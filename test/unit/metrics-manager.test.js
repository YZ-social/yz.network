/**
 * Property-based tests for MetricsManager
 * 
 * Feature: browser-mesh-stability-tests
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.6
 */
import { describe, test } from '@jest/globals';
import fc from 'fast-check';
import { MetricsManager } from '../browser/helpers/MetricsManager';
import { ConnectionMetrics } from '../browser/helpers/ConnectionMetrics';

describe('MetricsManager Property Tests', () => {
  
  /**
   * Property 5: Uptime calculation correctness
   * For any connection with recorded connect/disconnect events, the uptime percentage 
   * SHALL equal (total connected time / total monitoring time) * 100
   * 
   * Validates: Requirements 4.1
   */
  describe('Property 5: Uptime calculation correctness', () => {
    test('uptime equals (connected time / total time) * 100', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1000, max: 100000 }),
          fc.integer({ min: 0, max: 100000 }),
          (connectedTime, disconnectedTime) => {
            const metrics = new ConnectionMetrics('test-peer');
            const startTime = 0;
            
            metrics.recordConnect(startTime);
            if (disconnectedTime > 0) {
              metrics.recordDisconnect(connectedTime);
              metrics.finalize(connectedTime + disconnectedTime);
            } else {
              metrics.finalize(connectedTime);
            }
            
            const totalTime = metrics.getTotalTime();
            if (totalTime === 0) return true;
            
            const expectedUptime = (metrics.totalConnectedTime / totalTime) * 100;
            const manager = new MetricsManager();
            manager.connections.set('test-peer', metrics);
            
            const actualUptime = manager.calculateUptime('test-peer');
            
            return Math.abs(actualUptime - expectedUptime) < 0.0001;
          }
        ),
        { numRuns: 100 }
      );
    });
  });


  /**
   * Property 6: Churn rate calculation correctness
   * For any monitoring period with recorded disconnect events, the churn rate 
   * SHALL equal (total disconnects / monitoring duration in minutes)
   * 
   * Validates: Requirements 4.2
   */
  describe('Property 6: Churn rate calculation correctness', () => {
    test('churn rate equals disconnects per minute', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 60000, max: 600000 }),
          (disconnectCount, durationMs) => {
            const manager = new MetricsManager();
            manager.start(0);
            
            const interval = Math.floor(durationMs / (disconnectCount + 1));
            for (let i = 0; i < disconnectCount; i++) {
              const timestamp = interval * (i + 1);
              manager.recordEvent('disconnect', `peer-${i}`, timestamp);
            }
            
            manager.stop(durationMs);
            
            const expectedChurnRate = disconnectCount / (durationMs / 60000);
            const actualChurnRate = manager.calculateChurnRate();
            
            // Use relative tolerance for floating point comparison
            const tolerance = Math.max(0.0001, Math.abs(expectedChurnRate) * 0.0001);
            return Math.abs(actualChurnRate - expectedChurnRate) < tolerance;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 7: MTBF calculation correctness
   * For any connection with at least one failure, the MTBF SHALL equal 
   * (total uptime / number of failures). For connections with zero failures, MTBF SHALL be null.
   * 
   * Validates: Requirements 4.3
   */
  describe('Property 7: MTBF calculation correctness', () => {
    test('MTBF equals total uptime divided by failure count', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 10 }),
          fc.integer({ min: 10000, max: 100000 }),
          (failureCount, totalUptime) => {
            const manager = new MetricsManager();
            const peerId = 'test-peer';
            
            const metrics = new ConnectionMetrics(peerId);
            metrics.totalConnectedTime = totalUptime;
            
            for (let i = 0; i < failureCount; i++) {
              metrics.disconnectTimes.push(i * 1000);
            }
            
            manager.connections.set(peerId, metrics);
            
            const expectedMTBF = totalUptime / failureCount;
            const actualMTBF = manager.calculateMTBF(peerId);
            
            return Math.abs(actualMTBF - expectedMTBF) < 0.0001;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('MTBF is null when no failures', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 10000, max: 100000 }),
          (totalUptime) => {
            const manager = new MetricsManager();
            const peerId = 'test-peer';
            
            const metrics = new ConnectionMetrics(peerId);
            metrics.totalConnectedTime = totalUptime;
            
            manager.connections.set(peerId, metrics);
            
            return manager.calculateMTBF(peerId) === null;
          }
        ),
        { numRuns: 100 }
      );
    });
  });


  /**
   * Property 8: Event count invariant
   * For any MetricsManager instance, the total event count SHALL equal 
   * the sum of connect events + disconnect events + reconnect events.
   * 
   * Validates: Requirements 4.4
   */
  describe('Property 8: Event count invariant', () => {
    test('total events equals sum of connect + disconnect + reconnect', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 50 }),
          fc.integer({ min: 0, max: 50 }),
          fc.integer({ min: 0, max: 50 }),
          (connectCount, disconnectCount, reconnectCount) => {
            const manager = new MetricsManager();
            let timestamp = 0;
            
            for (let i = 0; i < connectCount; i++) {
              manager.recordEvent('connect', `peer-${i}`, timestamp++);
            }
            for (let i = 0; i < disconnectCount; i++) {
              manager.recordEvent('disconnect', `peer-${i}`, timestamp++);
            }
            for (let i = 0; i < reconnectCount; i++) {
              manager.recordEvent('reconnect', `peer-${i}`, timestamp++);
            }
            
            const counts = manager.getEventCounts();
            const totalFromCounts = counts.connect + counts.disconnect + counts.reconnect;
            const totalEvents = manager.events.length;
            
            return totalFromCounts === totalEvents &&
                   counts.connect === connectCount &&
                   counts.disconnect === disconnectCount &&
                   counts.reconnect === reconnectCount;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  /**
   * Property 9: Stability threshold correctness
   * For any connection, isStable SHALL return true if and only if uptime >= 99%.
   * 
   * Validates: Requirements 4.6
   */
  describe('Property 9: Stability threshold correctness', () => {
    test('isStable returns true iff uptime >= 99%', () => {
      fc.assert(
        fc.property(
          fc.float({ min: 0, max: 100, noNaN: true }),
          (uptimePercent) => {
            const manager = new MetricsManager();
            const peerId = 'test-peer';
            
            const metrics = new ConnectionMetrics(peerId);
            const totalTime = 100000;
            metrics.totalConnectedTime = Math.floor(totalTime * uptimePercent / 100);
            metrics.totalDisconnectedTime = totalTime - metrics.totalConnectedTime;
            
            manager.connections.set(peerId, metrics);
            
            const isStable = manager.isStable(peerId);
            const actualUptime = manager.calculateUptime(peerId);
            
            return isStable === (actualUptime >= 99);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});


/**
 * Property 4: Event tracking accuracy
 * For any sequence of connection state changes (connect, disconnect, reconnect),
 * the MetricsManager SHALL record each event with a timestamp, and the recorded
 * event count SHALL equal the actual number of state changes that occurred.
 * 
 * Feature: browser-mesh-stability-tests, Property 4: Event tracking accuracy
 * Validates: Requirements 3.1, 3.2
 */
describe('Property 4: Event tracking accuracy', () => {
  
  /**
   * Generator for random event sequences
   */
  const eventTypeArb = fc.constantFrom('connect', 'disconnect', 'reconnect');
  const peerIdArb = fc.string({ minLength: 8, maxLength: 16 }).map(s => `peer-${s.replace(/[^a-z0-9]/gi, 'x')}`);
  
  const eventArb = fc.record({
    type: eventTypeArb,
    peerId: peerIdArb,
    timestampOffset: fc.integer({ min: 0, max: 100000 })
  });

  test('recorded event count equals actual state changes', () => {
    fc.assert(
      fc.property(
        fc.array(eventArb, { minLength: 1, maxLength: 100 }),
        (events) => {
          const manager = new MetricsManager();
          const baseTimestamp = Date.now();
          
          // Record all events
          for (const event of events) {
            const timestamp = baseTimestamp + event.timestampOffset;
            manager.recordEvent(event.type, event.peerId, timestamp, {});
          }
          
          // Verify event count matches
          const recordedCount = manager.events.length;
          const expectedCount = events.length;
          
          return recordedCount === expectedCount;
        }
      ),
      { numRuns: 100 }
    );
  });

  test('each recorded event has a valid timestamp', () => {
    fc.assert(
      fc.property(
        fc.array(eventArb, { minLength: 1, maxLength: 50 }),
        (events) => {
          const manager = new MetricsManager();
          const baseTimestamp = 1000000;
          
          // Record all events
          for (const event of events) {
            const timestamp = baseTimestamp + event.timestampOffset;
            manager.recordEvent(event.type, event.peerId, timestamp, {});
          }
          
          // Verify all recorded events have timestamps
          for (const recorded of manager.events) {
            if (typeof recorded.timestamp !== 'number') return false;
            if (recorded.timestamp < baseTimestamp) return false;
          }
          
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  test('event types are preserved accurately', () => {
    fc.assert(
      fc.property(
        fc.array(eventArb, { minLength: 1, maxLength: 50 }),
        (events) => {
          const manager = new MetricsManager();
          const baseTimestamp = 1000000;
          
          // Record all events
          for (const event of events) {
            const timestamp = baseTimestamp + event.timestampOffset;
            manager.recordEvent(event.type, event.peerId, timestamp, {});
          }
          
          // Verify event types match
          for (let i = 0; i < events.length; i++) {
            if (manager.events[i].type !== events[i].type) return false;
          }
          
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  test('peer IDs are preserved accurately', () => {
    fc.assert(
      fc.property(
        fc.array(eventArb, { minLength: 1, maxLength: 50 }),
        (events) => {
          const manager = new MetricsManager();
          const baseTimestamp = 1000000;
          
          // Record all events
          for (const event of events) {
            const timestamp = baseTimestamp + event.timestampOffset;
            manager.recordEvent(event.type, event.peerId, timestamp, {});
          }
          
          // Verify peer IDs match
          for (let i = 0; i < events.length; i++) {
            if (manager.events[i].peerId !== events[i].peerId) return false;
          }
          
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  test('disconnect events are tracked with timestamps (Requirement 3.1)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.array(peerIdArb, { minLength: 1, maxLength: 10 }),
        (disconnectCount, peerIds) => {
          const manager = new MetricsManager();
          const baseTimestamp = 1000000;
          let expectedDisconnects = 0;
          
          // Generate disconnect events for random peers
          for (let i = 0; i < disconnectCount; i++) {
            const peerId = peerIds[i % peerIds.length];
            const timestamp = baseTimestamp + (i * 1000);
            manager.recordEvent('disconnect', peerId, timestamp, {});
            expectedDisconnects++;
          }
          
          // Verify all disconnect events are tracked
          const disconnectEvents = manager.events.filter(e => e.type === 'disconnect');
          
          if (disconnectEvents.length !== expectedDisconnects) return false;
          
          // Verify each has a timestamp
          for (const event of disconnectEvents) {
            if (typeof event.timestamp !== 'number') return false;
          }
          
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  test('reconnect events are tracked with timestamps (Requirement 3.2)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.array(peerIdArb, { minLength: 1, maxLength: 10 }),
        (reconnectCount, peerIds) => {
          const manager = new MetricsManager();
          const baseTimestamp = 1000000;
          let expectedReconnects = 0;
          
          // Generate reconnect events for random peers
          for (let i = 0; i < reconnectCount; i++) {
            const peerId = peerIds[i % peerIds.length];
            const timestamp = baseTimestamp + (i * 1000);
            manager.recordEvent('reconnect', peerId, timestamp, {});
            expectedReconnects++;
          }
          
          // Verify all reconnect events are tracked
          const reconnectEvents = manager.events.filter(e => e.type === 'reconnect');
          
          if (reconnectEvents.length !== expectedReconnects) return false;
          
          // Verify each has a timestamp
          for (const event of reconnectEvents) {
            if (typeof event.timestamp !== 'number') return false;
          }
          
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});
