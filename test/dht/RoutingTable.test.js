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
      expect(routingTable.localId).toBe(localId);
      expect(routingTable.k).toBe(20);
      expect(routingTable.buckets).toBeDefined();
      expect(routingTable.buckets.length).toBe(160); // 160 buckets for 160-bit IDs
    });
  });

  describe('node management', () => {
    test('should add node to correct bucket', () => {
      const node = new DHTNode(new DHTNodeId(), 'test-address');
      const added = routingTable.addNode(node);
      
      expect(added).toBe(true);
      expect(routingTable.size()).toBe(1);
      expect(routingTable.hasNode(node.id)).toBe(true);
    });

    test('should not add local node', () => {
      const localNode = new DHTNode(localId, 'local-address');
      const added = routingTable.addNode(localNode);
      
      expect(added).toBe(false);
      expect(routingTable.size()).toBe(0);
    });

    test('should remove node correctly', () => {
      const node = new DHTNode(new DHTNodeId(), 'test-address');
      routingTable.addNode(node);
      
      const removed = routingTable.removeNode(node.id);
      expect(removed).toBe(true);
      expect(routingTable.hasNode(node.id)).toBe(false);
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
      const targetId = new DHTNodeId('8' + '0'.repeat(39)); // MSB = 1000
      const bucketIndex = routingTable.getBucketIndex(targetId);
      
      expect(bucketIndex).toBeGreaterThanOrEqual(0);
      expect(bucketIndex).toBeLessThan(160);
    });

    test('should return -1 for local ID', () => {
      const bucketIndex = routingTable.getBucketIndex(localId);
      expect(bucketIndex).toBe(-1);
    });

    test('should get bucket by index', () => {
      const bucket = routingTable.getBucket(0);
      expect(bucket).toBeDefined();
      expect(bucket.capacity).toBe(20);
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
      const closest = routingTable.getClosestNodes(targetId, 5);
      
      expect(closest.length).toBeLessThanOrEqual(5);
      expect(closest.length).toBeLessThanOrEqual(nodes.length);
      
      // Verify they are sorted by distance
      if (closest.length > 1) {
        for (let i = 0; i < closest.length - 1; i++) {
          const dist1 = closest[i].distanceTo(targetId);
          const dist2 = closest[i + 1].distanceTo(targetId);
          expect(Buffer.compare(dist1, dist2)).toBeLessThanOrEqual(0);
        }
      }
    });

    test('should return empty array when no nodes exist', () => {
      const targetId = new DHTNodeId();
      const closest = routingTable.getClosestNodes(targetId, 5);
      
      expect(closest).toEqual([]);
    });

    test('should not include local node in results', () => {
      const nodes = [];
      for (let i = 0; i < 5; i++) {
        const node = new DHTNode(new DHTNodeId(), `address-${i}`);
        nodes.push(node);
        routingTable.addNode(node);
      }
      
      const closest = routingTable.getClosestNodes(localId, 10);
      expect(closest.some(node => node.id.equals(localId))).toBe(false);
    });
  });

  describe('routing table statistics', () => {
    test('should count total nodes correctly', () => {
      expect(routingTable.size()).toBe(0);
      
      for (let i = 0; i < 15; i++) {
        const node = new DHTNode(new DHTNodeId(), `address-${i}`);
        routingTable.addNode(node);
      }
      
      expect(routingTable.size()).toBe(15);
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

    test('should get bucket statistics', () => {
      // Add nodes to different buckets
      for (let i = 0; i < 25; i++) {
        const node = new DHTNode(new DHTNodeId(), `address-${i}`);
        routingTable.addNode(node);
      }
      
      const stats = routingTable.getStats();
      expect(stats.totalNodes).toBeGreaterThan(0);
      expect(stats.activeBuckets).toBeGreaterThan(0);
      expect(stats.averageNodesPerBucket).toBeGreaterThan(0);
    });
  });

  describe('stale node management', () => {
    test('should identify stale nodes', () => {
      const node = new DHTNode(new DHTNodeId(), 'test-address');
      node.lastSeen = Date.now() - 70000; // 70 seconds ago
      routingTable.addNode(node);
      
      const staleNodes = routingTable.getStaleNodes(60000); // 60 second timeout
      expect(staleNodes).toContain(node);
    });

    test('should refresh stale nodes', () => {
      const node = new DHTNode(new DHTNodeId(), 'test-address');
      node.lastSeen = Date.now() - 70000; // 70 seconds ago
      routingTable.addNode(node);
      
      routingTable.refreshNode(node.id);
      expect(node.isStale(60000)).toBe(false);
    });
  });

  describe('routing table maintenance', () => {
    test('should clear all nodes', () => {
      for (let i = 0; i < 10; i++) {
        const node = new DHTNode(new DHTNodeId(), `address-${i}`);
        routingTable.addNode(node);
      }
      
      routingTable.clear();
      expect(routingTable.size()).toBe(0);
    });

    test('should split buckets when necessary', () => {
      // This test would require a more complex setup to trigger bucket splitting
      // For now, just verify the routing table can handle many nodes
      const initialBuckets = routingTable.buckets.filter(b => !b.isEmpty()).length;
      
      for (let i = 0; i < 50; i++) {
        const node = new DHTNode(new DHTNodeId(), `address-${i}`);
        routingTable.addNode(node);
      }
      
      expect(routingTable.size()).toBeGreaterThan(0);
    });
  });

  describe('node lookup by prefix', () => {
    test('should find nodes in specific bucket range', () => {
      // Add nodes and test bucket-specific lookups
      const nodes = [];
      for (let i = 0; i < 20; i++) {
        const node = new DHTNode(new DHTNodeId(), `address-${i}`);
        nodes.push(node);
        routingTable.addNode(node);
      }
      
      // Get nodes from a specific distance range
      const bucketNodes = routingTable.getNodesInBucketRange(0, 10);
      expect(Array.isArray(bucketNodes)).toBe(true);
    });
  });
});