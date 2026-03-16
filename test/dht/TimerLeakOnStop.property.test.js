import * as fc from 'fast-check';
import { jest } from '@jest/globals';

/**
 * Bug Condition Exploration Test: Timer Leak on Stop
 * 
 * **Validates: Requirements 1.1, 1.2, 1.3**
 * 
 * This test is designed to FAIL on UNFIXED code to confirm the bug exists.
 * The bug: KademliaDHT.stop() and OverlayNetwork.stop() leave interval timers running.
 * 
 * Bug Condition from design.md:
 * - KademliaDHT.stop() only clears bootstrapRetryTimer and refreshTimer
 * - Leaves republishData, cleanupTrackingMaps, cleanup, maintainRoutingTableConnections, 
 *   cleanupStaleConnections interval timers running
 * - OverlayNetwork.stop() does not clear sendKeepAlives, cleanupRoutingCache, 
 *   or checkConnectionHealth interval timers
 * 
 * Expected Counterexamples:
 * - After stop(), republishData timer still fires
 * - After stop(), cleanupTrackingMaps timer still fires
 * - After stop(), OverlayNetwork keepAlive timer still fires
 */

describe('Bug Condition Exploration: Timer Leak on Stop', () => {
  
  // Track setInterval calls to detect timer leaks
  let originalSetInterval;
  let originalClearInterval;
  let originalSetTimeout;
  let originalClearTimeout;
  let activeIntervals;
  let activeTimeouts;
  let timerIdCounter;

  beforeAll(() => {
    // Store originals
    originalSetInterval = global.setInterval;
    originalClearInterval = global.clearInterval;
    originalSetTimeout = global.setTimeout;
    originalClearTimeout = global.clearTimeout;
  });

  beforeEach(() => {
    // Track active timers
    activeIntervals = new Map();
    activeTimeouts = new Map();
    timerIdCounter = 1000;
    
    // Mock setInterval to track timer creation
    global.setInterval = jest.fn((callback, interval) => {
      const timerId = timerIdCounter++;
      activeIntervals.set(timerId, { callback, interval, cleared: false });
      return timerId;
    });
    
    // Mock clearInterval to track timer cleanup
    global.clearInterval = jest.fn((timerId) => {
      if (activeIntervals.has(timerId)) {
        activeIntervals.get(timerId).cleared = true;
      }
    });

    // Mock setTimeout to track timer creation
    global.setTimeout = jest.fn((callback, delay) => {
      const timerId = timerIdCounter++;
      activeTimeouts.set(timerId, { callback, delay, cleared: false });
      return timerId;
    });
    
    // Mock clearTimeout to track timer cleanup
    global.clearTimeout = jest.fn((timerId) => {
      if (activeTimeouts.has(timerId)) {
        activeTimeouts.get(timerId).cleared = true;
      }
    });
  });

  afterEach(() => {
    // Clear all tracked timers to prevent Jest open handles
    activeIntervals.clear();
    activeTimeouts.clear();
  });

  afterAll(() => {
    // Restore originals
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  });

  /**
   * Property 1: Bug Condition - Timer Leak on Stop (KademliaDHT)
   * 
   * For any call to KademliaDHT.stop(), the system should clear ALL interval timers
   * created by startMaintenanceTasks(). On UNFIXED code, this will FAIL because
   * the timers are not stored and therefore cannot be cleared.
   * 
   * **Validates: Requirements 1.1, 1.3**
   */
  describe('Property 1: KademliaDHT Timer Leak on Stop', () => {
    
    test('KademliaDHT.stop() should clear all maintenance timers (EXPECTED TO FAIL ON UNFIXED CODE)', async () => {
      // Dynamically import to get fresh module with mocked timers
      const { KademliaDHT } = await import('../../src/dht/KademliaDHT.js');
      
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 3 }), // Number of start/stop cycles
          async (cycles) => {
            for (let i = 0; i < cycles; i++) {
              // Reset timer tracking for this cycle
              activeIntervals.clear();
              activeTimeouts.clear();
              
              // Create a minimal DHT instance
              const dht = new KademliaDHT({
                republishInterval: 60000,
                expireInterval: 60000,
                pingInterval: 30000,
                requestTimeout: 5000
              });
              
              // Start maintenance tasks (this creates interval timers)
              dht.isStarted = true;
              dht.startMaintenanceTasks();
              
              // Count interval timers created by startMaintenanceTasks
              const intervalsCreatedBeforeStop = new Set(activeIntervals.keys());
              const intervalCountBeforeStop = intervalsCreatedBeforeStop.size;
              
              // We expect at least 5 interval timers from startMaintenanceTasks:
              // 1. republishData timer
              // 2. cleanupTrackingMaps timer  
              // 3. cleanup timer
              // 4. maintainRoutingTableConnections timer
              // 5. cleanupStaleConnections timer
              
              if (intervalCountBeforeStop < 5) {
                // Not enough timers created - skip this iteration
                return true;
              }
              
              // Call the actual stop() method to test timer cleanup
              try {
                await dht.stop();
              } catch (e) {
                // Ignore errors - we're testing timer cleanup
              }
              
              // Count how many interval timers were cleared
              let clearedCount = 0;
              for (const timerId of intervalsCreatedBeforeStop) {
                const timer = activeIntervals.get(timerId);
                if (timer && timer.cleared) {
                  clearedCount++;
                }
              }
              
              // BUG CONDITION: On unfixed code, not all timers are cleared
              // This property should FAIL because stop() doesn't clear all timers
              const allTimersCleared = clearedCount === intervalCountBeforeStop;
              
              // For the bug exploration test, we expect this to be FALSE on unfixed code
              // When this returns false, the test FAILS, confirming the bug exists
              return allTimersCleared;
            }
            return true;
          }
        ),
        { numRuns: 5, timeout: 10000 }
      );
    });
  });

  /**
   * Property 1b: Bug Condition - Timer Leak on Stop (OverlayNetwork)
   * 
   * For any call to OverlayNetwork.stop(), the system should clear ALL interval timers
   * created by startMaintenanceTasks(). On UNFIXED code, this will FAIL because
   * the timers are not stored and therefore cannot be cleared.
   * 
   * **Validates: Requirements 1.2, 1.3**
   */
  describe('Property 1b: OverlayNetwork Timer Leak on Stop', () => {
    
    test('OverlayNetwork.stop() should clear all maintenance timers (EXPECTED TO FAIL ON UNFIXED CODE)', async () => {
      // Create a mock DHT for OverlayNetwork
      const mockDHT = {
        localNodeId: { toString: () => 'test-node-id' },
        on: jest.fn(),
        off: jest.fn(),
        removeListener: jest.fn(),
        emit: jest.fn()
      };
      
      // Dynamically import to get fresh module with mocked timers
      const { OverlayNetwork } = await import('../../src/network/OverlayNetwork.js');
      
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 3 }), // Number of start/stop cycles
          async (cycles) => {
            for (let i = 0; i < cycles; i++) {
              // Reset timer tracking for this cycle
              activeIntervals.clear();
              activeTimeouts.clear();
              
              // Create OverlayNetwork instance
              const overlay = new OverlayNetwork(mockDHT, {
                keepAliveInterval: 30000
              });
              
              // Start maintenance tasks (this creates interval timers)
              overlay.isStarted = true;
              overlay.startMaintenanceTasks();
              
              // Count interval timers created by startMaintenanceTasks
              const intervalsCreatedBeforeStop = new Set(activeIntervals.keys());
              const intervalCountBeforeStop = intervalsCreatedBeforeStop.size;
              
              // We expect at least 3 interval timers from startMaintenanceTasks:
              // 1. keepAlive timer (sendKeepAlives)
              // 2. routingCacheCleanup timer (cleanupRoutingCache)
              // 3. connectionHealth timer (checkConnectionHealth)
              
              if (intervalCountBeforeStop < 3) {
                // Not enough timers created - skip this iteration
                return true;
              }
              
              // Call the actual stop() method to test timer cleanup
              try {
                await overlay.stop();
              } catch (e) {
                // Ignore errors - we're testing timer cleanup
              }
              
              // Count how many interval timers were cleared
              let clearedCount = 0;
              for (const timerId of intervalsCreatedBeforeStop) {
                const timer = activeIntervals.get(timerId);
                if (timer && timer.cleared) {
                  clearedCount++;
                }
              }
              
              // BUG CONDITION: On unfixed code, not all timers are cleared
              // This property should FAIL because stop() doesn't clear all timers
              const allTimersCleared = clearedCount === intervalCountBeforeStop;
              
              // For the bug exploration test, we expect this to be FALSE on unfixed code
              // When this returns false, the test FAILS, confirming the bug exists
              return allTimersCleared;
            }
            return true;
          }
        ),
        { numRuns: 5, timeout: 10000 }
      );
    });
  });

  /**
   * Property 1c: Combined Timer Leak Detection
   * 
   * Simpler deterministic test that directly verifies the bug condition:
   * After stop() is called, interval timers continue running.
   * 
   * **Validates: Requirements 1.1, 1.2, 1.3**
   */
  describe('Property 1c: Direct Timer Leak Verification', () => {
    
    test('KademliaDHT maintenance timers should be cleared on stop (EXPECTED TO FAIL)', async () => {
      const { KademliaDHT } = await import('../../src/dht/KademliaDHT.js');
      
      // Reset tracking
      activeIntervals.clear();
      
      const dht = new KademliaDHT({
        republishInterval: 60000,
        expireInterval: 60000,
        pingInterval: 30000
      });
      
      dht.isStarted = true;
      dht.startMaintenanceTasks();
      
      const intervalsBefore = new Set(activeIntervals.keys());
      
      // Call the actual stop() method
      try {
        await dht.stop();
      } catch (e) {
        // Ignore stop errors
      }
      
      // Check which interval timers were NOT cleared (the bug)
      const unclearedTimers = [];
      for (const timerId of intervalsBefore) {
        const timer = activeIntervals.get(timerId);
        if (timer && !timer.cleared) {
          unclearedTimers.push(timerId);
        }
      }
      
      // Document the counterexample
      if (unclearedTimers.length > 0) {
        console.log(`\n📋 COUNTEREXAMPLE FOUND: ${unclearedTimers.length} timers not cleared after KademliaDHT.stop()`);
        console.log('   Expected timers to clear: republishData, cleanupTrackingMaps, cleanup, maintainRoutingTableConnections, cleanupStaleConnections');
        console.log('   Bug confirmed: stop() does not clear maintenance interval timers\n');
      }
      
      // BUG CONDITION: This assertion will FAIL on unfixed code
      // because stop() doesn't clear all maintenance timers
      expect(unclearedTimers.length).toBe(0);
    });

    test('OverlayNetwork maintenance timers should be cleared on stop (EXPECTED TO FAIL)', async () => {
      const mockDHT = {
        localNodeId: { toString: () => 'test-node-id' },
        on: jest.fn(),
        off: jest.fn(),
        removeListener: jest.fn(),
        emit: jest.fn()
      };
      
      const { OverlayNetwork } = await import('../../src/network/OverlayNetwork.js');
      
      // Reset tracking
      activeIntervals.clear();
      
      const overlay = new OverlayNetwork(mockDHT, {
        keepAliveInterval: 30000
      });
      
      overlay.isStarted = true;
      overlay.startMaintenanceTasks();
      
      const intervalsBefore = new Set(activeIntervals.keys());
      
      // Call the actual stop() method
      try {
        await overlay.stop();
      } catch (e) {
        // Ignore stop errors
      }
      
      // Check which interval timers were NOT cleared (the bug)
      const unclearedTimers = [];
      for (const timerId of intervalsBefore) {
        const timer = activeIntervals.get(timerId);
        if (timer && !timer.cleared) {
          unclearedTimers.push(timerId);
        }
      }
      
      // Document the counterexample
      if (unclearedTimers.length > 0) {
        console.log(`\n📋 COUNTEREXAMPLE FOUND: ${unclearedTimers.length} timers not cleared after OverlayNetwork.stop()`);
        console.log('   Expected timers to clear: keepAlive, routingCacheCleanup, connectionHealth');
        console.log('   Bug confirmed: stop() does not clear maintenance interval timers\n');
      }
      
      // BUG CONDITION: This assertion will FAIL on unfixed code
      // because stop() doesn't clear any maintenance timers
      expect(unclearedTimers.length).toBe(0);
    });
  });
});
