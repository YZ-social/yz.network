/**
 * Enhanced Channel Join Demo
 * 
 * Demonstrates the improved channel join experience and reliability features:
 * - 5-second timeout for channel join operations with progress feedback
 * - Automatic retry with exponential backoff for failed joins
 * - Clear error messages and remediation suggestions for join failures
 * - Concurrent join handling to ensure multiple users can join simultaneously
 */

import { PubSubClient } from '../src/pubsub/PubSubClient.js';

// Mock DHT for demonstration
class DemoMockDHT {
  constructor(simulateFailures = false) {
    this.isStarted = true;
    this.storage = new Map();
    this.connectedPeers = ['peer1', 'peer2', 'peer3'];
    this.simulateFailures = simulateFailures;
    this.failureCount = 0;
    this.routingTable = {
      getAllNodes: () => [
        { id: 'node1' }, { id: 'node2' }, { id: 'node3' }
      ]
    };
  }

  async store(key, data) {
    // Simulate occasional storage failures
    if (this.simulateFailures && Math.random() < 0.3) {
      throw new Error('Storage temporarily unavailable');
    }
    this.storage.set(key, data);
    return true;
  }

  async get(key) {
    return this.storage.get(key) || null;
  }

  async getFromNetwork(key) {
    // Simulate network delays and occasional failures
    await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 200));
    
    if (this.simulateFailures && this.failureCount < 2) {
      this.failureCount++;
      throw new Error('Network connection failed');
    }
    
    return this.storage.get(key) || null;
  }

  getConnectedPeers() {
    return this.connectedPeers;
  }

  cleanupRoutingTable() {
    console.log('🧹 Cleaning up routing table...');
  }

  on(event, handler) {
    // Mock event registration
  }

  sendMessage(nodeId, message) {
    return Promise.resolve();
  }
}

async function demonstrateEnhancedJoin() {
  console.log('🚀 Enhanced Channel Join Demo\n');

  // Create mock DHT and PubSub client
  const mockDHT = new DemoMockDHT();
  const mockPrivateKey = new Uint8Array(32).fill(1);
  const mockPublicKey = new Uint8Array(32).fill(2);
  
  const pubsubClient = new PubSubClient(
    mockDHT,
    'demo-node-id',
    { privateKey: mockPrivateKey, publicKey: mockPublicKey }
  );

  // Demo 1: Successful join with progress feedback
  console.log('📋 Demo 1: Successful Channel Join with Progress Feedback');
  console.log('=' .repeat(60));
  
  try {
    const result = await pubsubClient.joinChannel('demo-channel-1', {
      timeout: 5000,
      maxRetries: 3,
      onProgress: (stage, details) => {
        switch (stage) {
          case 'attempting':
            console.log(`🔄 Attempting join (${details.attempt}/${details.maxAttempts}): ${details.message}`);
            break;
          case 'health_check':
            console.log(`🏥 ${details.message}`);
            break;
          case 'health_check_passed':
            console.log(`✅ ${details.message}`);
            break;
          case 'connecting':
            console.log(`🔗 ${details.message}`);
            break;
          case 'validating':
            console.log(`🔍 ${details.message}`);
            break;
          case 'validation_passed':
            console.log(`✅ ${details.message}`);
            break;
          case 'completed':
            console.log(`🎉 ${details.message} (${details.attempts} attempts, ${details.duration}ms)`);
            break;
        }
      }
    });

    console.log(`\n✅ Join Result:`, {
      success: result.success,
      coordinatorNode: result.coordinatorNode,
      historicalMessages: result.historicalMessages,
      attempts: result.attempts,
      duration: result.duration
    });

  } catch (error) {
    console.error('❌ Join failed:', error.message);
  }

  console.log('\n' + '='.repeat(60) + '\n');

  // Demo 2: Join with retry on failure
  console.log('📋 Demo 2: Join with Automatic Retry on Failure');
  console.log('=' .repeat(60));

  // Create a DHT that will fail initially then succeed
  const flakyDHT = new DemoMockDHT(true);
  const flakyClient = new PubSubClient(
    flakyDHT,
    'flaky-node-id',
    { privateKey: mockPrivateKey, publicKey: mockPublicKey }
  );

  try {
    const result = await flakyClient.joinChannel('demo-channel-2', {
      timeout: 3000,
      maxRetries: 3,
      onProgress: (stage, details) => {
        switch (stage) {
          case 'attempting':
            console.log(`🔄 Attempt ${details.attempt}/${details.maxAttempts}: ${details.message}`);
            break;
          case 'retrying':
            console.log(`⚠️ ${details.message} (delay: ${details.retryDelay}ms)`);
            break;
          case 'completed':
            console.log(`🎉 ${details.message} after ${details.attempts} attempts`);
            break;
        }
      }
    });

    console.log(`\n✅ Retry Success:`, {
      success: result.success,
      attempts: result.attempts,
      duration: result.duration
    });

  } catch (error) {
    console.error('❌ Join failed after retries:', error.message);
    if (error.remediation) {
      console.log('\n💡 Suggested solutions:');
      error.remediation.forEach((suggestion, index) => {
        console.log(`   ${index + 1}. ${suggestion}`);
      });
    }
  }

  console.log('\n' + '='.repeat(60) + '\n');

  // Demo 3: Concurrent joins
  console.log('📋 Demo 3: Concurrent Join Handling');
  console.log('=' .repeat(60));

  const channelId = 'concurrent-demo-channel';
  
  console.log('🚀 Starting two concurrent joins to the same channel...');
  
  const join1Promise = pubsubClient.joinChannel(channelId, {
    onProgress: (stage, details) => {
      if (stage === 'concurrent') {
        console.log('👥 Join 1: Detected concurrent join, waiting...');
      } else if (stage === 'completed') {
        console.log(`✅ Join 1: ${details.message} ${details.concurrent ? '(via concurrent operation)' : ''}`);
      }
    }
  });

  const join2Promise = pubsubClient.joinChannel(channelId, {
    onProgress: (stage, details) => {
      if (stage === 'concurrent') {
        console.log('👥 Join 2: Detected concurrent join, waiting...');
      } else if (stage === 'completed') {
        console.log(`✅ Join 2: ${details.message} ${details.concurrent ? '(via concurrent operation)' : ''}`);
      }
    }
  });

  try {
    const [result1, result2] = await Promise.all([join1Promise, join2Promise]);
    
    console.log('\n🎯 Concurrent Join Results:');
    console.log(`   Join 1: ${result1.success ? 'Success' : 'Failed'} ${result1.concurrent ? '(concurrent)' : '(primary)'}`);
    console.log(`   Join 2: ${result2.success ? 'Success' : 'Failed'} ${result2.concurrent ? '(concurrent)' : '(primary)'}`);
    
  } catch (error) {
    console.error('❌ Concurrent join failed:', error.message);
  }

  console.log('\n' + '='.repeat(60) + '\n');

  // Demo 4: Statistics
  console.log('📋 Demo 4: Join Statistics');
  console.log('=' .repeat(60));

  const stats = pubsubClient.getJoinStats();
  console.log('📊 Join Statistics:', {
    totalJoins: stats.totalJoins,
    successfulJoins: stats.successfulJoins,
    failedJoins: stats.failedJoins,
    retriedJoins: stats.retriedJoins,
    concurrentJoins: stats.concurrentJoins,
    successRate: stats.successRate
  });

  console.log('\n🎉 Demo completed! Enhanced channel join functionality provides:');
  console.log('   ✅ 5-second timeout with progress feedback');
  console.log('   ✅ Automatic retry with exponential backoff');
  console.log('   ✅ Clear error messages with remediation suggestions');
  console.log('   ✅ Concurrent join handling');
  console.log('   ✅ Comprehensive statistics and monitoring');
}

// Run the demo
demonstrateEnhancedJoin().catch(console.error);