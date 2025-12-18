/**
 * Test Message Deduplication
 * 
 * Simple test to verify message deduplication works correctly
 * Run with: node src/pubsub/test-deduplication.js
 */

import { PubSubClient } from './PubSubClient.js';

// Mock DHT for testing
class MockDHT {
  constructor() {
    this.isStarted = true;
    this.storage = new Map();
  }

  async store(key, value) {
    this.storage.set(key, value);
    return true;
  }

  async getFromNetwork(key) {
    return this.storage.get(key) || null;
  }

  on() {} // Mock event handler
  emit() {} // Mock event emitter
}

// Mock key info
const mockKeyInfo = {
  publicKey: 'mock-public-key',
  privateKey: 'mock-private-key'
};

async function testDeduplication() {
  console.log('🧪 Testing Message Deduplication...\n');

  const mockDHT = new MockDHT();
  const pubsub = new PubSubClient(mockDHT, 'test-node', mockKeyInfo);

  // Test message
  const testMessage = {
    messageID: 'test-msg-123',
    topicID: 'test-topic',
    data: { text: 'Hello World' },
    publishedAt: Date.now()
  };

  console.log('1. Testing first message delivery...');
  const isDuplicate1 = pubsub.isDuplicateMessage(testMessage);
  console.log(`   Is duplicate: ${isDuplicate1} (should be false)`);
  
  if (!isDuplicate1) {
    pubsub.markMessageReceived(testMessage);
    console.log('   ✅ Message marked as received');
  }

  console.log('\n2. Testing duplicate message detection...');
  const isDuplicate2 = pubsub.isDuplicateMessage(testMessage);
  console.log(`   Is duplicate: ${isDuplicate2} (should be true)`);
  
  if (isDuplicate2) {
    console.log('   ✅ Duplicate correctly detected');
  } else {
    console.log('   ❌ Duplicate detection failed');
  }

  console.log('\n3. Testing deduplication cache size...');
  console.log(`   Cache size: ${pubsub.receivedMessages.size}`);

  console.log('\n4. Testing cleanup...');
  pubsub.cleanupOldMessages();
  console.log(`   Cache size after cleanup: ${pubsub.receivedMessages.size}`);

  console.log('\n5. Testing DHT status check...');
  mockDHT.isStarted = false;
  
  try {
    await pubsub.publish('test-topic', { text: 'Should fail' });
    console.log('   ❌ Publish should have failed');
  } catch (error) {
    console.log(`   ✅ Publish correctly failed: ${error.message}`);
  }

  // Test polling with DHT not started
  console.log('\n6. Testing polling with DHT not started...');
  await pubsub.pollAll(); // Should not throw, just log warning
  console.log('   ✅ Polling handled DHT not started gracefully');

  console.log('\n✅ Deduplication test completed successfully!');
  
  await pubsub.shutdown();
}

testDeduplication().catch(console.error);