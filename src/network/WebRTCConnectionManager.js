import { ConnectionManager } from './ConnectionManager.js';

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
      iceServers: options.iceServers || [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        // Multiple TURN servers for better reliability
        { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
        // More reliable TURN servers
        { urls: 'turn:relay.metered.ca:80', username: 'f60e8e5b8493fa5e8b6fcbb1', credential: 'hIvFMxNqIRobbdxC' },
        { urls: 'turn:relay.metered.ca:443', username: 'f60e8e5b8493fa5e8b6fcbb1', credential: 'hIvFMxNqIRobbdxC' },
        { urls: 'turn:relay.metered.ca:443?transport=tcp', username: 'f60e8e5b8493fa5e8b6fcbb1', credential: 'hIvFMxNqIRobbdxC' }
      ],
      ...options
    };

    // WebRTC-specific state
    this.dataChannels = new Map(); // peerId -> RTCDataChannel
    this.pendingConnections = new Map(); // peerId -> connection attempt info
    this.signalQueues = new Map(); // peerId -> array of queued signals
    this.remoteDescriptionSet = new Map(); // peerId -> boolean (has remote description)
    this.offerCollisions = new Map(); // peerId -> collision detection state for Perfect Negotiation
    this.handshakeCompleted = new Map(); // peerId -> boolean (prevent duplicate metadata updates)
    this.processingSignals = new Map(); // peerId -> boolean (prevent concurrent signal processing)

    // Keep-alive system for browser tab visibility
    this.keepAliveIntervals = new Map(); // peerId -> intervalId
    this.keepAlivePings = new Map(); // peerId -> Set of pending pings
    this.keepAliveResponses = new Map(); // peerId -> last response timestamp
    this.keepAliveTimeouts = new Map(); // peerId -> Set of timeout IDs
    this.isTabVisible = true;
    this.keepAliveInterval = 30000; // 30 seconds for active tabs
    this.keepAliveIntervalHidden = 10000; // 10 seconds for inactive tabs
    this.keepAliveTimeout = 60000; // 60 seconds to wait for pong response
    
    // Initialize Page Visibility API if available
    if (typeof document !== 'undefined') {
      this.setupVisibilityHandling();
    }
  }

  /**
   * Setup Page Visibility API handling for keep-alive frequency adjustment
   */
  setupVisibilityHandling() {
    if (typeof document === 'undefined') return;

    // Set initial visibility state
    this.isTabVisible = !document.hidden;
    
    console.log(`📱 Setting up visibility handling. Initial state: ${this.isTabVisible ? 'visible' : 'hidden'}`);

    // Listen for visibility changes
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
      // Restart keep-alive for all connected peers with new frequency
      const peerIds = Array.from(this.keepAliveIntervals.keys());
      for (const peerId of peerIds) {
        if (this.isConnected(peerId)) {
          this.stopKeepAlive(peerId);
          this.startKeepAlive(peerId);
        }
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
   */
  async createConnection(peerId, initiator = true) {
    if (this.isDestroyed) {
      throw new Error('WebRTCConnectionManager is destroyed');
    }

    if (this.connections.has(peerId)) {
      throw new Error(`Connection to ${peerId} already exists`);
    }

    if (this.connections.size >= this.options.maxConnections) {
      throw new Error('Maximum connections reached');
    }

    console.log(`🚀 Creating ${initiator ? 'outgoing' : 'incoming'} WebRTC connection to ${peerId.substring(0, 8)}...`);

    // Create RTCPeerConnection
    const pc = new RTCPeerConnection({
      iceServers: this.rtcOptions.iceServers,
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 10
    });

    this.connections.set(peerId, pc);
    this.connectionStates.set(peerId, 'connecting');

    // Setup peer connection events
    this.setupPeerConnectionEvents(peerId, pc, initiator);

    this.pendingConnections.set(peerId, {
      startTime: Date.now(),
      initiator,
      pc
    });

    // Set connection timeout
    const timeout = setTimeout(() => {
      if (this.connectionStates.get(peerId) === 'connecting') {
        console.warn(`⏰ Connection timeout for peer ${peerId.substring(0, 8)}... after ${this.options.timeout}ms`);
        console.warn(`🔍 Final connection state:`, {
          connectionState: pc.connectionState,
          iceConnectionState: pc.iceConnectionState,
          signalingState: pc.signalingState
        });
        this.destroyConnection(peerId, 'timeout');
      }
    }, this.options.timeout);

    pc.timeout = timeout;

    if (initiator) {
      // Create data channel for outgoing connections
      const dataChannel = pc.createDataChannel('dht-data', {
        ordered: true
      });
      this.setupDataChannelEvents(peerId, dataChannel);
      this.dataChannels.set(peerId, dataChannel);

      // Create offer
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        console.log(`📤 Created offer for ${peerId.substring(0, 8)}...`);
        
        // Send offer through appropriate signaling channel
        await this.sendSignal(peerId, {
          type: 'offer',
          sdp: offer.sdp
        });
      } catch (error) {
        console.error(`❌ Failed to create offer for ${peerId}:`, error);
        this.destroyConnection(peerId, 'offer_failed');
        throw error;
      }
    }

    return new Promise((resolve, reject) => {
      const checkConnection = () => {
        const state = this.connectionStates.get(peerId);
        if (state === 'connected') {
          clearTimeout(timeout);
          resolve(pc);
        } else if (state === 'failed' || state === 'disconnected') {
          clearTimeout(timeout);
          reject(new Error(`Connection failed: ${state}`));
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
        if (this.connectionStates.get(peerId) === 'connecting') {
          reject(new Error('Connection timeout'));
        }
      }, this.options.timeout);
    });
  }

  /**
   * Setup peer connection events
   */
  setupPeerConnectionEvents(peerId, pc, initiator) {
    console.log(`🔧 Setting up events for peer: ${peerId.substring(0, 8)}... (initiator: ${initiator})`);
    console.log(`🔍 WebRTC Peer Connection state: ${pc.connectionState}, ICE state: ${pc.iceConnectionState}, Signaling state: ${pc.signalingState}`);

    // ICE candidate gathering with enhanced debugging
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log(`🧊 ICE candidate for ${peerId.substring(0, 8)}...: ${event.candidate.type} (${event.candidate.protocol}:${event.candidate.address}:${event.candidate.port})`);
        // Send ICE candidate through appropriate signaling channel
        this.sendSignal(peerId, {
          type: 'candidate',
          candidate: event.candidate.candidate,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
          sdpMid: event.candidate.sdpMid
        }).catch(error => {
          console.warn(`Failed to send ICE candidate for ${peerId}:`, error);
        });
      } else {
        console.log(`🏁 ICE gathering complete for ${peerId.substring(0, 8)}...`);
      }
    };

    // Connection state changes
    pc.onconnectionstatechange = () => {
      console.log(`🔗 Connection state for ${peerId.substring(0, 8)}...: ${pc.connectionState}`);

      if (pc.connectionState === 'connected') {
        clearTimeout(pc.timeout);
        this.connectionStates.set(peerId, 'connected');
        this.pendingConnections.delete(peerId);

        console.log(`✅ WebRTC Connected to ${peerId.substring(0, 8)}... - EMITTING peerConnected EVENT`);
        this.emit('peerConnected', { peerId, connection: pc });

        // Start keep-alive for this connection
        this.startKeepAlive(peerId);

      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        console.log(`❌ Connection failed/disconnected for ${peerId.substring(0, 8)}...: ${pc.connectionState}`);
        this.connectionStates.set(peerId, pc.connectionState);
        this.stopKeepAlive(peerId);
        this.cleanupConnection(peerId);
        this.emit('peerDisconnected', { peerId, reason: pc.connectionState });
      } else {
        console.log(`🔄 WebRTC connection state transition for ${peerId.substring(0, 8)}...: ${pc.connectionState} (waiting for 'connected')`);
        this.connectionStates.set(peerId, pc.connectionState);
      }
    };

    // ICE connection state changes with enhanced debugging
    pc.oniceconnectionstatechange = () => {
      console.log(`🧊 ICE connection state for ${peerId.substring(0, 8)}...: ${pc.iceConnectionState}`);

      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        console.log(`✅ ICE connection established for ${peerId.substring(0, 8)}...: ${pc.iceConnectionState}`);
      } else if (pc.iceConnectionState === 'failed') {
        console.error(`❌ ICE connection failed for ${peerId.substring(0, 8)}...`);
        this.destroyConnection(peerId, 'ice_failed');
      } else if (pc.iceConnectionState === 'checking') {
        console.log(`🔍 ICE connectivity checks started for ${peerId.substring(0, 8)}...`);
      } else if (pc.iceConnectionState === 'disconnected') {
        console.warn(`⚠️ ICE connection disconnected for ${peerId.substring(0, 8)}...`);
      } else {
        console.log(`🧊 ICE state transition for ${peerId.substring(0, 8)}...: ${pc.iceConnectionState}`);
      }
    };

    // Data channel handling for incoming connections
    if (!initiator) {
      pc.ondatachannel = (event) => {
        console.log(`📥 Received data channel from ${peerId.substring(0, 8)}...`);
        const dataChannel = event.channel;
        this.setupDataChannelEvents(peerId, dataChannel);
        this.dataChannels.set(peerId, dataChannel);
      };
    }

    // ICE gathering state monitoring - CRITICAL for debugging
    pc.onicegatheringstatechange = () => {
      console.log(`🧊 ICE gathering state for ${peerId.substring(0, 8)}...: ${pc.iceGatheringState}`);

      if (pc.iceGatheringState === 'gathering') {
        console.log(`✅ ICE gathering started for ${peerId.substring(0, 8)}...`);
      } else if (pc.iceGatheringState === 'complete') {
        console.log(`🏁 ICE gathering completed for ${peerId.substring(0, 8)}...`);
      }
    };

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
  setupDataChannelEvents(peerId, dataChannel) {
    dataChannel.onopen = () => {
      console.log(`📡 Data channel opened for ${peerId.substring(0, 8)}... - WebRTC communication ready!`);

      // Send initial metadata handshake (only once per peer)
      if (!this.handshakeCompleted.has(peerId)) {
        const myMetadata = this.getPeerMetadata(this.localNodeId);
        if (myMetadata) {
          const handshakeMessage = {
            type: 'handshake',
            peerId: this.localNodeId,
            metadata: myMetadata,
            timestamp: Date.now()
          };
          dataChannel.send(JSON.stringify(handshakeMessage));
          console.log(`📤 Sent WebRTC handshake with metadata to ${peerId.substring(0, 8)}`);
          this.handshakeCompleted.set(peerId, true);
        }
      } else {
        console.log(`📤 Skipping duplicate handshake for ${peerId.substring(0, 8)} (already sent)`);
      }
    };

    dataChannel.onclose = () => {
      console.log(`📡 Data channel closed for ${peerId.substring(0, 8)}...`);
    };

    dataChannel.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        
        // Handle keep-alive messages
        if (message.type === 'keep_alive_ping') {
          this.handleKeepAlivePing(peerId, message);
          return;
        } else if (message.type === 'keep_alive_pong') {
          this.handleKeepAlivePong(peerId, message);
          return;
        } else if (message.type === 'handshake') {
          // Handle handshake with peer metadata (prevent duplicate processing)
          if (message.metadata && !this.handshakeCompleted.has(`recv_${peerId}`)) {
            console.log(`📋 Received WebRTC handshake metadata from ${peerId.substring(0, 8)}:`, message.metadata);
            this.setPeerMetadata(peerId, message.metadata);
            
            // CRITICAL: Update routing table node metadata after handshake (only once)
            this.emit('metadataUpdated', { peerId, metadata: message.metadata });
            this.handshakeCompleted.set(`recv_${peerId}`, true);
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

    dataChannel.onerror = (error) => {
      console.error(`❌ Data channel error for ${peerId.substring(0, 8)}...:`, error);
    };
  }

  /**
   * Send WebRTC signal through appropriate channel
   * @param {string} peerId - Target peer ID
   * @param {Object} signal - Signal to send (offer/answer/candidate)
   */
  async sendSignal(peerId, signal) {
    try {
      // Determine if we should use bootstrap signaling (browser-to-browser)
      const peerMetadata = this.getPeerMetadata?.(peerId) || {};
      const isTargetBrowser = peerMetadata.nodeType === 'browser' || !peerMetadata.nodeType; // default to browser
      const isLocalBrowser = typeof process === 'undefined'; // we're in browser if window exists
      const isBridgeNode = peerMetadata.isBridgeNode === true;
      
      // SIMPLIFIED LOGIC: Always use DHT signaling (event emission)
      // Let OverlayNetwork.handleOutgoingSignal determine bootstrap vs DHT routing
      // This fixes the issue where WebRTC answers weren't using DHT routing
      
      console.log(`🔄 Sending WebRTC signal (${signal.type}) to ${peerId.substring(0, 8)}... via DHT event (target: ${isTargetBrowser ? 'browser' : 'node'}, bridge: ${isBridgeNode})`);
      
      // Fall back to event emission for DHT-based signaling or other connection types
      this.emit('signal', {
        peerId,
        signal
      });
      
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
    console.log(`🔄 Handling signal from ${peerId.substring(0, 8)}...:`, signal.type);

    // Prevent concurrent signal processing for the same peer
    if (this.processingSignals.get(peerId)) {
      console.log(`⚠️ Already processing signal for ${peerId.substring(0, 8)}..., ignoring duplicate ${signal.type}`);
      return;
    }

    this.processingSignals.set(peerId, true);

    let pc = this.connections.get(peerId);
    
    // Perfect Negotiation Pattern: Determine who is polite/impolite based on node IDs
    const isPolite = this.localNodeId && this.localNodeId < peerId;
    const makingOffer = pc && pc.signalingState === 'have-local-offer';
    const ignoreOffer = !isPolite && signal.type === 'offer' && makingOffer;
    
    console.log(`🤝 Perfect Negotiation - Role: ${isPolite ? 'POLITE' : 'IMPOLITE'} (${this.localNodeId} vs ${peerId})`);
    
    // Perfect Negotiation: Handle collision resolution
    if (ignoreOffer) {
      console.log(`💪 Perfect Negotiation - Being impolite, ignoring offer from ${peerId.substring(0, 8)}... (we have precedence)`);
      this.processingSignals.delete(peerId);
      return;
    }

    if (!pc) {
      // Create new incoming connection for offers
      if (signal.type === 'offer') {
        console.log(`📥 Creating incoming connection for ${peerId.substring(0, 8)}...`);
        try {
          // Create connection synchronously for immediate offer processing
          const rtcPC = new RTCPeerConnection({
            iceServers: this.rtcOptions.iceServers,
            iceTransportPolicy: 'all',
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require',
            iceCandidatePoolSize: 10
          });
          
          this.connections.set(peerId, rtcPC);
          this.connectionStates.set(peerId, 'connecting');
          
          // Setup peer connection events immediately
          this.setupPeerConnectionEvents(peerId, rtcPC, false); // false = not initiator
          
          // Setup pending connection tracking
          this.pendingConnections.set(peerId, {
            startTime: Date.now(),
            initiator: false,
            pc: rtcPC
          });
          
          // Set connection timeout
          const timeout = setTimeout(() => {
            if (this.connectionStates.get(peerId) === 'connecting') {
              console.warn(`⏰ Connection timeout for peer ${peerId.substring(0, 8)}... after ${this.options.timeout}ms`);
              this.destroyConnection(peerId, 'timeout');
            }
          }, this.options.timeout);
          
          rtcPC.timeout = timeout;
          pc = rtcPC;
          
          console.log(`✅ Incoming connection created synchronously for ${peerId.substring(0, 8)}...`);
        } catch (error) {
          console.error(`❌ Failed to create incoming connection for ${peerId}:`, error);
          this.processingSignals.delete(peerId);
          return;
        }
      } else {
        console.warn(`⚠️ Received ${signal.type} signal for unknown peer ${peerId.substring(0, 8)}...`);
        this.processingSignals.delete(peerId);
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
    if (signal.type === 'candidate' && !this.remoteDescriptionSet.get(peerId)) {
      console.log(`🔄 Queuing ICE candidate for ${peerId.substring(0, 8)}... (remote description not set)`);
      if (!this.signalQueues.has(peerId)) {
        this.signalQueues.set(peerId, []);
      }
      this.signalQueues.get(peerId).push(signal);
      this.processingSignals.delete(peerId);
      return;
    }

    try {
      if (signal.type === 'offer') {
        console.log(`📥 Processing offer from ${peerId.substring(0, 8)}...`);

        // Check if remote description is already set to prevent duplicate offer processing
        if (this.remoteDescriptionSet.get(peerId)) {
          console.log(`⚠️ Ignoring duplicate offer from ${peerId.substring(0, 8)}... (remote description already set)`);
          return;
        }

        await pc.setRemoteDescription(new RTCSessionDescription({
          type: 'offer',
          sdp: signal.sdp
        }));

        // Mark remote description as set
        this.remoteDescriptionSet.set(peerId, true);

        // Process any queued ICE candidates
        await this.processQueuedSignals(peerId);

        // Create answer
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        console.log(`📤 Created answer for ${peerId.substring(0, 8)}...`);
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
          sdp: answer.sdp
        });

      } else if (signal.type === 'answer') {
        console.log(`📥 Processing answer from ${peerId.substring(0, 8)}...`);

        // Check if remote description is already set to prevent duplicate answer processing
        if (this.remoteDescriptionSet.get(peerId)) {
          console.log(`⚠️ Ignoring duplicate answer from ${peerId.substring(0, 8)}... (remote description already set)`);
          return; // Exit early to prevent duplicate processing
        }

        await pc.setRemoteDescription(new RTCSessionDescription({
          type: 'answer',
          sdp: signal.sdp
        }));

        // Mark remote description as set
        this.remoteDescriptionSet.set(peerId, true);
        console.log(`📥 Answer processed for ${peerId.substring(0, 8)}... - connection=${pc.connectionState}, ice=${pc.iceConnectionState}, signaling=${pc.signalingState}`);

        // Process any queued ICE candidates
        await this.processQueuedSignals(peerId);

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
      this.processingSignals.delete(peerId);
    }
  }

  /**
   * Process queued signals for a peer after remote description is set
   */
  async processQueuedSignals(peerId) {
    const queuedSignals = this.signalQueues.get(peerId);
    if (!queuedSignals || queuedSignals.length === 0) {
      return;
    }

    console.log(`🔄 Processing ${queuedSignals.length} queued signals for ${peerId.substring(0, 8)}...`);
    const pc = this.connections.get(peerId);
    
    if (!pc) {
      console.warn(`⚠️ No connection found for ${peerId} when processing queued signals`);
      return;
    }

    // Process all queued ICE candidates
    for (const signal of queuedSignals) {
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
    this.signalQueues.delete(peerId);
  }

  /**
   * Send raw message via WebRTC DataChannel
   */
  async sendRawMessage(peerId, message) {
    const dataChannel = this.dataChannels.get(peerId);
    
    if (!dataChannel) {
      throw new Error(`No data channel to peer ${peerId}`);
    }

    if (dataChannel.readyState !== 'open') {
      throw new Error(`Data channel to ${peerId} is not open`);
    }

    const messageStr = typeof message === 'string' ? message : JSON.stringify(message);
    
    try {
      dataChannel.send(messageStr);
      return true;
    } catch (error) {
      console.error(`Failed to send data to ${peerId}:`, error);
      throw error;
    }
  }

  /**
   * Check if peer is connected
   */
  isConnected(peerId) {
    const connection = this.connections.get(peerId);
    if (!connection) return false;
    
    // Check WebRTC connection
    return connection.connectionState === 'connected';
  }

  /**
   * Destroy connection to peer
   */
  destroyConnection(peerId, reason = 'manual') {
    console.log(`🔌 Destroying WebRTC connection to ${peerId.substring(0, 8)}... (${reason})`);
    
    const pc = this.connections.get(peerId);
    if (pc) {
      clearTimeout(pc.timeout);
      pc.close();
    }

    this.stopKeepAlive(peerId);
    this.cleanupConnection(peerId);
    this.emit('peerDisconnected', { peerId, reason });
  }

  /**
   * Clean up connection data
   */
  cleanupConnection(peerId) {
    this.connections.delete(peerId);
    this.dataChannels.delete(peerId);
    this.connectionStates.delete(peerId);
    this.pendingConnections.delete(peerId);
    this.signalQueues.delete(peerId);
    this.remoteDescriptionSet.delete(peerId);
    this.offerCollisions.delete(peerId);
    this.handshakeCompleted.delete(peerId);
    this.handshakeCompleted.delete(`recv_${peerId}`);
    this.processingSignals.delete(peerId);
  }

  // ===========================================
  // KEEP-ALIVE SYSTEM
  // ===========================================

  /**
   * Start keep-alive for a peer connection
   */
  startKeepAlive(peerId) {
    if (!this.isConnected(peerId)) {
      console.warn(`⚠️ Cannot start keep-alive for disconnected peer ${peerId}`);
      return;
    }

    // Don't start if already running
    if (this.keepAliveIntervals.has(peerId)) {
      return;
    }

    const interval = this.isTabVisible ? this.keepAliveInterval : this.keepAliveIntervalHidden;

    // Initialize tracking structures
    this.keepAlivePings.set(peerId, new Set());
    this.keepAliveResponses.set(peerId, Date.now());
    this.keepAliveTimeouts.set(peerId, new Set());

    // Set up keep-alive interval
    const intervalId = setInterval(() => {
      this.sendKeepAlivePing(peerId);
    }, interval);

    this.keepAliveIntervals.set(peerId, intervalId);
  }

  /**
   * Stop keep-alive for a peer connection
   */
  stopKeepAlive(peerId) {
    const intervalId = this.keepAliveIntervals.get(peerId);
    if (intervalId) {
      clearInterval(intervalId);
      this.keepAliveIntervals.delete(peerId);
    }

    // Clean up tracking structures
    this.keepAlivePings.delete(peerId);
    this.keepAliveResponses.delete(peerId);
    
    // Clear any pending timeouts
    const timeouts = this.keepAliveTimeouts.get(peerId);
    if (timeouts) {
      for (const timeoutId of timeouts) {
        clearTimeout(timeoutId);
      }
      this.keepAliveTimeouts.delete(peerId);
    }
  }

  /**
   * Send keep-alive ping to peer
   */
  async sendKeepAlivePing(peerId) {
    if (!this.isConnected(peerId)) {
      this.stopKeepAlive(peerId);
      return;
    }

    try {
      const pingMessage = {
        type: 'keep_alive_ping',
        pingId: `ping_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        timestamp: Date.now(),
        tabVisible: this.isTabVisible
      };

      // Add to pending pings
      const pendingPings = this.keepAlivePings.get(peerId) || new Set();
      pendingPings.add(pingMessage.pingId);
      this.keepAlivePings.set(peerId, pendingPings);

      // Send ping message
      const dataChannel = this.dataChannels.get(peerId);
      if (dataChannel && dataChannel.readyState === 'open') {
        dataChannel.send(JSON.stringify(pingMessage));

        // Set timeout for pong response
        const timeoutId = setTimeout(() => {
          const pendingPings = this.keepAlivePings.get(peerId);
          if (pendingPings && pendingPings.has(pingMessage.pingId)) {
            pendingPings.delete(pingMessage.pingId);
            
            // Check if we have too many failed pings
            const lastResponse = this.keepAliveResponses.get(peerId) || 0;
            const timeSinceLastResponse = Date.now() - lastResponse;
            
            if (timeSinceLastResponse > this.keepAliveTimeout * 2) {
              console.error(`❌ Peer ${peerId.substring(0, 8)}... not responding to keep-alive pings, marking as failed`);
              this.destroyConnection(peerId, 'keep_alive_timeout');
            }
          }
        }, this.keepAliveTimeout);
        
        // Track timeout for cleanup
        const timeouts = this.keepAliveTimeouts.get(peerId) || new Set();
        timeouts.add(timeoutId);
        this.keepAliveTimeouts.set(peerId, timeouts);

      } else {
        this.stopKeepAlive(peerId);
      }

    } catch (error) {
      console.error(`❌ Failed to send keep-alive ping to ${peerId}:`, error);
    }
  }

  /**
   * Handle incoming keep-alive ping from peer
   */
  handleKeepAlivePing(peerId, pingMessage) {
    try {
      // Send pong response
      const pongMessage = {
        type: 'keep_alive_pong',
        pingId: pingMessage.pingId,
        originalTimestamp: pingMessage.timestamp,
        responseTimestamp: Date.now(),
        tabVisible: this.isTabVisible
      };

      const dataChannel = this.dataChannels.get(peerId);
      if (dataChannel && dataChannel.readyState === 'open') {
        dataChannel.send(JSON.stringify(pongMessage));
      }

    } catch (error) {
      console.error(`❌ Failed to send keep-alive pong to ${peerId}:`, error);
    }
  }

  /**
   * Handle incoming keep-alive pong from peer
   */
  handleKeepAlivePong(peerId, pongMessage) {
    // Remove from pending pings
    const pendingPings = this.keepAlivePings.get(peerId);
    if (pendingPings) {
      pendingPings.delete(pongMessage.pingId);
    }

    // Update last response timestamp
    this.keepAliveResponses.set(peerId, Date.now());
  }

  /**
   * Clean up all keep-alive timers
   */
  cleanupAllKeepAlives() {
    for (const [peerId, intervalId] of this.keepAliveIntervals.entries()) {
      clearInterval(intervalId);
    }

    this.keepAliveIntervals.clear();
    this.keepAlivePings.clear();
    this.keepAliveResponses.clear();
    
    // Clear all pending timeouts
    for (const [peerId, timeouts] of this.keepAliveTimeouts.entries()) {
      for (const timeoutId of timeouts) {
        clearTimeout(timeoutId);
      }
    }
    this.keepAliveTimeouts.clear();
  }

  /**
   * Debug WebRTC connection states and issues
   */
  debugWebRTCStates() {
    console.log('=== WebRTC Connection Debug Report ===');
    
    const report = {
      totalConnections: this.connections.size,
      connectedPeers: this.getConnectedPeers().length,
      pendingConnections: this.pendingConnections.size,
      connections: []
    };
    
    for (const [peerId, connection] of this.connections.entries()) {
      if (connection instanceof RTCPeerConnection) {
        const connectionInfo = {
          peerId: peerId.substring(0, 8),
          connectionState: connection.connectionState,
          iceConnectionState: connection.iceConnectionState,
          iceGatheringState: connection.iceGatheringState,
          signalingState: connection.signalingState,
          hasDataChannel: this.dataChannels.has(peerId),
          dataChannelState: this.dataChannels.get(peerId)?.readyState || 'none'
        };
        
        report.connections.push(connectionInfo);
        console.log(`Peer ${peerId.substring(0, 8)}:`, connectionInfo);
      }
    }
    
    return report;
  }

  /**
   * Check connection health for all peers
   */
  checkConnectionHealth() {
    console.log('=== WebRTC Connection Health Check ===');
    
    const healthReport = {
      healthy: [],
      unhealthy: [],
      pending: []
    };
    
    for (const [peerId, connection] of this.connections.entries()) {
      const status = {
        peerId: peerId.substring(0, 8),
        connected: this.isConnected(peerId),
        state: this.connectionStates.get(peerId)
      };
      
      if (connection instanceof RTCPeerConnection) {
        status.connectionState = connection.connectionState;
        status.iceConnectionState = connection.iceConnectionState;
        
        if (connection.connectionState === 'connected') {
          healthReport.healthy.push(status);
        } else if (connection.connectionState === 'connecting') {
          healthReport.pending.push(status);
        } else {
          healthReport.unhealthy.push(status);
        }
      }
    }
    
    console.log('Health Report:', {
      healthy: healthReport.healthy.length,
      pending: healthReport.pending.length,
      unhealthy: healthReport.unhealthy.length
    });
    
    return healthReport;
  }

  /**
   * Destroy all connections and cleanup
   */
  destroy() {
    if (this.isDestroyed) return;

    console.log('🚀 Destroying WebRTCConnectionManager');

    // Clean up all keep-alive timers
    this.cleanupAllKeepAlives();

    // Destroy all peer connections
    for (const [peerId, pc] of this.connections.entries()) {
      if (pc.timeout) clearTimeout(pc.timeout);
      pc.close();
    }

    // Call parent destroy
    super.destroy();
  }
}
