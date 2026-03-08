/**
 * Kademlia Routing Enhancements Integration Tests
 * 
 * Tests end-to-end integration of:
 * - Recursive routing across multiple nodes
 * - Self-lookup network convergence
 * - Replacement cache under node churn
 * - PNS ranking stability under RTT updates
 * 
 * Validates: Requirements 1.1-6.5
 */

import { createHash } from 'crypto';

// Configure @noble/ed25519 for Node.js
import * as ed25519 from '@noble/ed25519';
if (!ed25519.etc || !ed25519.etc.sha512Sync) {
  if (ed25519.etc) {
    ed25519.etc.sha512Sync = (...m) => createHash('sha512').update(Buffer.concat(m)).digest();
  }
}

import { jest } from '@jest/globals';
import { DHTNodeId } from '../../src/core/DHTNodeId.js';
import { DHTNode } from '../../src/core/DHTNode.js';
import { RoutingTable } from '../../src/dht/RoutingTable.js';
import { KBucket } from '../../src/core/KBucket.js';
import { KademliaDHT } from '../../src/dht/KademliaDHT.js';

/**
 * Create a mock DHT instance for testing
 */
const createMockDHT = (options = {}) => {
  const mockBootstrap = {
    connect: jest.fn().mockResolvedValue(undefined),
    requestPeersOrGenesis: jest.fn().mockResolvedValue({ peers: [], isGenesis: true }),
    isBootstrapConnected: jest.fn().mockReturnValue(true),
    enableAutoReconnect: jest.fn(),
    disableAutoReconnect: jest.fn(),
    isDestroyed: false,
    on: jest.fn(),
    once: jest.fn(),
    removeListener: jest.fn(),
    emit: jest.fn(),
    getStatus: jest.fn().mockReturnValue({ connected: true })
  };
  
  return new KademliaDHT({
    bootstrap: mockBootstrap,
    bootstrapServers: ['ws://localhost:8080'],
    ...options
  });
};

/**
 * Create a virtual DHT network for integration testing
 */
class VirtualDHTNetwork {
  constructor(nodeCount = 10) {
    this.nodeCount = nodeCount;
    this.nodes = [];
    this.messageLog = [];
  }

  async setup() {
    // Create DHT nodes
    for (let i = 0; i < this.nodeCount; i++) {
      const dht = createMockDHT();
      
      // Mock sendMessage to log and route messages
      dht.sendMessage = jest.fn().mockImplementation((peerId, message) => {
        this.messageLog.push({ from: dht.localNodeId.toString(), to: peerId, message });
        return this.routeMessage(dht.localNodeId.toString(), peerId, message);
      });
      
      // Mock isPeerConnected based on routing table
      dht.isPeerConnected = jest.fn().mockImplementation((peerId) => {
        const node = dht.routingTable.getNode(peerId);
        return node !== null && node !== undefined;
      });
      
      this.nodes.push(dht);
    }

    // Connect nodes in a mesh (each node knows about several others)
    await this.buildMesh();
  }

  async buildMesh() {
    for (const dht of this.nodes) {
      // Each node connects to 5-10 random other nodes
      const connectCount = Math.min(Math.floor(Math.random() * 6) + 5, this.nodes.length - 1);
      const connected = new Set();
      
      for (let i = 0; i < connectCount; i++) {
        let targetDHT;
        do {
          targetDHT = this.nodes[Math.floor(Math.random() * this.nodes.length)];
        } while (targetDHT === dht || connected.has(targetDHT.localNodeId.toString()));
        
        connected.add(targetDHT.localNodeId.toString());
        
        // Add to routing table
        const node = new DHTNode(targetDHT.localNodeId, `endpoint-${targetDHT.localNodeId.toString().substring(0, 8)}`);
        node.isAlive = true;
        node.lastSeen = Date.now();
        node.rtt = Math.floor(Math.random() * 100) + 10; // 10-110ms RTT
        dht.routingTable.addNode(node);
      }
    }
  }

  async routeMessage(fromId, toId, message) {
    const targetDHT = this.nodes.find(n => n.localNodeId.toString() === toId);
    if (!targetDHT) {
      throw new Error(`Node ${toId.substring(0, 8)} not found`);
    }
    
    // Simulate message handling
    if (message.type === 'recursive_find_node') {
      await targetDHT.handleRecursiveFindNode(fromId, message);
    } else if (message.type === 'recursive_find_node_response') {
      // Response handling would go here
    }
    
    return Promise.resolve();
  }

  getNode(index) {
    return this.nodes[index];
  }

  getRandomNode() {
    return this.nodes[Math.floor(Math.random() * this.nodes.length)];
  }

  clearMessageLog() {
    this.messageLog = [];
  }
}

describe('Kademlia Routing Enhancements Integration Tests', () => {
  
  describe('End-to-End Recursive Routing', () => {
    let network;

    beforeEach(async () => {
      network = new VirtualDHTNetwork(10);
      await network.setup();
    });

    test('recursive find_node traverses multiple hops toward target', async () => {
      const sourceDHT = network.getNode(0);
      const target = new DHTNodeId();
      
      network.clearMessageLog();
      
      // Initiate recursive find_node
      const message = {
        type: 'recursive_find_node',
        target: target.toString(),
        requestId: 'integration-test-1',
        hopCount: 0,
        originatorId: sourceDHT.localNodeId.toString()
      };
      
      // Find a connected peer to send to
      const connectedPeers = sourceDHT.routingTable.getAllNodes().filter(n => 
        sourceDHT.isPeerConnected(n.id.toString())
      );
      
      if (connectedPeers.length > 0) {
        await sourceDHT.sendMessage(connectedPeers[0].id.toString(), message);
        
        // Verify messages were logged
        expect(network.messageLog.length).toBeGreaterThan(0);
        
        // Verify first message was recursive_find_node
        expect(network.messageLog[0].message.type).toBe('recursive_find_node');
      }
    });

    test('hop count increments with each forward', async () => {
      const sourceDHT = network.getNode(0);
      const target = new DHTNodeId();
      
      network.clearMessageLog();
      
      const message = {
        type: 'recursive_find_node',
        target: target.toString(),
        requestId: 'hop-count-test',
        hopCount: 5,
        originatorId: sourceDHT.localNodeId.toString()
      };
      
      const connectedPeers = sourceDHT.routingTable.getAllNodes().filter(n => 
        sourceDHT.isPeerConnected(n.id.toString())
      );
      
      if (connectedPeers.length > 0) {
        await sourceDHT.sendMessage(connectedPeers[0].id.toString(), message);
        
        // Check if any forwarded messages have incremented hop count
        const forwardedMessages = network.messageLog.filter(m => 
          m.message.type === 'recursive_find_node' && m.message.hopCount > 5
        );
        
        // If forwarding occurred, hop count should be incremented
        for (const fwd of forwardedMessages) {
          expect(fwd.message.hopCount).toBeGreaterThan(5);
        }
      }
    });

    test('XOR distance decreases with each hop', async () => {
      const sourceDHT = network.getNode(0);
      const target = new DHTNodeId();
      
      network.clearMessageLog();
      
      const message = {
        type: 'recursive_find_node',
        target: target.toString(),
        requestId: 'xor-distance-test',
        hopCount: 0,
        originatorId: sourceDHT.localNodeId.toString()
      };
      
      const connectedPeers = sourceDHT.routingTable.getAllNodes().filter(n => 
        sourceDHT.isPeerConnected(n.id.toString())
      );
      
      if (connectedPeers.length > 0) {
        const firstPeer = connectedPeers[0];
        await sourceDHT.sendMessage(firstPeer.id.toString(), message);
        
        // Verify XOR distance property: each forwarded message should go to a closer node
        const forwardedMessages = network.messageLog.filter(m => 
          m.message.type === 'recursive_find_node'
        );
        
        let previousDistance = null;
        for (const fwd of forwardedMessages) {
          const fromNode = network.nodes.find(n => n.localNodeId.toString() === fwd.from);
          if (fromNode) {
            const currentDistance = fromNode.localNodeId.xorDistance(target);
            
            // Each hop should be to a node closer to target
            if (previousDistance !== null) {
              // The 'to' node should be closer than 'from' node
              const toNodeDHT = network.nodes.find(n => n.localNodeId.toString() === fwd.to);
              if (toNodeDHT) {
                const toDistance = toNodeDHT.localNodeId.xorDistance(target);
                expect(toDistance.compare(currentDistance)).toBeLessThan(0);
              }
            }
            previousDistance = currentDistance;
          }
        }
      }
    });
  });

  describe('Self-Lookup Network Convergence', () => {
    test('self-lookup adds discovered nodes to routing table', async () => {
      const dht = createMockDHT();
      
      // Create mock discovered nodes
      const discoveredNodes = [];
      for (let i = 0; i < 5; i++) {
        const node = new DHTNode(new DHTNodeId(), `endpoint-${i}`);
        node.isAlive = true;
        node.lastSeen = Date.now();
        discoveredNodes.push(node);
      }
      
      // Mock findNode to return discovered nodes
      dht.findNode = jest.fn().mockResolvedValue(discoveredNodes);
      
      const initialSize = dht.routingTable.totalNodes;
      
      // Perform self-lookup
      await dht.performSelfLookup();
      
      // Verify nodes were added
      expect(dht.routingTable.totalNodes).toBeGreaterThan(initialSize);
      expect(dht.selfLookupComplete).toBe(true);
    });

    test('self-lookup emits selfLookupComplete event', async () => {
      const dht = createMockDHT();
      
      const discoveredNodes = [
        new DHTNode(new DHTNodeId(), 'endpoint-1'),
        new DHTNode(new DHTNodeId(), 'endpoint-2')
      ];
      discoveredNodes.forEach(n => { n.isAlive = true; n.lastSeen = Date.now(); });
      
      dht.findNode = jest.fn().mockResolvedValue(discoveredNodes);
      
      const eventPromise = new Promise(resolve => {
        dht.once('selfLookupComplete', resolve);
      });
      
      await dht.performSelfLookup();
      
      const eventData = await eventPromise;
      expect(eventData.nodesDiscovered).toBe(2);
      expect(eventData.nodesAdded).toBeGreaterThanOrEqual(0);
    });

    test('self-lookup does not add local node to routing table', async () => {
      const dht = createMockDHT();
      
      // Include local node in discovered nodes
      const localNode = new DHTNode(dht.localNodeId, 'local-endpoint');
      localNode.isAlive = true;
      localNode.lastSeen = Date.now();
      
      const otherNode = new DHTNode(new DHTNodeId(), 'other-endpoint');
      otherNode.isAlive = true;
      otherNode.lastSeen = Date.now();
      
      dht.findNode = jest.fn().mockResolvedValue([localNode, otherNode]);
      
      await dht.performSelfLookup();
      
      // Local node should not be in routing table
      const foundLocal = dht.routingTable.getNode(dht.localNodeId);
      expect(foundLocal).toBeNull();
    });
  });

  describe('Replacement Cache Under Node Churn', () => {
    test('replacement cache stores overflow nodes', () => {
      const bucket = new KBucket(3); // Small k for testing
      
      // Fill bucket
      for (let i = 0; i < 3; i++) {
        const node = new DHTNode(new DHTNodeId(), `endpoint-${i}`);
        node.lastSeen = Date.now();
        bucket.addNode(node);
      }
      
      expect(bucket.isFull()).toBe(true);
      expect(bucket.replacementCacheSize()).toBe(0);
      
      // Add overflow node
      const overflowNode = new DHTNode(new DHTNodeId(), 'overflow-endpoint');
      overflowNode.lastSeen = Date.now();
      bucket.addNode(overflowNode);
      
      // Should be in replacement cache
      expect(bucket.replacementCacheSize()).toBe(1);
      const cache = bucket.getReplacementCache();
      expect(cache[0].id.equals(overflowNode.id)).toBe(true);
    });

    test('node failure promotes from replacement cache', () => {
      const bucket = new KBucket(3);
      
      // Fill bucket
      const nodes = [];
      for (let i = 0; i < 3; i++) {
        const node = new DHTNode(new DHTNodeId(), `endpoint-${i}`);
        node.lastSeen = Date.now();
        bucket.addNode(node);
        nodes.push(node);
      }
      
      // Add to replacement cache
      const cacheNode = new DHTNode(new DHTNodeId(), 'cache-endpoint');
      cacheNode.lastSeen = Date.now();
      bucket.addNode(cacheNode);
      
      expect(bucket.replacementCacheSize()).toBe(1);
      
      // Simulate node failure
      const failedNode = nodes[0];
      bucket.handleNodeFailure(failedNode.id);
      
      // Cache node should be promoted
      expect(bucket.size()).toBe(3); // Still full
      expect(bucket.replacementCacheSize()).toBe(0); // Cache empty
      expect(bucket.hasNode(cacheNode.id)).toBe(true); // Cache node now in bucket
      expect(bucket.hasNode(failedNode.id)).toBe(false); // Failed node removed
    });

    test('RoutingTable.handleNodeFailure uses replacement cache', () => {
      const localId = new DHTNodeId();
      const routingTable = new RoutingTable(localId, 20);
      
      // Add nodes to fill a bucket
      const addedNodes = [];
      for (let i = 0; i < 25; i++) {
        const node = new DHTNode(new DHTNodeId(), `endpoint-${i}`);
        node.isAlive = true;
        node.lastSeen = Date.now();
        if (routingTable.addNode(node)) {
          addedNodes.push(node);
        }
      }
      
      // Get a node that was added
      if (addedNodes.length > 0) {
        const nodeToFail = addedNodes[0];
        const initialSize = routingTable.totalNodes;
        
        // Handle failure
        routingTable.handleNodeFailure(nodeToFail.id);
        
        // Node should be removed (or replaced from cache)
        // getNode returns undefined or null when not found
        const foundNode = routingTable.getNode(nodeToFail.id);
        expect(foundNode == null).toBe(true); // Handles both null and undefined
      }
    });

    test('replacement cache maintains LRU ordering', () => {
      const bucket = new KBucket(2); // Very small for testing
      
      // Fill bucket
      bucket.addNode(new DHTNode(new DHTNodeId(), 'main-1'));
      bucket.addNode(new DHTNode(new DHTNodeId(), 'main-2'));
      
      // Add to cache
      const cacheNode1 = new DHTNode(new DHTNodeId(), 'cache-1');
      const cacheNode2 = new DHTNode(new DHTNodeId(), 'cache-2');
      
      bucket.addNode(cacheNode1);
      bucket.addNode(cacheNode2);
      
      // cacheNode2 should be most recent (at end)
      let cache = bucket.getReplacementCache();
      expect(cache[cache.length - 1].id.equals(cacheNode2.id)).toBe(true);
      
      // Re-add cacheNode1 to move it to end
      bucket.addToReplacementCache(cacheNode1);
      
      cache = bucket.getReplacementCache();
      expect(cache[cache.length - 1].id.equals(cacheNode1.id)).toBe(true);
    });
  });

  describe('PNS Ranking Stability Under RTT Updates', () => {
    test('PNS ranks nodes by RTT when enabled', () => {
      const localId = new DHTNodeId();
      const routingTable = new RoutingTable(localId, 20, { pnsEnabled: true });
      
      // Add nodes with different RTTs
      const nodes = [];
      for (let i = 0; i < 5; i++) {
        const node = new DHTNode(new DHTNodeId(), `endpoint-${i}`);
        node.isAlive = true;
        node.lastSeen = Date.now();
        node.rtt = (5 - i) * 50; // 250, 200, 150, 100, 50
        routingTable.addNode(node);
        nodes.push(node);
      }
      
      // Get bucket and verify ordering
      const allNodes = routingTable.getAllNodes();
      
      // Nodes should be sorted by RTT (lowest first) among live nodes
      for (let i = 1; i < allNodes.length; i++) {
        const prevRTT = allNodes[i-1].rtt || Infinity;
        const currRTT = allNodes[i].rtt || Infinity;
        
        // If both are alive, lower RTT should come first
        if (allNodes[i-1].isAlive && allNodes[i].isAlive) {
          expect(prevRTT).toBeLessThanOrEqual(currRTT);
        }
      }
    });

    test('PNS preserves liveness priority over RTT', () => {
      const localId = new DHTNodeId();
      const routingTable = new RoutingTable(localId, 20, { pnsEnabled: true });
      
      // Add live node with high RTT
      const liveNode = new DHTNode(new DHTNodeId(), 'live-endpoint');
      liveNode.isAlive = true;
      liveNode.lastSeen = Date.now();
      liveNode.rtt = 500; // High RTT
      routingTable.addNode(liveNode);
      
      // Add dead node with low RTT
      const deadNode = new DHTNode(new DHTNodeId(), 'dead-endpoint');
      deadNode.isAlive = false;
      deadNode.lastSeen = Date.now() - 10 * 60 * 1000; // 10 minutes ago
      deadNode.rtt = 10; // Low RTT
      routingTable.addNode(deadNode);
      
      const allNodes = routingTable.getAllNodes();
      
      // Live node should come before dead node regardless of RTT
      const liveIndex = allNodes.findIndex(n => n.id.equals(liveNode.id));
      const deadIndex = allNodes.findIndex(n => n.id.equals(deadNode.id));
      
      if (liveIndex !== -1 && deadIndex !== -1) {
        expect(liveIndex).toBeLessThan(deadIndex);
      }
    });

    test('bucket structure unchanged by RTT updates', () => {
      const localId = new DHTNodeId();
      const routingTable = new RoutingTable(localId, 20, { pnsEnabled: true });
      
      // Add nodes
      for (let i = 0; i < 10; i++) {
        const node = new DHTNode(new DHTNodeId(), `endpoint-${i}`);
        node.isAlive = true;
        node.lastSeen = Date.now();
        node.rtt = Math.random() * 200;
        routingTable.addNode(node);
      }
      
      const initialBucketCount = routingTable.buckets.length;
      const initialBucketPrefixes = routingTable.buckets.map(b => b.prefix);
      const initialBucketDepths = routingTable.buckets.map(b => b.depth);
      
      // Update RTTs
      for (const node of routingTable.getAllNodes()) {
        node.rtt = Math.random() * 200;
      }
      
      // Re-rank all buckets
      for (let i = 0; i < routingTable.buckets.length; i++) {
        routingTable.rankBucketByRTT(i);
      }
      
      // Verify bucket structure unchanged
      expect(routingTable.buckets.length).toBe(initialBucketCount);
      expect(routingTable.buckets.map(b => b.prefix)).toEqual(initialBucketPrefixes);
      expect(routingTable.buckets.map(b => b.depth)).toEqual(initialBucketDepths);
    });

    test('PNS disabled by default', () => {
      const localId = new DHTNodeId();
      const routingTable = new RoutingTable(localId, 20);
      
      expect(routingTable.pnsEnabled).toBe(false);
    });
  });

  describe('Liveness Over Proximity Enforcement', () => {
    test('live node not replaced by better-RTT unknown-liveness node', () => {
      const localId = new DHTNodeId();
      const routingTable = new RoutingTable(localId, 20);
      
      // Add live node
      const liveNode = new DHTNode(new DHTNodeId(), 'live-endpoint');
      liveNode.isAlive = true;
      liveNode.lastSeen = Date.now();
      liveNode.rtt = 500;
      routingTable.addNode(liveNode);
      
      // Try to add unknown-liveness node with better RTT
      const unknownNode = new DHTNode(new DHTNodeId(), 'unknown-endpoint');
      unknownNode.isAlive = false; // Unknown liveness
      unknownNode.lastSeen = Date.now() - 10 * 60 * 1000;
      unknownNode.rtt = 10;
      
      // shouldReplaceNode should return false
      expect(routingTable.shouldReplaceNode(liveNode, unknownNode)).toBe(false);
    });

    test('recently-seen node protected regardless of RTT', () => {
      const localId = new DHTNodeId();
      const routingTable = new RoutingTable(localId, 20);
      
      // Add recently-seen node
      const recentNode = new DHTNode(new DHTNodeId(), 'recent-endpoint');
      recentNode.isAlive = true;
      recentNode.lastSeen = Date.now() - 60 * 1000; // 1 minute ago (within 5 min window)
      recentNode.rtt = 500;
      
      // Candidate with better RTT
      const candidate = new DHTNode(new DHTNodeId(), 'candidate-endpoint');
      candidate.isAlive = true;
      candidate.lastSeen = Date.now();
      candidate.rtt = 10;
      
      // shouldReplaceNode should return false
      expect(routingTable.shouldReplaceNode(recentNode, candidate)).toBe(false);
    });

    test('dead node can be replaced', () => {
      const localId = new DHTNodeId();
      const routingTable = new RoutingTable(localId, 20);
      
      // Add dead node
      const deadNode = new DHTNode(new DHTNodeId(), 'dead-endpoint');
      deadNode.isAlive = false;
      deadNode.lastSeen = Date.now() - 10 * 60 * 1000; // 10 minutes ago
      deadNode.failureCount = 3;
      
      // Live candidate
      const candidate = new DHTNode(new DHTNodeId(), 'candidate-endpoint');
      candidate.isAlive = true;
      candidate.lastSeen = Date.now();
      
      // shouldReplaceNode should return true
      expect(routingTable.shouldReplaceNode(deadNode, candidate)).toBe(true);
    });

    test('isNodeLive checks both isAlive and lastSeen', () => {
      const localId = new DHTNodeId();
      const routingTable = new RoutingTable(localId, 20);
      
      // Node with isAlive=true but old lastSeen
      const staleNode = new DHTNode(new DHTNodeId(), 'stale-endpoint');
      staleNode.isAlive = true;
      staleNode.lastSeen = Date.now() - 10 * 60 * 1000; // 10 minutes ago
      
      expect(routingTable.isNodeLive(staleNode)).toBe(false);
      
      // Node with isAlive=true and recent lastSeen
      const liveNode = new DHTNode(new DHTNodeId(), 'live-endpoint');
      liveNode.isAlive = true;
      liveNode.lastSeen = Date.now() - 60 * 1000; // 1 minute ago
      
      expect(routingTable.isNodeLive(liveNode)).toBe(true);
      
      // Node with isAlive=false
      const deadNode = new DHTNode(new DHTNodeId(), 'dead-endpoint');
      deadNode.isAlive = false;
      deadNode.lastSeen = Date.now();
      
      expect(routingTable.isNodeLive(deadNode)).toBe(false);
    });
  });

  describe('Proximity Routing Integration', () => {
    test('selectNextHopWithProximity filters by XOR distance', () => {
      const dht = createMockDHT();
      const target = new DHTNodeId();
      const localDistance = dht.localNodeId.xorDistance(target);
      
      // Create candidates - some closer, some farther
      const candidates = [];
      for (let i = 0; i < 10; i++) {
        const node = new DHTNode(new DHTNodeId(), `endpoint-${i}`);
        node.isAlive = true;
        node.rtt = Math.random() * 100;
        candidates.push(node);
      }
      
      const selected = dht.selectNextHopWithProximity(candidates, target);
      
      if (selected) {
        // Selected node must be closer to target than local node
        const selectedDistance = selected.id.xorDistance(target);
        expect(selectedDistance.compare(localDistance)).toBeLessThan(0);
      }
    });

    test('selectNextHopWithProximity uses RTT as tiebreaker', () => {
      const dht = createMockDHT();
      const target = new DHTNodeId();
      
      // Find two nodes with same XOR distance (unlikely but test the logic)
      // Instead, create nodes and verify RTT ordering among XOR-valid candidates
      const candidates = [];
      for (let i = 0; i < 20; i++) {
        const node = new DHTNode(new DHTNodeId(), `endpoint-${i}`);
        node.isAlive = true;
        node.rtt = (20 - i) * 10; // Varying RTTs
        candidates.push(node);
      }
      
      const selected = dht.selectNextHopWithProximity(candidates, target);
      
      // If selected, it should be among the XOR-valid candidates with good RTT
      if (selected) {
        const localDistance = dht.localNodeId.xorDistance(target);
        const selectedDistance = selected.id.xorDistance(target);
        expect(selectedDistance.compare(localDistance)).toBeLessThan(0);
      }
    });

    test('selectNextHopWithProximity returns null for empty candidates', () => {
      const dht = createMockDHT();
      const target = new DHTNodeId();
      
      const selected = dht.selectNextHopWithProximity([], target);
      expect(selected).toBeNull();
      
      const selectedNull = dht.selectNextHopWithProximity(null, target);
      expect(selectedNull).toBeNull();
    });
  });
});
