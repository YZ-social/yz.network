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
      expect(bucket.capacity).toBe(20);
      expect(bucket.isEmpty()).toBe(true);
      expect(bucket.isFull()).toBe(false);
    });
  });

  describe('node management', () => {
    test('should add nodes correctly', () => {
      const node = new DHTNode(new DHTNodeId(), 'test-address');
      
      const added = bucket.add(node);
      expect(added).toBe(true);
      expect(bucket.size()).toBe(1);
      expect(bucket.contains(node.id)).toBe(true);
    });

    test('should not add duplicate nodes', () => {
      const node = new DHTNode(new DHTNodeId(), 'test-address');
      
      bucket.add(node);
      const addedAgain = bucket.add(node);
      
      expect(addedAgain).toBe(false);
      expect(bucket.size()).toBe(1);
    });

    test('should move existing node to tail when re-added', () => {
      const node1 = new DHTNode(new DHTNodeId(), 'address1');
      const node2 = new DHTNode(new DHTNodeId(), 'address2');
      
      bucket.add(node1);
      bucket.add(node2);
      
      // Re-add node1 - should move to tail
      bucket.add(node1);
      
      const nodes = bucket.getNodes();
      expect(nodes[nodes.length - 1]).toBe(node1);
    });

    test('should remove nodes correctly', () => {
      const node = new DHTNode(new DHTNodeId(), 'test-address');
      
      bucket.add(node);
      const removed = bucket.remove(node.id);
      
      expect(removed).toBe(true);
      expect(bucket.size()).toBe(0);
      expect(bucket.contains(node.id)).toBe(false);
    });

    test('should not remove non-existent nodes', () => {
      const nodeId = new DHTNodeId();
      const removed = bucket.remove(nodeId);
      
      expect(removed).toBe(false);
    });
  });

  describe('capacity management', () => {
    test('should become full when at capacity', () => {
      // Fill bucket to capacity
      for (let i = 0; i < 20; i++) {
        const node = new DHTNode(new DHTNodeId(), `address-${i}`);
        bucket.add(node);
      }
      
      expect(bucket.isFull()).toBe(true);
      expect(bucket.size()).toBe(20);
    });

    test('should reject new nodes when full', () => {
      // Fill bucket to capacity
      for (let i = 0; i < 20; i++) {
        const node = new DHTNode(new DHTNodeId(), `address-${i}`);
        bucket.add(node);
      }
      
      // Try to add one more
      const extraNode = new DHTNode(new DHTNodeId(), 'extra-address');
      const added = bucket.add(extraNode);
      
      expect(added).toBe(false);
      expect(bucket.size()).toBe(20);
    });

    test('should get head node for eviction candidate', () => {
      const node1 = new DHTNode(new DHTNodeId(), 'address1');
      const node2 = new DHTNode(new DHTNodeId(), 'address2');
      
      bucket.add(node1);
      bucket.add(node2);
      
      const head = bucket.getHead();
      expect(head).toBe(node1); // First added should be head
    });

    test('should get tail node for most recent', () => {
      const node1 = new DHTNode(new DHTNodeId(), 'address1');
      const node2 = new DHTNode(new DHTNodeId(), 'address2');
      
      bucket.add(node1);
      bucket.add(node2);
      
      const tail = bucket.getTail();
      expect(tail).toBe(node2); // Last added should be tail
    });
  });

  describe('node lookup', () => {
    test('should find nodes by ID', () => {
      const node = new DHTNode(new DHTNodeId(), 'test-address');
      bucket.add(node);
      
      const found = bucket.get(node.id);
      expect(found).toBe(node);
    });

    test('should return null for non-existent nodes', () => {
      const nodeId = new DHTNodeId();
      const found = bucket.get(nodeId);
      
      expect(found).toBeNull();
    });

    test('should return all nodes in order', () => {
      const nodes = [];
      for (let i = 0; i < 5; i++) {
        const node = new DHTNode(new DHTNodeId(), `address-${i}`);
        nodes.push(node);
        bucket.add(node);
      }
      
      const bucketNodes = bucket.getNodes();
      expect(bucketNodes).toEqual(nodes);
    });
  });

  describe('bucket state', () => {
    test('should clear all nodes', () => {
      for (let i = 0; i < 5; i++) {
        const node = new DHTNode(new DHTNodeId(), `address-${i}`);
        bucket.add(node);
      }
      
      bucket.clear();
      expect(bucket.size()).toBe(0);
      expect(bucket.isEmpty()).toBe(true);
    });

    test('should get closest nodes to target', () => {
      const targetId = new DHTNodeId('8' + '0'.repeat(39));
      
      // Add nodes with various distances
      const nodes = [];
      for (let i = 0; i < 10; i++) {
        const node = new DHTNode(new DHTNodeId(), `address-${i}`);
        nodes.push(node);
        bucket.add(node);
      }
      
      const closest = bucket.getClosestNodes(targetId, 3);
      expect(closest.length).toBeLessThanOrEqual(3);
    });
  });

  describe('last seen tracking', () => {
    test('should update last seen time on activity', () => {
      const node = new DHTNode(new DHTNodeId(), 'test-address');
      bucket.add(node);
      
      const initialTime = node.lastSeen;
      
      // Simulate some time passing
      setTimeout(() => {
        bucket.touch(node.id);
        expect(node.lastSeen).toBeGreaterThan(initialTime);
      }, 10);
    });

    test('should get stale nodes based on timeout', () => {
      const node = new DHTNode(new DHTNodeId(), 'test-address');
      node.lastSeen = Date.now() - 70000; // 70 seconds ago
      bucket.add(node);
      
      const staleNodes = bucket.getStaleNodes(60000); // 60 second timeout
      expect(staleNodes).toContain(node);
    });
  });
});