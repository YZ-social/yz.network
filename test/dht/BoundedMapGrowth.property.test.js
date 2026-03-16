import * as fc from 'fast-check';
import { jest } from '@jest/globals';

/**
 * Property-Based Tests: Bounded Map Growth
 * 
 * **Validates: Requirements 2.3, 2.4, 2.5**
 * 
 * These tests verify that:
 * - pendingRequests size stays bounded under random request/timeout patterns (2.4)
 * - Routing table stays clean under random peer connect/disconnect patterns (2.5)
 * - No timer leaks occur under random sequences of start/stop operations (2.3)
 * 
 * Property-based testing generates many random test cases to catch edge cases
 * that manual unit tests might miss.
 */

describe('Property-Based Tests: Bounded Map Growth', () => {
  
  // Track timer calls for timer leak tests
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

  afterAll(() => {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  });

  /**
   * Property 3: Bug Condition - Bounded pendingRequests Growth
   * 
   * For any sequence of request additions and cleanup cycles,
   * the pendingRequests Map size should stay bounded.
   * 
   * **Validates: Requirements 2.4**
   */
  describe('Property 3: Bounded pendingRequests Growth', () => {
    
    test('pendingRequests size stays bounded under random request/timeout patterns', async () => {
      const { KademliaDHT } = await import('../../src/dht/KademliaDHT.js');
      
      await fc.assert(
        fc.asyncProperty(
          // Generate a sequence of operations
          fc.array(
            fc.record({
              operation: fc.constantFrom('addRequest', 'addTimedOutRequest', 'cleanup'),
              requestId: fc.uuid(),
              // Age in milliseconds - some fresh, some timed out
              ageMs: fc.oneof(
                fc.integer({ min: 0, max: 5000 }),      // Fresh requests
                fc.integer({ min: 20000, max: 60000 }) // Timed out requests
              )
            }),
            { minLength: 10, maxLength: 100 }
          ),
          async (operations) => {
            const requestTimeout = 5000; // 5 seconds
            const dht = new KademliaDHT({ requestTimeout });
            
            const now = Date.now();
            let maxSize = 0;
            
            for (const op of operations) {
              if (op.operation === 'addRequest' || op.operation === 'addTimedOutRequest') {
                // Add a request with the specified age
                dht.pendingRequests.set(op.requestId, {
                  timestamp: now - op.ageMs,
                  resolve: () => {},
                  reject: () => {},
                  type: 'FIND_NODE'
                });
              } else if (op.operation === 'cleanup') {
                // Run cleanup
                dht.cleanupTrackingMaps();
              }
              
              maxSize = Math.max(maxSize, dht.pendingRequests.size);
            }
            
            // Final cleanup
            dht.cleanupTrackingMaps();
            
            // After cleanup, only fresh requests should remain
            // Fresh = timestamp within requestTimeout * 2 of now
            const threshold = requestTimeout * 2;
            for (const [requestId, request] of dht.pendingRequests.entries()) {
              const age = now - request.timestamp;
              if (age > threshold) {
                // Found a timed-out request that wasn't cleaned up
                return false;
              }
            }
            
            // Property: After cleanup, no timed-out requests remain
            return true;
          }
        ),
        { numRuns: 50, timeout: 30000 }
      );
    });

    test('pendingRequests cleanup removes all entries older than threshold', async () => {
      const { KademliaDHT } = await import('../../src/dht/KademliaDHT.js');
      
      await fc.assert(
        fc.asyncProperty(
          // Generate counts of fresh and stale requests
          fc.record({
            freshCount: fc.integer({ min: 0, max: 50 }),
            staleCount: fc.integer({ min: 0, max: 50 })
          }),
          async ({ freshCount, staleCount }) => {
            const requestTimeout = 5000;
            const dht = new KademliaDHT({ requestTimeout });
            
            const now = Date.now();
            const threshold = requestTimeout * 2;
            
            // Add fresh requests (within threshold)
            for (let i = 0; i < freshCount; i++) {
              dht.pendingRequests.set(`fresh-${i}`, {
                timestamp: now - Math.floor(Math.random() * threshold),
                resolve: () => {},
                reject: () => {},
                type: 'FIND_NODE'
              });
            }
            
            // Add stale requests (beyond threshold)
            for (let i = 0; i < staleCount; i++) {
              dht.pendingRequests.set(`stale-${i}`, {
                timestamp: now - threshold - 1000 - Math.floor(Math.random() * 10000),
                resolve: () => {},
                reject: () => {},
                type: 'FIND_NODE'
              });
            }
            
            const sizeBefore = dht.pendingRequests.size;
            expect(sizeBefore).toBe(freshCount + staleCount);
            
            // Run cleanup
            dht.cleanupTrackingMaps();
            
            // Property: After cleanup, size should equal freshCount
            // (all stale entries removed, all fresh entries preserved)
            return dht.pendingRequests.size === freshCount;
          }
        ),
        { numRuns: 50, timeout: 30000 }
      );
    });
  });

  /**
   * Property 4: Bounded failedPeerQueries Growth
   * 
   * For any sequence of peer failures and cleanup cycles,
   * the failedPeerQueries Map size should stay bounded.
   * 
   * **Validates: Requirements 2.5**
   */
  describe('Property 4: Bounded failedPeerQueries Growth', () => {
    
    test('failedPeerQueries size stays bounded under random failure patterns', async () => {
      const { KademliaDHT } = await import('../../src/dht/KademliaDHT.js');
      
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              operation: fc.constantFrom('addFailure', 'addStaleFailure', 'cleanup'),
              peerId: fc.uuid(),
              // Backoff time - some active, some expired
              backoffMs: fc.oneof(
                fc.integer({ min: 60000, max: 300000 }),  // Active backoff (future)
                fc.integer({ min: -600000, max: -1000 })  // Expired backoff (past)
              )
            }),
            { minLength: 10, maxLength: 100 }
          ),
          async (operations) => {
            const dht = new KademliaDHT({ requestTimeout: 5000 });
            
            // Initialize failedPeerQueries if not present
            if (!dht.failedPeerQueries) {
              dht.failedPeerQueries = new Map();
            }
            
            const now = Date.now();
            
            for (const op of operations) {
              if (op.operation === 'addFailure' || op.operation === 'addStaleFailure') {
                // Add a failure entry with corresponding backoff
                dht.failedPeerQueries.set(op.peerId, 1);
                dht.peerFailureBackoff.set(op.peerId, now + op.backoffMs);
              } else if (op.operation === 'cleanup') {
                dht.cleanupTrackingMaps();
              }
            }
            
            // Final cleanup
            dht.cleanupTrackingMaps();
            
            // After cleanup, only entries with active backoffs should remain
            for (const [peerId] of dht.failedPeerQueries.entries()) {
              const backoff = dht.peerFailureBackoff.get(peerId);
              // Entry should have a valid, non-expired backoff
              if (!backoff || backoff < now) {
                return false;
              }
            }
            
            return true;
          }
        ),
        { numRuns: 50, timeout: 30000 }
      );
    });
  });

  /**
   * Property 5: Bounded findNodeRateLimit Growth
   * 
   * For any sequence of rate limit entries and cleanup cycles,
   * the findNodeRateLimit Map size should stay bounded.
   * 
   * **Validates: Requirements 2.5**
   */
  describe('Property 5: Bounded findNodeRateLimit Growth', () => {
    
    test('findNodeRateLimit size stays bounded under random access patterns', async () => {
      const { KademliaDHT } = await import('../../src/dht/KademliaDHT.js');
      
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              operation: fc.constantFrom('addEntry', 'addStaleEntry', 'cleanup'),
              peerId: fc.uuid(),
              // Age - some fresh, some stale (older than 10 minutes)
              ageMs: fc.oneof(
                fc.integer({ min: 0, max: 300000 }),      // Fresh (< 10 min)
                fc.integer({ min: 660000, max: 1200000 }) // Stale (> 10 min)
              )
            }),
            { minLength: 10, maxLength: 100 }
          ),
          async (operations) => {
            const dht = new KademliaDHT({ requestTimeout: 5000 });
            
            const now = Date.now();
            const tenMinutes = 10 * 60 * 1000;
            
            for (const op of operations) {
              if (op.operation === 'addEntry' || op.operation === 'addStaleEntry') {
                dht.findNodeRateLimit.set(op.peerId, now - op.ageMs);
              } else if (op.operation === 'cleanup') {
                dht.cleanupTrackingMaps();
              }
            }
            
            // Final cleanup
            dht.cleanupTrackingMaps();
            
            // After cleanup, only entries younger than 10 minutes should remain
            for (const [peerId, timestamp] of dht.findNodeRateLimit.entries()) {
              if (timestamp < now - tenMinutes) {
                return false;
              }
            }
            
            return true;
          }
        ),
        { numRuns: 50, timeout: 30000 }
      );
    });
  });


  /**
   * Property 6: Bounded processedMessages Growth
   * 
   * For any sequence of message processing and cleanup cycles,
   * the processedMessages Map size should stay bounded.
   * 
   * **Validates: Requirements 2.5**
   */
  describe('Property 6: Bounded processedMessages Growth', () => {
    
    test('processedMessages size stays bounded under random message patterns', async () => {
      const { KademliaDHT } = await import('../../src/dht/KademliaDHT.js');
      
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              operation: fc.constantFrom('addMessage', 'addStaleMessage', 'cleanup'),
              messageId: fc.uuid(),
              // Age - some fresh, some stale (older than deduplication timeout)
              ageMs: fc.oneof(
                fc.integer({ min: 0, max: 200000 }),      // Fresh
                fc.integer({ min: 400000, max: 600000 })  // Stale (> 5 min default)
              )
            }),
            { minLength: 10, maxLength: 100 }
          ),
          async (operations) => {
            const dht = new KademliaDHT({ requestTimeout: 5000 });
            
            const now = Date.now();
            const deduplicationTimeout = dht.messageDeduplicationTimeout || (5 * 60 * 1000);
            
            for (const op of operations) {
              if (op.operation === 'addMessage' || op.operation === 'addStaleMessage') {
                dht.processedMessages.set(op.messageId, now - op.ageMs);
              } else if (op.operation === 'cleanup') {
                dht.cleanupTrackingMaps();
              }
            }
            
            // Final cleanup
            dht.cleanupTrackingMaps();
            
            // After cleanup, only entries within deduplication timeout should remain
            for (const [messageId, timestamp] of dht.processedMessages.entries()) {
              if (timestamp < now - deduplicationTimeout) {
                return false;
              }
            }
            
            return true;
          }
        ),
        { numRuns: 50, timeout: 30000 }
      );
    });
  });

  /**
   * Property 7: No Timer Leaks Under Start/Stop Sequences
   * 
   * For any sequence of start/stop operations,
   * all timers should be properly cleared after stop().
   * 
   * **Validates: Requirements 2.3**
   */
  describe('Property 7: No Timer Leaks Under Start/Stop Sequences', () => {
    
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

    test('KademliaDHT: all timers cleared after any start/stop sequence', async () => {
      const { KademliaDHT } = await import('../../src/dht/KademliaDHT.js');
      
      await fc.assert(
        fc.asyncProperty(
          // Generate number of start/stop cycles
          fc.integer({ min: 1, max: 5 }),
          async (cycles) => {
            for (let i = 0; i < cycles; i++) {
              // Reset tracking for this cycle
              activeIntervals.clear();
              activeTimeouts.clear();
              
              const dht = new KademliaDHT({
                republishInterval: 60000,
                expireInterval: 60000,
                pingInterval: 30000,
                requestTimeout: 5000
              });
              
              // Start maintenance tasks
              dht.isStarted = true;
              dht.startMaintenanceTasks();
              
              // Optionally start DHT offer polling
              if (Math.random() > 0.5) {
                dht.startDHTOfferPolling();
              }
              
              // Record all interval timers created
              const intervalsBeforeStop = new Set(activeIntervals.keys());
              
              // Stop the DHT
              try {
                await dht.stop();
              } catch (e) {
                // Ignore errors during stop
              }
              
              // Verify all interval timers were cleared
              for (const timerId of intervalsBeforeStop) {
                const timer = activeIntervals.get(timerId);
                if (timer && !timer.cleared) {
                  console.log(`Timer leak detected: interval ${timerId} not cleared`);
                  return false;
                }
              }
            }
            
            return true;
          }
        ),
        { numRuns: 20, timeout: 30000 }
      );
    });

    test('OverlayNetwork: all timers cleared after any start/stop sequence', async () => {
      const mockDHT = {
        localNodeId: { toString: () => 'test-node-id' },
        on: jest.fn(),
        off: jest.fn(),
        removeListener: jest.fn(),
        emit: jest.fn()
      };
      
      const { OverlayNetwork } = await import('../../src/network/OverlayNetwork.js');
      
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }),
          async (cycles) => {
            for (let i = 0; i < cycles; i++) {
              activeIntervals.clear();
              activeTimeouts.clear();
              
              const overlay = new OverlayNetwork(mockDHT, {
                keepAliveInterval: 30000
              });
              
              overlay.isStarted = true;
              overlay.startMaintenanceTasks();
              
              const intervalsBeforeStop = new Set(activeIntervals.keys());
              
              try {
                await overlay.stop();
              } catch (e) {
                // Ignore errors
              }
              
              for (const timerId of intervalsBeforeStop) {
                const timer = activeIntervals.get(timerId);
                if (timer && !timer.cleared) {
                  console.log(`Timer leak detected: interval ${timerId} not cleared`);
                  return false;
                }
              }
            }
            
            return true;
          }
        ),
        { numRuns: 20, timeout: 30000 }
      );
    });

    test('Multiple rapid start/stop cycles do not accumulate timer leaks', async () => {
      const { KademliaDHT } = await import('../../src/dht/KademliaDHT.js');
      
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 3, max: 10 }),
          async (cycles) => {
            // Track total timers across all cycles
            let totalTimersCreated = 0;
            let totalTimersCleared = 0;
            
            for (let i = 0; i < cycles; i++) {
              activeIntervals.clear();
              
              const dht = new KademliaDHT({
                republishInterval: 60000,
                expireInterval: 60000,
                pingInterval: 30000
              });
              
              dht.isStarted = true;
              dht.startMaintenanceTasks();
              
              totalTimersCreated += activeIntervals.size;
              
              try {
                await dht.stop();
              } catch (e) {
                // Ignore
              }
              
              // Count cleared timers
              for (const timer of activeIntervals.values()) {
                if (timer.cleared) {
                  totalTimersCleared++;
                }
              }
            }
            
            // Property: All timers created should be cleared
            return totalTimersCreated === totalTimersCleared;
          }
        ),
        { numRuns: 10, timeout: 30000 }
      );
    });
  });

  /**
   * Property 8: Routing Table Stays Clean Under Peer Churn
   * 
   * For any sequence of peer connect/disconnect events,
   * the routing table should not accumulate stale entries.
   * 
   * **Validates: Requirements 2.5, 2.8**
   */
  describe('Property 8: Routing Table Stays Clean Under Peer Churn', () => {
    
    beforeEach(() => {
      // Restore real timers for these tests
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    });

    test('peerNodes Map stays bounded under random connect/disconnect patterns', async () => {
      const { KademliaDHT } = await import('../../src/dht/KademliaDHT.js');
      
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              operation: fc.constantFrom('connect', 'disconnect', 'cleanup'),
              peerId: fc.uuid()
            }),
            { minLength: 10, maxLength: 50 }
          ),
          async (operations) => {
            const dht = new KademliaDHT({ requestTimeout: 5000 });
            
            if (!dht.peerNodes) {
              dht.peerNodes = new Map();
            }
            
            // Track which peers are "connected"
            const connectedPeers = new Set();
            
            // Mock getConnectedPeers to return our tracked set
            dht.getConnectedPeers = () => Array.from(connectedPeers);
            
            // Mock routing table to return empty (no peers in routing table)
            dht.routingTable.getAllNodes = () => [];
            
            for (const op of operations) {
              if (op.operation === 'connect') {
                connectedPeers.add(op.peerId);
                dht.peerNodes.set(op.peerId, {
                  id: op.peerId,
                  connectionManager: { destroy: jest.fn() }
                });
              } else if (op.operation === 'disconnect') {
                connectedPeers.delete(op.peerId);
                // Note: We don't remove from peerNodes here - that's what cleanup should do
              } else if (op.operation === 'cleanup') {
                dht.cleanupTrackingMaps();
              }
            }
            
            // Final cleanup
            dht.cleanupTrackingMaps();
            
            // Property: After cleanup, peerNodes should only contain connected peers
            for (const peerId of dht.peerNodes.keys()) {
              if (!connectedPeers.has(peerId)) {
                return false;
              }
            }
            
            return true;
          }
        ),
        { numRuns: 30, timeout: 30000 }
      );
    });

    test('unsolicitedResponseCounts stays bounded under peer churn', async () => {
      const { KademliaDHT } = await import('../../src/dht/KademliaDHT.js');
      
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              operation: fc.constantFrom('addResponse', 'disconnect', 'cleanup'),
              peerId: fc.uuid()
            }),
            { minLength: 10, maxLength: 50 }
          ),
          async (operations) => {
            const dht = new KademliaDHT({ requestTimeout: 5000 });
            
            if (!dht.unsolicitedResponseCounts) {
              dht.unsolicitedResponseCounts = new Map();
            }
            
            const connectedPeers = new Set();
            dht.getConnectedPeers = () => Array.from(connectedPeers);
            
            for (const op of operations) {
              if (op.operation === 'addResponse') {
                connectedPeers.add(op.peerId);
                const count = dht.unsolicitedResponseCounts.get(op.peerId) || 0;
                dht.unsolicitedResponseCounts.set(op.peerId, count + 1);
              } else if (op.operation === 'disconnect') {
                connectedPeers.delete(op.peerId);
              } else if (op.operation === 'cleanup') {
                dht.cleanupTrackingMaps();
              }
            }
            
            // Final cleanup
            dht.cleanupTrackingMaps();
            
            // Property: After cleanup, only connected peers should have entries
            for (const peerId of dht.unsolicitedResponseCounts.keys()) {
              if (!connectedPeers.has(peerId)) {
                return false;
              }
            }
            
            return true;
          }
        ),
        { numRuns: 30, timeout: 30000 }
      );
    });
  });

  /**
   * Property 9: Combined Map Cleanup Invariant
   * 
   * For any sequence of mixed operations across all Maps,
   * running cleanupTrackingMaps() should always result in bounded sizes.
   * 
   * **Validates: Requirements 2.3, 2.4, 2.5**
   */
  describe('Property 9: Combined Map Cleanup Invariant', () => {
    
    beforeEach(() => {
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    });

    test('all Maps stay bounded under mixed operation sequences', async () => {
      const { KademliaDHT } = await import('../../src/dht/KademliaDHT.js');
      
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              mapType: fc.constantFrom(
                'pendingRequests',
                'findNodeRateLimit',
                'processedMessages',
                'peerFailureBackoff',
                'failedPeerQueries'
              ),
              operation: fc.constantFrom('addFresh', 'addStale', 'cleanup'),
              key: fc.uuid()
            }),
            { minLength: 20, maxLength: 100 }
          ),
          async (operations) => {
            const dht = new KademliaDHT({ requestTimeout: 5000 });
            
            if (!dht.failedPeerQueries) {
              dht.failedPeerQueries = new Map();
            }
            
            const now = Date.now();
            const tenMinutesAgo = now - (10 * 60 * 1000);
            const requestTimeout = dht.options.requestTimeout || 10000;
            
            for (const op of operations) {
              if (op.operation === 'cleanup') {
                dht.cleanupTrackingMaps();
                continue;
              }
              
              const isFresh = op.operation === 'addFresh';
              
              switch (op.mapType) {
                case 'pendingRequests':
                  dht.pendingRequests.set(op.key, {
                    timestamp: isFresh ? now - 1000 : now - (requestTimeout * 3),
                    resolve: () => {},
                    reject: () => {},
                    type: 'FIND_NODE'
                  });
                  break;
                  
                case 'findNodeRateLimit':
                  dht.findNodeRateLimit.set(op.key, isFresh ? now - 60000 : tenMinutesAgo - 60000);
                  break;
                  
                case 'processedMessages':
                  const dedup = dht.messageDeduplicationTimeout || (5 * 60 * 1000);
                  dht.processedMessages.set(op.key, isFresh ? now - 60000 : now - dedup - 60000);
                  break;
                  
                case 'peerFailureBackoff':
                  dht.peerFailureBackoff.set(op.key, isFresh ? now + 60000 : now - 60000);
                  break;
                  
                case 'failedPeerQueries':
                  dht.failedPeerQueries.set(op.key, 1);
                  // Also add corresponding backoff
                  dht.peerFailureBackoff.set(op.key, isFresh ? now + 60000 : tenMinutesAgo - 60000);
                  break;
              }
            }
            
            // Run multiple cleanup cycles
            for (let i = 0; i < 3; i++) {
              dht.cleanupTrackingMaps();
            }
            
            // Verify no stale entries remain in any Map
            
            // Check pendingRequests
            for (const [, request] of dht.pendingRequests.entries()) {
              if (now - request.timestamp > requestTimeout * 2) {
                return false;
              }
            }
            
            // Check findNodeRateLimit
            for (const [, timestamp] of dht.findNodeRateLimit.entries()) {
              if (timestamp < tenMinutesAgo) {
                return false;
              }
            }
            
            // Check processedMessages
            const deduplicationTimeout = dht.messageDeduplicationTimeout || (5 * 60 * 1000);
            for (const [, timestamp] of dht.processedMessages.entries()) {
              if (timestamp < now - deduplicationTimeout) {
                return false;
              }
            }
            
            // Check peerFailureBackoff
            for (const [, backoffUntil] of dht.peerFailureBackoff.entries()) {
              if (now > backoffUntil) {
                return false;
              }
            }
            
            // Check failedPeerQueries - should only have entries with valid backoffs
            for (const [peerId] of dht.failedPeerQueries.entries()) {
              const backoff = dht.peerFailureBackoff.get(peerId);
              if (!backoff || backoff < tenMinutesAgo) {
                return false;
              }
            }
            
            return true;
          }
        ),
        { numRuns: 30, timeout: 60000 }
      );
    });
  });
});
