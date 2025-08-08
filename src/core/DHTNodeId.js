import crypto from 'crypto-js';

/**
 * Represents a 160-bit node ID for Kademlia DHT
 * This is a unified class that handles both node IDs (random) and data IDs (hashed)
 * with explicit methods to prevent double-hashing
 */
export class DHTNodeId {
  constructor(bytes = null) {
    if (bytes) {
      this.bytes = new Uint8Array(bytes);
    } else {
      // Generate random 160-bit (20 byte) ID
      this.bytes = new Uint8Array(20);
      
      // Use browser's native crypto API for random values
      if (typeof window !== 'undefined' && window.crypto && window.crypto.getRandomValues) {
        window.crypto.getRandomValues(this.bytes);
      } else if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.getRandomValues) {
        globalThis.crypto.getRandomValues(this.bytes);
      } else {
        // Fallback for environments without crypto.getRandomValues
        for (let i = 0; i < 20; i++) {
          this.bytes[i] = Math.floor(Math.random() * 256);
        }
      }
    }
    
    if (this.bytes.length !== 20) {
      throw new Error('DHTNodeId must be exactly 20 bytes (160 bits)');
    }
  }

  /**
   * Create DHTNodeId from string by hashing (for DATA/STORAGE keys only)
   */
  static fromString(str) {
    const hash = crypto.SHA1(str);
    const bytes = new Uint8Array(20);
    const words = hash.words;
    
    for (let i = 0; i < 5; i++) {
      const word = words[i];
      bytes[i * 4] = (word >>> 24) & 0xff;
      bytes[i * 4 + 1] = (word >>> 16) & 0xff;
      bytes[i * 4 + 2] = (word >>> 8) & 0xff;
      bytes[i * 4 + 3] = word & 0xff;
    }
    
    return new DHTNodeId(bytes);
  }

  /**
   * Create DHTNodeId from hex string (for EXISTING node IDs - no hashing)
   */
  static fromHex(hex) {
    if (hex.length !== 40) {
      throw new Error('Hex string must be 40 characters (20 bytes)');
    }
    
    const bytes = new Uint8Array(20);
    for (let i = 0; i < 20; i++) {
      bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    
    return new DHTNodeId(bytes);
  }

  /**
   * Calculate XOR distance to another DHTNodeId
   */
  xorDistance(other) {
    const result = new Uint8Array(20);
    for (let i = 0; i < 20; i++) {
      result[i] = this.bytes[i] ^ other.bytes[i];
    }
    return new DHTNodeId(result);
  }

  /**
   * Calculate the number of leading zero bits
   */
  leadingZeroBits() {
    for (let i = 0; i < this.bytes.length; i++) {
      if (this.bytes[i] !== 0) {
        let byte = this.bytes[i];
        let zeros = 0;
        for (let j = 7; j >= 0; j--) {
          if ((byte & (1 << j)) === 0) {
            zeros++;
          } else {
            break;
          }
        }
        return i * 8 + zeros;
      }
    }
    return 160; // All bits are zero
  }

  /**
   * Get the bit at position i (0-159)
   */
  getBit(position) {
    if (position < 0 || position >= 160) {
      return 0;
    }
    
    const byteIndex = Math.floor(position / 8);
    const bitIndex = position % 8;
    return (this.bytes[byteIndex] >> (7 - bitIndex)) & 1;
  }

  /**
   * Compare this DHTNodeId with another for ordering
   * Returns -1 if this < other, 0 if equal, 1 if this > other
   */
  compare(other) {
    for (let i = 0; i < 20; i++) {
      if (this.bytes[i] < other.bytes[i]) return -1;
      if (this.bytes[i] > other.bytes[i]) return 1;
    }
    return 0;
  }

  /**
   * Check if two DHTNodeIds are equal
   */
  equals(other) {
    return this.compare(other) === 0;
  }

  /**
   * Convert to hex string
   */
  toHex() {
    return Array.from(this.bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Convert to base64 string
   */
  toBase64() {
    return btoa(String.fromCharCode(...this.bytes));
  }

  /**
   * Convert to string representation
   */
  toString() {
    return this.toHex();
  }

  /**
   * Get a copy of the bytes
   */
  getBytes() {
    return new Uint8Array(this.bytes);
  }

  /**
   * Generate a DHTNodeId at a specific distance
   */
  static generateAtDistance(target, distance) {
    const result = new DHTNodeId();
    
    // Copy target bytes
    for (let i = 0; i < 20; i++) {
      result.bytes[i] = target.bytes[i];
    }
    
    // Flip the bit at the specified distance
    if (distance < 160) {
      const byteIndex = Math.floor(distance / 8);
      const bitIndex = distance % 8;
      result.bytes[byteIndex] ^= (1 << (7 - bitIndex));
    }
    
    // Randomize remaining bits
    for (let i = distance + 1; i < 160; i++) {
      const byteIndex = Math.floor(i / 8);
      const bitIndex = i % 8;
      if (Math.random() > 0.5) {
        result.bytes[byteIndex] |= (1 << (7 - bitIndex));
      } else {
        result.bytes[byteIndex] &= ~(1 << (7 - bitIndex));
      }
    }
    
    return result;
  }
}