// import { DHTNodeId } from './DHTNodeId.js';

/**
 * Represents a K-bucket in the Kademlia routing table
 */
export class KBucket {
  constructor(k = 20, prefix = 0, depth = 0) {
    this.k = k; // Maximum number of nodes in bucket
    this.prefix = prefix; // Binary prefix for this bucket
    this.depth = depth; // Depth in the binary tree
    this.nodes = []; // Array of DHTNode objects
    this.replacementCache = []; // Secondary storage for overflow nodes
    this.lastUpdated = Date.now();
  }

  /**
   * Add a node to this bucket
   */
  addNode(node) {
    const existingIndex = this.nodes.findIndex(n => n.id.equals(node.id));

    if (existingIndex !== -1) {
      // Node already exists, move to end (most recently seen)
      const existingNode = this.nodes.splice(existingIndex, 1)[0];
      existingNode.lastSeen = Date.now();
      this.nodes.push(existingNode);
      this.lastUpdated = Date.now();
      return true;
    }

    if (this.nodes.length < this.k) {
      // Bucket has space, add the node
      node.lastSeen = Date.now();
      this.nodes.push(node);
      this.lastUpdated = Date.now();
      return true;
    }

    // Bucket is full - add to replacement cache
    return this.addToReplacementCache(node);
  }

  /**
   * Add a node to the replacement cache (LRU eviction when full)
   * @param {DHTNode} node - Node to add to cache
   * @returns {boolean} - Always returns true (node is cached)
   */
  addToReplacementCache(node) {
    const existingIndex = this.replacementCache.findIndex(n => n.id.equals(node.id));

    if (existingIndex !== -1) {
      // Move to end (most recently seen) - LRU ordering
      const existing = this.replacementCache.splice(existingIndex, 1)[0];
      existing.lastSeen = Date.now();
      this.replacementCache.push(existing);
      return true;
    }

    if (this.replacementCache.length < this.k) {
      node.lastSeen = Date.now();
      this.replacementCache.push(node);
      return true;
    }

    // Cache full - evict oldest (LRU eviction)
    this.replacementCache.shift();
    node.lastSeen = Date.now();
    this.replacementCache.push(node);
    return true;
  }

  /**
   * Get a copy of the replacement cache
   * @returns {DHTNode[]} - Copy of replacement cache array
   */
  getReplacementCache() {
    return [...this.replacementCache];
  }

  /**
   * Get the size of the replacement cache
   * @returns {number} - Number of nodes in replacement cache
   */
  replacementCacheSize() {
    return this.replacementCache.length;
  }

  /**
   * Promote the most recently seen node from replacement cache to main bucket
   * @returns {DHTNode|null} - The promoted node, or null if cache is empty
   */
  promoteFromReplacementCache() {
    if (this.replacementCache.length === 0) {
      return null;
    }

    // Promote most recently seen node (last in array due to LRU ordering)
    const promoted = this.replacementCache.pop();
    promoted.lastSeen = Date.now();
    this.nodes.push(promoted);
    this.lastUpdated = Date.now();
    return promoted;
  }

  /**
   * Handle node failure by removing it and promoting from replacement cache
   * @param {DHTNodeId} nodeId - ID of the failed node
   * @returns {boolean} - True if node was found and removed
   */
  handleNodeFailure(nodeId) {
    const index = this.nodes.findIndex(n => n.id.equals(nodeId));
    if (index === -1) {
      return false;
    }

    this.nodes.splice(index, 1);
    const promoted = this.promoteFromReplacementCache();

    if (promoted) {
      console.log(`📋 Promoted ${promoted.id.toString().substring(0, 8)}... from replacement cache`);
    }

    this.lastUpdated = Date.now();
    return true;
  }

  /**
   * Remove a node from this bucket
   */
  removeNode(nodeId) {
    const index = this.nodes.findIndex(n => n.id.equals(nodeId));
    if (index !== -1) {
      this.nodes.splice(index, 1);
      this.lastUpdated = Date.now();
      return true;
    }
    return false;
  }

  /**
   * Get a node by ID
   */
  getNode(nodeId) {
    return this.nodes.find(n => n.id.equals(nodeId));
  }

  /**
   * Check if bucket contains a node
   */
  hasNode(nodeId) {
    return this.nodes.some(n => n.id.equals(nodeId));
  }

  /**
   * Get all nodes in this bucket
   */
  getNodes() {
    return [...this.nodes];
  }

  /**
   * Get the least recently seen node
   */
  getLeastRecentlySeenNode() {
    if (this.nodes.length === 0) return null;

    return this.nodes.reduce((oldest, current) =>
      current.lastSeen < oldest.lastSeen ? current : oldest
    );
  }

  /**
   * Get nodes ordered by last seen (most recent first)
   */
  getNodesByLastSeen() {
    return [...this.nodes].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /**
   * Check if bucket is full
   */
  isFull() {
    return this.nodes.length >= this.k;
  }

  /**
   * Check if bucket is empty
   */
  isEmpty() {
    return this.nodes.length === 0;
  }

  /**
   * Get bucket size
   */
  size() {
    return this.nodes.length;
  }

  /**
   * Split this bucket into two buckets
   */
  split() {
    const newDepth = this.depth + 1;
    const leftBucket = new KBucket(this.k, this.prefix << 1, newDepth);
    const rightBucket = new KBucket(this.k, (this.prefix << 1) | 1, newDepth);

    // Redistribute nodes
    for (const node of this.nodes) {
      const bit = node.id.getBit(this.depth);
      if (bit === 0) {
        leftBucket.nodes.push(node);
      } else {
        rightBucket.nodes.push(node);
      }
    }

    leftBucket.lastUpdated = this.lastUpdated;
    rightBucket.lastUpdated = this.lastUpdated;

    return { leftBucket, rightBucket };
  }

  /**
   * Check if a node ID belongs in this bucket
   */
  canContain(nodeId, targetId) {
    // Check if the XOR distance puts this node in our bucket range
    const distance = targetId.xorDistance(nodeId);
    const leadingZeros = distance.leadingZeroBits();

    return leadingZeros >= this.depth &&
           (this.depth === 0 || leadingZeros < this.depth + 1);
  }

  /**
   * Remove stale nodes (older than threshold)
   * @param {number} maxAge - Maximum age in ms before a node is considered stale (default 15 minutes)
   * @param {Set<string>|null} connectedPeerIds - Optional set of currently connected peer IDs for connection-based stale detection
   * @returns {number} - Number of nodes removed
   */
  removeStaleNodes(maxAge = 15 * 60 * 1000, connectedPeerIds = null) { // 15 minutes default
    const now = Date.now();
    const originalLength = this.nodes.length;

    this.nodes = this.nodes.filter(node => {
      const nodeIdStr = node.id.toString();
      const age = now - node.lastSeen;
      const isStaleByAge = age >= maxAge;
      
      // If we have connection info, also check if disconnected peers are stale
      if (connectedPeerIds !== null) {
        const isConnected = connectedPeerIds.has(nodeIdStr);
        
        // Remove if: stale by age AND not connected
        // This ensures we don't remove actively connected peers even if lastSeen is old
        // But we DO remove disconnected peers that are also stale by age
        if (isStaleByAge && !isConnected) {
          return false; // Remove this node
        }
        
        // Keep connected peers regardless of age
        // Keep non-stale peers regardless of connection status
        return true;
      }
      
      // No connection info - use age-based removal only (original behavior)
      return !isStaleByAge;
    });

    if (this.nodes.length !== originalLength) {
      this.lastUpdated = now;
    }

    return originalLength - this.nodes.length; // Number removed
  }

  /**
   * Get bucket statistics
   */
  getStats() {
    // const now = Date.now();
    return {
      size: this.nodes.length,
      capacity: this.k,
      depth: this.depth,
      prefix: this.prefix.toString(2).padStart(this.depth, '0'),
      lastUpdated: this.lastUpdated,
      avgLastSeen: this.nodes.length > 0 ?
        this.nodes.reduce((sum, node) => sum + node.lastSeen, 0) / this.nodes.length : 0,
      oldestNode: this.nodes.length > 0 ?
        Math.min(...this.nodes.map(n => n.lastSeen)) : null,
      newestNode: this.nodes.length > 0 ?
        Math.max(...this.nodes.map(n => n.lastSeen)) : null
    };
  }

  /**
   * Convert to JSON representation
   */
  toJSON() {
    return {
      k: this.k,
      prefix: this.prefix,
      depth: this.depth,
      lastUpdated: this.lastUpdated,
      nodes: this.nodes.map(node => ({
        id: node.id.toString(),
        lastSeen: node.lastSeen,
        endpoint: node.endpoint
      }))
    };
  }
}