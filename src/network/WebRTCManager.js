import { EventEmitter } from 'events';

/**
 * Manages WebRTC connections using native WebRTC API with bootstrap signaling
 */
export class WebRTCManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
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
      timeout: options.timeout || 30000,
      maxConnections: options.maxConnections || 50,
      ...options
    };

    this.connections = new Map(); // peerId -> RTCPeerConnection
    this.dataChannels = new Map(); // peerId -> RTCDataChannel
    this.pendingConnections = new Map(); // peerId -> connection attempt info
    this.connectionStates = new Map(); // peerId -> connection state
    this.signalQueues = new Map(); // peerId -> array of queued signals
    this.remoteDescriptionSet = new Map(); // peerId -> boolean (has remote description)
    this.offerCollisions = new Map(); // peerId -> collision detection state for Perfect Negotiation
    this.localNodeId = null;
    this.isDestroyed = false;
    this.isInitialized = false;

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
   * Initialize the WebRTC manager
   */
  initialize(localNodeId) {
    if (this.isInitialized) {
      console.warn('WebRTCManager already initialized');
      return;
    }

    this.localNodeId = localNodeId;
    this.isInitialized = true;
    
    console.log(`🚀 Initializing WebRTC with node ID: ${localNodeId}`);
    this.emit('initialized', { localNodeId });
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

  /**
   * Create outgoing connection to peer
   */
  async createConnection(peerId, initiator = true) {
    if (this.isDestroyed) {
      throw new Error('WebRTCManager is destroyed');
    }

    if (this.connections.has(peerId)) {
      throw new Error(`Connection to ${peerId} already exists`);
    }

    if (this.connections.size >= this.options.maxConnections) {
      throw new Error('Maximum connections reached');
    }

    console.log(`🚀 Creating ${initiator ? 'outgoing' : 'incoming'} connection to ${peerId}`);
    console.log(`🔍 Peer ID validation: ${peerId} -> valid DHT peer: ${this.isValidDHTPeer(peerId)}`);
    console.log(`📊 Current connection counts - Total: ${this.connections.size}, Connected: ${this.getConnectedPeers().length}`);

    // Create RTCPeerConnection
    const pc = new RTCPeerConnection({
      iceServers: this.options.iceServers,
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
        console.warn(`⏰ Connection timeout for peer ${peerId} after ${this.options.timeout}ms`);
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
        console.log(`📤 Created offer for ${peerId}`);
        
        // Send offer through bootstrap server
        this.emit('signal', {
          peerId,
          signal: {
            type: 'offer',
            sdp: offer.sdp
          }
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
    console.log(`🔧 Setting up events for peer: ${peerId} (initiator: ${initiator})`);

    // ICE candidate gathering with enhanced debugging
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log(`🧊 ICE candidate for ${peerId}: ${event.candidate.type} (${event.candidate.protocol}:${event.candidate.address}:${event.candidate.port})`);
        console.log(`🔍 ICE candidate details:`, {
          type: event.candidate.type,
          protocol: event.candidate.protocol,
          address: event.candidate.address,
          port: event.candidate.port,
          priority: event.candidate.priority
        });
        this.emit('signal', {
          peerId,
          signal: {
            type: 'candidate',
            candidate: event.candidate.candidate,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
            sdpMid: event.candidate.sdpMid
          }
        });
      } else {
        console.log(`🏁 ICE gathering complete for ${peerId}`);
        console.log(`🔍 Final ICE gathering state: ${pc.iceGatheringState}`);
      }
    };

    // Connection state changes
    pc.onconnectionstatechange = () => {
      console.log(`🔗 Connection state for ${peerId}: ${pc.connectionState}`);
      
      if (pc.connectionState === 'connected') {
        clearTimeout(pc.timeout);
        this.connectionStates.set(peerId, 'connected');
        this.pendingConnections.delete(peerId);
        
        console.log(`✅ WebRTC Connected to ${peerId}`);
        console.log(`🚀 CRITICAL: About to emit peerConnected event for ${peerId}`);
        this.emit('peerConnected', { peerId, connection: pc, manager: this, initiator: true });
        console.log(`✅ CRITICAL: peerConnected event emitted for ${peerId}`);
        
        // Start keep-alive for this connection
        this.startKeepAlive(peerId);
        
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        console.log(`❌ Connection failed/disconnected for ${peerId}: ${pc.connectionState}`);
        this.connectionStates.set(peerId, pc.connectionState);
        this.stopKeepAlive(peerId);
        this.cleanupConnection(peerId);
        this.emit('peerDisconnected', { peerId, reason: pc.connectionState });
      } else {
        console.log(`🔍 DEBUG: Connection state '${pc.connectionState}' for ${peerId} - not triggering events`);
      }
    };

    // ICE connection state changes with enhanced debugging
    pc.oniceconnectionstatechange = () => {
      console.log(`🧊 ICE connection state for ${peerId}: ${pc.iceConnectionState}`);
      
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        console.log(`✅ ICE connection established for ${peerId}: ${pc.iceConnectionState}`);
        // Log successful ICE candidate pair information
        pc.getStats().then(stats => {
          stats.forEach(report => {
            if (report.type === 'candidate-pair' && report.state === 'succeeded') {
              console.log(`🎯 Successful ICE candidate pair for ${peerId}:`, {
                localType: report.localCandidateType,
                remoteType: report.remoteCandidateType,
                transportType: report.transportType
              });
            }
          });
        }).catch(err => console.warn(`Could not get ICE stats: ${err}`));
      } else if (pc.iceConnectionState === 'failed') {
        console.error(`❌ ICE connection failed for ${peerId}`);
        console.error(`🔍 ICE failure debug:`, {
          connectionState: pc.connectionState,
          signalingState: pc.signalingState,
          iceGatheringState: pc.iceGatheringState
        });
        // Log failed ICE candidates for debugging
        pc.getStats().then(stats => {
          stats.forEach(report => {
            if (report.type === 'candidate-pair' && report.state === 'failed') {
              console.error(`💥 Failed ICE candidate pair for ${peerId}:`, {
                localType: report.localCandidateType,
                remoteType: report.remoteCandidateType,
                failureReason: report.failureReason || 'Unknown'
              });
            }
          });
        }).catch(err => console.warn(`Could not get ICE failure stats: ${err}`));
        // Force connection cleanup on ICE failure
        this.destroyConnection(peerId, 'ice_failed');
      } else if (pc.iceConnectionState === 'disconnected') {
        console.warn(`⚠️ ICE connection disconnected for ${peerId}`);
      }
    };

    // Data channel handling for incoming connections
    if (!initiator) {
      pc.ondatachannel = (event) => {
        console.log(`📥 Received data channel from ${peerId}`);
        const dataChannel = event.channel;
        this.setupDataChannelEvents(peerId, dataChannel);
        this.dataChannels.set(peerId, dataChannel);
      };
    }
  }

  /**
   * Setup data channel events
   */
  setupDataChannelEvents(peerId, dataChannel) {
    dataChannel.onopen = () => {
      console.log(`📡 Data channel opened for ${peerId}`);
    };

    dataChannel.onclose = () => {
      console.log(`📡 Data channel closed for ${peerId}`);
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
        }
        
        this.emit('data', { peerId, data: message });
      } catch (error) {
        console.warn(`Invalid JSON data from ${peerId}:`, error);
        this.emit('rawData', { peerId, data: event.data });
      }
    };

    dataChannel.onerror = (error) => {
      console.error(`❌ Data channel error for ${peerId}:`, error);
    };
  }

  /**
   * Handle incoming signal from remote peer with Perfect Negotiation Pattern
   */
  async handleSignal(peerId, signal) {
    console.log(`🔄 Handling signal from ${peerId}:`, signal.type);
    console.log(`🔍 SIGNAL DEBUG: ${signal.type} from ${peerId}, connection exists: ${this.connections.has(peerId)}`);

    let pc = this.connections.get(peerId);
    
    // Perfect Negotiation Pattern: Determine who is polite/impolite based on node IDs
    const isPolite = this.localNodeId && this.localNodeId < peerId;
    const makingOffer = pc && pc.signalingState === 'have-local-offer';
    const ignoreOffer = !isPolite && signal.type === 'offer' && makingOffer;
    
    console.log(`🤝 Perfect Negotiation - Role: ${isPolite ? 'POLITE' : 'IMPOLITE'} (${this.localNodeId} vs ${peerId})`);
    console.log(`🔍 Perfect Negotiation - States: makingOffer=${makingOffer}, ignoreOffer=${ignoreOffer}`);
    
    // Perfect Negotiation: Handle collision resolution
    if (ignoreOffer) {
      console.log(`💪 Perfect Negotiation - Being impolite, ignoring offer from ${peerId} (we have precedence)`);
      return;
    }

    if (!pc) {
      // Create new incoming connection for offers
      if (signal.type === 'offer') {
        console.log(`📥 Creating incoming connection for ${peerId}`);
        try {
          // CRITICAL FIX: Create connection synchronously to avoid race conditions
          // Call the connection creation logic directly instead of using async createConnection()
          
          // Check if already creating connection
          if (this.connections.has(peerId)) {
            pc = this.connections.get(peerId);
            console.log(`🔄 Connection already exists for ${peerId}, continuing to process offer`);
          } else {
            // Create RTCPeerConnection immediately for synchronous processing
            const rtcPC = new RTCPeerConnection({
              iceServers: this.options.iceServers,
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
                console.warn(`⏰ Connection timeout for peer ${peerId} after ${this.options.timeout}ms`);
                console.warn(`🔍 Final connection state:`, {
                  connectionState: rtcPC.connectionState,
                  iceConnectionState: rtcPC.iceConnectionState,
                  signalingState: rtcPC.signalingState
                });
                this.destroyConnection(peerId, 'timeout');
              }
            }, this.options.timeout);
            
            rtcPC.timeout = timeout;
            pc = rtcPC;
            
            console.log(`✅ Incoming connection created synchronously for ${peerId}`);
          }
        } catch (error) {
          console.error(`❌ Failed to create incoming connection for ${peerId}:`, error);
          return;
        }
      } else {
        console.warn(`⚠️ Received ${signal.type} signal for unknown peer ${peerId}`);
        return;
      }
    } else {
      console.log(`🔍 Using existing connection for ${peerId}: signaling=${pc.signalingState}, connection=${pc.connectionState}`);
    }
    
    // Perfect Negotiation: Handle rollback if we're being polite
    if (isPolite && signal.type === 'offer' && makingOffer) {
      console.log(`🤝 Perfect Negotiation - Being polite, performing rollback for ${peerId}`);
      try {
        await pc.setLocalDescription({ type: 'rollback' });
        console.log(`✅ Rollback completed for ${peerId}`);
      } catch (error) {
        console.warn(`⚠️ Rollback failed for ${peerId}:`, error);
        // Continue processing even if rollback fails
      }
    }

    console.log(`🔍 DEBUG STEP 3: After connection resolution, pc exists: ${!!pc}`);

    // Ensure we have a valid peer connection before proceeding
    if (!pc || pc.connectionState === 'closed') {
      console.error(`❌ No valid connection for ${peerId} after creation attempt`);
      return;
    }

    console.log(`🔍 DEBUG STEP 4: About to validate connection state`);
    console.log(`🔍 About to process signal: ${signal.type} for ${peerId}`);
    console.log(`🔍 Remote description set: ${this.remoteDescriptionSet.get(peerId)}`);
    console.log(`🔍 Signal type check: Is candidate? ${signal.type === 'candidate'}, Is offer? ${signal.type === 'offer'}, Is answer? ${signal.type === 'answer'}`);

    // Queue ICE candidates ONLY if remote description not set yet - DO NOT queue offers/answers
    if (signal.type === 'candidate' && !this.remoteDescriptionSet.get(peerId)) {
      console.log(`🔄 Queuing ICE candidate for ${peerId} (remote description not set)`);
      if (!this.signalQueues.has(peerId)) {
        this.signalQueues.set(peerId, []);
      }
      this.signalQueues.get(peerId).push(signal);
      console.log(`🔍 DEBUG STEP 5: ICE candidate queued, returning early`);
      return;
    }

    console.log(`🔍 DEBUG STEP 6: Past ICE candidate queueing check`);
    console.log(`🔍 DEBUG STEP 7: About to check pc state before processing`);
    console.log(`🔍 pc.connectionState: ${pc.connectionState}, pc.signalingState: ${pc.signalingState}`);
    console.log(`🔍 Signal type being processed: ${signal.type}`);
    console.log(`🚀 Entering signal processing try block for ${signal.type} from ${peerId}`);

    try {
      console.log(`🚀 CRITICAL: Entering try block to process signal type: ${signal.type}`);
      if (signal.type === 'offer') {
        console.log(`📥 Processing offer from ${peerId}`);
        console.log(`🔍 Offer details:`, { 
          hasSignal: !!signal, 
          hasSdp: !!signal.sdp, 
          signalingState: pc.signalingState,
          connectionState: pc.connectionState 
        });
        
        await pc.setRemoteDescription(new RTCSessionDescription({
          type: 'offer',
          sdp: signal.sdp
        }));
        
        console.log(`✅ Remote description set for ${peerId}, signaling state: ${pc.signalingState}`);
        
        // Mark remote description as set
        this.remoteDescriptionSet.set(peerId, true);
        
        // Process any queued ICE candidates
        await this.processQueuedSignals(peerId);

        // Create answer
        console.log(`🔄 Creating answer for ${peerId}`);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        console.log(`📤 Created answer for ${peerId}, local signaling state: ${pc.signalingState}`);
        this.emit('signal', {
          peerId,
          signal: {
            type: 'answer',
            sdp: answer.sdp
          }
        });

      } else if (signal.type === 'answer') {
        console.log(`📥 Processing answer from ${peerId}`);
        await pc.setRemoteDescription(new RTCSessionDescription({
          type: 'answer',
          sdp: signal.sdp
        }));
        
        // Mark remote description as set
        this.remoteDescriptionSet.set(peerId, true);
        
        // Process any queued ICE candidates
        await this.processQueuedSignals(peerId);

      } else if (signal.type === 'candidate') {
        console.log(`📥 Processing ICE candidate from ${peerId}`);
        await pc.addIceCandidate(new RTCIceCandidate({
          candidate: signal.candidate,
          sdpMLineIndex: signal.sdpMLineIndex,
          sdpMid: signal.sdpMid
        }));
      }

    } catch (error) {
      // Perfect Negotiation: Handle signaling errors gracefully
      const isPolite = this.localNodeId && this.localNodeId < peerId;
      
      if (isPolite && signal.type === 'offer') {
        console.log(`🤝 Perfect Negotiation - Polite peer handling offer error gracefully for ${peerId}`);
        // Don't destroy connection for polite peers during offer processing
        console.warn(`⚠️ Polite signaling error from ${peerId}:`, error.message);
      } else {
        console.error(`❌ Error processing signal from ${peerId}:`, error);
        this.destroyConnection(peerId, 'signal_error');
      }
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

    console.log(`🔄 Processing ${queuedSignals.length} queued signals for ${peerId}`);
    const pc = this.connections.get(peerId);
    
    if (!pc) {
      console.warn(`⚠️ No connection found for ${peerId} when processing queued signals`);
      return;
    }

    // Process all queued ICE candidates
    for (const signal of queuedSignals) {
      try {
        if (signal.type === 'candidate') {
          console.log(`📥 Processing queued ICE candidate for ${peerId}`);
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
   * Send data to a specific peer
   */
  sendData(peerId, data) {
    const dataChannel = this.dataChannels.get(peerId);
    
    if (!dataChannel) {
      throw new Error(`No data channel to peer ${peerId}`);
    }

    if (dataChannel.readyState !== 'open') {
      throw new Error(`Data channel to ${peerId} is not open`);
    }

    const message = typeof data === 'string' ? data : JSON.stringify(data);
    
    try {
      dataChannel.send(message);
      return true;
    } catch (error) {
      console.error(`Failed to send data to ${peerId}:`, error);
      return false;
    }
  }

  /**
   * Broadcast data to all connected peers
   */
  broadcastData(data, excludePeers = []) {
    const message = typeof data === 'string' ? data : JSON.stringify(data);
    const results = {};

    for (const [peerId, dataChannel] of this.dataChannels.entries()) {
      if (excludePeers.includes(peerId)) continue;
      
      if (dataChannel.readyState === 'open') {
        try {
          dataChannel.send(message);
          results[peerId] = true;
        } catch (error) {
          console.error(`Failed to broadcast to ${peerId}:`, error);
          results[peerId] = false;
        }
      } else {
        results[peerId] = false;
      }
    }

    return results;
  }

  /**
   * Get connection state for a peer
   */
  getConnectionState(peerId) {
    return this.connectionStates.get(peerId) || 'disconnected';
  }

  /**
   * Check if peer is connected
   */
  isConnected(peerId) {
    const connection = this.connections.get(peerId);
    if (!connection) return false;
    
    // Check WebSocket connection
    if (connection instanceof WebSocket) {
      return connection.readyState === WebSocket.OPEN;
    }
    
    // Check WebRTC connection
    return connection.connectionState === 'connected';
  }

  /**
   * Get all connected peer IDs (filtered to only valid DHT peers)
   */
  getConnectedPeers() {
    const connected = [];
    for (const [peerId, connection] of this.connections.entries()) {
      // Use isConnected() method which handles both WebSocket and WebRTC connections
      if (this.isConnected(peerId) && this.isValidDHTPeer(peerId)) {
        connected.push(peerId);
      }
    }
    return connected;
  }

  /**
   * Validate that a peer ID represents a valid DHT peer
   */
  isValidDHTPeer(peerId) {
    // Filter out bootstrap server connections and invalid peer IDs
    
    // Check if it looks like a bootstrap server
    if (peerId.includes('bootstrap') || peerId.includes('server')) {
      return false;
    }
    
    // Check if it's a websocket connection (should only be WebRTC for DHT peers)
    if (peerId.startsWith('ws://') || peerId.startsWith('wss://')) {
      return false;
    }
    
    // Check for localhost/IP addresses (bootstrap servers)
    if (peerId.includes('localhost') || peerId.includes('127.0.0.1') || peerId.includes('8080') || peerId.includes('8081')) {
      return false;
    }
    
    // Basic format validation - DHT node IDs should be hex strings of appropriate length
    const hexPattern = /^[a-f0-9]{40,}$/i;
    return hexPattern.test(peerId);
  }

  /**
   * Get connection statistics
   */
  getStats() {
    const connectedCount = this.getConnectedPeers().length; // Already filtered to valid DHT peers
    const validPeers = Array.from(this.connections.keys()).filter(peerId => this.isValidDHTPeer(peerId));
    const pendingCount = Array.from(this.pendingConnections.keys()).filter(peerId => this.isValidDHTPeer(peerId)).length;
    
    // Only count actually connected peers, not just connection attempts
    const totalCount = connectedCount;

    return {
      total: totalCount,
      connected: connectedCount,
      pending: pendingCount,
      maxConnections: this.options.maxConnections,
      utilization: (totalCount / this.options.maxConnections * 100).toFixed(1) + '%',
      connections: validPeers.map(peerId => ({
        peerId,
        state: this.getConnectionState(peerId),
        connected: this.isConnected(peerId)
      }))
    };
  }

  /**
   * Destroy a specific connection
   */
  destroyConnection(peerId, reason = 'manual') {
    console.log(`Destroying connection to ${peerId} (${reason})`);
    
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
  }

  /**
   * Clean up stale connections
   */
  cleanupStaleConnections(maxAge = 60000) { // 1 minute default
    const now = Date.now();
    let cleaned = 0;

    for (const [peerId, pendingInfo] of this.pendingConnections.entries()) {
      if (now - pendingInfo.startTime > maxAge) {
        console.log(`Cleaning up stale connection to ${peerId}`);
        this.destroyConnection(peerId, 'stale');
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Create WebSocket connection to Node.js peer (Browser → Node.js)
   * This method allows browsers to connect to Node.js WebSocket servers
   */
  async createWebSocketConnection(peerId, websocketAddress) {
    if (this.isDestroyed) {
      throw new Error('WebRTCManager is destroyed');
    }

    if (this.connections.has(peerId)) {
      throw new Error(`Connection to ${peerId} already exists`);
    }

    if (this.connections.size >= this.options.maxConnections) {
      throw new Error('Maximum connections reached');
    }

    console.log(`🌐 Creating WebSocket connection to ${peerId} at ${websocketAddress}`);

    return new Promise((resolve, reject) => {
      try {
        const ws = new WebSocket(websocketAddress);
        const connectionTimeout = setTimeout(() => {
          ws.close();
          reject(new Error('WebSocket connection timeout'));
        }, this.options.timeout);

        ws.onopen = () => {
          clearTimeout(connectionTimeout);
          console.log(`✅ WebSocket connection established to ${peerId}`);

          // Send handshake to identify ourselves
          // Check if this is a bridge node connection based on metadata
          const peerMetadata = this.peerMetadata?.get(peerId);
          const messageType = (peerMetadata && peerMetadata.isBridgeNode) ? 'dht_peer_hello' : 'handshake';
          
          ws.send(JSON.stringify({
            type: messageType,
            peerId: this.localNodeId
          }));
          
          console.log(`📤 Sent ${messageType} to ${peerMetadata?.isBridgeNode ? 'bridge node' : 'peer'} ${peerId.substring(0, 8)}`);

          // Wait for handshake response
          const handshakeTimeout = setTimeout(() => {
            ws.close();
            reject(new Error('WebSocket handshake timeout'));
          }, 5000);

          const handleHandshakeResponse = (event) => {
            try {
              const message = JSON.parse(event.data);
              
              // Handle both regular handshake and bridge node responses
              const isValidResponse = 
                (message.type === 'handshake_response' && message.success) ||
                (message.type === 'dht_peer_connected' && message.bridgeNodeId);
              
              if (isValidResponse) {
                clearTimeout(handshakeTimeout);
                ws.removeEventListener('message', handleHandshakeResponse);
                
                if (message.type === 'dht_peer_connected') {
                  console.log(`✅ Successfully connected to bridge node ${message.bridgeNodeId.substring(0, 8)}`);
                }
                
                // Set up the WebSocket connection for DHT messaging
                this.setupWebSocketConnection(peerId, ws);
                resolve(ws);
              } else {
                console.warn('WebSocket handshake failed:', message);
                ws.close();
                reject(new Error('WebSocket handshake failed'));
              }
            } catch (error) {
              console.error('Invalid handshake response:', error);
              ws.close();
              reject(new Error('Invalid handshake response'));
            }
          };

          ws.addEventListener('message', handleHandshakeResponse);
        };

        ws.onerror = (error) => {
          clearTimeout(connectionTimeout);
          reject(new Error(`WebSocket connection failed: ${error.message}`));
        };

        ws.onclose = (event) => {
          clearTimeout(connectionTimeout);
          if (event.code !== 1000) {
            reject(new Error(`WebSocket closed unexpectedly: ${event.code} ${event.reason}`));
          }
        };

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Set up WebSocket connection with DHT message handling
   */
  setupWebSocketConnection(peerId, ws) {
    // Store WebSocket connection (reuse RTCPeerConnection storage structure)
    this.connections.set(peerId, ws);
    this.connectionStates.set(peerId, 'connected');

    console.log(`📋 WebSocket connection setup complete for ${peerId}`);

    // Handle incoming messages
    ws.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(event.data);
        
        // Skip handshake messages
        if (message.type === 'handshake' || message.type === 'handshake_response') {
          return;
        }

        // Emit DHT data event (same interface as WebRTC)
        this.emit('data', { peerId, data: message });
      } catch (error) {
        console.error(`❌ Error parsing WebSocket message from ${peerId}:`, error);
      }
    });

    // Handle connection close
    ws.addEventListener('close', (event) => {
      console.log(`🔌 WebSocket connection closed to ${peerId}: ${event.code} ${event.reason}`);
      this.handleWebSocketClose(peerId);
    });

    // Handle connection error
    ws.addEventListener('error', (error) => {
      console.error(`❌ WebSocket error with ${peerId}:`, error);
    });

    // Emit connection event (same interface as WebRTC)
    this.emit('peerConnected', { peerId, connection: ws, manager: this, initiator: false });
  }

  /**
   * Send message via WebSocket connection
   */
  async sendWebSocketMessage(peerId, message) {
    const ws = this.connections.get(peerId);
    
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error(`No open WebSocket connection to peer ${peerId}`);
    }

    return new Promise((resolve, reject) => {
      try {
        ws.send(JSON.stringify(message));
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Handle WebSocket connection close
   */
  handleWebSocketClose(peerId) {
    this.connections.delete(peerId);
    this.connectionStates.delete(peerId);
    this.pendingConnections.delete(peerId);

    this.emit('peerDisconnected', { peerId });
  }

  /**
   * Check if peer is connected via WebSocket
   */
  isWebSocketConnected(peerId) {
    const ws = this.connections.get(peerId);
    return ws && ws.readyState === WebSocket.OPEN;
  }

  /**
   * Send message to peer (supports both WebRTC and WebSocket)
   */
  async sendMessage(peerId, message) {
    const connection = this.connections.get(peerId);
    
    if (!connection) {
      throw new Error(`No connection to peer ${peerId}`);
    }

    // Check if it's a WebSocket connection
    if (connection instanceof WebSocket) {
      return this.sendWebSocketMessage(peerId, message);
    }

    // Handle WebRTC DataChannel
    const dataChannel = this.dataChannels.get(peerId);
    if (!dataChannel || dataChannel.readyState !== 'open') {
      throw new Error(`No open data channel to peer ${peerId}`);
    }

    return new Promise((resolve, reject) => {
      try {
        dataChannel.send(JSON.stringify(message));
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }

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
      console.log(`📱 Keep-alive already running for ${peerId}`);
      return;
    }

    const interval = this.isTabVisible ? this.keepAliveInterval : this.keepAliveIntervalHidden;
    console.log(`📱 Starting keep-alive for ${peerId} with ${interval}ms interval (tab ${this.isTabVisible ? 'visible' : 'hidden'})`);

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
      console.log(`📱 Stopped keep-alive for ${peerId}`);
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
      console.warn(`⚠️ Cannot send keep-alive ping to disconnected peer ${peerId}`);
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

      // Reduce logging frequency - only log every 5th ping to avoid console spam
      const pingCount = (this.keepAlivePings.get(peerId)?.size || 0);
      if (pingCount % 5 === 0) {
        console.log(`📱 Sending keep-alive ping to ${peerId}: ${pingMessage.pingId} (tab ${this.isTabVisible ? 'visible' : 'hidden'})`);
      }

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
            console.warn(`⚠️ Keep-alive ping ${pingMessage.pingId} to ${peerId} timed out after ${this.keepAliveTimeout}ms`);
            pendingPings.delete(pingMessage.pingId);
            
            // Remove timeout from tracking
            const timeouts = this.keepAliveTimeouts.get(peerId);
            if (timeouts) {
              timeouts.delete(timeoutId);
            }
            
            // Check if we have too many failed pings
            const lastResponse = this.keepAliveResponses.get(peerId) || 0;
            const timeSinceLastResponse = Date.now() - lastResponse;
            
            if (timeSinceLastResponse > this.keepAliveTimeout * 2) {
              console.error(`❌ Peer ${peerId} not responding to keep-alive pings for ${timeSinceLastResponse}ms, marking as failed`);
              this.destroyConnection(peerId, 'keep_alive_timeout');
            }
          }
        }, this.keepAliveTimeout);
        
        // Track timeout for cleanup
        const timeouts = this.keepAliveTimeouts.get(peerId) || new Set();
        timeouts.add(timeoutId);
        this.keepAliveTimeouts.set(peerId, timeouts);

      } else {
        console.warn(`⚠️ No open data channel to send keep-alive ping to ${peerId}`);
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
    // Reduce logging frequency to avoid console spam
    if (Math.random() < 0.1) { // Log only 10% of ping receptions
      console.log(`📱 Received keep-alive ping from ${peerId}: ${pingMessage.pingId} (peer tab ${pingMessage.tabVisible ? 'visible' : 'hidden'})`);
    }

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
        // Only log pong responses occasionally to reduce spam
        if (Math.random() < 0.1) {
          console.log(`📱 Sent keep-alive pong to ${peerId}: ${pingMessage.pingId}`);
        }
      } else {
        console.warn(`⚠️ No open data channel to send keep-alive pong to ${peerId}`);
      }

    } catch (error) {
      console.error(`❌ Failed to send keep-alive pong to ${peerId}:`, error);
    }
  }

  /**
   * Handle incoming keep-alive pong from peer
   */
  handleKeepAlivePong(peerId, pongMessage) {
    const roundTripTime = Date.now() - pongMessage.originalTimestamp;
    
    // Only log pong responses occasionally to reduce spam, or if RTT is high
    if (Math.random() < 0.1 || roundTripTime > 5000) {
      console.log(`📱 Received keep-alive pong from ${peerId}: ${pongMessage.pingId} (RTT: ${roundTripTime}ms, peer tab ${pongMessage.tabVisible ? 'visible' : 'hidden'})`);
    }

    // Remove from pending pings
    const pendingPings = this.keepAlivePings.get(peerId);
    if (pendingPings) {
      pendingPings.delete(pongMessage.pingId);
    }

    // Update last response timestamp
    this.keepAliveResponses.set(peerId, Date.now());
    
    // Clean up corresponding timeout (ping was successful)
    // Note: We can't easily match timeout to specific ping, but successful response means connection is healthy
  }

  /**
   * Clean up all keep-alive timers
   */
  cleanupAllKeepAlives() {
    console.log(`📱 Cleaning up ${this.keepAliveIntervals.size} keep-alive timers`);
    
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
   * Get keep-alive status for debugging
   */
  getKeepAliveStatus() {
    const status = {
      tabVisible: this.isTabVisible,
      activeKeepAlives: this.keepAliveIntervals.size,
      keepAliveInterval: this.isTabVisible ? this.keepAliveInterval : this.keepAliveIntervalHidden,
      peers: {}
    };

    for (const [peerId] of this.keepAliveIntervals.entries()) {
      const pendingPings = this.keepAlivePings.get(peerId)?.size || 0;
      const lastResponse = this.keepAliveResponses.get(peerId) || 0;
      const timeSinceLastResponse = Date.now() - lastResponse;

      status.peers[peerId] = {
        connected: this.isConnected(peerId),
        pendingPings,
        lastResponseMs: timeSinceLastResponse,
        healthy: timeSinceLastResponse < this.keepAliveTimeout
      };
    }

    return status;
  }

  /**
   * Test keep-alive ping manually for debugging
   */
  async testKeepAlivePing(peerId) {
    if (!peerId) {
      const connectedPeers = this.getConnectedPeers();
      if (connectedPeers.length === 0) {
        console.log('📱 No connected peers to test keep-alive');
        return false;
      }
      peerId = connectedPeers[0];
    }

    console.log(`📱 Testing keep-alive ping to ${peerId}...`);
    await this.sendKeepAlivePing(peerId);
    return true;
  }

  /**
   * Simulate tab visibility change for debugging
   */
  simulateTabVisibilityChange() {
    console.log(`📱 Simulating tab visibility change: ${this.isTabVisible ? 'visible' : 'hidden'} → ${!this.isTabVisible ? 'visible' : 'hidden'}`);
    this.isTabVisible = !this.isTabVisible;
    this.adjustKeepAliveFrequency();
    return this.isTabVisible;
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
        
        // Get detailed ICE candidate information
        connection.getStats().then(stats => {
          const candidates = [];
          const candidatePairs = [];
          
          stats.forEach(report => {
            if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
              candidates.push({
                type: report.type,
                candidateType: report.candidateType,
                protocol: report.protocol,
                address: report.address,
                port: report.port,
                priority: report.priority
              });
            } else if (report.type === 'candidate-pair') {
              candidatePairs.push({
                state: report.state,
                nominated: report.nominated,
                writable: report.writable,
                readable: report.readable
              });
            }
          });
          
          if (candidates.length > 0 || candidatePairs.length > 0) {
            console.log(`  ICE Details for ${peerId.substring(0, 8)}:`, {
              candidates: candidates.length,
              candidatePairs: candidatePairs.length,
              pairs: candidatePairs
            });
          }
        }).catch(err => {
          console.warn(`  Could not get ICE stats for ${peerId.substring(0, 8)}:`, err.message);
        });
      }
    }
    
    console.log('Summary:', {
      total: report.totalConnections,
      connected: report.connectedPeers,
      pending: report.pendingConnections,
      success_rate: report.totalConnections > 0 ? `${(report.connectedPeers / report.totalConnections * 100).toFixed(1)}%` : '0%'
    });
    
    return report;
  }
  
  /**
   * Check connection health for all peers
   */
  checkConnectionHealth() {
    console.log('=== Connection Health Check ===');
    
    const healthReport = {
      healthy: [],
      unhealthy: [],
      pending: []
    };
    
    for (const [peerId, connection] of this.connections.entries()) {
      const status = {
        peerId: peerId.substring(0, 8),
        connected: this.isConnected(peerId),
        state: this.getConnectionState(peerId)
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
    
    if (healthReport.unhealthy.length > 0) {
      console.log('Unhealthy connections:', healthReport.unhealthy);
    }
    
    if (healthReport.pending.length > 0) {
      console.log('Pending connections:', healthReport.pending);
    }
    
    return healthReport;
  }

  /**
   * Destroy all connections and cleanup
   */
  destroy() {
    if (this.isDestroyed) return;

    console.log('Destroying WebRTCManager');
    this.isDestroyed = true;

    // Clean up all keep-alive timers
    this.cleanupAllKeepAlives();

    // Destroy all peer connections
    for (const [peerId, pc] of this.connections.entries()) {
      clearTimeout(pc.timeout);
      pc.close();
    }

    // Clear all data structures
    this.connections.clear();
    this.dataChannels.clear();
    this.connectionStates.clear();
    this.pendingConnections.clear();
    this.signalQueues.clear();
    this.remoteDescriptionSet.clear();
    this.offerCollisions.clear();

    // Remove all listeners
    this.removeAllListeners();

    this.emit('destroyed');
  }
}