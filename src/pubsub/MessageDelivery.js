/**
 * MessageDelivery - Handles push-based message delivery to subscribers
 *
 * Implements Phase 3 of the Sticky PubSub proposal:
 * - Deterministic subscriber assignment to initiator nodes
 * - Direct push delivery via DHT messaging
 * - Failure handling with retry logic
 *
 * Flow:
 * 1. After message published, load subscriber collection
 * 2. Calculate which initiator is responsible for each subscriber
 * 3. If we're the assigned initiator, push message to subscriber
 * 4. Subscribers receive instant notification (no polling delay)
 * 5. Polling remains as fallback for missed push messages
 */

import crypto from 'crypto';

export class MessageDelivery {
  /**
   * Create new MessageDelivery
   * @param {KademliaDHT} dht - DHT instance for messaging
   * @param {string} localNodeId - This node's ID
   */
  constructor(dht, localNodeId) {
    if (!dht) throw new Error('MessageDelivery requires DHT instance');
    if (!localNodeId) throw new Error('MessageDelivery requires localNodeId');

    this.dht = dht;
    this.localNodeId = localNodeId;

    // Track delivery attempts for metrics
    this.deliveryStats = {
      attempted: 0,
      succeeded: 0,
      failed: 0
    };
  }

  /**
   * Deterministic subscriber assignment algorithm
   *
   * Ensures:
   * - Same subscriber always assigned to same initiator
   * - Load balanced across all initiators
   * - No coordination needed (all nodes compute same result)
   *
   * @param {string} subscriberID - Subscriber node ID
   * @param {string} topicID - Topic ID
   * @param {Array<string>} initiatorNodes - Array of k-closest node IDs
   * @returns {string} - Assigned initiator node ID
   */
  static assignSubscriberToInitiator(subscriberID, topicID, initiatorNodes) {
    if (!initiatorNodes || initiatorNodes.length === 0) {
      throw new Error('No initiator nodes available');
    }

    // Hash combines both IDs to ensure same result for same subscriber
    const assignmentData = subscriberID + topicID;
    const assignmentHash = crypto.createHash('sha1').update(assignmentData).digest('hex');

    // Convert first 8 hex chars to integer and mod by node count
    const index = parseInt(assignmentHash.substring(0, 8), 16) % initiatorNodes.length;

    return initiatorNodes[index];
  }

  /**
   * Deliver message to subscribers via push
   *
   * @param {string} topicID - Topic ID
   * @param {Object} message - Published message
   * @param {Object} coordinator - Current coordinator object
   * @param {Array<string>} initiatorNodes - k-closest nodes to topic (from findNode)
   * @returns {Promise<{delivered: number, failed: number}>}
   */
  async deliverToSubscribers(topicID, message, coordinator, initiatorNodes) {
    console.log(`📤 [Push] Delivering message ${message.messageID.substring(0, 8)}... to subscribers`);

    // Load subscriber collection
    if (!coordinator.currentSubscribers) {
      console.log(`   ℹ️ [Push] No subscribers yet for topic ${topicID.substring(0, 8)}...`);
      return { delivered: 0, failed: 0 };
    }

    const subscriberCollection = await this.loadSubscriberCollection(coordinator.currentSubscribers);
    if (!subscriberCollection || !subscriberCollection.subscribers) {
      console.log(`   ⚠️ [Push] Failed to load subscriber collection`);
      return { delivered: 0, failed: 0 };
    }

    // Filter active (non-expired) subscribers
    const now = Date.now();
    const activeSubscribers = subscriberCollection.subscribers.filter(sub => sub.expiresAt > now);

    if (activeSubscribers.length === 0) {
      console.log(`   ℹ️ [Push] No active subscribers for topic ${topicID.substring(0, 8)}...`);
      return { delivered: 0, failed: 0 };
    }

    console.log(`   👥 [Push] Found ${activeSubscribers.length} active subscribers`);

    // Deliver messages using deterministic assignment
    let delivered = 0;
    let failed = 0;

    for (const subscriber of activeSubscribers) {
      // Determine which initiator is responsible for this subscriber
      const assignedInitiator = MessageDelivery.assignSubscriberToInitiator(
        subscriber.subscriberID,
        topicID,
        initiatorNodes
      );

      // Only deliver if WE are the assigned initiator
      if (assignedInitiator === this.localNodeId) {
        try {
          await this.pushMessageToSubscriber(subscriber.subscriberID, topicID, message);
          delivered++;
          this.deliveryStats.succeeded++;
        } catch (error) {
          console.warn(`   ⚠️ [Push] Failed to deliver to ${subscriber.subscriberID.substring(0, 8)}...: ${error.message}`);
          failed++;
          this.deliveryStats.failed++;
        }
      }
    }

    this.deliveryStats.attempted += activeSubscribers.length;

    if (delivered > 0 || failed > 0) {
      console.log(`   ✅ [Push] Delivered to ${delivered} subscribers, ${failed} failed`);
    }

    return { delivered, failed };
  }

  /**
   * Push message to a single subscriber via DHT messaging
   *
   * @param {string} subscriberID - Subscriber node ID
   * @param {string} topicID - Topic ID
   * @param {Object} message - Message to deliver
   * @returns {Promise<void>}
   */
  async pushMessageToSubscriber(subscriberID, topicID, message) {
    // Create push notification message
    const pushMessage = {
      type: 'pubsub_push',
      topicID,
      message: {
        messageID: message.messageID,
        topicID: message.topicID,
        publisherID: message.publisherID,
        publisherSequence: message.publisherSequence,
        addedInVersion: message.addedInVersion,
        data: message.data,
        publishedAt: message.publishedAt,
        expiresAt: message.expiresAt
      },
      pushedAt: Date.now()
    };

    // Send via DHT messaging (uses existing sendMessage infrastructure)
    await this.dht.sendMessage(subscriberID, pushMessage);
  }

  /**
   * Load subscriber collection from DHT
   * @param {string} collectionID - Collection ID to load
   * @returns {Promise<Object|null>}
   */
  async loadSubscriberCollection(collectionID) {
    try {
      const collection = await this.dht.get(collectionID);
      return collection;
    } catch (error) {
      console.error(`Failed to load subscriber collection ${collectionID.substring(0, 8)}...:`, error.message);
      return null;
    }
  }

  /**
   * Get delivery statistics
   * @returns {Object}
   */
  getStats() {
    return {
      ...this.deliveryStats,
      successRate: this.deliveryStats.attempted > 0
        ? (this.deliveryStats.succeeded / this.deliveryStats.attempted * 100).toFixed(1) + '%'
        : 'N/A'
    };
  }

  /**
   * Reset delivery statistics
   */
  resetStats() {
    this.deliveryStats = {
      attempted: 0,
      succeeded: 0,
      failed: 0
    };
  }
}
