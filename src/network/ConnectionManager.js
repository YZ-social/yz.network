import { EventEmitter } from 'events';

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

    // Core peer management
    this.connections = new Map(); // peerId -> connection object
    this.connectionStates = new Map(); // peerId -> connection state
    this.peerMetadata = new Map(); // peerId -> metadata

    // Message handling
    this.pendingRequests = new Map(); // requestId -> { resolve, reject, timeout }
    this.messageQueues = new Map(); // peerId -> Array<message>
    this.messageProcessingFlags = new Map(); // peerId -> boolean

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
   * Check if peer is connected (transport-specific)
   * @param {string} peerId - Peer ID to check
   * @returns {boolean}
   */
  isConnected(peerId) {
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

    if (!this.isConnected(peerId)) {
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
    try {
      // Update peer metadata
      this.updatePeerActivity(peerId);

      // Handle responses to pending requests
      if (message.requestId && this.pendingRequests.has(message.requestId)) {
        const pendingRequest = this.pendingRequests.get(message.requestId);
        clearTimeout(pendingRequest.timeout);
        this.pendingRequests.delete(message.requestId);

        if (message.type.endsWith('_response')) {
          pendingRequest.resolve(message);
        } else {
          pendingRequest.reject(new Error(`Unexpected response type: ${message.type}`));
        }
        return;
      }

      // Route protocol messages to appropriate handlers
      switch (message.type) {
        case 'ping':
          this.handlePing(peerId, message);
          break;
        case 'pong':
          this.handlePong(peerId, message);
          break;
        case 'find_node':
        case 'find_value':
        case 'store':
        case 'find_node_response':
        case 'find_value_response':
        case 'store_response':
        case 'peer_discovery_request':
        case 'peer_discovery_response':
        case 'connection_offer':
        case 'connection_answer':
        case 'connection_candidate':
        case 'create_invitation_for_peer':
        case 'forward_invitation':
          // Emit to DHT for handling
          this.emit('dhtMessage', { peerId, message });
          break;
        case 'connect_genesis_peer':
        case 'validate_reconnection':
        case 'invitation_for_bridge':
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
    try {
      await this.sendMessage(peerId, {
        type: 'pong',
        requestId: message.requestId,
        timestamp: Date.now(),
        originalTimestamp: message.timestamp
      });
    } catch (error) {
      console.error(`Failed to send pong to ${peerId}:`, error);
    }
  }

  /**
   * Handle pong message
   */
  handlePong(peerId, message) {
    const rtt = Date.now() - (message.originalTimestamp || message.timestamp);
    console.log(`📡 Received pong from ${peerId.substring(0, 8)}... (RTT: ${rtt}ms)`);
    this.emit('pong', { peerId, rtt, message });
  }

  /**
   * Send ping to peer
   */
  async ping(peerId) {
    try {
      const response = await this.sendRequest(peerId, {
        type: 'ping',
        timestamp: Date.now()
      }, 5000);

      const rtt = Date.now() - response.originalTimestamp;
      return { success: true, rtt };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // ===========================================
  // PEER MANAGEMENT (Implemented in base class)
  // ===========================================

  /**
   * Set metadata for a peer
   */
  setPeerMetadata(peerId, metadata) {
    this.peerMetadata.set(peerId, { ...metadata, lastUpdated: Date.now() });
    console.log(`📋 Updated metadata for ${peerId.substring(0, 8)}...:`, metadata);
  }

  /**
   * Get metadata for a peer
   */
  getPeerMetadata(peerId) {
    return this.peerMetadata.get(peerId);
  }

  /**
   * Update peer activity timestamp
   */
  updatePeerActivity(peerId) {
    const metadata = this.peerMetadata.get(peerId) || {};
    metadata.lastActivity = Date.now();
    this.peerMetadata.set(peerId, metadata);
  }

  /**
   * Get all connected peer IDs
   */
  getConnectedPeers() {
    const connected = [];
    for (const [peerId] of this.connections.entries()) {
      if (this.isConnected(peerId)) {
        connected.push(peerId);
      }
    }
    return connected;
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
   * Returns a Map where value is the connection object
   */
  get peers() {
    return this.connections;
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
   * Clean up stale connections
   */
  cleanupStaleConnections(maxAge = 300000) { // 5 minutes default
    const now = Date.now();
    let cleaned = 0;

    for (const [peerId, metadata] of this.peerMetadata.entries()) {
      const lastActivity = metadata.lastActivity || metadata.lastUpdated || 0;
      if (now - lastActivity > maxAge && this.isConnected(peerId)) {
        console.log(`🧹 Cleaning up stale connection to ${peerId.substring(0, 8)}...`);
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

    console.log(`🔗 Destroying ${this.constructor.name}`);
    this.isDestroyed = true;

    // Cancel all pending requests
    for (const [requestId, request] of this.pendingRequests.entries()) {
      clearTimeout(request.timeout);
      request.reject(new Error('ConnectionManager destroyed'));
    }
    this.pendingRequests.clear();

    // Clean up all connections (subclass responsibility)
    const peerIds = Array.from(this.connections.keys());
    for (const peerId of peerIds) {
      this.destroyConnection(peerId, 'manager_destroyed');
    }

    // Clear data structures
    this.connections.clear();
    this.connectionStates.clear();
    this.peerMetadata.clear();
    this.messageQueues.clear();
    this.messageProcessingFlags.clear();

    this.removeAllListeners();
    this.emit('destroyed');
  }
}