import { DHTNodeId } from './DHTNodeId.js';

/**
 * Represents a node in the DHT network
 */
export class DHTNode {
  constructor(id, endpoint = null, connection = null) {
    // CRITICAL FIX: Prevent double-hashing phantom peers
    // DHTNode should ONLY contain actual peer node IDs, never hash them again
    if (id instanceof DHTNodeId) {
      this.id = id;
    } else if (typeof id === 'string' && /^[0-9a-f]{40}$/i.test(id)) {
      // 40-character hex string - this is already a node ID, use fromHex() to avoid double-hashing
      this.id = DHTNodeId.fromHex(id);
    } else {
      throw new Error(`DHTNode requires a valid node ID. Got: ${id}. Use DHTNodeId.fromHex() for existing node IDs.`);
    }
    this.endpoint = endpoint; // WebRTC connection info or identifier
    this.connection = connection; // Active WebRTC connection object
    this.lastSeen = Date.now();
    this.lastPing = 0;
    this.rtt = 0; // Round trip time in ms
    this.failureCount = 0;
    this.isAlive = true;
    this.capabilities = new Set(); // Set of supported capabilities
    this.metadata = {}; // Additional node metadata
  }

  /**
   * Create DHTNode from connection info
   */
  static fromConnection(connectionInfo) {
    return new DHTNode(
      connectionInfo.id,
      connectionInfo.endpoint,
      connectionInfo.connection
    );
  }

  /**
   * Update the last seen timestamp
   */
  updateLastSeen() {
    this.lastSeen = Date.now();
    this.isAlive = true;
    this.failureCount = 0;
  }

  /**
   * Record a ping response
   */
  recordPing(rtt) {
    this.lastPing = Date.now();
    this.rtt = rtt;
    this.updateLastSeen();
  }

  /**
   * Record a failure
   */
  recordFailure() {
    this.failureCount++;
    if (this.failureCount >= 3) {
      this.isAlive = false;
    }
  }

  /**
   * Check if node should be considered stale
   */
  isStale(maxAge = 15 * 60 * 1000) { // 15 minutes default
    return (Date.now() - this.lastSeen) > maxAge;
  }

  /**
   * Check if node needs to be pinged
   */
  needsPing(pingInterval = 5 * 60 * 1000) { // 5 minutes default
    return (Date.now() - this.lastPing) > pingInterval;
  }

  /**
   * Get connection state
   */
  getConnectionState() {
    if (!this.connection) return 'disconnected';
    
    if (this.connection.readyState !== undefined) {
      // WebRTC DataChannel
      return this.connection.readyState;
    }
    
    if (this.connection.connectionState !== undefined) {
      // WebRTC PeerConnection
      return this.connection.connectionState;
    }
    
    return 'unknown';
  }

  /**
   * Check if node is connected
   */
  isConnected() {
    const state = this.getConnectionState();
    return state === 'open' || state === 'connected';
  }

  /**
   * Add a capability
   */
  addCapability(capability) {
    this.capabilities.add(capability);
  }

  /**
   * Remove a capability
   */
  removeCapability(capability) {
    this.capabilities.delete(capability);
  }

  /**
   * Check if node has a capability
   */
  hasCapability(capability) {
    return this.capabilities.has(capability);
  }

  /**
   * Set metadata
   */
  setMetadata(key, value) {
    this.metadata[key] = value;
  }

  /**
   * Get metadata
   */
  getMetadata(key) {
    return this.metadata[key];
  }

  /**
   * Calculate distance to another node
   */
  distanceTo(otherId) {
    const otherNodeId = otherId instanceof DHTNodeId ? otherId : DHTNodeId.fromHex(otherId);
    return this.id.xorDistance(otherNodeId);
  }

  /**
   * Compare distance to target with another node
   */
  isCloserTo(target, otherNode) {
    const targetId = target instanceof DHTNodeId ? target : DHTNodeId.fromHex(target);
    const myDistance = this.id.xorDistance(targetId);
    const otherDistance = otherNode.id.xorDistance(targetId);
    return myDistance.compare(otherDistance) < 0;
  }

  /**
   * Get node quality score (higher is better)
   */
  getQualityScore() {
    let score = 100;
    
    // Penalize for failures
    score -= this.failureCount * 10;
    
    // Penalize for high RTT
    if (this.rtt > 0) {
      score -= Math.min(this.rtt / 10, 50); // Max 50 point penalty
    }
    
    // Penalize for being offline
    if (!this.isAlive) {
      score -= 50;
    }
    
    // Penalize for being stale
    const age = Date.now() - this.lastSeen;
    score -= Math.min(age / (60 * 1000), 30); // Max 30 point penalty for age
    
    // Bonus for being connected
    if (this.isConnected()) {
      score += 20;
    }
    
    return Math.max(score, 0);
  }

  /**
   * Create a compact representation for network transmission
   */
  toCompact() {
    return {
      id: this.id.toString(),
      endpoint: this.endpoint,
      lastSeen: this.lastSeen,
      capabilities: Array.from(this.capabilities),
      metadata: this.metadata
    };
  }

  /**
   * Create DHTNode from compact representation
   */
  static fromCompact(compact) {
    const node = new DHTNode(compact.id, compact.endpoint);
    node.lastSeen = compact.lastSeen || Date.now();
    node.capabilities = new Set(compact.capabilities || []);
    node.metadata = compact.metadata || {};
    return node;
  }

  /**
   * Convert to JSON representation
   */
  toJSON() {
    return {
      id: this.id.toString(),
      endpoint: this.endpoint,
      lastSeen: this.lastSeen,
      lastPing: this.lastPing,
      rtt: this.rtt,
      failureCount: this.failureCount,
      isAlive: this.isAlive,
      connectionState: this.getConnectionState(),
      qualityScore: this.getQualityScore(),
      capabilities: Array.from(this.capabilities),
      metadata: this.metadata
    };
  }

  /**
   * String representation
   */
  toString() {
    return `DHTNode(${this.id.toString().substr(0, 8)}..., ${this.getConnectionState()})`;
  }
}