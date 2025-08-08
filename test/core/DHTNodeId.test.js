import { DHTNodeId } from '../../src/core/DHTNodeId.js';

describe('DHTNodeId', () => {
  describe('constructor', () => {
    test('should create a valid 160-bit node ID', () => {
      const nodeId = new DHTNodeId();
      expect(nodeId.id).toBeDefined();
      expect(nodeId.id.length).toBe(20); // 160 bits = 20 bytes
    });

    test('should create from string', () => {
      const idString = 'a'.repeat(40); // 40 hex chars = 160 bits
      const nodeId = new DHTNodeId(idString);
      expect(nodeId.toString()).toBe(idString);
    });

    test('should create from buffer', () => {
      const buffer = Buffer.alloc(20, 0xaa);
      const nodeId = new DHTNodeId(buffer);
      expect(nodeId.id).toEqual(buffer);
    });

    test('should throw on invalid input', () => {
      expect(() => new DHTNodeId('invalid')).toThrow();
      expect(() => new DHTNodeId(Buffer.alloc(19))).toThrow(); // Wrong size
    });
  });

  describe('XOR distance calculation', () => {
    test('should calculate distance between two node IDs', () => {
      const id1 = new DHTNodeId('0'.repeat(40));
      const id2 = new DHTNodeId('f'.repeat(40));
      
      const distance = id1.distance(id2);
      expect(distance).toBeDefined();
      expect(distance.length).toBe(20);
    });

    test('should return zero distance for identical IDs', () => {
      const id1 = new DHTNodeId('a'.repeat(40));
      const id2 = new DHTNodeId('a'.repeat(40));
      
      const distance = id1.distance(id2);
      const isZero = distance.every(byte => byte === 0);
      expect(isZero).toBe(true);
    });

    test('should be symmetric', () => {
      const id1 = new DHTNodeId();
      const id2 = new DHTNodeId();
      
      const dist1to2 = id1.distance(id2);
      const dist2to1 = id2.distance(id1);
      
      expect(dist1to2).toEqual(dist2to1);
    });
  });

  describe('bucket index calculation', () => {
    test('should calculate correct bucket index', () => {
      const id1 = new DHTNodeId('0'.repeat(40));
      const id2 = new DHTNodeId('8' + '0'.repeat(39)); // MSB = 1000
      
      const bucketIndex = id1.bucketIndex(id2);
      expect(bucketIndex).toBe(159); // 160 - 1 for MSB position
    });

    test('should return -1 for identical IDs', () => {
      const id1 = new DHTNodeId('a'.repeat(40));
      const id2 = new DHTNodeId('a'.repeat(40));
      
      const bucketIndex = id1.bucketIndex(id2);
      expect(bucketIndex).toBe(-1);
    });
  });

  describe('comparison methods', () => {
    test('should compare node IDs correctly', () => {
      const id1 = new DHTNodeId('1'.repeat(40));
      const id2 = new DHTNodeId('2'.repeat(40));
      const id3 = new DHTNodeId('1'.repeat(40));
      
      expect(id1.equals(id2)).toBe(false);
      expect(id1.equals(id3)).toBe(true);
      expect(id1.compare(id2)).toBeLessThan(0);
      expect(id2.compare(id1)).toBeGreaterThan(0);
      expect(id1.compare(id3)).toBe(0);
    });
  });

  describe('serialization', () => {
    test('should convert to string correctly', () => {
      const nodeId = new DHTNodeId();
      const str = nodeId.toString();
      
      expect(typeof str).toBe('string');
      expect(str.length).toBe(40); // 20 bytes * 2 hex chars
      expect(/^[0-9a-f]+$/.test(str)).toBe(true);
    });

    test('should round-trip correctly', () => {
      const original = new DHTNodeId();
      const str = original.toString();
      const restored = new DHTNodeId(str);
      
      expect(original.equals(restored)).toBe(true);
    });
  });

  describe('utility methods', () => {
    test('should generate random node IDs', () => {
      const id1 = DHTNodeId.generate();
      const id2 = DHTNodeId.generate();
      
      expect(id1.equals(id2)).toBe(false);
      expect(id1.id.length).toBe(20);
      expect(id2.id.length).toBe(20);
    });

    test('should create from hash', () => {
      const data = 'test-data';
      const nodeId = DHTNodeId.fromHash(data);
      
      expect(nodeId.id.length).toBe(20);
      
      // Same input should produce same hash
      const nodeId2 = DHTNodeId.fromHash(data);
      expect(nodeId.equals(nodeId2)).toBe(true);
    });
  });
});