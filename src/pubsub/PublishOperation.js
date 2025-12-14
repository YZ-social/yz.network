/**
 * PublishOperation - Handles message publishing with optimistic concurrency
 *
 * Implements infinite retry with automatic merge for version conflicts.
 * Critical design: Store message FIRST before coordinator update to ensure
 * messages survive conflicts.
 *
 * Flow:
 * 1. Store message in DHT (survives conflicts)
 * 2. Load current coordinator
 * 3. Create/update message collection
 * 4. Update coordinator with version check
 * 5. If conflict: merge and retry
 * 6. If repeated failures: catastrophic recovery
 *
 * Integration:
 * - Uses PubSubStorage for DHT operations
 * - Uses CoordinatorObject for state management
 * - Uses Message for cryptographic signing
 */

import { Message } from './Message.js';
import { MessageCollection } from './MessageCollection.js';
import { CoordinatorObject } from './CoordinatorObject.js';
import { MessageDelivery } from './MessageDelivery.js';

export class PublishOperation {
  /**
   * Maximum backoff delay (30 seconds)
   */
  static MAX_BACKOFF = 30000;

  /**
   * Initial backoff delay (100ms)
   */
  static INITIAL_BACKOFF = 100;

  /**
   * Trigger catastrophic recovery after this many failures
   */
  static CATASTROPHIC_THRESHOLD = 10;

  /**
   * Default batch size threshold (flush when queue reaches this size)
   */
  static DEFAULT_BATCH_SIZE = 10;

  /**
   * Default batch time threshold (flush after this delay from first message)
   */
  static DEFAULT_BATCH_TIME = 100; // 100ms

  /**
   * Create new PublishOperation
   * @param {PubSubStorage} storage - Storage instance
   * @param {string} publisherID - Publisher node ID
   * @param {Object} keyInfo - Publisher's key info for signing
   * @param {Object} options - Operation options
   * @param {boolean} [options.enableBatching] - Enable automatic batching (default: false)
   * @param {number} [options.batchSize] - Batch size threshold
   * @param {number} [options.batchTime] - Batch time threshold (ms)
   * @param {KademliaDHT} [options.dht] - DHT instance for push delivery
   */
  constructor(storage, publisherID, keyInfo, options = {}) {
    if (!storage) throw new Error('PublishOperation requires storage');
    if (!publisherID) throw new Error('PublishOperation requires publisherID');
    if (!keyInfo) throw new Error('PublishOperation requires keyInfo');

    this.storage = storage;
    this.publisherID = publisherID;
    this.keyInfo = keyInfo;

    // Per-topic sequence tracking
    this.sequences = new Map(); // topicID -> next sequence number

    // Batch processing configuration
    this.enableBatching = options.enableBatching || false;
    this.batchSize = options.batchSize || PublishOperation.DEFAULT_BATCH_SIZE;
    this.batchTime = options.batchTime || PublishOperation.DEFAULT_BATCH_TIME;

    // Batch queues per topic
    this.batchQueues = new Map(); // topicID -> { messages: [], timer: null, firstMessageTime: null, resolvers: [], flushing: false }

    // Push delivery (Phase 3)
    this.messageDelivery = options.dht ? new MessageDelivery(options.dht, publisherID) : null;
  }

  /**
   * Get next sequence number for topic
   * @param {string} topicID - Topic ID
   * @returns {number} - Next sequence number
   */
  getNextSequence(topicID) {
    const current = this.sequences.get(topicID) || 0;
    const next = current + 1;
    this.sequences.set(topicID, next);
    return next;
  }

  /**
   * Publish message to topic with infinite retry
   * @param {string} topicID - Topic to publish to
   * @param {any} data - Message data (can be encrypted)
   * @param {Object} options - Publish options
   * @param {number} [options.ttl] - Message TTL in milliseconds (default: 1 hour)
   * @param {boolean} [options.immediate] - Skip batching and publish immediately
   * @returns {Promise<{success: boolean, messageID: string, version: number, attempts: number}>}
   */
  async publish(topicID, data, options = {}) {
    const ttl = options.ttl || 3600000; // Default 1 hour
    const publishedAt = Date.now();
    const expiresAt = publishedAt + ttl;

    // If batching enabled and not forcing immediate, queue the message
    if (this.enableBatching && !options.immediate) {
      return await this.queueMessage(topicID, data, { ttl, publishedAt, expiresAt });
    }

    console.log(`📤 Publishing to topic ${topicID.substring(0, 8)}...`);

    // CRITICAL: Store message FIRST before coordinator update
    // This ensures message survives any coordinator conflicts
    const message = new Message({
      topicID,
      publisherID: this.publisherID,
      publisherSequence: this.getNextSequence(topicID),
      addedInVersion: 0, // Will be updated during coordinator update
      data,
      publishedAt,
      expiresAt
    });

    // Sign message
    await message.sign(this.keyInfo);
    console.log(`   ✅ Message signed: ${message.messageID.substring(0, 8)}... (seq ${message.publisherSequence})`);

    // Store message in DHT (replication to k=20 nodes)
    const messageStored = await this.storage.storeMessage(message);
    if (!messageStored) {
      throw new Error('Failed to store message in DHT');
    }
    console.log(`   ✅ Message stored in DHT: ${message.messageID.substring(0, 8)}...`);

    // Now attempt coordinator update with infinite retry
    let attempt = 0;
    let backoffMs = PublishOperation.INITIAL_BACKOFF;

    while (true) { // Infinite retry - failure is not an option
      attempt++;
      console.log(`   🔄 Coordinator update attempt ${attempt}...`);

      try {
        // Load current coordinator (or create if doesn't exist) - use resilient loading
        let coordinator = await this.storage.loadCoordinatorResilient(topicID);
        if (!coordinator) {
          console.log(`   📝 Creating initial coordinator for topic ${topicID.substring(0, 8)}...`);
          coordinator = CoordinatorObject.createInitial(topicID);
        }

        const currentVersion = coordinator.version;
        console.log(`   📊 Current coordinator version: ${currentVersion}`);

        // Update message with correct addedInVersion
        message.addedInVersion = currentVersion + 1;

        // Load or create message collection
        let messageCollection;
        if (coordinator.currentMessages) {
          messageCollection = await this.storage.loadMessageCollection(coordinator.currentMessages);
          if (!messageCollection) {
            console.warn(`   ⚠️ Message collection ${coordinator.currentMessages.substring(0, 8)}... not found, creating new`);
            messageCollection = new MessageCollection();
          }
        } else {
          messageCollection = new MessageCollection();
        }

        // Add message to collection (creates NEW collection - immutable)
        const updatedCollection = messageCollection.addMessage({
          messageID: message.messageID,
          publisherID: message.publisherID,
          publisherSequence: message.publisherSequence,
          addedInVersion: message.addedInVersion,
          expiresAt: message.expiresAt
        });

        console.log(`   📚 Updated collection size: ${updatedCollection.size()} messages`);

        // Store new collection
        const collectionStored = await this.storage.storeMessageCollection(updatedCollection);
        if (!collectionStored) {
          throw new Error('Failed to store message collection');
        }

        // Check if coordinator needs pruning
        let finalCoordinator = coordinator;
        if (coordinator.needsPruning()) {
          console.log(`   ✂️ Coordinator needs pruning (size: ${coordinator.getSize()}B, history: ${coordinator.getHistorySize()})`);
          const { coordinator: pruned, snapshot } = coordinator.prune();

          // Store snapshot
          await this.storage.storeSnapshot(snapshot);
          console.log(`   📸 Stored snapshot: ${snapshot.snapshotID.substring(0, 8)}...`);

          finalCoordinator = pruned;
        }

        // Update coordinator with new message collection
        const updatedCoordinator = finalCoordinator.updateMessages(updatedCollection.collectionID);

        // Store coordinator with version check (optimistic locking)
        const storeResult = await this.storage.storeCoordinatorWithVersionCheck(
          updatedCoordinator,
          currentVersion
        );

        if (storeResult.conflict) {
          // VERSION CONFLICT - merge and retry
          console.warn(`   ⚠️ Version conflict: expected ${currentVersion}, found ${storeResult.currentVersion}`);
          console.log(`   🔀 Merging coordinators...`);

          // Merge our changes with current state
          const merged = updatedCoordinator.merge(storeResult.currentCoordinator);
          console.log(`   ✅ Merged coordinator (version ${merged.version})`);

          // Try to store the merged coordinator (this could also conflict, but that's fine - we'll retry)
          const mergedStoreResult = await this.storage.storeCoordinatorWithVersionCheck(
            merged,
            storeResult.currentVersion // Use the version we just loaded
          );

          if (mergedStoreResult.conflict) {
            // Another conflict during merge - check if our message is already in the current coordinator
            console.warn(`   ⚠️ Merge also conflicted, checking if message already stored...`);

            // Load the current coordinator to see if our message is already there
            const latestCoordinator = mergedStoreResult.currentCoordinator || await this.storage.loadCoordinator(topicID);
            if (latestCoordinator && latestCoordinator.currentMessages) {
              const latestCollection = await this.storage.loadMessageCollection(latestCoordinator.currentMessages);
              if (latestCollection) {
                // Check if our message is in the collection
                const ourMessage = latestCollection.messages.find(m => m.messageID === message.messageID);
                if (ourMessage) {
                  console.log(`   ✅ Message already in coordinator (version ${latestCoordinator.version}), publish complete`);

                  // Trigger push delivery (fire-and-forget)
                  await this.triggerPushDelivery(topicID, message, latestCoordinator);

                  return {
                    success: true,
                    messageID: message.messageID,
                    version: latestCoordinator.version,
                    attempts: attempt
                  };
                }
              }
            }

            // Message not in coordinator yet - retry from beginning with backoff
            console.warn(`   ⚠️ Message not yet in coordinator, will retry`);
            await this.sleep(Math.min(backoffMs, PublishOperation.MAX_BACKOFF));
            backoffMs *= 2;
            continue; // Retry entire operation
          }

          // Merged coordinator stored successfully!
          console.log(`   ✅ Published successfully after merge (version ${merged.version}, ${attempt} attempts)`);

          // Trigger push delivery (fire-and-forget)
          await this.triggerPushDelivery(topicID, message, merged);

          return {
            success: true,
            messageID: message.messageID,
            version: merged.version,
            attempts: attempt
          };
        }

        // SUCCESS!
        console.log(`   ✅ Published successfully (version ${updatedCoordinator.version}, ${attempt} attempts)`);

        // Trigger push delivery (fire-and-forget)
        await this.triggerPushDelivery(topicID, message, updatedCoordinator);

        return {
          success: true,
          messageID: message.messageID,
          version: updatedCoordinator.version,
          attempts: attempt
        };

      } catch (error) {
        console.error(`   ❌ Publish attempt ${attempt} failed: ${error.message}`);

        // Check if we should trigger catastrophic recovery
        if (attempt >= PublishOperation.CATASTROPHIC_THRESHOLD) {
          console.error(`   🚨 CATASTROPHIC: ${attempt} failures, attempting recovery...`);

          try {
            await this.catastrophicRecovery(topicID);
            console.log(`   ✅ Catastrophic recovery successful, retrying publish...`);
            // Reset backoff and continue
            backoffMs = PublishOperation.INITIAL_BACKOFF;
            continue;
          } catch (recoveryError) {
            console.error(`   💀 Catastrophic recovery FAILED: ${recoveryError.message}`);
            console.error(`   💀 Topic ${topicID} is in FAILED state, manual intervention required`);

            // Mark coordinator as FAILED
            const coordinator = await this.storage.loadCoordinator(topicID);
            if (coordinator) {
              const failed = coordinator.updateState(CoordinatorObject.ChannelState.FAILED);
              await this.storage.storeCoordinator(failed);
            }

            throw new Error(`Catastrophic failure after ${attempt} attempts: ${error.message}`);
          }
        }

        // Exponential backoff
        await this.sleep(Math.min(backoffMs, PublishOperation.MAX_BACKOFF));
        backoffMs *= 2;
      }
    }
  }

  /**
   * Catastrophic recovery: Load coordinator from majority of k-closest nodes
   * @param {string} topicID - Topic ID
   * @returns {Promise<void>}
   */
  async catastrophicRecovery(topicID) {
    console.log(`🚨 CATASTROPHIC RECOVERY for topic ${topicID.substring(0, 8)}...`);

    // Mark coordinator as RECOVERING
    const coordinator = await this.storage.loadCoordinator(topicID);
    if (coordinator) {
      const recovering = coordinator.updateState(CoordinatorObject.ChannelState.RECOVERING);
      await this.storage.storeCoordinator(recovering);
      console.log(`   ⚠️ Marked coordinator as RECOVERING`);
    }

    // In a full implementation, this would:
    // 1. Query k-closest nodes for their coordinator versions
    // 2. Take majority vote (most recent version)
    // 3. Load all collections referenced in majority coordinator
    // 4. Verify collections are loadable
    // 5. Restore coordinator to ACTIVE state

    // For Phase 2, we'll do a simplified version:
    // Just reload the coordinator and verify it's valid
    const reloaded = await this.storage.loadCoordinator(topicID);
    if (!reloaded) {
      throw new Error('Coordinator not found during recovery');
    }

    const validation = reloaded.validate();
    if (!validation.valid) {
      throw new Error(`Coordinator validation failed: ${validation.errors.join(', ')}`);
    }

    // Verify message collection is loadable
    if (reloaded.currentMessages) {
      const messageCollection = await this.storage.loadMessageCollection(reloaded.currentMessages);
      if (!messageCollection) {
        throw new Error('Message collection not found during recovery');
      }
    }

    // Mark as ACTIVE again
    const active = reloaded.updateState(CoordinatorObject.ChannelState.ACTIVE);
    await this.storage.storeCoordinator(active);
    console.log(`   ✅ Coordinator restored to ACTIVE state`);
  }

  /**
   * Queue message for batch processing
   * @param {string} topicID - Topic to publish to
   * @param {any} data - Message data
   * @param {Object} options - Publish options
   * @returns {Promise<{success: boolean, messageID: string, version: number, attempts: number}>}
   */
  async queueMessage(topicID, data, options = {}) {
    // Get or create batch queue for topic
    if (!this.batchQueues.has(topicID)) {
      this.batchQueues.set(topicID, {
        messages: [],
        timer: null,
        firstMessageTime: null,
        resolvers: [],
        flushing: false
      });
    }

    const queue = this.batchQueues.get(topicID);

    // Create message
    const message = new Message({
      topicID,
      publisherID: this.publisherID,
      publisherSequence: this.getNextSequence(topicID),
      addedInVersion: 0,
      data,
      publishedAt: options.publishedAt || Date.now(),
      expiresAt: options.expiresAt || (Date.now() + (options.ttl || 3600000))
    });

    // Sign message
    await message.sign(this.keyInfo);

    // Create promise for this message
    const promise = new Promise((resolve) => {
      queue.messages.push(message);
      queue.resolvers.push(resolve);
    });

    // Set first message time if this is first in queue
    if (queue.messages.length === 1) {
      queue.firstMessageTime = Date.now();
    }

    // Check if we should flush (size threshold)
    if (queue.messages.length >= this.batchSize && !queue.flushing) {
      console.log(`   📦 Batch size threshold reached (${queue.messages.length}), flushing...`);

      // Clear timer if set (prevent double flush)
      if (queue.timer) {
        clearTimeout(queue.timer);
        queue.timer = null;
      }

      setImmediate(() => this.flushBatch(topicID));
    } else if (!queue.timer && !queue.flushing) {
      // Set timer for time-based flush (only if not already flushing)
      queue.timer = setTimeout(() => {
        console.log(`   ⏰ Batch time threshold reached, flushing...`);
        this.flushBatch(topicID);
      }, this.batchTime);
    }

    return promise;
  }

  /**
   * Flush queued messages for a topic (update coordinator once with all messages)
   * @param {string} topicID - Topic to flush
   * @returns {Promise<void>}
   */
  async flushBatch(topicID) {
    const queue = this.batchQueues.get(topicID);
    if (!queue || queue.messages.length === 0) {
      return;
    }

    // Skip if already flushing
    if (queue.flushing) {
      console.log(`   ⏭️ Skipping flush - already flushing ${topicID.substring(0, 8)}`);
      return;
    }

    // Set flushing flag
    queue.flushing = true;

    // Clear timer if set
    if (queue.timer) {
      clearTimeout(queue.timer);
      queue.timer = null;
    }

    // Extract messages and resolvers
    const messages = queue.messages.slice();
    const resolvers = queue.resolvers.slice();

    // Clear queue (but keep flushing flag set)
    queue.messages = [];
    queue.resolvers = [];
    queue.firstMessageTime = null;

    console.log(`📦 Flushing batch of ${messages.length} messages to topic ${topicID.substring(0, 8)}...`);

    try {
      // Publish batch with single coordinator update
      const result = await this.publishBatchInternal(topicID, messages);

      // Resolve all promises with success
      resolvers.forEach((resolve, index) => {
        resolve({
          success: true,
          messageID: messages[index].messageID,
          version: result.version,
          attempts: result.attempts
        });
      });

      console.log(`   ✅ Batch flushed successfully (version ${result.version}, ${result.attempts} attempts)`);
    } catch (error) {
      // Resolve all promises with failure
      resolvers.forEach((resolve, index) => {
        resolve({
          success: false,
          messageID: messages[index].messageID,
          error: error.message,
          attempts: 0
        });
      });

      console.error(`   ❌ Batch flush failed: ${error.message}`);
    } finally {
      // Clear flushing flag
      queue.flushing = false;

      // If messages accumulated during flush, trigger another flush
      if (queue.messages.length >= this.batchSize) {
        setImmediate(() => this.flushBatch(topicID));
      } else if (queue.messages.length > 0 && !queue.timer) {
        queue.timer = setTimeout(() => this.flushBatch(topicID), this.batchTime);
      }
    }
  }

  /**
   * Publish batch of messages with single coordinator update (OPTIMIZED)
   * @param {string} topicID - Topic to publish to
   * @param {Array<Message>} messages - Pre-signed messages
   * @returns {Promise<{success: boolean, version: number, attempts: number}>}
   */
  async publishBatchInternal(topicID, messages) {
    // CRITICAL: Store ALL messages FIRST before coordinator update
    console.log(`   💾 Storing ${messages.length} messages in DHT...`);
    for (const message of messages) {
      await this.storage.storeMessage(message);
    }

    // Now update coordinator with ALL messages in single operation
    let attempt = 0;
    let backoffMs = PublishOperation.INITIAL_BACKOFF;

    while (true) {
      attempt++;
      console.log(`   🔄 Coordinator update attempt ${attempt} (batch of ${messages.length})...`);

      try {
        // Load current coordinator
        let coordinator = await this.storage.loadCoordinator(topicID);
        if (!coordinator) {
          coordinator = CoordinatorObject.createInitial(topicID);
        }

        const currentVersion = coordinator.version;

        // Load or create message collection
        let messageCollection;
        if (coordinator.currentMessages) {
          messageCollection = await this.storage.loadMessageCollection(coordinator.currentMessages);
          if (!messageCollection) {
            messageCollection = new MessageCollection();
          }
        } else {
          messageCollection = new MessageCollection();
        }

        // Add ALL messages to collection
        let updatedCollection = messageCollection;
        for (const message of messages) {
          message.addedInVersion = currentVersion + 1;
          updatedCollection = updatedCollection.addMessage({
            messageID: message.messageID,
            publisherID: message.publisherID,
            publisherSequence: message.publisherSequence,
            addedInVersion: message.addedInVersion,
            expiresAt: message.expiresAt
          });
        }

        console.log(`   📚 Updated collection size: ${updatedCollection.size()} messages (+${messages.length})`);

        // Store new collection
        await this.storage.storeMessageCollection(updatedCollection);

        // Check if coordinator needs pruning
        let finalCoordinator = coordinator;
        if (coordinator.needsPruning()) {
          const { coordinator: pruned, snapshot } = coordinator.prune();
          await this.storage.storeSnapshot(snapshot);
          finalCoordinator = pruned;
        }

        // Update coordinator with new message collection
        const updatedCoordinator = finalCoordinator.updateMessages(updatedCollection.collectionID);

        // Store coordinator with version check (optimistic locking)
        const storeResult = await this.storage.storeCoordinatorWithVersionCheck(
          updatedCoordinator,
          currentVersion
        );

        if (storeResult.conflict) {
          // VERSION CONFLICT - merge message collections first, then coordinators
          console.warn(`   ⚠️ Version conflict: expected ${currentVersion}, found ${storeResult.currentVersion}`);
          console.log(`   🔀 Merging message collections...`);

          // Load BOTH message collections
          const ourCollection = updatedCollection;
          const theirCollectionID = storeResult.currentCoordinator.currentMessages;
          let mergedCollection = ourCollection;

          if (theirCollectionID && theirCollectionID !== updatedCollection.collectionID) {
            const theirCollection = await this.storage.loadMessageCollection(theirCollectionID);
            if (theirCollection) {
              // Merge message collections - add all their messages to ours
              for (const theirMsg of theirCollection.messages) {
                const alreadyHave = mergedCollection.messages.find(m => m.messageID === theirMsg.messageID);
                if (!alreadyHave) {
                  mergedCollection = mergedCollection.addMessage(theirMsg);
                }
              }
              console.log(`   📚 Merged collections: ${ourCollection.size()} + ${theirCollection.size()} = ${mergedCollection.size()} messages`);

              // Store merged collection
              await this.storage.storeMessageCollection(mergedCollection);
            }
          }

          // Update our coordinator to point to merged collection
          const updatedWithMergedCollection = finalCoordinator.updateMessages(mergedCollection.collectionID);

          // Now merge coordinators
          const merged = updatedWithMergedCollection.merge(storeResult.currentCoordinator);
          console.log(`   ✅ Merged coordinator (version ${merged.version})`);

          // Try to store the merged coordinator
          const mergedStoreResult = await this.storage.storeCoordinatorWithVersionCheck(
            merged,
            storeResult.currentVersion
          );

          if (mergedStoreResult.conflict) {
            // Another conflict - check if our messages are already in coordinator
            const latestCoordinator = mergedStoreResult.currentCoordinator || await this.storage.loadCoordinator(topicID);
            if (latestCoordinator && latestCoordinator.currentMessages) {
              const latestCollection = await this.storage.loadMessageCollection(latestCoordinator.currentMessages);
              if (latestCollection) {
                // Check if ALL our messages are in the collection
                const allPresent = messages.every(msg =>
                  latestCollection.messages.find(m => m.messageID === msg.messageID)
                );
                if (allPresent) {
                  console.log(`   ✅ All ${messages.length} messages already in coordinator, batch complete`);
                  return {
                    success: true,
                    version: latestCoordinator.version,
                    attempts: attempt
                  };
                }
              }
            }

            // Messages not all present yet - retry with backoff
            await this.sleep(Math.min(backoffMs, PublishOperation.MAX_BACKOFF));
            backoffMs *= 2;
            continue;
          }

          // Merged coordinator stored successfully
          console.log(`   ✅ Published batch after merge (version ${merged.version}, ${attempt} attempts)`);
          return {
            success: true,
            version: merged.version,
            attempts: attempt
          };
        }

        // SUCCESS!
        console.log(`   ✅ Published batch successfully (version ${updatedCoordinator.version}, ${attempt} attempts)`);
        return {
          success: true,
          version: updatedCoordinator.version,
          attempts: attempt
        };

      } catch (error) {
        console.error(`   ❌ Batch publish attempt ${attempt} failed: ${error.message}`);

        if (attempt >= PublishOperation.CATASTROPHIC_THRESHOLD) {
          throw new Error(`Batch publish failed after ${attempt} attempts: ${error.message}`);
        }

        await this.sleep(Math.min(backoffMs, PublishOperation.MAX_BACKOFF));
        backoffMs *= 2;
      }
    }
  }

  /**
   * Batch publish multiple messages (optimization)
   * @param {string} topicID - Topic to publish to
   * @param {Array<any>} dataArray - Array of message data
   * @param {Object} options - Publish options
   * @returns {Promise<Array<{success: boolean, messageID: string, version: number}>>}
   */
  async batchPublish(topicID, dataArray, options = {}) {
    console.log(`📤 Batch publishing ${dataArray.length} messages to topic ${topicID.substring(0, 8)}...`);

    // If batching enabled, queue all messages and flush
    if (this.enableBatching) {
      const promises = [];
      for (const data of dataArray) {
        promises.push(this.queueMessage(topicID, data, options));
      }
      await this.flushBatch(topicID);
      return await Promise.all(promises);
    }

    // Otherwise fall back to sequential publishing
    const results = [];
    for (const data of dataArray) {
      const result = await this.publish(topicID, data, options);
      results.push(result);
    }

    const successes = results.filter(r => r.success).length;
    console.log(`   ✅ Batch publish complete: ${successes}/${dataArray.length} successful`);

    return results;
  }

  /**
   * Sleep for specified duration
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get current sequence number for topic (without incrementing)
   * @param {string} topicID - Topic ID
   * @returns {number} - Current sequence number
   */
  getCurrentSequence(topicID) {
    return this.sequences.get(topicID) || 0;
  }

  /**
   * Reset sequence for topic (useful for testing)
   * @param {string} topicID - Topic ID
   */
  resetSequence(topicID) {
    this.sequences.delete(topicID);
  }

  /**
   * Trigger push delivery to subscribers (Phase 3)
   *
   * This is fire-and-forget - we don't wait for delivery to complete.
   * Subscribers will receive push notification if online, or will get
   * the message via polling otherwise.
   *
   * @param {string} topicID - Topic ID
   * @param {Object} message - Published message
   * @param {Object} coordinator - Current coordinator after successful publish
   * @returns {Promise<void>}
   */
  async triggerPushDelivery(topicID, message, coordinator) {
    if (!this.messageDelivery) {
      // Push delivery not enabled (DHT not provided)
      return;
    }

    try {
      // Get k-closest nodes to topic for deterministic assignment
      const initiatorNodes = await this.storage.dht.findNode(topicID);
      const initiatorIDs = initiatorNodes.map(node => node.id.toString());

      if (initiatorIDs.length === 0) {
        console.warn(`   ⚠️ [Push] No initiator nodes found for topic ${topicID.substring(0, 8)}...`);
        return;
      }

      // Trigger push delivery (fire-and-forget)
      this.messageDelivery.deliverToSubscribers(topicID, message, coordinator, initiatorIDs)
        .catch(error => {
          // Log but don't fail publish
          console.warn(`   ⚠️ [Push] Delivery failed: ${error.message}`);
        });
    } catch (error) {
      // Log but don't fail publish
      console.warn(`   ⚠️ [Push] Failed to trigger push delivery: ${error.message}`);
    }
  }
}
