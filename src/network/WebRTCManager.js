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
        // Backup TURN servers
        { urls: 'turn:relay1.expressturn.com:3478', username: 'ef3MYDAQ2ZEQEQ9Q', credential: 'Pjm5P3LnQlQRGEZK' },
        { urls: 'turn:relay1.expressturn.com:443', username: 'ef3MYDAQ2ZEQEQ9Q', credential: 'Pjm5P3LnQlQRGEZK' }
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

      // Check immediately and set up interval
      checkConnection();
      const interval = setInterval(checkConnection, 100);
      
      setTimeout(() => {
        clearInterval(interval);
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

    // ICE candidate gathering
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log(`🧊 ICE candidate for ${peerId}:`, event.candidate.type);
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
        this.emit('peerConnected', { peerId, connection: pc });
        console.log(`✅ CRITICAL: peerConnected event emitted for ${peerId}`);
        
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        console.log(`❌ Connection failed/disconnected for ${peerId}: ${pc.connectionState}`);
        this.connectionStates.set(peerId, pc.connectionState);
        this.cleanupConnection(peerId);
        this.emit('peerDisconnected', { peerId, reason: pc.connectionState });
      } else {
        console.log(`🔍 DEBUG: Connection state '${pc.connectionState}' for ${peerId} - not triggering events`);
      }
    };

    // ICE connection state changes
    pc.oniceconnectionstatechange = () => {
      console.log(`🧊 ICE connection state for ${peerId}: ${pc.iceConnectionState}`);
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
          // For incoming connections processing offers, we need the RTCPeerConnection immediately,
          // not after the connection is fully established. Create connection but don't await the Promise.
          console.log(`🚀 CRITICAL FIX: Creating connection without awaiting for immediate offer processing`);
          this.createConnection(peerId, false); // Don't await - we need the RTCPeerConnection object immediately
          pc = this.connections.get(peerId);
          console.log(`✅ Incoming connection created for ${peerId}, connection exists: ${!!pc}`);
          if (pc) {
            console.log(`🔍 Connection states: signaling=${pc.signalingState}, connection=${pc.connectionState}, ice=${pc.iceConnectionState}`);
          }
          console.log(`🚀 IMPORTANT: About to continue processing the original offer signal that triggered connection creation`);
          console.log(`🔍 DEBUG STEP 1: Continuing execution after connection creation`);
          console.log(`🔍 DEBUG STEP 1a: pc object after creation: ${!!pc}, signal type: ${signal.type}`);
          console.log(`🚀 CRITICAL: About to continue processing offer signal after connection creation`);
          // IMPORTANT: Don't return here - continue to process the offer signal that triggered this creation
        } catch (error) {
          // If connection already exists, get it and continue processing
          if (error.message.includes('already exists')) {
            console.log(`🔄 Connection already exists for ${peerId}, continuing to process offer`);
            pc = this.connections.get(peerId);
          } else {
            console.error(`❌ Failed to create incoming connection for ${peerId}:`, error);
            return;
          }
        }
      } else {
        console.warn(`⚠️ Received ${signal.type} signal for unknown peer ${peerId}`);
        return;
      }
    } else {
      console.log(`🔍 Using existing connection for ${peerId}: signaling=${pc.signalingState}, connection=${pc.connectionState}`);
      console.log(`🔍 DEBUG STEP 2: Using existing connection, no creation needed`);
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
    const pc = this.connections.get(peerId);
    return pc && pc.connectionState === 'connected';
  }

  /**
   * Get all connected peer IDs (filtered to only valid DHT peers)
   */
  getConnectedPeers() {
    const connected = [];
    for (const [peerId, pc] of this.connections.entries()) {
      if (pc.connectionState === 'connected' && this.isValidDHTPeer(peerId)) {
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
   * Destroy all connections and cleanup
   */
  destroy() {
    if (this.isDestroyed) return;

    console.log('Destroying WebRTCManager');
    this.isDestroyed = true;

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