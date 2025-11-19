/**
 * Message - Individual pub/sub message with per-publisher sequences
 *
 * Represents a single published message in the Sticky Pub/Sub system.
 * Messages are immutable, signed by publishers, and include sequence numbers
 * for drop detection and ordering.
 *
 * Integration:
 * - Uses InvitationToken for Ed25519 signing/verification
 * - Uses DHTNodeId.fromString() for deterministic messageID generation
 * - Stored separately in DHT, referenced by MessageCollection
 */

import { InvitationToken } from '../core/InvitationToken.js';
import { DHTNodeId } from '../core/DHTNodeId.js';

export class Message {
  /**
   * Create a new Message
   * @param {Object} params - Message parameters
   * @param {string} params.topicID - Topic this message belongs to
   * @param {string} params.publisherID - Node ID of publisher
   * @param {number} params.publisherSequence - Per-publisher monotonic sequence number
   * @param {number} params.addedInVersion - Coordinator version when message was added
   * @param {any} params.data - Message payload (can be encrypted)
   * @param {number} params.publishedAt - Timestamp when published
   * @param {number} params.expiresAt - Timestamp when message expires
   * @param {string} [params.messageID] - Optional pre-computed message ID
   * @param {string} [params.signature] - Optional pre-computed signature
   */
  constructor(params) {
    // Required fields validation
    if (!params.topicID) throw new Error('Message requires topicID');
    if (!params.publisherID) throw new Error('Message requires publisherID');
    if (params.publisherSequence === undefined) throw new Error('Message requires publisherSequence');
    if (params.addedInVersion === undefined) throw new Error('Message requires addedInVersion');
    if (params.data === undefined) throw new Error('Message requires data');
    if (!params.publishedAt) throw new Error('Message requires publishedAt');
    if (!params.expiresAt) throw new Error('Message requires expiresAt');

    this.topicID = params.topicID;
    this.publisherID = params.publisherID;
    this.publisherSequence = params.publisherSequence;
    this.addedInVersion = params.addedInVersion;
    this.data = params.data;
    this.publishedAt = params.publishedAt;
    this.expiresAt = params.expiresAt;

    // Generate deterministic messageID if not provided
    this.messageID = params.messageID || this.generateMessageID();

    // Signature added after signing
    this.signature = params.signature || null;
  }

  /**
   * Generate deterministic message ID from message content
   * @returns {string} - 40-character hex string (160-bit hash)
   */
  generateMessageID() {
    // Hash combination of topic, publisher, sequence, and timestamp for deterministic ID
    const content = `${this.topicID}:${this.publisherID}:${this.publisherSequence}:${this.publishedAt}`;
    const id = DHTNodeId.fromString(content);
    return id.toString();
  }

  /**
   * Get signable data (message content without signature)
   * @returns {string} - Canonical string representation for signing
   */
  getSignableData() {
    return JSON.stringify({
      messageID: this.messageID,
      topicID: this.topicID,
      publisherID: this.publisherID,
      publisherSequence: this.publisherSequence,
      addedInVersion: this.addedInVersion,
      data: this.data,
      publishedAt: this.publishedAt,
      expiresAt: this.expiresAt
    });
  }

  /**
   * Sign the message using publisher's key
   * @param {Object} keyInfo - Publisher's key info from InvitationToken.generateKeyPair()
   * @returns {Promise<void>}
   */
  async sign(keyInfo) {
    const signableData = this.getSignableData();
    this.signature = await InvitationToken.signData(signableData, keyInfo);
  }

  /**
   * Verify message signature
   * @param {string|Object} publicKey - Publisher's public key (hex string or key object)
   * @returns {Promise<boolean>} - True if signature is valid
   */
  async verify(publicKey) {
    if (!this.signature) {
      console.warn('⚠️ Cannot verify message without signature');
      return false;
    }

    try {
      const signableData = this.getSignableData();
      return await InvitationToken.verifySignature(signableData, this.signature, publicKey);
    } catch (error) {
      console.error('❌ Message signature verification failed:', error);
      return false;
    }
  }

  /**
   * Check if message has expired
   * @returns {boolean} - True if message is expired
   */
  isExpired() {
    return Date.now() > this.expiresAt;
  }

  /**
   * Serialize message for DHT storage
   * @returns {Object} - Plain object suitable for JSON serialization
   */
  serialize() {
    return {
      messageID: this.messageID,
      topicID: this.topicID,
      publisherID: this.publisherID,
      publisherSequence: this.publisherSequence,
      addedInVersion: this.addedInVersion,
      data: this.data,
      publishedAt: this.publishedAt,
      expiresAt: this.expiresAt,
      signature: this.signature
    };
  }

  /**
   * Deserialize message from DHT storage
   * @param {Object} obj - Serialized message object
   * @returns {Message} - Message instance
   */
  static deserialize(obj) {
    return new Message({
      messageID: obj.messageID,
      topicID: obj.topicID,
      publisherID: obj.publisherID,
      publisherSequence: obj.publisherSequence,
      addedInVersion: obj.addedInVersion,
      data: obj.data,
      publishedAt: obj.publishedAt,
      expiresAt: obj.expiresAt,
      signature: obj.signature
    });
  }

  /**
   * Create message with automatic signing
   * @param {Object} params - Message parameters (same as constructor)
   * @param {Object} keyInfo - Publisher's key info for signing
   * @returns {Promise<Message>} - Signed message
   */
  static async create(params, keyInfo) {
    const message = new Message(params);
    await message.sign(keyInfo);
    return message;
  }

  /**
   * Validate message structure and signature
   * @param {Object} publicKey - Publisher's public key for verification
   * @returns {Promise<{valid: boolean, errors: string[]}>}
   */
  async validate(publicKey) {
    const errors = [];

    // Check required fields
    if (!this.messageID) errors.push('Missing messageID');
    if (!this.topicID) errors.push('Missing topicID');
    if (!this.publisherID) errors.push('Missing publisherID');
    if (this.publisherSequence === undefined) errors.push('Missing publisherSequence');
    if (this.addedInVersion === undefined) errors.push('Missing addedInVersion');
    if (this.data === undefined) errors.push('Missing data');
    if (!this.publishedAt) errors.push('Missing publishedAt');
    if (!this.expiresAt) errors.push('Missing expiresAt');
    if (!this.signature) errors.push('Missing signature');

    // Verify messageID is correct
    const expectedID = this.generateMessageID();
    if (this.messageID !== expectedID) {
      errors.push(`MessageID mismatch: expected ${expectedID}, got ${this.messageID}`);
    }

    // Verify timestamps
    if (this.publishedAt > this.expiresAt) {
      errors.push('publishedAt cannot be after expiresAt');
    }

    // Verify signature
    if (publicKey && this.signature) {
      const signatureValid = await this.verify(publicKey);
      if (!signatureValid) {
        errors.push('Invalid signature');
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Create a human-readable string representation
   * @returns {string}
   */
  toString() {
    return `Message(${this.messageID.substring(0, 8)}... topic=${this.topicID} publisher=${this.publisherID.substring(0, 8)}... seq=${this.publisherSequence} version=${this.addedInVersion})`;
  }
}
