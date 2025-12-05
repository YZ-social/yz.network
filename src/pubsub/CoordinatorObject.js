/**
 * CoordinatorObject - Central coordinator for a pub/sub topic
 *
 * The coordinator is the mutable "head" that tracks current state for a topic.
 * It's stored at hash(topicID) in the DHT and replicated to k-closest nodes.
 *
 * Key Features:
 * - Dual histories: separate tracking for subscribers and messages
 * - Bounded size: automatic pruning with snapshot creation when histories grow large
 * - Version-based concurrency: supports optimistic locking for conflict detection
 * - Channel state tracking: ACTIVE, RECOVERING, or FAILED
 * - History-based merging: resolves conflicts via set union of collection IDs
 *
 * Integration:
 * - Stored at DHT key hash(topicID)
 * - References SubscriberCollection and MessageCollection by ID
 * - Links to CoordinatorSnapshot for historical data
 * - Used by all k-closest nodes for coordination
 */

import { DHTNodeId } from '../core/DHTNodeId.js';
import { CoordinatorSnapshot } from './CoordinatorSnapshot.js';

export class CoordinatorObject {
  /**
   * Maximum coordinator size before pruning (1KB)
   */
  static MAX_COORDINATOR_SIZE = 1024;

  /**
   * Maximum history entries before pruning
   */
  static MAX_HISTORY_ENTRIES = 50;

  /**
   * Minimum history entries to keep after pruning
   */
  static MIN_HISTORY_ENTRIES = 10;

  /**
   * Channel states
   */
  static ChannelState = {
    ACTIVE: 'ACTIVE',           // Normal operation
    RECOVERING: 'RECOVERING',   // Recovering from merge conflicts
    FAILED: 'FAILED'            // Catastrophic failure, manual intervention needed
  };

  /**
   * Create a new CoordinatorObject
   * @param {Object} params - Coordinator parameters
   * @param {string} params.topicID - Topic this coordinator manages
   * @param {string|null} [params.currentSubscribers] - Current subscriber collection ID
   * @param {string|null} [params.currentMessages] - Current message collection ID
   * @param {Array<string>} [params.subscriberHistory] - Historical subscriber collection IDs
   * @param {Array<string>} [params.messageHistory] - Historical message collection IDs
   * @param {string|null} [params.previousCoordinator] - Link to snapshot
   * @param {number} [params.version] - Coordinator version
   * @param {string} [params.state] - Channel state
   * @param {string} [params.coordinatorID] - Optional pre-computed coordinator ID
   * @param {number} [params.createdAt] - Creation timestamp
   * @param {number} [params.lastModified] - Last modification timestamp
   */
  constructor(params) {
    // Required fields validation
    if (!params.topicID) throw new Error('Coordinator requires topicID');

    this.topicID = params.topicID;
    this.version = params.version !== undefined ? params.version : 0;
    this.currentSubscribers = params.currentSubscribers || null;
    this.currentMessages = params.currentMessages || null;
    this.subscriberHistory = params.subscriberHistory || [];
    this.messageHistory = params.messageHistory || [];
    this.previousCoordinator = params.previousCoordinator || null;
    this.state = params.state || CoordinatorObject.ChannelState.ACTIVE;

    this.createdAt = params.createdAt || Date.now();
    this.lastModified = params.lastModified || this.createdAt;

    // Generate deterministic coordinator ID if not provided
    this.coordinatorID = params.coordinatorID || this.generateCoordinatorID();
  }

  /**
   * Generate deterministic coordinator ID from topic ID
   * @returns {string} - 40-character hex string (160-bit hash)
   */
  generateCoordinatorID() {
    // Coordinator ID is just the topic ID hashed
    // This ensures all nodes find the same coordinator location in DHT
    const id = DHTNodeId.fromString(this.topicID);
    return id.toString();
  }

  /**
   * Update subscriber collection (creates NEW coordinator with incremented version)
   * @param {string} newSubscriberCollectionID - New subscriber collection ID
   * @returns {CoordinatorObject} - New coordinator instance
   */
  updateSubscribers(newSubscriberCollectionID) {
    const newHistory = [...this.subscriberHistory];
    if (this.currentSubscribers) {
      newHistory.push(this.currentSubscribers);
    }

    return new CoordinatorObject({
      topicID: this.topicID,
      version: this.version + 1,
      currentSubscribers: newSubscriberCollectionID,
      currentMessages: this.currentMessages,
      subscriberHistory: newHistory,
      messageHistory: this.messageHistory,
      previousCoordinator: this.previousCoordinator,
      state: this.state,
      coordinatorID: this.coordinatorID,
      createdAt: this.createdAt,
      lastModified: Date.now()
    });
  }

  /**
   * Update message collection (creates NEW coordinator with incremented version)
   * @param {string} newMessageCollectionID - New message collection ID
   * @returns {CoordinatorObject} - New coordinator instance
   */
  updateMessages(newMessageCollectionID) {
    const newHistory = [...this.messageHistory];
    if (this.currentMessages) {
      newHistory.push(this.currentMessages);
    }

    return new CoordinatorObject({
      topicID: this.topicID,
      version: this.version + 1,
      currentSubscribers: this.currentSubscribers,
      currentMessages: newMessageCollectionID,
      subscriberHistory: this.subscriberHistory,
      messageHistory: newHistory,
      previousCoordinator: this.previousCoordinator,
      state: this.state,
      coordinatorID: this.coordinatorID,
      createdAt: this.createdAt,
      lastModified: Date.now()
    });
  }

  /**
   * Update both collections simultaneously (creates NEW coordinator)
   * @param {string} newSubscriberCollectionID - New subscriber collection ID
   * @param {string} newMessageCollectionID - New message collection ID
   * @returns {CoordinatorObject} - New coordinator instance
   */
  updateBoth(newSubscriberCollectionID, newMessageCollectionID) {
    const newSubscriberHistory = [...this.subscriberHistory];
    if (this.currentSubscribers) {
      newSubscriberHistory.push(this.currentSubscribers);
    }

    const newMessageHistory = [...this.messageHistory];
    if (this.currentMessages) {
      newMessageHistory.push(this.currentMessages);
    }

    return new CoordinatorObject({
      topicID: this.topicID,
      version: this.version + 1,
      currentSubscribers: newSubscriberCollectionID,
      currentMessages: newMessageCollectionID,
      subscriberHistory: newSubscriberHistory,
      messageHistory: newMessageHistory,
      previousCoordinator: this.previousCoordinator,
      state: this.state,
      coordinatorID: this.coordinatorID,
      createdAt: this.createdAt,
      lastModified: Date.now()
    });
  }

  /**
   * Check if coordinator needs pruning
   * @returns {boolean} - True if pruning is needed
   */
  needsPruning() {
    const size = JSON.stringify(this.serialize()).length;
    const historySize = Math.max(
      this.subscriberHistory.length,
      this.messageHistory.length
    );

    return size > CoordinatorObject.MAX_COORDINATOR_SIZE ||
           historySize > CoordinatorObject.MAX_HISTORY_ENTRIES;
  }

  /**
   * Prune coordinator history (creates NEW coordinator with snapshot)
   * @returns {{coordinator: CoordinatorObject, snapshot: CoordinatorSnapshot}}
   */
  prune() {
    // Keep only recent entries
    const keepCount = CoordinatorObject.MIN_HISTORY_ENTRIES;
    const newSubscriberHistory = this.subscriberHistory.slice(-keepCount);
    const newMessageHistory = this.messageHistory.slice(-keepCount);

    // Create snapshot of pruned history
    const prunedSubscriberHistory = this.subscriberHistory.slice(0, -keepCount);
    const prunedMessageHistory = this.messageHistory.slice(0, -keepCount);

    const snapshot = CoordinatorSnapshot.createFromPruning({
      version: this.version,
      topicID: this.topicID,
      prunedSubscriberHistory,
      prunedMessageHistory,
      previousCoordinator: this.previousCoordinator
    });

    // Create new coordinator with pruned history and link to snapshot
    const prunedCoordinator = new CoordinatorObject({
      topicID: this.topicID,
      version: this.version,
      currentSubscribers: this.currentSubscribers,
      currentMessages: this.currentMessages,
      subscriberHistory: newSubscriberHistory,
      messageHistory: newMessageHistory,
      previousCoordinator: snapshot.snapshotID,
      state: this.state,
      coordinatorID: this.coordinatorID,
      createdAt: this.createdAt,
      lastModified: Date.now()
    });

    return { coordinator: prunedCoordinator, snapshot };
  }

  /**
   * Merge with another coordinator (for conflict resolution)
   * Takes set union of all collection IDs from both histories
   * @param {CoordinatorObject} otherCoordinator - Coordinator to merge with
   * @returns {CoordinatorObject} - New merged coordinator
   */
  merge(otherCoordinator) {
    // Take the higher version number
    const maxVersion = Math.max(this.version, otherCoordinator.version);

    // Merge histories (set union)
    const subscriberHistorySet = new Set([
      ...this.subscriberHistory,
      ...otherCoordinator.subscriberHistory
    ]);

    const messageHistorySet = new Set([
      ...this.messageHistory,
      ...otherCoordinator.messageHistory
    ]);

    // Add current collections to histories if they differ
    if (this.currentSubscribers) subscriberHistorySet.add(this.currentSubscribers);
    if (otherCoordinator.currentSubscribers) subscriberHistorySet.add(otherCoordinator.currentSubscribers);
    if (this.currentMessages) messageHistorySet.add(this.currentMessages);
    if (otherCoordinator.currentMessages) messageHistorySet.add(otherCoordinator.currentMessages);

    // Convert back to arrays
    const mergedSubscriberHistory = Array.from(subscriberHistorySet);
    const mergedMessageHistory = Array.from(messageHistorySet);

    // Take most recent current collections
    // For equal versions, prefer non-null values to preserve data during concurrent updates
    const currentSubscribers = otherCoordinator.version >= this.version
      ? (otherCoordinator.currentSubscribers || this.currentSubscribers)
      : this.currentSubscribers;

    const currentMessages = otherCoordinator.version >= this.version
      ? (otherCoordinator.currentMessages || this.currentMessages)
      : this.currentMessages;

    // Link to previous coordinators (prefer most recent)
    const previousCoordinator = otherCoordinator.version > this.version
      ? otherCoordinator.previousCoordinator
      : this.previousCoordinator;

    // State transitions: ACTIVE stays ACTIVE, any RECOVERING/FAILED propagates
    let mergedState = CoordinatorObject.ChannelState.ACTIVE;
    if (this.state === CoordinatorObject.ChannelState.FAILED ||
        otherCoordinator.state === CoordinatorObject.ChannelState.FAILED) {
      mergedState = CoordinatorObject.ChannelState.FAILED;
    } else if (this.state === CoordinatorObject.ChannelState.RECOVERING ||
               otherCoordinator.state === CoordinatorObject.ChannelState.RECOVERING) {
      mergedState = CoordinatorObject.ChannelState.RECOVERING;
    }

    return new CoordinatorObject({
      topicID: this.topicID,
      version: maxVersion + 1, // Increment version for merge
      currentSubscribers,
      currentMessages,
      subscriberHistory: mergedSubscriberHistory,
      messageHistory: mergedMessageHistory,
      previousCoordinator,
      state: mergedState,
      coordinatorID: this.coordinatorID,
      createdAt: Math.min(this.createdAt, otherCoordinator.createdAt),
      lastModified: Date.now()
    });
  }

  /**
   * Update channel state
   * @param {string} newState - New state (ACTIVE, RECOVERING, FAILED)
   * @returns {CoordinatorObject} - New coordinator with updated state
   */
  updateState(newState) {
    if (!Object.values(CoordinatorObject.ChannelState).includes(newState)) {
      throw new Error(`Invalid state: ${newState}`);
    }

    return new CoordinatorObject({
      topicID: this.topicID,
      version: this.version,
      currentSubscribers: this.currentSubscribers,
      currentMessages: this.currentMessages,
      subscriberHistory: this.subscriberHistory,
      messageHistory: this.messageHistory,
      previousCoordinator: this.previousCoordinator,
      state: newState,
      coordinatorID: this.coordinatorID,
      createdAt: this.createdAt,
      lastModified: Date.now()
    });
  }

  /**
   * Get coordinator size in bytes (approximate)
   * @returns {number} - Size in bytes
   */
  getSize() {
    return JSON.stringify(this.serialize()).length;
  }

  /**
   * Get total history size
   * @returns {number} - Total number of historical collection IDs
   */
  getHistorySize() {
    return this.subscriberHistory.length + this.messageHistory.length;
  }

  /**
   * Serialize coordinator for DHT storage
   * @returns {Object} - Plain object suitable for JSON serialization
   */
  serialize() {
    return {
      coordinatorID: this.coordinatorID,
      topicID: this.topicID,
      version: this.version,
      currentSubscribers: this.currentSubscribers,
      currentMessages: this.currentMessages,
      subscriberHistory: this.subscriberHistory.slice(),
      messageHistory: this.messageHistory.slice(),
      previousCoordinator: this.previousCoordinator,
      state: this.state,
      createdAt: this.createdAt,
      lastModified: this.lastModified
    };
  }

  /**
   * Deserialize coordinator from DHT storage
   * @param {Object} obj - Serialized coordinator object
   * @returns {CoordinatorObject} - Coordinator instance
   */
  static deserialize(obj) {
    return new CoordinatorObject({
      coordinatorID: obj.coordinatorID,
      topicID: obj.topicID,
      version: obj.version !== undefined ? obj.version : 0,
      currentSubscribers: obj.currentSubscribers || null,
      currentMessages: obj.currentMessages || null,
      subscriberHistory: obj.subscriberHistory || [],
      messageHistory: obj.messageHistory || [],
      previousCoordinator: obj.previousCoordinator || null,
      state: obj.state || CoordinatorObject.ChannelState.ACTIVE,
      createdAt: obj.createdAt,
      lastModified: obj.lastModified
    });
  }

  /**
   * Validate coordinator structure
   * @returns {{valid: boolean, errors: string[]}}
   */
  validate() {
    const errors = [];

    // Check required fields
    if (!this.coordinatorID) errors.push('Missing coordinatorID');
    if (!this.topicID) errors.push('Missing topicID');
    if (this.version === undefined) errors.push('Missing version');
    if (!Array.isArray(this.subscriberHistory)) errors.push('subscriberHistory must be an array');
    if (!Array.isArray(this.messageHistory)) errors.push('messageHistory must be an array');
    if (!this.createdAt) errors.push('Missing createdAt');
    if (!this.lastModified) errors.push('Missing lastModified');
    if (!this.state) errors.push('Missing state');

    // Verify version is non-negative
    if (this.version < 0) {
      errors.push('version must be non-negative');
    }

    // Verify state is valid
    if (!Object.values(CoordinatorObject.ChannelState).includes(this.state)) {
      errors.push(`Invalid state: ${this.state}`);
    }

    // Verify timestamps
    if (this.createdAt > this.lastModified) {
      errors.push('createdAt cannot be after lastModified');
    }

    // Verify coordinator ID matches topic ID hash
    const expectedID = DHTNodeId.fromString(this.topicID).toString();
    if (this.coordinatorID !== expectedID) {
      errors.push(`Coordinator ID mismatch: expected ${expectedID}, got ${this.coordinatorID}`);
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Create initial coordinator for a new topic
   * @param {string} topicID - Topic ID
   * @returns {CoordinatorObject} - New coordinator with version 0
   */
  static createInitial(topicID) {
    return new CoordinatorObject({
      topicID,
      version: 0,
      currentSubscribers: null,
      currentMessages: null,
      subscriberHistory: [],
      messageHistory: [],
      previousCoordinator: null,
      state: CoordinatorObject.ChannelState.ACTIVE
    });
  }

  /**
   * Create a human-readable string representation
   * @returns {string}
   */
  toString() {
    return `CoordinatorObject(topic=${this.topicID.substring(0, 8)}... version=${this.version} state=${this.state} histories=${this.getHistorySize()} size=${this.getSize()}B)`;
  }
}
