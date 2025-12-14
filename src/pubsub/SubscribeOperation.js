/**
 * SubscribeOperation - Handles topic subscriptions with delta delivery
 *
 * Manages subscriptions with:
 * - Deterministic coordinator assignment (hash-based)
 * - Signature-based subscription authentication
 * - Delta delivery (only messages since lastSeenVersion)
 * - Version gap detection and recovery
 * - Subscription renewal
 *
 * Flow:
 * 1. Calculate coordinator assignment
 * 2. Sign subscription request
 * 3. Add to subscriber collection
 * 4. Load all historical non-expired messages
 * 5. Track version and detect gaps
 * 6. Request delta updates when version jumps
 *
 * Integration:
 * - Uses PubSubStorage for DHT operations
 * - Uses SubscriberCollection for immutable subscriber tracking
 * - Uses InvitationToken for signature generation
 */

import { SubscriberCollection } from './SubscriberCollection.js';
import { CoordinatorObject } from './CoordinatorObject.js';
import { InvitationToken } from '../core/InvitationToken.js';

export class SubscribeOperation {
  /**
   * Default subscription TTL (1 hour)
   */
  static DEFAULT_SUBSCRIPTION_TTL = 3600000;

  /**
   * Create new SubscribeOperation
   * @param {PubSubStorage} storage - Storage instance
   * @param {string} subscriberID - Subscriber node ID
   * @param {Object} keyInfo - Subscriber's key info for signing
   */
  constructor(storage, subscriberID, keyInfo) {
    if (!storage) throw new Error('SubscribeOperation requires storage');
    if (!subscriberID) throw new Error('SubscribeOperation requires subscriberID');
    if (!keyInfo) throw new Error('SubscribeOperation requires keyInfo');

    this.storage = storage;
    this.subscriberID = subscriberID;
    this.keyInfo = keyInfo;

    // Active subscriptions
    this.subscriptions = new Map(); // topicID -> {lastSeenVersion, coordinatorNode, messageHandler}
  }

  /**
   * Subscribe to topic
   * @param {string} topicID - Topic to subscribe to
   * @param {Function} messageHandler - Callback for received messages: (message) => void
   * @param {Object} options - Subscribe options
   * @param {number} [options.ttl] - Subscription TTL in milliseconds
   * @param {number} [options.k] - Number of coordinator nodes (default: 20)
   * @returns {Promise<{success: boolean, coordinatorNode: number, historicalMessages: number}>}
   */
  async subscribe(topicID, messageHandler, options = {}) {
    const ttl = options.ttl || SubscribeOperation.DEFAULT_SUBSCRIPTION_TTL;
    const k = options.k || 20;
    const subscribedAt = Date.now();
    const expiresAt = subscribedAt + ttl;

    console.log(`📥 Subscribing to topic ${topicID.substring(0, 8)}...`);

    // Calculate deterministic coordinator assignment
    const coordinatorNode = SubscriberCollection.calculateCoordinatorNode(
      topicID,
      this.subscriberID,
      k
    );
    console.log(`   🎯 Assigned to coordinator node ${coordinatorNode}`);

    // Create subscription metadata with signature
    const subscriptionData = {
      subscriberID: this.subscriberID,
      coordinatorNode,
      subscribedAt,
      expiresAt
    };

    const signableData = JSON.stringify(subscriptionData);
    const signature = await InvitationToken.signData(signableData, this.keyInfo);

    const subscriberMetadata = {
      ...subscriptionData,
      signature
    };

    // Load or create coordinator (use resilient loading for better reliability)
    let coordinator = await this.storage.loadCoordinatorResilient(topicID);
    if (!coordinator) {
      console.log(`   📝 Creating initial coordinator for topic ${topicID.substring(0, 8)}...`);
      coordinator = CoordinatorObject.createInitial(topicID);
    }

    const currentVersion = coordinator.version;
    console.log(`   📊 Current coordinator version: ${currentVersion}`);

    // Load or create subscriber collection
    let subscriberCollection;
    if (coordinator.currentSubscribers) {
      subscriberCollection = await this.storage.loadSubscriberCollection(coordinator.currentSubscribers);
      if (!subscriberCollection) {
        console.warn(`   ⚠️ Subscriber collection not found, creating new`);
        subscriberCollection = new SubscriberCollection();
      }
    } else {
      subscriberCollection = new SubscriberCollection();
    }

    // Check if already subscribed
    if (subscriberCollection.hasSubscriber(this.subscriberID)) {
      console.log(`   ℹ️ Already subscribed, updating subscription`);
    }

    // Add subscriber (creates NEW collection - immutable)
    const updatedCollection = subscriberCollection.addSubscriber(subscriberMetadata);
    console.log(`   👥 Updated subscriber collection size: ${updatedCollection.size()}`);

    // Store new subscriber collection
    const collectionStored = await this.storage.storeSubscriberCollection(updatedCollection);
    if (!collectionStored) {
      throw new Error('Failed to store subscriber collection');
    }

    // Update coordinator with new subscriber collection
    const updatedCoordinator = coordinator.updateSubscribers(updatedCollection.collectionID);

    // Store coordinator with version check
    const storeResult = await this.storage.storeCoordinatorWithVersionCheck(
      updatedCoordinator,
      currentVersion
    );

    let finalVersion = updatedCoordinator.version;

    if (storeResult.conflict) {
      console.warn(`   ⚠️ Version conflict during subscribe, retrying...`);
      // For subscribe, we can just retry once since conflicts are less critical
      const merged = updatedCoordinator.merge(storeResult.currentCoordinator);
      await this.storage.storeCoordinator(merged);
      finalVersion = merged.version;
      console.log(`   ✅ Merged and stored coordinator (version ${merged.version})`);
    }

    // Load historical messages (all non-expired messages)
    const historicalMessages = await this.loadHistoricalMessages(topicID, coordinator);
    console.log(`   📚 Loaded ${historicalMessages.length} historical messages`);

    // Deliver historical messages to handler
    for (const message of historicalMessages) {
      try {
        await messageHandler(message);
      } catch (error) {
        console.error(`   ❌ Error in message handler: ${error.message}`);
      }
    }

    // Track subscription - use FINAL version after our update
    this.subscriptions.set(topicID, {
      lastSeenVersion: finalVersion,
      coordinatorNode,
      messageHandler,
      subscribedAt,
      expiresAt
    });

    console.log(`   ✅ Subscribed successfully (${historicalMessages.length} historical messages)`);

    return {
      success: true,
      coordinatorNode,
      historicalMessages: historicalMessages.length
    };
  }

  /**
   * Load all historical non-expired messages for topic
   * @param {string} topicID - Topic ID
   * @param {CoordinatorObject} coordinator - Current coordinator
   * @returns {Promise<Array<Message>>} - Array of historical messages
   */
  async loadHistoricalMessages(topicID, coordinator) {
    if (!coordinator.currentMessages) {
      console.log(`   ℹ️ No messages yet for topic ${topicID.substring(0, 8)}...`);
      return [];
    }

    // Load message collection
    const messageCollection = await this.storage.loadMessageCollection(coordinator.currentMessages);
    if (!messageCollection) {
      console.warn(`   ⚠️ Message collection not found: ${coordinator.currentMessages.substring(0, 8)}...`);
      return [];
    }

    // Filter to non-expired messages only
    const now = Date.now();
    const activeMetadata = messageCollection.messages.filter(m => m.expiresAt > now);
    console.log(`   📊 Found ${activeMetadata.length} non-expired messages (${messageCollection.size()} total)`);

    // Load actual messages (parallel)
    const messageIDs = activeMetadata.map(m => m.messageID);
    const messages = await this.storage.loadMessages(messageIDs);

    // Sort by timestamp for chronological display (oldest to newest)
    messages.sort((a, b) => {
      return a.publishedAt - b.publishedAt;
    });

    return messages;
  }

  /**
   * Poll for updates (check for new messages since last seen version)
   * @param {string} topicID - Topic ID
   * @returns {Promise<{newMessages: Array<Message>, currentVersion: number}>}
   */
  async pollUpdates(topicID) {
    const subscription = this.subscriptions.get(topicID);
    if (!subscription) {
      throw new Error(`Not subscribed to topic ${topicID}`);
    }

    // Load current coordinator
    const coordinator = await this.storage.loadCoordinator(topicID);
    if (!coordinator) {
      console.log(`   ℹ️ Coordinator not found for ${topicID.substring(0, 8)}...`);
      return { newMessages: [], currentVersion: 0 };
    }

    const currentVersion = coordinator.version;
    const lastSeenVersion = subscription.lastSeenVersion;

    // Check for version gap
    if (currentVersion > lastSeenVersion + 1) {
      console.warn(`   ⚠️ Version gap detected: last=${lastSeenVersion}, current=${currentVersion}`);
      await this.requestFullUpdate(topicID, lastSeenVersion);
      return { newMessages: [], currentVersion }; // Full update handled separately
    }

    // No updates
    if (currentVersion === lastSeenVersion) {
      return { newMessages: [], currentVersion };
    }

    // Get delta messages (messages added since lastSeenVersion)
    const deltaMessages = await this.getDeltaMessages(topicID, coordinator, lastSeenVersion);
    console.log(`   📨 Found ${deltaMessages.length} new messages (version ${lastSeenVersion} → ${currentVersion})`);

    // Deliver to handler
    for (const message of deltaMessages) {
      try {
        await subscription.messageHandler(message);
      } catch (error) {
        console.error(`   ❌ Error in message handler: ${error.message}`);
      }
    }

    // Update last seen version
    subscription.lastSeenVersion = currentVersion;

    return {
      newMessages: deltaMessages,
      currentVersion
    };
  }

  /**
   * Get messages added after a specific version (delta delivery)
   * @param {string} topicID - Topic ID
   * @param {CoordinatorObject} coordinator - Current coordinator
   * @param {number} sinceVersion - Version to get updates since
   * @returns {Promise<Array<Message>>} - Delta messages
   */
  async getDeltaMessages(topicID, coordinator, sinceVersion) {
    if (!coordinator.currentMessages) {
      return [];
    }

    // Load message collection
    const messageCollection = await this.storage.loadMessageCollection(coordinator.currentMessages);
    if (!messageCollection) {
      return [];
    }

    // Filter to messages added after sinceVersion
    const deltaMetadata = messageCollection.getMessagesSince(sinceVersion);
    console.log(`   📊 Found ${deltaMetadata.length} messages added after version ${sinceVersion}`);

    // Load actual messages
    const messageIDs = deltaMetadata.map(m => m.messageID);
    const messages = await this.storage.loadMessages(messageIDs);

    // Filter expired messages
    const now = Date.now();
    const activeMessages = messages.filter(m => m.expiresAt > now);

    // Sort by timestamp for chronological display (oldest to newest)
    activeMessages.sort((a, b) => {
      return a.publishedAt - b.publishedAt;
    });

    return activeMessages;
  }

  /**
   * Request full update when version gap detected
   * @param {string} topicID - Topic ID
   * @param {number} fromVersion - Version to update from
   * @returns {Promise<void>}
   */
  async requestFullUpdate(topicID, fromVersion) {
    console.log(`   🔄 Requesting full update from version ${fromVersion}...`);

    const subscription = this.subscriptions.get(topicID);
    if (!subscription) {
      throw new Error(`Not subscribed to topic ${topicID}`);
    }

    // Load current coordinator
    const coordinator = await this.storage.loadCoordinator(topicID);
    if (!coordinator) {
      console.warn(`   ⚠️ Coordinator not found during full update`);
      return;
    }

    // Load all messages added after fromVersion
    const messages = await this.getDeltaMessages(topicID, coordinator, fromVersion);
    console.log(`   📦 Full update: ${messages.length} messages since version ${fromVersion}`);

    // Deliver to handler (client-side deduplication handles duplicates)
    for (const message of messages) {
      try {
        await subscription.messageHandler(message);
      } catch (error) {
        console.error(`   ❌ Error in message handler: ${error.message}`);
      }
    }

    // Update last seen version
    subscription.lastSeenVersion = coordinator.version;
  }

  /**
   * Renew subscription (extend TTL)
   * @param {string} topicID - Topic ID
   * @param {number} additionalTTL - Additional TTL in milliseconds
   * @returns {Promise<{success: boolean, newExpiresAt: number}>}
   */
  async renew(topicID, additionalTTL) {
    const subscription = this.subscriptions.get(topicID);
    if (!subscription) {
      throw new Error(`Not subscribed to topic ${topicID}`);
    }

    console.log(`🔄 Renewing subscription to ${topicID.substring(0, 8)}...`);

    const newExpiresAt = Date.now() + additionalTTL;

    // Create new subscription signature
    const subscriptionData = {
      subscriberID: this.subscriberID,
      coordinatorNode: subscription.coordinatorNode,
      subscribedAt: subscription.subscribedAt,
      expiresAt: newExpiresAt
    };

    const signableData = JSON.stringify(subscriptionData);
    const newSignature = await InvitationToken.signData(signableData, this.keyInfo);

    // Load coordinator and subscriber collection
    const coordinator = await this.storage.loadCoordinator(topicID);
    if (!coordinator || !coordinator.currentSubscribers) {
      throw new Error('Coordinator or subscriber collection not found');
    }

    const subscriberCollection = await this.storage.loadSubscriberCollection(coordinator.currentSubscribers);
    if (!subscriberCollection) {
      throw new Error('Subscriber collection not found');
    }

    // Renew subscription (creates NEW collection)
    const renewed = subscriberCollection.renewSubscription(
      this.subscriberID,
      newExpiresAt,
      newSignature
    );

    // Store new collection
    await this.storage.storeSubscriberCollection(renewed);

    // Update coordinator
    const updatedCoordinator = coordinator.updateSubscribers(renewed.collectionID);
    await this.storage.storeCoordinator(updatedCoordinator);

    // Update local tracking
    subscription.expiresAt = newExpiresAt;

    console.log(`   ✅ Subscription renewed until ${new Date(newExpiresAt).toISOString()}`);

    return {
      success: true,
      newExpiresAt
    };
  }

  /**
   * Unsubscribe from topic
   * @param {string} topicID - Topic ID
   * @returns {Promise<{success: boolean}>}
   */
  async unsubscribe(topicID) {
    const subscription = this.subscriptions.get(topicID);
    if (!subscription) {
      console.log(`   ℹ️ Not subscribed to ${topicID.substring(0, 8)}...`);
      return { success: true };
    }

    console.log(`📤 Unsubscribing from topic ${topicID.substring(0, 8)}...`);

    // Load coordinator and subscriber collection
    const coordinator = await this.storage.loadCoordinator(topicID);
    if (coordinator && coordinator.currentSubscribers) {
      const subscriberCollection = await this.storage.loadSubscriberCollection(coordinator.currentSubscribers);
      if (subscriberCollection) {
        // Remove subscriber (creates NEW collection)
        const updated = subscriberCollection.removeSubscriber(this.subscriberID);

        // Store new collection
        await this.storage.storeSubscriberCollection(updated);

        // Update coordinator
        const updatedCoordinator = coordinator.updateSubscribers(updated.collectionID);
        await this.storage.storeCoordinator(updatedCoordinator);
      }
    }

    // Remove local tracking
    this.subscriptions.delete(topicID);

    console.log(`   ✅ Unsubscribed successfully`);

    return { success: true };
  }

  /**
   * Get active subscriptions
   * @returns {Array<{topicID: string, coordinatorNode: number, lastSeenVersion: number}>}
   */
  getSubscriptions() {
    return Array.from(this.subscriptions.entries()).map(([topicID, sub]) => ({
      topicID,
      coordinatorNode: sub.coordinatorNode,
      lastSeenVersion: sub.lastSeenVersion,
      expiresAt: sub.expiresAt
    }));
  }

  /**
   * Check if subscribed to topic
   * @param {string} topicID - Topic ID
   * @returns {boolean}
   */
  isSubscribed(topicID) {
    return this.subscriptions.has(topicID);
  }
}
