import { DHTNodeId } from '../core/DHTNodeId.js';
import { DHTNode } from '../core/DHTNode.js';
import { KBucket } from '../core/KBucket.js';
import { ConnectionManagerFactory } from '../network/ConnectionManagerFactory.js';

/**
 * Kademlia routing table implementation
 */
export class RoutingTable {
  constructor(localNodeId, k = 20) {
    this.localNodeId = localNodeId instanceof DHTNodeId ? localNodeId : DHTNodeId.fromString(localNodeId);
    this.k = k;
    this.buckets = [new KBucket(k, 0, 0)]; // Start with single bucket
    this.totalNodes = 0;

    // Event handling for connection managers
    this.onNodeAdded = null; // Callback to notify DHT when nodes are added via connections
    this.eventHandlersSetup = false;

    // EMERGENCY: Circuit breaker to completely disable debug logging after threshold
    this._debugLoggingDisabled = false;
    this._debugLogCount = 0;
    this._maxDebugLogs = 50; // After 50 debug logs, disable completely
  }

  /**
   * Add a node to the routing table
   */
  addNode(node) {
    if (!(node instanceof DHTNode)) {
      throw new Error('Must provide DHTNode instance');
    }

    // CRITICAL FIX: Don't add temporary bootstrap server connections to DHT routing table
    // Bootstrap connections have IDs like "bootstrap_1234567890" and are temporary
    const nodeIdStr = node.id.toString();
    if (nodeIdStr.startsWith('bootstrap_')) {
      console.log(`🔗 Ignoring temporary bootstrap connection ${nodeIdStr.substring(0, 16)}... in RoutingTable.addNode (not a DHT peer)`);
      return false;
    }

    // Validate that nodeId is a valid 40-character hex DHT node ID
    if (!nodeIdStr || nodeIdStr.length !== 40 || !/^[0-9a-f]{40}$/i.test(nodeIdStr)) {
      console.warn(`⚠️ Invalid DHT node ID format in RoutingTable.addNode: ${nodeIdStr} - not adding to routing table`);
      return false;
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

    // SAFETY CHECK: Ensure buckets array and target bucket exist
    if (!this.buckets || bucketIndex >= this.buckets.length || !this.buckets[bucketIndex]) {
      console.error(`❌ RoutingTable.addNode: Invalid bucket access - buckets=${!!this.buckets}, bucketIndex=${bucketIndex}, bucketsLength=${this.buckets?.length}`);
      return false;
    }

    const bucket = this.buckets[bucketIndex];

    // Try to add to existing bucket
    const wasAlreadyPresent = bucket.hasNode(node.id);
    if (bucket.addNode(node)) {
      if (!wasAlreadyPresent) {
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
    const id = nodeId instanceof DHTNodeId ? nodeId : DHTNodeId.fromHex(nodeId);
    const bucketIndex = this.getBucketIndex(id);

    // SAFETY CHECK: Ensure buckets array and target bucket exist
    if (!this.buckets || bucketIndex >= this.buckets.length || !this.buckets[bucketIndex]) {
      console.error(`❌ RoutingTable.removeNode: Invalid bucket access - buckets=${!!this.buckets}, bucketIndex=${bucketIndex}, bucketsLength=${this.buckets?.length}`);
      return false;
    }

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
    // CRITICAL FIX: Add null check to prevent TypeError
    if (!nodeId) {
      console.warn('⚠️ RoutingTable.getNode called with undefined/null nodeId');
      return null;
    }

    // CRITICAL FIX: Nodes should never look up themselves in routing table
    // This prevents the negative bucket index issue
    const nodeIdStr = nodeId instanceof DHTNodeId ? nodeId.toString() : nodeId;
    if (nodeIdStr === this.localNodeId.toString()) {
      console.warn(`⚠️ Attempted to look up local node ID ${nodeIdStr.substring(0, 8)}... in routing table - returning null`);
      return null;
    }

    // CRITICAL FIX: Use fromHex() for existing node IDs, not fromString() which hashes them!
    const id = nodeId instanceof DHTNodeId ? nodeId : DHTNodeId.fromHex(nodeId);
    const bucketIndex = this.getBucketIndex(id);

    // SAFETY CHECK: Ensure buckets array and target bucket exist
    if (!this.buckets || bucketIndex >= this.buckets.length || !this.buckets[bucketIndex]) {
      console.error(`❌ RoutingTable.getNode: Invalid bucket access - buckets=${!!this.buckets}, bucketIndex=${bucketIndex}, bucketsLength=${this.buckets?.length}, targetBucket=${!!this.buckets?.[bucketIndex]}`);
      return null;
    }

    // Try normal bucket lookup first
    let foundNode = this.buckets[bucketIndex].getNode(id);

    // EMERGENCY: Circuit breaker to prevent memory crashes from debug logging
    // Reuse nodeIdStr from above to avoid duplicate declaration
    const nodePrefix = nodeIdStr.substring(0, 8);

    if (!this._debugLoggingDisabled && this._debugLogCount < this._maxDebugLogs) {
      if (!this._debugLogged) {
        this._debugLogged = new Set();
      }

      // Only log once per unique node prefix AND only for specific debug cases
      const shouldDebugLog = !this._debugLogged.has(nodePrefix) &&
                            (nodeIdStr.includes('8b7f7fb8') || nodeIdStr.includes('88bcbfa2'));

      if (shouldDebugLog) {
        console.log(`🔧 ROUTING TABLE DEBUG - getNode for ${nodePrefix}: bucket=${bucketIndex}, found=${!!foundNode}`);

        this._debugLogged.add(nodePrefix);
        this._debugLogCount++;

        // Circuit breaker: disable all debug logging after threshold
        if (this._debugLogCount >= this._maxDebugLogs) {
          this._debugLoggingDisabled = true;
          console.warn(`🚨 EMERGENCY: Routing table debug logging DISABLED after ${this._maxDebugLogs} logs to prevent memory crash`);
        }
      }
    }

    // CRITICAL FIX: If not found in expected bucket, search all buckets
    // This handles bucket calculation issues, ID conversion problems, and bucket splits
    if (!foundNode) {
      const nodeIdStr = id.toString();

      // EMERGENCY: Disable most fallback search logging to prevent memory crashes
      if (!this._fallbackSearchLogged) {
        this._fallbackSearchLogged = new Set();
      }

      const nodePrefix = nodeIdStr.substring(0, 8);
      const shouldLog = !this._fallbackSearchLogged.has(nodePrefix) && this._fallbackSearchLogged.size < 5;

      if (shouldLog) {
        console.warn(`🔍 Fallback search for ${nodePrefix} (bucket ${bucketIndex})`);
        this._fallbackSearchLogged.add(nodePrefix);
      }

      // Silent fallback search across ALL buckets
      for (let i = 0; i < this.buckets.length; i++) {
        const bucket = this.buckets[i];
        const nodes = bucket.getNodes();

        for (const node of nodes) {
          const nodeStr = node.id.toString();

          // Try both string comparison and equals() method
          if (nodeStr === nodeIdStr || node.id.equals(id)) {
            if (shouldLog) {
              console.warn(`🔍 FOUND ${nodePrefix} in bucket ${i}`);
            }
            foundNode = node;
            break;
          }
        }

        if (foundNode) break;
      }

      if (!foundNode && shouldLog) {
        console.error(`🚨 ${nodePrefix} not found in any bucket`);
      }
    }

    return foundNode;
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
    // DISABLED: The previous phantom peer detection was incorrectly flagging
    // legitimate connected peers that had been successfully communicating for 5+ minutes
    //
    // Real connected peers that maintain long-term connections should NOT be considered phantom
    // Only actual phantom peers (like storage key hashes) should be rejected
    //
    // TODO: Implement proper phantom peer detection that:
    // 1. Checks if the peer ID comes from a legitimate connection manager
    // 2. Validates against known invitation tokens
    // 3. Does NOT reject peers based on connection duration
    // 4. Uses pattern analysis of node IDs to detect storage keys vs real peer IDs

    console.log(`🔍 Routing table evaluating peer: ${nodeIdStr} (phantom detection disabled)`);

    // Always allow peers for now - phantom detection needs proper redesign
    return false;
  }

  /**
   * Find the k closest nodes to a target
   */
  findClosestNodes(targetId, k = this.k) {
    const target = targetId instanceof DHTNodeId ? targetId : DHTNodeId.fromHex(targetId);
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
   * Find the k closest CONNECTED nodes to a target
   */
  findClosestConnectedNodes(targetId, k = this.k, connectionManager = null) {
    const target = targetId instanceof DHTNodeId ? targetId : DHTNodeId.fromHex(targetId);
    const allNodes = [];

    // Collect all nodes from all buckets
    for (const bucket of this.buckets) {
      allNodes.push(...bucket.getNodes());
    }

    // Filter to only connected nodes using per-node connection managers
    const connectedNodes = allNodes.filter(node => node.isConnected());
    connectedNodes.sort((a, b) => {
      const distA = a.id.xorDistance(target);
      const distB = b.id.xorDistance(target);
      return distA.compare(distB);
    });

    return connectedNodes.slice(0, k);
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
    // CRITICAL FIX: Prevent looking up our own node ID (distance = 0, leadingZeros = 160)
    // Nodes should never store themselves in their own routing table
    if (nodeId instanceof DHTNodeId ? nodeId.equals(this.localNodeId) : nodeId === this.localNodeId.toString()) {
      console.warn(`⚠️ Attempted to get bucket index for local node ID ${this.localNodeId.toString().substring(0, 8)}... - this should not happen`);
      return 0; // Return bucket 0 as fallback to prevent negative index
    }

    const distance = this.localNodeId.xorDistance(nodeId);
    const leadingZeros = distance.leadingZeroBits();

    // Map to bucket index (160 - leadingZeros - 1)
    let bucketIndex = 159 - leadingZeros;

    // SAFETY: Ensure bucket index is non-negative and within bounds
    if (bucketIndex < 0) {
      console.warn(`⚠️ Negative bucket index calculated: ${bucketIndex} (leadingZeros: ${leadingZeros}) - using bucket 0`);
      bucketIndex = 0;
    }

    // Ensure we don't exceed available buckets
    return Math.min(bucketIndex, this.buckets.length - 1);
  }

  /**
   * Check if a bucket can be split
   */
  canSplitBucket(bucketIndex, _nodeId) {
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
    const bucketStats = this.buckets.map((bucket, _index) => bucket.getStats());
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
  /**
   * Set up event handlers on connection managers to receive peerConnected events
   */
  setupConnectionEventHandlers(connectionManagers, nodeAddedCallback) {
    if (this.eventHandlersSetup) {
      return;
    }

    console.log('🔧 RoutingTable setting up connection event handlers');

    // Store callback to notify DHT when nodes are added
    this.onNodeAdded = nodeAddedCallback;

    // Create shared event handler - same for all connection managers
    this.peerConnectedHandler = ({ peerId, connection, manager, initiator, metadata }) => {
      console.log(`🔗 RoutingTable received peerConnected: ${peerId.substring(0, 8)}... (via ${manager.constructor.name}, initiator=${initiator})`);
      if (metadata) {
        console.log(`📋 RoutingTable received metadata for ${peerId.substring(0, 8)}:`, metadata);
      }
      this.handlePeerConnected(peerId, connection, manager, initiator, metadata);
    };

    // Set up the same handler on all connection managers
    for (const manager of connectionManagers) {
      if (manager && manager.localNodeId) {
        console.log(`📋 RoutingTable setting up event handlers on ${manager.constructor.name}`);
        manager.on('peerConnected', this.peerConnectedHandler);
      }
    }

    this.eventHandlersSetup = true;
    console.log('✅ RoutingTable connection event handlers configured');
  }

  /**
   * Set up connection manager handlers (WebRTC signals, etc.)
   * Called by KademliaDHT when connection manager is created
   * TIMING CRITICAL: Must be called BEFORE createConnection() to catch signals
   */
  setupConnectionManagerHandlers(connectionManager, peerId) {
    if (!connectionManager) {
      console.warn('⚠️ setupConnectionManagerHandlers called with null manager');
      return;
    }

    // CRITICAL FIX: Attach WebRTC signal routing handler for WebRTC connections
    // This must be attached BEFORE any signals are emitted (timing critical!)
    if (connectionManager.constructor.name === 'WebRTCConnectionManager' && this.webrtcSignalHandler) {
      console.log(`🔗 RoutingTable: Attaching WebRTC signal handler to ${connectionManager.constructor.name} for ${peerId.substring(0, 8)}...`);
      connectionManager.on('signal', this.webrtcSignalHandler);
      connectionManager._webrtcSignalHandlerAttached = true;
    } else if (connectionManager.constructor.name === 'WebRTCConnectionManager') {
      console.warn(`⚠️ WebRTC signal handler not available for ${peerId.substring(0, 8)} - signals will not be routed`);
    }
  }

  /**
   * Handle peerConnected event by creating and configuring DHTNode
   */
  handlePeerConnected(peerId, connection, manager, initiator, metadata = null) {
    // CRITICAL FIX: Don't add temporary bootstrap server connections to DHT routing table
    // Bootstrap connections have IDs like "bootstrap_1234567890" and are temporary
    if (peerId.startsWith('bootstrap_')) {
      console.log(`🔗 Ignoring temporary bootstrap connection ${peerId.substring(0, 16)}... in RoutingTable (not a DHT peer)`);
      return;
    }

    // Validate that peerId is a valid 40-character hex DHT node ID
    if (!peerId || peerId.length !== 40 || !/^[0-9a-f]{40}$/i.test(peerId)) {
      console.warn(`⚠️ Invalid DHT node ID format in RoutingTable: ${peerId} - not adding to routing table`);
      return;
    }

    // Check if node already exists
    const existingNode = this.getNode(peerId);
    if (existingNode) {
      console.log(`🔄 Node ${peerId.substring(0, 8)}... already exists in routing table`);

      // ARCHITECTURE NOTE: Collision detection should be handled in ConnectionManager subclasses
      // before emitting 'peerConnected', not here in RoutingTable.
      // RoutingTable should just store nodes - connection negotiation is transport-specific.
      //
      // For now: Always accept new connections (ConnectionManager will handle collisions internally)
      console.log(`🔗 Updating connection for existing node ${peerId.substring(0, 8)}...`);
      existingNode.setupConnection(manager, connection);
      existingNode.initiator = initiator; // Store initiator flag

      // Update metadata if provided
      if (metadata && Object.keys(metadata).length > 0) {
        console.log(`📋 Updating metadata for existing node ${peerId.substring(0, 8)}:`, metadata);
        for (const [key, value] of Object.entries(metadata)) {
          existingNode.setMetadata(key, value);
        }
      }
      return;
    }

    console.log(`📋 RoutingTable creating DHTNode for ${peerId.substring(0, 8)}...`);

    // Create new DHTNode
    const node = new DHTNode(peerId, peerId);

    // Set up the node's connection and manager
    node.setupConnection(manager, connection);
    node.initiator = initiator; // Store initiator flag for collision handling
    // Note: Signal handlers should already be attached via setupConnectionManagerHandlers()
    
    // CRITICAL FIX: Pass routing table reference to connection manager for inactive tab filtering
    if (manager) {
      manager.routingTable = this;
    }

    // Set metadata directly on node (clean architecture - no intermediate storage)
    if (metadata && Object.keys(metadata).length > 0) {
      console.log(`📋 Setting metadata on DHTNode ${peerId.substring(0, 8)}:`, metadata);
      for (const [key, value] of Object.entries(metadata)) {
        node.setMetadata(key, value);
        console.log(`📋 Set metadata ${key}=${value} for ${peerId.substring(0, 8)}`);
      }

      // Verify the metadata was set
      const bridgeCheck = node.getMetadata('isBridgeNode');
      console.log(`📋 Verification: isBridgeNode=${bridgeCheck} for ${peerId.substring(0, 8)}`);
    } else {
      console.log(`📋 No metadata provided for ${peerId.substring(0, 8)}`);

      // Fallback: Check ConnectionManagerFactory for global metadata (for existing code compatibility)
      if (ConnectionManagerFactory && ConnectionManagerFactory.getPeerMetadata) {
        const factoryMetadata = ConnectionManagerFactory.getPeerMetadata(peerId);
        if (factoryMetadata && Object.keys(factoryMetadata).length > 0) {
          console.log(`📋 Found fallback metadata in ConnectionManagerFactory for ${peerId.substring(0, 8)}:`, factoryMetadata);
          for (const [key, value] of Object.entries(factoryMetadata)) {
            node.setMetadata(key, value);
          }
        }
      }
    }

    // Set up callbacks for the node to communicate back to DHT
    if (this.onNodeAdded) {
      node.setMessageCallback((peerId, data) => {
        this.onNodeAdded('message', { peerId, data });
      });

      node.setDisconnectionCallback((peerId) => {
        console.log(`🔌 RoutingTable handling disconnection of ${peerId.substring(0, 8)}...`);
        this.removeNode(peerId);
        this.onNodeAdded('disconnect', { peerId });
      });
    }

    // Add node to routing table
    const addResult = this.addNode(node);

    if (addResult) {
      console.log(`✅ RoutingTable added ${peerId.substring(0, 8)}... (total: ${this.totalNodes})`);

      // Notify DHT that a new node was added
      if (this.onNodeAdded) {
        this.onNodeAdded('nodeAdded', { peerId, node });
      }
    }
  }

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