import { DHTNodeId } from '../core/DHTNodeId.js';
import { DHTNode } from '../core/DHTNode.js';
import { KBucket } from '../core/KBucket.js';

/**
 * Kademlia routing table implementation
 */
export class RoutingTable {
  constructor(localNodeId, k = 20) {
    this.localNodeId = localNodeId instanceof DHTNodeId ? localNodeId : DHTNodeId.fromString(localNodeId);
    this.k = k;
    this.buckets = [new KBucket(k, 0, 0)]; // Start with single bucket
    this.totalNodes = 0;
  }

  /**
   * Add a node to the routing table
   */
  addNode(node) {
    if (!(node instanceof DHTNode)) {
      throw new Error('Must provide DHTNode instance');
    }

    // Don't add ourselves
    if (node.id.equals(this.localNodeId)) {
      return false;
    }

    // CRITICAL VALIDATION: Only add nodes that appear to be legitimate peer node IDs
    // Phantom peer detection: reject IDs that look like storage keys or random hashes
    const nodeIdStr = node.id.toString();
    
    // Basic validation - node IDs should be reasonably distributed, not sequential or patterned
    // This is a heuristic check for phantom peers that might be storage key hashes
    if (this.isLikelyPhantomPeer(nodeIdStr)) {
      console.warn(`🚫 Routing table rejecting likely phantom peer: ${nodeIdStr}`);
      return false;
    }

    const bucketIndex = this.getBucketIndex(node.id);
    const bucket = this.buckets[bucketIndex];

    // Try to add to existing bucket
    if (bucket.addNode(node)) {
      if (!bucket.hasNode(node.id)) {
        this.totalNodes++;
      }
      return true;
    }

    // Bucket is full, check if we can split it
    if (this.canSplitBucket(bucketIndex, node.id)) {
      this.splitBucket(bucketIndex);
      return this.addNode(node); // Retry after split
    }

    // Can't split, try to replace least recently seen node
    const leastRecent = bucket.getLeastRecentlySeenNode();
    if (leastRecent && (leastRecent.isStale() || !leastRecent.isAlive)) {
      bucket.removeNode(leastRecent.id);
      this.totalNodes--;
      if (bucket.addNode(node)) {
        this.totalNodes++;
        return true;
      }
    }

    return false; // Could not add node
  }

  /**
   * Remove a node from the routing table
   */
  removeNode(nodeId) {
    const id = nodeId instanceof DHTNodeId ? nodeId : DHTNodeId.fromString(nodeId);
    const bucketIndex = this.getBucketIndex(id);
    const bucket = this.buckets[bucketIndex];

    if (bucket.removeNode(id)) {
      this.totalNodes--;
      return true;
    }
    return false;
  }

  /**
   * Get a node by ID
   */
  getNode(nodeId) {
    const id = nodeId instanceof DHTNodeId ? nodeId : DHTNodeId.fromString(nodeId);
    const bucketIndex = this.getBucketIndex(id);
    return this.buckets[bucketIndex].getNode(id);
  }

  /**
   * Check if routing table contains a node
   */
  hasNode(nodeId) {
    return this.getNode(nodeId) !== undefined;
  }

  /**
   * Heuristic check to detect likely phantom peers (storage keys, random hashes, etc.)
   * Real peer node IDs should come from legitimate peer connections with invitation tokens
   */
  isLikelyPhantomPeer(nodeIdStr) {
    // Keep track of recently rejected phantom peers to detect patterns
    if (!this.recentPhantomPeers) {
      this.recentPhantomPeers = new Map(); // nodeId -> firstSeen timestamp
    }

    // Check if we've seen this exact ID before (phantom peers often repeat)
    if (this.recentPhantomPeers.has(nodeIdStr)) {
      const firstSeen = this.recentPhantomPeers.get(nodeIdStr);
      const age = Date.now() - firstSeen;
      
      // If we've been rejecting this same ID for more than 5 minutes, it's definitely phantom
      if (age > 5 * 60 * 1000) {
        console.warn(`🚨 Persistent phantom peer detected: ${nodeIdStr} (seen for ${Math.round(age/1000)}s)`);
        return true;
      }
    }

    // For now, implement a simple heuristic
    // Real peer node IDs typically come from successful WebRTC connections
    // We can enhance this logic as we identify more phantom peer patterns
    
    // Check if this looks like a storage key hash by examining common patterns
    // This is a basic implementation - we can make it more sophisticated
    
    // Record this as a potential phantom peer
    if (!this.recentPhantomPeers.has(nodeIdStr)) {
      this.recentPhantomPeers.set(nodeIdStr, Date.now());
    }

    // For now, let's log any peer additions to see patterns
    console.log(`🔍 Routing table evaluating peer: ${nodeIdStr}`);
    
    // Clean up old entries (older than 10 minutes)
    const cutoff = Date.now() - (10 * 60 * 1000);
    for (const [id, timestamp] of this.recentPhantomPeers.entries()) {
      if (timestamp < cutoff) {
        this.recentPhantomPeers.delete(id);
      }
    }

    // For now, don't reject any peers - just log and observe
    // We'll enable rejection once we understand the patterns better
    return false;
  }

  /**
   * Find the k closest nodes to a target
   */
  findClosestNodes(targetId, k = this.k) {
    const target = targetId instanceof DHTNodeId ? targetId : DHTNodeId.fromString(targetId);
    const allNodes = [];

    // Collect all nodes from all buckets
    for (const bucket of this.buckets) {
      allNodes.push(...bucket.getNodes());
    }

    // Sort by distance to target
    allNodes.sort((a, b) => {
      const distA = a.id.xorDistance(target);
      const distB = b.id.xorDistance(target);
      return distA.compare(distB);
    });

    return allNodes.slice(0, k);
  }

  /**
   * Get all nodes in the routing table
   */
  getAllNodes() {
    const allNodes = [];
    for (const bucket of this.buckets) {
      allNodes.push(...bucket.getNodes());
    }
    return allNodes;
  }

  /**
   * Get nodes from a specific bucket
   */
  getBucketNodes(bucketIndex) {
    if (bucketIndex >= 0 && bucketIndex < this.buckets.length) {
      return this.buckets[bucketIndex].getNodes();
    }
    return [];
  }

  /**
   * Get the appropriate bucket index for a node ID
   */
  getBucketIndex(nodeId) {
    const distance = this.localNodeId.xorDistance(nodeId);
    const leadingZeros = distance.leadingZeroBits();
    
    // Map to bucket index (160 - leadingZeros - 1)
    let bucketIndex = 159 - leadingZeros;
    
    // Ensure we don't exceed available buckets
    return Math.min(bucketIndex, this.buckets.length - 1);
  }

  /**
   * Check if a bucket can be split
   */
  canSplitBucket(bucketIndex, nodeId) {
    const bucket = this.buckets[bucketIndex];
    
    // Can only split if bucket is full and it's the bucket that contains our local node
    if (!bucket.isFull()) return false;
    
    // Check if this bucket contains our local node's range
    const localBucketIndex = this.getBucketIndex(this.localNodeId);
    return bucketIndex === localBucketIndex && bucket.depth < 159;
  }

  /**
   * Split a bucket into two buckets
   */
  splitBucket(bucketIndex) {
    const bucket = this.buckets[bucketIndex];
    const { leftBucket, rightBucket } = bucket.split();
    
    // Replace the old bucket with the two new buckets
    this.buckets.splice(bucketIndex, 1, leftBucket, rightBucket);
    
    // Update total node count (should remain the same)
    this.totalNodes = this.buckets.reduce((sum, b) => sum + b.size(), 0);
  }

  /**
   * Remove stale nodes from all buckets
   */
  removeStaleNodes(maxAge = 15 * 60 * 1000) {
    let totalRemoved = 0;
    
    for (const bucket of this.buckets) {
      const removed = bucket.removeStaleNodes(maxAge);
      totalRemoved += removed;
    }
    
    this.totalNodes -= totalRemoved;
    return totalRemoved;
  }

  /**
   * Get nodes that need to be pinged
   */
  getNodesToPing(pingInterval = 5 * 60 * 1000) {
    const nodesToPing = [];
    
    for (const bucket of this.buckets) {
      for (const node of bucket.getNodes()) {
        if (node.needsPing(pingInterval)) {
          nodesToPing.push(node);
        }
      }
    }
    
    return nodesToPing;
  }

  /**
   * Get bucket for refresh (least recently updated)
   */
  getBucketForRefresh() {
    if (this.buckets.length === 0) return null;
    
    return this.buckets.reduce((oldest, current) => 
      current.lastUpdated < oldest.lastUpdated ? current : oldest
    );
  }

  /**
   * Get routing table statistics
   */
  getStats() {
    const bucketStats = this.buckets.map((bucket, index) => bucket.getStats());
    const allNodes = this.getAllNodes();
    
    return {
      totalNodes: this.totalNodes,
      totalBuckets: this.buckets.length,
      averageNodesPerBucket: this.totalNodes / this.buckets.length,
      connectedNodes: allNodes.filter(n => n.isConnected()).length,
      aliveNodes: allNodes.filter(n => n.isAlive).length,
      staleNodes: allNodes.filter(n => n.isStale()).length,
      buckets: bucketStats,
      k: this.k,
      localNodeId: this.localNodeId.toString()
    };
  }

  /**
   * Validate routing table consistency
   */
  validate() {
    const issues = [];
    let calculatedTotal = 0;
    
    for (let i = 0; i < this.buckets.length; i++) {
      const bucket = this.buckets[i];
      calculatedTotal += bucket.size();
      
      // Check bucket depth consistency
      if (i > 0 && bucket.depth <= this.buckets[i-1].depth) {
        issues.push(`Bucket ${i} depth inconsistency`);
      }
      
      // Check for duplicate nodes within bucket
      const nodeIds = new Set();
      for (const node of bucket.getNodes()) {
        if (nodeIds.has(node.id.toString())) {
          issues.push(`Duplicate node in bucket ${i}: ${node.id.toString()}`);
        }
        nodeIds.add(node.id.toString());
      }
    }
    
    // Check total node count
    if (calculatedTotal !== this.totalNodes) {
      issues.push(`Total node count mismatch: ${calculatedTotal} vs ${this.totalNodes}`);
    }
    
    return {
      valid: issues.length === 0,
      issues: issues
    };
  }

  /**
   * Convert to JSON representation
   */
  toJSON() {
    return {
      localNodeId: this.localNodeId.toString(),
      k: this.k,
      totalNodes: this.totalNodes,
      buckets: this.buckets.map(bucket => bucket.toJSON()),
      stats: this.getStats()
    };
  }
}