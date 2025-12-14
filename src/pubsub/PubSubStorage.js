/**
 * PubSubStorage - DHT storage integration for Sticky Pub/Sub
 *
 * Provides type-safe storage and retrieval of all pub/sub data structures
 * in the DHT. Handles serialization/deserialization and automatic TTL management.
 *
 * Storage Keys:
 * - Coordinator: hash(topicID) -> CoordinatorObject
 * - MessageCollection: collectionID -> MessageCollection
 * - SubscriberCollection: collectionID -> SubscriberCollection
 * - Message: messageID -> Message
 * - Snapshot: snapshotID -> CoordinatorSnapshot
 *
 * Integration:
 * - Uses KademliaDHT.store() and KademliaDHT.get() methods
 * - Automatic TTL management via content-based expiry
 * - Replication to k-closest nodes (typically k=20)
 */

import { CoordinatorObject } from './CoordinatorObject.js';
import { MessageCollection } from './MessageCollection.js';
import { SubscriberCollection } from './SubscriberCollection.js';
import { Message } from './Message.js';
import { CoordinatorSnapshot } from './CoordinatorSnapshot.js';

export class PubSubStorage {
  /**
   * Create new PubSubStorage instance
   * @param {KademliaDHT} dht - DHT instance for storage/retrieval
   */
  constructor(dht) {
    if (!dht) throw new Error('PubSubStorage requires DHT instance');
    this.dht = dht;
  }

  // ==========================================
  // COORDINATOR OPERATIONS
  // ==========================================

  /**
   * Store coordinator in DHT
   * Coordinators are stored at hash(topicID) for predictable location
   * @param {CoordinatorObject} coordinator - Coordinator to store
   * @returns {Promise<boolean>} - True if storage succeeded
   */
  async storeCoordinator(coordinator) {
    if (!(coordinator instanceof CoordinatorObject)) {
      throw new Error('Expected CoordinatorObject instance');
    }

    const validation = coordinator.validate();
    if (!validation.valid) {
      throw new Error(`Invalid coordinator: ${validation.errors.join(', ')}`);
    }

    // Coordinators don't have TTL - they're mutable and always "current"
    // Store at predictable location: hash(topicID)
    const key = `coordinator:${coordinator.topicID}`;
    const serialized = coordinator.serialize();

    console.log(`💾 Storing coordinator for topic ${coordinator.topicID.substring(0, 8)}... (version ${coordinator.version})`);
    return await this.dht.store(key, serialized);
  }

  /**
   * Load coordinator from DHT
   * Always fetches from network to get the latest version (coordinators are mutable)
   * @param {string} topicID - Topic ID
   * @returns {Promise<CoordinatorObject|null>} - Coordinator or null if not found
   */
  async loadCoordinator(topicID) {
    const key = `coordinator:${topicID}`;
    console.log(`🔍 Loading coordinator for topic ${topicID.substring(0, 8)}... (always network fetch)`);

    try {
      // ALWAYS fetch from network - coordinators are mutable data that MUST NOT be cached locally
      // Local caching of coordinators is architecturally wrong - they change frequently
      const data = await this.dht.getFromNetwork(key);
      if (!data) {
        console.log(`   Coordinator not found for topic ${topicID.substring(0, 8)}...`);
        return null;
      }

      const coordinator = CoordinatorObject.deserialize(data);
      console.log(`   ✅ Loaded coordinator (version ${coordinator.version}) from network`);
      return coordinator;
    } catch (error) {
      console.error(`   ❌ Failed to load coordinator: ${error.message}`);
      return null;
    }
  }

  /**
   * Load coordinator with resilient fallback strategy
   * IMPROVED: Handles connection failures gracefully for PubSub channel creation
   * @param {string} topicID - Topic ID
   * @returns {Promise<CoordinatorObject|null>} - Coordinator or null if not found
   */
  async loadCoordinatorResilient(topicID) {
    const key = `coordinator:${topicID}`;
    console.log(`🔍 Loading coordinator (resilient) for topic ${topicID.substring(0, 8)}...`);

    try {
      // First attempt: Try normal network fetch
      const data = await this.dht.getFromNetwork(key);
      if (data) {
        const coordinator = CoordinatorObject.deserialize(data);
        console.log(`   ✅ Loaded coordinator (version ${coordinator.version}) from network`);
        return coordinator;
      }
      
      console.log(`   Coordinator not found for topic ${topicID.substring(0, 8)}...`);
      return null;
      
    } catch (error) {
      console.warn(`   ⚠️ Network fetch failed: ${error.message}`);
      
      // Fallback: Clean up routing table and try local cache as last resort
      console.log(`   🔄 Cleaning up routing table and retrying...`);
      
      try {
        // Clean up stale routing table entries
        this.dht.cleanupRoutingTable();
        
        // Wait a moment for cleanup to complete
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Try local cache as absolute last resort (may be stale but better than nothing)
        const localData = await this.dht.get(key);
        if (localData) {
          const coordinator = CoordinatorObject.deserialize(localData);
          console.log(`   ⚠️ Using local cache coordinator (version ${coordinator.version}) - may be stale`);
          return coordinator;
        }
        
      } catch (fallbackError) {
        console.error(`   ❌ Fallback also failed: ${fallbackError.message}`);
      }
      
      console.error(`   ❌ All coordinator loading attempts failed for topic ${topicID.substring(0, 8)}...`);
      return null;
    }
  }

  /**
   * Store coordinator with version check (optimistic locking)
   * @param {CoordinatorObject} newCoordinator - New coordinator to store
   * @param {number} expectedVersion - Expected current version
   * @returns {Promise<{success: boolean, conflict: boolean, currentVersion?: number}>}
   */
  async storeCoordinatorWithVersionCheck(newCoordinator, expectedVersion) {
    // Use atomic compare-and-swap if available (for proper concurrency testing)
    if (typeof this.dht.compareAndSwapCoordinator === 'function') {
      return await this.dht.compareAndSwapCoordinator(
        newCoordinator.topicID,
        newCoordinator,
        expectedVersion
      );
    }

    // Fallback to non-atomic version (for real DHT usage)
    // Load current coordinator
    const currentCoordinator = await this.loadCoordinator(newCoordinator.topicID);

    // Check for version conflict
    if (currentCoordinator && currentCoordinator.version !== expectedVersion) {
      console.warn(`⚠️ Version conflict: expected ${expectedVersion}, found ${currentCoordinator.version}`);
      return {
        success: false,
        conflict: true,
        currentVersion: currentCoordinator.version,
        currentCoordinator
      };
    }

    // No conflict, store new version
    const success = await this.storeCoordinator(newCoordinator);
    return {
      success,
      conflict: false,
      currentVersion: newCoordinator.version
    };
  }

  // ==========================================
  // MESSAGE COLLECTION OPERATIONS
  // ==========================================

  /**
   * Store message collection in DHT
   * @param {MessageCollection} collection - Collection to store
   * @returns {Promise<boolean>} - True if storage succeeded
   */
  async storeMessageCollection(collection) {
    if (!(collection instanceof MessageCollection)) {
      throw new Error('Expected MessageCollection instance');
    }

    const validation = collection.validate();
    if (!validation.valid) {
      throw new Error(`Invalid message collection: ${validation.errors.join(', ')}`);
    }

    // Collections have content-based TTL
    const key = `msgcoll:${collection.collectionID}`;
    const serialized = collection.serialize();

    console.log(`💾 Storing message collection ${collection.collectionID.substring(0, 8)}... (${collection.size()} messages)`);
    return await this.dht.store(key, serialized);
  }

  /**
   * Load message collection from DHT
   * Always fetches from network to get the latest version (collections are mutable)
   * @param {string} collectionID - Collection ID
   * @returns {Promise<MessageCollection|null>} - Collection or null if not found
   */
  async loadMessageCollection(collectionID) {
    const key = `msgcoll:${collectionID}`;

    try {
      // ALWAYS fetch from network - message collections are mutable data that MUST NOT be cached locally
      const data = await this.dht.getFromNetwork(key);
      if (!data) {
        console.log(`   Message collection ${collectionID.substring(0, 8)}... not found`);
        return null;
      }

      const collection = MessageCollection.deserialize(data);
      console.log(`   ✅ Loaded message collection (${collection.size()} messages) from network`);
      return collection;
    } catch (error) {
      console.error(`   ❌ Failed to load message collection: ${error.message}`);
      return null;
    }
  }

  // ==========================================
  // SUBSCRIBER COLLECTION OPERATIONS
  // ==========================================

  /**
   * Store subscriber collection in DHT
   * @param {SubscriberCollection} collection - Collection to store
   * @returns {Promise<boolean>} - True if storage succeeded
   */
  async storeSubscriberCollection(collection) {
    if (!(collection instanceof SubscriberCollection)) {
      throw new Error('Expected SubscriberCollection instance');
    }

    const validation = collection.validate();
    if (!validation.valid) {
      throw new Error(`Invalid subscriber collection: ${validation.errors.join(', ')}`);
    }

    const key = `subcoll:${collection.collectionID}`;
    const serialized = collection.serialize();

    console.log(`💾 Storing subscriber collection ${collection.collectionID.substring(0, 8)}... (${collection.size()} subscribers)`);
    return await this.dht.store(key, serialized);
  }

  /**
   * Load subscriber collection from DHT
   * Always fetches from network to get the latest version (collections are mutable)
   * @param {string} collectionID - Collection ID
   * @returns {Promise<SubscriberCollection|null>} - Collection or null if not found
   */
  async loadSubscriberCollection(collectionID) {
    const key = `subcoll:${collectionID}`;

    try {
      // ALWAYS fetch from network - subscriber collections are mutable data that MUST NOT be cached locally
      const data = await this.dht.getFromNetwork(key);
      if (!data) {
        console.log(`   Subscriber collection ${collectionID.substring(0, 8)}... not found`);
        return null;
      }

      const collection = SubscriberCollection.deserialize(data);
      console.log(`   ✅ Loaded subscriber collection (${collection.size()} subscribers) from network`);
      return collection;
    } catch (error) {
      console.error(`   ❌ Failed to load subscriber collection: ${error.message}`);
      return null;
    }
  }

  // ==========================================
  // MESSAGE OPERATIONS
  // ==========================================

  /**
   * Store individual message in DHT
   * @param {Message} message - Message to store
   * @returns {Promise<boolean>} - True if storage succeeded
   */
  async storeMessage(message) {
    if (!(message instanceof Message)) {
      throw new Error('Expected Message instance');
    }

    // Validate message (requires public key for signature verification)
    // Skip signature validation during storage - will be validated on retrieval
    if (!message.signature) {
      throw new Error('Message must be signed before storage');
    }

    const key = `msg:${message.messageID}`;
    const serialized = message.serialize();

    console.log(`💾 Storing message ${message.messageID.substring(0, 8)}... from ${message.publisherID.substring(0, 8)}...`);
    return await this.dht.store(key, serialized);
  }

  /**
   * Load individual message from DHT
   * @param {string} messageID - Message ID
   * @returns {Promise<Message|null>} - Message or null if not found
   */
  async loadMessage(messageID) {
    const key = `msg:${messageID}`;

    try {
      const data = await this.dht.get(key);
      if (!data) {
        console.log(`   Message ${messageID.substring(0, 8)}... not found`);
        return null;
      }

      const message = Message.deserialize(data);
      console.log(`   ✅ Loaded message from ${message.publisherID.substring(0, 8)}... (seq ${message.publisherSequence})`);
      return message;
    } catch (error) {
      console.error(`   ❌ Failed to load message: ${error.message}`);
      return null;
    }
  }

  /**
   * Load multiple messages by IDs (parallel)
   * @param {Array<string>} messageIDs - Array of message IDs
   * @returns {Promise<Array<Message>>} - Array of messages (may be incomplete if some fail)
   */
  async loadMessages(messageIDs) {
    console.log(`🔍 Loading ${messageIDs.length} messages in parallel...`);

    const loadPromises = messageIDs.map(id => this.loadMessage(id));
    const results = await Promise.allSettled(loadPromises);

    const messages = results
      .filter(r => r.status === 'fulfilled' && r.value !== null)
      .map(r => r.value);

    const failures = results.filter(r => r.status === 'rejected' || r.value === null).length;
    if (failures > 0) {
      console.warn(`   ⚠️ Failed to load ${failures}/${messageIDs.length} messages`);
    }

    return messages;
  }

  // ==========================================
  // SNAPSHOT OPERATIONS
  // ==========================================

  /**
   * Store coordinator snapshot in DHT
   * @param {CoordinatorSnapshot} snapshot - Snapshot to store
   * @returns {Promise<boolean>} - True if storage succeeded
   */
  async storeSnapshot(snapshot) {
    if (!(snapshot instanceof CoordinatorSnapshot)) {
      throw new Error('Expected CoordinatorSnapshot instance');
    }

    const validation = snapshot.validate();
    if (!validation.valid) {
      throw new Error(`Invalid snapshot: ${validation.errors.join(', ')}`);
    }

    const key = `snapshot:${snapshot.snapshotID}`;
    const serialized = snapshot.serialize();

    console.log(`💾 Storing snapshot ${snapshot.snapshotID.substring(0, 8)}... (version ${snapshot.version})`);
    return await this.dht.store(key, serialized);
  }

  /**
   * Load coordinator snapshot from DHT
   * Always fetches from network (snapshots are versioned and shouldn't be locally cached)
   * @param {string} snapshotID - Snapshot ID
   * @returns {Promise<CoordinatorSnapshot|null>} - Snapshot or null if not found
   */
  async loadSnapshot(snapshotID) {
    const key = `snapshot:${snapshotID}`;

    try {
      // ALWAYS fetch from network - snapshots are mutable data that MUST NOT be cached locally
      const data = await this.dht.getFromNetwork(key);
      if (!data) {
        console.log(`   Snapshot ${snapshotID.substring(0, 8)}... not found`);
        return null;
      }

      const snapshot = CoordinatorSnapshot.deserialize(data);
      console.log(`   ✅ Loaded snapshot (version ${snapshot.version}) from network`);
      return snapshot;
    } catch (error) {
      console.error(`   ❌ Failed to load snapshot: ${error.message}`);
      return null;
    }
  }

  /**
   * Load snapshot chain (traverse linked list)
   * @param {string} snapshotID - Starting snapshot ID
   * @param {number} maxDepth - Maximum depth to traverse (prevent infinite loops)
   * @returns {Promise<Array<CoordinatorSnapshot>>} - Array of snapshots (newest first)
   */
  async loadSnapshotChain(snapshotID, maxDepth = 10) {
    const chain = [];
    let currentID = snapshotID;
    let depth = 0;

    while (currentID && depth < maxDepth) {
      const snapshot = await this.loadSnapshot(currentID);
      if (!snapshot) {
        console.warn(`   ⚠️ Snapshot chain broken at ${currentID.substring(0, 8)}...`);
        break;
      }

      chain.push(snapshot);
      currentID = snapshot.previousCoordinator;
      depth++;
    }

    if (depth >= maxDepth) {
      console.warn(`   ⚠️ Snapshot chain exceeded max depth ${maxDepth}, possible circular reference`);
    }

    console.log(`   ✅ Loaded snapshot chain with ${chain.length} snapshots`);
    return chain;
  }

  // ==========================================
  // UTILITY METHODS
  // ==========================================

  /**
   * Check if a key exists in DHT (without loading full value)
   * @param {string} key - Storage key
   * @returns {Promise<boolean>} - True if key exists
   */
  async exists(key) {
    try {
      const data = await this.dht.get(key);
      return data !== null && data !== undefined;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get storage statistics
   * @returns {Object} - Storage stats
   */
  getStats() {
    return {
      localStorageSize: this.dht.storage?.size || 0,
      dhtNodes: this.dht.routingTable?.getAllNodes()?.length || 0,
      connectedPeers: this.dht.getConnectedPeers?.()?.length || 0
    };
  }
}
