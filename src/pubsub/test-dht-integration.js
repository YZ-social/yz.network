/**
 * DHT Integration Test for Sticky Pub/Sub
 *
 * Tests that PubSubStorage correctly integrates with KademliaDHT's
 * store() and get() methods for actual distributed storage.
 *
 * Run with: node src/pubsub/test-dht-integration.js
 */

import { KademliaDHT } from '../dht/KademliaDHT.js';
import { PubSubClient } from './PubSubClient.js';
import { PubSubStorage } from './PubSubStorage.js';
import { InvitationToken } from '../core/InvitationToken.js';
import { Message } from './Message.js';
import { CoordinatorObject } from './CoordinatorObject.js';

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    throw new Error(message);
  }
}

async function runIntegrationTests() {
  console.log('🔗 DHT Integration Tests for Sticky Pub/Sub\n');
  console.log('═══════════════════════════════════════\n');

  // Test 1: Basic storage integration
  console.log('📦 Test 1: PubSubStorage with KademliaDHT...\n');

  try {
    // Create a minimal DHT instance (no network)
    const dht = new KademliaDHT({
      nodeType: 'nodejs'
    });

    const storage = new PubSubStorage(dht);

    // Test storing and loading a coordinator
    console.log('   Testing coordinator storage...');
    const topicID = 'test-topic-1';
    const coordinator = CoordinatorObject.createInitial(topicID);

    await storage.storeCoordinator(coordinator);
    const loaded = await storage.loadCoordinator(topicID);

    assert(loaded !== null, 'Coordinator should be loaded');
    assert(loaded.topicID === topicID, 'Topic ID should match');
    assert(loaded.version === 0, 'Initial version should be 0');
    console.log('   ✅ Coordinator storage works\n');

    // Test storing and loading a message
    console.log('   Testing message storage...');
    const keys = await InvitationToken.generateKeyPair();
    const message = new Message({
      topicID,
      publisherID: 'test-publisher',
      publisherSequence: 1,
      addedInVersion: 1,
      data: { text: 'Test message' },
      publishedAt: Date.now(),
      expiresAt: Date.now() + 3600000
    });

    await message.sign(keys);
    await storage.storeMessage(message);
    const loadedMessage = await storage.loadMessage(message.messageID);

    assert(loadedMessage !== null, 'Message should be loaded');
    assert(loadedMessage.data.text === 'Test message', 'Message data should match');
    console.log('   ✅ Message storage works\n');

    console.log('✅ Test 1 PASSED\n');
    console.log('═══════════════════════════════════════\n');

  } catch (error) {
    console.error(`❌ Test 1 FAILED: ${error.message}\n`);
    throw error;
  }

  // Test 2: PubSubClient with DHT
  console.log('📬 Test 2: PubSubClient with real DHT storage...\n');

  try {
    const dht = new KademliaDHT({
      nodeType: 'nodejs'
    });

    const keys = await InvitationToken.generateKeyPair();
    const pubsub = new PubSubClient(dht, 'publisher-1', keys);

    const topicID = 'test-topic-2';

    // Publish a message
    console.log('   Publishing message...');
    const result = await pubsub.publish(topicID, { text: 'Hello DHT!' });

    assert(result.success, 'Publish should succeed');
    assert(result.messageID, 'Should have message ID');
    assert(result.version === 1, 'Version should be 1');
    console.log('   ✅ Published successfully\n');

    // Verify it's in DHT storage
    console.log('   Verifying storage...');
    const coordinator = await pubsub.storage.loadCoordinator(topicID);

    assert(coordinator !== null, 'Coordinator should exist');
    assert(coordinator.version === 1, 'Version should be 1');
    console.log('   ✅ Data stored in DHT\n');

    // Create another client and subscribe
    console.log('   Testing subscription and historical delivery...');
    const keys2 = await InvitationToken.generateKeyPair();
    const pubsub2 = new PubSubClient(dht, 'subscriber-1', keys2);

    const receivedMessages = [];
    pubsub2.on(topicID, (message) => {
      receivedMessages.push(message);
    });

    await pubsub2.subscribe(topicID);

    assert(receivedMessages.length === 1, 'Should receive 1 historical message');
    assert(receivedMessages[0].data.text === 'Hello DHT!', 'Message content should match');
    console.log('   ✅ Historical delivery works\n');

    console.log('✅ Test 2 PASSED\n');
    console.log('═══════════════════════════════════════\n');

  } catch (error) {
    console.error(`❌ Test 2 FAILED: ${error.message}\n`);
    throw error;
  }

  // Test 3: Multiple messages with real DHT
  console.log('📨 Test 3: Multiple messages through DHT...\n');

  try {
    const dht = new KademliaDHT({
      nodeType: 'nodejs'
    });

    const keys = await InvitationToken.generateKeyPair();
    const pubsub = new PubSubClient(dht, 'publisher-multi', keys);

    const topicID = 'test-topic-3';

    // Publish multiple messages
    console.log('   Publishing 10 messages...');
    for (let i = 1; i <= 10; i++) {
      await pubsub.publish(topicID, { index: i, text: `Message ${i}` });
    }
    console.log('   ✅ Published 10 messages\n');

    // Subscribe and verify
    console.log('   Subscribing and checking delivery...');
    const keys2 = await InvitationToken.generateKeyPair();
    const pubsub2 = new PubSubClient(dht, 'subscriber-multi', keys2);

    const receivedMessages = [];
    pubsub2.on(topicID, (message) => {
      receivedMessages.push(message);
    });

    await pubsub2.subscribe(topicID);

    assert(receivedMessages.length === 10, 'Should receive all 10 messages');

    // Verify order and content
    const indices = receivedMessages.map(m => m.data.index).sort((a, b) => a - b);
    for (let i = 1; i <= 10; i++) {
      assert(indices.includes(i), `Should include message ${i}`);
    }

    console.log('   ✅ All 10 messages received correctly\n');

    console.log('✅ Test 3 PASSED\n');
    console.log('═══════════════════════════════════════\n');

  } catch (error) {
    console.error(`❌ Test 3 FAILED: ${error.message}\n`);
    throw error;
  }

  // Test 4: Batch publishing with DHT
  console.log('📦 Test 4: Batch publishing with DHT storage...\n');

  try {
    const dht = new KademliaDHT({
      nodeType: 'nodejs'
    });

    const keys = await InvitationToken.generateKeyPair();
    const pubsub = new PubSubClient(dht, 'publisher-batch', keys, {
      enableBatching: true,
      batchSize: 5,
      batchTime: 100
    });

    const topicID = 'test-topic-4';

    // Batch publish
    console.log('   Batch publishing 20 messages...');
    const batchData = [];
    for (let i = 1; i <= 20; i++) {
      batchData.push({ index: i, text: `Batch ${i}` });
    }

    const results = await pubsub.batchPublish(topicID, batchData);
    const successes = results.filter(r => r.success).length;

    assert(successes === 20, 'All 20 messages should publish successfully');
    console.log('   ✅ Batch published 20 messages\n');

    // Subscribe and verify
    console.log('   Verifying batch storage in DHT...');
    const keys2 = await InvitationToken.generateKeyPair();
    const pubsub2 = new PubSubClient(dht, 'subscriber-batch', keys2);

    const receivedMessages = [];
    pubsub2.on(topicID, (message) => {
      receivedMessages.push(message);
    });

    await pubsub2.subscribe(topicID);

    assert(receivedMessages.length === 20, 'Should receive all 20 batched messages');
    console.log('   ✅ All batched messages stored and retrieved from DHT\n');

    console.log('✅ Test 4 PASSED\n');
    console.log('═══════════════════════════════════════\n');

  } catch (error) {
    console.error(`❌ Test 4 FAILED: ${error.message}\n`);
    throw error;
  }

  // Summary
  console.log('═══════════════════════════════════════');
  console.log('🎉 All DHT Integration Tests PASSED!');
  console.log('═══════════════════════════════════════');
  console.log('\n✅ Test 1: Basic storage integration');
  console.log('✅ Test 2: PubSubClient with DHT');
  console.log('✅ Test 3: Multiple messages through DHT');
  console.log('✅ Test 4: Batch publishing with DHT\n');
  console.log('🏆 Sticky Pub/Sub successfully integrated with KademliaDHT!\n');

  process.exit(0);
}

// Run tests
runIntegrationTests().catch(error => {
  console.error('Fatal test error:', error);
  process.exit(1);
});
