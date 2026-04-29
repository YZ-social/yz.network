import { EventEmitter } from 'events';
import Logger from '../utils/Logger.js';
import { RelaySessionKeys } from './RelayEncryption.js';

/**
 * RelayManager - Manages WebSocket relay sessions for browser-to-browser communication
 * 
 * When direct WebRTC connections fail (e.g., both peers behind symmetric NAT),
 * this manager establishes relay paths through Node.js nodes (bridge nodes, DHT nodes).
 * 
 * ARCHITECTURE:
 * - RelayManager acts as a MESSAGE ROUTER that dispatches incoming relay messages
 *   to the correct per-peer HybridConnectionManager
 * - Each HybridConnectionManager OWNS its relay session state for ONE specific peer
 * - RelayManager handles relay node selection, health monitoring, and message routing
 * 
 * Key responsibilities:
 * - Route incoming relay messages to the correct HybridConnectionManager
 * - Track active relay sessions (sessionId → {from, to, relayNode})
 * - Select optimal relay node based on latency, load, and connectivity
 * - Handle relay protocol messages (relay_request, relay_forward, relay_ack, relay_close)
 * - Monitor relay health and implement failover
 * 
 * See: .kiro/specs/symmetric-nat-relay/design.md for detailed rationale
 */
export class RelayManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Maximum relay sessions this node can handle
      maxRelaySessions: options.maxRelaySessions || 100,
      // Session timeout (no activity)
      sessionTimeout: options.sessionTimeout || 5 * 60 * 1000, // 5 minutes
      // Health check interval for relay paths
      healthCheckInterval: options.healthCheckInterval || 30000, // 30 seconds
      // Maximum relay hops (prevent loops)
      maxRelayHops: options.maxRelayHops || 3,
      // Health check ping timeout
      pingTimeout: options.pingTimeout || 10000, // 10 seconds
      // Consecutive failures before marking relay unhealthy
      maxConsecutiveFailures: options.maxConsecutiveFailures || 3,
      // Time to wait before retrying an unhealthy relay
      unhealthyRetryInterval: options.unhealthyRetryInterval || 60000, // 1 minute
      ...options
    };
    
    // Active relay sessions: sessionId → RelaySession
    this._sessions = new Map();
    
    // Peer to session mapping: peerId → Set<sessionId>
    // Tracks which sessions involve each peer (for cleanup on disconnect)
    this._peerSessions = new Map();
    
    // Per-peer HybridConnectionManager registry: peerId → HybridConnectionManager
    // Used to route incoming relay messages to the correct manager
    this._peerManagers = new Map();
    
    // Relay node candidates: nodeId → RelayNodeInfo
    // Nodes that can act as relays (canRelay: true in metadata)
    this._relayNodes = new Map();
    
    // Local node info
    this._localNodeId = null;
    this._canRelay = false;
    this._relayLoad = 0;
    
    // Health check timer
    this._healthCheckTimer = null;
    
    // Session cleanup timer
    this._cleanupTimer = null;
    
    // Metrics
    this._metrics = {
      sessionsCreated: 0,
      sessionsClosed: 0,
      messagesRelayed: 0,
      bytesRelayed: 0,
      failovers: 0,
      healthChecksSent: 0,
      healthChecksReceived: 0,
      healthCheckTimeouts: 0
    };
    
    // Pending health check pings: pingId → { sessionId, sentAt, timeout }
    this._pendingPings = new Map();
    
    // Health status per relay node: nodeId → { healthy, consecutiveFailures, lastRtt, lastCheck }
    this._relayHealth = new Map();
    
    // Connection checker callback - set by DHT to check if relay nodes are connected to specific peers
    // Signature: (relayNodeId, peerId) => boolean
    this._connectionChecker = null;
    
    // Local peer's connected peers (for checking if we're connected to relay node)
    this._localConnectedPeers = new Set();
  }
  
  // ===========================================
  // PER-PEER MANAGER REGISTRATION
  // ===========================================
  
  /**
   * Register a HybridConnectionManager for a specific peer
   * The RelayManager will route incoming relay messages to this manager
   * @param {string} peerId - The peer ID this manager handles
   * @param {HybridConnectionManager} manager - The manager instance
   */
  registerPeerManager(peerId, manager) {
    if (!peerId) {
      console.warn('⚠️ RelayManager: Cannot register manager without peerId');
      return;
    }
    
    this._peerManagers.set(peerId, manager);
    console.log(`🔄 RelayManager: Registered manager for peer ${peerId.substring(0, 8)}...`);
  }
  
  /**
   * Unregister a HybridConnectionManager for a peer
   * @param {string} peerId - The peer ID to unregister
   */
  unregisterPeerManager(peerId) {
    if (this._peerManagers.has(peerId)) {
      this._peerManagers.delete(peerId);
      console.log(`🔄 RelayManager: Unregistered manager for peer ${peerId.substring(0, 8)}...`);
    }
  }
  
  /**
   * Get the HybridConnectionManager for a peer
   * @param {string} peerId - The peer ID
   * @returns {HybridConnectionManager|null}
   */
  getPeerManager(peerId) {
    return this._peerManagers.get(peerId) || null;
  }

  /**
   * Initialize the relay manager
   * @param {string} localNodeId - This node's ID
   * @param {boolean} canRelay - Whether this node can act as a relay
   */
  initialize(localNodeId, canRelay = false) {
    this._localNodeId = localNodeId;
    this._canRelay = canRelay;
    
    console.log(`🔄 RelayManager initialized: nodeId=${localNodeId.substring(0, 8)}..., canRelay=${canRelay}`);
    
    // Start health check timer
    this._startHealthCheck();
    
    // Start session cleanup timer
    this._startCleanupTimer();
    
    this.emit('initialized', { localNodeId, canRelay });
  }

  /**
   * Set a callback to check if a relay node is connected to a specific peer
   * This is used by the relay selection algorithm to prefer nodes already connected to both peers
   * @param {Function} checker - Callback: (relayNodeId, peerId) => boolean
   */
  setConnectionChecker(checker) {
    this._connectionChecker = checker;
    console.log('🔄 RelayManager: Connection checker callback set');
  }

  /**
   * Update the set of peers this local node is connected to
   * Used for relay selection to prefer nodes we're already connected to
   * @param {Array<string>|Set<string>} connectedPeers - Array or Set of connected peer IDs
   */
  updateLocalConnectedPeers(connectedPeers) {
    this._localConnectedPeers = new Set(connectedPeers);
  }

  /**
   * Check if a relay node is connected to a specific peer
   * Uses the connection checker callback if available
   * @param {string} relayNodeId - The relay node to check
   * @param {string} peerId - The peer to check connection to
   * @returns {boolean} True if connected
   * @private
   */
  _isRelayConnectedToPeer(relayNodeId, peerId) {
    // If we have a connection checker callback, use it
    if (this._connectionChecker) {
      return this._connectionChecker(relayNodeId, peerId);
    }
    
    // Fallback: check if the relay node has reported its connected peers
    const relayNode = this._relayNodes.get(relayNodeId);
    if (relayNode?.connectedPeers) {
      return relayNode.connectedPeers.has(peerId);
    }
    
    return false;
  }

  /**
   * Check if we (local node) are connected to a relay node
   * @param {string} relayNodeId - The relay node to check
   * @returns {boolean} True if connected
   * @private
   */
  _isConnectedToRelay(relayNodeId) {
    return this._localConnectedPeers.has(relayNodeId);
  }

  // ===========================================
  // RELAY SESSION MANAGEMENT
  // ===========================================

  /**
   * Request a relay session to connect to a target peer
   * 
   * Task 3.1: Start relay connection immediately (guaranteed to work)
   * This method sends a relay_request to the bridge node and waits for acknowledgment.
   * The relay connection is established immediately, providing guaranteed connectivity
   * while WebRTC probes in the background.
   * 
   * @param {string} targetPeerId - The peer we want to communicate with
   * @param {Object} options - Relay options
   * @param {string} options.preferredRelay - Preferred relay node ID (e.g., bridge node)
   * @param {number} options.timeout - Timeout for relay establishment (default: 5000ms)
   * @returns {Promise<RelaySession>} The established relay session
   */
  async requestRelaySession(targetPeerId, options = {}) {
    if (!this._localNodeId) {
      throw new Error('RelayManager not initialized');
    }
    
    const timeout = options.timeout || 5000;
    
    console.log(`🔄 Requesting relay session to ${targetPeerId.substring(0, 8)}...`);
    
    // Check if we already have a session to this peer
    const existingSession = this._findSessionToPeer(targetPeerId);
    if (existingSession && existingSession.state === 'active') {
      console.log(`🔄 Reusing existing relay session ${existingSession.sessionId.substring(0, 8)}...`);
      return existingSession;
    }
    
    // Select optimal relay node (prefer the specified relay if provided)
    const relayNode = await this._selectRelayNode(targetPeerId, options);
    if (!relayNode) {
      throw new Error(`No relay node available for connection to ${targetPeerId}`);
    }
    
    // Generate session ID
    const sessionId = this._generateSessionId();
    
    // Initialize encryption keys for end-to-end encryption
    // Relay nodes will only see encrypted payloads
    const encryptionKeys = new RelaySessionKeys();
    await encryptionKeys.initialize();
    
    // Create session object in pending state
    const session = {
      sessionId,
      fromPeerId: this._localNodeId,
      toPeerId: targetPeerId,
      relayNodeId: relayNode.nodeId,
      relayAddress: relayNode.publicAddress,
      state: 'pending', // pending, active, closing, closed
      createdAt: Date.now(),
      lastActivity: Date.now(),
      messagesRelayed: 0,
      bytesRelayed: 0,
      rtt: null, // Round-trip time through relay
      encryptionKeys, // End-to-end encryption keys
      encryptionReady: false // True when peer's public key is received
    };
    
    // Store session
    this._sessions.set(sessionId, session);
    this._addPeerSession(this._localNodeId, sessionId);
    this._addPeerSession(targetPeerId, sessionId);
    
    this._metrics.sessionsCreated++;
    
    console.log(`🔄 Created relay session ${sessionId.substring(0, 8)}... via ${relayNode.nodeId.substring(0, 8)}... (with E2E encryption)`);
    
    // Task 3.1: Send relay_request to the bridge node and wait for acknowledgment
    // This establishes the relay connection immediately, guaranteeing connectivity
    const publicKeyJwk = encryptionKeys.getPublicKeyJwk();
    
    try {
      // Create a promise that resolves when we receive the relay_ack
      const ackPromise = new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          // Clean up listener
          this.removeListener('sessionActivated', onActivated);
          this.removeListener('sessionFailed', onFailed);
          reject(new Error(`Relay session establishment timed out after ${timeout}ms`));
        }, timeout);
        
        const onActivated = ({ session: activatedSession }) => {
          if (activatedSession.sessionId === sessionId) {
            clearTimeout(timeoutId);
            this.removeListener('sessionActivated', onActivated);
            this.removeListener('sessionFailed', onFailed);
            resolve(activatedSession);
          }
        };
        
        const onFailed = ({ session: failedSession, error }) => {
          if (failedSession.sessionId === sessionId) {
            clearTimeout(timeoutId);
            this.removeListener('sessionActivated', onActivated);
            this.removeListener('sessionFailed', onFailed);
            reject(new Error(`Relay session failed: ${error}`));
          }
        };
        
        this.on('sessionActivated', onActivated);
        this.on('sessionFailed', onFailed);
      });
      
      // Send the relay_request message to the bridge node
      console.log(`📤 Sending relay_request to ${relayNode.nodeId.substring(0, 8)}... for session ${sessionId.substring(0, 8)}...`);
      this.emit('sendRelayRequest', {
        toPeerId: relayNode.nodeId,
        message: {
          type: 'relay_request',
          targetPeerId,
          sessionId,
          publicKey: publicKeyJwk,
          timestamp: Date.now()
        }
      });
      
      // Wait for acknowledgment (or timeout)
      const activatedSession = await ackPromise;
      
      console.log(`✅ Relay session ${sessionId.substring(0, 8)}... established and active`);
      this.emit('sessionCreated', { session: activatedSession, publicKey: publicKeyJwk });
      
      return activatedSession;
      
    } catch (error) {
      // Clean up failed session
      console.warn(`⚠️ Relay session establishment failed: ${error.message}`);
      this._cleanupSession(sessionId, 'establishment_failed');
      throw error;
    }
  }

  /**
   * Handle incoming relay request (when this node is the relay)
   * @param {string} fromPeerId - Requesting peer
   * @param {Object} message - Relay request message
   */
  handleRelayRequest(fromPeerId, message) {
    if (!this._canRelay) {
      console.warn(`⚠️ Received relay request but this node cannot relay`);
      this.emit('relayRequestRejected', { 
        fromPeerId, 
        sessionId: message.sessionId,
        reason: 'not_relay_capable'
      });
      return;
    }
    
    if (this._sessions.size >= this.options.maxRelaySessions) {
      console.warn(`⚠️ Relay capacity reached (${this._sessions.size}/${this.options.maxRelaySessions})`);
      this.emit('relayRequestRejected', {
        fromPeerId,
        sessionId: message.sessionId,
        reason: 'capacity_reached'
      });
      return;
    }
    
    const { targetPeerId, sessionId } = message;
    
    console.log(`🔄 Handling relay request: ${fromPeerId.substring(0, 8)}... → ${targetPeerId.substring(0, 8)}... (session: ${sessionId.substring(0, 8)}...)`);
    
    // Create relay session (this node is the relay)
    const session = {
      sessionId,
      fromPeerId,
      toPeerId: targetPeerId,
      relayNodeId: this._localNodeId, // We are the relay
      state: 'active',
      createdAt: Date.now(),
      lastActivity: Date.now(),
      messagesRelayed: 0,
      bytesRelayed: 0,
      isRelay: true // Flag indicating we're the relay node
    };
    
    this._sessions.set(sessionId, session);
    this._addPeerSession(fromPeerId, sessionId);
    this._addPeerSession(targetPeerId, sessionId);
    
    this._updateRelayLoad();
    this._metrics.sessionsCreated++;
    
    console.log(`✅ Relay session established: ${sessionId.substring(0, 8)}...`);
    
    this.emit('relaySessionEstablished', { session });
    this.emit('sendRelayAck', {
      toPeerId: fromPeerId,
      sessionId,
      success: true
    });
  }

  /**
   * Handle relay forward message (forward payload to target peer)
   * This is called when THIS node is acting as a RELAY (forwarding between two other peers)
   * @param {string} fromPeerId - Sender peer
   * @param {Object} message - Relay forward message
   */
  handleRelayForward(fromPeerId, message) {
    const { sessionId, to, payload } = message;
    
    const session = this._sessions.get(sessionId);
    if (!session) {
      console.warn(`⚠️ Unknown relay session: ${sessionId.substring(0, 8)}...`);
      return;
    }
    
    // Check if we are the relay node (forwarding between two peers)
    if (session.isRelay) {
      // We are the relay - forward to the other peer
      // Validate sender is part of this session
      if (fromPeerId !== session.fromPeerId && fromPeerId !== session.toPeerId) {
        console.warn(`⚠️ Unauthorized relay forward from ${fromPeerId.substring(0, 8)}...`);
        return;
      }
      
      // Determine target (the other peer in the session)
      const targetPeerId = fromPeerId === session.fromPeerId ? session.toPeerId : session.fromPeerId;
      
      // Update session activity
      session.lastActivity = Date.now();
      session.messagesRelayed++;
      session.bytesRelayed += JSON.stringify(payload).length;
      
      this._metrics.messagesRelayed++;
      this._metrics.bytesRelayed += JSON.stringify(payload).length;
      
      Logger.trace(`🔄 Relaying message: ${fromPeerId.substring(0, 8)}... → ${targetPeerId.substring(0, 8)}... (session: ${sessionId.substring(0, 8)}...)`);
      
      // Emit event to forward the message
      this.emit('forwardRelayMessage', {
        toPeerId: targetPeerId,
        message: {
          type: 'relay_forward',
          from: fromPeerId,
          sessionId,
          payload
        }
      });
    } else {
      // We are an ENDPOINT - this message is for us, deliver to local handlers
      this._handleIncomingRelayPayload(fromPeerId, message);
    }
  }
  
  /**
   * Handle incoming relay payload as an ENDPOINT (not as a relay)
   * This is called when we receive a relay_forward message that is destined for us
   * @param {string} fromPeerId - The relay node that forwarded the message (bridge node)
   * @param {Object} message - Relay forward message containing the payload
   * @private
   */
  async _handleIncomingRelayPayload(fromPeerId, message) {
    const { sessionId, from: originalSender, payload } = message;
    
    let session = this._sessions.get(sessionId);
    let isNewSession = false;
    
    if (!session) {
      // Create session on-the-fly for the receiving end
      // This happens when Browser A initiates a relay session to Browser B,
      // and Browser B receives the first relay_forward message
      console.log(`🔄 Creating session on-the-fly for incoming relay: ${sessionId.substring(0, 8)}... from ${originalSender.substring(0, 8)}...`);
      
      session = {
        sessionId,
        fromPeerId: originalSender, // The peer who initiated the relay
        toPeerId: this._localNodeId, // We are the target
        relayNodeId: fromPeerId, // The bridge node that forwarded the message
        state: 'active',
        createdAt: Date.now(),
        lastActivity: Date.now(),
        messagesRelayed: 0,
        bytesRelayed: 0,
        isRelay: false, // We are an endpoint, not a relay
        encryptionReady: false // No encryption for on-the-fly sessions (yet)
      };
      
      this._sessions.set(sessionId, session);
      this._addPeerSession(originalSender, sessionId);
      this._addPeerSession(this._localNodeId, sessionId);
      
      this._metrics.sessionsCreated++;
      isNewSession = true;
      
      console.log(`✅ On-the-fly relay session created: ${sessionId.substring(0, 8)}...`);
    }
    
    // Update session activity
    session.lastActivity = Date.now();
    
    // Decrypt payload if encryption is enabled
    let decryptedPayload = payload;
    if (session.encryptionReady && session.encryptionKeys && payload?.encrypted) {
      try {
        decryptedPayload = await session.encryptionKeys.decrypt(payload);
        Logger.trace(`🔓 Decrypted relay payload for session ${sessionId.substring(0, 8)}...`);
      } catch (err) {
        console.warn(`⚠️ Failed to decrypt relay payload: ${err.message}`);
        // Try to use payload as-is (backward compatibility)
        decryptedPayload = payload;
      }
    }
    
    Logger.trace(`📥 Received relay payload from ${originalSender.substring(0, 8)}... via session ${sessionId.substring(0, 8)}...`);
    
    // Route message to the correct HybridConnectionManager for this peer
    let peerManager = this._peerManagers.get(originalSender);
    
    if (!peerManager && isNewSession) {
      // No manager registered yet - emit event so one can be created
      // This is the "incoming relay connection" case
      console.log(`🔄 No manager for peer ${originalSender.substring(0, 8)}..., emitting incomingRelaySession event`);
      this.emit('incomingRelaySession', {
        sessionId,
        fromPeerId: originalSender,
        relayNodeId: fromPeerId
      });
      
      // Try to get the manager again (it may have been created synchronously)
      peerManager = this._peerManagers.get(originalSender);
    }
    
    if (peerManager) {
      // Route directly to the per-peer manager
      peerManager.handleRelayMessage({
        sessionId,
        from: originalSender,
        payload: decryptedPayload
      });
    } else {
      // Fallback: emit global event for backward compatibility
      console.warn(`⚠️ No manager for peer ${originalSender.substring(0, 8)}..., using global event fallback`);
      this.emit('relayForwardReceived', {
        sessionId,
        from: originalSender,
        payload: decryptedPayload
      });
    }
  }

  /**
   * Handle relay acknowledgment
   * @param {string} fromPeerId - Relay node that sent the ack
   * @param {Object} message - Relay ack message
   */
  async handleRelayAck(fromPeerId, message) {
    const { sessionId, success, error, publicKey } = message;
    
    const session = this._sessions.get(sessionId);
    if (!session) {
      console.warn(`⚠️ Received ack for unknown session: ${sessionId.substring(0, 8)}...`);
      return;
    }
    
    if (success) {
      session.state = 'active';
      
      // Complete encryption key exchange if peer's public key is provided
      if (publicKey && session.encryptionKeys) {
        try {
          await session.encryptionKeys.setPeerPublicKey(publicKey);
          session.encryptionReady = true;
          console.log(`🔐 E2E encryption established for session ${sessionId.substring(0, 8)}...`);
        } catch (err) {
          console.warn(`⚠️ Failed to establish E2E encryption for session ${sessionId.substring(0, 8)}...: ${err.message}`);
          // Session can still work without encryption (backward compatibility)
        }
      }
      
      console.log(`✅ Relay session ${sessionId.substring(0, 8)}... is now active`);
      this.emit('sessionActivated', { session });
    } else {
      session.state = 'failed';
      console.warn(`❌ Relay session ${sessionId.substring(0, 8)}... failed: ${error}`);
      this._cleanupSession(sessionId);
      this.emit('sessionFailed', { session, error });
    }
  }

  /**
   * Handle relay close message
   * @param {string} fromPeerId - Peer requesting close
   * @param {Object} message - Relay close message
   */
  handleRelayClose(fromPeerId, message) {
    const { sessionId, reason } = message;
    
    console.log(`🔄 Relay close request for session ${sessionId.substring(0, 8)}...: ${reason || 'no reason'}`);
    
    this._cleanupSession(sessionId, reason);
  }

  /**
   * Handle relay ping message (health check request)
   * When we receive a ping, we respond with a pong
   * @param {string} fromPeerId - Peer sending the ping
   * @param {Object} message - Relay ping message
   */
  handleRelayPing(fromPeerId, message) {
    const { sessionId, pingId, timestamp } = message;
    
    const session = this._sessions.get(sessionId);
    if (!session) {
      // Session doesn't exist, ignore ping
      return;
    }
    
    // Update session activity
    session.lastActivity = Date.now();
    
    // Respond with pong
    this.emit('sendRelayPong', {
      toPeerId: fromPeerId,
      message: {
        type: 'relay_pong',
        sessionId,
        pingId,
        timestamp, // Echo back original timestamp for RTT calculation
        respondedAt: Date.now()
      }
    });
  }

  /**
   * Handle relay pong message (health check response)
   * Task 4.4: Route pong to HybridConnectionManager for RTT measurement
   * @param {string} fromPeerId - Peer sending the pong
   * @param {Object} message - Relay pong message
   */
  handleRelayPong(fromPeerId, message) {
    const { sessionId, pingId, timestamp } = message;
    
    const pendingPing = this._pendingPings.get(pingId);
    if (!pendingPing) {
      // Ping already timed out or unknown - might be a path measurement ping
      // Try to route to the appropriate HybridConnectionManager
      const session = this._sessions.get(sessionId);
      if (session) {
        // Find the peer manager for this session
        const targetPeerId = session.fromPeerId === this._localNodeId ? session.toPeerId : session.fromPeerId;
        const peerManager = this._peerManagers.get(targetPeerId);
        
        if (peerManager && typeof peerManager.handleRelayPong === 'function') {
          console.log(`📊 RelayManager: Routing relay pong to HybridConnectionManager for ${targetPeerId.substring(0, 8)}...`);
          peerManager.handleRelayPong(message);
        }
      }
      return;
    }
    
    // Clear the timeout
    if (pendingPing.timeout) {
      clearTimeout(pendingPing.timeout);
    }
    this._pendingPings.delete(pingId);
    
    // Calculate RTT
    const rtt = Date.now() - pendingPing.sentAt;
    
    const session = this._sessions.get(sessionId);
    if (session) {
      session.lastActivity = Date.now();
      session.rtt = rtt;
      
      // Task 4.4: Route pong to HybridConnectionManager for path tracking
      const targetPeerId = session.fromPeerId === this._localNodeId ? session.toPeerId : session.fromPeerId;
      const peerManager = this._peerManagers.get(targetPeerId);
      
      if (peerManager && typeof peerManager.handleRelayPong === 'function') {
        console.log(`📊 RelayManager: Routing relay pong to HybridConnectionManager for ${targetPeerId.substring(0, 8)}... (RTT: ${rtt}ms)`);
        peerManager.handleRelayPong(message);
      }
    }
    
    // Update relay health status
    this._updateRelayHealth(pendingPing.relayNodeId, true, rtt);
    
    this._metrics.healthChecksReceived++;
    
    Logger.trace(`🔄 Relay pong received for session ${sessionId.substring(0, 8)}... RTT=${rtt}ms`);
    
    this.emit('healthCheckSuccess', { sessionId, relayNodeId: pendingPing.relayNodeId, rtt });
  }

  /**
   * Send a health check ping through a relay session
   * @param {string} sessionId - Session to ping
   * @private
   */
  _sendHealthPing(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session || session.state !== 'active') {
      return;
    }
    
    const pingId = `ping_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const sentAt = Date.now();
    
    // Set up timeout for this ping
    const timeout = setTimeout(() => {
      this._handlePingTimeout(pingId);
    }, this.options.pingTimeout);
    
    // Track pending ping
    this._pendingPings.set(pingId, {
      sessionId,
      relayNodeId: session.relayNodeId,
      sentAt,
      timeout
    });
    
    this._metrics.healthChecksSent++;
    
    // Send ping through the relay
    this.emit('sendRelayPing', {
      toPeerId: session.relayNodeId,
      message: {
        type: 'relay_ping',
        sessionId,
        pingId,
        timestamp: sentAt
      }
    });
  }

  /**
   * Handle ping timeout - relay may be unhealthy
   * @param {string} pingId - The ping that timed out
   * @private
   */
  _handlePingTimeout(pingId) {
    const pendingPing = this._pendingPings.get(pingId);
    if (!pendingPing) {
      return;
    }
    
    this._pendingPings.delete(pingId);
    this._metrics.healthCheckTimeouts++;
    
    const { sessionId, relayNodeId } = pendingPing;
    
    console.warn(`⚠️ Relay health check timeout for session ${sessionId.substring(0, 8)}... via ${relayNodeId.substring(0, 8)}...`);
    
    // Update relay health status (failure)
    const shouldFailover = this._updateRelayHealth(relayNodeId, false, null);
    
    this.emit('healthCheckTimeout', { sessionId, relayNodeId });
    
    // If relay is now unhealthy, trigger failover
    if (shouldFailover) {
      this._initiateFailover(sessionId, relayNodeId, 'health_check_timeout');
    }
  }

  /**
   * Update relay node health status
   * @param {string} relayNodeId - Relay node ID
   * @param {boolean} success - Whether the health check succeeded
   * @param {number|null} rtt - Round-trip time if successful
   * @returns {boolean} True if failover should be triggered
   * @private
   */
  _updateRelayHealth(relayNodeId, success, rtt) {
    let health = this._relayHealth.get(relayNodeId);
    
    if (!health) {
      health = {
        healthy: true,
        consecutiveFailures: 0,
        lastRtt: null,
        lastCheck: Date.now(),
        totalChecks: 0,
        totalFailures: 0
      };
      this._relayHealth.set(relayNodeId, health);
    }
    
    health.lastCheck = Date.now();
    health.totalChecks++;
    
    if (success) {
      health.consecutiveFailures = 0;
      health.lastRtt = rtt;
      
      // If was unhealthy, mark as healthy again
      if (!health.healthy) {
        health.healthy = true;
        console.log(`✅ Relay ${relayNodeId.substring(0, 8)}... is healthy again (RTT: ${rtt}ms)`);
        this.emit('relayHealthRestored', { relayNodeId, rtt });
      }
      
      return false; // No failover needed
    } else {
      health.consecutiveFailures++;
      health.totalFailures++;
      
      console.warn(`⚠️ Relay ${relayNodeId.substring(0, 8)}... health check failed (${health.consecutiveFailures}/${this.options.maxConsecutiveFailures})`);
      
      // Check if we should mark as unhealthy
      if (health.consecutiveFailures >= this.options.maxConsecutiveFailures) {
        if (health.healthy) {
          health.healthy = false;
          console.error(`❌ Relay ${relayNodeId.substring(0, 8)}... marked unhealthy after ${health.consecutiveFailures} consecutive failures`);
          this.emit('relayUnhealthy', { relayNodeId, consecutiveFailures: health.consecutiveFailures });
        }
        return true; // Trigger failover
      }
      
      return false; // Not enough failures yet
    }
  }

  /**
   * Initiate failover for a session to a new relay
   * @param {string} sessionId - Session to failover
   * @param {string} failedRelayId - The relay that failed
   * @param {string} reason - Reason for failover
   * @private
   */
  async _initiateFailover(sessionId, failedRelayId, reason) {
    const session = this._sessions.get(sessionId);
    if (!session || session.state !== 'active') {
      return;
    }
    
    console.log(`🔄 Initiating failover for session ${sessionId.substring(0, 8)}... (reason: ${reason})`);
    
    // Find a new relay node (excluding the failed one)
    const newRelay = await this._selectRelayNode(session.toPeerId, {
      excludeNodes: [failedRelayId]
    });
    
    if (!newRelay) {
      console.error(`❌ No alternate relay available for failover of session ${sessionId.substring(0, 8)}...`);
      this.emit('failoverFailed', { sessionId, reason: 'no_alternate_relay' });
      return;
    }
    
    // Store old relay info for event
    const oldRelayId = session.relayNodeId;
    const oldRelayAddress = session.relayAddress;
    
    // Update session with new relay
    session.relayNodeId = newRelay.nodeId;
    session.relayAddress = newRelay.publicAddress;
    session.lastActivity = Date.now();
    
    this._metrics.failovers++;
    
    console.log(`✅ Failover complete: session ${sessionId.substring(0, 8)}... moved from ${oldRelayId.substring(0, 8)}... to ${newRelay.nodeId.substring(0, 8)}...`);
    
    this.emit('failoverComplete', {
      sessionId,
      oldRelayId,
      newRelayId: newRelay.nodeId,
      reason
    });
    
    // Notify the relay nodes about the change
    // Close session on old relay
    this.emit('sendRelayClose', {
      toPeerId: oldRelayId,
      sessionId,
      reason: 'failover'
    });
    
    // Request new relay session
    this.emit('sendRelayRequest', {
      toPeerId: newRelay.nodeId,
      message: {
        type: 'relay_request',
        targetPeerId: session.toPeerId,
        sessionId
      }
    });
  }

  /**
   * Check if a relay node is healthy
   * @param {string} relayNodeId - Relay node ID
   * @returns {boolean} True if healthy or unknown
   */
  isRelayHealthy(relayNodeId) {
    const health = this._relayHealth.get(relayNodeId);
    if (!health) {
      return true; // Unknown = assume healthy
    }
    
    // If marked unhealthy, check if enough time has passed to retry
    if (!health.healthy) {
      const timeSinceLastCheck = Date.now() - health.lastCheck;
      if (timeSinceLastCheck >= this.options.unhealthyRetryInterval) {
        // Allow retry
        return true;
      }
      return false;
    }
    
    return true;
  }

  /**
   * Get health status for a relay node
   * @param {string} relayNodeId - Relay node ID
   * @returns {Object|null} Health status or null if unknown
   */
  getRelayHealth(relayNodeId) {
    return this._relayHealth.get(relayNodeId) || null;
  }

  /**
   * Close a relay session
   * @param {string} sessionId - Session to close
   * @param {string} reason - Reason for closing
   */
  closeSession(sessionId, reason = 'manual') {
    const session = this._sessions.get(sessionId);
    if (!session) {
      return;
    }
    
    console.log(`🔄 Closing relay session ${sessionId.substring(0, 8)}...: ${reason}`);
    
    // Notify peers
    this.emit('sendRelayClose', {
      toPeerId: session.fromPeerId,
      sessionId,
      reason
    });
    
    if (session.toPeerId !== session.fromPeerId) {
      this.emit('sendRelayClose', {
        toPeerId: session.toPeerId,
        sessionId,
        reason
      });
    }
    
    this._cleanupSession(sessionId, reason);
  }

  /**
   * Send a message through a relay session
   * Payloads are encrypted end-to-end if encryption is established
   * @param {string} sessionId - Session to use
   * @param {Object} payload - Message payload (will be encrypted and forwarded opaquely)
   */
  async sendThroughRelay(sessionId, payload) {
    const session = this._sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown relay session: ${sessionId}`);
    }
    
    if (session.state !== 'active') {
      throw new Error(`Relay session ${sessionId} is not active (state: ${session.state})`);
    }
    
    session.lastActivity = Date.now();
    
    // Encrypt payload if encryption is ready (relay node sees only ciphertext)
    let finalPayload = payload;
    if (session.encryptionReady && session.encryptionKeys) {
      try {
        finalPayload = await session.encryptionKeys.encrypt(payload);
        Logger.trace(`🔐 Encrypted relay payload for session ${sessionId.substring(0, 8)}...`);
      } catch (err) {
        console.warn(`⚠️ Failed to encrypt relay payload: ${err.message}, sending unencrypted`);
        // Fall back to unencrypted (backward compatibility)
      }
    }
    
    this.emit('sendRelayForward', {
      toPeerId: session.relayNodeId,
      message: {
        type: 'relay_forward',
        sessionId,
        to: session.toPeerId,
        payload: finalPayload
      }
    });
  }

  // ===========================================
  // RELAY NODE SELECTION
  // ===========================================

  /**
   * Update known relay nodes from DHT routing table
   * @param {Array} nodes - Array of node info objects with metadata
   *   Each node can have:
   *   - nodeId: string
   *   - metadata.canRelay: boolean
   *   - metadata.publicAddress: string
   *   - metadata.relayLoad: number (0-1)
   *   - metadata.relayCapacity: number
   *   - metadata.connectedPeers: Array<string> (optional - peers this relay is connected to)
   *   - rtt: number (optional - round-trip time in ms)
   */
  updateRelayNodes(nodes) {
    for (const node of nodes) {
      if (node.metadata?.canRelay && node.metadata?.publicAddress) {
        // Convert connectedPeers array to Set for efficient lookup
        const connectedPeers = node.metadata.connectedPeers 
          ? new Set(node.metadata.connectedPeers)
          : null;
        
        this._relayNodes.set(node.nodeId, {
          nodeId: node.nodeId,
          publicAddress: node.metadata.publicAddress,
          relayLoad: node.metadata.relayLoad || 0,
          relayCapacity: node.metadata.relayCapacity || 100,
          connectedPeers, // Set of peer IDs this relay is connected to
          rtt: node.rtt || null,
          lastSeen: Date.now()
        });
      }
    }
    
    // Clean up stale relay nodes (not seen in 5 minutes)
    const staleThreshold = Date.now() - 5 * 60 * 1000;
    for (const [nodeId, info] of this._relayNodes) {
      if (info.lastSeen < staleThreshold) {
        this._relayNodes.delete(nodeId);
      }
    }
  }

  /**
   * Select optimal relay node for a connection
   * 
   * Selection algorithm (in priority order):
   * 1. HIGHEST PRIORITY: Nodes already connected to BOTH peers (us and target)
   *    - These can relay immediately without new connections
   *    - Bonus: +50 points
   * 2. HIGH PRIORITY: Nodes connected to target peer (we can connect to relay)
   *    - Only need to establish one new connection
   *    - Bonus: +30 points
   * 3. MEDIUM PRIORITY: Nodes we're already connected to
   *    - Only need relay to connect to target
   *    - Bonus: +20 points
   * 4. Load balancing: Prefer nodes with lower current load
   *    - Penalty: up to -50 points based on relayLoad (0-1)
   * 5. Latency: Prefer nodes with lower RTT
   *    - Penalty: up to -30 points based on RTT
   * 6. Capacity: Prefer nodes with more available capacity
   *    - Bonus: up to +20 points based on available slots
   * 7. Health: Exclude unhealthy relays (unless retry interval passed)
   * 
   * @param {string} targetPeerId - Target peer we want to reach
   * @param {Object} options - Selection options
   * @param {Array<string>} options.excludeNodes - Node IDs to exclude (e.g., for failover)
   * @returns {Object|null} Selected relay node info
   * @private
   */
  async _selectRelayNode(targetPeerId, options = {}) {
    const excludeNodes = new Set(options.excludeNodes || []);
    
    const candidates = Array.from(this._relayNodes.values()).filter(node => {
      // Exclude specified nodes (e.g., failed relay during failover)
      if (excludeNodes.has(node.nodeId)) {
        return false;
      }
      
      // Exclude unhealthy relays (unless retry interval has passed)
      if (!this.isRelayHealthy(node.nodeId)) {
        return false;
      }
      
      return true;
    });
    
    if (candidates.length === 0) {
      console.warn(`⚠️ No relay nodes available (${this._relayNodes.size} known, ${excludeNodes.size} excluded, some may be unhealthy)`);
      return null;
    }
    
    // Score each candidate
    const scored = candidates.map(node => {
      let score = 100; // Base score
      let connectionBonus = 0;
      let connectionStatus = 'none';
      
      // Check connectivity to both peers
      const connectedToUs = this._isConnectedToRelay(node.nodeId);
      const connectedToTarget = this._isRelayConnectedToPeer(node.nodeId, targetPeerId);
      
      // HIGHEST PRIORITY: Connected to BOTH peers
      if (connectedToUs && connectedToTarget) {
        connectionBonus = 50;
        connectionStatus = 'both';
      }
      // HIGH PRIORITY: Connected to target (we can connect to relay)
      else if (connectedToTarget) {
        connectionBonus = 30;
        connectionStatus = 'target';
      }
      // MEDIUM PRIORITY: Connected to us (relay needs to connect to target)
      else if (connectedToUs) {
        connectionBonus = 20;
        connectionStatus = 'local';
      }
      
      score += connectionBonus;
      
      // Load balancing: Prefer nodes with lower load
      // relayLoad is 0-1, so penalty is 0-50 points
      const loadPenalty = node.relayLoad * 50;
      score -= loadPenalty;
      
      // Latency: Prefer nodes with lower RTT
      // Use health-tracked RTT if available, otherwise node's reported RTT
      const health = this._relayHealth.get(node.nodeId);
      const effectiveRtt = health?.lastRtt || node.rtt;
      let latencyPenalty = 0;
      if (effectiveRtt) {
        // Cap penalty at 30 points (300ms+ RTT gets max penalty)
        latencyPenalty = Math.min(effectiveRtt / 10, 30);
        score -= latencyPenalty;
      }
      
      // Capacity: Prefer nodes with more available capacity
      // Available capacity = total capacity - (load * capacity)
      const utilization = node.relayLoad * node.relayCapacity;
      const availableCapacity = node.relayCapacity - utilization;
      // Cap bonus at 20 points (200+ available slots gets max bonus)
      const capacityBonus = Math.min(availableCapacity / 10, 20);
      score += capacityBonus;
      
      // Health bonus: Prefer relays with good health history
      let healthBonus = 0;
      if (health && health.totalChecks > 0) {
        const successRate = 1 - (health.totalFailures / health.totalChecks);
        healthBonus = successRate * 10; // Up to 10 points for 100% success rate
        score += healthBonus;
      }
      
      return { 
        node, 
        score,
        connectionStatus,
        connectionBonus,
        loadPenalty,
        latencyPenalty,
        capacityBonus,
        healthBonus
      };
    });
    
    // Sort by score (highest first)
    scored.sort((a, b) => b.score - a.score);
    
    // Log top candidates for debugging
    if (scored.length > 0) {
      const top3 = scored.slice(0, 3);
      console.log(`🔄 Relay node candidates (top ${top3.length}):`);
      for (const candidate of top3) {
        const { node, score, connectionStatus, connectionBonus, loadPenalty, capacityBonus, healthBonus } = candidate;
        console.log(`   ${node.nodeId.substring(0, 8)}... score=${score.toFixed(1)} ` +
          `[conn=${connectionStatus}(+${connectionBonus}) load=-${loadPenalty.toFixed(1)} cap=+${capacityBonus.toFixed(1)} health=+${healthBonus.toFixed(1)}]`);
      }
    }
    
    // Return best candidate
    const best = scored[0];
    if (best) {
      console.log(`🔄 Selected relay node: ${best.node.nodeId.substring(0, 8)}... ` +
        `(score: ${best.score.toFixed(1)}, conn: ${best.connectionStatus}, load: ${(best.node.relayLoad * 100).toFixed(0)}%)`);
      return best.node;
    }
    
    return null;
  }

  /**
   * Get relay node for a specific peer (if we have a session)
   * @param {string} peerId - Peer ID
   * @returns {string|null} Relay node ID or null
   */
  getRelayNodeForPeer(peerId) {
    const session = this._findSessionToPeer(peerId);
    return session?.relayNodeId || null;
  }

  // ===========================================
  // PEER DISCONNECT HANDLING
  // ===========================================

  /**
   * Handle peer disconnection - clean up related sessions
   * @param {string} peerId - Disconnected peer
   */
  handlePeerDisconnected(peerId) {
    const sessionIds = this._peerSessions.get(peerId);
    if (!sessionIds || sessionIds.size === 0) {
      return;
    }
    
    console.log(`🔄 Cleaning up ${sessionIds.size} relay sessions for disconnected peer ${peerId.substring(0, 8)}...`);
    
    for (const sessionId of sessionIds) {
      this._cleanupSession(sessionId, 'peer_disconnected');
    }
  }

  // ===========================================
  // HEALTH MONITORING
  // ===========================================

  /**
   * Start health check timer
   * @private
   */
  _startHealthCheck() {
    if (this._healthCheckTimer) {
      clearInterval(this._healthCheckTimer);
    }
    
    this._healthCheckTimer = setInterval(() => {
      this._performHealthCheck();
    }, this.options.healthCheckInterval);
  }

  /**
   * Perform health check on active sessions
   * Sends ping through each active relay session to measure RTT and detect failures
   * @private
   */
  _performHealthCheck() {
    const now = Date.now();
    const staleThreshold = now - this.options.sessionTimeout;
    
    for (const [sessionId, session] of this._sessions) {
      // Check for stale sessions
      if (session.lastActivity < staleThreshold) {
        console.log(`🔄 Session ${sessionId.substring(0, 8)}... timed out (no activity for ${Math.round((now - session.lastActivity) / 1000)}s)`);
        this._cleanupSession(sessionId, 'timeout');
        continue;
      }
      
      // Skip sessions that are not active
      if (session.state !== 'active') {
        continue;
      }
      
      // Skip sessions where we are the relay (we don't ping ourselves)
      if (session.isRelay) {
        continue;
      }
      
      // Send health check ping through relay
      this._sendHealthPing(sessionId);
    }
  }

  /**
   * Start session cleanup timer
   * @private
   */
  _startCleanupTimer() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
    }
    
    // Run cleanup every minute
    this._cleanupTimer = setInterval(() => {
      this._cleanupStaleSessions();
    }, 60000);
  }

  /**
   * Clean up stale sessions
   * @private
   */
  _cleanupStaleSessions() {
    const now = Date.now();
    const staleThreshold = now - this.options.sessionTimeout;
    
    for (const [sessionId, session] of this._sessions) {
      if (session.lastActivity < staleThreshold) {
        this._cleanupSession(sessionId, 'stale');
      }
    }
  }

  // ===========================================
  // UTILITY METHODS
  // ===========================================

  /**
   * Find existing session to a peer
   * @param {string} peerId - Target peer
   * @returns {Object|null} Session or null
   * @private
   */
  _findSessionToPeer(peerId) {
    for (const session of this._sessions.values()) {
      if (session.toPeerId === peerId || session.fromPeerId === peerId) {
        return session;
      }
    }
    return null;
  }

  /**
   * Add peer to session mapping
   * @param {string} peerId - Peer ID
   * @param {string} sessionId - Session ID
   * @private
   */
  _addPeerSession(peerId, sessionId) {
    if (!this._peerSessions.has(peerId)) {
      this._peerSessions.set(peerId, new Set());
    }
    this._peerSessions.get(peerId).add(sessionId);
  }

  /**
   * Remove peer from session mapping
   * @param {string} peerId - Peer ID
   * @param {string} sessionId - Session ID
   * @private
   */
  _removePeerSession(peerId, sessionId) {
    const sessions = this._peerSessions.get(peerId);
    if (sessions) {
      sessions.delete(sessionId);
      if (sessions.size === 0) {
        this._peerSessions.delete(peerId);
      }
    }
  }

  /**
   * Clean up a session
   * @param {string} sessionId - Session to clean up
   * @param {string} reason - Reason for cleanup
   * @private
   */
  _cleanupSession(sessionId, reason = 'unknown') {
    const session = this._sessions.get(sessionId);
    if (!session) {
      return;
    }
    
    session.state = 'closed';
    
    // Clean up encryption keys
    if (session.encryptionKeys) {
      session.encryptionKeys.destroy();
      session.encryptionKeys = null;
      session.encryptionReady = false;
    }
    
    // Remove from peer mappings
    this._removePeerSession(session.fromPeerId, sessionId);
    this._removePeerSession(session.toPeerId, sessionId);
    
    // Remove session
    this._sessions.delete(sessionId);
    
    this._updateRelayLoad();
    this._metrics.sessionsClosed++;
    
    console.log(`🔄 Session ${sessionId.substring(0, 8)}... cleaned up: ${reason}`);
    
    this.emit('sessionClosed', { session, reason });
  }

  /**
   * Update relay load metric
   * @private
   */
  _updateRelayLoad() {
    if (this._canRelay) {
      this._relayLoad = this._sessions.size / this.options.maxRelaySessions;
    }
  }

  /**
   * Generate unique session ID
   * @returns {string} Session ID
   * @private
   */
  _generateSessionId() {
    return `relay_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // ===========================================
  // PUBLIC GETTERS
  // ===========================================

  /**
   * Get current relay load (0-1)
   */
  getRelayLoad() {
    return this._relayLoad;
  }

  /**
   * Get relay capacity
   */
  getRelayCapacity() {
    return this.options.maxRelaySessions;
  }

  /**
   * Check if this node can relay
   */
  canRelay() {
    return this._canRelay;
  }

  /**
   * Get active session count
   */
  getActiveSessionCount() {
    return this._sessions.size;
  }

  /**
   * Get session by ID
   * @param {string} sessionId - Session ID
   * @returns {Object|null} Session or null
   */
  getSession(sessionId) {
    return this._sessions.get(sessionId) || null;
  }

  /**
   * Check if a relay path exists to a peer
   * Task 3.3: Browser sends to peer → check if relay path exists, use it
   * @param {string} peerId - Target peer ID
   * @returns {boolean} True if an active relay session exists to the peer
   */
  hasRelayPath(peerId) {
    const session = this._findSessionToPeer(peerId);
    return session !== null && session.state === 'active';
  }

  /**
   * Get the active relay session for a peer (if one exists)
   * Task 3.3: Maintain mapping of peerId → relay session
   * @param {string} peerId - Target peer ID
   * @returns {Object|null} Active session or null
   */
  getActiveSessionForPeer(peerId) {
    const session = this._findSessionToPeer(peerId);
    if (session && session.state === 'active') {
      return session;
    }
    return null;
  }

  /**
   * Decrypt a received relay payload
   * Call this when receiving a relay_forward message to decrypt the payload
   * @param {string} sessionId - Session ID
   * @param {Object} payload - Encrypted payload from relay_forward message
   * @returns {Promise<Object>} Decrypted payload
   */
  async decryptRelayPayload(sessionId, payload) {
    const session = this._sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown relay session: ${sessionId}`);
    }
    
    // Check if payload is encrypted
    if (!payload || !payload.encrypted) {
      // Not encrypted, return as-is (backward compatibility)
      return payload;
    }
    
    // Decrypt if encryption is ready
    if (session.encryptionReady && session.encryptionKeys) {
      try {
        const decrypted = await session.encryptionKeys.decrypt(payload);
        Logger.trace(`🔓 Decrypted relay payload for session ${sessionId.substring(0, 8)}...`);
        return decrypted;
      } catch (err) {
        console.warn(`⚠️ Failed to decrypt relay payload: ${err.message}`);
        throw err;
      }
    }
    
    // Encryption not ready but payload is encrypted - this is an error
    throw new Error(`Received encrypted payload but encryption not established for session ${sessionId}`);
  }

  /**
   * Check if a session has encryption enabled
   * @param {string} sessionId - Session ID
   * @returns {boolean}
   */
  isSessionEncrypted(sessionId) {
    const session = this._sessions.get(sessionId);
    return session ? session.encryptionReady === true : false;
  }

  /**
   * Get the public key for a session (to send to peer during handshake)
   * @param {string} sessionId - Session ID
   * @returns {Object|null} Public key JWK or null
   */
  getSessionPublicKey(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session || !session.encryptionKeys) {
      return null;
    }
    return session.encryptionKeys.getPublicKeyJwk();
  }

  /**
   * Set the peer's public key for a session (received during handshake)
   * @param {string} sessionId - Session ID
   * @param {Object} publicKeyJwk - Peer's public key in JWK format
   */
  async setSessionPeerPublicKey(sessionId, publicKeyJwk) {
    const session = this._sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown relay session: ${sessionId}`);
    }
    
    if (!session.encryptionKeys) {
      // Initialize encryption keys if not already done
      session.encryptionKeys = new RelaySessionKeys();
      await session.encryptionKeys.initialize();
    }
    
    await session.encryptionKeys.setPeerPublicKey(publicKeyJwk);
    session.encryptionReady = true;
    console.log(`🔐 E2E encryption established for session ${sessionId.substring(0, 8)}...`);
  }

  /**
   * Get all sessions for a peer
   * @param {string} peerId - Peer ID
   * @returns {Array} Array of sessions
   */
  getSessionsForPeer(peerId) {
    const sessionIds = this._peerSessions.get(peerId);
    if (!sessionIds) {
      return [];
    }
    
    return Array.from(sessionIds)
      .map(id => this._sessions.get(id))
      .filter(Boolean);
  }

  /**
   * Get relay metrics
   */
  getMetrics() {
    // Calculate health statistics
    let healthyRelays = 0;
    let unhealthyRelays = 0;
    for (const health of this._relayHealth.values()) {
      if (health.healthy) {
        healthyRelays++;
      } else {
        unhealthyRelays++;
      }
    }
    
    return {
      ...this._metrics,
      activeSessions: this._sessions.size,
      relayLoad: this._relayLoad,
      relayNodesKnown: this._relayNodes.size,
      healthyRelays,
      unhealthyRelays,
      pendingPings: this._pendingPings.size
    };
  }
  
  /**
   * Get aggregate path statistics across all browser-to-browser connections
   * Task 5.4: Report aggregate statistics: % direct, % relay
   * 
   * This aggregates path time statistics from all registered HybridConnectionManagers
   * to provide network-wide visibility into connection quality.
   * 
   * @returns {Object} Aggregate statistics including:
   *   - totalConnections: Number of active browser-to-browser connections
   *   - totalConnectionTime: Sum of all connection durations
   *   - aggregateRelayTime: Total time spent on relay paths
   *   - aggregateDirectTime: Total time spent on direct paths (WebRTC + IPv6)
   *   - relayPercentage: % of total time on relay
   *   - directPercentage: % of total time on direct
   *   - meetsDirectTarget: Whether 80%+ of time is on direct paths
   *   - perConnection: Array of per-connection stats for detailed analysis
   */
  getAggregatePathStats() {
    const perConnection = [];
    let totalConnectionTime = 0;
    let aggregateRelayTime = 0;
    let aggregateDirectTime = 0;
    let connectionsOnRelay = 0;
    let connectionsOnDirect = 0;
    
    // Iterate through all registered peer managers
    for (const [peerId, manager] of this._peerManagers) {
      // Only include connected managers with path time stats
      if (manager && typeof manager.getPathTimeStats === 'function') {
        try {
          const stats = manager.getPathTimeStats();
          
          // Only include connections that have been established
          if (stats.totalConnectionTime > 0) {
            perConnection.push({
              peerId: peerId.substring(0, 8) + '...',
              totalTime: stats.totalConnectionTime,
              relayTime: stats.aggregate?.relayTime || 0,
              directTime: stats.aggregate?.directTime || 0,
              relayPercentage: stats.aggregate?.relayPercentage || 0,
              directPercentage: stats.aggregate?.directPercentage || 0,
              currentPath: stats.currentPath,
              meetsTarget: stats.aggregate?.meetsDirectTarget || false
            });
            
            totalConnectionTime += stats.totalConnectionTime;
            aggregateRelayTime += stats.aggregate?.relayTime || 0;
            aggregateDirectTime += stats.aggregate?.directTime || 0;
            
            // Count connections by current path type
            if (stats.currentPath === 'websocket_relay') {
              connectionsOnRelay++;
            } else if (stats.currentPath === 'webrtc_direct' || stats.currentPath === 'ipv6_direct') {
              connectionsOnDirect++;
            }
          }
        } catch (error) {
          console.warn(`⚠️ RelayManager: Failed to get path stats for peer ${peerId.substring(0, 8)}: ${error.message}`);
        }
      }
    }
    
    // Calculate aggregate percentages
    const relayPercentage = totalConnectionTime > 0 
      ? Math.round((aggregateRelayTime / totalConnectionTime) * 10000) / 100 
      : 0;
    const directPercentage = totalConnectionTime > 0 
      ? Math.round((aggregateDirectTime / totalConnectionTime) * 10000) / 100 
      : 0;
    
    // Target metric from spec: 80%+ direct connections on desktop networks
    const meetsDirectTarget = totalConnectionTime > 0 && directPercentage >= 80;
    
    const totalConnections = perConnection.length;
    const currentlyOnRelay = connectionsOnRelay;
    const currentlyOnDirect = connectionsOnDirect;
    
    // Calculate current connection distribution
    const currentRelayPercentage = totalConnections > 0 
      ? Math.round((currentlyOnRelay / totalConnections) * 10000) / 100 
      : 0;
    const currentDirectPercentage = totalConnections > 0 
      ? Math.round((currentlyOnDirect / totalConnections) * 10000) / 100 
      : 0;
    
    return {
      // Summary statistics
      totalConnections,
      totalConnectionTime,
      
      // Time-based aggregate (how much time spent on each path type)
      aggregateRelayTime,
      aggregateDirectTime,
      relayPercentage,
      directPercentage,
      meetsDirectTarget,
      
      // Current snapshot (how many connections are currently on each path type)
      currentlyOnRelay,
      currentlyOnDirect,
      currentRelayPercentage,
      currentDirectPercentage,
      
      // Per-connection breakdown for detailed analysis
      perConnection,
      
      // Timestamp for tracking
      timestamp: Date.now()
    };
  }

  /**
   * Get relay metadata for DHT node info
   */
  getRelayMetadata() {
    return {
      canRelay: this._canRelay,
      relayLoad: this._relayLoad,
      relayCapacity: this.options.maxRelaySessions
    };
  }

  // ===========================================
  // CLEANUP
  // ===========================================

  /**
   * Destroy the relay manager
   */
  destroy() {
    console.log('🔄 Destroying RelayManager');
    
    // Stop timers
    if (this._healthCheckTimer) {
      clearInterval(this._healthCheckTimer);
      this._healthCheckTimer = null;
    }
    
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    
    // Clear pending ping timeouts
    for (const [pingId, pendingPing] of this._pendingPings) {
      if (pendingPing.timeout) {
        clearTimeout(pendingPing.timeout);
      }
    }
    this._pendingPings.clear();
    
    // Close all sessions
    for (const sessionId of this._sessions.keys()) {
      this._cleanupSession(sessionId, 'manager_destroyed');
    }
    
    // Clear data structures
    this._sessions.clear();
    this._peerSessions.clear();
    this._relayNodes.clear();
    this._relayHealth.clear();
    
    this.removeAllListeners();
    this.emit('destroyed');
  }
}

/**
 * @typedef {Object} RelaySession
 * @property {string} sessionId - Unique session identifier
 * @property {string} fromPeerId - Initiating peer ID
 * @property {string} toPeerId - Target peer ID
 * @property {string} relayNodeId - Node acting as relay
 * @property {string} relayAddress - WebSocket address of relay node
 * @property {'pending'|'active'|'closing'|'closed'|'failed'} state - Session state
 * @property {number} createdAt - Creation timestamp
 * @property {number} lastActivity - Last activity timestamp
 * @property {number} messagesRelayed - Count of messages relayed
 * @property {number} bytesRelayed - Total bytes relayed
 * @property {number|null} rtt - Round-trip time through relay (ms)
 * @property {boolean} [isRelay] - True if this node is the relay (not an endpoint)
 */

/**
 * @typedef {Object} RelayNodeInfo
 * @property {string} nodeId - Node ID
 * @property {string} publicAddress - Public WebSocket address
 * @property {number} relayLoad - Current load (0-1)
 * @property {number} relayCapacity - Maximum relay sessions
 * @property {number|null} rtt - Round-trip time to this node (ms)
 * @property {number} lastSeen - Last seen timestamp
 */

// Export singleton instance for convenience
export const relayManager = new RelayManager();

export default RelayManager;
