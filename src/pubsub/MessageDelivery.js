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
   * Threshold for when to enlist helper nodes for push delivery.
   * Below this, publisher handles all pushes directly.
   * Above this, distribute across multiple initiator nodes.
   */
  static HELPER_THRESHOLD = 10;

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
      failed: 0,
      helpersEnlisted: 0
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
   * Scaling strategy:
   * - Below HELPER_THRESHOLD subscribers: Publisher pushes to all directly
   * - Above HELPER_THRESHOLD: Enlist helper nodes to distribute the load
   * - Each helper (including publisher) pushes to their assigned subset
   * - Maximum K helpers, so minimum load per helper is subscribers/K
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

    // Filter active (non-expired) subscribers, excluding ourselves
    const now = Date.now();
    const activeSubscribers = subscriberCollection.subscribers.filter(
      sub => sub.expiresAt > now && sub.subscriberID !== this.localNodeId
    );

    if (activeSubscribers.length === 0) {
      console.log(`   ℹ️ [Push] No active subscribers for topic ${topicID.substring(0, 8)}...`);
      return { delivered: 0, failed: 0 };
    }

    const subscriberCount = activeSubscribers.length;
    console.log(`   👥 [Push] Found ${subscriberCount} active subscribers (excluding self)`);

    // Decide whether to use helpers based on subscriber count
    if (subscriberCount <= MessageDelivery.HELPER_THRESHOLD) {
      // Small channel: publisher handles all pushes directly
      console.log(`   📤 [Push] Direct delivery (${subscriberCount} <= ${MessageDelivery.HELPER_THRESHOLD} threshold)`);
      return await this.pushToAllSubscribers(activeSubscribers, topicID, message);
    }

    // Large channel: distribute across helper nodes
    // Calculate how many helpers we need (up to K)
    const numHelpers = Math.min(
      initiatorNodes.length,
      Math.ceil(subscriberCount / MessageDelivery.HELPER_THRESHOLD)
    );

    // Select the helpers (first N initiator nodes, ensuring we're included)
    const selectedHelpers = this.selectHelpers(initiatorNodes, numHelpers);

    console.log(`   🤝 [Push] Enlisting ${selectedHelpers.length} helpers for ${subscriberCount} subscribers`);

    // Send push requests to other helpers (not ourselves)
    const otherHelpers = selectedHelpers.filter(h => h !== this.localNodeId);
    if (otherHelpers.length > 0) {
      await this.sendPushRequests(otherHelpers, topicID, message, coordinator, selectedHelpers);
      this.deliveryStats.helpersEnlisted += otherHelpers.length;
    }

    // Handle our assigned subset of subscribers
    return await this.pushToAssignedSubscribers(activeSubscribers, topicID, message, selectedHelpers);
  }

  /**
   * Select helper nodes for distributed push delivery
   * Ensures the local node is included in the selection
   *
   * @param {Array<string>} initiatorNodes - k-closest node IDs
   * @param {number} numHelpers - Number of helpers needed
   * @returns {Array<string>} - Selected helper node IDs
   */
  selectHelpers(initiatorNodes, numHelpers) {
    // If we're already in the initiator list, just take first N
    const weAreInitiator = initiatorNodes.includes(this.localNodeId);

    if (weAreInitiator) {
      return initiatorNodes.slice(0, numHelpers);
    }

    // We're not in initiator list - include ourselves and take N-1 others
    const helpers = [this.localNodeId, ...initiatorNodes.slice(0, numHelpers - 1)];
    return helpers;
  }

  /**
   * Push directly to all subscribers (used for small channels)
   *
   * @param {Array<Object>} subscribers - Active subscribers
   * @param {string} topicID - Topic ID
   * @param {Object} message - Message to deliver
   * @returns {Promise<{delivered: number, failed: number}>}
   */
  async pushToAllSubscribers(subscribers, topicID, message) {
    let delivered = 0;
    let failed = 0;

    for (const subscriber of subscribers) {
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

    this.deliveryStats.attempted += subscribers.length;

    if (delivered > 0 || failed > 0) {
      console.log(`   ✅ [Push] Delivered to ${delivered}/${subscribers.length} subscribers, ${failed} failed`);
    }

    return { delivered, failed };
  }

  /**
   * Push to subscribers assigned to us via deterministic assignment
   *
   * @param {Array<Object>} subscribers - Active subscribers
   * @param {string} topicID - Topic ID
   * @param {Object} message - Message to deliver
   * @param {Array<string>} helpers - Helper nodes for assignment
   * @returns {Promise<{delivered: number, failed: number}>}
   */
  async pushToAssignedSubscribers(subscribers, topicID, message, helpers) {
    let delivered = 0;
    let failed = 0;
    let assigned = 0;

    for (const subscriber of subscribers) {
      // Determine which helper is responsible for this subscriber
      const assignedHelper = MessageDelivery.assignSubscriberToInitiator(
        subscriber.subscriberID,
        topicID,
        helpers
      );

      // Only deliver if WE are the assigned helper
      if (assignedHelper === this.localNodeId) {
        assigned++;
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

    this.deliveryStats.attempted += assigned;

    console.log(`   ✅ [Push] Our share: ${delivered}/${assigned} delivered, ${failed} failed (of ${subscribers.length} total)`);

    return { delivered, failed };
  }

  /**
   * Send push requests to helper nodes
   *
   * @param {Array<string>} helpers - Helper node IDs (excluding self)
   * @param {string} topicID - Topic ID
   * @param {Object} message - Message to deliver
   * @param {Object} coordinator - Coordinator with subscriber collection
   * @param {Array<string>} allHelpers - All helpers for assignment calculation
   */
  async sendPushRequests(helpers, topicID, message, coordinator, allHelpers) {
    const pushRequest = {
      type: 'pubsub_push_request',
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
      subscriberCollectionID: coordinator.currentSubscribers,
      helpers: allHelpers,  // So they know the full helper list for assignment
      requestedAt: Date.now()
    };

    // Send to all helpers in parallel (fire-and-forget)
    const sendPromises = helpers.map(async (helperId) => {
      try {
        await this.dht.sendMessage(helperId, pushRequest);
        console.log(`   📨 [Push] Sent push request to helper ${helperId.substring(0, 8)}...`);
      } catch (error) {
        console.warn(`   ⚠️ [Push] Failed to send push request to ${helperId.substring(0, 8)}...: ${error.message}`);
      }
    });

    await Promise.all(sendPromises);
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
   * Always fetches from network (subscriber collections are mutable)
   * @param {string} collectionID - Collection ID to load
   * @returns {Promise<Object|null>}
   */
  async loadSubscriberCollection(collectionID) {
    try {
      // ALWAYS fetch from network - subscriber collections are mutable data that MUST NOT be cached locally
      const collection = await this.dht.getFromNetwork(collectionID);
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
