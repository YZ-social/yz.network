/**
 * Integration Tests for Sticky Pub/Sub Protocol Operations
 *
 * Tests publish and subscribe operations with a mock DHT storage.
 * Validates:
 * - Message publishing with version conflicts
 * - Historical message delivery on subscribe
 * - Delta delivery for updates
 * - Sequence number tracking
 * - Subscription renewal
 *
 * Run with: node src/pubsub/test-operations.js
 */

import { PublishOperation } from './PublishOperation.js';
import { SubscribeOperation } from './SubscribeOperation.js';
import { PubSubStorage } from './PubSubStorage.js';
import { InvitationToken } from '../core/InvitationToken.js';

// Mock DHT with in-memory storage
class MockDHT {
  constructor() {
    this.storage = new Map();
  }

  async store(key, value) {
    console.log(`   [MockDHT] Storing key: ${key.substring(0, 30)}...`);
    this.storage.set(key, JSON.parse(JSON.stringify(value))); // Deep clone
    return true;
  }

  async get(key) {
    const value = this.storage.get(key);
    if (value) {
      console.log(`   [MockDHT] Retrieved key: ${key.substring(0, 30)}...`);
      return JSON.parse(JSON.stringify(value)); // Deep clone
    }
    console.log(`   [MockDHT] Key not found: ${key.substring(0, 30)}...`);
    return null;
  }

  getStats() {
    return {
      localStorageSize: this.storage.size,
      dhtNodes: 0,
      connectedPeers: 0
    };
  }
}

// Test utilities
let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    testsFailed++;
    throw new Error(message);
  }
  testsPassed++;
}

async function runTests() {
  console.log('🧪 Starting Sticky Pub/Sub Protocol Operation Tests\n');

  try {
    // ==========================================
    // SETUP: Create mock DHT and generate keys
    // ==========================================
    console.log('🔧 Setting up test environment...');

    const mockDHT = new MockDHT();
    const storage = new PubSubStorage(mockDHT);

    // Generate keys for publisher and subscriber
    console.log('🔐 Generating cryptographic keys...');
    const publisherKeys = await InvitationToken.generateKeyPair();
    const subscriberKeys = await InvitationToken.generateKeyPair();

    const publisherID = 'publisher-node-001';
    const subscriberID = 'subscriber-node-001';

    console.log(`   Publisher ID: ${publisherID}`);
    console.log(`   Subscriber ID: ${subscriberID}`);
    console.log('✅ Setup complete\n');

    // ==========================================
    // TEST 1: Publish single message
    // ==========================================
    console.log('📨 Test 1: Publishing single message...');

    const publisher = new PublishOperation(storage, publisherID, publisherKeys);
    const topicID = 'test-topic-1';

    const result1 = await publisher.publish(topicID, { text: 'Hello World', index: 1 });

    assert(result1.success, 'Publish succeeded');
    assert(result1.version === 1, 'Coordinator version is 1');
    assert(result1.attempts === 1, 'Publish completed in 1 attempt');
    assert(result1.messageID.length === 40, 'Message ID is 40-char hex string');

    // Verify message was stored
    const storedMessage1 = await storage.loadMessage(result1.messageID);
    assert(storedMessage1 !== null, 'Message stored in DHT');
    assert(storedMessage1.data.text === 'Hello World', 'Message data matches');
    assert(storedMessage1.publisherSequence === 1, 'Sequence number is 1');

    console.log('✅ Test 1 passed\n');

    // ==========================================
    // TEST 2: Publish multiple messages (sequence tracking)
    // ==========================================
    console.log('📨 Test 2: Publishing multiple messages...');

    const result2 = await publisher.publish(topicID, { text: 'Message 2', index: 2 });
    const result3 = await publisher.publish(topicID, { text: 'Message 3', index: 3 });

    assert(result2.version === 2, 'Second message version is 2');
    assert(result3.version === 3, 'Third message version is 3');

    // Verify sequences
    const storedMessage2 = await storage.loadMessage(result2.messageID);
    const storedMessage3 = await storage.loadMessage(result3.messageID);

    assert(storedMessage2.publisherSequence === 2, 'Second message sequence is 2');
    assert(storedMessage3.publisherSequence === 3, 'Third message sequence is 3');

    console.log('✅ Test 2 passed\n');

    // ==========================================
    // TEST 3: Subscribe and receive historical messages
    // ==========================================
    console.log('📥 Test 3: Subscribe to topic with history...');

    const subscriber = new SubscribeOperation(storage, subscriberID, subscriberKeys);
    const receivedMessages = [];

    const messageHandler = async (message) => {
      console.log(`   📬 Received: ${message.data.text} (seq ${message.publisherSequence})`);
      receivedMessages.push(message);
    };

    const subResult = await subscriber.subscribe(topicID, messageHandler);

    assert(subResult.success, 'Subscribe succeeded');
    assert(subResult.historicalMessages === 3, 'Received 3 historical messages');
    assert(receivedMessages.length === 3, 'Message handler called 3 times');

    // Verify message order
    assert(receivedMessages[0].publisherSequence === 1, 'First message sequence is 1');
    assert(receivedMessages[1].publisherSequence === 2, 'Second message sequence is 2');
    assert(receivedMessages[2].publisherSequence === 3, 'Third message sequence is 3');

    console.log('✅ Test 3 passed\n');

    // ==========================================
    // TEST 4: Delta delivery (publish after subscribe)
    // ==========================================
    console.log('📨 Test 4: Publish new message after subscribe...');

    receivedMessages.length = 0; // Clear received messages

    const result4 = await publisher.publish(topicID, { text: 'Message 4', index: 4 });
    assert(result4.success, 'Fourth message published');

    // Poll for updates
    const pollResult = await subscriber.pollUpdates(topicID);

    assert(pollResult.newMessages.length === 1, 'Delta delivery returned 1 new message');
    assert(pollResult.newMessages[0].data.text === 'Message 4', 'Delta message content matches');
    assert(receivedMessages.length === 1, 'Message handler called once for delta');

    console.log('✅ Test 4 passed\n');

    // ==========================================
    // TEST 5: Sequence gap detection
    // ==========================================
    console.log('📊 Test 5: Sequence gap detection...');

    // Load message collection and check for gaps
    const coordinator = await storage.loadCoordinator(topicID);
    const messageCollection = await storage.loadMessageCollection(coordinator.currentMessages);

    const gaps = messageCollection.detectSequenceGaps();
    assert(gaps.size === 0, 'No sequence gaps detected (all messages sequential)');

    console.log('✅ Test 5 passed\n');

    // ==========================================
    // TEST 6: Multiple publishers (different sequences)
    // ==========================================
    console.log('📨 Test 6: Multiple publishers...');

    const publisher2Keys = await InvitationToken.generateKeyPair();
    const publisher2ID = 'publisher-node-002';
    const publisher2 = new PublishOperation(storage, publisher2ID, publisher2Keys);

    const result5 = await publisher2.publish(topicID, { text: 'Publisher 2 - Message 1', index: 5 });
    assert(result5.success, 'Publisher 2 message sent');

    const storedMessage5 = await storage.loadMessage(result5.messageID);
    assert(storedMessage5.publisherID === publisher2ID, 'Message from Publisher 2');
    assert(storedMessage5.publisherSequence === 1, 'Publisher 2 sequence starts at 1');

    console.log('✅ Test 6 passed\n');

    // ==========================================
    // TEST 7: Subscription renewal
    // ==========================================
    console.log('🔄 Test 7: Subscription renewal...');

    const renewResult = await subscriber.renew(topicID, 7200000); // 2 hours
    assert(renewResult.success, 'Renewal succeeded');
    assert(renewResult.newExpiresAt > Date.now(), 'New expiry in future');

    // Verify renewed subscription in collection
    const updatedCoordinator = await storage.loadCoordinator(topicID);
    const updatedSubCollection = await storage.loadSubscriberCollection(updatedCoordinator.currentSubscribers);
    const sub = updatedSubCollection.getSubscriber(subscriberID);

    assert(sub !== null, 'Subscriber found in collection');
    assert(sub.expiresAt === renewResult.newExpiresAt, 'Expiry timestamp updated');

    console.log('✅ Test 7 passed\n');

    // ==========================================
    // TEST 8: Unsubscribe
    // ==========================================
    console.log('📤 Test 8: Unsubscribe from topic...');

    const unsubResult = await subscriber.unsubscribe(topicID);
    assert(unsubResult.success, 'Unsubscribe succeeded');
    assert(!subscriber.isSubscribed(topicID), 'No longer subscribed');

    // Verify removed from collection
    const finalCoordinator = await storage.loadCoordinator(topicID);
    const finalSubCollection = await storage.loadSubscriberCollection(finalCoordinator.currentSubscribers);
    assert(!finalSubCollection.hasSubscriber(subscriberID), 'Subscriber removed from collection');

    console.log('✅ Test 8 passed\n');

    // ==========================================
    // TEST 9: Coordinator pruning
    // ==========================================
    console.log('✂️ Test 9: Coordinator pruning after many updates...');

    const topicID2 = 'test-topic-2';
    const publisher3 = new PublishOperation(storage, publisherID, publisherKeys);

    // Publish 60 messages to trigger pruning
    console.log('   Publishing 60 messages...');
    for (let i = 1; i <= 60; i++) {
      await publisher3.publish(topicID2, { text: `Bulk message ${i}`, index: i });
    }

    // Check coordinator size
    const bulkCoordinator = await storage.loadCoordinator(topicID2);
    const historySize = bulkCoordinator.getHistorySize();

    assert(historySize <= 50, `Coordinator history pruned (size: ${historySize})`);
    assert(bulkCoordinator.previousCoordinator !== null, 'Snapshot link exists');

    console.log(`   ✅ Coordinator pruned (history: ${historySize} entries)`);
    console.log('✅ Test 9 passed\n');

    // ==========================================
    // TEST 10: Late joiner receives all history
    // ==========================================
    console.log('📥 Test 10: Late joiner receives full history...');

    const lateSubscriber = new SubscribeOperation(storage, 'late-subscriber-001', subscriberKeys);
    const lateMessages = [];

    const lateResult = await lateSubscriber.subscribe(topicID2, async (msg) => {
      lateMessages.push(msg);
    });

    assert(lateResult.success, 'Late subscriber subscribed');
    assert(lateMessages.length === 60, 'Late joiner received all 60 messages');

    // Verify no gaps in sequences
    const lateCoordinator = await storage.loadCoordinator(topicID2);
    const lateMessageCollection = await storage.loadMessageCollection(lateCoordinator.currentMessages);
    const lateGaps = lateMessageCollection.detectSequenceGaps();

    assert(lateGaps.size === 0, 'No sequence gaps for late joiner');

    console.log('✅ Test 10 passed\n');

  } catch (error) {
    console.error(`❌ Test failed: ${error.message}`);
    console.error(error.stack);
    testsFailed++;
  }

  // ==========================================
  // SUMMARY
  // ==========================================
  console.log('═══════════════════════════════════════');
  console.log(`✅ Tests Passed: ${testsPassed}`);
  console.log(`❌ Tests Failed: ${testsFailed}`);
  console.log('═══════════════════════════════════════');

  if (testsFailed === 0) {
    console.log('\n🎉 All protocol operation tests passed!');
    process.exit(0);
  } else {
    console.log('\n❌ Some tests failed');
    process.exit(1);
  }
}

// Run tests
runTests().catch(error => {
  console.error('Fatal test error:', error);
  process.exit(1);
});
