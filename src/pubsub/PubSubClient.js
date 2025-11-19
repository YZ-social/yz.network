/**
 * PubSubClient - High-level pub/sub API for DHT clients
 *
 * Provides a simple interface for publishing and subscribing to topics
 * with automatic integration into existing DHT infrastructure.
 *
 * Features:
 * - Uses existing DHT node identity (no separate key generation)
 * - Automatic storage integration
 * - Event-based message delivery
 * - Subscription management
 * - Topic statistics
 *
 * Integration:
 * - Wraps PublishOperation and SubscribeOperation
 * - Uses DHT's existing PubSubStorage
 * - Integrates with node identity (keyInfo from DHT)
 *
 * Usage:
 * ```javascript
 * import { PubSubClient } from './pubsub/PubSubClient.js';
 *
 * // Create client
 * const pubsub = new PubSubClient(dht, nodeID, keyInfo);
 *
 * // Publish
 * await pubsub.publish('my-topic', { text: 'Hello World' });
 *
 * // Subscribe
 * pubsub.on('my-topic', (message) => {
 *   console.log('Received:', message.data);
 * });
 * await pubsub.subscribe('my-topic');
 *
 * // Start polling
 * pubsub.startPolling(5000); // Poll every 5 seconds
 * ```
 */

import { EventEmitter } from 'events';
import { PublishOperation } from './PublishOperation.js';
import { SubscribeOperation } from './SubscribeOperation.js';
import { PubSubStorage } from './PubSubStorage.js';

export class PubSubClient extends EventEmitter {
  /**
   * Default message TTL (1 hour)
   */
  static DEFAULT_MESSAGE_TTL = 3600000;

  /**
   * Default subscription TTL (1 hour)
   */
  static DEFAULT_SUBSCRIPTION_TTL = 3600000;

  /**
   * Default polling interval (5 seconds)
   */
  static DEFAULT_POLL_INTERVAL = 5000;

  /**
   * Create new PubSubClient
   * @param {KademliaDHT} dht - DHT instance
   * @param {string} nodeID - Node ID (from DHT)
   * @param {Object} keyInfo - Key info for signing (from DHT)
   * @param {Object} options - Client options
   * @param {boolean} [options.enableBatching=false] - Enable batch coordinator updates
   * @param {number} [options.batchSize=10] - Batch size threshold
   * @param {number} [options.batchTime=100] - Batch time threshold (ms)
   */
  constructor(dht, nodeID, keyInfo, options = {}) {
    super();

    if (!dht) throw new Error('PubSubClient requires DHT instance');
    if (!nodeID) throw new Error('PubSubClient requires nodeID');
    if (!keyInfo) throw new Error('PubSubClient requires keyInfo');

    this.dht = dht;
    this.nodeID = nodeID;
    this.keyInfo = keyInfo;

    // Create storage integration
    this.storage = new PubSubStorage(dht);

    // Create operation handlers with batching support and push delivery
    this.publishOp = new PublishOperation(this.storage, nodeID, keyInfo, {
      enableBatching: options.enableBatching || false,
      batchSize: options.batchSize,
      batchTime: options.batchTime,
      dht: dht  // Enable push delivery
    });
    this.subscribeOp = new SubscribeOperation(this.storage, nodeID, keyInfo);

    // Set up push message handler
    this.setupPushHandler();

    // Polling state
    this.pollingInterval = null;
    this.isPolling = false;

    // Statistics
    this.stats = {
      messagesPublished: 0,
      messagesReceived: 0,
      publishFailures: 0,
      subscriptions: 0
    };
  }

  /**
   * Publish message to topic
   * @param {string} topic - Topic name
   * @param {any} data - Message data
   * @param {Object} options - Publish options
   * @param {number} [options.ttl] - Message TTL in milliseconds
   * @returns {Promise<{messageID: string, version: number, attempts: number}>}
   */
  async publish(topic, data, options = {}) {
    const ttl = options.ttl || PubSubClient.DEFAULT_MESSAGE_TTL;

    try {
      const result = await this.publishOp.publish(topic, data, { ttl });

      this.stats.messagesPublished++;

      // Emit published event
      this.emit('published', {
        topic,
        messageID: result.messageID,
        version: result.version,
        attempts: result.attempts,
        data
      });

      return result;
    } catch (error) {
      this.stats.publishFailures++;

      // Emit error event
      this.emit('publishError', {
        topic,
        data,
        error: error.message
      });

      throw error;
    }
  }

  /**
   * Subscribe to topic
   * @param {string} topic - Topic name
   * @param {Object} options - Subscribe options
   * @param {number} [options.ttl] - Subscription TTL in milliseconds
   * @param {number} [options.k] - Number of coordinator nodes
   * @returns {Promise<{coordinatorNode: number, historicalMessages: number}>}
   */
  async subscribe(topic, options = {}) {
    const ttl = options.ttl || PubSubClient.DEFAULT_SUBSCRIPTION_TTL;
    const k = options.k || 20;

    // Create message handler that emits events
    const messageHandler = async (message) => {
      this.stats.messagesReceived++;

      // Emit topic-specific event
      this.emit(topic, message);

      // Emit generic message event
      this.emit('message', {
        topic,
        message
      });
    };

    try {
      const result = await this.subscribeOp.subscribe(topic, messageHandler, { ttl, k });

      this.stats.subscriptions++;

      // Emit subscribed event
      this.emit('subscribed', {
        topic,
        coordinatorNode: result.coordinatorNode,
        historicalMessages: result.historicalMessages
      });

      return result;
    } catch (error) {
      // Emit error event
      this.emit('subscribeError', {
        topic,
        error: error.message
      });

      throw error;
    }
  }

  /**
   * Unsubscribe from topic
   * @param {string} topic - Topic name
   * @returns {Promise<void>}
   */
  async unsubscribe(topic) {
    await this.subscribeOp.unsubscribe(topic);

    // Remove all listeners for this topic
    this.removeAllListeners(topic);

    // Emit unsubscribed event
    this.emit('unsubscribed', { topic });
  }

  /**
   * Renew subscription to topic
   * @param {string} topic - Topic name
   * @param {number} additionalTTL - Additional TTL in milliseconds
   * @returns {Promise<{newExpiresAt: number}>}
   */
  async renew(topic, additionalTTL) {
    const result = await this.subscribeOp.renew(topic, additionalTTL);

    // Emit renewed event
    this.emit('renewed', {
      topic,
      newExpiresAt: result.newExpiresAt
    });

    return result;
  }

  /**
   * Start automatic polling for updates
   * @param {number} interval - Polling interval in milliseconds
   */
  startPolling(interval = PubSubClient.DEFAULT_POLL_INTERVAL) {
    if (this.isPolling) {
      console.warn('⚠️ Polling already started');
      return;
    }

    this.isPolling = true;

    this.pollingInterval = setInterval(async () => {
      await this.pollAll();
    }, interval);

    console.log(`🔄 Started polling for updates (interval: ${interval}ms)`);

    // Emit polling started event
    this.emit('pollingStarted', { interval });
  }

  /**
   * Stop automatic polling
   */
  stopPolling() {
    if (!this.isPolling) {
      return;
    }

    clearInterval(this.pollingInterval);
    this.pollingInterval = null;
    this.isPolling = false;

    console.log('⏸️ Stopped polling for updates');

    // Emit polling stopped event
    this.emit('pollingStopped');
  }

  /**
   * Poll all active subscriptions for updates
   * @returns {Promise<void>}
   */
  async pollAll() {
    const subscriptions = this.subscribeOp.getSubscriptions();

    for (const sub of subscriptions) {
      try {
        const updates = await this.subscribeOp.pollUpdates(sub.topicID);

        if (updates.newMessages.length > 0) {
          // Emit poll update event
          this.emit('pollUpdate', {
            topic: sub.topicID,
            newMessages: updates.newMessages.length,
            currentVersion: updates.currentVersion
          });
        }
      } catch (error) {
        // Emit poll error event
        this.emit('pollError', {
          topic: sub.topicID,
          error: error.message
        });
      }
    }
  }

  /**
   * Poll specific topic for updates
   * @param {string} topic - Topic name
   * @returns {Promise<{newMessages: number, currentVersion: number}>}
   */
  async poll(topic) {
    const updates = await this.subscribeOp.pollUpdates(topic);

    if (updates.newMessages.length > 0) {
      // Emit poll update event
      this.emit('pollUpdate', {
        topic,
        newMessages: updates.newMessages.length,
        currentVersion: updates.currentVersion
      });
    }

    return {
      newMessages: updates.newMessages.length,
      currentVersion: updates.currentVersion
    };
  }

  /**
   * Get active subscriptions
   * @returns {Array<{topicID: string, coordinatorNode: number, lastSeenVersion: number}>}
   */
  getSubscriptions() {
    return this.subscribeOp.getSubscriptions();
  }

  /**
   * Check if subscribed to topic
   * @param {string} topic - Topic name
   * @returns {boolean}
   */
  isSubscribed(topic) {
    return this.subscribeOp.isSubscribed(topic);
  }

  /**
   * Get statistics
   * @returns {Object} - Client statistics
   */
  getStats() {
    const subscriptions = this.subscribeOp.getSubscriptions();

    return {
      nodeID: this.nodeID,
      messagesPublished: this.stats.messagesPublished,
      messagesReceived: this.stats.messagesReceived,
      publishFailures: this.stats.publishFailures,
      activeSubscriptions: subscriptions.length,
      isPolling: this.isPolling,
      subscriptions: subscriptions.map(sub => ({
        topic: sub.topicID,
        coordinatorNode: sub.coordinatorNode,
        lastSeenVersion: sub.lastSeenVersion,
        expiresAt: new Date(sub.expiresAt).toISOString()
      }))
    };
  }

  /**
   * Get topic information
   * @param {string} topic - Topic name
   * @returns {Promise<{version: number, subscribers: number, messages: number, state: string}>}
   */
  async getTopicInfo(topic) {
    const coordinator = await this.storage.loadCoordinator(topic);

    if (!coordinator) {
      return null;
    }

    let subscriberCount = 0;
    let messageCount = 0;

    if (coordinator.currentSubscribers) {
      const subCollection = await this.storage.loadSubscriberCollection(coordinator.currentSubscribers);
      if (subCollection) {
        subscriberCount = subCollection.size();
      }
    }

    if (coordinator.currentMessages) {
      const msgCollection = await this.storage.loadMessageCollection(coordinator.currentMessages);
      if (msgCollection) {
        messageCount = msgCollection.size();
      }
    }

    return {
      topic,
      version: coordinator.version,
      subscribers: subscriberCount,
      messages: messageCount,
      state: coordinator.state,
      createdAt: new Date(coordinator.createdAt).toISOString(),
      lastModified: new Date(coordinator.lastModified).toISOString()
    };
  }

  /**
   * List all known topics (that have coordinators in DHT)
   * Note: This requires scanning the DHT, which may not be efficient
   * In practice, clients would track their own topics
   * @returns {Array<string>} - Array of topic IDs this client knows about
   */
  getKnownTopics() {
    const subscriptions = this.subscribeOp.getSubscriptions();
    const topics = new Set();

    // Add subscribed topics
    for (const sub of subscriptions) {
      topics.add(sub.topicID);
    }

    // Add published topics (from publish operation sequence tracking)
    for (const [topicID] of this.publishOp.sequences.entries()) {
      topics.add(topicID);
    }

    return Array.from(topics);
  }

  /**
   * Batch publish multiple messages to a topic
   * @param {string} topic - Topic name
   * @param {Array<any>} dataArray - Array of message data
   * @param {Object} options - Publish options
   * @returns {Promise<Array<{messageID: string, version: number}>>}
   */
  async batchPublish(topic, dataArray, options = {}) {
    const results = await this.publishOp.batchPublish(topic, dataArray, options);

    this.stats.messagesPublished += results.filter(r => r.success).length;
    this.stats.publishFailures += results.filter(r => !r.success).length;

    // Emit batch published event
    this.emit('batchPublished', {
      topic,
      count: dataArray.length,
      successes: results.filter(r => r.success).length,
      failures: results.filter(r => !r.success).length
    });

    return results;
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      messagesPublished: 0,
      messagesReceived: 0,
      publishFailures: 0,
      subscriptions: 0
    };
  }

  /**
   * Setup push message handler (Phase 3)
   *
   * Listens for pubsub_push messages from DHT and delivers them
   * to the appropriate topic listeners immediately.
   */
  setupPushHandler() {
    // Register handler for push messages from DHT
    this.dht.on('message', (msg) => {
      // Only handle pubsub_push messages
      if (msg.type !== 'pubsub_push') {
        return;
      }

      try {
        const { topicID, message, pushedAt } = msg;

        console.log(`📥 [Push] Received message for topic ${topicID.substring(0, 8)}... (pushed ${Date.now() - pushedAt}ms ago)`);

        // Check if we're subscribed to this topic
        if (!this.subscribeOp.isSubscribed(topicID)) {
          console.warn(`   ⚠️ [Push] Received message for unsubscribed topic ${topicID.substring(0, 8)}...`);
          return;
        }

        // Update statistics
        this.stats.messagesReceived++;
        this.stats.pushNotifications = (this.stats.pushNotifications || 0) + 1;

        // Emit message to topic listeners (same as polling delivery)
        this.emit(topicID, message);

        console.log(`   ✅ [Push] Delivered message ${message.messageID.substring(0, 8)}... to topic listeners`);

      } catch (error) {
        console.error(`   ❌ [Push] Error handling push message:`, error);
      }
    });

    console.log('📤 [Push] Push notification handler registered');
  }

  /**
   * Cleanup and shutdown
   */
  async shutdown() {
    console.log('🛑 Shutting down PubSubClient...');

    // Stop polling
    this.stopPolling();

    // Unsubscribe from all topics
    const subscriptions = this.subscribeOp.getSubscriptions();
    for (const sub of subscriptions) {
      try {
        await this.unsubscribe(sub.topicID);
      } catch (error) {
        console.error(`Failed to unsubscribe from ${sub.topicID}:`, error.message);
      }
    }

    // Remove all listeners
    this.removeAllListeners();

    console.log('✅ PubSubClient shutdown complete');
  }
}
