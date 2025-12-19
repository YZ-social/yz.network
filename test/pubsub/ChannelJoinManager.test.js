/**
 * Tests for ChannelJoinManager - Enhanced channel join experience and reliability
 */

import { ChannelJoinManager } from '../../src/pubsub/ChannelJoinManager.js';

// Mock PubSubClient
class MockPubSubClient {
  constructor(shouldFail = false, delay = 0) {
    this.shouldFail = shouldFail;
    this.delay = delay;
    this.subscriptions = new Set();
  }

  async subscribe(channelId, options = {}) {
    // Always add a small delay to make duration > 0
    const delay = this.delay > 0 ? this.delay : 10;
    await new Promise(resolve => setTimeout(resolve, delay));

    if (this.shouldFail) {
      throw new Error('Mock subscription failure');
    }

    this.subscriptions.add(channelId);
    return {
      coordinatorNode: 1,
      historicalMessages: 0
    };
  }

  isSubscribed(channelId) {
    return this.subscriptions.has(channelId);
  }

  async getTopicInfo(channelId) {
    if (this.subscriptions.has(channelId)) {
      return {
        version: 1,
        subscribers: 1,
        messages: 0
      };
    }
    return null;
  }
}

// Mock DHT
class MockDHT {
  constructor(isStarted = true, connectedPeers = 5) {
    this.isStarted = isStarted;
    this.connectedPeers = connectedPeers;
    this.routingTableSize = 10;
  }

  getConnectedPeers() {
    return Array(this.connectedPeers).fill(0).map((_, i) => `peer-${i}`);
  }

  get routingTable() {
    return {
      getAllNodes: () => Array(this.routingTableSize).fill(0).map((_, i) => ({ id: `node-${i}` }))
    };
  }

  cleanupRoutingTable() {
    // Mock cleanup
  }
}

describe('ChannelJoinManager', () => {
  let joinManager;
  let mockPubSub;
  let mockDHT;

  beforeEach(() => {
    mockPubSub = new MockPubSubClient();
    mockDHT = new MockDHT();
    joinManager = new ChannelJoinManager(mockPubSub, mockDHT);
  });

  describe('Basic functionality', () => {
    test('should successfully join a channel', async () => {
      const channelId = 'test-channel';
      const progressEvents = [];

      const result = await joinManager.joinChannel(channelId, {
        onProgress: (stage, details) => {
          progressEvents.push({ stage, details });
        }
      });

      expect(result.success).toBe(true);
      expect(result.coordinatorNode).toBe(1);
      expect(result.historicalMessages).toBe(0);
      expect(result.attempts).toBe(1);
      expect(result.duration).toBeGreaterThan(0);

      // Check that progress events were fired
      expect(progressEvents.length).toBeGreaterThan(0);
      expect(progressEvents.some(e => e.stage === 'attempting')).toBe(true);
      expect(progressEvents.some(e => e.stage === 'completed')).toBe(true);
    });

    test('should handle timeout correctly', async () => {
      // Create a slow mock that will timeout
      mockPubSub = new MockPubSubClient(false, 6000); // 6 second delay
      joinManager = new ChannelJoinManager(mockPubSub, mockDHT);

      const channelId = 'timeout-channel';
      const timeout = 1000; // 1 second timeout

      await expect(
        joinManager.joinChannel(channelId, { timeout, maxRetries: 0 })
      ).rejects.toThrow('timeout');

      expect(joinManager.getStats().timeoutJoins).toBe(1);
    });

    test('should retry on failure with exponential backoff', async () => {
      // Create a mock that fails first two attempts, then succeeds
      let attemptCount = 0;
      mockPubSub.subscribe = async (channelId) => {
        attemptCount++;
        if (attemptCount <= 2) {
          throw new Error('Connection failed');
        }
        mockPubSub.subscriptions.add(channelId);
        return { coordinatorNode: 1, historicalMessages: 0 };
      };

      const channelId = 'retry-channel';
      const progressEvents = [];

      const result = await joinManager.joinChannel(channelId, {
        maxRetries: 3,
        onProgress: (stage, details) => {
          progressEvents.push({ stage, details });
        }
      });

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(3);
      expect(attemptCount).toBe(3);

      // Check retry events
      const retryEvents = progressEvents.filter(e => e.stage === 'retrying');
      expect(retryEvents.length).toBe(2); // Two retries before success

      expect(joinManager.getStats().retriedJoins).toBe(1);
    });

    test('should handle concurrent joins to same channel', async () => {
      const channelId = 'concurrent-channel';
      
      // Start two joins simultaneously
      const join1Promise = joinManager.joinChannel(channelId);
      const join2Promise = joinManager.joinChannel(channelId);

      const [result1, result2] = await Promise.all([join1Promise, join2Promise]);

      // Both should succeed
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      // One should be marked as concurrent
      expect(result1.concurrent || result2.concurrent).toBe(true);

      expect(joinManager.getStats().concurrentJoins).toBe(1);
    });

    test('should validate connection health before joining', async () => {
      // Create DHT with no connected peers
      mockDHT = new MockDHT(true, 0);
      joinManager = new ChannelJoinManager(mockPubSub, mockDHT);

      const channelId = 'health-check-channel';

      await expect(
        joinManager.joinChannel(channelId)
      ).rejects.toThrow('No connected peers');
    });

    test('should provide enhanced error information', async () => {
      mockPubSub = new MockPubSubClient(true); // Always fail
      joinManager = new ChannelJoinManager(mockPubSub, mockDHT);

      const channelId = 'error-channel';

      try {
        await joinManager.joinChannel(channelId, { maxRetries: 2 });
        fail('Should have thrown an error');
      } catch (error) {
        expect(error.channelId).toBe(channelId);
        expect(error.attempts).toBeGreaterThan(0); // At least one attempt
        expect(error.duration).toBeGreaterThan(0);
        expect(error.remediation).toBeDefined();
        expect(Array.isArray(error.remediation)).toBe(true);
      }
    });
  });

  describe('Statistics and monitoring', () => {
    test('should track join statistics', async () => {
      const channelId1 = 'stats-channel-1';
      const channelId2 = 'stats-channel-2';

      // Successful join
      await joinManager.joinChannel(channelId1);

      // Failed join - modify the existing mock instead of creating new instance
      mockPubSub.shouldFail = true;

      try {
        await joinManager.joinChannel(channelId2, { maxRetries: 0 });
      } catch (error) {
        // Expected to fail
      }

      const stats = joinManager.getStats();
      expect(stats.totalJoins).toBe(2);
      expect(stats.successfulJoins).toBe(1);
      expect(stats.failedJoins).toBe(1);
      expect(stats.successRate).toBe('50.0%');
    });

    test('should track ongoing joins', async () => {
      const channelId = 'ongoing-channel';
      
      // Create a slow join
      mockPubSub = new MockPubSubClient(false, 1000);
      joinManager = new ChannelJoinManager(mockPubSub, mockDHT);

      const joinPromise = joinManager.joinChannel(channelId);

      // Check that join is tracked as ongoing
      expect(joinManager.isJoinInProgress(channelId)).toBe(true);
      expect(joinManager.getOngoingJoins()).toContain(channelId);

      await joinPromise;

      // Check that join is no longer tracked as ongoing
      expect(joinManager.isJoinInProgress(channelId)).toBe(false);
      expect(joinManager.getOngoingJoins()).not.toContain(channelId);
    });
  });

  describe('Error categorization', () => {
    test('should categorize timeout errors correctly', async () => {
      mockPubSub = new MockPubSubClient(false, 6000);
      joinManager = new ChannelJoinManager(mockPubSub, mockDHT);

      try {
        await joinManager.joinChannel('timeout-test', { timeout: 1000, maxRetries: 0 });
      } catch (error) {
        expect(error.category).toBe('timeout');
        expect(error.remediation).toContain('Check network connectivity');
      }
    });

    test('should categorize network isolation errors correctly', async () => {
      mockDHT = new MockDHT(true, 0); // No connected peers
      joinManager = new ChannelJoinManager(mockPubSub, mockDHT);

      try {
        await joinManager.joinChannel('isolation-test');
      } catch (error) {
        expect(error.category).toBe('network_isolation');
        expect(error.remediation).toContain('Check internet connection');
      }
    });

    test('should categorize DHT not ready errors correctly', async () => {
      mockDHT = new MockDHT(false); // DHT not started
      joinManager = new ChannelJoinManager(mockPubSub, mockDHT);

      try {
        await joinManager.joinChannel('dht-not-ready-test');
      } catch (error) {
        expect(error.category).toBe('dht_not_ready');
        expect(error.remediation).toContain('Wait for DHT to fully initialize');
      }
    });
  });
});