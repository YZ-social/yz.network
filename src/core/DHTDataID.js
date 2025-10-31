import crypto from 'crypto-js';

/**
 * Represents a 160-bit Data ID for stored data in the DHT
 * These are ALWAYS hashed from strings - used to identify storage locations
 */
export class DHTDataID {
  constructor(bytes) {
    if (!bytes || bytes.length !== 20) {
      throw new Error('DHTDataID must be constructed with exactly 20 bytes. Use fromString() to create from data.');
    }

    this.bytes = new Uint8Array(bytes);

    // Mark as data ID (not node ID)
    this._isDataID = true;
  }

  /**
   * Create DHTDataID from string by hashing it
   * This is the PRIMARY way to create data IDs
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

    return new DHTDataID(bytes);
  }

  /**
   * Create DHTDataID from hex string (only if you're sure it's already hashed)
   */
  static fromHex(hex) {
    if (hex.length !== 40) {
      throw new Error('Data ID hex string must be 40 characters (20 bytes)');
    }

    const bytes = new Uint8Array(20);
    for (let i = 0; i < 20; i++) {
      bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }

    return new DHTDataID(bytes);
  }

  /**
   * Calculate XOR distance to another DHTDataID or DHTNodeID
   */
  xorDistance(other) {
    // Support distance calculation with both data IDs and node IDs
    const otherBytes = other._isDataID ? other.bytes : other.bytes;
    const result = new Uint8Array(20);
    for (let i = 0; i < 20; i++) {
      result[i] = this.bytes[i] ^ otherBytes[i];
    }
    return new DHTDataID(result);
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
   * Compare this DHTDataID with another for ordering
   * Returns -1 if this < other, 0 if equal, 1 if this > other
   */
  compare(other) {
    const otherBytes = other._isDataID ? other.bytes : other.bytes;
    for (let i = 0; i < 20; i++) {
      if (this.bytes[i] < otherBytes[i]) return -1;
      if (this.bytes[i] > otherBytes[i]) return 1;
    }
    return 0;
  }

  /**
   * Check if two IDs are equal (supports both data IDs and node IDs)
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
}