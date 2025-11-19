/**
 * SubscriberCollection - Immutable collection of subscriber metadata
 *
 * Represents a snapshot of active subscribers for a topic. Collections are
 * IMMUTABLE - modifications create new collections following copy-on-write semantics.
 *
 * Key Features:
 * - Content-based TTL: expires when all subscriptions expire + grace period
 * - Deterministic coordinator assignment: each subscriber assigned to specific coordinator
 * - Signature verification: subscribers sign subscription to prove intent
 * - Immutable: all modifications create new collections
 *
 * Integration:
 * - Referenced by CoordinatorObject.currentSubscribers
 * - Stored separately in DHT at collectionID location
 * - Coordinators use this to determine which messages to deliver to which subscribers
 */

import { DHTNodeId } from '../core/DHTNodeId.js';
import { InvitationToken } from '../core/InvitationToken.js';

export class SubscriberCollection {
  /**
   * Grace period after last subscription expires before collection is deleted
   */
  static GRACE_PERIOD = 3600000; // 1 hour in milliseconds

  /**
   * Create a new SubscriberCollection
   * @param {Object} params - Collection parameters
   * @param {Array} [params.subscribers] - Array of subscriber metadata objects
   * @param {string} [params.collectionID] - Optional pre-computed collection ID
   * @param {number} [params.createdAt] - Creation timestamp
   * @param {number} [params.expiresAt] - Expiration timestamp
   */
  constructor(params = {}) {
    this.subscribers = params.subscribers || [];
    this.createdAt = params.createdAt || Date.now();

    // Calculate content-based TTL
    this.expiresAt = params.expiresAt || this.calculateTTL();

    // Generate deterministic collection ID if not provided
    this.collectionID = params.collectionID || this.generateCollectionID();
  }

  /**
   * Generate deterministic collection ID from subscriber IDs
   * @returns {string} - 40-character hex string (160-bit hash)
   */
  generateCollectionID() {
    // Sort subscriber IDs for deterministic hashing
    const sortedSubscriberIDs = this.subscribers
      .map(s => s.subscriberID)
      .sort()
      .join(':');

    // Include creation timestamp for uniqueness across collection versions
    const content = `subcoll:${sortedSubscriberIDs}:${this.createdAt}`;
    const id = DHTNodeId.fromString(content);
    return id.toString();
  }

  /**
   * Calculate content-based TTL
   * Collection expires when all subscriptions expire + grace period
   * @returns {number} - Expiration timestamp
   */
  calculateTTL() {
    if (this.subscribers.length === 0) {
      return Date.now() + SubscriberCollection.GRACE_PERIOD;
    }

    // Find latest subscription expiry
    const maxExpiry = Math.max(...this.subscribers.map(s => s.expiresAt));
    return maxExpiry + SubscriberCollection.GRACE_PERIOD;
  }

  /**
   * Calculate deterministic coordinator node for a subscriber
   * Uses hash of (topicID + subscriberID) % k to assign coordinator
   * @param {string} topicID - Topic ID
   * @param {string} subscriberID - Subscriber node ID
   * @param {number} k - Number of coordinator nodes (typically 20 for Kademlia)
   * @returns {number} - Coordinator node index (0 to k-1)
   */
  static calculateCoordinatorNode(topicID, subscriberID, k = 20) {
    const content = `${topicID}:${subscriberID}`;
    const hash = DHTNodeId.fromString(content);
    const hashBytes = hash.bytes;

    // Use first 4 bytes as uint32 for modulo operation
    const uint32 = (hashBytes[0] << 24) | (hashBytes[1] << 16) | (hashBytes[2] << 8) | hashBytes[3];
    return uint32 % k;
  }

  /**
   * Add subscriber to collection (creates NEW collection - immutable)
   * @param {Object} subscriberMetadata - Subscriber metadata object
   * @param {string} subscriberMetadata.subscriberID - Subscriber node ID
   * @param {number} subscriberMetadata.coordinatorNode - Assigned coordinator (0 to k-1)
   * @param {number} subscriberMetadata.subscribedAt - Subscription timestamp
   * @param {number} subscriberMetadata.expiresAt - Subscription expiration timestamp
   * @param {string} subscriberMetadata.signature - Subscriber's signature
   * @returns {SubscriberCollection} - New collection with added subscriber
   */
  addSubscriber(subscriberMetadata) {
    // Validate required fields
    if (!subscriberMetadata.subscriberID) throw new Error('Subscriber metadata requires subscriberID');
    if (subscriberMetadata.coordinatorNode === undefined) throw new Error('Subscriber metadata requires coordinatorNode');
    if (!subscriberMetadata.subscribedAt) throw new Error('Subscriber metadata requires subscribedAt');
    if (!subscriberMetadata.expiresAt) throw new Error('Subscriber metadata requires expiresAt');
    if (!subscriberMetadata.signature) throw new Error('Subscriber metadata requires signature');

    // Create new collection with added subscriber (immutable)
    const newSubscribers = [
      ...this.subscribers,
      {
        subscriberID: subscriberMetadata.subscriberID,
        coordinatorNode: subscriberMetadata.coordinatorNode,
        subscribedAt: subscriberMetadata.subscribedAt,
        expiresAt: subscriberMetadata.expiresAt,
        signature: subscriberMetadata.signature
      }
    ];

    return new SubscriberCollection({
      subscribers: newSubscribers,
      createdAt: Date.now() // New collection has new creation time
    });
  }

  /**
   * Remove subscriber from collection (creates NEW collection)
   * @param {string} subscriberID - Subscriber node ID to remove
   * @returns {SubscriberCollection} - New collection without subscriber
   */
  removeSubscriber(subscriberID) {
    const filteredSubscribers = this.subscribers.filter(s => s.subscriberID !== subscriberID);

    return new SubscriberCollection({
      subscribers: filteredSubscribers,
      createdAt: Date.now()
    });
  }

  /**
   * Remove expired subscriptions (creates NEW collection)
   * @returns {SubscriberCollection} - New collection without expired subscriptions
   */
  removeExpiredSubscribers() {
    const now = Date.now();
    const activeSubscribers = this.subscribers.filter(s => s.expiresAt > now);

    return new SubscriberCollection({
      subscribers: activeSubscribers,
      createdAt: Date.now()
    });
  }

  /**
   * Get subscribers assigned to a specific coordinator node
   * @param {number} coordinatorNode - Coordinator node index (0 to k-1)
   * @returns {Array<Object>} - Subscriber metadata for this coordinator
   */
  getSubscribersByCoordinator(coordinatorNode) {
    return this.subscribers.filter(s => s.coordinatorNode === coordinatorNode);
  }

  /**
   * Check if a specific subscriber is in the collection
   * @param {string} subscriberID - Subscriber node ID to check
   * @returns {boolean} - True if subscriber is in collection
   */
  hasSubscriber(subscriberID) {
    return this.subscribers.some(s => s.subscriberID === subscriberID);
  }

  /**
   * Get subscriber metadata
   * @param {string} subscriberID - Subscriber node ID
   * @returns {Object|null} - Subscriber metadata or null if not found
   */
  getSubscriber(subscriberID) {
    return this.subscribers.find(s => s.subscriberID === subscriberID) || null;
  }

  /**
   * Merge with another collection (set union by subscriberID)
   * Creates NEW collection containing all unique subscribers from both
   * @param {SubscriberCollection} otherCollection - Collection to merge with
   * @returns {SubscriberCollection} - New merged collection
   */
  merge(otherCollection) {
    const subscriberMap = new Map();

    // Add subscribers from this collection
    for (const sub of this.subscribers) {
      subscriberMap.set(sub.subscriberID, sub);
    }

    // Add subscribers from other collection (take latest if duplicate)
    for (const sub of otherCollection.subscribers) {
      const existing = subscriberMap.get(sub.subscriberID);
      if (!existing || sub.subscribedAt > existing.subscribedAt) {
        subscriberMap.set(sub.subscriberID, sub);
      }
    }

    return new SubscriberCollection({
      subscribers: Array.from(subscriberMap.values()),
      createdAt: Date.now()
    });
  }

  /**
   * Renew subscription for a subscriber (creates NEW collection)
   * @param {string} subscriberID - Subscriber node ID
   * @param {number} newExpiresAt - New expiration timestamp
   * @param {string} newSignature - New signature for renewed subscription
   * @returns {SubscriberCollection} - New collection with renewed subscription
   */
  renewSubscription(subscriberID, newExpiresAt, newSignature) {
    const updatedSubscribers = this.subscribers.map(s => {
      if (s.subscriberID === subscriberID) {
        return {
          ...s,
          expiresAt: newExpiresAt,
          signature: newSignature
        };
      }
      return s;
    });

    return new SubscriberCollection({
      subscribers: updatedSubscribers,
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
   * @returns {number} - Number of subscribers in collection
   */
  size() {
    return this.subscribers.length;
  }

  /**
   * Get distribution of subscribers across coordinator nodes
   * @returns {Map<number, number>} - Map of coordinatorNode -> subscriber count
   */
  getCoordinatorDistribution() {
    const distribution = new Map();

    for (const sub of this.subscribers) {
      const count = distribution.get(sub.coordinatorNode) || 0;
      distribution.set(sub.coordinatorNode, count + 1);
    }

    return distribution;
  }

  /**
   * Verify all subscriber signatures
   * @param {Map<string, string>} publicKeys - Map of subscriberID -> publicKey
   * @returns {Promise<{valid: boolean, invalidSubscribers: string[]}>}
   */
  async verifySignatures(publicKeys) {
    const invalidSubscribers = [];

    for (const sub of this.subscribers) {
      const publicKey = publicKeys.get(sub.subscriberID);
      if (!publicKey) {
        console.warn(`⚠️ No public key for subscriber ${sub.subscriberID}`);
        invalidSubscribers.push(sub.subscriberID);
        continue;
      }

      const signableData = JSON.stringify({
        subscriberID: sub.subscriberID,
        coordinatorNode: sub.coordinatorNode,
        subscribedAt: sub.subscribedAt,
        expiresAt: sub.expiresAt
      });

      try {
        const isValid = await InvitationToken.verifySignature(signableData, sub.signature, publicKey);
        if (!isValid) {
          invalidSubscribers.push(sub.subscriberID);
        }
      } catch (error) {
        console.error(`❌ Signature verification failed for ${sub.subscriberID}:`, error);
        invalidSubscribers.push(sub.subscriberID);
      }
    }

    return {
      valid: invalidSubscribers.length === 0,
      invalidSubscribers
    };
  }

  /**
   * Serialize collection for DHT storage
   * @returns {Object} - Plain object suitable for JSON serialization
   */
  serialize() {
    return {
      collectionID: this.collectionID,
      subscribers: this.subscribers.map(s => ({
        subscriberID: s.subscriberID,
        coordinatorNode: s.coordinatorNode,
        subscribedAt: s.subscribedAt,
        expiresAt: s.expiresAt,
        signature: s.signature
      })),
      createdAt: this.createdAt,
      expiresAt: this.expiresAt
    };
  }

  /**
   * Deserialize collection from DHT storage
   * @param {Object} obj - Serialized collection object
   * @returns {SubscriberCollection} - Collection instance
   */
  static deserialize(obj) {
    return new SubscriberCollection({
      collectionID: obj.collectionID,
      subscribers: obj.subscribers || [],
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
    if (!Array.isArray(this.subscribers)) errors.push('subscribers must be an array');

    // Verify timestamps
    if (this.createdAt > this.expiresAt) {
      errors.push('createdAt cannot be after expiresAt');
    }

    // Validate each subscriber metadata
    for (let i = 0; i < this.subscribers.length; i++) {
      const sub = this.subscribers[i];
      if (!sub.subscriberID) errors.push(`Subscriber ${i} missing subscriberID`);
      if (sub.coordinatorNode === undefined) errors.push(`Subscriber ${i} missing coordinatorNode`);
      if (!sub.subscribedAt) errors.push(`Subscriber ${i} missing subscribedAt`);
      if (!sub.expiresAt) errors.push(`Subscriber ${i} missing expiresAt`);
      if (!sub.signature) errors.push(`Subscriber ${i} missing signature`);

      // Verify subscription timestamps
      if (sub.subscribedAt > sub.expiresAt) {
        errors.push(`Subscriber ${i}: subscribedAt cannot be after expiresAt`);
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
    return `SubscriberCollection(${this.collectionID.substring(0, 8)}... subscribers=${this.subscribers.length} expires=${new Date(this.expiresAt).toISOString()})`;
  }
}
