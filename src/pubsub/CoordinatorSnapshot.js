/**
 * CoordinatorSnapshot - Historical snapshot of coordinator history
 *
 * When a coordinator's history grows too large, it creates a snapshot containing
 * the pruned historical entries. Snapshots form a linked list via previousCoordinator,
 * allowing deep history access for conflict resolution while keeping active
 * coordinator size bounded.
 *
 * Key Features:
 * - Fixed TTL: snapshots expire after 1 hour (independent of content)
 * - Linked list: previousCoordinator points to older snapshot
 * - Immutable: snapshots never modified after creation
 * - Lazy loading: only loaded when deep history merge is needed
 *
 * Integration:
 * - Referenced by CoordinatorObject.previousCoordinator
 * - Stored separately in DHT at snapshotID location
 * - Chain traversed during deep conflict resolution
 */

import { DHTNodeId } from '../core/DHTNodeId.js';

export class CoordinatorSnapshot {
  /**
   * Snapshots expire 1 hour after creation
   * This is independent of content expiry - snapshots are temporary conflict resolution aids
   */
  static SNAPSHOT_TTL = 3600000; // 1 hour in milliseconds

  /**
   * Create a new CoordinatorSnapshot
   * @param {Object} params - Snapshot parameters
   * @param {number} params.version - Coordinator version at time of snapshot
   * @param {string} params.topicID - Topic this snapshot belongs to
   * @param {Array<string>} params.subscriberHistory - Historical subscriber collection IDs
   * @param {Array<string>} params.messageHistory - Historical message collection IDs
   * @param {string|null} [params.previousCoordinator] - Link to previous snapshot
   * @param {string} [params.snapshotID] - Optional pre-computed snapshot ID
   * @param {number} [params.createdAt] - Creation timestamp
   * @param {number} [params.expiresAt] - Expiration timestamp
   */
  constructor(params) {
    // Required fields validation
    if (params.version === undefined) throw new Error('Snapshot requires version');
    if (!params.topicID) throw new Error('Snapshot requires topicID');
    if (!params.subscriberHistory) throw new Error('Snapshot requires subscriberHistory');
    if (!params.messageHistory) throw new Error('Snapshot requires messageHistory');

    this.version = params.version;
    this.topicID = params.topicID;
    this.subscriberHistory = params.subscriberHistory || [];
    this.messageHistory = params.messageHistory || [];
    this.previousCoordinator = params.previousCoordinator || null;
    this.isSnapshot = true; // Flag to identify as snapshot (not active coordinator)

    this.createdAt = params.createdAt || Date.now();
    this.expiresAt = params.expiresAt || (this.createdAt + CoordinatorSnapshot.SNAPSHOT_TTL);

    // Generate deterministic snapshot ID if not provided
    this.snapshotID = params.snapshotID || this.generateSnapshotID();
  }

  /**
   * Generate deterministic snapshot ID
   * @returns {string} - 40-character hex string (160-bit hash)
   */
  generateSnapshotID() {
    // Include version and creation time for uniqueness
    const content = `snapshot:${this.topicID}:${this.version}:${this.createdAt}`;
    const id = DHTNodeId.fromString(content);
    return id.toString();
  }

  /**
   * Check if snapshot has expired
   * @returns {boolean} - True if snapshot is expired
   */
  isExpired() {
    return Date.now() > this.expiresAt;
  }

  /**
   * Get total number of historical entries
   * @returns {number} - Combined history size
   */
  getHistorySize() {
    return this.subscriberHistory.length + this.messageHistory.length;
  }

  /**
   * Get depth of snapshot chain (for debugging)
   * Requires loading linked snapshots to calculate
   * @returns {number} - Number of snapshots in chain including this one
   */
  getChainDepth() {
    let depth = 1;
    let current = this;

    // Count until we reach a snapshot with no previous link
    // (In real usage, would need to load snapshots from DHT)
    while (current.previousCoordinator) {
      depth++;
      // Break to prevent infinite loop in case of circular reference
      if (depth > 100) {
        console.warn('⚠️ Possible circular snapshot chain detected');
        break;
      }
      // In real implementation, would load previous snapshot here
      break;
    }

    return depth;
  }

  /**
   * Serialize snapshot for DHT storage
   * @returns {Object} - Plain object suitable for JSON serialization
   */
  serialize() {
    return {
      snapshotID: this.snapshotID,
      version: this.version,
      topicID: this.topicID,
      subscriberHistory: this.subscriberHistory.slice(), // Copy array
      messageHistory: this.messageHistory.slice(),
      previousCoordinator: this.previousCoordinator,
      isSnapshot: true,
      createdAt: this.createdAt,
      expiresAt: this.expiresAt
    };
  }

  /**
   * Deserialize snapshot from DHT storage
   * @param {Object} obj - Serialized snapshot object
   * @returns {CoordinatorSnapshot} - Snapshot instance
   */
  static deserialize(obj) {
    return new CoordinatorSnapshot({
      snapshotID: obj.snapshotID,
      version: obj.version,
      topicID: obj.topicID,
      subscriberHistory: obj.subscriberHistory || [],
      messageHistory: obj.messageHistory || [],
      previousCoordinator: obj.previousCoordinator || null,
      createdAt: obj.createdAt,
      expiresAt: obj.expiresAt
    });
  }

  /**
   * Validate snapshot structure
   * @returns {{valid: boolean, errors: string[]}}
   */
  validate() {
    const errors = [];

    // Check required fields
    if (!this.snapshotID) errors.push('Missing snapshotID');
    if (this.version === undefined) errors.push('Missing version');
    if (!this.topicID) errors.push('Missing topicID');
    if (!Array.isArray(this.subscriberHistory)) errors.push('subscriberHistory must be an array');
    if (!Array.isArray(this.messageHistory)) errors.push('messageHistory must be an array');
    if (!this.createdAt) errors.push('Missing createdAt');
    if (!this.expiresAt) errors.push('Missing expiresAt');
    if (!this.isSnapshot) errors.push('isSnapshot flag must be true');

    // Verify timestamps
    if (this.createdAt > this.expiresAt) {
      errors.push('createdAt cannot be after expiresAt');
    }

    // Verify version is non-negative
    if (this.version < 0) {
      errors.push('version must be non-negative');
    }

    // Validate history arrays contain strings (collection IDs)
    for (let i = 0; i < this.subscriberHistory.length; i++) {
      if (typeof this.subscriberHistory[i] !== 'string') {
        errors.push(`subscriberHistory[${i}] must be a string (collection ID)`);
      }
    }

    for (let i = 0; i < this.messageHistory.length; i++) {
      if (typeof this.messageHistory[i] !== 'string') {
        errors.push(`messageHistory[${i}] must be a string (collection ID)`);
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
    const hasLink = this.previousCoordinator ? 'linked' : 'root';
    return `CoordinatorSnapshot(${this.snapshotID.substring(0, 8)}... version=${this.version} topic=${this.topicID.substring(0, 8)}... histories=${this.getHistorySize()} ${hasLink})`;
  }

  /**
   * Create snapshot from coordinator pruning
   * Static factory method for creating snapshots during coordinator pruning
   * @param {Object} params - Snapshot creation parameters
   * @param {number} params.version - Coordinator version
   * @param {string} params.topicID - Topic ID
   * @param {Array<string>} params.prunedSubscriberHistory - Pruned subscriber collection IDs
   * @param {Array<string>} params.prunedMessageHistory - Pruned message collection IDs
   * @param {string|null} params.previousCoordinator - Link to older snapshot
   * @returns {CoordinatorSnapshot} - New snapshot
   */
  static createFromPruning(params) {
    return new CoordinatorSnapshot({
      version: params.version,
      topicID: params.topicID,
      subscriberHistory: params.prunedSubscriberHistory,
      messageHistory: params.prunedMessageHistory,
      previousCoordinator: params.previousCoordinator
    });
  }
}
