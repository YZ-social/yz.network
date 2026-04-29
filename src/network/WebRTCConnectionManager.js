import { ConnectionManager } from './ConnectionManager.js';
import { ConnectionManagerFactory } from './ConnectionManagerFactory.js';
import { ConnectionStates, ConnectionTracker } from './ConnectionTracker.js';
import { ConnectionMetricsTracker, ConnectionOutcome, ConnectionType } from './ConnectionMetricsTracker.js';

/**
 * WebRTC-based connection manager for browser peers
 * Extends ConnectionManager with WebRTC transport implementation
 */
export class WebRTCConnectionManager extends ConnectionManager {
  constructor(options = {}) {
    super(options);

    // Store bootstrap client reference for browser-to-browser signaling
    this.bootstrapClient = options.bootstrapClient || null;

    this.rtcOptions = {
      // STUN servers for NAT discovery only - no TURN servers
      // We use our own WebSocket relay infrastructure instead of third-party TURN
      // See: .kiro/specs/symmetric-nat-relay/design.md for rationale
      iceServers: options.iceServers || [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' }
      ],
      ...options
    };

    // WebRTC-specific state (REFACTORED: Single connection per manager)
    this.dataChannel = null; // Single RTCDataChannel
    this.pendingConnectionInfo = null; // Connection attempt info for single peer
    this.signalQueue = []; // Array of queued signals for single peer
    this.remoteDescriptionSet = false; // Boolean (has remote description)
    this.offerCollision = null; // Collision detection state for Perfect Negotiation
    this.handshakeCompleted = false; // Boolean (prevent duplicate metadata updates)
    this.handshakeRecvCompleted = false; // Boolean for received handshake
    this.processingSignal = false; // Boolean (prevent concurrent signal processing)
    this.candidateTypes = { host: 0, srflx: 0, relay: 0 }; // Candidate type counts

    // Keep-alive system for browser tab visibility (single peer)
    // Task 5.1: Handle NAT mapping timeout (typically 30 seconds for UDP)
    // Keep-alive interval must be UNDER the NAT timeout to prevent mapping expiration
    // Using 25 seconds for active tabs (under typical 30s NAT timeout)
    // Using 10 seconds for inactive tabs (more aggressive to maintain connection)
    this.keepAliveIntervalId = null; // Interval ID for single peer
    this.keepAlivePings = new Set(); // Set of pending pings
    this.keepAliveLastResponse = null; // Last response timestamp
    this.keepAliveTimeouts = new Set(); // Set of timeout IDs
    this.isTabVisible = true;
    this.keepAliveInterval = options.keepAliveInterval || 25000; // 25 seconds for active tabs (under 30s NAT timeout)
    this.keepAliveIntervalHidden = options.keepAliveIntervalHidden || 10000; // 10 seconds for inactive tabs
    this.keepAliveTimeout = options.keepAliveTimeout || 60000; // 60 seconds to wait for pong response
    
    // NAT mapping timeout configuration
    // Most NATs have a 30-second UDP mapping timeout, some aggressive NATs use 20 seconds
    // We track this to proactively refresh mappings before they expire
    this.natMappingTimeout = options.natMappingTimeout || 30000; // Typical NAT mapping timeout
    this.natMappingRefreshMargin = options.natMappingRefreshMargin || 5000; // Refresh 5s before timeout
    this.lastNatRefreshTime = null; // Track when we last refreshed NAT mapping

    // NOTE: Metadata now passed directly in peerConnected/metadataUpdated events
    // No intermediate storage needed - clean architecture!

    // Event listener tracking for proper cleanup (prevents memory leaks)
    this.trackedListeners = [];

    // State-aware cleanup properties
    this.cleanupInProgress = false;
    this.cleanupTimeout = 5000; // ms - timeout for waiting for stable state

    // Initialize Page Visibility API if available
    if (typeof document !== 'undefined') {
      this.setupVisibilityHandling();
    }
  }

  /**
   * Register an event listener with automatic tracking for cleanup
   * @param {EventTarget} target - RTCPeerConnection or RTCDataChannel
   * @param {string} event - Event name
   * @param {Function} handler - Event handler function
   */
  registerListener(target, event, handler) {
    if (!target || typeof target.addEventListener !== 'function') {
      console.warn('registerListener: Invalid target provided');
      return;
    }
    target.addEventListener(event, handler);
    this.trackedListeners.push({ target, event, handler });
  }

  /**
   * Remove all tracked event listeners
   */
  removeAllListeners() {
    for (const { target, event, handler } of this.trackedListeners) {
      try {
        target.removeEventListener(event, handler);
      } catch (error) {
        console.warn(`Failed to remove listener for ${event}:`, error);
        // Continue with remaining listeners
      }
    }
    this.trackedListeners = [];
  }

  /**
   * Stop all media tracks on the peer connection.
   * Stops tracks from both senders (outgoing) and receivers (incoming).
   * Requirements: 2.1
   */
  stopAllTracks() {
    if (!this.connection) {
      return;
    }

    const peerId = this.peerId ? this.peerId.substring(0, 8) : 'unknown';

    // Stop tracks from senders (outgoing tracks)
    try {
      const senders = this.connection.getSenders();
      for (const sender of senders) {
        if (sender.track) {
          try {
            sender.track.stop();
          } catch (error) {
            console.warn(`Failed to stop sender track for ${peerId}:`, error);
          }
        }
      }
    } catch (error) {
      console.warn(`Failed to get senders for ${peerId}:`, error);
    }

    // Stop tracks from receivers (incoming tracks)
    try {
      const receivers = this.connection.getReceivers();
      for (const receiver of receivers) {
        if (receiver.track) {
          try {
            receiver.track.stop();
          } catch (error) {
            console.warn(`Failed to stop receiver track for ${peerId}:`, error);
          }
        }
      }
    } catch (error) {
      console.warn(`Failed to get receivers for ${peerId}:`, error);
    }
  }

  /**
   * Wait for connection to reach a stable state before cleanup.
   * If already stable, returns immediately. If transitional, waits for
   * connectionstatechange event or timeout.
   * 
   * Requirements: 1.1, 1.2, 1.3
   * 
   * @param {number} timeout - Maximum wait time in ms (default: this.cleanupTimeout)
   * @returns {Promise<string>} Final connection state
   */
  async waitForStableState(timeout = this.cleanupTimeout) {
    const peerId = this.peerId ? this.peerId.substring(0, 8) : 'unknown';

    // If no connection, return 'closed' as stable state
    if (!this.connection) {
      return 'closed';
    }

    const currentState = this.connection.connectionState;

    // If already stable, return immediately (Requirement 1.2)
    if (ConnectionStates.isStable(currentState)) {
      return currentState;
    }

    // If transitional, wait for stable state or timeout (Requirement 1.1, 1.3)
    console.log(`⏳ Waiting for stable state for ${peerId}... (current: ${currentState})`);

    return new Promise((resolve) => {
      const startTime = Date.now();
      let resolved = false;

      const cleanup = () => {
        if (this.connection && typeof this.connection.removeEventListener === 'function') {
          this.connection.removeEventListener('connectionstatechange', onStateChange);
        }
        clearTimeout(timeoutId);
      };

      const onStateChange = () => {
        if (resolved) return;

        const newState = this.connection ? this.connection.connectionState : 'closed';
        
        if (ConnectionStates.isStable(newState)) {
          resolved = true;
          cleanup();
          console.log(`✅ Connection reached stable state for ${peerId}: ${newState}`);
          resolve(newState);
        }
      };

      // Set timeout for waiting
      const timeoutId = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        cleanup();

        const finalState = this.connection ? this.connection.connectionState : 'closed';
        console.warn(`⚠️ Cleanup timeout for ${peerId}, forcing cleanup from state: ${finalState}`);
        resolve(finalState);
      }, timeout);

      // Listen for state changes (guard against mock objects in tests)
      if (this.connection && typeof this.connection.addEventListener === 'function') {
        this.connection.addEventListener('connectionstatechange', onStateChange);
      }

      // Check immediately in case state changed
      onStateChange();
    });
  }

  /**
   * Execute cleanup in the correct order.
   * Order: tracks → listeners → channel → connection → refs
   * Each step is wrapped in try/catch to continue on errors.
   * 
   * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 6.1
   * 
   * @param {string} reason - Reason for cleanup
   */
  performCleanup(reason) {
    const peerId = this.peerId;
    const peerIdShort = peerId ? peerId.substring(0, 8) : 'unknown';
    let cleanupSuccess = true;
    let cleanupError = null;

    console.log(`🧹 Performing cleanup for ${peerIdShort}... (reason: ${reason})`);

    // Step 1: Stop all media tracks (Requirement 2.1)
    try {
      this.stopAllTracks();
    } catch (error) {
      console.error(`Failed to stop tracks for ${peerIdShort}:`, error);
      cleanupSuccess = false;
      cleanupError = error.message;
    }

    // Step 2: Remove all event listeners (Requirement 2.2)
    try {
      this.removeAllListeners();
    } catch (error) {
      console.error(`Failed to remove listeners for ${peerIdShort}:`, error);
      cleanupSuccess = false;
      cleanupError = cleanupError || error.message;
    }

    // Step 3: Close data channel (Requirement 2.3)
    try {
      if (this.dataChannel) {
        this.dataChannel.close();
      }
    } catch (error) {
      console.error(`Failed to close data channel for ${peerIdShort}:`, error);
      cleanupSuccess = false;
      cleanupError = cleanupError || error.message;
    }

    // Step 4: Close RTCPeerConnection (Requirement 2.4)
    try {
      if (this.connection && this.connection.connectionState !== 'closed') {
        if (this.connection.timeout) {
          clearTimeout(this.connection.timeout);
        }
        this.connection.close();
      }
    } catch (error) {
      console.error(`Failed to close connection for ${peerIdShort}:`, error);
      cleanupSuccess = false;
      cleanupError = cleanupError || error.message;
    }

    // Step 5: Nullify references (Requirement 2.5)
    const connectionState = this.connection ? this.connection.connectionState : 'unknown';
    const iceConnectionState = this.connection ? this.connection.iceConnectionState : 'unknown';

    this.connection = null;
    this.dataChannel = null;
    this.connectionState = 'disconnected';
    this.pendingConnectionInfo = null;
    this.signalQueue = [];
    this.remoteDescriptionSet = false;
    this.offerCollision = null;
    this.handshakeCompleted = false;
    this.handshakeRecvCompleted = false;
    this.processingSignal = false;
    this.candidateTypes = { host: 0, srflx: 0, relay: 0 };

    // Log to ConnectionTracker
    ConnectionTracker.trackConnectionClosed(cleanupSuccess, reason, {
      peerId: peerId || 'unknown',
      connectionState,
      iceConnectionState,
      error: cleanupError
    });

    console.log(`✅ Cleanup completed for ${peerIdShort} (success: ${cleanupSuccess})`);

    // Emit peerDisconnected event (Requirement 6.1)
    if (peerId) {
      this.emit('peerDisconnected', { peerId, reason });
    }
  }

  /**
   * State-aware cleanup entry point.
   * Waits for stable state before performing cleanup.
   * Prevents concurrent cleanup attempts.
   * 
   * Requirements: 5.1, 5.2, 5.3
   * 
   * @param {string} reason - Reason for cleanup
   * @returns {Promise<void>}
   */
  async safeCleanup(reason) {
    const peerIdShort = this.peerId ? this.peerId.substring(0, 8) : 'unknown';

    // Check if cleanup is already in progress (Requirement 5.1)
    if (this.cleanupInProgress) {
      console.log(`⚠️ Cleanup already in progress for ${peerIdShort}, ignoring`);
      return;
    }

    // Set cleanup flag (Requirement 5.2)
    this.cleanupInProgress = true;

    try {
      // Stop keep-alive first
      this.stopKeepAlive();

      // Wait for stable state before cleanup
      await this.waitForStableState();

      // Perform the actual cleanup
      this.performCleanup(reason);
    } finally {
      // Clear cleanup flag in finally block (Requirement 5.3)
      this.cleanupInProgress = false;
    }
  }


  /**
   * Setup Page Visibility API handling for keep-alive frequency adjustment
   */
  setupVisibilityHandling() {
    if (typeof document === 'undefined') return;

    // Set initial visibility state
    this.isTabVisible = !document.hidden;

    console.log(`📱 Setting up visibility handling. Initial state: ${this.isTabVisible ? 'visible' : 'hidden'}`);    // Listen for visibility changes
    document.addEventListener('visibilitychange', () => {
      const wasVisible = this.isTabVisible;
      this.isTabVisible = !document.hidden;

      console.log(`📱 Tab visibility changed: ${wasVisible ? 'visible' : 'hidden'} → ${this.isTabVisible ? 'visible' : 'hidden'}`);

      // Adjust keep-alive frequency for all connections
      this.adjustKeepAliveFrequency();
    });

    // Listen for beforeunload to cleanup
    window.addEventListener('beforeunload', () => {
      console.log('📱 Tab unloading, cleaning up keep-alive timers');
      this.cleanupAllKeepAlives();
    });
  }

  /**
   * Adjust keep-alive frequency based on tab visibility
   */
  adjustKeepAliveFrequency() {
    const newInterval = this.isTabVisible ? this.keepAliveInterval : this.keepAliveIntervalHidden;
    console.log(`📱 Adjusting keep-alive frequency to ${newInterval}ms (tab ${this.isTabVisible ? 'visible' : 'hidden'})`);

    // Use setTimeout to avoid blocking the main thread during visibility change
    setTimeout(() => {
      // Restart keep-alive for the connected peer with new frequency
      if (this.isConnected()) {
        this.stopKeepAlive();
        this.startKeepAlive();
      }
    }, 0);
  }

  // ===========================================
  // INVITATION PROTOCOL IMPLEMENTATION
  // ===========================================

  /**
   * Handle invitation sent to peer
   * Connection-agnostic invitation interface implementation
   */
  async handleInvitationSent(targetPeerId, invitationResult) {
    console.log(`📤 WebRTC manager handling invitation sent to ${targetPeerId.substring(0, 8)}...`);

    try {
      // DHT member should initiate WebRTC connection to new client
      console.log(`🚀 Creating WebRTC connection to invited peer ${targetPeerId.substring(0, 8)}...`);
      await this.createConnection(targetPeerId, true); // true = initiator

      return {
        success: true,
        connectionInitiated: true
      };

    } catch (error) {
      console.error(`❌ Failed to create WebRTC connection to invited peer ${targetPeerId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // ===========================================
  // TRANSPORT IMPLEMENTATION (WebRTC)
  // ===========================================

  /**
   * Create WebRTC connection to peer
   * 
   * Task 4.1: Modified to support non-blocking mode for parallel connection strategy.
   * When options.nonBlocking is true, returns immediately after starting ICE gathering
   * instead of waiting for the connection to complete. This enables the "relay first"
   * strategy where relay is used immediately while WebRTC probes in parallel.
   * 
   * @param {string} peerId - Target peer ID
   * @param {boolean} initiator - Whether we're initiating the connection
   * @param {Object} metadata - Peer metadata (optional, for API compatibility)
   * @param {Object} options - Connection options
   * @param {boolean} options.nonBlocking - If true, return immediately without waiting for ICE completion
   * @returns {Promise<RTCPeerConnection>} - In blocking mode: resolves when connected. In non-blocking mode: resolves immediately after ICE starts.
   */
  async createConnection(peerId, initiator = true, metadata = null, options = {}) {
    if (this.isDestroyed) {
      throw new Error('WebRTCConnectionManager is destroyed');
    }

    if (this.connection) {
      throw new Error(`Connection already exists to ${this.peerId}`);
    }

    // Task 4.1: Support non-blocking mode for parallel connection strategy
    const nonBlocking = options.nonBlocking === true;

    console.log(`🚀 Creating ${initiator ? 'outgoing' : 'incoming'} WebRTC connection to ${peerId.substring(0, 8)}... (nonBlocking: ${nonBlocking})`);
    console.log(`🔍 DEBUG WebRTC createConnection: peerId=${peerId.substring(0, 8)}, initiator=${initiator}, hasMetadata=${!!metadata}`);
    if (metadata) {
      console.log(`🔍 DEBUG WebRTC metadata: nodeType=${metadata.nodeType}, canAccept=${metadata.canAcceptConnections}`);
    }

    // Store the peer ID
    this.peerId = peerId;

    // Create RTCPeerConnection
    const pc = new RTCPeerConnection({
      iceServers: this.rtcOptions.iceServers,
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 10
    });

    this.connection = pc;
    this.connectionState = 'connecting';

    // Setup peer connection events
    this.setupPeerConnectionEvents(pc, initiator);

    this.pendingConnectionInfo = {
      startTime: Date.now(),
      initiator,
      pc
    };

    // Set connection timeout
    const timeout = setTimeout(() => {
      if (this.connectionState === 'connecting') {
        console.warn(`⏰ Connection timeout for peer ${peerId.substring(0, 8)}... after ${this.options.timeout}ms`);
        console.warn(`🔍 Final connection state:`, {
          connectionState: pc.connectionState,
          iceConnectionState: pc.iceConnectionState,
          signalingState: pc.signalingState
        });
        
        // Track timeout failure (Task 1.3)
        const startTime = this.pendingConnectionInfo ? this.pendingConnectionInfo.startTime : null;
        const duration = startTime ? Date.now() - startTime : this.options.timeout;
        ConnectionMetricsTracker.recordAttempt({
          connectionType: ConnectionType.BROWSER_TO_BROWSER,
          outcome: ConnectionOutcome.FAILURE,
          localNodeType: 'browser',
          remoteNodeType: 'browser',
          peerId,
          duration,
          failureReason: 'timeout',
          candidateTypes: { ...this.candidateTypes }
        });
        
        // Task 4.1: Emit connectionFailed event for non-blocking callers
        this.emit('connectionFailed', { peerId, reason: 'timeout' });
        
        this.destroyConnection(peerId, 'timeout');
      }
    }, this.options.timeout);

    pc.timeout = timeout;

    if (initiator) {
      // Create data channel for outgoing connections
      const dataChannel = pc.createDataChannel('dht-data', {
        ordered: true
      });
      this.setupDataChannelEvents(dataChannel);
      this.dataChannel = dataChannel;

      // Create offer
      try {
        const offer = await pc.createOffer();
        // Task 6.1: Apply IPv6 prioritization before setting local description
        // This boosts IPv6 host candidate priorities to prefer direct IPv6 connections
        const modifiedOffer = await this._setLocalDescriptionWithIPv6Priority(pc, offer);
        console.log(`📤 Created offer for ${peerId.substring(0, 8)}... (IPv6 prioritized)`);

        // Send offer through appropriate signaling channel
        await this.sendSignal(peerId, {
          type: 'offer',
          sdp: modifiedOffer.sdp
        });
      } catch (error) {
        console.error(`❌ Failed to create offer for ${peerId}:`, error);
        this.destroyConnection(peerId, 'offer_failed');
        throw error;
      }
    }

    // Task 4.1: Non-blocking mode - return immediately after ICE gathering starts
    // The caller can listen for 'peerConnected' and 'connectionFailed' events
    // This enables the parallel connection strategy where relay is used immediately
    // while WebRTC probes in the background
    if (nonBlocking) {
      console.log(`🔄 Non-blocking mode: ICE gathering started for ${peerId.substring(0, 8)}..., returning immediately`);
      
      // Emit event to indicate ICE probing has started
      this.emit('iceGatheringStarted', { peerId, pc });
      
      // Return the peer connection immediately - caller uses events for completion
      return pc;
    }

    // Blocking mode (default) - wait for connection to complete
    return new Promise((resolve, reject) => {
      const checkConnection = () => {
        if (this.connectionState === 'connected') {
          clearTimeout(timeout);
          // Track successful connection creation (Requirement 4.2)
          ConnectionTracker.trackConnectionCreated();
          resolve(pc);
        } else if (this.connectionState === 'failed' || this.connectionState === 'disconnected') {
          clearTimeout(timeout);
          reject(new Error(`Connection failed: ${this.connectionState}`));
        }
      };

      // Check immediately
      checkConnection();

      // Use event-driven approach instead of polling
      const connectionHandler = () => {
        checkConnection();
      };

      // Listen for connection state changes instead of polling
      pc.addEventListener('connectionstatechange', connectionHandler);
      pc.addEventListener('iceconnectionstatechange', connectionHandler);

      setTimeout(() => {
        pc.removeEventListener('connectionstatechange', connectionHandler);
        pc.removeEventListener('iceconnectionstatechange', connectionHandler);
        if (this.connectionState === 'connecting') {
          reject(new Error('Connection timeout'));
        }
      }, this.options.timeout);
    });
  }

  /**
   * Setup peer connection events
   */
  setupPeerConnectionEvents(pc, initiator) {
      const peerId = this.peerId;
      console.log(`🔧 Setting up events for peer: ${peerId.substring(0, 8)}... (initiator: ${initiator})`);
      console.log(`🔍 WebRTC Peer Connection state: ${pc.connectionState}, ICE state: ${pc.iceConnectionState}, Signaling state: ${pc.signalingState}`);

      // ICE candidate gathering with enhanced debugging
      // TRICKLE ICE: Send candidates immediately as they're discovered (Task 5.2)
      // This is more efficient than waiting for gathering complete - candidates
      // are sent to the peer as soon as they're available, reducing connection time.
      const onIceCandidate = (event) => {
        if (event.candidate) {
          console.log(`🧊 ICE candidate for ${peerId.substring(0, 8)}...: ${event.candidate.type} (${event.candidate.protocol}:${event.candidate.address}:${event.candidate.port})`);
          console.log(`   📋 Full candidate string: ${event.candidate.candidate}`);

          // Track candidate types for diagnostics
          if (event.candidate.type === 'host') this.candidateTypes.host++;
          else if (event.candidate.type === 'srflx') this.candidateTypes.srflx++;
          else if (event.candidate.type === 'relay') this.candidateTypes.relay++;

          // TRICKLE ICE: Send ICE candidate immediately through signaling channel
          // Don't wait for gathering complete - send as discovered for faster connection
          this.sendSignal(peerId, {
            type: 'candidate',
            candidate: event.candidate.candidate,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
            sdpMid: event.candidate.sdpMid
          }).catch(error => {
            console.warn(`Failed to send ICE candidate for ${peerId}:`, error);
          });
        } else {
          console.log(`🏁 ICE gathering complete for ${peerId.substring(0, 8)}... - Generated: ${this.candidateTypes.host} host, ${this.candidateTypes.srflx} srflx, ${this.candidateTypes.relay} relay candidates`);

          // CRITICAL DIAGNOSTIC: Warn if no host candidates generated
          if (this.candidateTypes.host === 0) {
            console.warn(`⚠️ WARNING: No host candidates generated for ${peerId.substring(0, 8)}!`);
            console.warn(`   This may cause connection failures for same-network peers.`);
            console.warn(`   Possible causes: browser privacy settings, mDNS disabled, or network configuration.`);
          }
        }
      };
      this.registerListener(pc, 'icecandidate', onIceCandidate);

      // Connection state changes with unexpected disconnect handling
      const onConnectionStateChange = () => {
        console.log(`🔗 Connection state for ${peerId.substring(0, 8)}...: ${pc.connectionState}`);

        if (pc.connectionState === 'connected') {
          clearTimeout(pc.timeout);
          this.connectionState = 'connected';

          // CRITICAL FIX: Get initiator flag before clearing pending connection
          const initiator = this.pendingConnectionInfo ? this.pendingConnectionInfo.initiator : false;
          const startTime = this.pendingConnectionInfo ? this.pendingConnectionInfo.startTime : null;
          this.pendingConnectionInfo = null;

          // Track successful direct WebRTC connection (Task 1.3)
          const duration = startTime ? Date.now() - startTime : undefined;
          
          // Extract the selected ICE candidate pair for metrics (Task 1.3)
          // Task 4.4: Also include in peerConnected event for IPv6 detection
          this._getSelectedCandidatePair(pc).then(selectedCandidatePair => {
            // Task 4.4: Detect if connection uses IPv6 (bypasses NAT entirely)
            const isIPv6 = selectedCandidatePair && this._isIPv6Address(selectedCandidatePair.localAddress);
            
            ConnectionMetricsTracker.recordAttempt({
              connectionType: ConnectionType.BROWSER_TO_BROWSER,
              outcome: ConnectionOutcome.DIRECT_SUCCESS,
              localNodeType: 'browser',
              remoteNodeType: 'browser',
              peerId,
              duration,
              candidateTypes: { ...this.candidateTypes },
              selectedCandidatePair
            });
            
            // Report to bootstrap server for network-wide metrics (Task 1.3)
            if (this.bootstrapClient) {
              ConnectionMetricsTracker.reportToBootstrap(this.bootstrapClient, {
                success: true,
                connectionType: 'webrtc',
                iceCandidateType: selectedCandidatePair?.localType || 'unknown',
                isIPv6
              });
            }
            
            // Task 4.4: Emit selectedCandidatePair event for HybridConnectionManager
            // This allows path tracking to distinguish IPv6 from IPv4 WebRTC connections
            this.emit('selectedCandidatePair', {
              peerId,
              selectedCandidatePair,
              isIPv6,
              duration
            });
          }).catch(err => {
            // Still record the attempt even if we can't get candidate pair
            console.warn(`Failed to get selected candidate pair: ${err.message}`);
            ConnectionMetricsTracker.recordAttempt({
              connectionType: ConnectionType.BROWSER_TO_BROWSER,
              outcome: ConnectionOutcome.DIRECT_SUCCESS,
              localNodeType: 'browser',
              remoteNodeType: 'browser',
              peerId,
              duration,
              candidateTypes: { ...this.candidateTypes }
            });
            
            // Report to bootstrap server for network-wide metrics (Task 1.3)
            if (this.bootstrapClient) {
              ConnectionMetricsTracker.reportToBootstrap(this.bootstrapClient, {
                success: true,
                connectionType: 'webrtc'
              });
            }
          });

          console.log(`✅ WebRTC Connected to ${peerId.substring(0, 8)}... - EMITTING peerConnected EVENT (initiator: ${initiator})`);
          // CRITICAL FIX: Include manager reference so RoutingTable can store the correct manager on the DHTNode
          this.emit('peerConnected', { peerId, connection: pc, manager: this, initiator });

          // Start keep-alive for this connection
          this.startKeepAlive();

        } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          // Requirement 9.1, 9.2, 9.3: Detect unexpected disconnects and perform cleanup
          console.log(`❌ Connection failed/disconnected for ${peerId.substring(0, 8)}...: ${pc.connectionState}`);
          
          // Track connection failure (Task 1.3)
          // Only track as failure if we were still connecting (not an established connection dropping)
          if (this.pendingConnectionInfo) {
            const startTime = this.pendingConnectionInfo.startTime;
            const duration = startTime ? Date.now() - startTime : undefined;
            ConnectionMetricsTracker.recordAttempt({
              connectionType: ConnectionType.BROWSER_TO_BROWSER,
              outcome: ConnectionOutcome.FAILURE,
              localNodeType: 'browser',
              remoteNodeType: 'browser',
              peerId,
              duration,
              failureReason: pc.connectionState,
              candidateTypes: { ...this.candidateTypes }
            });
            
            // Report to bootstrap server for network-wide metrics (Task 1.3)
            if (this.bootstrapClient) {
              ConnectionMetricsTracker.reportToBootstrap(this.bootstrapClient, {
                success: false,
                connectionType: 'webrtc',
                failureReason: pc.connectionState
              });
            }
          }
          
          // Log to ConnectionTracker with peer ID and state (Requirement 9.3)
          console.log(`📊 Logging unexpected disconnect to ConnectionTracker: peerId=${peerId.substring(0, 8)}, state=${pc.connectionState}`);
          
          this.connectionState = pc.connectionState;
          this.stopKeepAlive();
          
          // Use safeCleanup for proper state-aware, ordered cleanup (Requirement 9.2)
          this.safeCleanup('unexpected_disconnect').catch(error => {
            console.error(`Failed to cleanup after unexpected disconnect for ${peerId.substring(0, 8)}:`, error);
          });
        } else {
          console.log(`🔄 WebRTC connection state transition for ${peerId.substring(0, 8)}...: ${pc.connectionState} (waiting for 'connected')`);
          this.connectionState = pc.connectionState;
        }
      };
      this.registerListener(pc, 'connectionstatechange', onConnectionStateChange);

      // ICE connection state changes with enhanced debugging
      const onIceConnectionStateChange = () => {
        console.log(`🧊 ICE connection state for ${peerId.substring(0, 8)}...: ${pc.iceConnectionState}`);

        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          console.log(`✅ ICE connection established for ${peerId.substring(0, 8)}...: ${pc.iceConnectionState}`);
          
          // Clear ICE restart state if we were doing a restart
          if (this._iceRestartInProgress) {
            console.log(`❄️ [WebRTC] ICE restart succeeded for ${peerId.substring(0, 8)}...`);
            this._iceRestartInProgress = false;
            this._iceRestartSessionId = null;
            this.emit('iceRestartSucceeded', { peerId, sessionId: this._iceRestartSessionId });
          }
        } else if (pc.iceConnectionState === 'failed') {
          console.error(`❌ ICE connection failed for ${peerId.substring(0, 8)}...`);
          
          // Task 4.3: Emit iceConnectionFailed event BEFORE destroying connection
          // This allows HybridConnectionManager to request coordinated ICE restart
          // if both peers have hard NAT and this is the initial ICE failure
          const wasIceRestart = this._iceRestartInProgress;
          this._iceRestartInProgress = false;
          
          this.emit('iceConnectionFailed', {
            peerId,
            wasIceRestart,
            sessionId: this._iceRestartSessionId,
            candidateTypes: { ...this.candidateTypes }
          });
          
          this._iceRestartSessionId = null;
          
          this.destroyConnection(peerId, 'ice_failed');
        } else if (pc.iceConnectionState === 'checking') {
          console.log(`🔍 ICE connectivity checks started for ${peerId.substring(0, 8)}...`);
        } else if (pc.iceConnectionState === 'disconnected') {
          console.warn(`⚠️ ICE connection disconnected for ${peerId.substring(0, 8)}...`);
        } else {
          console.log(`🧊 ICE state transition for ${peerId.substring(0, 8)}...: ${pc.iceConnectionState}`);
        }
      };
      this.registerListener(pc, 'iceconnectionstatechange', onIceConnectionStateChange);

      // Data channel handling for incoming connections
      if (!initiator) {
        const onDataChannel = (event) => {
          console.log(`📥 Received data channel from ${peerId.substring(0, 8)}...`);
          const dataChannel = event.channel;
          this.setupDataChannelEvents(dataChannel);
          this.dataChannel = dataChannel;
        };
        this.registerListener(pc, 'datachannel', onDataChannel);
      }

      // ICE gathering state monitoring - CRITICAL for debugging
      const onIceGatheringStateChange = () => {
        console.log(`🧊 ICE gathering state for ${peerId.substring(0, 8)}...: ${pc.iceGatheringState}`);

        if (pc.iceGatheringState === 'gathering') {
          console.log(`✅ ICE gathering started for ${peerId.substring(0, 8)}...`);
        } else if (pc.iceGatheringState === 'complete') {
          console.log(`🏁 ICE gathering completed for ${peerId.substring(0, 8)}...`);
        }
      };
      this.registerListener(pc, 'icegatheringstatechange', onIceGatheringStateChange);

      // DEBUG: Add periodic status monitoring to track connection progress
      const statusMonitor = setInterval(() => {
        if (pc.connectionState === 'connected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          clearInterval(statusMonitor);
          return;
        }
        console.log(`🔍 WebRTC Status Monitor for ${peerId.substring(0, 8)}...: connection=${pc.connectionState}, ice=${pc.iceConnectionState}, iceGathering=${pc.iceGatheringState}, signaling=${pc.signalingState}`);
      }, 2000); // Check every 2 seconds
    }

  /**
   * Setup data channel events
   */
  setupDataChannelEvents(dataChannel) {
      const peerId = this.peerId;

      const onOpen = () => {
        console.log(`📡 Data channel opened for ${peerId.substring(0, 8)}... - WebRTC communication ready!`);

        // Send initial metadata handshake (only once per peer)
        if (!this.handshakeCompleted) {
          const myMetadata = ConnectionManagerFactory.getPeerMetadata(this.localNodeId);
          if (myMetadata) {
            const handshakeMessage = {
              type: 'handshake',
              peerId: this.localNodeId,
              metadata: myMetadata,
              timestamp: Date.now()
            };
            dataChannel.send(JSON.stringify(handshakeMessage));
            console.log(`📤 Sent WebRTC handshake with metadata to ${peerId.substring(0, 8)}`);
            this.handshakeCompleted = true;
          }
        } else {
          console.log(`📤 Skipping duplicate handshake for ${peerId.substring(0, 8)} (already sent)`);
        }
      };
      this.registerListener(dataChannel, 'open', onOpen);

      const onClose = () => {
        console.log(`📡 Data channel closed for ${peerId.substring(0, 8)}...`);
      };
      this.registerListener(dataChannel, 'close', onClose);

      const onMessage = (event) => {
        try {
          const message = JSON.parse(event.data);

          // Handle keep-alive messages
          if (message.type === 'keep_alive_ping') {
            this.handleKeepAlivePing(message);
            return;
          } else if (message.type === 'keep_alive_pong') {
            this.handleKeepAlivePong(message);
            return;
          } else if (message.type === 'handshake') {
            // Handle handshake with peer metadata (prevent duplicate processing)
            if (message.metadata && !this.handshakeRecvCompleted) {
              console.log(`📋 Received WebRTC handshake metadata from ${peerId.substring(0, 8)}:`, message.metadata);

              // CRITICAL: Emit metadataUpdated event so RoutingTable can set metadata on DHTNode
              // No intermediate storage needed - clean architecture!
              this.emit('metadataUpdated', { peerId, metadata: message.metadata });
              this.handshakeRecvCompleted = true;
            } else if (message.metadata) {
              console.log(`📋 Skipping duplicate handshake metadata from ${peerId.substring(0, 8)} (already processed)`);
            }
            return;
          }

          // Pass to base class for protocol handling
          this.handleMessage(peerId, message);
        } catch (error) {
          console.warn(`Invalid JSON data from ${peerId}:`, error);
        }
      };
      this.registerListener(dataChannel, 'message', onMessage);

      const onError = (error) => {
        console.error(`❌ Data channel error for ${peerId.substring(0, 8)}...:`, error);
      };
      this.registerListener(dataChannel, 'error', onError);
    }

  /**
   * Send WebRTC signal through appropriate channel
   * @param {string} peerId - Target peer ID
   * @param {Object} signal - Signal to send (offer/answer/candidate)
   */
  async sendSignal(peerId, signal) {
    try {
      // Determine if we should use bootstrap signaling (browser-to-browser)
      const peerMetadata = ConnectionManagerFactory.getPeerMetadata(peerId) || {};
      const isTargetBrowser = peerMetadata.nodeType === 'browser' || !peerMetadata.nodeType; // default to browser
      const isLocalBrowser = typeof process === 'undefined'; // we're in browser if window exists
      const isBridgeNode = peerMetadata.isBridgeNode === true;

      // SIMPLIFIED LOGIC: Always use DHT signaling (event emission)
      // Let OverlayNetwork.handleOutgoingSignal determine bootstrap vs DHT routing
      // This fixes the issue where WebRTC answers weren't using DHT routing

      console.log(`🔄 Sending WebRTC signal (${signal.type}) to ${peerId.substring(0, 8)}... via DHT event (target: ${isTargetBrowser ? 'browser' : 'node'}, bridge: ${isBridgeNode})`);
      console.log(`🔍 DEBUG sendSignal: localBrowser=${isLocalBrowser}, targetBrowser=${isTargetBrowser}, signalType=${signal.type}`);

      // Fall back to event emission for DHT-based signaling or other connection types
      this.emit('signal', {
        peerId,
        signal
      });
      console.log(`✅ DEBUG: Signal event emitted for ${peerId.substring(0, 8)}...`);

    } catch (error) {
      console.error(`❌ Failed to send WebRTC signal to ${peerId}:`, error);

      // Fallback to event emission if bootstrap fails
      this.emit('signal', {
        peerId,
        signal
      });
    }
  }

  /**
   * Handle incoming WebRTC signaling
   */
  async handleSignal(peerId, signal) {
    // Validate peerId matches expected peer
    if (this.peerId && this.peerId !== peerId) {
      console.warn(`⚠️ Received signal for unexpected peer ${peerId.substring(0, 8)}..., expected ${this.peerId.substring(0, 8)}...`);
      // Allow signal if we don't have a connection yet (incoming connection case)
      if (this.connection) {
        return;
      }
    }

    console.log(`🔄 Handling signal from ${peerId.substring(0, 8)}...:`, signal.type);

    // Prevent concurrent signal processing
    if (this.processingSignal) {
      console.log(`⚠️ Already processing signal for ${peerId.substring(0, 8)}..., ignoring duplicate ${signal.type}`);
      return;
    }

    this.processingSignal = true;

    let pc = this.connection;

    // Perfect Negotiation Pattern: Determine who is polite/impolite based on node IDs
    const isPolite = this.localNodeId && this.localNodeId < peerId;
    const makingOffer = pc && pc.signalingState === 'have-local-offer';
    const ignoreOffer = !isPolite && signal.type === 'offer' && makingOffer;

    console.log(`🤝 Perfect Negotiation - Role: ${isPolite ? 'POLITE' : 'IMPOLITE'} (${this.localNodeId} vs ${peerId})`);

    // Perfect Negotiation: Handle collision resolution
    if (ignoreOffer) {
      console.log(`💪 Perfect Negotiation - Being impolite, ignoring offer from ${peerId.substring(0, 8)}... (we have precedence)`);
      this.processingSignal = false;
      return;
    }

    // Perfect Negotiation: Handle glare condition - both sides sent offers simultaneously
    // If we're the polite peer and have an existing connection attempt, close it and restart
    if (!pc || (isPolite && signal.type === 'offer' && makingOffer)) {
      // Create new incoming connection for offers
      if (signal.type === 'offer') {

        // GLARE HANDLING: If polite peer with existing connection, close old one first
        if (pc && isPolite) {
          console.log(`🤝 Perfect Negotiation - Glare detected! Polite peer ${this.localNodeId.substring(0, 8)} closing existing connection attempt to ${peerId.substring(0, 8)}`);
          // Close existing connection WITHOUT emitting disconnect event (we're about to reconnect)
          if (this.connection) {
            if (this.connection.timeout) clearTimeout(this.connection.timeout);
            this.connection.close();
          }
          this.cleanupConnection();
          pc = null; // Clear pc reference so we create new one below
        }
        console.log(`📥 Creating incoming connection for ${peerId.substring(0, 8)}...`);
        try {
          // Store the peer ID
          this.peerId = peerId;

          // Create connection synchronously for immediate offer processing
          const rtcPC = new RTCPeerConnection({
            iceServers: this.rtcOptions.iceServers,
            iceTransportPolicy: 'all',
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require',
            iceCandidatePoolSize: 10
          });

          this.connection = rtcPC;
          this.connectionState = 'connecting';

          // Setup peer connection events immediately
          this.setupPeerConnectionEvents(rtcPC, false); // false = not initiator

          // Setup pending connection tracking
          this.pendingConnectionInfo = {
            startTime: Date.now(),
            initiator: false,
            pc: rtcPC
          };

          // Set connection timeout
          const timeout = setTimeout(() => {
            if (this.connectionState === 'connecting') {
              console.warn(`⏰ Connection timeout for peer ${peerId.substring(0, 8)}... after ${this.options.timeout}ms`);
              this.destroyConnection(peerId, 'timeout');
            }
          }, this.options.timeout);

          rtcPC.timeout = timeout;
          pc = rtcPC;

          console.log(`✅ Incoming connection created synchronously for ${peerId.substring(0, 8)}...`);
        } catch (error) {
          console.error(`❌ Failed to create incoming connection for ${peerId}:`, error);
          this.processingSignal = false;
          return;
        }
      } else {
        console.warn(`⚠️ Received ${signal.type} signal for unknown peer ${peerId.substring(0, 8)}...`);
        this.processingSignal = false;
        return;
      }
    }

    // Perfect Negotiation: Handle rollback if we're being polite
    if (isPolite && signal.type === 'offer' && makingOffer) {
      console.log(`🤝 Perfect Negotiation - Being polite, performing rollback for ${peerId.substring(0, 8)}...`);
      try {
        await pc.setLocalDescription({ type: 'rollback' });
      } catch (error) {
        console.warn(`⚠️ Rollback failed for ${peerId}:`, error);
      }
    }

    // Queue ICE candidates ONLY if remote description not set yet
    if (signal.type === 'candidate' && !this.remoteDescriptionSet) {
      console.log(`🔄 Queuing ICE candidate for ${peerId.substring(0, 8)}... (remote description not set)`);
      this.signalQueue.push(signal);
      this.processingSignal = false;
      return;
    }

    try {
      if (signal.type === 'offer') {
        console.log(`📥 Processing offer from ${peerId.substring(0, 8)}...`);

        // Check if remote description is already set to prevent duplicate offer processing
        if (this.remoteDescriptionSet) {
          console.log(`⚠️ Ignoring duplicate offer from ${peerId.substring(0, 8)}... (remote description already set)`);
          return;
        }

        await pc.setRemoteDescription(new RTCSessionDescription({
          type: 'offer',
          sdp: signal.sdp
        }));

        // Mark remote description as set
        this.remoteDescriptionSet = true;

        // Process any queued ICE candidates
        await this.processQueuedSignals();

        // Create answer
        const answer = await pc.createAnswer();
        // Task 6.1: Apply IPv6 prioritization before setting local description
        // This boosts IPv6 host candidate priorities to prefer direct IPv6 connections
        const modifiedAnswer = await this._setLocalDescriptionWithIPv6Priority(pc, answer);

        console.log(`📤 Created answer for ${peerId.substring(0, 8)}... (IPv6 prioritized)`);
        console.log(`🔍 Answer peer connection state after setLocalDescription: connection=${pc.connectionState}, ice=${pc.iceConnectionState}, iceGathering=${pc.iceGatheringState}, signaling=${pc.signalingState}`);

        // CRITICAL: Wait for ICE gathering to start before sending answer
        // This prevents the race condition where answer is sent before ICE candidates
        if (pc.iceGatheringState === 'new') {
          console.warn(`⚠️ WARNING: ICE gathering state is still 'new' after setLocalDescription for ${peerId.substring(0, 8)}... - waiting for it to start`);

          // Wait for ICE gathering to start (with timeout)
          await new Promise((resolve) => {
            const timeout = setTimeout(() => {
              console.warn(`⏰ Timeout waiting for ICE gathering to start for ${peerId.substring(0, 8)}...`);
              resolve();
            }, 1000); // 1 second timeout

            const checkGathering = () => {
              if (pc.iceGatheringState !== 'new') {
                clearTimeout(timeout);
                console.log(`✅ ICE gathering started for ${peerId.substring(0, 8)}... (state: ${pc.iceGatheringState})`);
                resolve();
              }
            };

            // Check immediately
            checkGathering();

            // Listen for gathering state change
            pc.addEventListener('icegatheringstatechange', checkGathering, { once: true });
          });
        } else if (pc.iceGatheringState === 'gathering') {
          console.log(`✅ ICE gathering is active for ${peerId.substring(0, 8)}...`);
        } else if (pc.iceGatheringState === 'complete') {
          console.log(`🏁 ICE gathering already complete for ${peerId.substring(0, 8)}... (all candidates should have been sent)`);
        }

        // Send answer through appropriate signaling channel
        await this.sendSignal(peerId, {
          type: 'answer',
          sdp: modifiedAnswer.sdp
        });

      } else if (signal.type === 'answer') {
        console.log(`📥 Processing answer from ${peerId.substring(0, 8)}...`);

        // Check if remote description is already set to prevent duplicate answer processing
        if (this.remoteDescriptionSet) {
          console.log(`⚠️ Ignoring duplicate answer from ${peerId.substring(0, 8)}... (remote description already set)`);
          return; // Exit early to prevent duplicate processing
        }

        await pc.setRemoteDescription(new RTCSessionDescription({
          type: 'answer',
          sdp: signal.sdp
        }));

        // Mark remote description as set
        this.remoteDescriptionSet = true;
        console.log(`📥 Answer processed for ${peerId.substring(0, 8)}... - connection=${pc.connectionState}, ice=${pc.iceConnectionState}, signaling=${pc.signalingState}`);

        // Process any queued ICE candidates
        await this.processQueuedSignals();

      } else if (signal.type === 'candidate') {
        const candidatePreview = signal.candidate ?
          (typeof signal.candidate === 'string' ? signal.candidate.substring(0, 50) : String(signal.candidate).substring(0, 50)) :
          'null';
        console.log(`📥 Processing ICE candidate from ${peerId.substring(0, 8)}...: ${candidatePreview}...`);

        try {
          await pc.addIceCandidate(new RTCIceCandidate({
            candidate: signal.candidate,
            sdpMLineIndex: signal.sdpMLineIndex,
            sdpMid: signal.sdpMid
          }));
          console.log(`✅ ICE candidate added successfully for ${peerId.substring(0, 8)}...`);
        } catch (error) {
          console.error(`❌ Failed to add ICE candidate for ${peerId.substring(0, 8)}...:`, error);
        }
      }

    } catch (error) {
      // Perfect Negotiation: Handle signaling errors gracefully
      if (isPolite && signal.type === 'offer') {
        console.log(`🤝 Perfect Negotiation - Polite peer handling offer error gracefully for ${peerId.substring(0, 8)}...`);
        console.warn(`⚠️ Polite signaling error from ${peerId}:`, error.message || error);
      } else {
        console.error(`❌ Error processing signal from ${peerId}:`, error.message || error);
        console.error(`❌ Signal type: ${signal.type}, Error stack:`, error.stack);
        this.destroyConnection(peerId, 'signal_error');
      }
    } finally {
      // Clear processing flag
      this.processingSignal = false;
    }
  }

  /**
   * Process queued signals after remote description is set
   */
  async processQueuedSignals() {
    if (!this.signalQueue || this.signalQueue.length === 0) {
      return;
    }

    const peerId = this.peerId;
    console.log(`🔄 Processing ${this.signalQueue.length} queued signals for ${peerId.substring(0, 8)}...`);
    const pc = this.connection;

    if (!pc) {
      console.warn(`⚠️ No connection found for ${peerId} when processing queued signals`);
      return;
    }

    // Process all queued ICE candidates
    for (const signal of this.signalQueue) {
      try {
        if (signal.type === 'candidate') {
          await pc.addIceCandidate(new RTCIceCandidate({
            candidate: signal.candidate,
            sdpMLineIndex: signal.sdpMLineIndex,
            sdpMid: signal.sdpMid
          }));
        }
      } catch (error) {
        console.error(`❌ Error processing queued signal for ${peerId}:`, error);
      }
    }

    // Clear the queue
    this.signalQueue = [];
  }

  /**
   * Handle synchronized ICE start signal (Task 4.2: Coordinated ICE timing)
   * 
   * This implements the Tailscale technique for synchronized NAT traversal:
   * - Both peers have exchanged ICE candidates via the bootstrap server
   * - Bootstrap server sends ice_start to BOTH peers at the same time
   * - Both peers add each other's candidates simultaneously
   * - Packets cross in flight, opening both firewalls at the same time
   * 
   * This is especially effective for symmetric NAT ↔ cone NAT pairs where
   * timing matters for successful hole punching.
   * 
   * @param {Object} data - ICE start data
   * @param {string} data.peerId - The peer we're coordinating with
   * @param {Array} data.peerCandidates - Peer's ICE candidates to add
   * @param {Object} data.peerProfile - Peer's connection profile (NAT type, etc.)
   * @param {string} data.sessionId - Session ID for tracking
   */
  async handleIceStart(data) {
    const { peerId, peerCandidates, peerProfile, sessionId } = data;
    
    console.log(`❄️ [WebRTC] Synchronized ICE start for ${peerId?.substring(0, 8)}...`);
    console.log(`   Session: ${sessionId?.substring(0, 12)}...`);
    console.log(`   Peer candidates: ${peerCandidates?.length || 0}`);
    console.log(`   Peer NAT type: ${peerProfile?.natType || 'unknown'}`);
    
    // Validate we have a peer connection
    const pc = this.connection;
    if (!pc) {
      console.warn(`❄️ [WebRTC] No peer connection for synchronized ICE start to ${peerId?.substring(0, 8)}...`);
      // Emit event so HybridConnectionManager can handle it
      this.emit('iceStartFailed', { peerId, reason: 'no_connection', sessionId });
      return;
    }
    
    // Validate peer ID matches
    if (this.peerId && this.peerId !== peerId) {
      console.warn(`❄️ [WebRTC] Peer ID mismatch for ICE start: expected ${this.peerId?.substring(0, 8)}..., got ${peerId?.substring(0, 8)}...`);
      this.emit('iceStartFailed', { peerId, reason: 'peer_mismatch', sessionId });
      return;
    }
    
    // Check if we have remote description set (required for adding candidates)
    if (!this.remoteDescriptionSet) {
      console.log(`❄️ [WebRTC] Remote description not set yet, queuing ${peerCandidates?.length || 0} candidates for synchronized start`);
      // Queue the candidates - they'll be processed when remote description is set
      if (peerCandidates && peerCandidates.length > 0) {
        for (const candidate of peerCandidates) {
          this.signalQueue.push({
            type: 'candidate',
            candidate: candidate.candidate || candidate,
            sdpMLineIndex: candidate.sdpMLineIndex || 0,
            sdpMid: candidate.sdpMid || '0'
          });
        }
        console.log(`❄️ [WebRTC] Queued ${peerCandidates.length} candidates for later processing`);
      }
      return;
    }
    
    // Add peer's ICE candidates to trigger connectivity checks
    // This is the synchronized moment - both peers do this at the same time
    if (peerCandidates && peerCandidates.length > 0) {
      console.log(`❄️ [WebRTC] Adding ${peerCandidates.length} peer candidates NOW (synchronized)`);
      
      let addedCount = 0;
      let failedCount = 0;
      
      for (const candidate of peerCandidates) {
        try {
          // Handle both raw candidate strings and candidate objects
          const candidateStr = candidate.candidate || candidate;
          const sdpMLineIndex = candidate.sdpMLineIndex ?? 0;
          const sdpMid = candidate.sdpMid ?? '0';
          
          await pc.addIceCandidate(new RTCIceCandidate({
            candidate: candidateStr,
            sdpMLineIndex,
            sdpMid
          }));
          
          addedCount++;
          
          // Log candidate type for debugging
          const candidateType = candidateStr.includes('typ host') ? 'host' :
                               candidateStr.includes('typ srflx') ? 'srflx' :
                               candidateStr.includes('typ relay') ? 'relay' : 'unknown';
          console.log(`   ✅ Added ${candidateType} candidate`);
          
        } catch (error) {
          failedCount++;
          console.warn(`   ❌ Failed to add candidate: ${error.message}`);
        }
      }
      
      console.log(`❄️ [WebRTC] Synchronized ICE start complete: ${addedCount} added, ${failedCount} failed`);
      
      // Emit success event
      this.emit('iceStarted', {
        peerId,
        sessionId,
        candidatesAdded: addedCount,
        candidatesFailed: failedCount,
        peerNatType: peerProfile?.natType
      });
      
      // Log current ICE state for debugging
      console.log(`❄️ [WebRTC] ICE state after synchronized start: connection=${pc.connectionState}, ice=${pc.iceConnectionState}, gathering=${pc.iceGatheringState}`);
      
    } else {
      console.log(`❄️ [WebRTC] No peer candidates to add for synchronized start`);
      this.emit('iceStarted', {
        peerId,
        sessionId,
        candidatesAdded: 0,
        candidatesFailed: 0,
        peerNatType: peerProfile?.natType
      });
    }
  }

  /**
   * Send raw message via WebRTC DataChannel
   */
  async sendRawMessage(peerId, message) {
    // Validate peerId matches expected peer
    if (this.peerId !== peerId) {
      throw new Error(`Peer ID mismatch: expected ${this.peerId}, got ${peerId}`);
    }

    if (!this.dataChannel) {
      throw new Error(`No data channel to peer ${peerId}`);
    }

    if (this.dataChannel.readyState !== 'open') {
      throw new Error(`Data channel to ${peerId} is not open`);
    }

    const messageStr = typeof message === 'string' ? message : JSON.stringify(message);

    try {
      this.dataChannel.send(messageStr);
      return true;
    } catch (error) {
      console.error(`Failed to send data to ${peerId}:`, error);
      throw error;
    }
  }

  /**
   * Check if connected (no peerId parameter needed)
   */
  isConnected() {
    if (!this.connection) return false;

    // Check WebRTC connection
    return this.connection.connectionState === 'connected';
  }

  /**
   * Destroy connection with proper resource cleanup.
   * Uses safeCleanup for state-aware, ordered cleanup.
   * 
   * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
   * 
   * @param {string} peerId - Peer ID to disconnect
   * @param {string} reason - Reason for disconnection
   * @returns {Promise<void>}
   */
  async destroyConnection(peerId, reason = 'manual') {
    // Delegate to safeCleanup for proper state-aware, ordered cleanup
    await this.safeCleanup(reason);
  }

  /**
   * Clean up connection data using safeCleanup.
   * This method is kept for backward compatibility but now delegates to safeCleanup.
   * 
   * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
   * 
   * @returns {Promise<void>}
   */
  async cleanupConnection() {
    // Delegate to safeCleanup for proper state-aware, ordered cleanup
    await this.safeCleanup('cleanup');
  }

  // ===========================================
  // KEEP-ALIVE SYSTEM
  // ===========================================

  /**
   * Start keep-alive for the peer connection
   */
  startKeepAlive() {
    if (!this.isConnected()) {
      console.warn(`⚠️ Cannot start keep-alive for disconnected peer`);
      return;
    }

    // Don't start if already running
    if (this.keepAliveIntervalId) {
      return;
    }

    const interval = this.isTabVisible ? this.keepAliveInterval : this.keepAliveIntervalHidden;

    // Initialize tracking structures
    this.keepAlivePings = new Set();
    this.keepAliveLastResponse = Date.now();
    this.keepAliveTimeouts = new Set();

    // Set up keep-alive interval
    this.keepAliveIntervalId = setInterval(() => {
      this.sendKeepAlivePing();
    }, interval);
  }

  /**
   * Stop keep-alive for the peer connection
   */
  stopKeepAlive() {
    if (this.keepAliveIntervalId) {
      clearInterval(this.keepAliveIntervalId);
      this.keepAliveIntervalId = null;
    }

    // Clean up tracking structures
    this.keepAlivePings = new Set();
    this.keepAliveLastResponse = null;

    // Clear any pending timeouts
    if (this.keepAliveTimeouts) {
      for (const timeoutId of this.keepAliveTimeouts) {
        clearTimeout(timeoutId);
      }
      this.keepAliveTimeouts = new Set();
    }
  }

  /**
   * Send keep-alive ping to peer
   * Task 5.1: Handle NAT mapping timeout by sending periodic packets
   * 
   * This method serves two purposes:
   * 1. Detect connection failures (peer not responding)
   * 2. Keep NAT mappings alive by sending traffic before they expire
   * 
   * NAT mappings typically expire after 30 seconds of inactivity for UDP.
   * By sending keep-alive pings every 25 seconds, we ensure the mapping
   * stays active and the connection remains viable.
   */
  async sendKeepAlivePing() {
    if (!this.isConnected()) {
      this.stopKeepAlive();
      return;
    }

    const peerId = this.peerId;

    try {
      const pingMessage = {
        type: 'keep_alive_ping',
        pingId: `ping_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        timestamp: Date.now(),
        tabVisible: this.isTabVisible,
        // Include NAT refresh info for debugging/monitoring
        natRefresh: true
      };

      // Add to pending pings
      this.keepAlivePings.add(pingMessage.pingId);
      
      // Track NAT mapping refresh time
      // This helps monitor if we're keeping the NAT mapping alive
      this.lastNatRefreshTime = Date.now();

      // Send ping message
      if (this.dataChannel && this.dataChannel.readyState === 'open') {
        this.dataChannel.send(JSON.stringify(pingMessage));

        // Set timeout for pong response
        const timeoutId = setTimeout(() => {
          if (this.keepAlivePings.has(pingMessage.pingId)) {
            this.keepAlivePings.delete(pingMessage.pingId);

            // Check if we have too many failed pings
            const lastResponse = this.keepAliveLastResponse || 0;
            const timeSinceLastResponse = Date.now() - lastResponse;

            if (timeSinceLastResponse > this.keepAliveTimeout * 2) {
              console.error(`❌ Peer ${peerId.substring(0, 8)}... not responding to keep-alive pings, marking as failed`);
              // NAT mapping may have expired - connection is likely dead
              this.emit('natMappingExpired', {
                peerId,
                lastRefresh: this.lastNatRefreshTime,
                timeSinceLastResponse
              });
              this.destroyConnection(peerId, 'keep_alive_timeout');
            }
          }
        }, this.keepAliveTimeout);

        // Track timeout for cleanup
        this.keepAliveTimeouts.add(timeoutId);

      } else {
        this.stopKeepAlive();
      }

    } catch (error) {
      console.error(`❌ Failed to send keep-alive ping to ${peerId}:`, error);
    }
  }

  /**
   * Handle incoming keep-alive ping from peer
   */
  handleKeepAlivePing(pingMessage) {
    try {
      // Send pong response
      const pongMessage = {
        type: 'keep_alive_pong',
        pingId: pingMessage.pingId,
        originalTimestamp: pingMessage.timestamp,
        responseTimestamp: Date.now(),
        tabVisible: this.isTabVisible
      };

      if (this.dataChannel && this.dataChannel.readyState === 'open') {
        this.dataChannel.send(JSON.stringify(pongMessage));
      }

    } catch (error) {
      console.error(`❌ Failed to send keep-alive pong:`, error);
    }
  }

  /**
   * Handle incoming keep-alive pong from peer
   * Task 4.4: Add RTT measurement to WebRTC path (existing keep-alive)
   * Task 5.1: Track NAT mapping refresh - receiving a pong confirms the mapping is alive
   */
  handleKeepAlivePong(pongMessage) {
    // Remove from pending pings
    if (this.keepAlivePings.has(pongMessage.pingId)) {
      this.keepAlivePings.delete(pongMessage.pingId);
    }

    // Update last response timestamp
    this.keepAliveLastResponse = Date.now();
    
    // Task 5.1: Track NAT mapping refresh - receiving a pong confirms the mapping is alive
    // This is important for monitoring NAT mapping health
    this.lastNatRefreshTime = Date.now();
    
    // Task 4.4: Calculate RTT from the original timestamp
    if (pongMessage.originalTimestamp) {
      const rtt = Date.now() - pongMessage.originalTimestamp;
      
      // Store RTT measurement
      this._lastRtt = rtt;
      
      // Update RTT history for averaging
      if (!this._rttHistory) {
        this._rttHistory = [];
      }
      this._rttHistory.push({
        rtt,
        timestamp: Date.now()
      });
      
      // Keep only last 10 samples
      while (this._rttHistory.length > 10) {
        this._rttHistory.shift();
      }
      
      // Calculate average RTT
      const avgRtt = Math.round(
        this._rttHistory.reduce((sum, s) => sum + s.rtt, 0) / this._rttHistory.length
      );
      this._avgRtt = avgRtt;
      
      // Calculate jitter (standard deviation)
      if (this._rttHistory.length >= 2) {
        const variance = this._rttHistory.reduce(
          (sum, s) => sum + Math.pow(s.rtt - avgRtt, 2), 0
        ) / this._rttHistory.length;
        this._rttJitter = Math.sqrt(variance);
      }
      
      // Emit event for HybridConnectionManager/PathTracker integration
      this.emit('rttMeasured', {
        peerId: this.peerId,
        rtt,
        avgRtt: this._avgRtt,
        jitter: this._rttJitter,
        pingId: pongMessage.pingId
      });
    }
  }
  
  /**
   * Get the last measured RTT for this WebRTC connection
   * Task 4.4: RTT measurement getter
   * @returns {number|null} Last RTT in milliseconds, or null if not measured
   */
  getLastRtt() {
    return this._lastRtt || null;
  }
  
  /**
   * Get the average RTT for this WebRTC connection
   * Task 4.4: Average RTT getter
   * @returns {number|null} Average RTT in milliseconds, or null if not measured
   */
  getAverageRtt() {
    return this._avgRtt || null;
  }
  
  /**
   * Get RTT jitter (standard deviation) for this WebRTC connection
   * Task 4.4: RTT jitter getter
   * @returns {number|null} RTT jitter in milliseconds, or null if not enough samples
   */
  getRttJitter() {
    return this._rttJitter || null;
  }
  
  /**
   * Get full RTT statistics for this WebRTC connection
   * Task 4.4: Comprehensive RTT stats
   * @returns {Object} RTT statistics { lastRtt, avgRtt, jitter, sampleCount }
   */
  getRttStats() {
    return {
      lastRtt: this._lastRtt || null,
      avgRtt: this._avgRtt || null,
      jitter: this._rttJitter || null,
      sampleCount: this._rttHistory?.length || 0
    };
  }

  /**
   * Clean up all keep-alive timers
   */
  cleanupAllKeepAlives() {
    if (this.keepAliveIntervalId) {
      clearInterval(this.keepAliveIntervalId);
      this.keepAliveIntervalId = null;
    }

    this.keepAlivePings = new Set();
    this.keepAliveLastResponse = null;

    // Clear all pending timeouts
    if (this.keepAliveTimeouts) {
      for (const timeoutId of this.keepAliveTimeouts) {
        clearTimeout(timeoutId);
      }
      this.keepAliveTimeouts = new Set();
    }
  }

  /**
   * Debug WebRTC connection states and issues
   */
  debugWebRTCStates() {
    console.log('=== WebRTC Connection Debug Report ===');

    const report = {
      peerId: this.peerId ? this.peerId.substring(0, 8) : 'none',
      hasConnection: !!this.connection,
      connectionState: this.connectionState,
      connection: null
    };

    if (this.connection instanceof RTCPeerConnection) {
      report.connection = {
        peerId: this.peerId ? this.peerId.substring(0, 8) : 'unknown',
        connectionState: this.connection.connectionState,
        iceConnectionState: this.connection.iceConnectionState,
        iceGatheringState: this.connection.iceGatheringState,
        signalingState: this.connection.signalingState,
        hasDataChannel: !!this.dataChannel,
        dataChannelState: this.dataChannel?.readyState || 'none'
      };

      console.log(`Connection to ${this.peerId?.substring(0, 8)}:`, report.connection);
    }

    return report;
  }

  /**
   * Check connection health
   */
  checkConnectionHealth() {
    console.log('=== WebRTC Connection Health Check ===');

    const status = {
      peerId: this.peerId ? this.peerId.substring(0, 8) : 'none',
      connected: this.isConnected(),
      state: this.connectionState
    };

    if (this.connection instanceof RTCPeerConnection) {
      status.connectionState = this.connection.connectionState;
      status.iceConnectionState = this.connection.iceConnectionState;
    }

    const healthReport = {
      healthy: this.connection?.connectionState === 'connected' ? [status] : [],
      unhealthy: this.connection && this.connection.connectionState !== 'connected' && this.connection.connectionState !== 'connecting' ? [status] : [],
      pending: this.connection?.connectionState === 'connecting' ? [status] : []
    };

    console.log('Health Report:', {
      healthy: healthReport.healthy.length,
      pending: healthReport.pending.length,
      unhealthy: healthReport.unhealthy.length
    });

    return healthReport;
  }

  /**
   * Destroy the WebRTCConnectionManager and clean up all resources.
   * Uses safeCleanup for proper state-aware cleanup with Promise.allSettled
   * to handle failures gracefully without throwing exceptions.
   * 
   * Requirements: 7.1, 7.2, 7.3, 7.4
   * @returns {Promise<void>}
   */
  async destroy() {
    if (this.isDestroyed) return;

    console.log('🚀 Destroying WebRTCConnectionManager');

    // Clean up all keep-alive timers first
    this.cleanupAllKeepAlives();

    // Collect all cleanup promises for active connections
    const cleanupPromises = [];

    // Clean up the main connection if it exists
    if (this.connection) {
      if (this.connection.timeout) clearTimeout(this.connection.timeout);
      cleanupPromises.push(this.safeCleanup('shutdown'));
    }

    // Wait for all cleanups to complete using Promise.allSettled
    // This ensures we attempt cleanup on all connections even if some fail
    if (cleanupPromises.length > 0) {
      const results = await Promise.allSettled(cleanupPromises);

      // Log any failures but don't throw
      for (const result of results) {
        if (result.status === 'rejected') {
          console.error('⚠️ Cleanup failed during destroy:', result.reason);
        }
      }
    }

    // Verify all connections are cleaned up
    const stats = ConnectionTracker.getResourceStats();
    if (stats.activeConnections > 0) {
      console.warn(`⚠️ ${stats.activeConnections} active connections remain after destroy`);
    }

    // Clear peerId before calling super.destroy() to prevent it from calling destroyConnection
    // (which would fail since we already cleaned up the connection)
    this.peerId = null;
    this.connection = null;

    // Call parent destroy
    super.destroy();
  }

  /**
   * Restart ICE for the peer connection (Task 4.3: Coordinated ICE restart for hard NAT pairs)
   * 
   * This implements the coordinated ICE restart technique:
   * 1. Both peers call pc.restartIce() at the same time (coordinated via bootstrap server)
   * 2. Fresh NAT mappings are created
   * 3. New ICE candidates are gathered and exchanged
   * 4. Sometimes NAT state changes help establish direct connection
   * 
   * This is especially useful for hard NAT ↔ hard NAT pairs where initial ICE failed.
   * 
   * @param {Object} options - Restart options
   * @param {string} options.peerId - The peer we're restarting ICE with
   * @param {string} options.sessionId - Session ID for tracking
   * @returns {Promise<boolean>} True if restart was initiated successfully
   */
  async restartIce(options = {}) {
    const { peerId, sessionId } = options;
    const pc = this.connection;
    
    if (!pc) {
      console.warn(`❄️ [WebRTC] Cannot restart ICE - no peer connection`);
      this.emit('iceRestartFailed', { peerId, reason: 'no_connection', sessionId });
      return false;
    }
    
    // Validate peer ID matches
    if (this.peerId && peerId && this.peerId !== peerId) {
      console.warn(`❄️ [WebRTC] Peer ID mismatch for ICE restart: expected ${this.peerId?.substring(0, 8)}..., got ${peerId?.substring(0, 8)}...`);
      this.emit('iceRestartFailed', { peerId, reason: 'peer_mismatch', sessionId });
      return false;
    }
    
    const targetPeerId = peerId || this.peerId;
    console.log(`❄️ [WebRTC] Initiating ICE restart for ${targetPeerId?.substring(0, 8)}... (session: ${sessionId?.substring(0, 12) || 'none'})`);
    
    try {
      // Reset ICE-related state for fresh gathering
      this.candidateTypes = { host: 0, srflx: 0, relay: 0 };
      
      // Track that we're doing an ICE restart
      this._iceRestartInProgress = true;
      this._iceRestartSessionId = sessionId;
      
      // Call the WebRTC API to restart ICE
      // This triggers new ICE candidate gathering with fresh NAT mappings
      pc.restartIce();
      
      console.log(`❄️ [WebRTC] ICE restart triggered, creating new offer...`);
      
      // Create a new offer with ICE restart flag
      // The iceRestart option tells the browser to generate new ICE credentials
      const offer = await pc.createOffer({ iceRestart: true });
      // Task 6.1: Apply IPv6 prioritization before setting local description
      // This boosts IPv6 host candidate priorities to prefer direct IPv6 connections
      const modifiedOffer = await this._setLocalDescriptionWithIPv6Priority(pc, offer);
      
      console.log(`❄️ [WebRTC] New offer created after ICE restart for ${targetPeerId?.substring(0, 8)}... (IPv6 prioritized)`);
      
      // Reset remote description state since we're starting fresh
      this.remoteDescriptionSet = false;
      this.signalQueue = [];
      
      // Send the new offer through signaling
      await this.sendSignal(targetPeerId, {
        type: 'offer',
        sdp: modifiedOffer.sdp,
        iceRestart: true,  // Flag to indicate this is an ICE restart offer
        sessionId
      });
      
      console.log(`❄️ [WebRTC] ICE restart offer sent to ${targetPeerId?.substring(0, 8)}...`);
      
      // Emit success event
      this.emit('iceRestartInitiated', {
        peerId: targetPeerId,
        sessionId,
        timestamp: Date.now()
      });
      
      return true;
      
    } catch (error) {
      console.error(`❄️ [WebRTC] ICE restart failed for ${targetPeerId?.substring(0, 8)}...:`, error);
      this._iceRestartInProgress = false;
      this._iceRestartSessionId = null;
      
      this.emit('iceRestartFailed', {
        peerId: targetPeerId,
        reason: error.message,
        sessionId
      });
      
      return false;
    }
  }

  /**
   * Extract the selected ICE candidate pair from the RTCPeerConnection stats.
   * This is used to track which candidate types actually resulted in successful connections.
   * 
   * Task 1.3: Track ICE candidate types used for successful connections
   * 
   * @param {RTCPeerConnection} pc - The peer connection to get stats from
   * @returns {Promise<Object|null>} The selected candidate pair info or null
   */
  async _getSelectedCandidatePair(pc) {
    if (!pc || pc.connectionState !== 'connected') {
      return null;
    }

    try {
      const stats = await pc.getStats();
      let selectedPair = null;
      const candidates = new Map();

      // First pass: collect all candidate info
      stats.forEach(report => {
        if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
          candidates.set(report.id, {
            type: report.candidateType, // host, srflx, prflx, relay
            address: report.address || report.ip,
            port: report.port,
            protocol: report.protocol
          });
        }
      });

      // Second pass: find the selected candidate pair
      stats.forEach(report => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          // This is the active candidate pair
          const localCandidate = candidates.get(report.localCandidateId);
          const remoteCandidate = candidates.get(report.remoteCandidateId);

          if (localCandidate && remoteCandidate) {
            selectedPair = {
              localType: localCandidate.type,
              remoteType: remoteCandidate.type,
              localAddress: localCandidate.address,
              remoteAddress: remoteCandidate.address,
              protocol: localCandidate.protocol || remoteCandidate.protocol
            };
          }
        }
      });

      if (selectedPair) {
        console.log(`🧊 Selected ICE candidate pair: local=${selectedPair.localType} (${selectedPair.localAddress}), remote=${selectedPair.remoteType} (${selectedPair.remoteAddress}), protocol=${selectedPair.protocol}`);
      }

      return selectedPair;
    } catch (error) {
      console.warn(`Failed to get ICE stats: ${error.message}`);
      return null;
    }
  }

  /**
   * Check if an address is a global IPv6 address
   * Task 4.4: Used to detect IPv6 connections for path preference
   * 
   * Global unicast IPv6 addresses start with 2xxx: or 3xxx:
   * This excludes link-local (fe80::), loopback (::1), and private addresses
   * 
   * @param {string} address - The IP address to check
   * @returns {boolean} True if the address is a global IPv6 address
   */
  _isIPv6Address(address) {
    if (!address) return false;
    // Global unicast addresses start with 2 or 3
    return /^[23][0-9a-f]{3}:/i.test(address);
  }

  /**
   * Prioritize IPv6 host candidates over IPv4 in SDP
   * Task 6.1: IPv6 bypasses NAT entirely, so it should be preferred
   * 
   * ICE candidate priorities in SDP are encoded in the 'a=candidate' lines.
   * The priority is a 32-bit value where higher = more preferred.
   * 
   * Format: a=candidate:<foundation> <component> <protocol> <priority> <address> <port> typ <type> ...
   * 
   * This method boosts the priority of IPv6 host candidates by adding a large
   * value to their existing priority, making them preferred over IPv4 candidates.
   * 
   * Why prioritize IPv6:
   * - IPv6 addresses are globally routable (no NAT traversal needed)
   * - Direct IPv6 connections have lower latency than STUN-discovered paths
   * - IPv6 connections are more reliable (no NAT mapping timeouts)
   * 
   * @param {string} sdp - The SDP string to modify
   * @returns {string} Modified SDP with boosted IPv6 candidate priorities
   */
  _prioritizeIPv6Candidates(sdp) {
    if (!sdp) return sdp;

    // Split SDP into lines for processing
    const lines = sdp.split('\r\n');
    const modifiedLines = [];
    let ipv6CandidatesFound = 0;
    let ipv4CandidatesFound = 0;

    // Priority boost for IPv6 candidates
    // ICE priority is a 32-bit unsigned integer (max ~4.3 billion)
    // We add 2^24 (~16 million) to IPv6 host candidates to ensure they're preferred
    // This is large enough to override type preference but not overflow
    const IPV6_PRIORITY_BOOST = 16777216; // 2^24

    for (const line of lines) {
      // Check if this is a candidate line
      if (line.startsWith('a=candidate:')) {
        // Parse the candidate line
        // Format: a=candidate:<foundation> <component> <protocol> <priority> <address> <port> typ <type> ...
        const parts = line.split(' ');
        
        if (parts.length >= 8) {
          const address = parts[4];
          const candidateType = parts[7]; // 'host', 'srflx', 'relay'
          
          // Check if this is an IPv6 address (contains colons, not just port separator)
          // IPv6 addresses contain multiple colons (e.g., 2001:db8::1)
          // IPv4 addresses don't contain colons in the address part
          const isIPv6 = address && address.includes(':') && this._isIPv6Address(address);
          
          if (isIPv6 && candidateType === 'host') {
            // Boost priority for IPv6 host candidates
            const currentPriority = parseInt(parts[3], 10);
            if (!isNaN(currentPriority)) {
              // Add boost but cap at max 32-bit unsigned value
              const newPriority = Math.min(currentPriority + IPV6_PRIORITY_BOOST, 4294967295);
              parts[3] = newPriority.toString();
              
              ipv6CandidatesFound++;
              console.log(`🌐 IPv6 priority boost: ${address} (${candidateType}) ${currentPriority} → ${newPriority}`);
            }
            modifiedLines.push(parts.join(' '));
          } else {
            // Keep IPv4 and non-host candidates unchanged
            if (!isIPv6 && candidateType === 'host') {
              ipv4CandidatesFound++;
            }
            modifiedLines.push(line);
          }
        } else {
          // Malformed candidate line, keep as-is
          modifiedLines.push(line);
        }
      } else {
        // Non-candidate line, keep as-is
        modifiedLines.push(line);
      }
    }

    if (ipv6CandidatesFound > 0) {
      console.log(`🌐 IPv6 prioritization: boosted ${ipv6CandidatesFound} IPv6 host candidates over ${ipv4CandidatesFound} IPv4 host candidates`);
    }

    return modifiedLines.join('\r\n');
  }

  /**
   * Create and set local description with IPv6 prioritization
   * Task 6.1: Wrapper that applies IPv6 prioritization before setting local description
   * 
   * @param {RTCPeerConnection} pc - The peer connection
   * @param {RTCSessionDescriptionInit} description - The offer or answer
   * @returns {Promise<void>}
   */
  async _setLocalDescriptionWithIPv6Priority(pc, description) {
    // Apply IPv6 prioritization to the SDP
    const modifiedSdp = this._prioritizeIPv6Candidates(description.sdp);
    
    // Create modified description
    const modifiedDescription = {
      type: description.type,
      sdp: modifiedSdp
    };
    
    // Set the modified local description
    await pc.setLocalDescription(modifiedDescription);
    
    return modifiedDescription;
  }
}
