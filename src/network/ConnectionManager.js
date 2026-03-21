import { EventEmitter } from 'events';
import Logger from '../utils/Logger.js';

/**
 * Abstract base class for connection management
 * Handles protocol messages and peer management, delegates transport to subclasses
 */
export class ConnectionManager extends EventEmitter {
  constructor(options = {}) {
    super();

    this.options = {
      maxConnections: options.maxConnections || 50,
      timeout: options.timeout || 45000, // Increased from 30s to 45s for better WebRTC reliability
      ...options
    };

    // REFACTORED: Single connection per manager (per-node architecture)
    // Each ConnectionManager instance manages exactly ONE connection to ONE peer
    this.peerId = null; // The peer this manager connects to
    this.connection = null; // Single connection object (not a Map)
    this.connectionState = 'disconnected'; // Connection state
    // NOTE: Peer metadata now stored on DHTNode.metadata, not in connection manager

    // Store routing table reference for inactive tab filtering
    this.routingTable = options.routingTable || null;

    // Message handling (keep queue structure for the single peer)
    this.pendingRequests = new Map(); // requestId -> { resolve, reject, timeout }
    this.messageQueue = []; // Array of messages for the single peer
    this.messageProcessing = false; // Flag for the single peer

    this.isDestroyed = false;
    this.localNodeId = null;
  }

  /**
   * Initialize the connection manager
   */
  initialize(localNodeId) {
    if (this.localNodeId) {
      console.warn('ConnectionManager already initialized');
      return;
    }

    this.localNodeId = localNodeId;
    console.log(`🔗 ${this.constructor.name} initialized with node ID: ${localNodeId}`);
    this.emit('initialized', { localNodeId });
  }

  // ===========================================
  // ABSTRACT METHODS - Must be implemented by subclasses
  // ===========================================

  /**
   * Create connection to peer (transport-specific)
   * @param {string} peerId - Target peer ID
   * @param {boolean} initiator - Whether we're initiating the connection
   * @returns {Promise<void>}
   */
  async createConnection(peerId, initiator = true) {
    throw new Error('createConnection() must be implemented by subclass');
  }

  /**
   * Send raw message to peer (transport-specific)
   * @param {string} peerId - Target peer ID
   * @param {Object} message - Message to send
   * @returns {Promise<void>}
   */
  async sendRawMessage(peerId, message) {
    throw new Error('sendRawMessage() must be implemented by subclass');
  }

  /**
   * Check if connected (no peerId needed - manager handles single peer)
   * @returns {boolean}
   */
  isConnected() {
    throw new Error('isConnected() must be implemented by subclass');
  }

  /**
   * Destroy connection to peer (transport-specific)
   * @param {string} peerId - Peer ID
   * @param {string} reason - Reason for destruction
   */
  destroyConnection(peerId, reason = 'manual') {
    throw new Error('destroyConnection() must be implemented by subclass');
  }

  /**
   * Handle invitation from peer - determines who initiates connection
   * Transport-specific logic for handling connection direction
   * @param {string} peerId - Inviter peer ID
   * @param {Object} peerMetadata - Inviter's connection metadata
   * @returns {Promise<void>}
   */
  async handleInvitation(peerId, peerMetadata) {
    // Default: wait for inviter to connect
    // Subclasses override to implement transport-specific logic
    console.log(`⏳ Waiting for connection from ${peerId.substring(0, 8)}...`);
  }

  // ===========================================
  // PROTOCOL MESSAGE HANDLING (Implemented in base class)
  // ===========================================

  /**
   * Send protocol message to peer with automatic queuing and request tracking
   */
  async sendMessage(peerId, message) {
    if (this.isDestroyed) {
      throw new Error('ConnectionManager is destroyed');
    }

    // REFACTORED: isConnected() no longer takes peerId parameter (single-connection architecture)
    // Each manager handles exactly one peer, so we just check if the connection is open
    if (!this.isConnected()) {
      throw new Error(`No connection to peer ${peerId}`);
    }

    // Add protocol metadata
    const protocolMessage = {
      ...message,
      from: this.localNodeId,
      timestamp: Date.now()
    };

    try {
      await this.sendRawMessage(peerId, protocolMessage);
      return true;
    } catch (error) {
      console.error(`Failed to send message to ${peerId}:`, error);
      throw error;
    }
  }

  /**
   * Send request and wait for response
   */
  async sendRequest(peerId, message, timeout = 10000) {
    if (!message.requestId) {
      message.requestId = this.generateRequestId();
    }

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(message.requestId);
        reject(new Error(`Request ${message.type} to ${peerId} timed out after ${timeout}ms`));
      }, timeout);

      this.pendingRequests.set(message.requestId, {
        resolve,
        reject,
        timeout: timeoutHandle,
        peerId
      });

      this.sendMessage(peerId, message).catch(error => {
        clearTimeout(timeoutHandle);
        this.pendingRequests.delete(message.requestId);
        reject(error);
      });
    });
  }

  /**
   * Handle incoming protocol message
   */
  handleMessage(peerId, message) {
    // Guard against destroyed managers - silently drop messages
    if (this.isDestroyed) {
      return;
    }
    
    try {
      // NOTE: Peer activity tracking moved to DHTNode.updateLastSeen()

      // Handle responses to pending requests
      if (message.requestId && this.pendingRequests.has(message.requestId)) {
        const pendingRequest = this.pendingRequests.get(message.requestId);
        clearTimeout(pendingRequest.timeout);
        this.pendingRequests.delete(message.requestId);

        if (message.type.endsWith('_response') || message.type === 'pong') {
          pendingRequest.resolve(message);
        } else {
          pendingRequest.reject(new Error(`Unexpected response type: ${message.type}`));
        }
        return;
      }
      
      // NOTE: Pong messages that don't match ConnectionManager.pendingRequests are expected
      // when using the unified ping system (KademliaDHT.pingPeer). The pong will be matched
      // in KademliaDHT.handlePong() via the dhtMessage event below.

      // Route protocol messages to appropriate handlers
      switch (message.type) {
        case 'ping':
          this.handlePing(peerId, message);
          break;
        case 'pong':
          // CRITICAL FIX: Also emit dhtMessage for pong so KademliaDHT can resolve pending requests
          // ConnectionManager.handlePong just logs RTT, but KademliaDHT.handlePong resolves pendingRequests
          this.handlePong(peerId, message);
          this.emit('dhtMessage', { peerId, message, sourceManager: this });
          break;
        case 'find_node':
        case 'find_value':
        case 'store':
        case 'find_node_response':
        case 'find_value_response':
        case 'store_response':
        case 'peer_discovery_request':
        case 'peer_discovery_response':
        case 'connection_request':
        case 'connection_response':
        case 'connection_offer':
        case 'connection_answer':
        case 'connection_candidate':
        case 'create_invitation_for_peer':
        case 'forward_invitation':
        case 'overlay_routed_message': {
          // Emit to DHT for handling - include manager reference for response routing
          const listenerCount = this.listenerCount('dhtMessage');
          if (listenerCount === 0) {
            console.warn(`⚠️ NO DHT MESSAGE LISTENERS: ${message.type} from ${peerId.substring(0, 8)}... will NOT be processed`);
          }
          this.emit('dhtMessage', { peerId, message, sourceManager: this });
          break;
        }
        case 'connect_genesis_peer':
        case 'validate_reconnection':
        case 'invitation_for_bridge':
        case 'get_onboarding_peer':
          // Bootstrap server messages - emit to bridge handler
          this.emit('message', { peerId, message });
          break;
        default:
          console.warn(`Unknown message type from ${peerId}: ${message.type}`);
          this.emit('message', { peerId, message });
      }

      // Also emit 'data' event for compatibility with existing DHT and OverlayNetwork code
      this.emit('data', { peerId, data: message });

    } catch (error) {
      console.error(`Error handling message from ${peerId}:`, error);
    }
  }

  /**
   * Handle ping message
   */
  async handlePing(peerId, message) {
    // Guard against destroyed managers - don't try to respond
    if (this.isDestroyed) {
      Logger.trace(`⏭️ Ignoring ping from ${peerId.substring(0, 8)}... - manager is destroyed`);
      return;
    }
    
    try {
      Logger.trace(`🏓 Handling ping from ${peerId.substring(0, 8)}... (requestId: ${message.requestId})`);
      await this.sendMessage(peerId, {
        type: 'pong',
        requestId: message.requestId,
        timestamp: Date.now(),
        originalTimestamp: message.timestamp
      });
      Logger.trace(`✅ Sent pong to ${peerId.substring(0, 8)}...`);
    } catch (error) {
      // Only log if not a destroyed manager error (expected during cleanup)
      if (!error.message.includes('destroyed')) {
        console.error(`❌ Failed to send pong to ${peerId.substring(0, 8)}...: ${error.message}`);
      }
    }
  }

  /**
   * Handle pong message
   */
  handlePong(peerId, message) {
    const rtt = Date.now() - (message.originalTimestamp || message.timestamp);
    Logger.trace(`📡 Received pong from ${peerId.substring(0, 8)}... (RTT: ${rtt}ms)`);
    this.emit('pong', { peerId, rtt, message });
  }

  /**
   * Verify DHT message handler is attached and emit event if not
   * Used to detect and recover from detached handlers after OOM restart
   * @returns {boolean} true if handler is attached, false if detached
   */
  ensureDHTMessageHandler() {
    const listenerCount = this.listenerCount('dhtMessage');
    const flaggedAsAttached = this._dhtMessageHandlerAttached || false;
    
    if (listenerCount === 0) {
      console.warn(`⚠️ DHT message handler detached on ${this.constructor.name} for peer ${this.peerId?.substring(0, 8) || 'unknown'}`);
      console.warn(`   Flag says attached: ${flaggedAsAttached}, Actual listeners: ${listenerCount}`);
      
      // Reset the stale flag since there are no actual listeners
      if (flaggedAsAttached) {
        this._dhtMessageHandlerAttached = false;
        console.warn(`   Reset stale _dhtMessageHandlerAttached flag to false`);
      }
      
      // Emit event to allow DHT to reattach handler
      this.emit('handlerDetached', { manager: this, peerId: this.peerId });
      return false;
    }
    
    return true;
  }

  /**
   * Send ping to peer
   */
  async ping(peerId) {
    // CRITICAL FIX: Skip pinging inactive browser tabs to prevent high latency
    if (this.routingTable && peerId) {
      const peerNode = this.routingTable.getNode(peerId);
      if (peerNode?.metadata?.nodeType === 'browser' && peerNode.metadata?.tabVisible === false) {
        Logger.debug(`⏭️ [Ping] Skipping ping to inactive browser tab ${peerId.substring(0, 8)}... (would cause high latency)`);
        return { success: false, error: 'Inactive browser tab - skipped to prevent high latency' };
      }
    }

    try {
      // DIAGNOSTIC: Log which manager is sending the ping
      const managerId = this._managerId || (this._managerId = Math.random().toString(36).substr(2, 6));
      const requestId = this.generateRequestId();
      
      console.log(`🏓 PING_SEND: manager=${managerId} peerId=${peerId?.substring(0, 8)} requestId=${requestId} pendingBefore=${this.pendingRequests.size}`);
      
      const response = await this.sendRequest(peerId, {
        type: 'ping',
        timestamp: Date.now(),
        requestId: requestId
      }, 5000);

      const rtt = Date.now() - response.originalTimestamp;
      console.log(`🏓 PING_SUCCESS: manager=${managerId} peerId=${peerId?.substring(0, 8)} rtt=${rtt}ms`);
      return { success: true, rtt };
    } catch (error) {
      const managerId = this._managerId || 'unknown';
      console.log(`🏓 PING_FAIL: manager=${managerId} peerId=${peerId?.substring(0, 8)} error=${error.message}`);
      return { success: false, error: error.message };
    }
  }

  // ===========================================
  // PEER MANAGEMENT (Implemented in base class)
  // ===========================================
  // NOTE: Peer metadata now stored on DHTNode instances via node.setMetadata()
  // Connection managers no longer maintain peer metadata

  /**
   * Get connected peer ID (single connection architecture)
   * Returns array for API compatibility (will contain 0 or 1 peer)
   */
  getConnectedPeers() {
    if (this.peerId && this.isConnected()) {
      return [this.peerId];
    }
    return [];
  }

  /**
   * Get connection statistics
   */
  getStats() {
    const connected = this.getConnectedPeers();
    return {
      type: this.constructor.name,
      total: connected.length,
      connected: connected.length,
      maxConnections: this.options.maxConnections,
      utilization: (connected.length / this.options.maxConnections * 100).toFixed(1) + '%'
    };
  }

  // ===========================================
  // OVERLAY NETWORK COMPATIBILITY
  // ===========================================

  /**
   * Send data message to peer (alias for sendMessage for OverlayNetwork compatibility)
   */
  async sendData(peerId, data) {
    return this.sendMessage(peerId, data);
  }

  /**
   * Get peers map (for OverlayNetwork compatibility)
   * Returns a Map with single connection (or empty if not connected)
   */
  get peers() {
    const map = new Map();
    if (this.peerId && this.connection) {
      map.set(this.peerId, this.connection);
    }
    return map;
  }

  // ===========================================
  // UTILITY METHODS
  // ===========================================

  /**
   * Generate unique request ID
   */
  generateRequestId() {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Clean up stale connection (single connection architecture)
   * NOTE: Staleness is now tracked on DHTNode instances, not in connection manager
   */
  cleanupStaleConnections(maxAge = 300000) { // 5 minutes default
    // This method is deprecated - staleness tracking moved to DHTNode
    // Kept for API compatibility but does nothing
    return 0;
  }

  /**
   * Destroy connection and cleanup (single connection architecture)
   */
  destroy() {
    if (this.isDestroyed) return;

    console.log(`🔗 Destroying ${this.constructor.name}`);
    this.isDestroyed = true;

    // Cancel all pending requests
    for (const [requestId, request] of this.pendingRequests.entries()) {
      clearTimeout(request.timeout);
      request.reject(new Error('ConnectionManager destroyed'));
    }
    this.pendingRequests.clear();

    // Clean up single connection (subclass responsibility)
    if (this.peerId) {
      this.destroyConnection(this.peerId, 'manager_destroyed');
    }

    // Clear data structures
    this.connection = null;
    this.connectionState = 'disconnected';
    this.messageQueue = [];
    this.messageProcessing = false;
    this.peerId = null;

    this.removeAllListeners();
    this.emit('destroyed');
  }
}