/**
 * MessageCollection - Immutable collection of message references
 *
 * Represents a snapshot of messages for a topic. Collections are IMMUTABLE -
 * modifications create new collections following copy-on-write semantics.
 *
 * Key Features:
 * - Content-based TTL: expires when all contained messages expire + grace period
 * - Message metadata only: stores lightweight references, not full message data
 * - addedInVersion tracking: enables efficient delta delivery to subscribers
 * - Immutable: all modifications create new collections
 *
 * Integration:
 * - Referenced by CoordinatorObject.currentMessages
 * - Stored separately in DHT at collectionID location
 * - Messages themselves stored separately and loaded on demand
 */

import { DHTNodeId } from '../core/DHTNodeId.js';

export class MessageCollection {
  /**
   * Grace period after last message expires before collection is deleted
   */
  static GRACE_PERIOD = 3600000; // 1 hour in milliseconds

  /**
   * Create a new MessageCollection
   * @param {Object} params - Collection parameters
   * @param {Array} [params.messages] - Array of message metadata objects
   * @param {string} [params.collectionID] - Optional pre-computed collection ID
   * @param {number} [params.createdAt] - Creation timestamp
   * @param {number} [params.expiresAt] - Expiration timestamp
   */
  constructor(params = {}) {
    this.messages = params.messages || [];
    this.createdAt = params.createdAt || Date.now();

    // Calculate content-based TTL
    this.expiresAt = params.expiresAt || this.calculateTTL();

    // Generate deterministic collection ID if not provided
    this.collectionID = params.collectionID || this.generateCollectionID();
  }

  /**
   * Generate deterministic collection ID from message IDs
   * @returns {string} - 40-character hex string (160-bit hash)
   */
  generateCollectionID() {
    // Sort message IDs for deterministic hashing
    const sortedMessageIDs = this.messages
      .map(m => m.messageID)
      .sort()
      .join(':');

    // Include creation timestamp for uniqueness across collection versions
    const content = `msgcoll:${sortedMessageIDs}:${this.createdAt}`;
    const id = DHTNodeId.fromString(content);
    return id.toString();
  }

  /**
   * Calculate content-based TTL
   * Collection expires when all messages expire + grace period
   * @returns {number} - Expiration timestamp
   */
  calculateTTL() {
    if (this.messages.length === 0) {
      return Date.now() + MessageCollection.GRACE_PERIOD;
    }

    // Find latest message expiry
    const maxExpiry = Math.max(...this.messages.map(m => m.expiresAt));
    return maxExpiry + MessageCollection.GRACE_PERIOD;
  }

  /**
   * Add message to collection (creates NEW collection - immutable)
   * @param {Object} messageMetadata - Message metadata object
   * @param {string} messageMetadata.messageID - Message ID
   * @param {string} messageMetadata.publisherID - Publisher node ID
   * @param {number} messageMetadata.publisherSequence - Per-publisher sequence
   * @param {number} messageMetadata.addedInVersion - Coordinator version when added
   * @param {number} messageMetadata.expiresAt - Message expiration timestamp
   * @returns {MessageCollection} - New collection with added message
   */
  addMessage(messageMetadata) {
    // Validate required fields
    if (!messageMetadata.messageID) throw new Error('Message metadata requires messageID');
    if (!messageMetadata.publisherID) throw new Error('Message metadata requires publisherID');
    if (messageMetadata.publisherSequence === undefined) throw new Error('Message metadata requires publisherSequence');
    if (messageMetadata.addedInVersion === undefined) throw new Error('Message metadata requires addedInVersion');
    if (!messageMetadata.expiresAt) throw new Error('Message metadata requires expiresAt');

    // Create new collection with added message (immutable)
    const newMessages = [
      ...this.messages,
      {
        messageID: messageMetadata.messageID,
        publisherID: messageMetadata.publisherID,
        publisherSequence: messageMetadata.publisherSequence,
        addedInVersion: messageMetadata.addedInVersion,
        expiresAt: messageMetadata.expiresAt
      }
    ];

    return new MessageCollection({
      messages: newMessages,
      createdAt: Date.now() // New collection has new creation time
    });
  }

  /**
   * Add multiple messages to collection (creates NEW collection)
   * @param {Array<Object>} messageMetadataArray - Array of message metadata
   * @returns {MessageCollection} - New collection with added messages
   */
  addMessages(messageMetadataArray) {
    const newMessages = [
      ...this.messages,
      ...messageMetadataArray.map(m => ({
        messageID: m.messageID,
        publisherID: m.publisherID,
        publisherSequence: m.publisherSequence,
        addedInVersion: m.addedInVersion,
        expiresAt: m.expiresAt
      }))
    ];

    return new MessageCollection({
      messages: newMessages,
      createdAt: Date.now()
    });
  }

  /**
   * Remove expired messages (creates NEW collection)
   * @returns {MessageCollection} - New collection without expired messages
   */
  removeExpiredMessages() {
    const now = Date.now();
    const activeMessages = this.messages.filter(m => m.expiresAt > now);

    return new MessageCollection({
      messages: activeMessages,
      createdAt: Date.now()
    });
  }

  /**
   * Get messages added after a specific coordinator version
   * Used for delta delivery to subscribers
   * @param {number} sinceVersion - Coordinator version (exclusive)
   * @returns {Array<Object>} - Message metadata for messages added after sinceVersion
   */
  getMessagesSince(sinceVersion) {
    return this.messages.filter(m => m.addedInVersion > sinceVersion);
  }

  /**
   * Get messages by publisher ID
   * @param {string} publisherID - Publisher node ID
   * @returns {Array<Object>} - Message metadata from this publisher
   */
  getMessagesByPublisher(publisherID) {
    return this.messages.filter(m => m.publisherID === publisherID);
  }

  /**
   * Check if collection contains a specific message
   * @param {string} messageID - Message ID to check
   * @returns {boolean} - True if message is in collection
   */
  hasMessage(messageID) {
    return this.messages.some(m => m.messageID === messageID);
  }

  /**
   * Merge with another collection (set union by messageID)
   * Creates NEW collection containing all unique messages from both
   * @param {MessageCollection} otherCollection - Collection to merge with
   * @returns {MessageCollection} - New merged collection
   */
  merge(otherCollection) {
    const messageMap = new Map();

    // Add messages from this collection
    for (const msg of this.messages) {
      messageMap.set(msg.messageID, msg);
    }

    // Add messages from other collection (no duplicates)
    for (const msg of otherCollection.messages) {
      if (!messageMap.has(msg.messageID)) {
        messageMap.set(msg.messageID, msg);
      }
    }

    return new MessageCollection({
      messages: Array.from(messageMap.values()),
      createdAt: Date.now()
    });
  }

  /**
   * Check if collection has expired
   * @returns {boolean} - True if collection is expired
   */
  isExpired() {
    return Date.now() > this.expiresAt;
  }

  /**
   * Get collection size
   * @returns {number} - Number of messages in collection
   */
  size() {
    return this.messages.length;
  }

  /**
   * Serialize collection for DHT storage
   * @returns {Object} - Plain object suitable for JSON serialization
   */
  serialize() {
    return {
      collectionID: this.collectionID,
      messages: this.messages.map(m => ({
        messageID: m.messageID,
        publisherID: m.publisherID,
        publisherSequence: m.publisherSequence,
        addedInVersion: m.addedInVersion,
        expiresAt: m.expiresAt
      })),
      createdAt: this.createdAt,
      expiresAt: this.expiresAt
    };
  }

  /**
   * Deserialize collection from DHT storage
   * @param {Object} obj - Serialized collection object
   * @returns {MessageCollection} - Collection instance
   */
  static deserialize(obj) {
    return new MessageCollection({
      collectionID: obj.collectionID,
      messages: obj.messages || [],
      createdAt: obj.createdAt,
      expiresAt: obj.expiresAt
    });
  }

  /**
   * Validate collection structure
   * @returns {{valid: boolean, errors: string[]}}
   */
  validate() {
    const errors = [];

    // Check required fields
    if (!this.collectionID) errors.push('Missing collectionID');
    if (!this.createdAt) errors.push('Missing createdAt');
    if (!this.expiresAt) errors.push('Missing expiresAt');
    if (!Array.isArray(this.messages)) errors.push('messages must be an array');

    // Verify timestamps
    if (this.createdAt > this.expiresAt) {
      errors.push('createdAt cannot be after expiresAt');
    }

    // Validate each message metadata
    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];
      if (!msg.messageID) errors.push(`Message ${i} missing messageID`);
      if (!msg.publisherID) errors.push(`Message ${i} missing publisherID`);
      if (msg.publisherSequence === undefined) errors.push(`Message ${i} missing publisherSequence`);
      if (msg.addedInVersion === undefined) errors.push(`Message ${i} missing addedInVersion`);
      if (!msg.expiresAt) errors.push(`Message ${i} missing expiresAt`);
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Detect gaps in per-publisher sequences
   * @returns {Object} - Map of publisherID -> array of missing sequences
   */
  detectSequenceGaps() {
    const gaps = new Map();

    // Group messages by publisher
    const byPublisher = new Map();
    for (const msg of this.messages) {
      if (!byPublisher.has(msg.publisherID)) {
        byPublisher.set(msg.publisherID, []);
      }
      byPublisher.get(msg.publisherID).push(msg.publisherSequence);
    }

    // Check for gaps in each publisher's sequences
    for (const [publisherID, sequences] of byPublisher.entries()) {
      sequences.sort((a, b) => a - b);
      const missing = [];

      for (let i = 1; i < sequences.length; i++) {
        const expected = sequences[i - 1] + 1;
        const actual = sequences[i];

        if (actual > expected) {
          // Found gap
          for (let seq = expected; seq < actual; seq++) {
            missing.push(seq);
          }
        }
      }

      if (missing.length > 0) {
        gaps.set(publisherID, missing);
      }
    }

    return gaps;
  }

  /**
   * Create a human-readable string representation
   * @returns {string}
   */
  toString() {
    return `MessageCollection(${this.collectionID.substring(0, 8)}... messages=${this.messages.length} expires=${new Date(this.expiresAt).toISOString()})`;
  }
}
