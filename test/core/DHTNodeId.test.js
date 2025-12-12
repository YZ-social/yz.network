import { DHTNodeId } from '../../src/core/DHTNodeId.js';

describe('DHTNodeId', () => {
  describe('constructor', () => {
    test('should create a valid 160-bit node ID', () => {
      const nodeId = new DHTNodeId();
      expect(nodeId.bytes).toBeDefined();
      expect(nodeId.bytes.length).toBe(20); // 160 bits = 20 bytes
    });

    test('should create from hex string', () => {
      const idString = 'a'.repeat(40); // 40 hex chars = 160 bits
      const nodeId = DHTNodeId.fromHex(idString);
      expect(nodeId.toString()).toBe(idString);
    });

    test('should create from bytes', () => {
      const bytes = new Uint8Array(20);
      bytes.fill(0xaa);
      const nodeId = new DHTNodeId(bytes);
      expect(nodeId.bytes).toEqual(bytes);
    });

    test('should throw on invalid input', () => {
      expect(() => DHTNodeId.fromHex('invalid')).toThrow();
      expect(() => new DHTNodeId(new Uint8Array(19))).toThrow(); // Wrong size
    });
  });

  describe('XOR distance calculation', () => {
    test('should calculate distance between two node IDs', () => {
      const id1 = DHTNodeId.fromHex('0'.repeat(40));
      const id2 = DHTNodeId.fromHex('f'.repeat(40));
      
      const distance = id1.xorDistance(id2);
      expect(distance).toBeDefined();
      expect(distance.bytes.length).toBe(20);
    });

    test('should return zero distance for identical IDs', () => {
      const id1 = DHTNodeId.fromHex('a'.repeat(40));
      const id2 = DHTNodeId.fromHex('a'.repeat(40));
      
      const distance = id1.xorDistance(id2);
      const isZero = Array.from(distance.bytes).every(byte => byte === 0);
      expect(isZero).toBe(true);
    });

    test('should be symmetric', () => {
      const id1 = new DHTNodeId();
      const id2 = new DHTNodeId();
      
      const dist1to2 = id1.xorDistance(id2);
      const dist2to1 = id2.xorDistance(id1);
      
      expect(dist1to2.bytes).toEqual(dist2to1.bytes);
    });
  });

  describe('leading zero bits calculation', () => {
    test('should calculate leading zero bits correctly', () => {
      const id1 = DHTNodeId.fromHex('0'.repeat(40));
      const id2 = DHTNodeId.fromHex('8' + '0'.repeat(39)); // MSB = 1000
      
      const distance = id1.xorDistance(id2);
      const leadingZeros = distance.leadingZeroBits();
      expect(leadingZeros).toBe(0); // MSB is 1, so 0 leading zeros
    });

    test('should return 160 for identical IDs', () => {
      const id1 = DHTNodeId.fromHex('a'.repeat(40));
      const id2 = DHTNodeId.fromHex('a'.repeat(40));
      
      const distance = id1.xorDistance(id2);
      const leadingZeros = distance.leadingZeroBits();
      expect(leadingZeros).toBe(160); // All bits are zero
    });
  });

  describe('comparison methods', () => {
    test('should compare node IDs correctly', () => {
      const id1 = DHTNodeId.fromHex('1'.repeat(40));
      const id2 = DHTNodeId.fromHex('2'.repeat(40));
      const id3 = DHTNodeId.fromHex('1'.repeat(40));
      
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
      const restored = DHTNodeId.fromHex(str);
      
      expect(original.equals(restored)).toBe(true);
    });
  });

  describe('utility methods', () => {
    test('should generate random node IDs', () => {
      const id1 = new DHTNodeId();
      const id2 = new DHTNodeId();
      
      expect(id1.equals(id2)).toBe(false);
      expect(id1.bytes.length).toBe(20);
      expect(id2.bytes.length).toBe(20);
    });

    test('should create from string hash', () => {
      const data = 'test-data';
      const nodeId = DHTNodeId.fromString(data);
      
      expect(nodeId.bytes.length).toBe(20);
      
      // Same input should produce same hash
      const nodeId2 = DHTNodeId.fromString(data);
      expect(nodeId.equals(nodeId2)).toBe(true);
    });

    test('should generate at specific distance', () => {
      const target = new DHTNodeId();
      const distance = 5;
      const generated = DHTNodeId.generateAtDistance(target, distance);
      
      expect(generated.bytes.length).toBe(20);
      
      // Verify the distance bit is flipped
      const actualDistance = target.xorDistance(generated);
      const leadingZeros = actualDistance.leadingZeroBits();
      expect(leadingZeros).toBe(distance);
    });
  });
});