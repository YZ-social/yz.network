/**
 * Unit Tests for Sticky Pub/Sub Data Structures
 *
 * Tests serialization/deserialization and core functionality
 * of all pub/sub data structure classes.
 *
 * Run with: node src/pubsub/test-data-structures.js
 */

import { Message } from './Message.js';
import { MessageCollection } from './MessageCollection.js';
import { SubscriberCollection } from './SubscriberCollection.js';
import { CoordinatorObject } from './CoordinatorObject.js';
import { CoordinatorSnapshot } from './CoordinatorSnapshot.js';
import { InvitationToken } from '../core/InvitationToken.js';

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

function assertThrows(fn, expectedError, message) {
  try {
    fn();
    console.error(`❌ FAIL: ${message} - Expected error not thrown`);
    testsFailed++;
  } catch (error) {
    if (expectedError && !error.message.includes(expectedError)) {
      console.error(`❌ FAIL: ${message} - Wrong error: ${error.message}`);
      testsFailed++;
    } else {
      testsPassed++;
    }
  }
}

async function runTests() {
  console.log('🧪 Starting Sticky Pub/Sub Data Structure Tests\n');

  // ==========================================
  // MESSAGE TESTS
  // ==========================================
  console.log('📨 Testing Message class...');

  try {
    // Test 1: Message creation
    const message1 = new Message({
      topicID: 'test-topic',
      publisherID: 'publisher-node-123',
      publisherSequence: 1,
      addedInVersion: 0,
      data: { text: 'Hello World' },
      publishedAt: Date.now(),
      expiresAt: Date.now() + 3600000
    });

    assert(message1.topicID === 'test-topic', 'Message topic ID set correctly');
    assert(message1.publisherSequence === 1, 'Message sequence set correctly');
    assert(message1.messageID.length === 40, 'Message ID is 40-char hex string');

    // Test 2: Message signing and verification
    const keyInfo = await InvitationToken.generateKeyPair();
    await message1.sign(keyInfo);
    assert(message1.signature !== null, 'Message signed successfully');

    const isValid = await message1.verify(keyInfo.publicKey);
    assert(isValid, 'Message signature verification succeeded');

    // Test 3: Message serialization/deserialization
    const serialized1 = message1.serialize();
    const deserialized1 = Message.deserialize(serialized1);
    assert(deserialized1.messageID === message1.messageID, 'Message ID preserved after serialization');
    assert(deserialized1.publisherSequence === 1, 'Sequence preserved after serialization');
    assert(deserialized1.signature === message1.signature, 'Signature preserved after serialization');

    // Test 4: Message validation
    const validation1 = await message1.validate(keyInfo.publicKey);
    assert(validation1.valid, 'Message validation passed');
    assert(validation1.errors.length === 0, 'No validation errors');

    // Test 5: Message expiry check
    const expiredMessage = new Message({
      topicID: 'test-topic',
      publisherID: 'publisher-node-123',
      publisherSequence: 2,
      addedInVersion: 0,
      data: { text: 'Expired' },
      publishedAt: Date.now() - 7200000,
      expiresAt: Date.now() - 3600000 // Expired 1 hour ago
    });
    assert(expiredMessage.isExpired(), 'Expired message detected correctly');
    assert(!message1.isExpired(), 'Non-expired message detected correctly');

    console.log('✅ Message tests passed\n');
  } catch (error) {
    console.error(`❌ Message tests failed: ${error.message}\n`);
  }

  // ==========================================
  // MESSAGE COLLECTION TESTS
  // ==========================================
  console.log('📚 Testing MessageCollection class...');

  try {
    // Test 1: Empty collection
    const emptyCollection = new MessageCollection();
    assert(emptyCollection.size() === 0, 'Empty collection has size 0');
    assert(emptyCollection.collectionID.length === 40, 'Collection ID is 40-char hex string');

    // Test 2: Adding messages (immutable)
    const msgMeta1 = {
      messageID: 'msg-001',
      publisherID: 'pub-001',
      publisherSequence: 1,
      addedInVersion: 1,
      expiresAt: Date.now() + 3600000
    };

    const collection1 = emptyCollection.addMessage(msgMeta1);
    assert(collection1.size() === 1, 'Collection has 1 message after add');
    assert(emptyCollection.size() === 0, 'Original collection unchanged (immutable)');
    assert(collection1.hasMessage('msg-001'), 'Message found in collection');

    // Test 3: Adding multiple messages
    const msgMeta2 = {
      messageID: 'msg-002',
      publisherID: 'pub-001',
      publisherSequence: 2,
      addedInVersion: 2,
      expiresAt: Date.now() + 3600000
    };

    const collection2 = collection1.addMessage(msgMeta2);
    assert(collection2.size() === 2, 'Collection has 2 messages');

    // Test 4: Content-based TTL
    const ttl = collection2.expiresAt;
    assert(ttl > Date.now(), 'Collection TTL is in the future');
    assert(ttl > msgMeta1.expiresAt, 'Collection TTL includes grace period');

    // Test 5: Delta delivery (getMessagesSince)
    const deltaMessages = collection2.getMessagesSince(1);
    assert(deltaMessages.length === 1, 'Delta includes only messages added after version 1');
    assert(deltaMessages[0].messageID === 'msg-002', 'Delta contains correct message');

    // Test 6: Merge collections
    const collection3 = new MessageCollection().addMessage({
      messageID: 'msg-003',
      publisherID: 'pub-002',
      publisherSequence: 1,
      addedInVersion: 1,
      expiresAt: Date.now() + 3600000
    });

    const merged = collection2.merge(collection3);
    assert(merged.size() === 3, 'Merged collection has 3 messages');
    assert(merged.hasMessage('msg-001'), 'Merged collection has msg-001');
    assert(merged.hasMessage('msg-002'), 'Merged collection has msg-002');
    assert(merged.hasMessage('msg-003'), 'Merged collection has msg-003');

    // Test 7: Serialization/deserialization
    const serialized2 = collection2.serialize();
    const deserialized2 = MessageCollection.deserialize(serialized2);
    assert(deserialized2.size() === collection2.size(), 'Collection size preserved after serialization');
    assert(deserialized2.collectionID === collection2.collectionID, 'Collection ID preserved');

    // Test 8: Validation
    const validation2 = collection2.validate();
    assert(validation2.valid, 'Collection validation passed');

    // Test 9: Sequence gap detection
    const gappedCollection = new MessageCollection().addMessages([
      { messageID: 'm1', publisherID: 'p1', publisherSequence: 1, addedInVersion: 1, expiresAt: Date.now() + 3600000 },
      { messageID: 'm2', publisherID: 'p1', publisherSequence: 2, addedInVersion: 1, expiresAt: Date.now() + 3600000 },
      { messageID: 'm3', publisherID: 'p1', publisherSequence: 5, addedInVersion: 1, expiresAt: Date.now() + 3600000 } // Gap: 3, 4 missing
    ]);

    const gaps = gappedCollection.detectSequenceGaps();
    assert(gaps.has('p1'), 'Gap detected for publisher p1');
    assert(gaps.get('p1').length === 2, 'Gap contains 2 missing sequences');
    assert(gaps.get('p1').includes(3), 'Gap includes sequence 3');
    assert(gaps.get('p1').includes(4), 'Gap includes sequence 4');

    console.log('✅ MessageCollection tests passed\n');
  } catch (error) {
    console.error(`❌ MessageCollection tests failed: ${error.message}\n`);
  }

  // ==========================================
  // SUBSCRIBER COLLECTION TESTS
  // ==========================================
  console.log('👥 Testing SubscriberCollection class...');

  try {
    // Test 1: Empty collection
    const emptySubCollection = new SubscriberCollection();
    assert(emptySubCollection.size() === 0, 'Empty subscriber collection has size 0');

    // Test 2: Coordinator assignment calculation
    const coordinatorNode = SubscriberCollection.calculateCoordinatorNode('topic-1', 'subscriber-1', 20);
    assert(coordinatorNode >= 0 && coordinatorNode < 20, 'Coordinator node is in valid range');

    // Test 3: Adding subscribers
    const subMeta1 = {
      subscriberID: 'sub-001',
      coordinatorNode: 5,
      subscribedAt: Date.now(),
      expiresAt: Date.now() + 3600000,
      signature: 'fake-signature-1'
    };

    const subCollection1 = emptySubCollection.addSubscriber(subMeta1);
    assert(subCollection1.size() === 1, 'Subscriber collection has 1 subscriber');
    assert(subCollection1.hasSubscriber('sub-001'), 'Subscriber found in collection');

    // Test 4: Get subscribers by coordinator
    const subMeta2 = {
      subscriberID: 'sub-002',
      coordinatorNode: 5,
      subscribedAt: Date.now(),
      expiresAt: Date.now() + 3600000,
      signature: 'fake-signature-2'
    };

    const subCollection2 = subCollection1.addSubscriber(subMeta2);
    const coordinator5Subs = subCollection2.getSubscribersByCoordinator(5);
    assert(coordinator5Subs.length === 2, 'Found 2 subscribers for coordinator 5');

    // Test 5: Merge subscriber collections
    const subCollection3 = new SubscriberCollection().addSubscriber({
      subscriberID: 'sub-003',
      coordinatorNode: 10,
      subscribedAt: Date.now(),
      expiresAt: Date.now() + 3600000,
      signature: 'fake-signature-3'
    });

    const mergedSubs = subCollection2.merge(subCollection3);
    assert(mergedSubs.size() === 3, 'Merged subscriber collection has 3 subscribers');

    // Test 6: Remove subscriber (immutable)
    const removedCollection = mergedSubs.removeSubscriber('sub-002');
    assert(removedCollection.size() === 2, 'Collection has 2 subscribers after removal');
    assert(!removedCollection.hasSubscriber('sub-002'), 'Subscriber removed');
    assert(mergedSubs.size() === 3, 'Original collection unchanged (immutable)');

    // Test 7: Coordinator distribution
    const distribution = subCollection2.getCoordinatorDistribution();
    assert(distribution.get(5) === 2, 'Coordinator 5 has 2 subscribers');

    // Test 8: Serialization/deserialization
    const serializedSub = subCollection2.serialize();
    const deserializedSub = SubscriberCollection.deserialize(serializedSub);
    assert(deserializedSub.size() === subCollection2.size(), 'Subscriber count preserved after serialization');

    console.log('✅ SubscriberCollection tests passed\n');
  } catch (error) {
    console.error(`❌ SubscriberCollection tests failed: ${error.message}\n`);
  }

  // ==========================================
  // COORDINATOR OBJECT TESTS
  // ==========================================
  console.log('🎯 Testing CoordinatorObject class...');

  try {
    // Test 1: Create initial coordinator
    const coordinator0 = CoordinatorObject.createInitial('test-topic-1');
    assert(coordinator0.version === 0, 'Initial coordinator has version 0');
    assert(coordinator0.state === CoordinatorObject.ChannelState.ACTIVE, 'Initial coordinator is ACTIVE');
    assert(coordinator0.currentMessages === null, 'Initial coordinator has no messages');
    assert(coordinator0.currentSubscribers === null, 'Initial coordinator has no subscribers');

    // Test 2: Update subscribers (immutable, version increment)
    const coordinator1 = coordinator0.updateSubscribers('sub-coll-001');
    assert(coordinator1.version === 1, 'Coordinator version incremented');
    assert(coordinator1.currentSubscribers === 'sub-coll-001', 'Subscribers updated');
    assert(coordinator1.subscriberHistory.length === 0, 'History empty for first update');
    assert(coordinator0.version === 0, 'Original coordinator unchanged (immutable)');

    // Test 3: Update messages with history tracking
    const coordinator2 = coordinator1.updateMessages('msg-coll-001');
    assert(coordinator2.version === 2, 'Version incremented to 2');
    assert(coordinator2.currentMessages === 'msg-coll-001', 'Messages updated');
    assert(coordinator2.subscriberHistory.length === 0, 'Subscriber history unchanged when updating messages');
    assert(coordinator2.messageHistory.length === 0, 'Message history empty for first message update');

    // Test 4: Update subscribers again (should add previous to history)
    const coordinator2b = coordinator2.updateSubscribers('sub-coll-002');
    assert(coordinator2b.version === 3, 'Version incremented to 3');
    assert(coordinator2b.subscriberHistory.length === 1, 'Subscriber history has 1 entry');
    assert(coordinator2b.subscriberHistory[0] === 'sub-coll-001', 'Previous subscriber collection in history');

    // Test 5: Update both simultaneously
    const coordinator3 = coordinator2b.updateBoth('sub-coll-003', 'msg-coll-002');
    assert(coordinator3.version === 4, 'Version incremented to 4');
    assert(coordinator3.subscriberHistory.length === 2, 'Subscriber history has 2 entries');
    assert(coordinator3.messageHistory.length === 1, 'Message history has 1 entry');

    // Test 6: Merge coordinators
    const coordinatorA = CoordinatorObject.createInitial('test-topic-1');
    const coordinatorA1 = coordinatorA.updateMessages('msg-a');

    const coordinatorB = CoordinatorObject.createInitial('test-topic-1');
    const coordinatorB1 = coordinatorB.updateMessages('msg-b');

    const merged = coordinatorA1.merge(coordinatorB1);
    assert(merged.version === 2, 'Merged coordinator has max version + 1');
    assert(merged.messageHistory.length >= 2, 'Merged history contains both collections');

    // Test 7: Pruning check
    const bigCoordinator = CoordinatorObject.createInitial('test-topic-2');
    let current = bigCoordinator;

    // Add 60 updates to trigger pruning
    for (let i = 0; i < 60; i++) {
      current = current.updateMessages(`msg-coll-${i}`);
    }

    assert(current.needsPruning(), 'Coordinator needs pruning after 60 updates');

    const { coordinator: pruned, snapshot } = current.prune();
    assert(pruned.messageHistory.length === CoordinatorObject.MIN_HISTORY_ENTRIES, 'Pruned coordinator has minimal history');
    assert(pruned.previousCoordinator === snapshot.snapshotID, 'Pruned coordinator links to snapshot');
    assert(snapshot.isSnapshot === true, 'Snapshot flagged correctly');

    // Test 8: State transitions
    const recovering = coordinator3.updateState(CoordinatorObject.ChannelState.RECOVERING);
    assert(recovering.state === 'RECOVERING', 'State updated to RECOVERING');
    assert(recovering.version === coordinator3.version, 'Version unchanged for state update');

    // Test 9: Serialization/deserialization
    const serializedCoord = coordinator3.serialize();
    const deserializedCoord = CoordinatorObject.deserialize(serializedCoord);
    assert(deserializedCoord.version === coordinator3.version, 'Version preserved after serialization');
    assert(deserializedCoord.topicID === coordinator3.topicID, 'Topic ID preserved');
    assert(deserializedCoord.subscriberHistory.length === coordinator3.subscriberHistory.length, 'History length preserved');

    // Test 10: Validation
    const validation3 = coordinator3.validate();
    assert(validation3.valid, 'Coordinator validation passed');

    console.log('✅ CoordinatorObject tests passed\n');
  } catch (error) {
    console.error(`❌ CoordinatorObject tests failed: ${error.message}\n`);
  }

  // ==========================================
  // COORDINATOR SNAPSHOT TESTS
  // ==========================================
  console.log('📸 Testing CoordinatorSnapshot class...');

  try {
    // Test 1: Create snapshot
    const snapshot1 = new CoordinatorSnapshot({
      version: 50,
      topicID: 'test-topic-3',
      subscriberHistory: ['sub-1', 'sub-2', 'sub-3'],
      messageHistory: ['msg-1', 'msg-2', 'msg-3'],
      previousCoordinator: null
    });

    assert(snapshot1.version === 50, 'Snapshot version set correctly');
    assert(snapshot1.isSnapshot === true, 'Snapshot flag is true');
    assert(snapshot1.getHistorySize() === 6, 'Snapshot history size is 6');

    // Test 2: Linked snapshots
    const snapshot2 = new CoordinatorSnapshot({
      version: 100,
      topicID: 'test-topic-3',
      subscriberHistory: ['sub-4', 'sub-5'],
      messageHistory: ['msg-4', 'msg-5'],
      previousCoordinator: snapshot1.snapshotID
    });

    assert(snapshot2.previousCoordinator === snapshot1.snapshotID, 'Snapshot links to previous');

    // Test 3: Expiry check
    assert(!snapshot1.isExpired(), 'Fresh snapshot not expired');

    // Test 4: Factory method
    const snapshot3 = CoordinatorSnapshot.createFromPruning({
      version: 75,
      topicID: 'test-topic-4',
      prunedSubscriberHistory: ['s1', 's2'],
      prunedMessageHistory: ['m1', 'm2'],
      previousCoordinator: null
    });

    assert(snapshot3.version === 75, 'Factory method creates snapshot with correct version');

    // Test 5: Serialization/deserialization
    const serializedSnap = snapshot1.serialize();
    const deserializedSnap = CoordinatorSnapshot.deserialize(serializedSnap);
    assert(deserializedSnap.version === snapshot1.version, 'Snapshot version preserved');
    assert(deserializedSnap.isSnapshot === true, 'Snapshot flag preserved');

    console.log('✅ CoordinatorSnapshot tests passed\n');
  } catch (error) {
    console.error(`❌ CoordinatorSnapshot tests failed: ${error.message}\n`);
  }

  // ==========================================
  // SUMMARY
  // ==========================================
  console.log('═══════════════════════════════════════');
  console.log(`✅ Tests Passed: ${testsPassed}`);
  console.log(`❌ Tests Failed: ${testsFailed}`);
  console.log('═══════════════════════════════════════');

  if (testsFailed === 0) {
    console.log('\n🎉 All tests passed!');
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
