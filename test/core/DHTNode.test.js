import { DHTNode } from '../../src/core/DHTNode.js';
import { DHTNodeId } from '../../src/core/DHTNodeId.js';

describe('DHTNode', () => {
  describe('constructor', () => {
    test('should create node with required properties', () => {
      const id = new DHTNodeId();
      const endpoint = 'test-endpoint';
      const node = new DHTNode(id, endpoint);
      
      expect(node.id).toBe(id);
      expect(node.endpoint).toBe(endpoint);
      expect(node.lastSeen).toBeDefined();
      expect(typeof node.lastSeen).toBe('number');
    });

    test('should create node with connection', () => {
      const id = new DHTNodeId();
      const endpoint = 'test-endpoint';
      const connection = { readyState: 'open' };
      const node = new DHTNode(id, endpoint, connection);
      
      expect(node.connection).toBe(connection);
    });

    test('should initialize lastSeen to current time', () => {
      const beforeCreate = Date.now();
      const node = new DHTNode(new DHTNodeId(), 'test-endpoint');
      const afterCreate = Date.now();
      
      expect(node.lastSeen).toBeGreaterThanOrEqual(beforeCreate);
      expect(node.lastSeen).toBeLessThanOrEqual(afterCreate);
    });
  });

  describe('distance calculation', () => {
    test('should calculate distance to another node', () => {
      const id1 = DHTNodeId.fromHex('0'.repeat(40));
      const id2 = DHTNodeId.fromHex('f'.repeat(40));
      const node1 = new DHTNode(id1, 'endpoint1');
      const node2 = new DHTNode(id2, 'endpoint2');
      
      const distance = node1.distanceTo(node2.id);
      expect(distance).toBeDefined();
      expect(distance.bytes.length).toBe(20);
    });

    test('should calculate distance to node ID', () => {
      const id1 = DHTNodeId.fromHex('0'.repeat(40));
      const id2 = DHTNodeId.fromHex('f'.repeat(40));
      const node = new DHTNode(id1, 'endpoint');
      
      const distance = node.distanceTo(id2);
      expect(distance).toBeDefined();
      expect(distance.bytes.length).toBe(20);
    });
  });

  describe('activity tracking', () => {
    test('should update last seen time', async () => {
      const node = new DHTNode(new DHTNodeId(), 'test-endpoint');
      const initialTime = node.lastSeen;
      
      // Wait a bit and update
      await new Promise(resolve => setTimeout(resolve, 10));
      node.updateLastSeen();
      expect(node.lastSeen).toBeGreaterThan(initialTime);
    });

    test('should check if node is stale', () => {
      const node = new DHTNode(new DHTNodeId(), 'test-endpoint');
      
      // Fresh node should not be stale
      expect(node.isStale(60000)).toBe(false);
      
      // Set last seen to old time
      node.lastSeen = Date.now() - 70000; // 70 seconds ago
      expect(node.isStale(60000)).toBe(true); // 60 second timeout
    });

    test('should record ping response', async () => {
      const node = new DHTNode(new DHTNodeId(), 'test-endpoint');
      const initialTime = node.lastSeen;
      const rtt = 150;
      
      // Wait a bit to ensure different timestamp
      await new Promise(resolve => setTimeout(resolve, 10));
      node.recordPing(rtt);
      expect(node.rtt).toBe(rtt);
      expect(node.lastPing).toBeGreaterThan(0);
      expect(node.lastSeen).toBeGreaterThanOrEqual(initialTime);
    });
  });

  describe('node comparison', () => {
    test('should compare nodes by ID equality', () => {
      const id1 = DHTNodeId.fromHex('a'.repeat(40));
      const id2 = DHTNodeId.fromHex('b'.repeat(40));
      
      const node1a = new DHTNode(id1, 'endpoint1');
      const node1b = new DHTNode(id1, 'endpoint2'); // Same ID, different endpoint
      const node2 = new DHTNode(id2, 'endpoint1');
      
      expect(node1a.id.equals(node1b.id)).toBe(true); // Same ID
      expect(node1a.id.equals(node2.id)).toBe(false); // Different ID
    });

    test('should compare distance to target', () => {
      const target = DHTNodeId.fromHex('8'.repeat(40));
      const id1 = DHTNodeId.fromHex('0'.repeat(40));
      const id2 = DHTNodeId.fromHex('f'.repeat(40));
      
      const node1 = new DHTNode(id1, 'endpoint1');
      const node2 = new DHTNode(id2, 'endpoint2');
      
      const isCloser = node1.isCloserTo(target, node2);
      expect(typeof isCloser).toBe('boolean');
    });
  });

  describe('serialization', () => {
    test('should convert to JSON correctly', () => {
      const id = DHTNodeId.fromHex('a'.repeat(40));
      const node = new DHTNode(id, 'test-endpoint');
      
      const json = node.toJSON();
      
      expect(json.id).toBe(id.toString());
      expect(json.endpoint).toBe('test-endpoint');
      expect(json.lastSeen).toBe(node.lastSeen);
      expect(json.isAlive).toBe(true);
      expect(json.failureCount).toBe(0);
    });

    test('should create from compact representation', () => {
      const compact = {
        id: 'a'.repeat(40),
        endpoint: 'test-endpoint',
        lastSeen: Date.now(),
        capabilities: ['store', 'find'],
        metadata: { type: 'test' }
      };
      
      const node = DHTNode.fromCompact(compact);
      
      expect(node.id.toString()).toBe(compact.id);
      expect(node.endpoint).toBe(compact.endpoint);
      expect(node.lastSeen).toBe(compact.lastSeen);
      expect(node.hasCapability('store')).toBe(true);
      expect(node.getMetadata('type')).toBe('test');
    });

    test('should create compact representation', () => {
      const node = new DHTNode(new DHTNodeId(), 'test-endpoint');
      node.addCapability('store');
      node.setMetadata('type', 'test');
      
      const compact = node.toCompact();
      
      expect(compact.id).toBe(node.id.toString());
      expect(compact.endpoint).toBe('test-endpoint');
      expect(compact.capabilities).toContain('store');
      expect(compact.metadata.type).toBe('test');
    });
  });

  describe('capabilities and metadata', () => {
    test('should manage capabilities', () => {
      const node = new DHTNode(new DHTNodeId(), 'test-endpoint');
      
      expect(node.hasCapability('store')).toBe(false);
      
      node.addCapability('store');
      expect(node.hasCapability('store')).toBe(true);
      
      node.removeCapability('store');
      expect(node.hasCapability('store')).toBe(false);
    });

    test('should manage metadata', () => {
      const node = new DHTNode(new DHTNodeId(), 'test-endpoint');
      
      expect(node.getMetadata('type')).toBeUndefined();
      
      node.setMetadata('type', 'bridge');
      expect(node.getMetadata('type')).toBe('bridge');
    });

    test('should calculate quality score', () => {
      const node = new DHTNode(new DHTNodeId(), 'test-endpoint');
      
      const score = node.getQualityScore();
      expect(typeof score).toBe('number');
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });

    test('should handle connection state', () => {
      const node = new DHTNode(new DHTNodeId(), 'test-endpoint');
      
      expect(node.getConnectionState()).toBe('disconnected');
      expect(node.isConnected()).toBe(false);
    });
  });
});