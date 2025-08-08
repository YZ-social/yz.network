import { DHTNode } from '../../src/core/DHTNode.js';
import { DHTNodeId } from '../../src/core/DHTNodeId.js';

describe('DHTNode', () => {
  describe('constructor', () => {
    test('should create node with required properties', () => {
      const id = new DHTNodeId();
      const address = 'test-address';
      const node = new DHTNode(id, address);
      
      expect(node.id).toBe(id);
      expect(node.address).toBe(address);
      expect(node.lastSeen).toBeDefined();
      expect(typeof node.lastSeen).toBe('number');
    });

    test('should create node with optional port', () => {
      const id = new DHTNodeId();
      const address = 'test-address';
      const port = 8080;
      const node = new DHTNode(id, address, port);
      
      expect(node.port).toBe(port);
    });

    test('should initialize lastSeen to current time', () => {
      const beforeCreate = Date.now();
      const node = new DHTNode(new DHTNodeId(), 'test-address');
      const afterCreate = Date.now();
      
      expect(node.lastSeen).toBeGreaterThanOrEqual(beforeCreate);
      expect(node.lastSeen).toBeLessThanOrEqual(afterCreate);
    });
  });

  describe('distance calculation', () => {
    test('should calculate distance to another node', () => {
      const id1 = new DHTNodeId('0'.repeat(40));
      const id2 = new DHTNodeId('f'.repeat(40));
      const node1 = new DHTNode(id1, 'address1');
      const node2 = new DHTNode(id2, 'address2');
      
      const distance = node1.distanceTo(node2);
      expect(distance).toBeDefined();
      expect(distance.length).toBe(20);
    });

    test('should calculate distance to node ID', () => {
      const id1 = new DHTNodeId('0'.repeat(40));
      const id2 = new DHTNodeId('f'.repeat(40));
      const node = new DHTNode(id1, 'address');
      
      const distance = node.distanceTo(id2);
      expect(distance).toBeDefined();
      expect(distance.length).toBe(20);
    });
  });

  describe('activity tracking', () => {
    test('should update last seen time', () => {
      const node = new DHTNode(new DHTNodeId(), 'test-address');
      const initialTime = node.lastSeen;
      
      // Wait a bit and update
      setTimeout(() => {
        node.updateLastSeen();
        expect(node.lastSeen).toBeGreaterThan(initialTime);
      }, 10);
    });

    test('should check if node is stale', () => {
      const node = new DHTNode(new DHTNodeId(), 'test-address');
      
      // Fresh node should not be stale
      expect(node.isStale(60000)).toBe(false);
      
      // Set last seen to old time
      node.lastSeen = Date.now() - 70000; // 70 seconds ago
      expect(node.isStale(60000)).toBe(true); // 60 second timeout
    });

    test('should get age in milliseconds', () => {
      const node = new DHTNode(new DHTNodeId(), 'test-address');
      node.lastSeen = Date.now() - 5000; // 5 seconds ago
      
      const age = node.getAge();
      expect(age).toBeGreaterThanOrEqual(4900); // Allow some tolerance
      expect(age).toBeLessThanOrEqual(5100);
    });
  });

  describe('node comparison', () => {
    test('should compare nodes for equality', () => {
      const id1 = new DHTNodeId('a'.repeat(40));
      const id2 = new DHTNodeId('b'.repeat(40));
      
      const node1a = new DHTNode(id1, 'address1');
      const node1b = new DHTNode(id1, 'address2'); // Same ID, different address
      const node2 = new DHTNode(id2, 'address1');
      
      expect(node1a.equals(node1b)).toBe(true); // Same ID
      expect(node1a.equals(node2)).toBe(false); // Different ID
    });

    test('should compare distance to target', () => {
      const target = new DHTNodeId('8'.repeat(40));
      const id1 = new DHTNodeId('0'.repeat(40));
      const id2 = new DHTNodeId('f'.repeat(40));
      
      const node1 = new DHTNode(id1, 'address1');
      const node2 = new DHTNode(id2, 'address2');
      
      const comparison = node1.compareDistanceTo(node2, target);
      expect(typeof comparison).toBe('number');
    });
  });

  describe('serialization', () => {
    test('should convert to JSON correctly', () => {
      const id = new DHTNodeId('a'.repeat(40));
      const node = new DHTNode(id, 'test-address', 8080);
      
      const json = node.toJSON();
      
      expect(json.id).toBe(id.toString());
      expect(json.address).toBe('test-address');
      expect(json.port).toBe(8080);
      expect(json.lastSeen).toBe(node.lastSeen);
    });

    test('should create from JSON correctly', () => {
      const json = {
        id: 'a'.repeat(40),
        address: 'test-address',
        port: 8080,
        lastSeen: Date.now()
      };
      
      const node = DHTNode.fromJSON(json);
      
      expect(node.id.toString()).toBe(json.id);
      expect(node.address).toBe(json.address);
      expect(node.port).toBe(json.port);
      expect(node.lastSeen).toBe(json.lastSeen);
    });

    test('should round-trip through JSON correctly', () => {
      const original = new DHTNode(new DHTNodeId(), 'test-address', 8080);
      const json = original.toJSON();
      const restored = DHTNode.fromJSON(json);
      
      expect(original.equals(restored)).toBe(true);
      expect(restored.address).toBe(original.address);
      expect(restored.port).toBe(original.port);
      expect(restored.lastSeen).toBe(original.lastSeen);
    });
  });

  describe('contact information', () => {
    test('should get full address with port', () => {
      const node = new DHTNode(new DHTNodeId(), 'localhost', 8080);
      expect(node.getFullAddress()).toBe('localhost:8080');
    });

    test('should get address without port if not specified', () => {
      const node = new DHTNode(new DHTNodeId(), 'localhost');
      expect(node.getFullAddress()).toBe('localhost');
    });

    test('should check if node is reachable', () => {
      const reachableNode = new DHTNode(new DHTNodeId(), 'localhost', 8080);
      const unreachableNode = new DHTNode(new DHTNodeId(), '');
      
      expect(reachableNode.isReachable()).toBe(true);
      expect(unreachableNode.isReachable()).toBe(false);
    });
  });
});