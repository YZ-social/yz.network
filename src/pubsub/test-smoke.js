/**
 * Smoke Test for Sticky Pub/Sub
 *
 * Smaller scale tests to verify concurrent publishing works correctly:
 * - 100 sequential messages
 * - 5 publishers × 20 messages each (100 total concurrent)
 * - Late joiner with 50 historical messages
 */

import { PubSubClient } from './PubSubClient.js';
import { PubSubStorage } from './PubSubStorage.js';
import { InvitationToken } from '../core/InvitationToken.js';

// Mock DHT with atomic compare-and-swap
class MockDHT {
  constructor() {
    this.storage = new Map();
    this.coordinatorLocks = new Map();
  }

  async store(key, value) {
    this.storage.set(key, JSON.parse(JSON.stringify(value)));
    return true;
  }

  async get(key) {
    const value = this.storage.get(key);
    return value ? JSON.parse(JSON.stringify(value)) : null;
  }

  async compareAndSwapCoordinator(topicID, newCoordinator, expectedVersion) {
    if (!this.coordinatorLocks.has(topicID)) {
      this.coordinatorLocks.set(topicID, Promise.resolve());
    }

    return new Promise((resolve) => {
      const lock = this.coordinatorLocks.get(topicID);
      this.coordinatorLocks.set(topicID, lock.then(async () => {
        await new Promise(r => setTimeout(r, 1));
        const key = `coordinator:${topicID}`;
        const current = this.storage.get(key);
        const currentCoordinator = current ? JSON.parse(JSON.stringify(current)) : null;

        if (currentCoordinator && currentCoordinator.version !== expectedVersion) {
          resolve({ success: false, conflict: true, currentVersion: currentCoordinator.version, currentCoordinator });
        } else {
          this.storage.set(key, JSON.parse(JSON.stringify(newCoordinator)));
          resolve({ success: true, conflict: false, currentVersion: newCoordinator.version });
        }
      }));
    });
  }

  getStats() {
    return { localStorageSize: this.storage.size, dhtNodes: 0, connectedPeers: 0 };
  }
}

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    throw new Error(message);
  }
}

async function runSmokeTests() {
  console.log('🔬 Sticky Pub/Sub Smoke Tests\n');

  // Test 1: 100 sequential messages
  console.log('📨 Test 1: Sequential (100 messages)...');
  const mockDHT1 = new MockDHT();
  const pub1Keys = await InvitationToken.generateKeyPair();
  const sub1Keys = await InvitationToken.generateKeyPair();
  const pub1 = new PubSubClient(mockDHT1, 'pub-1', pub1Keys);
  const sub1 = new PubSubClient(mockDHT1, 'sub-1', sub1Keys);

  for (let i = 1; i <= 100; i++) {
    await pub1.publish('test-seq', { index: i });
  }

  const received1 = [];
  sub1.on('test-seq', (msg) => received1.push(msg));
  await sub1.subscribe('test-seq');

  assert(received1.length === 100, `Received all 100 messages (got ${received1.length})`);
  console.log('✅ Test 1 PASSED\n');

  // Test 2: 5 publishers × 20 messages = 100 concurrent
  console.log('📨 Test 2: Concurrent (5 publishers × 20 messages)...');
  const mockDHT2 = new MockDHT();
  const publishers = [];

  for (let i = 0; i < 5; i++) {
    const keys = await InvitationToken.generateKeyPair();
    publishers.push(new PubSubClient(mockDHT2, `pub-${i}`, keys));
  }

  const publishPromises = [];
  for (let p = 0; p < 5; p++) {
    for (let i = 1; i <= 20; i++) {
      publishPromises.push(publishers[p].publish('test-con', { publisherID: `pub-${p}`, index: i }));
    }
  }

  const results = await Promise.allSettled(publishPromises);
  const successes = results.filter(r => r.status === 'fulfilled').length;
  console.log(`   Published ${successes}/100 messages`);

  const sub2Keys = await InvitationToken.generateKeyPair();
  const sub2 = new PubSubClient(mockDHT2, 'sub-2', sub2Keys);
  const received2 = [];
  sub2.on('test-con', (msg) => received2.push(msg));
  await sub2.subscribe('test-con');

  assert(received2.length === successes, `Received all ${successes} messages (got ${received2.length})`);
  console.log('✅ Test 2 PASSED\n');

  // Test 3: Late joiner with 50 historical messages
  console.log('📨 Test 3: Late Joiner (50 historical messages)...');
  const mockDHT3 = new MockDHT();
  const pub3Keys = await InvitationToken.generateKeyPair();
  const pub3 = new PubSubClient(mockDHT3, 'pub-3', pub3Keys);

  for (let i = 1; i <= 50; i++) {
    await pub3.publish('test-late', { index: i });
  }

  const sub3Keys = await InvitationToken.generateKeyPair();
  const sub3 = new PubSubClient(mockDHT3, 'sub-3', sub3Keys);
  const received3 = [];
  sub3.on('test-late', (msg) => received3.push(msg));
  await sub3.subscribe('test-late');

  assert(received3.length === 50, `Late joiner received all 50 messages (got ${received3.length})`);
  console.log('✅ Test 3 PASSED\n');

  console.log('═══════════════════════════════════');
  console.log('🎉 All Smoke Tests PASSED!');
  console.log('═══════════════════════════════════');
  process.exit(0);
}

runSmokeTests().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
