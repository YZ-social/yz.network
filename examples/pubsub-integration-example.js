/**
 * Sticky Pub/Sub Integration Example with KademliaDHT
 *
 * This example demonstrates how to use the Sticky Pub/Sub protocol
 * with the real KademliaDHT for decentralized publish/subscribe messaging.
 *
 * Run with: node examples/pubsub-integration-example.js
 */

import { KademliaDHT } from '../src/dht/KademliaDHT.js';
import { PubSubClient } from '../src/pubsub/index.js';
import { InvitationToken } from '../src/core/InvitationToken.js';

async function runExample() {
  console.log('🚀 Sticky Pub/Sub Integration Example\n');
  console.log('═══════════════════════════════════════\n');

  // Step 1: Create DHT nodes
  console.log('📡 Step 1: Creating DHT nodes...\n');

  const dht1 = new KademliaDHT({
    nodeType: 'nodejs',
    port: 9001,
    isGenesis: true
  });

  const dht2 = new KademliaDHT({
    nodeType: 'nodejs',
    port: 9002
  });

  await dht1.bootstrap();
  await dht2.bootstrap();

  console.log(`   ✅ DHT Node 1: ${dht1.nodeID.toString().substring(0, 16)}...`);
  console.log(`   ✅ DHT Node 2: ${dht2.nodeID.toString().substring(0, 16)}...\n`);

  // Step 2: Create pub/sub clients
  console.log('📬 Step 2: Creating pub/sub clients...\n');

  // Generate keys for signing messages
  const keys1 = await InvitationToken.generateKeyPair();
  const keys2 = await InvitationToken.generateKeyPair();

  // Create pub/sub clients WITH BATCHING for high concurrency
  const pubsub1 = new PubSubClient(dht1, dht1.nodeID.toString(), keys1, {
    enableBatching: true,
    batchSize: 10,
    batchTime: 100
  });

  const pubsub2 = new PubSubClient(dht2, dht2.nodeID.toString(), keys2);

  console.log('   ✅ PubSub Client 1 created (with batching enabled)');
  console.log('   ✅ PubSub Client 2 created\n');

  // Step 3: Subscribe to a topic
  console.log('📥 Step 3: Client 2 subscribing to "chat" topic...\n');

  const receivedMessages = [];

  pubsub2.on('chat', (message) => {
    console.log(`   📨 Received: "${message.data.text}" from ${message.publisherID.substring(0, 8)}`);
    receivedMessages.push(message);
  });

  await pubsub2.subscribe('chat');
  console.log('   ✅ Subscribed successfully\n');

  // Step 4: Publish messages
  console.log('📤 Step 4: Client 1 publishing messages...\n');

  await pubsub1.publish('chat', { text: 'Hello from Client 1!' });
  console.log('   ✅ Published message 1');

  await pubsub1.publish('chat', { text: 'This is message 2' });
  console.log('   ✅ Published message 2');

  await pubsub1.publish('chat', { text: 'And here is message 3' });
  console.log('   ✅ Published message 3\n');

  // Step 5: Wait for Client 2 to receive messages (via polling)
  console.log('🔄 Step 5: Polling for new messages...\n');

  await new Promise(resolve => setTimeout(resolve, 2000));
  const updates = await pubsub2.poll('chat');

  console.log(`   ✅ Polled and received ${updates.newMessages} new messages\n`);

  // Step 6: Demonstrate late joiner receiving history
  console.log('📥 Step 6: Creating late joiner (Client 3)...\n');

  const dht3 = new KademliaDHT({
    nodeType: 'nodejs',
    port: 9003
  });
  await dht3.bootstrap();

  const keys3 = await InvitationToken.generateKeyPair();
  const pubsub3 = new PubSubClient(dht3, dht3.nodeID.toString(), keys3);

  const lateMessages = [];
  pubsub3.on('chat', (message) => {
    lateMessages.push(message);
  });

  await pubsub3.subscribe('chat');

  console.log(`   ✅ Late joiner received ${lateMessages.length} historical messages\n`);
  lateMessages.forEach((msg, i) => {
    console.log(`      ${i + 1}. "${msg.data.text}"`);
  });

  // Step 7: Batch publishing (demonstrate high concurrency)
  console.log('\n📦 Step 7: Batch publishing 50 messages...\n');

  const batchData = [];
  for (let i = 1; i <= 50; i++) {
    batchData.push({ text: `Batch message ${i}`, index: i });
  }

  const startBatch = Date.now();
  const results = await pubsub1.batchPublish('chat', batchData);
  const batchDuration = Date.now() - startBatch;

  const successes = results.filter(r => r.success).length;
  console.log(`   ✅ Published ${successes}/50 messages in ${batchDuration}ms`);
  console.log(`   📈 Rate: ${(successes / (batchDuration / 1000)).toFixed(2)} msg/sec\n`);

  // Step 8: Show statistics
  console.log('📊 Step 8: Statistics...\n');

  const stats1 = pubsub1.getStats();
  const stats2 = pubsub2.getStats();
  const stats3 = pubsub3.getStats();

  console.log('   Client 1 (Publisher):');
  console.log(`      Messages published: ${stats1.messagesPublished}`);
  console.log(`      Publish failures: ${stats1.publishFailures}`);
  console.log(`      Active subscriptions: ${stats1.activeSubscriptions}\n`);

  console.log('   Client 2 (Subscriber):');
  console.log(`      Messages received: ${stats2.messagesReceived}`);
  console.log(`      Active subscriptions: ${stats2.activeSubscriptions}\n`);

  console.log('   Client 3 (Late Joiner):');
  console.log(`      Messages received: ${stats3.messagesReceived} (all historical)`);
  console.log(`      Active subscriptions: ${stats3.activeSubscriptions}\n`);

  // Step 9: Cleanup
  console.log('🧹 Step 9: Cleaning up...\n');

  await pubsub1.shutdown();
  await pubsub2.shutdown();
  await pubsub3.shutdown();

  await dht1.shutdown();
  await dht2.shutdown();
  await dht3.shutdown();

  console.log('   ✅ All clients and DHT nodes shut down\n');

  console.log('═══════════════════════════════════════');
  console.log('✅ Example Complete!');
  console.log('═══════════════════════════════════════\n');

  process.exit(0);
}

// Run the example
runExample().catch(error => {
  console.error('❌ Example failed:', error);
  process.exit(1);
});
