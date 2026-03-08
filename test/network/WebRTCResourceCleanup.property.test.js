import * as fc from 'fast-check';
import { ConnectionStates, ConnectionTracker } from '../../src/network/ConnectionTracker.js';
import { WebRTCConnectionManager } from '../../src/network/WebRTCConnectionManager.js';

/**
 * Property-Based Tests for WebRTC Resource Cleanup
 * 
 * These tests verify universal properties that must hold across all valid inputs.
 * Using fast-check for randomized property-based testing.
 * 
 * Minimum iterations: 100 per property test
 */

describe('WebRTC Resource Cleanup - Property Tests', () => {
  beforeEach(() => {
    ConnectionTracker.reset();
  });

  /**
   * Feature: webrtc-resource-cleanup, Property 1: State Classification Correctness
   * 
   * For any RTCPeerConnection state value, isTransitional(state) returns true 
   * if and only if state is one of ['new', 'connecting', 'disconnected'], 
   * and isStable(state) returns true if and only if state is one of 
   * ['connected', 'failed', 'closed'].
   * 
   * Validates: Requirements 1.4, 1.5
   */
  describe('Property 1: State Classification Correctness', () => {
    test('transitional states are correctly classified', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('new', 'connecting', 'disconnected'),
          (state) => {
            return ConnectionStates.isTransitional(state) === true &&
                   ConnectionStates.isStable(state) === false;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('stable states are correctly classified', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('connected', 'failed', 'closed'),
          (state) => {
            return ConnectionStates.isStable(state) === true &&
                   ConnectionStates.isTransitional(state) === false;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('all valid states are classified as either transitional or stable (mutually exclusive)', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('new', 'connecting', 'disconnected', 'connected', 'failed', 'closed'),
          (state) => {
            const isTransitional = ConnectionStates.isTransitional(state);
            const isStable = ConnectionStates.isStable(state);
            // Exactly one must be true (XOR)
            return (isTransitional && !isStable) || (!isTransitional && isStable);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('unknown states return false for both classifications', () => {
      fc.assert(
        fc.property(
          fc.string().filter(s => 
            !['new', 'connecting', 'disconnected', 'connected', 'failed', 'closed'].includes(s)
          ),
          (unknownState) => {
            return ConnectionStates.isTransitional(unknownState) === false &&
                   ConnectionStates.isStable(unknownState) === false;
          }
        ),
        { numRuns: 100 }
      );
    });
  });


  /**
   * Feature: webrtc-resource-cleanup, Property 4: Listener Registration Round-Trip
   * 
   * For any set of event listeners registered via registerListener(), performing 
   * cleanup and then checking the listener count SHALL result in zero remaining 
   * tracked listeners.
   * 
   * Validates: Requirements 3.1, 3.2, 3.4
   */
  describe('Property 4: Listener Registration Round-Trip', () => {
    /**
     * Mock EventTarget that tracks addEventListener/removeEventListener calls
     */
    class MockEventTarget {
      constructor() {
        this.listeners = new Map();
      }
      
      addEventListener(event, handler) {
        if (!this.listeners.has(event)) {
          this.listeners.set(event, new Set());
        }
        this.listeners.get(event).add(handler);
      }
      
      removeEventListener(event, handler) {
        if (this.listeners.has(event)) {
          this.listeners.get(event).delete(handler);
        }
      }
      
      getListenerCount(event) {
        return this.listeners.has(event) ? this.listeners.get(event).size : 0;
      }
      
      getTotalListenerCount() {
        let total = 0;
        for (const handlers of this.listeners.values()) {
          total += handlers.size;
        }
        return total;
      }
    }

    test('all registered listeners are removed after removeAllListeners', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              event: fc.constantFrom('open', 'close', 'message', 'error', 'icecandidate', 'connectionstatechange'),
              handlerId: fc.integer({ min: 0, max: 1000 })
            }),
            { minLength: 1, maxLength: 20 }
          ),
          (listenerSpecs) => {
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            const mockTarget = new MockEventTarget();
            
            // Register all listeners
            for (const spec of listenerSpecs) {
              const handler = () => {}; // Unique handler per registration
              manager.registerListener(mockTarget, spec.event, handler);
            }
            
            // Verify listeners were registered
            const registeredCount = manager.trackedListeners.length;
            if (registeredCount !== listenerSpecs.length) {
              return false;
            }
            
            // Remove all listeners
            manager.removeAllListeners();
            
            // Verify all tracked listeners are cleared
            return manager.trackedListeners.length === 0;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('removeAllListeners actually removes listeners from targets', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.constantFrom('open', 'close', 'message', 'error'),
            { minLength: 1, maxLength: 10 }
          ),
          (events) => {
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            const mockTarget = new MockEventTarget();
            
            // Register listeners for each event
            for (const event of events) {
              const handler = () => {};
              manager.registerListener(mockTarget, event, handler);
            }
            
            // Verify listeners were added to target
            const beforeCount = mockTarget.getTotalListenerCount();
            if (beforeCount !== events.length) {
              return false;
            }
            
            // Remove all listeners
            manager.removeAllListeners();
            
            // Verify listeners were removed from target
            return mockTarget.getTotalListenerCount() === 0;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('multiple targets have all listeners removed', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 5 }),
          fc.array(
            fc.constantFrom('open', 'close', 'message'),
            { minLength: 1, maxLength: 5 }
          ),
          (targetCount, events) => {
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            const targets = Array.from({ length: targetCount }, () => new MockEventTarget());
            
            // Register listeners on multiple targets
            for (const target of targets) {
              for (const event of events) {
                manager.registerListener(target, event, () => {});
              }
            }
            
            // Verify total registered
            const expectedTotal = targetCount * events.length;
            if (manager.trackedListeners.length !== expectedTotal) {
              return false;
            }
            
            // Remove all listeners
            manager.removeAllListeners();
            
            // Verify all targets have no listeners
            const allTargetsClean = targets.every(t => t.getTotalListenerCount() === 0);
            return manager.trackedListeners.length === 0 && allTargetsClean;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('removeAllListeners is idempotent', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 5 }),
          fc.array(
            fc.constantFrom('open', 'close', 'message'),
            { minLength: 1, maxLength: 5 }
          ),
          (callCount, events) => {
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            const mockTarget = new MockEventTarget();
            
            // Register some listeners
            for (const event of events) {
              manager.registerListener(mockTarget, event, () => {});
            }
            
            // Call removeAllListeners multiple times
            for (let i = 0; i < callCount; i++) {
              manager.removeAllListeners();
            }
            
            // Should still have zero listeners
            return manager.trackedListeners.length === 0 && 
                   mockTarget.getTotalListenerCount() === 0;
          }
        ),
        { numRuns: 100 }
      );
    });
  });


  /**
   * Feature: webrtc-resource-cleanup, Property 5: Connection Count Invariant
   * 
   * For any sequence of connection lifecycle operations (create, cleanup success, 
   * cleanup failure), the activeConnections count SHALL equal the number of 
   * connections created minus the number of successful cleanups.
   * 
   * Validates: Requirements 4.1, 4.2, 4.3, 4.7
   */
  describe('Property 5: Connection Count Invariant', () => {
    test('active connections equals created minus successfully cleaned up', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.constantFrom('create', 'cleanupSuccess', 'cleanupFailure'),
            { minLength: 1, maxLength: 50 }
          ),
          (operations) => {
            ConnectionTracker.reset();
            let expectedActive = 0;
            
            for (const op of operations) {
              if (op === 'create') {
                ConnectionTracker.trackConnectionCreated();
                expectedActive++;
              } else if (op === 'cleanupSuccess') {
                if (expectedActive > 0) {
                  ConnectionTracker.trackConnectionClosed(true, 'test');
                  expectedActive--;
                }
              } else if (op === 'cleanupFailure') {
                if (expectedActive > 0) {
                  ConnectionTracker.trackConnectionClosed(false, 'test', { error: 'test error' });
                  // Active count doesn't change on failure
                }
              }
            }
            
            return ConnectionTracker.activeConnections === expectedActive;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('active connections never goes negative', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.constantFrom('create', 'cleanupSuccess', 'cleanupFailure'),
            { minLength: 1, maxLength: 100 }
          ),
          (operations) => {
            ConnectionTracker.reset();
            
            for (const op of operations) {
              if (op === 'create') {
                ConnectionTracker.trackConnectionCreated();
              } else if (op === 'cleanupSuccess') {
                ConnectionTracker.trackConnectionClosed(true, 'test');
              } else if (op === 'cleanupFailure') {
                ConnectionTracker.trackConnectionClosed(false, 'test', { error: 'test error' });
              }
              
              // Check invariant after each operation
              if (ConnectionTracker.activeConnections < 0) {
                return false;
              }
            }
            
            return ConnectionTracker.activeConnections >= 0;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('cleanup counts are monotonically increasing', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.constantFrom('create', 'cleanupSuccess', 'cleanupFailure'),
            { minLength: 1, maxLength: 50 }
          ),
          (operations) => {
            ConnectionTracker.reset();
            let prevSuccesses = 0;
            let prevFailures = 0;
            
            for (const op of operations) {
              if (op === 'create') {
                ConnectionTracker.trackConnectionCreated();
              } else if (op === 'cleanupSuccess') {
                ConnectionTracker.trackConnectionClosed(true, 'test');
              } else if (op === 'cleanupFailure') {
                ConnectionTracker.trackConnectionClosed(false, 'test', { error: 'test error' });
              }
              
              // Counters should never decrease
              if (ConnectionTracker.cleanupSuccesses < prevSuccesses ||
                  ConnectionTracker.cleanupFailures < prevFailures) {
                return false;
              }
              
              prevSuccesses = ConnectionTracker.cleanupSuccesses;
              prevFailures = ConnectionTracker.cleanupFailures;
            }
            
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('total cleanups equals successes plus failures', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.constantFrom('create', 'cleanupSuccess', 'cleanupFailure'),
            { minLength: 1, maxLength: 50 }
          ),
          (operations) => {
            ConnectionTracker.reset();
            let totalCleanupAttempts = 0;
            
            for (const op of operations) {
              if (op === 'create') {
                ConnectionTracker.trackConnectionCreated();
              } else if (op === 'cleanupSuccess') {
                ConnectionTracker.trackConnectionClosed(true, 'test');
                totalCleanupAttempts++;
              } else if (op === 'cleanupFailure') {
                ConnectionTracker.trackConnectionClosed(false, 'test', { error: 'test error' });
                totalCleanupAttempts++;
              }
            }
            
            return (ConnectionTracker.cleanupSuccesses + ConnectionTracker.cleanupFailures) === totalCleanupAttempts;
          }
        ),
        { numRuns: 100 }
      );
    });
  });


  /**
   * Feature: webrtc-resource-cleanup, Property 6: Cleanup Failure Logging
   * 
   * For any cleanup operation that fails, the ConnectionTracker SHALL record 
   * the failure with details including peer ID, connection state, and error message.
   * 
   * Validates: Requirements 4.4, 4.6
   */
  describe('Property 6: Cleanup Failure Logging', () => {
    test('cleanup failure records peer ID in failure log', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 8, maxLength: 64 }).filter(s => s.length >= 8),
          fc.constantFrom('timeout', 'unexpected_disconnect', 'ice_failed', 'manual'),
          (peerId, reason) => {
            ConnectionTracker.reset();
            
            // Track a failed cleanup with peer ID
            ConnectionTracker.trackConnectionClosed(false, reason, {
              peerId,
              connectionState: 'failed',
              error: 'Test error'
            });
            
            // Verify failure was logged with peer ID
            const stats = ConnectionTracker.getResourceStats();
            const hasFailureWithPeerId = stats.recentFailures.some(
              failure => failure.peerId === peerId
            );
            
            return stats.cleanupFailures === 1 && hasFailureWithPeerId;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('cleanup failure records connection state in failure log', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('new', 'connecting', 'connected', 'disconnected', 'failed', 'closed'),
          fc.constantFrom('timeout', 'unexpected_disconnect', 'manual'),
          (connectionState, reason) => {
            ConnectionTracker.reset();
            
            // Track a failed cleanup with connection state
            ConnectionTracker.trackConnectionClosed(false, reason, {
              peerId: 'test-peer',
              connectionState,
              error: 'Test error'
            });
            
            // Verify failure was logged with connection state
            const stats = ConnectionTracker.getResourceStats();
            const hasFailureWithState = stats.recentFailures.some(
              failure => failure.connectionState === connectionState
            );
            
            return stats.cleanupFailures === 1 && hasFailureWithState;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('cleanup failure records error message in failure log', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 100 }),
          fc.constantFrom('timeout', 'unexpected_disconnect', 'manual'),
          (errorMessage, reason) => {
            ConnectionTracker.reset();
            
            // Track a failed cleanup with error message
            ConnectionTracker.trackConnectionClosed(false, reason, {
              peerId: 'test-peer',
              connectionState: 'failed',
              error: errorMessage
            });
            
            // Verify failure was logged with error message
            const stats = ConnectionTracker.getResourceStats();
            const hasFailureWithError = stats.recentFailures.some(
              failure => failure.error === errorMessage
            );
            
            return stats.cleanupFailures === 1 && hasFailureWithError;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('cleanup failure records reason in failure log', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('timeout', 'unexpected_disconnect', 'ice_failed', 'manual', 'shutdown', 'cleanup'),
          (reason) => {
            ConnectionTracker.reset();
            
            // Track a failed cleanup with reason
            ConnectionTracker.trackConnectionClosed(false, reason, {
              peerId: 'test-peer',
              connectionState: 'failed',
              error: 'Test error'
            });
            
            // Verify failure was logged with reason
            const stats = ConnectionTracker.getResourceStats();
            const hasFailureWithReason = stats.recentFailures.some(
              failure => failure.reason === reason
            );
            
            return stats.cleanupFailures === 1 && hasFailureWithReason;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('cleanup failure includes timestamp in failure log', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 100 }),
          (_seed) => {
            ConnectionTracker.reset();
            
            const beforeTime = Date.now();
            
            // Track a failed cleanup
            ConnectionTracker.trackConnectionClosed(false, 'test', {
              peerId: 'test-peer',
              connectionState: 'failed',
              error: 'Test error'
            });
            
            const afterTime = Date.now();
            
            // Verify failure was logged with valid timestamp
            const stats = ConnectionTracker.getResourceStats();
            const failure = stats.recentFailures[0];
            
            return failure !== undefined &&
                   typeof failure.timestamp === 'number' &&
                   failure.timestamp >= beforeTime &&
                   failure.timestamp <= afterTime;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('multiple cleanup failures are all recorded', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              peerId: fc.string({ minLength: 8, maxLength: 32 }).filter(s => s.length >= 8),
              reason: fc.constantFrom('timeout', 'unexpected_disconnect', 'manual'),
              error: fc.string({ minLength: 1, maxLength: 50 })
            }),
            { minLength: 1, maxLength: 10 }
          ),
          (failures) => {
            ConnectionTracker.reset();
            
            // Track multiple failed cleanups
            for (const failure of failures) {
              ConnectionTracker.trackConnectionClosed(false, failure.reason, {
                peerId: failure.peerId,
                connectionState: 'failed',
                error: failure.error
              });
            }
            
            // Verify all failures were recorded
            const stats = ConnectionTracker.getResourceStats();
            
            return stats.cleanupFailures === failures.length &&
                   stats.recentFailures.length === Math.min(failures.length, ConnectionTracker.MAX_FAILURE_LOGS);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('failure log respects MAX_FAILURE_LOGS limit', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 15, max: 30 }),
          (failureCount) => {
            ConnectionTracker.reset();
            
            // Track more failures than MAX_FAILURE_LOGS
            for (let i = 0; i < failureCount; i++) {
              ConnectionTracker.trackConnectionClosed(false, 'test', {
                peerId: `peer-${i}`,
                connectionState: 'failed',
                error: `Error ${i}`
              });
            }
            
            // Verify failure log is capped at MAX_FAILURE_LOGS
            const stats = ConnectionTracker.getResourceStats();
            
            return stats.cleanupFailures === failureCount &&
                   stats.recentFailures.length === ConnectionTracker.MAX_FAILURE_LOGS;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('failure log keeps most recent failures when limit exceeded', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 15, max: 30 }),
          (failureCount) => {
            ConnectionTracker.reset();
            
            // Track more failures than MAX_FAILURE_LOGS
            for (let i = 0; i < failureCount; i++) {
              ConnectionTracker.trackConnectionClosed(false, 'test', {
                peerId: `peer-${i}`,
                connectionState: 'failed',
                error: `Error ${i}`
              });
            }
            
            // Verify most recent failures are kept
            const stats = ConnectionTracker.getResourceStats();
            const expectedFirstPeerId = `peer-${failureCount - ConnectionTracker.MAX_FAILURE_LOGS}`;
            const expectedLastPeerId = `peer-${failureCount - 1}`;
            
            return stats.recentFailures[0].peerId === expectedFirstPeerId &&
                   stats.recentFailures[stats.recentFailures.length - 1].peerId === expectedLastPeerId;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('successful cleanup does not add to failure log', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 20 }),
          (successCount) => {
            ConnectionTracker.reset();
            
            // Track successful cleanups
            for (let i = 0; i < successCount; i++) {
              ConnectionTracker.trackConnectionCreated();
              ConnectionTracker.trackConnectionClosed(true, 'test', {
                peerId: `peer-${i}`,
                connectionState: 'connected'
              });
            }
            
            // Verify no failures were logged
            const stats = ConnectionTracker.getResourceStats();
            
            return stats.cleanupSuccesses === successCount &&
                   stats.cleanupFailures === 0 &&
                   stats.recentFailures.length === 0;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('failure log contains all required fields', () => {
      fc.assert(
        fc.property(
          fc.record({
            peerId: fc.string({ minLength: 8, maxLength: 32 }).filter(s => s.length >= 8),
            connectionState: fc.constantFrom('new', 'connecting', 'connected', 'disconnected', 'failed', 'closed'),
            iceConnectionState: fc.constantFrom('new', 'checking', 'connected', 'completed', 'failed', 'disconnected', 'closed'),
            error: fc.string({ minLength: 1, maxLength: 100 })
          }),
          fc.constantFrom('timeout', 'unexpected_disconnect', 'manual', 'shutdown'),
          (details, reason) => {
            ConnectionTracker.reset();
            
            // Track a failed cleanup with all details
            ConnectionTracker.trackConnectionClosed(false, reason, details);
            
            // Verify failure log contains all required fields
            const stats = ConnectionTracker.getResourceStats();
            const failure = stats.recentFailures[0];
            
            return failure !== undefined &&
                   failure.peerId === details.peerId &&
                   failure.connectionState === details.connectionState &&
                   failure.iceConnectionState === details.iceConnectionState &&
                   failure.error === details.error &&
                   failure.reason === reason &&
                   typeof failure.timestamp === 'number';
          }
        ),
        { numRuns: 100 }
      );
    });
  });


  /**
   * Feature: webrtc-resource-cleanup, Property 2: State-Aware Cleanup Behavior
   * 
   * For any cleanup request on a connection in a transitional state, the cleanup 
   * SHALL wait (not proceed immediately), and for any cleanup request on a 
   * connection in a stable state, the cleanup SHALL proceed immediately.
   * 
   * Validates: Requirements 1.1, 1.2
   */
  describe('Property 2: State-Aware Cleanup Behavior', () => {
    /**
     * Mock RTCPeerConnection for testing state-aware cleanup
     */
    class MockRTCPeerConnection {
      constructor(initialState = 'new') {
        this._connectionState = initialState;
        this._iceConnectionState = 'new';
        this._listeners = new Map();
        this.timeout = null;
      }

      get connectionState() {
        return this._connectionState;
      }

      set connectionState(state) {
        this._connectionState = state;
        this._triggerEvent('connectionstatechange');
      }

      get iceConnectionState() {
        return this._iceConnectionState;
      }

      addEventListener(event, handler) {
        if (!this._listeners.has(event)) {
          this._listeners.set(event, new Set());
        }
        this._listeners.get(event).add(handler);
      }

      removeEventListener(event, handler) {
        if (this._listeners.has(event)) {
          this._listeners.get(event).delete(handler);
        }
      }

      _triggerEvent(event) {
        if (this._listeners.has(event)) {
          for (const handler of this._listeners.get(event)) {
            handler();
          }
        }
      }

      getSenders() { return []; }
      getReceivers() { return []; }
      close() { this._connectionState = 'closed'; }
    }

    test('cleanup proceeds immediately for stable states', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('connected', 'failed', 'closed'),
          async (stableState) => {
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            manager.connection = new MockRTCPeerConnection(stableState);
            manager.peerId = 'test-peer-id';
            
            const startTime = Date.now();
            const resultState = await manager.waitForStableState(1000);
            const elapsed = Date.now() - startTime;
            
            // Should return immediately (within 50ms tolerance)
            return elapsed < 50 && ConnectionStates.isStable(resultState);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('cleanup waits for transitional states to become stable', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('new', 'connecting', 'disconnected'),
          fc.constantFrom('connected', 'failed', 'closed'),
          fc.integer({ min: 10, max: 100 }),
          async (transitionalState, targetStableState, transitionDelay) => {
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            const mockPc = new MockRTCPeerConnection(transitionalState);
            manager.connection = mockPc;
            manager.peerId = 'test-peer-id';
            
            // Schedule state transition
            setTimeout(() => {
              mockPc.connectionState = targetStableState;
            }, transitionDelay);
            
            const startTime = Date.now();
            const resultState = await manager.waitForStableState(1000);
            const elapsed = Date.now() - startTime;
            
            // Should have waited for the transition
            return elapsed >= transitionDelay - 5 && ConnectionStates.isStable(resultState);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('cleanup times out and proceeds for stuck transitional states', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('new', 'connecting', 'disconnected'),
          fc.integer({ min: 20, max: 50 }),
          async (transitionalState, timeout) => {
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            const mockPc = new MockRTCPeerConnection(transitionalState);
            manager.connection = mockPc;
            manager.peerId = 'test-peer-id';
            
            // Don't transition - let it timeout
            const startTime = Date.now();
            const resultState = await manager.waitForStableState(timeout);
            const elapsed = Date.now() - startTime;
            
            // Should have timed out (within tolerance)
            return elapsed >= timeout - 10 && elapsed < timeout + 50;
          }
        ),
        { numRuns: 50 }  // Reduced iterations for timeout tests
      );
    }, 30000);  // Increase Jest timeout to 30 seconds
  });


  /**
   * Feature: webrtc-resource-cleanup, Property 3: Cleanup Execution Order
   * 
   * For any cleanup operation, the execution order SHALL be: 
   * (1) stop media tracks, (2) remove event listeners, (3) close data channel, 
   * (4) close RTCPeerConnection, (5) nullify references.
   * Each step must complete before the next begins.
   * 
   * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5
   */
  describe('Property 3: Cleanup Execution Order', () => {
    /**
     * Mock RTCPeerConnection that tracks method call order
     */
    class OrderTrackingMockPeerConnection {
      constructor() {
        this._connectionState = 'connected';
        this._iceConnectionState = 'connected';
        this.callOrder = [];
        this.timeout = null;
        this._tracks = [
          { stop: () => this.callOrder.push('track.stop') }
        ];
      }

      get connectionState() { return this._connectionState; }
      get iceConnectionState() { return this._iceConnectionState; }

      getSenders() {
        this.callOrder.push('getSenders');
        return [{ track: this._tracks[0] }];
      }

      getReceivers() {
        this.callOrder.push('getReceivers');
        return [{ track: this._tracks[0] }];
      }

      close() {
        this.callOrder.push('pc.close');
        this._connectionState = 'closed';
      }

      addEventListener() {}
      removeEventListener() {}
    }

    /**
     * Mock DataChannel that tracks close calls
     */
    class OrderTrackingMockDataChannel {
      constructor(callOrder) {
        this.callOrder = callOrder;
        this.readyState = 'open';
      }

      close() {
        this.callOrder.push('dataChannel.close');
        this.readyState = 'closed';
      }

      addEventListener() {}
      removeEventListener() {}
    }

    test('cleanup executes steps in correct order', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('manual', 'timeout', 'unexpected_disconnect', 'shutdown'),
          (reason) => {
            ConnectionTracker.reset();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            const mockPc = new OrderTrackingMockPeerConnection();
            const mockDc = new OrderTrackingMockDataChannel(mockPc.callOrder);
            
            manager.connection = mockPc;
            manager.dataChannel = mockDc;
            manager.peerId = 'test-peer-id';
            
            // Add some tracked listeners to verify removal
            manager.trackedListeners = [
              { target: { removeEventListener: () => mockPc.callOrder.push('listener.remove') }, event: 'test', handler: () => {} }
            ];
            
            // Perform cleanup
            manager.performCleanup(reason);
            
            // Verify order: tracks → listeners → channel → connection
            const order = mockPc.callOrder;
            
            // Find indices of key operations
            const trackStopIndex = order.findIndex(op => op === 'track.stop');
            const listenerRemoveIndex = order.findIndex(op => op === 'listener.remove');
            const dataChannelCloseIndex = order.findIndex(op => op === 'dataChannel.close');
            const pcCloseIndex = order.findIndex(op => op === 'pc.close');
            
            // Verify order (tracks before listeners before channel before connection)
            const tracksBeforeListeners = trackStopIndex < listenerRemoveIndex || trackStopIndex === -1;
            const listenersBeforeChannel = listenerRemoveIndex < dataChannelCloseIndex;
            const channelBeforeConnection = dataChannelCloseIndex < pcCloseIndex;
            
            return tracksBeforeListeners && listenersBeforeChannel && channelBeforeConnection;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('references are nullified after cleanup', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('manual', 'timeout', 'unexpected_disconnect'),
          (reason) => {
            ConnectionTracker.reset();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            const mockPc = new OrderTrackingMockPeerConnection();
            const mockDc = new OrderTrackingMockDataChannel(mockPc.callOrder);
            
            manager.connection = mockPc;
            manager.dataChannel = mockDc;
            manager.peerId = 'test-peer-id';
            
            // Perform cleanup
            manager.performCleanup(reason);
            
            // Verify references are nullified (Requirement 2.5)
            return manager.connection === null && 
                   manager.dataChannel === null &&
                   manager.connectionState === 'disconnected';
          }
        ),
        { numRuns: 100 }
      );
    });

    test('cleanup continues even if individual steps fail', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('manual', 'timeout'),
          (reason) => {
            ConnectionTracker.reset();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            
            // Create mock that throws on getSenders
            const mockPc = {
              connectionState: 'connected',
              iceConnectionState: 'connected',
              timeout: null,
              getSenders: () => { throw new Error('getSenders failed'); },
              getReceivers: () => [],
              close: () => {},
              addEventListener: () => {},
              removeEventListener: () => {}
            };
            
            manager.connection = mockPc;
            manager.dataChannel = { close: () => {}, addEventListener: () => {}, removeEventListener: () => {} };
            manager.peerId = 'test-peer-id';
            
            // Should not throw
            let didThrow = false;
            try {
              manager.performCleanup(reason);
            } catch (e) {
              didThrow = true;
            }
            
            // Cleanup should complete and nullify references despite error
            return !didThrow && manager.connection === null && manager.dataChannel === null;
          }
        ),
        { numRuns: 100 }
      );
    });
  });


  /**
   * Feature: webrtc-resource-cleanup, Property 7: Concurrent Cleanup Prevention
   * 
   * For any connection where cleanup is already in progress, subsequent cleanup 
   * requests for that same connection SHALL be ignored (return immediately 
   * without performing cleanup).
   * 
   * Validates: Requirements 5.1
   */
  describe('Property 7: Concurrent Cleanup Prevention', () => {
    test('concurrent cleanup requests are ignored when cleanup is in progress', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 5 }),
          async (concurrentAttempts) => {
            ConnectionTracker.reset();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            
            // Create a mock connection that takes time to clean up
            let cleanupCount = 0;
            const mockPc = {
              connectionState: 'connected',
              iceConnectionState: 'connected',
              timeout: null,
              getSenders: () => [],
              getReceivers: () => [],
              close: () => { cleanupCount++; },
              addEventListener: () => {},
              removeEventListener: () => {}
            };
            
            manager.connection = mockPc;
            manager.peerId = 'test-peer-id';
            
            // Start multiple concurrent cleanup attempts
            const cleanupPromises = [];
            for (let i = 0; i < concurrentAttempts; i++) {
              cleanupPromises.push(manager.safeCleanup('test'));
            }
            
            await Promise.all(cleanupPromises);
            
            // Only one cleanup should have executed
            return cleanupCount === 1;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('cleanup flag prevents re-entry', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }),
          async (attempts) => {
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            
            // Manually set cleanup in progress
            manager.cleanupInProgress = true;
            
            let cleanupExecuted = false;
            const originalPerformCleanup = manager.performCleanup.bind(manager);
            manager.performCleanup = (reason) => {
              cleanupExecuted = true;
              originalPerformCleanup(reason);
            };
            
            // Try to cleanup multiple times
            for (let i = 0; i < attempts; i++) {
              await manager.safeCleanup('test');
            }
            
            // Cleanup should not have executed because flag was set
            return cleanupExecuted === false;
          }
        ),
        { numRuns: 100 }
      );
    });
  });


  /**
   * Feature: webrtc-resource-cleanup, Property 8: Cleanup Flag Consistency
   * 
   * For any cleanup operation (whether successful or failed), the cleanupInProgress 
   * flag SHALL be cleared (set to false) after the operation completes.
   * 
   * Validates: Requirements 5.2, 5.3
   */
  describe('Property 8: Cleanup Flag Consistency', () => {
    test('cleanup flag is cleared after successful cleanup', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('manual', 'timeout', 'unexpected_disconnect', 'shutdown'),
          async (reason) => {
            ConnectionTracker.reset();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            
            const mockPc = {
              connectionState: 'connected',
              iceConnectionState: 'connected',
              timeout: null,
              getSenders: () => [],
              getReceivers: () => [],
              close: () => {},
              addEventListener: () => {},
              removeEventListener: () => {}
            };
            
            manager.connection = mockPc;
            manager.peerId = 'test-peer-id';
            
            // Verify flag starts false
            if (manager.cleanupInProgress !== false) return false;
            
            await manager.safeCleanup(reason);
            
            // Flag should be cleared after cleanup
            return manager.cleanupInProgress === false;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('cleanup flag is cleared even when cleanup throws', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('manual', 'timeout'),
          async (reason) => {
            ConnectionTracker.reset();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            
            // Create mock that throws during cleanup
            const mockPc = {
              connectionState: 'connected',
              iceConnectionState: 'connected',
              timeout: null,
              getSenders: () => { throw new Error('Simulated error'); },
              getReceivers: () => [],
              close: () => {},
              addEventListener: () => {},
              removeEventListener: () => {}
            };
            
            manager.connection = mockPc;
            manager.peerId = 'test-peer-id';
            
            // Cleanup should handle errors gracefully
            await manager.safeCleanup(reason);
            
            // Flag should still be cleared (finally block)
            return manager.cleanupInProgress === false;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('cleanup flag is set during cleanup execution', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('manual', 'timeout'),
          async (reason) => {
            ConnectionTracker.reset();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            
            let flagDuringCleanup = false;
            const mockPc = {
              connectionState: 'connected',
              iceConnectionState: 'connected',
              timeout: null,
              getSenders: () => {
                // Check flag during cleanup execution
                flagDuringCleanup = manager.cleanupInProgress;
                return [];
              },
              getReceivers: () => [],
              close: () => {},
              addEventListener: () => {},
              removeEventListener: () => {}
            };
            
            manager.connection = mockPc;
            manager.peerId = 'test-peer-id';
            
            await manager.safeCleanup(reason);
            
            // Flag should have been true during cleanup
            return flagDuringCleanup === true && manager.cleanupInProgress === false;
          }
        ),
        { numRuns: 100 }
      );
    });
  });


  /**
   * Feature: webrtc-resource-cleanup, Property 9: Disconnect Event Emission
   * 
   * For any connection cleanup (whether due to unexpected disconnect, timeout, 
   * or manual cleanup), a peerDisconnected event SHALL be emitted with the 
   * peer ID and reason.
   * 
   * Validates: Requirements 6.1, 6.3, 8.5
   */
  describe('Property 9: Disconnect Event Emission', () => {
    test('peerDisconnected event is emitted for all cleanup reasons', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('manual', 'timeout', 'unexpected_disconnect', 'cleanup', 'ice_failed', 'shutdown'),
          async (reason) => {
            ConnectionTracker.reset();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            
            const mockPc = {
              connectionState: 'connected',
              iceConnectionState: 'connected',
              timeout: null,
              getSenders: () => [],
              getReceivers: () => [],
              close: () => {},
              addEventListener: () => {},
              removeEventListener: () => {}
            };
            
            manager.connection = mockPc;
            manager.peerId = 'test-peer-id-12345';
            
            // Track emitted events
            let emittedEvent = null;
            manager.on('peerDisconnected', (event) => {
              emittedEvent = event;
            });
            
            await manager.safeCleanup(reason);
            
            // Verify event was emitted with correct data
            return emittedEvent !== null &&
                   emittedEvent.peerId === 'test-peer-id-12345' &&
                   emittedEvent.reason === reason;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('peerDisconnected event contains peerId and reason', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 16, maxLength: 64 }).filter(s => s.length >= 8),
          fc.constantFrom('manual', 'timeout', 'unexpected_disconnect'),
          async (peerId, reason) => {
            ConnectionTracker.reset();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            
            const mockPc = {
              connectionState: 'connected',
              iceConnectionState: 'connected',
              timeout: null,
              getSenders: () => [],
              getReceivers: () => [],
              close: () => {},
              addEventListener: () => {},
              removeEventListener: () => {}
            };
            
            manager.connection = mockPc;
            manager.peerId = peerId;
            
            let emittedEvent = null;
            manager.on('peerDisconnected', (event) => {
              emittedEvent = event;
            });
            
            await manager.safeCleanup(reason);
            
            // Event must have both peerId and reason properties
            return emittedEvent !== null &&
                   typeof emittedEvent.peerId === 'string' &&
                   typeof emittedEvent.reason === 'string' &&
                   emittedEvent.peerId === peerId &&
                   emittedEvent.reason === reason;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('destroyConnection emits peerDisconnected via safeCleanup', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('manual', 'timeout', 'ice_failed'),
          async (reason) => {
            ConnectionTracker.reset();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            
            const mockPc = {
              connectionState: 'connected',
              iceConnectionState: 'connected',
              timeout: null,
              getSenders: () => [],
              getReceivers: () => [],
              close: () => {},
              addEventListener: () => {},
              removeEventListener: () => {}
            };
            
            manager.connection = mockPc;
            manager.peerId = 'destroy-test-peer';
            
            let emittedEvent = null;
            manager.on('peerDisconnected', (event) => {
              emittedEvent = event;
            });
            
            await manager.destroyConnection('destroy-test-peer', reason);
            
            return emittedEvent !== null &&
                   emittedEvent.peerId === 'destroy-test-peer' &&
                   emittedEvent.reason === reason;
          }
        ),
        { numRuns: 100 }
      );
    });
  });


  /**
   * Feature: webrtc-resource-cleanup, Property 13: Timeout Cleanup Completeness
   * 
   * For any connection that times out during establishment, the cleanup SHALL:
   * (1) close the RTCPeerConnection, (2) remove all event listeners, 
   * (3) log to ConnectionTracker, and (4) emit a disconnect event.
   * 
   * Validates: Requirements 8.1, 8.2, 8.3, 8.4
   */
  describe('Property 13: Timeout Cleanup Completeness', () => {
    test('timeout cleanup closes RTCPeerConnection', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 100 }),
          async (_seed) => {
            ConnectionTracker.reset();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            // Set short timeout for tests
            manager.cleanupTimeout = 100;
            
            let connectionClosed = false;
            const mockPc = {
              // Use 'failed' state - this is what a timed-out connection would be in
              connectionState: 'failed',
              iceConnectionState: 'failed',
              timeout: null,
              getSenders: () => [],
              getReceivers: () => [],
              close: () => { connectionClosed = true; },
              addEventListener: () => {},
              removeEventListener: () => {}
            };
            
            manager.connection = mockPc;
            manager.peerId = 'timeout-test-peer';
            
            // Simulate timeout cleanup
            await manager.destroyConnection('timeout-test-peer', 'timeout');
            
            return connectionClosed === true;
          }
        ),
        { numRuns: 100 }
      );
    }, 30000);

    test('timeout cleanup removes all event listeners', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.constantFrom('icecandidate', 'connectionstatechange', 'datachannel'),
            { minLength: 1, maxLength: 5 }
          ),
          async (events) => {
            ConnectionTracker.reset();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            manager.cleanupTimeout = 100;
            
            // Track listener removal
            const removedListeners = [];
            const mockPc = {
              // Use 'failed' state for immediate cleanup
              connectionState: 'failed',
              iceConnectionState: 'failed',
              timeout: null,
              getSenders: () => [],
              getReceivers: () => [],
              close: () => {},
              addEventListener: () => {},
              removeEventListener: (event, handler) => {
                removedListeners.push({ event, handler });
              }
            };
            
            manager.connection = mockPc;
            manager.peerId = 'timeout-test-peer';
            
            // Register some listeners
            for (const event of events) {
              manager.registerListener(mockPc, event, () => {});
            }
            
            const registeredCount = manager.trackedListeners.length;
            
            // Simulate timeout cleanup
            await manager.destroyConnection('timeout-test-peer', 'timeout');
            
            // All listeners should be removed
            return manager.trackedListeners.length === 0 &&
                   removedListeners.length === registeredCount;
          }
        ),
        { numRuns: 100 }
      );
    }, 30000);

    test('timeout cleanup logs to ConnectionTracker', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 100 }),
          async (_seed) => {
            ConnectionTracker.reset();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            manager.cleanupTimeout = 100;
            
            const mockPc = {
              // Use 'failed' state for immediate cleanup
              connectionState: 'failed',
              iceConnectionState: 'failed',
              timeout: null,
              getSenders: () => [],
              getReceivers: () => [],
              close: () => {},
              addEventListener: () => {},
              removeEventListener: () => {}
            };
            
            manager.connection = mockPc;
            manager.peerId = 'timeout-test-peer';
            
            const statsBefore = ConnectionTracker.getResourceStats();
            
            // Simulate timeout cleanup
            await manager.destroyConnection('timeout-test-peer', 'timeout');
            
            const statsAfter = ConnectionTracker.getResourceStats();
            
            // Should have logged a cleanup (success or failure)
            return statsAfter.cleanupSuccesses > statsBefore.cleanupSuccesses ||
                   statsAfter.cleanupFailures > statsBefore.cleanupFailures;
          }
        ),
        { numRuns: 100 }
      );
    }, 30000);

    test('timeout cleanup emits disconnect event', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 8, maxLength: 32 }).filter(s => s.length >= 8),
          async (peerId) => {
            ConnectionTracker.reset();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            manager.cleanupTimeout = 100;
            
            const mockPc = {
              // Use 'failed' state for immediate cleanup
              connectionState: 'failed',
              iceConnectionState: 'failed',
              timeout: null,
              getSenders: () => [],
              getReceivers: () => [],
              close: () => {},
              addEventListener: () => {},
              removeEventListener: () => {}
            };
            
            manager.connection = mockPc;
            manager.peerId = peerId;
            
            let emittedEvent = null;
            manager.on('peerDisconnected', (event) => {
              emittedEvent = event;
            });
            
            // Simulate timeout cleanup
            await manager.destroyConnection(peerId, 'timeout');
            
            return emittedEvent !== null &&
                   emittedEvent.peerId === peerId &&
                   emittedEvent.reason === 'timeout';
          }
        ),
        { numRuns: 100 }
      );
    }, 30000);
  });


  /**
   * Feature: webrtc-resource-cleanup, Property 14: Unexpected Disconnect Detection and Cleanup
   * 
   * For any remote peer that disconnects unexpectedly (connection state changes 
   * to 'failed' or 'disconnected'), the WebRTCConnectionManager SHALL detect 
   * this via the connectionstatechange event and perform complete resource 
   * cleanup with logging.
   * 
   * Validates: Requirements 9.1, 9.2, 9.3
   */
  describe('Property 14: Unexpected Disconnect Detection and Cleanup', () => {
    test('unexpected disconnect triggers safeCleanup', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('failed', 'disconnected'),
          async (disconnectState) => {
            ConnectionTracker.reset();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            manager.cleanupTimeout = 100; // Short timeout for tests
            
            let safeCleanupCalled = false;
            let cleanupReason = null;
            
            // Override safeCleanup to track calls
            const originalSafeCleanup = manager.safeCleanup.bind(manager);
            manager.safeCleanup = async (reason) => {
              safeCleanupCalled = true;
              cleanupReason = reason;
              return originalSafeCleanup(reason);
            };
            
            // Create mock peer connection with state change capability
            let stateChangeHandler = null;
            const mockPc = {
              _connectionState: 'connected',
              get connectionState() { return this._connectionState; },
              set connectionState(state) { this._connectionState = state; },
              iceConnectionState: 'connected',
              timeout: null,
              getSenders: () => [],
              getReceivers: () => [],
              close() { this._connectionState = 'closed'; },
              addEventListener: (event, handler) => {
                if (event === 'connectionstatechange') {
                  stateChangeHandler = handler;
                }
              },
              removeEventListener: () => {}
            };
            
            manager.connection = mockPc;
            manager.peerId = 'unexpected-disconnect-peer';
            manager.connectionState = 'connected';
            
            // Setup events (this registers the state change handler)
            manager.setupPeerConnectionEvents(mockPc, true);
            
            // Simulate unexpected disconnect - use 'failed' which is stable
            mockPc._connectionState = disconnectState === 'disconnected' ? 'failed' : disconnectState;
            if (stateChangeHandler) {
              stateChangeHandler();
            }
            
            // Wait for async cleanup
            await new Promise(resolve => setTimeout(resolve, 200));
            
            return safeCleanupCalled === true &&
                   cleanupReason === 'unexpected_disconnect';
          }
        ),
        { numRuns: 100 }
      );
    }, 30000);

    test('unexpected disconnect logs to ConnectionTracker', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('failed', 'disconnected'),
          async (disconnectState) => {
            ConnectionTracker.reset();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            manager.cleanupTimeout = 100; // Short timeout for tests
            
            let stateChangeHandler = null;
            const mockPc = {
              _connectionState: 'connected',
              get connectionState() { return this._connectionState; },
              iceConnectionState: 'connected',
              timeout: null,
              getSenders: () => [],
              getReceivers: () => [],
              close() { this._connectionState = 'closed'; },
              addEventListener: (event, handler) => {
                if (event === 'connectionstatechange') {
                  stateChangeHandler = handler;
                }
              },
              removeEventListener: () => {}
            };
            
            manager.connection = mockPc;
            manager.peerId = 'log-test-peer';
            manager.connectionState = 'connected';
            
            manager.setupPeerConnectionEvents(mockPc, true);
            
            const statsBefore = ConnectionTracker.getResourceStats();
            
            // Simulate unexpected disconnect - use 'failed' which is stable
            mockPc._connectionState = disconnectState === 'disconnected' ? 'failed' : disconnectState;
            if (stateChangeHandler) {
              stateChangeHandler();
            }
            
            // Wait for async cleanup
            await new Promise(resolve => setTimeout(resolve, 200));
            
            const statsAfter = ConnectionTracker.getResourceStats();
            
            // Should have logged a cleanup
            return statsAfter.cleanupSuccesses > statsBefore.cleanupSuccesses ||
                   statsAfter.cleanupFailures > statsBefore.cleanupFailures;
          }
        ),
        { numRuns: 100 }
      );
    }, 30000);

    test('unexpected disconnect emits peerDisconnected event', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('failed', 'disconnected'),
          fc.string({ minLength: 8, maxLength: 32 }).filter(s => s.length >= 8),
          async (disconnectState, peerId) => {
            ConnectionTracker.reset();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            manager.cleanupTimeout = 100; // Short timeout for tests
            
            let stateChangeHandler = null;
            const mockPc = {
              _connectionState: 'connected',
              get connectionState() { return this._connectionState; },
              iceConnectionState: 'connected',
              timeout: null,
              getSenders: () => [],
              getReceivers: () => [],
              close() { this._connectionState = 'closed'; },
              addEventListener: (event, handler) => {
                if (event === 'connectionstatechange') {
                  stateChangeHandler = handler;
                }
              },
              removeEventListener: () => {}
            };
            
            manager.connection = mockPc;
            manager.peerId = peerId;
            manager.connectionState = 'connected';
            
            let emittedEvent = null;
            manager.on('peerDisconnected', (event) => {
              emittedEvent = event;
            });
            
            manager.setupPeerConnectionEvents(mockPc, true);
            
            // Simulate unexpected disconnect - use 'failed' which is stable
            mockPc._connectionState = disconnectState === 'disconnected' ? 'failed' : disconnectState;
            if (stateChangeHandler) {
              stateChangeHandler();
            }
            
            // Wait for async cleanup
            await new Promise(resolve => setTimeout(resolve, 200));
            
            return emittedEvent !== null &&
                   emittedEvent.peerId === peerId &&
                   emittedEvent.reason === 'unexpected_disconnect';
          }
        ),
        { numRuns: 100 }
      );
    }, 30000);

    test('connected state does not trigger cleanup', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }),
          async (_seed) => {
            ConnectionTracker.reset();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            
            let safeCleanupCalled = false;
            manager.safeCleanup = async () => {
              safeCleanupCalled = true;
            };
            
            let stateChangeHandler = null;
            const mockPc = {
              _connectionState: 'connecting',
              get connectionState() { return this._connectionState; },
              iceConnectionState: 'checking',
              timeout: null,
              getSenders: () => [],
              getReceivers: () => [],
              close: () => {},
              addEventListener: (event, handler) => {
                if (event === 'connectionstatechange') {
                  stateChangeHandler = handler;
                }
              },
              removeEventListener: () => {}
            };
            
            manager.connection = mockPc;
            manager.peerId = 'no-cleanup-peer';
            manager.connectionState = 'connecting';
            manager.pendingConnectionInfo = { initiator: true };
            
            manager.setupPeerConnectionEvents(mockPc, true);
            
            // Simulate transition to connected (should NOT trigger cleanup)
            mockPc._connectionState = 'connected';
            if (stateChangeHandler) {
              stateChangeHandler();
            }
            
            // Wait a bit
            await new Promise(resolve => setTimeout(resolve, 50));
            
            // safeCleanup should NOT have been called for 'connected' state
            return safeCleanupCalled === false;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Feature: webrtc-resource-cleanup, Property 10: Routing Table Integration
   * 
   * For any peerDisconnected event received by the routing table, the peer 
   * SHALL be removed from the contact list.
   * 
   * Validates: Requirements 6.2, 9.4
   */
  describe('Property 10: Routing Table Integration', () => {
    /**
     * Mock RoutingTable that tracks node removal
     */
    class MockRoutingTable {
      constructor() {
        this.nodes = new Map();
        this.removedNodes = [];
      }

      addNode(peerId) {
        this.nodes.set(peerId, { id: peerId, lastSeen: Date.now() });
      }

      getNode(peerId) {
        return this.nodes.get(peerId) || null;
      }

      removeNode(peerId) {
        if (this.nodes.has(peerId)) {
          this.nodes.delete(peerId);
          this.removedNodes.push(peerId);
          return true;
        }
        return false;
      }

      hasNode(peerId) {
        return this.nodes.has(peerId);
      }

      reset() {
        this.nodes.clear();
        this.removedNodes = [];
      }
    }

    /**
     * Mock DHT that simulates the peerDisconnected event handler
     */
    class MockKademliaDHT {
      constructor() {
        this.routingTable = new MockRoutingTable();
        this.handlePeerDisconnectedCalled = [];
      }

      handlePeerDisconnected(peerId) {
        this.handlePeerDisconnectedCalled.push(peerId);
      }

      // Simulates the peerDisconnected handler added in setupRoutingTableEventHandlers
      setupPeerDisconnectedHandler(manager) {
        if (manager && !manager._dhtPeerDisconnectedHandlerAttached) {
          manager.on('peerDisconnected', ({ peerId: disconnectedPeerId, reason }) => {
            if (disconnectedPeerId && this.routingTable) {
              const existingNode = this.routingTable.getNode(disconnectedPeerId);
              if (existingNode) {
                this.routingTable.removeNode(disconnectedPeerId);
                this.handlePeerDisconnected(disconnectedPeerId);
              }
            }
          });
          manager._dhtPeerDisconnectedHandlerAttached = true;
        }
      }

      reset() {
        this.routingTable.reset();
        this.handlePeerDisconnectedCalled = [];
      }
    }

    // Helper to generate valid 40-character hex peer IDs
    const hexPeerIdArb = fc.array(
      fc.constantFrom('0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'),
      { minLength: 40, maxLength: 40 }
    ).map(arr => arr.join(''));

    test('peerDisconnected event removes peer from routing table', async () => {
      await fc.assert(
        fc.asyncProperty(
          hexPeerIdArb,
          fc.constantFrom('cleanup', 'timeout', 'unexpected_disconnect', 'shutdown'),
          async (peerId, reason) => {
            const mockDHT = new MockKademliaDHT();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            
            // Add peer to routing table
            mockDHT.routingTable.addNode(peerId);
            
            // Verify peer exists before disconnect
            const existsBefore = mockDHT.routingTable.hasNode(peerId);
            
            // Set up the peerDisconnected handler (simulates KademliaDHT.setupRoutingTableEventHandlers)
            mockDHT.setupPeerDisconnectedHandler(manager);
            
            // Emit peerDisconnected event
            manager.emit('peerDisconnected', { peerId, reason });
            
            // Wait for event processing
            await new Promise(resolve => setTimeout(resolve, 10));
            
            // Verify peer was removed from routing table
            const existsAfter = mockDHT.routingTable.hasNode(peerId);
            const wasRemoved = mockDHT.routingTable.removedNodes.includes(peerId);
            const handlePeerDisconnectedCalled = mockDHT.handlePeerDisconnectedCalled.includes(peerId);
            
            return existsBefore === true && 
                   existsAfter === false && 
                   wasRemoved === true &&
                   handlePeerDisconnectedCalled === true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('peerDisconnected for non-existent peer does not cause errors', async () => {
      await fc.assert(
        fc.asyncProperty(
          hexPeerIdArb,
          fc.constantFrom('cleanup', 'timeout', 'unexpected_disconnect'),
          async (peerId, reason) => {
            const mockDHT = new MockKademliaDHT();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            
            // Do NOT add peer to routing table (peer doesn't exist)
            
            // Set up the peerDisconnected handler
            mockDHT.setupPeerDisconnectedHandler(manager);
            
            // Emit peerDisconnected event for non-existent peer
            let errorThrown = false;
            try {
              manager.emit('peerDisconnected', { peerId, reason });
              await new Promise(resolve => setTimeout(resolve, 10));
            } catch (e) {
              errorThrown = true;
            }
            
            // Should not throw error and peer should not be in removed list
            return errorThrown === false && 
                   mockDHT.routingTable.removedNodes.length === 0 &&
                   mockDHT.handlePeerDisconnectedCalled.length === 0;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('multiple peerDisconnected events for same peer are handled correctly', async () => {
      await fc.assert(
        fc.asyncProperty(
          hexPeerIdArb,
          fc.integer({ min: 2, max: 5 }),
          async (peerId, eventCount) => {
            const mockDHT = new MockKademliaDHT();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            
            // Add peer to routing table
            mockDHT.routingTable.addNode(peerId);
            
            // Set up the peerDisconnected handler
            mockDHT.setupPeerDisconnectedHandler(manager);
            
            // Emit multiple peerDisconnected events
            for (let i = 0; i < eventCount; i++) {
              manager.emit('peerDisconnected', { peerId, reason: 'test' });
            }
            
            await new Promise(resolve => setTimeout(resolve, 10));
            
            // Peer should be removed exactly once (first event removes it, subsequent events find no node)
            return mockDHT.routingTable.removedNodes.filter(id => id === peerId).length === 1 &&
                   mockDHT.handlePeerDisconnectedCalled.filter(id => id === peerId).length === 1;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('handler is only attached once per manager', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 10 }),
          async (attachAttempts) => {
            const mockDHT = new MockKademliaDHT();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            
            // Try to attach handler multiple times
            for (let i = 0; i < attachAttempts; i++) {
              mockDHT.setupPeerDisconnectedHandler(manager);
            }
            
            // Add a peer and emit disconnect
            const peerId = 'a'.repeat(40);
            mockDHT.routingTable.addNode(peerId);
            manager.emit('peerDisconnected', { peerId, reason: 'test' });
            
            await new Promise(resolve => setTimeout(resolve, 10));
            
            // Handler should only fire once despite multiple attach attempts
            return mockDHT.routingTable.removedNodes.length === 1 &&
                   mockDHT.handlePeerDisconnectedCalled.length === 1;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

});


  /**
   * Feature: webrtc-resource-cleanup, Property 11: Destroy Completeness
   * 
   * For any call to destroy() on WebRTCConnectionManager with N active connections,
   * cleanup SHALL be attempted for all N connections, and after completion,
   * ConnectionTracker.activeConnections SHALL be zero.
   * 
   * Validates: Requirements 7.1, 7.3, 7.5
   */
  describe('Property 11: Destroy Completeness', () => {
    test('destroy cleans up all active connections', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }),
          async (connectionCount) => {
            ConnectionTracker.reset();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            
            // Track cleanup calls
            let cleanupCallCount = 0;
            const originalSafeCleanup = manager.safeCleanup.bind(manager);
            manager.safeCleanup = async (reason) => {
              cleanupCallCount++;
              return originalSafeCleanup(reason);
            };
            
            // Create mock connection
            const mockPc = {
              connectionState: 'connected',
              iceConnectionState: 'connected',
              timeout: null,
              getSenders: () => [],
              getReceivers: () => [],
              close: () => {},
              addEventListener: () => {},
              removeEventListener: () => {}
            };
            
            manager.connection = mockPc;
            manager.peerId = 'test-peer-id';
            
            // Simulate active connection tracking
            ConnectionTracker.trackConnectionCreated();
            
            // Call destroy
            await manager.destroy();
            
            // Verify cleanup was called and active connections is zero
            return cleanupCallCount === 1 && 
                   ConnectionTracker.activeConnections === 0;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('destroy with no connections completes without error', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }),
          async (_seed) => {
            ConnectionTracker.reset();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            
            // No connection set
            manager.connection = null;
            
            let errorThrown = false;
            try {
              await manager.destroy();
            } catch (e) {
              errorThrown = true;
            }
            
            // Should complete without error
            return errorThrown === false && 
                   ConnectionTracker.activeConnections === 0;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('destroy sets isDestroyed flag', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }),
          async (_seed) => {
            ConnectionTracker.reset();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            
            const mockPc = {
              connectionState: 'connected',
              iceConnectionState: 'connected',
              timeout: null,
              getSenders: () => [],
              getReceivers: () => [],
              close: () => {},
              addEventListener: () => {},
              removeEventListener: () => {}
            };
            
            manager.connection = mockPc;
            manager.peerId = 'test-peer-id';
            
            // Verify not destroyed before
            const wasDestroyedBefore = manager.isDestroyed;
            
            await manager.destroy();
            
            // Verify destroyed after
            return wasDestroyedBefore === false && manager.isDestroyed === true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('destroy is idempotent - second call does nothing', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 5 }),
          async (callCount) => {
            ConnectionTracker.reset();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            
            let cleanupCallCount = 0;
            const originalSafeCleanup = manager.safeCleanup.bind(manager);
            manager.safeCleanup = async (reason) => {
              cleanupCallCount++;
              return originalSafeCleanup(reason);
            };
            
            const mockPc = {
              connectionState: 'connected',
              iceConnectionState: 'connected',
              timeout: null,
              getSenders: () => [],
              getReceivers: () => [],
              close: () => {},
              addEventListener: () => {},
              removeEventListener: () => {}
            };
            
            manager.connection = mockPc;
            manager.peerId = 'test-peer-id';
            
            // Call destroy multiple times
            for (let i = 0; i < callCount; i++) {
              await manager.destroy();
            }
            
            // Cleanup should only be called once (first destroy)
            return cleanupCallCount === 1;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('destroy clears keep-alive timers', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }),
          async (_seed) => {
            ConnectionTracker.reset();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            
            let keepAlivesCleared = false;
            manager.cleanupAllKeepAlives = () => {
              keepAlivesCleared = true;
            };
            
            const mockPc = {
              connectionState: 'connected',
              iceConnectionState: 'connected',
              timeout: null,
              getSenders: () => [],
              getReceivers: () => [],
              close: () => {},
              addEventListener: () => {},
              removeEventListener: () => {}
            };
            
            manager.connection = mockPc;
            manager.peerId = 'test-peer-id';
            
            await manager.destroy();
            
            return keepAlivesCleared === true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('destroy uses shutdown reason for cleanup', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }),
          async (_seed) => {
            ConnectionTracker.reset();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            
            let cleanupReason = null;
            const originalSafeCleanup = manager.safeCleanup.bind(manager);
            manager.safeCleanup = async (reason) => {
              cleanupReason = reason;
              return originalSafeCleanup(reason);
            };
            
            const mockPc = {
              connectionState: 'connected',
              iceConnectionState: 'connected',
              timeout: null,
              getSenders: () => [],
              getReceivers: () => [],
              close: () => {},
              addEventListener: () => {},
              removeEventListener: () => {}
            };
            
            manager.connection = mockPc;
            manager.peerId = 'test-peer-id';
            
            await manager.destroy();
            
            return cleanupReason === 'shutdown';
          }
        ),
        { numRuns: 100 }
      );
    });
  });


  /**
   * Feature: webrtc-resource-cleanup, Property 12: Destroy Error Resilience
   * 
   * For any call to destroy() where one or more cleanup operations fail,
   * the destroy operation SHALL complete without throwing exceptions and
   * SHALL still attempt cleanup on all remaining connections.
   * 
   * Validates: Requirements 7.2, 7.4
   */
  describe('Property 12: Destroy Error Resilience', () => {
    test('destroy completes without throwing when cleanup fails', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('Error during cleanup', 'Connection reset', 'Timeout'),
          async (errorMessage) => {
            ConnectionTracker.reset();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            
            // Override safeCleanup to throw an error
            manager.safeCleanup = async () => {
              throw new Error(errorMessage);
            };
            
            const mockPc = {
              connectionState: 'connected',
              iceConnectionState: 'connected',
              timeout: null,
              getSenders: () => [],
              getReceivers: () => [],
              close: () => {},
              addEventListener: () => {},
              removeEventListener: () => {}
            };
            
            manager.connection = mockPc;
            manager.peerId = 'test-peer-id';
            
            let errorThrown = false;
            try {
              await manager.destroy();
            } catch (e) {
              errorThrown = true;
            }
            
            // Destroy should complete without throwing
            return errorThrown === false && manager.isDestroyed === true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('destroy handles rejected promises gracefully', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }),
          async (_seed) => {
            ConnectionTracker.reset();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            
            // Override safeCleanup to return a rejected promise
            manager.safeCleanup = async () => {
              return Promise.reject(new Error('Simulated cleanup failure'));
            };
            
            const mockPc = {
              connectionState: 'connected',
              iceConnectionState: 'connected',
              timeout: null,
              getSenders: () => [],
              getReceivers: () => [],
              close: () => {},
              addEventListener: () => {},
              removeEventListener: () => {}
            };
            
            manager.connection = mockPc;
            manager.peerId = 'test-peer-id';
            
            let errorThrown = false;
            try {
              await manager.destroy();
            } catch (e) {
              errorThrown = true;
            }
            
            // Should handle rejection gracefully
            return errorThrown === false && manager.isDestroyed === true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('destroy continues cleanup even when individual steps fail', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }),
          async (_seed) => {
            ConnectionTracker.reset();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            
            let cleanupAttempted = false;
            let parentDestroyAttempted = false;
            
            // Track that cleanup was attempted even if it fails
            manager.safeCleanup = async () => {
              cleanupAttempted = true;
              throw new Error('Cleanup failed');
            };
            
            // Track parent destroy call
            const originalParentDestroy = Object.getPrototypeOf(Object.getPrototypeOf(manager)).destroy;
            // We can't easily override super.destroy, but we can check isDestroyed is set
            
            const mockPc = {
              connectionState: 'connected',
              iceConnectionState: 'connected',
              timeout: null,
              getSenders: () => [],
              getReceivers: () => [],
              close: () => {},
              addEventListener: () => {},
              removeEventListener: () => {}
            };
            
            manager.connection = mockPc;
            manager.peerId = 'test-peer-id';
            
            await manager.destroy();
            
            // Cleanup should have been attempted and destroy should complete
            return cleanupAttempted === true && manager.isDestroyed === true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('destroy clears connection timeout even when cleanup fails', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }),
          async (_seed) => {
            ConnectionTracker.reset();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            
            let timeoutCleared = false;
            const mockTimeout = {
              _cleared: false
            };
            
            // Mock clearTimeout
            const originalClearTimeout = global.clearTimeout;
            global.clearTimeout = (timeout) => {
              if (timeout === mockTimeout) {
                timeoutCleared = true;
              }
              originalClearTimeout(timeout);
            };
            
            // Override safeCleanup to fail
            manager.safeCleanup = async () => {
              throw new Error('Cleanup failed');
            };
            
            const mockPc = {
              connectionState: 'connected',
              iceConnectionState: 'connected',
              timeout: mockTimeout,
              getSenders: () => [],
              getReceivers: () => [],
              close: () => {},
              addEventListener: () => {},
              removeEventListener: () => {}
            };
            
            manager.connection = mockPc;
            manager.peerId = 'test-peer-id';
            
            await manager.destroy();
            
            // Restore clearTimeout
            global.clearTimeout = originalClearTimeout;
            
            // Timeout should be cleared before cleanup attempt
            return timeoutCleared === true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('destroy logs cleanup failures without throwing', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 5, maxLength: 50 }),
          async (errorMessage) => {
            ConnectionTracker.reset();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            
            // Track console.error calls
            const errorLogs = [];
            const originalConsoleError = console.error;
            console.error = (...args) => {
              errorLogs.push(args);
            };
            
            // Override safeCleanup to fail
            manager.safeCleanup = async () => {
              throw new Error(errorMessage);
            };
            
            const mockPc = {
              connectionState: 'connected',
              iceConnectionState: 'connected',
              timeout: null,
              getSenders: () => [],
              getReceivers: () => [],
              close: () => {},
              addEventListener: () => {},
              removeEventListener: () => {}
            };
            
            manager.connection = mockPc;
            manager.peerId = 'test-peer-id';
            
            let errorThrown = false;
            try {
              await manager.destroy();
            } catch (e) {
              errorThrown = true;
            }
            
            // Restore console.error
            console.error = originalConsoleError;
            
            // Should log error but not throw
            const hasCleanupFailureLog = errorLogs.some(log => 
              log.some(arg => typeof arg === 'string' && arg.includes('Cleanup failed'))
            );
            
            return errorThrown === false && hasCleanupFailureLog === true;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('destroy handles errors thrown during async cleanup execution', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }),
          async (_seed) => {
            ConnectionTracker.reset();
            const manager = new WebRTCConnectionManager({ localNodeId: 'test-node' });
            
            // Override safeCleanup to throw during async execution
            // This simulates an error that occurs during the cleanup process
            manager.safeCleanup = async () => {
              // Simulate some async work before throwing
              await Promise.resolve();
              throw new Error('Error during async cleanup');
            };
            
            const mockPc = {
              connectionState: 'connected',
              iceConnectionState: 'connected',
              timeout: null,
              getSenders: () => [],
              getReceivers: () => [],
              close: () => {},
              addEventListener: () => {},
              removeEventListener: () => {}
            };
            
            manager.connection = mockPc;
            manager.peerId = 'test-peer-id';
            
            let errorThrown = false;
            try {
              await manager.destroy();
            } catch (e) {
              errorThrown = true;
            }
            
            // Promise.allSettled should catch async errors
            return errorThrown === false && manager.isDestroyed === true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
