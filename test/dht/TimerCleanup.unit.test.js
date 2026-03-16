import { jest } from '@jest/globals';

/**
 * Unit Tests: Timer Cleanup
 * 
 * **Validates: Requirements 2.1, 2.2, 2.4, 2.5**
 * 
 * These tests verify that:
 * - KademliaDHT.stop() clears all 5 maintenance timers (2.1)
 * - KademliaDHT.stop() clears refreshTimer, bootstrapRetryTimer, pingMaintenanceTimer, dhtOfferPollingInterval (2.1)
 * - OverlayNetwork.stop() clears all 3 maintenance timers (2.2)
 * - pendingRequests entries are removed on timeout (2.4)
 * - cleanupTrackingMaps() removes orphaned entries from all Maps (2.5)
 */

describe('Unit Tests: Timer Cleanup', () => {
  
  // Track timer calls
  let originalSetInterval;
  let originalClearInterval;
  let originalSetTimeout;
  let originalClearTimeout;
  let activeIntervals;
  let activeTimeouts;
  let timerIdCounter;

  beforeAll(() => {
    originalSetInterval = global.setInterval;
    originalClearInterval = global.clearInterval;
    originalSetTimeout = global.setTimeout;
    originalClearTimeout = global.clearTimeout;
  });

  beforeEach(() => {
    activeIntervals = new Map();
    activeTimeouts = new Map();
    timerIdCounter = 1000;
    
    global.setInterval = jest.fn((callback, interval) => {
      const timerId = timerIdCounter++;
      activeIntervals.set(timerId, { callback, interval, cleared: false });
      return timerId;
    });
    
    global.clearInterval = jest.fn((timerId) => {
      if (activeIntervals.has(timerId)) {
        activeIntervals.get(timerId).cleared = true;
      }
    });

    global.setTimeout = jest.fn((callback, delay) => {
      const timerId = timerIdCounter++;
      activeTimeouts.set(timerId, { callback, delay, cleared: false });
      return timerId;
    });
    
    global.clearTimeout = jest.fn((timerId) => {
      if (activeTimeouts.has(timerId)) {
        activeTimeouts.get(timerId).cleared = true;
      }
    });
  });

  afterEach(() => {
    activeIntervals.clear();
    activeTimeouts.clear();
  });

  afterAll(() => {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  });


  /**
   * Test Suite 1: KademliaDHT.stop() clears all 5 maintenance timers
   * 
   * **Validates: Requirement 2.1**
   * 
   * The 5 maintenance timers are:
   * 1. republishDataTimer
   * 2. cleanupTrackingMapsTimer
   * 3. cleanupTimer
   * 4. routingMaintenanceTimer
   * 5. staleCleanupTimer
   */
  describe('KademliaDHT.stop() clears all 5 maintenance timers', () => {
    
    test('republishDataTimer is cleared on stop()', async () => {
      const { KademliaDHT } = await import('../../src/dht/KademliaDHT.js');
      
      const dht = new KademliaDHT({
        republishInterval: 60000,
        expireInterval: 60000,
        pingInterval: 30000
      });
      
      dht.isStarted = true;
      dht.startMaintenanceTasks();
      
      // Verify timer was created
      expect(dht.republishDataTimer).toBeDefined();
      expect(dht.republishDataTimer).not.toBeNull();
      const timerId = dht.republishDataTimer;
      
      await dht.stop();
      
      // Verify timer was cleared
      expect(dht.republishDataTimer).toBeNull();
      expect(activeIntervals.get(timerId)?.cleared).toBe(true);
    });

    test('cleanupTrackingMapsTimer is cleared on stop()', async () => {
      const { KademliaDHT } = await import('../../src/dht/KademliaDHT.js');
      
      const dht = new KademliaDHT({
        republishInterval: 60000,
        expireInterval: 60000,
        pingInterval: 30000
      });
      
      dht.isStarted = true;
      dht.startMaintenanceTasks();
      
      expect(dht.cleanupTrackingMapsTimer).toBeDefined();
      expect(dht.cleanupTrackingMapsTimer).not.toBeNull();
      const timerId = dht.cleanupTrackingMapsTimer;
      
      await dht.stop();
      
      expect(dht.cleanupTrackingMapsTimer).toBeNull();
      expect(activeIntervals.get(timerId)?.cleared).toBe(true);
    });

    test('cleanupTimer is cleared on stop()', async () => {
      const { KademliaDHT } = await import('../../src/dht/KademliaDHT.js');
      
      const dht = new KademliaDHT({
        republishInterval: 60000,
        expireInterval: 60000,
        pingInterval: 30000
      });
      
      dht.isStarted = true;
      dht.startMaintenanceTasks();
      
      expect(dht.cleanupTimer).toBeDefined();
      expect(dht.cleanupTimer).not.toBeNull();
      const timerId = dht.cleanupTimer;
      
      await dht.stop();
      
      expect(dht.cleanupTimer).toBeNull();
      expect(activeIntervals.get(timerId)?.cleared).toBe(true);
    });

    test('routingMaintenanceTimer is cleared on stop()', async () => {
      const { KademliaDHT } = await import('../../src/dht/KademliaDHT.js');
      
      const dht = new KademliaDHT({
        republishInterval: 60000,
        expireInterval: 60000,
        pingInterval: 30000
      });
      
      dht.isStarted = true;
      dht.startMaintenanceTasks();
      
      expect(dht.routingMaintenanceTimer).toBeDefined();
      expect(dht.routingMaintenanceTimer).not.toBeNull();
      const timerId = dht.routingMaintenanceTimer;
      
      await dht.stop();
      
      expect(dht.routingMaintenanceTimer).toBeNull();
      expect(activeIntervals.get(timerId)?.cleared).toBe(true);
    });

    test('staleCleanupTimer is cleared on stop()', async () => {
      const { KademliaDHT } = await import('../../src/dht/KademliaDHT.js');
      
      const dht = new KademliaDHT({
        republishInterval: 60000,
        expireInterval: 60000,
        pingInterval: 30000
      });
      
      dht.isStarted = true;
      dht.startMaintenanceTasks();
      
      expect(dht.staleCleanupTimer).toBeDefined();
      expect(dht.staleCleanupTimer).not.toBeNull();
      const timerId = dht.staleCleanupTimer;
      
      await dht.stop();
      
      expect(dht.staleCleanupTimer).toBeNull();
      expect(activeIntervals.get(timerId)?.cleared).toBe(true);
    });

    test('all 5 maintenance timers are cleared together on stop()', async () => {
      const { KademliaDHT } = await import('../../src/dht/KademliaDHT.js');
      
      const dht = new KademliaDHT({
        republishInterval: 60000,
        expireInterval: 60000,
        pingInterval: 30000
      });
      
      dht.isStarted = true;
      dht.startMaintenanceTasks();
      
      // Collect all timer IDs
      const timerIds = [
        dht.republishDataTimer,
        dht.cleanupTrackingMapsTimer,
        dht.cleanupTimer,
        dht.routingMaintenanceTimer,
        dht.staleCleanupTimer
      ];
      
      // Verify all timers exist
      timerIds.forEach((id, index) => {
        expect(id).toBeDefined();
        expect(id).not.toBeNull();
      });
      
      await dht.stop();
      
      // Verify all timers are null
      expect(dht.republishDataTimer).toBeNull();
      expect(dht.cleanupTrackingMapsTimer).toBeNull();
      expect(dht.cleanupTimer).toBeNull();
      expect(dht.routingMaintenanceTimer).toBeNull();
      expect(dht.staleCleanupTimer).toBeNull();
      
      // Verify all timers were cleared via clearInterval
      timerIds.forEach(id => {
        expect(activeIntervals.get(id)?.cleared).toBe(true);
      });
    });
  });


  /**
   * Test Suite 2: KademliaDHT.stop() clears additional timers
   * 
   * **Validates: Requirement 2.1**
   * 
   * Additional timers that must be cleared:
   * - refreshTimer (from scheduleAdaptiveRefresh)
   * - bootstrapRetryTimer (from setupBootstrapRetry)
   * - pingMaintenanceTimer (from startAdaptivePingMaintenance)
   * - dhtOfferPollingInterval (from startDHTOfferPolling)
   */
  describe('KademliaDHT.stop() clears additional timers', () => {
    
    test('bootstrapRetryTimer is cleared on stop()', async () => {
      const { KademliaDHT } = await import('../../src/dht/KademliaDHT.js');
      
      const dht = new KademliaDHT({
        republishInterval: 60000,
        expireInterval: 60000,
        pingInterval: 30000
      });
      
      dht.isStarted = true;
      
      // Manually set up a bootstrap retry timer
      dht.bootstrapRetryTimer = global.setInterval(() => {}, 10000);
      const timerId = dht.bootstrapRetryTimer;
      
      await dht.stop();
      
      expect(dht.bootstrapRetryTimer).toBeNull();
      expect(activeIntervals.get(timerId)?.cleared).toBe(true);
    });

    test('pingMaintenanceTimer is cleared on stop()', async () => {
      const { KademliaDHT } = await import('../../src/dht/KademliaDHT.js');
      
      const dht = new KademliaDHT({
        republishInterval: 60000,
        expireInterval: 60000,
        pingInterval: 30000
      });
      
      dht.isStarted = true;
      dht.startMaintenanceTasks();
      
      // pingMaintenanceTimer is a setTimeout, not setInterval
      // It's set during startAdaptivePingMaintenance
      if (dht.pingMaintenanceTimer) {
        const timerId = dht.pingMaintenanceTimer;
        
        await dht.stop();
        
        expect(dht.pingMaintenanceTimer).toBeNull();
        expect(activeTimeouts.get(timerId)?.cleared).toBe(true);
      } else {
        // If no timer was set, just verify stop doesn't throw
        await dht.stop();
        expect(dht.pingMaintenanceTimer).toBeNull();
      }
    });

    test('dhtOfferPollingInterval is cleared on stop() via stopDHTOfferPolling()', async () => {
      const { KademliaDHT } = await import('../../src/dht/KademliaDHT.js');
      
      const dht = new KademliaDHT({
        republishInterval: 60000,
        expireInterval: 60000,
        pingInterval: 30000
      });
      
      dht.isStarted = true;
      
      // Manually start DHT offer polling
      dht.startDHTOfferPolling();
      
      expect(dht.dhtOfferPollingInterval).toBeDefined();
      expect(dht.dhtOfferPollingInterval).not.toBeNull();
      const timerId = dht.dhtOfferPollingInterval;
      
      await dht.stop();
      
      expect(dht.dhtOfferPollingInterval).toBeNull();
      expect(activeIntervals.get(timerId)?.cleared).toBe(true);
    });

    test('all additional timers are cleared together on stop()', async () => {
      const { KademliaDHT } = await import('../../src/dht/KademliaDHT.js');
      
      const dht = new KademliaDHT({
        republishInterval: 60000,
        expireInterval: 60000,
        pingInterval: 30000
      });
      
      dht.isStarted = true;
      dht.startMaintenanceTasks();
      
      // Set up additional timers
      dht.bootstrapRetryTimer = global.setInterval(() => {}, 10000);
      dht.startDHTOfferPolling();
      
      const bootstrapTimerId = dht.bootstrapRetryTimer;
      const dhtOfferTimerId = dht.dhtOfferPollingInterval;
      const pingTimerId = dht.pingMaintenanceTimer;
      
      await dht.stop();
      
      // Verify all are null
      expect(dht.bootstrapRetryTimer).toBeNull();
      expect(dht.dhtOfferPollingInterval).toBeNull();
      expect(dht.pingMaintenanceTimer).toBeNull();
      
      // Verify clearInterval/clearTimeout was called
      expect(activeIntervals.get(bootstrapTimerId)?.cleared).toBe(true);
      expect(activeIntervals.get(dhtOfferTimerId)?.cleared).toBe(true);
      if (pingTimerId) {
        expect(activeTimeouts.get(pingTimerId)?.cleared).toBe(true);
      }
    });
  });


  /**
   * Test Suite 3: OverlayNetwork.stop() clears all 3 maintenance timers
   * 
   * **Validates: Requirement 2.2**
   * 
   * The 3 maintenance timers are:
   * 1. keepAliveTimer
   * 2. routingCacheCleanupTimer
   * 3. connectionHealthTimer
   */
  describe('OverlayNetwork.stop() clears all 3 maintenance timers', () => {
    
    const createMockDHT = () => ({
      localNodeId: { toString: () => 'test-node-id' },
      on: jest.fn(),
      off: jest.fn(),
      removeListener: jest.fn(),
      emit: jest.fn()
    });

    test('keepAliveTimer is cleared on stop()', async () => {
      const { OverlayNetwork } = await import('../../src/network/OverlayNetwork.js');
      
      const overlay = new OverlayNetwork(createMockDHT(), {
        keepAliveInterval: 30000
      });
      
      overlay.isStarted = true;
      overlay.startMaintenanceTasks();
      
      expect(overlay.keepAliveTimer).toBeDefined();
      expect(overlay.keepAliveTimer).not.toBeNull();
      const timerId = overlay.keepAliveTimer;
      
      await overlay.stop();
      
      expect(overlay.keepAliveTimer).toBeNull();
      expect(activeIntervals.get(timerId)?.cleared).toBe(true);
    });

    test('routingCacheCleanupTimer is cleared on stop()', async () => {
      const { OverlayNetwork } = await import('../../src/network/OverlayNetwork.js');
      
      const overlay = new OverlayNetwork(createMockDHT(), {
        keepAliveInterval: 30000
      });
      
      overlay.isStarted = true;
      overlay.startMaintenanceTasks();
      
      expect(overlay.routingCacheCleanupTimer).toBeDefined();
      expect(overlay.routingCacheCleanupTimer).not.toBeNull();
      const timerId = overlay.routingCacheCleanupTimer;
      
      await overlay.stop();
      
      expect(overlay.routingCacheCleanupTimer).toBeNull();
      expect(activeIntervals.get(timerId)?.cleared).toBe(true);
    });

    test('connectionHealthTimer is cleared on stop()', async () => {
      const { OverlayNetwork } = await import('../../src/network/OverlayNetwork.js');
      
      const overlay = new OverlayNetwork(createMockDHT(), {
        keepAliveInterval: 30000
      });
      
      overlay.isStarted = true;
      overlay.startMaintenanceTasks();
      
      expect(overlay.connectionHealthTimer).toBeDefined();
      expect(overlay.connectionHealthTimer).not.toBeNull();
      const timerId = overlay.connectionHealthTimer;
      
      await overlay.stop();
      
      expect(overlay.connectionHealthTimer).toBeNull();
      expect(activeIntervals.get(timerId)?.cleared).toBe(true);
    });

    test('all 3 maintenance timers are cleared together on stop()', async () => {
      const { OverlayNetwork } = await import('../../src/network/OverlayNetwork.js');
      
      const overlay = new OverlayNetwork(createMockDHT(), {
        keepAliveInterval: 30000
      });
      
      overlay.isStarted = true;
      overlay.startMaintenanceTasks();
      
      // Collect all timer IDs
      const timerIds = [
        overlay.keepAliveTimer,
        overlay.routingCacheCleanupTimer,
        overlay.connectionHealthTimer
      ];
      
      // Verify all timers exist
      timerIds.forEach(id => {
        expect(id).toBeDefined();
        expect(id).not.toBeNull();
      });
      
      await overlay.stop();
      
      // Verify all timers are null
      expect(overlay.keepAliveTimer).toBeNull();
      expect(overlay.routingCacheCleanupTimer).toBeNull();
      expect(overlay.connectionHealthTimer).toBeNull();
      
      // Verify all timers were cleared via clearInterval
      timerIds.forEach(id => {
        expect(activeIntervals.get(id)?.cleared).toBe(true);
      });
    });
  });


  /**
   * Test Suite 4: pendingRequests entries are removed on timeout
   * 
   * **Validates: Requirement 2.4**
   * 
   * cleanupTrackingMaps() should remove pendingRequests entries
   * that have exceeded requestTimeout * 2
   */
  describe('pendingRequests entries are removed on timeout', () => {
    
    test('timed-out pendingRequests entries are removed by cleanupTrackingMaps()', async () => {
      // Restore real timers for this test
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
      
      const { KademliaDHT } = await import('../../src/dht/KademliaDHT.js');
      
      const requestTimeout = 5000; // 5 seconds
      const dht = new KademliaDHT({
        requestTimeout: requestTimeout
      });
      
      const now = Date.now();
      
      // Add a timed-out request (older than requestTimeout * 2)
      const timedOutRequestId = 'timed-out-request-1';
      dht.pendingRequests.set(timedOutRequestId, {
        timestamp: now - (requestTimeout * 3), // 15 seconds ago (> 10 seconds threshold)
        resolve: () => {},
        reject: () => {},
        type: 'FIND_NODE'
      });
      
      // Add a fresh request (within timeout)
      const freshRequestId = 'fresh-request-1';
      dht.pendingRequests.set(freshRequestId, {
        timestamp: now - 1000, // 1 second ago
        resolve: () => {},
        reject: () => {},
        type: 'FIND_NODE'
      });
      
      expect(dht.pendingRequests.size).toBe(2);
      
      // Run cleanup
      dht.cleanupTrackingMaps();
      
      // Timed-out request should be removed
      expect(dht.pendingRequests.has(timedOutRequestId)).toBe(false);
      // Fresh request should remain
      expect(dht.pendingRequests.has(freshRequestId)).toBe(true);
      expect(dht.pendingRequests.size).toBe(1);
    });

    test('multiple timed-out pendingRequests entries are all removed', async () => {
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
      
      const { KademliaDHT } = await import('../../src/dht/KademliaDHT.js');
      
      const requestTimeout = 5000;
      const dht = new KademliaDHT({
        requestTimeout: requestTimeout
      });
      
      const now = Date.now();
      
      // Add multiple timed-out requests
      for (let i = 0; i < 5; i++) {
        dht.pendingRequests.set(`timed-out-${i}`, {
          timestamp: now - (requestTimeout * 3),
          resolve: () => {},
          reject: () => {},
          type: 'FIND_NODE'
        });
      }
      
      // Add multiple fresh requests
      for (let i = 0; i < 3; i++) {
        dht.pendingRequests.set(`fresh-${i}`, {
          timestamp: now - 1000,
          resolve: () => {},
          reject: () => {},
          type: 'FIND_NODE'
        });
      }
      
      expect(dht.pendingRequests.size).toBe(8);
      
      dht.cleanupTrackingMaps();
      
      // Only fresh requests should remain
      expect(dht.pendingRequests.size).toBe(3);
      for (let i = 0; i < 5; i++) {
        expect(dht.pendingRequests.has(`timed-out-${i}`)).toBe(false);
      }
      for (let i = 0; i < 3; i++) {
        expect(dht.pendingRequests.has(`fresh-${i}`)).toBe(true);
      }
    });

    test('pendingRequests at exactly the timeout threshold are preserved', async () => {
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
      
      const { KademliaDHT } = await import('../../src/dht/KademliaDHT.js');
      
      const requestTimeout = 5000;
      const dht = new KademliaDHT({
        requestTimeout: requestTimeout
      });
      
      const now = Date.now();
      
      // Add a request at exactly the threshold (should be preserved)
      const thresholdRequestId = 'threshold-request';
      dht.pendingRequests.set(thresholdRequestId, {
        timestamp: now - (requestTimeout * 2), // Exactly at threshold
        resolve: () => {},
        reject: () => {},
        type: 'FIND_NODE'
      });
      
      // Add a request just over the threshold (should be removed)
      const overThresholdRequestId = 'over-threshold-request';
      dht.pendingRequests.set(overThresholdRequestId, {
        timestamp: now - (requestTimeout * 2) - 1, // 1ms over threshold
        resolve: () => {},
        reject: () => {},
        type: 'FIND_NODE'
      });
      
      dht.cleanupTrackingMaps();
      
      // Request at threshold should be preserved (> not >=)
      expect(dht.pendingRequests.has(thresholdRequestId)).toBe(true);
      // Request over threshold should be removed
      expect(dht.pendingRequests.has(overThresholdRequestId)).toBe(false);
    });
  });


  /**
   * Test Suite 5: cleanupTrackingMaps() removes orphaned entries from all Maps
   * 
   * **Validates: Requirement 2.5**
   * 
   * Maps that should be cleaned:
   * - findNodeRateLimit (entries older than 10 minutes)
   * - processedMessages (entries older than deduplication timeout)
   * - peerFailureBackoff (expired backoff entries)
   * - failedPeerQueries (stale entries without corresponding backoff)
   * - unsolicitedResponseCounts (entries for disconnected peers)
   * - peerNodes (orphaned entries not in routing table or connected)
   */
  describe('cleanupTrackingMaps() removes orphaned entries from all Maps', () => {
    
    test('stale findNodeRateLimit entries are removed', async () => {
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
      
      const { KademliaDHT } = await import('../../src/dht/KademliaDHT.js');
      
      const dht = new KademliaDHT({
        requestTimeout: 5000
      });
      
      const now = Date.now();
      const elevenMinutesAgo = now - (11 * 60 * 1000);
      const twoMinutesAgo = now - (2 * 60 * 1000);
      
      // Add stale entry (older than 10 minutes)
      dht.findNodeRateLimit.set('stale-peer', elevenMinutesAgo);
      // Add fresh entry
      dht.findNodeRateLimit.set('fresh-peer', twoMinutesAgo);
      
      expect(dht.findNodeRateLimit.size).toBe(2);
      
      dht.cleanupTrackingMaps();
      
      expect(dht.findNodeRateLimit.has('stale-peer')).toBe(false);
      expect(dht.findNodeRateLimit.has('fresh-peer')).toBe(true);
      expect(dht.findNodeRateLimit.size).toBe(1);
    });

    test('stale processedMessages entries are removed', async () => {
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
      
      const { KademliaDHT } = await import('../../src/dht/KademliaDHT.js');
      
      const dht = new KademliaDHT({
        requestTimeout: 5000
      });
      
      const now = Date.now();
      // Default deduplication timeout is typically 5 minutes
      const deduplicationTimeout = dht.messageDeduplicationTimeout || (5 * 60 * 1000);
      const staleTimestamp = now - deduplicationTimeout - 1000;
      const freshTimestamp = now - 1000;
      
      // Add stale entry
      dht.processedMessages.set('stale-message', staleTimestamp);
      // Add fresh entry
      dht.processedMessages.set('fresh-message', freshTimestamp);
      
      expect(dht.processedMessages.size).toBe(2);
      
      dht.cleanupTrackingMaps();
      
      expect(dht.processedMessages.has('stale-message')).toBe(false);
      expect(dht.processedMessages.has('fresh-message')).toBe(true);
      expect(dht.processedMessages.size).toBe(1);
    });

    test('expired peerFailureBackoff entries are removed', async () => {
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
      
      const { KademliaDHT } = await import('../../src/dht/KademliaDHT.js');
      
      const dht = new KademliaDHT({
        requestTimeout: 5000
      });
      
      const now = Date.now();
      
      // Add expired backoff (backoff time has passed)
      dht.peerFailureBackoff.set('expired-peer', now - 1000);
      // Add active backoff (still in backoff period)
      dht.peerFailureBackoff.set('active-peer', now + 60000);
      
      expect(dht.peerFailureBackoff.size).toBe(2);
      
      dht.cleanupTrackingMaps();
      
      expect(dht.peerFailureBackoff.has('expired-peer')).toBe(false);
      expect(dht.peerFailureBackoff.has('active-peer')).toBe(true);
      expect(dht.peerFailureBackoff.size).toBe(1);
    });

    test('stale failedPeerQueries entries are removed', async () => {
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
      
      const { KademliaDHT } = await import('../../src/dht/KademliaDHT.js');
      
      const dht = new KademliaDHT({
        requestTimeout: 5000
      });
      
      // Initialize failedPeerQueries if not present
      if (!dht.failedPeerQueries) {
        dht.failedPeerQueries = new Map();
      }
      
      const now = Date.now();
      const elevenMinutesAgo = now - (11 * 60 * 1000);
      
      // Add orphaned failedPeerQueries entry (no corresponding backoff)
      dht.failedPeerQueries.set('orphaned-peer', 3);
      
      // Add failedPeerQueries entry with stale backoff
      dht.failedPeerQueries.set('stale-peer', 2);
      dht.peerFailureBackoff.set('stale-peer', elevenMinutesAgo);
      
      // Add failedPeerQueries entry with fresh backoff
      dht.failedPeerQueries.set('fresh-peer', 1);
      dht.peerFailureBackoff.set('fresh-peer', now + 60000);
      
      expect(dht.failedPeerQueries.size).toBe(3);
      
      dht.cleanupTrackingMaps();
      
      // Orphaned and stale entries should be removed
      expect(dht.failedPeerQueries.has('orphaned-peer')).toBe(false);
      expect(dht.failedPeerQueries.has('stale-peer')).toBe(false);
      // Fresh entry should remain
      expect(dht.failedPeerQueries.has('fresh-peer')).toBe(true);
    });

    test('unsolicitedResponseCounts for disconnected peers are removed', async () => {
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
      
      const { KademliaDHT } = await import('../../src/dht/KademliaDHT.js');
      
      const dht = new KademliaDHT({
        requestTimeout: 5000
      });
      
      // Initialize unsolicitedResponseCounts if not present
      if (!dht.unsolicitedResponseCounts) {
        dht.unsolicitedResponseCounts = new Map();
      }
      
      // Mock getConnectedPeers to return only one peer
      dht.getConnectedPeers = () => ['connected-peer'];
      
      // Add entry for connected peer
      dht.unsolicitedResponseCounts.set('connected-peer', 5);
      // Add entry for disconnected peer
      dht.unsolicitedResponseCounts.set('disconnected-peer', 3);
      
      expect(dht.unsolicitedResponseCounts.size).toBe(2);
      
      dht.cleanupTrackingMaps();
      
      // Connected peer entry should remain
      expect(dht.unsolicitedResponseCounts.has('connected-peer')).toBe(true);
      // Disconnected peer entry should be removed
      expect(dht.unsolicitedResponseCounts.has('disconnected-peer')).toBe(false);
      expect(dht.unsolicitedResponseCounts.size).toBe(1);
    });

    test('orphaned peerNodes entries are cleaned up', async () => {
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
      
      const { KademliaDHT } = await import('../../src/dht/KademliaDHT.js');
      
      const dht = new KademliaDHT({
        requestTimeout: 5000
      });
      
      // Initialize peerNodes if not present
      if (!dht.peerNodes) {
        dht.peerNodes = new Map();
      }
      
      // Mock routing table to return only one peer
      dht.routingTable.getAllNodes = () => [{ id: { toString: () => 'routing-table-peer' } }];
      // Mock getConnectedPeers to return only one peer
      dht.getConnectedPeers = () => ['connected-peer'];
      
      // Add peer in routing table
      dht.peerNodes.set('routing-table-peer', {
        id: 'routing-table-peer',
        connectionManager: { destroy: jest.fn() }
      });
      
      // Add connected peer
      dht.peerNodes.set('connected-peer', {
        id: 'connected-peer',
        connectionManager: { destroy: jest.fn() }
      });
      
      // Add orphaned peer (not in routing table, not connected)
      const orphanedConnectionManager = { destroy: jest.fn() };
      dht.peerNodes.set('orphaned-peer', {
        id: 'orphaned-peer',
        connectionManager: orphanedConnectionManager
      });
      
      expect(dht.peerNodes.size).toBe(3);
      
      dht.cleanupTrackingMaps();
      
      // Routing table peer should remain
      expect(dht.peerNodes.has('routing-table-peer')).toBe(true);
      // Connected peer should remain
      expect(dht.peerNodes.has('connected-peer')).toBe(true);
      // Orphaned peer should be removed
      expect(dht.peerNodes.has('orphaned-peer')).toBe(false);
      // Orphaned peer's connection manager should be destroyed
      expect(orphanedConnectionManager.destroy).toHaveBeenCalled();
    });

    test('all Maps are cleaned in a single cleanupTrackingMaps() call', async () => {
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
      
      const { KademliaDHT } = await import('../../src/dht/KademliaDHT.js');
      
      const dht = new KademliaDHT({
        requestTimeout: 5000
      });
      
      const now = Date.now();
      const elevenMinutesAgo = now - (11 * 60 * 1000);
      
      // Initialize Maps
      if (!dht.failedPeerQueries) dht.failedPeerQueries = new Map();
      if (!dht.unsolicitedResponseCounts) dht.unsolicitedResponseCounts = new Map();
      if (!dht.peerNodes) dht.peerNodes = new Map();
      
      // Add stale entries to all Maps
      dht.findNodeRateLimit.set('stale', elevenMinutesAgo);
      dht.processedMessages.set('stale', elevenMinutesAgo);
      dht.peerFailureBackoff.set('stale', now - 1000);
      dht.failedPeerQueries.set('stale', 1);
      dht.pendingRequests.set('stale', { timestamp: now - 30000, resolve: () => {}, reject: () => {} });
      
      // Mock for peerNodes and unsolicitedResponseCounts
      dht.getConnectedPeers = () => [];
      dht.routingTable.getAllNodes = () => [];
      dht.unsolicitedResponseCounts.set('stale', 1);
      dht.peerNodes.set('stale', { connectionManager: { destroy: jest.fn() } });
      
      // Run cleanup
      dht.cleanupTrackingMaps();
      
      // All stale entries should be removed
      expect(dht.findNodeRateLimit.has('stale')).toBe(false);
      expect(dht.processedMessages.has('stale')).toBe(false);
      expect(dht.peerFailureBackoff.has('stale')).toBe(false);
      expect(dht.failedPeerQueries.has('stale')).toBe(false);
      expect(dht.unsolicitedResponseCounts.has('stale')).toBe(false);
      expect(dht.peerNodes.has('stale')).toBe(false);
      expect(dht.pendingRequests.has('stale')).toBe(false);
    });
  });
});
