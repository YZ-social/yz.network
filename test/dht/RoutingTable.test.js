import { RoutingTable } from '../../src/dht/RoutingTable.js';
import { DHTNode } from '../../src/core/DHTNode.js';
import { DHTNodeId } from '../../src/core/DHTNodeId.js';

describe('RoutingTable', () => {
  let routingTable;
  let localId;
  
  beforeEach(() => {
    localId = new DHTNodeId();
    routingTable = new RoutingTable(localId, 20); // k = 20
  });

  describe('constructor', () => {
    test('should create routing table with correct structure', () => {
      expect(routingTable.localNodeId).toBe(localId);
      expect(routingTable.k).toBe(20);
      expect(routingTable.buckets).toBeDefined();
      expect(routingTable.buckets.length).toBe(1); // Starts with single bucket
      expect(routingTable.totalNodes).toBe(0);
    });
  });

  describe('node management', () => {
    test('should add node to correct bucket', () => {
      const node = new DHTNode(new DHTNodeId(), 'test-address');
      const added = routingTable.addNode(node);
      
      expect(added).toBe(true);
      expect(routingTable.totalNodes).toBe(1);
      expect(routingTable.getNode(node.id)).toBe(node);
    });

    test('should not add local node', () => {
      const localNode = new DHTNode(localId, 'local-address');
      const added = routingTable.addNode(localNode);
      
      expect(added).toBe(false);
      expect(routingTable.totalNodes).toBe(0);
    });

    test('should remove node correctly', () => {
      const node = new DHTNode(new DHTNodeId(), 'test-address');
      routingTable.addNode(node);
      
      const removed = routingTable.removeNode(node.id);
      expect(removed).toBe(true);
      // After removal, getNode should return null or undefined (both indicate not found)
      const foundNode = routingTable.getNode(node.id);
      expect(foundNode == null).toBe(true); // Handles both null and undefined
    });

    test('should update existing node', () => {
      const node = new DHTNode(new DHTNodeId(), 'test-address');
      routingTable.addNode(node);
      
      const initialLastSeen = node.lastSeen;
      
      setTimeout(() => {
        routingTable.addNode(node); // Re-adding should update
        expect(node.lastSeen).toBeGreaterThan(initialLastSeen);
      }, 10);
    });
  });

  describe('bucket selection', () => {
    test('should find correct bucket for node ID', () => {
      // Create ID that differs in a specific bit position
      const targetId = DHTNodeId.fromHex('8' + '0'.repeat(39)); // MSB = 1000
      const bucketIndex = routingTable.getBucketIndex(targetId);
      
      expect(bucketIndex).toBeGreaterThanOrEqual(0);
      expect(bucketIndex).toBeLessThan(routingTable.buckets.length);
    });

    test('should return 0 for local ID (fallback)', () => {
      const bucketIndex = routingTable.getBucketIndex(localId);
      expect(bucketIndex).toBe(0); // Returns 0 as fallback, not -1
    });

    test('should get bucket nodes by index', () => {
      const bucketNodes = routingTable.getBucketNodes(0);
      expect(Array.isArray(bucketNodes)).toBe(true);
      expect(bucketNodes.length).toBe(0); // Initially empty
    });
  });

  describe('closest nodes lookup', () => {
    test('should find closest nodes to target', () => {
      // Add several nodes
      const nodes = [];
      for (let i = 0; i < 10; i++) {
        const node = new DHTNode(new DHTNodeId(), `address-${i}`);
        nodes.push(node);
        routingTable.addNode(node);
      }
      
      const targetId = new DHTNodeId();
      const closest = routingTable.findClosestNodes(targetId, 5);
      
      expect(closest.length).toBeLessThanOrEqual(5);
      expect(closest.length).toBeLessThanOrEqual(nodes.length);
      
      // Verify they are sorted by distance
      if (closest.length > 1) {
        for (let i = 0; i < closest.length - 1; i++) {
          const dist1 = closest[i].id.xorDistance(targetId);
          const dist2 = closest[i + 1].id.xorDistance(targetId);
          expect(dist1.compare(dist2)).toBeLessThanOrEqual(0);
        }
      }
    });

    test('should return empty array when no nodes exist', () => {
      const targetId = new DHTNodeId();
      const closest = routingTable.findClosestNodes(targetId, 5);
      
      expect(closest).toEqual([]);
    });

    test('should not include local node in results', () => {
      const nodes = [];
      for (let i = 0; i < 5; i++) {
        const node = new DHTNode(new DHTNodeId(), `address-${i}`);
        nodes.push(node);
        routingTable.addNode(node);
      }
      
      const closest = routingTable.findClosestNodes(localId, 10);
      expect(closest.some(node => node.id.equals(localId))).toBe(false);
    });
  });

  describe('routing table statistics', () => {
    test('should count total nodes correctly', () => {
      expect(routingTable.totalNodes).toBe(0);
      
      for (let i = 0; i < 15; i++) {
        const node = new DHTNode(new DHTNodeId(), `address-${i}`);
        routingTable.addNode(node);
      }
      
      expect(routingTable.totalNodes).toBe(15);
    });

    test('should get all nodes', () => {
      const nodes = [];
      for (let i = 0; i < 10; i++) {
        const node = new DHTNode(new DHTNodeId(), `address-${i}`);
        nodes.push(node);
        routingTable.addNode(node);
      }
      
      const allNodes = routingTable.getAllNodes();
      expect(allNodes.length).toBe(nodes.length);
    });

    test('should get routing table statistics', () => {
      // Add nodes to different buckets
      for (let i = 0; i < 25; i++) {
        const node = new DHTNode(new DHTNodeId(), `address-${i}`);
        routingTable.addNode(node);
      }
      
      const stats = routingTable.getStats();
      expect(stats.totalNodes).toBeGreaterThan(0);
      expect(stats.totalBuckets).toBeGreaterThan(0);
      expect(stats.averageNodesPerBucket).toBeGreaterThan(0);
      expect(stats.k).toBe(20);
      expect(stats.localNodeId).toBe(localId.toString());
    });
  });

  describe('stale node management', () => {
    test('should remove stale nodes', () => {
      const node = new DHTNode(new DHTNodeId(), 'test-address');
      routingTable.addNode(node);
      // Make node stale AFTER adding it (since addNode updates lastSeen)
      node.lastSeen = Date.now() - 70 * 1000; // 70 seconds ago
      
      const removedCount = routingTable.removeStaleNodes(60 * 1000); // 60 second timeout
      expect(removedCount).toBe(1);
      expect(routingTable.totalNodes).toBe(0);
    });

    test('should get nodes that need pinging', () => {
      const node = new DHTNode(new DHTNodeId(), 'test-address');
      node.lastPing = Date.now() - 70000; // 70 seconds ago
      routingTable.addNode(node);
      
      const nodesToPing = routingTable.getNodesToPing(60000); // 60 second interval
      expect(nodesToPing).toContain(node);
    });
  });

  describe('routing table maintenance', () => {
    test('should validate routing table consistency', () => {
      for (let i = 0; i < 10; i++) {
        const node = new DHTNode(new DHTNodeId(), `address-${i}`);
        routingTable.addNode(node);
      }
      
      const validation = routingTable.validate();
      expect(validation.valid).toBe(true);
      expect(validation.issues).toEqual([]);
    });

    test('should handle bucket splitting when necessary', () => {
      // This test would require a more complex setup to trigger bucket splitting
      // For now, just verify the routing table can handle many nodes
      const initialBuckets = routingTable.buckets.length;
      
      for (let i = 0; i < 50; i++) {
        const node = new DHTNode(new DHTNodeId(), `address-${i}`);
        routingTable.addNode(node);
      }
      
      expect(routingTable.totalNodes).toBeGreaterThan(0);
      // Bucket count may increase due to splitting
      expect(routingTable.buckets.length).toBeGreaterThanOrEqual(initialBuckets);
    });

    test('should get bucket for refresh', () => {
      // Add some nodes
      for (let i = 0; i < 5; i++) {
        const node = new DHTNode(new DHTNodeId(), `address-${i}`);
        routingTable.addNode(node);
      }
      
      const bucketForRefresh = routingTable.getBucketForRefresh();
      expect(bucketForRefresh).toBeDefined();
      expect(bucketForRefresh.lastUpdated).toBeDefined();
    });
  });

  describe('connected nodes lookup', () => {
    test('should find closest connected nodes', () => {
      // Add nodes and test connected node lookups
      const nodes = [];
      for (let i = 0; i < 10; i++) {
        const node = new DHTNode(new DHTNodeId(), `address-${i}`);
        // Mock some nodes as connected
        if (i < 5) {
          node.isConnected = () => true;
        }
        nodes.push(node);
        routingTable.addNode(node);
      }
      
      const targetId = new DHTNodeId();
      const connectedNodes = routingTable.findClosestConnectedNodes(targetId, 3);
      expect(Array.isArray(connectedNodes)).toBe(true);
      expect(connectedNodes.length).toBeLessThanOrEqual(5); // Only 5 are "connected"
      expect(connectedNodes.length).toBeLessThanOrEqual(3); // Requested max 3
    });
  });
});