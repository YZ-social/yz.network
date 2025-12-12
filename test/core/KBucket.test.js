import { KBucket } from '../../src/core/KBucket.js';
import { DHTNode } from '../../src/core/DHTNode.js';
import { DHTNodeId } from '../../src/core/DHTNodeId.js';

describe('KBucket', () => {
  let bucket;
  
  beforeEach(() => {
    bucket = new KBucket(20); // k = 20
  });

  describe('constructor', () => {
    test('should create empty bucket with correct capacity', () => {
      expect(bucket.size()).toBe(0);
      expect(bucket.k).toBe(20);
      expect(bucket.isEmpty()).toBe(true);
      expect(bucket.isFull()).toBe(false);
    });
  });

  describe('node management', () => {
    test('should add nodes correctly', () => {
      const node = new DHTNode(new DHTNodeId(), 'test-address');
      
      const added = bucket.addNode(node);
      expect(added).toBe(true);
      expect(bucket.size()).toBe(1);
      expect(bucket.hasNode(node.id)).toBe(true);
    });

    test('should not add duplicate nodes but update existing', () => {
      const node = new DHTNode(new DHTNodeId(), 'test-address');
      
      bucket.addNode(node);
      const addedAgain = bucket.addNode(node);
      
      expect(addedAgain).toBe(true); // Returns true for updates
      expect(bucket.size()).toBe(1);
    });

    test('should move existing node to tail when re-added', () => {
      const node1 = new DHTNode(new DHTNodeId(), 'address1');
      const node2 = new DHTNode(new DHTNodeId(), 'address2');
      
      bucket.addNode(node1);
      bucket.addNode(node2);
      
      // Re-add node1 - should move to tail
      bucket.addNode(node1);
      
      const nodes = bucket.getNodes();
      expect(nodes[nodes.length - 1]).toBe(node1);
    });

    test('should remove nodes correctly', () => {
      const node = new DHTNode(new DHTNodeId(), 'test-address');
      
      bucket.addNode(node);
      const removed = bucket.removeNode(node.id);
      
      expect(removed).toBe(true);
      expect(bucket.size()).toBe(0);
      expect(bucket.hasNode(node.id)).toBe(false);
    });

    test('should not remove non-existent nodes', () => {
      const nodeId = new DHTNodeId();
      const removed = bucket.removeNode(nodeId);
      
      expect(removed).toBe(false);
    });
  });

  describe('capacity management', () => {
    test('should become full when at capacity', () => {
      // Fill bucket to capacity
      for (let i = 0; i < 20; i++) {
        const node = new DHTNode(new DHTNodeId(), `address-${i}`);
        bucket.addNode(node);
      }
      
      expect(bucket.isFull()).toBe(true);
      expect(bucket.size()).toBe(20);
    });

    test('should reject new nodes when full', () => {
      // Fill bucket to capacity
      for (let i = 0; i < 20; i++) {
        const node = new DHTNode(new DHTNodeId(), `address-${i}`);
        bucket.addNode(node);
      }
      
      // Try to add one more
      const extraNode = new DHTNode(new DHTNodeId(), 'extra-address');
      const added = bucket.addNode(extraNode);
      
      expect(added).toBe(false);
      expect(bucket.size()).toBe(20);
    });

    test('should get least recently seen node', async () => {
      const node1 = new DHTNode(new DHTNodeId(), 'address1');
      const node2 = new DHTNode(new DHTNodeId(), 'address2');
      
      bucket.addNode(node1);
      // Wait a bit to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10));
      bucket.addNode(node2);
      
      const leastRecent = bucket.getLeastRecentlySeenNode();
      expect(leastRecent).toBe(node1); // First added should be least recent
    });

    test('should get nodes by last seen order', async () => {
      const node1 = new DHTNode(new DHTNodeId(), 'address1');
      const node2 = new DHTNode(new DHTNodeId(), 'address2');
      
      bucket.addNode(node1);
      await new Promise(resolve => setTimeout(resolve, 10));
      bucket.addNode(node2);
      
      const nodesByLastSeen = bucket.getNodesByLastSeen();
      expect(nodesByLastSeen[0]).toBe(node2); // Most recent first
      expect(nodesByLastSeen[1]).toBe(node1);
    });
  });

  describe('node lookup', () => {
    test('should find nodes by ID', () => {
      const node = new DHTNode(new DHTNodeId(), 'test-address');
      bucket.addNode(node);
      
      const found = bucket.getNode(node.id);
      expect(found).toBe(node);
    });

    test('should return undefined for non-existent nodes', () => {
      const nodeId = new DHTNodeId();
      const found = bucket.getNode(nodeId);
      
      expect(found).toBeUndefined();
    });

    test('should return all nodes in order', () => {
      const nodes = [];
      for (let i = 0; i < 5; i++) {
        const node = new DHTNode(new DHTNodeId(), `address-${i}`);
        nodes.push(node);
        bucket.addNode(node);
      }
      
      const bucketNodes = bucket.getNodes();
      expect(bucketNodes).toEqual(nodes);
    });
  });

  describe('bucket state', () => {
    test('should remove stale nodes', () => {
      for (let i = 0; i < 5; i++) {
        const node = new DHTNode(new DHTNodeId(), `address-${i}`);
        bucket.addNode(node);
        // Make nodes stale AFTER adding them
        node.lastSeen = Date.now() - 20 * 60 * 1000; // 20 minutes ago
      }
      
      const removed = bucket.removeStaleNodes(15 * 60 * 1000); // 15 minute threshold
      expect(removed).toBe(5);
      expect(bucket.size()).toBe(0);
      expect(bucket.isEmpty()).toBe(true);
    });

    test('should split bucket correctly', () => {
      // Add nodes to bucket
      for (let i = 0; i < 10; i++) {
        const node = new DHTNode(new DHTNodeId(), `address-${i}`);
        bucket.addNode(node);
      }
      
      const { leftBucket, rightBucket } = bucket.split();
      
      expect(leftBucket).toBeDefined();
      expect(rightBucket).toBeDefined();
      expect(leftBucket.depth).toBe(bucket.depth + 1);
      expect(rightBucket.depth).toBe(bucket.depth + 1);
      expect(leftBucket.size() + rightBucket.size()).toBe(bucket.size());
    });

    test('should get bucket statistics', () => {
      for (let i = 0; i < 5; i++) {
        const node = new DHTNode(new DHTNodeId(), `address-${i}`);
        bucket.addNode(node);
      }
      
      const stats = bucket.getStats();
      expect(stats.size).toBe(5);
      expect(stats.capacity).toBe(20);
      expect(stats.depth).toBe(0);
      expect(stats.lastUpdated).toBeDefined();
    });
  });

  describe('last seen tracking', () => {
    test('should update last seen time when node is re-added', async () => {
      const node = new DHTNode(new DHTNodeId(), 'test-address');
      bucket.addNode(node);
      
      const initialTime = node.lastSeen;
      
      // Simulate some time passing
      await new Promise(resolve => setTimeout(resolve, 10));
      bucket.addNode(node); // Re-adding updates lastSeen
      expect(node.lastSeen).toBeGreaterThan(initialTime);
    });

    test('should identify stale nodes correctly', () => {
      const node = new DHTNode(new DHTNodeId(), 'test-address');
      bucket.addNode(node);
      // Make node stale AFTER adding it
      node.lastSeen = Date.now() - 70 * 1000; // 70 seconds ago
      
      expect(node.isStale(60 * 1000)).toBe(true); // 60 second timeout
      expect(node.isStale(80 * 1000)).toBe(false); // 80 second timeout
    });
  });
});