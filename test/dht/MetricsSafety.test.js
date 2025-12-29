/**
 * Data Transfer Metrics Safety Tests
 * 
 * Tests for Requirement 5: Data Transfer Metrics Safety
 * - 5.1: Metrics recording doesn't interfere with message processing
 * - 5.2: Graceful handling of JSON serialization errors
 * - 5.3: Metrics tracking is completely optional and fail-safe
 * - 5.4: System operates identically when metrics are disabled
 * - 5.5: Fallback mechanisms when metrics tracking fails
 */

import { KademliaDHT } from '../../src/dht/KademliaDHT.js';
import { jest } from '@jest/globals';

describe('Data Transfer Metrics Safety', () => {
  let dht;

  beforeEach(() => {
    // Create a minimal DHT instance for testing
    dht = new KademliaDHT({
      bootstrapServers: ['ws://localhost:8080'],
      metricsEnabled: true
    });
  });

  afterEach(() => {
    if (dht) {
      dht.removeAllListeners();
    }
  });

  describe('Requirement 5.1: Non-interfering metrics', () => {
    test('safeRecordMetrics returns false when no tracker is available', () => {
      // No metrics tracker set
      dht.metricsTracker = null;
      const result = dht.safeRecordMetrics(100, 0);
      expect(result).toBe(false);
    });

    test('safeRecordMetrics returns false when metrics are disabled', () => {
      dht.metricsEnabled = false;
      const result = dht.safeRecordMetrics(100, 0);
      expect(result).toBe(false);
    });

    test('safeRecordMetrics returns true when tracker is available and working', () => {
      // Mock a working metrics tracker
      let called = false;
      let calledWith = null;
      dht.metricsTracker = {
        recordDataTransfer: (sent, received) => {
          called = true;
          calledWith = { sent, received };
        }
      };
      const result = dht.safeRecordMetrics(100, 50);
      expect(result).toBe(true);
      expect(called).toBe(true);
      expect(calledWith).toEqual({ sent: 100, received: 50 });
    });
  });

  describe('Requirement 5.2: JSON serialization error handling', () => {
    test('calculateMessageSize handles null message', () => {
      const size = dht.calculateMessageSize(null);
      expect(size).toBe(0);
    });

    test('calculateMessageSize handles undefined message', () => {
      const size = dht.calculateMessageSize(undefined);
      expect(size).toBe(0);
    });

    test('calculateMessageSize handles normal objects', () => {
      const message = { type: 'ping', data: 'test' };
      const size = dht.calculateMessageSize(message);
      expect(size).toBeGreaterThan(0);
    });

    test('calculateMessageSize handles circular references gracefully', () => {
      const message = { type: 'test' };
      message.self = message; // Create circular reference
      
      // Should not throw, should return a size (with [Circular] placeholder)
      const size = dht.calculateMessageSize(message);
      expect(size).toBeGreaterThan(0);
    });

    test('calculateMessageSize handles functions in objects', () => {
      const message = { 
        type: 'test', 
        callback: () => {} // Function should be skipped
      };
      const size = dht.calculateMessageSize(message);
      expect(size).toBeGreaterThan(0);
    });
  });

  describe('Requirement 5.3: Optional and fail-safe metrics', () => {
    test('setMetricsEnabled can disable metrics', () => {
      dht.setMetricsEnabled(false);
      expect(dht.metricsEnabled).toBe(false);
    });

    test('setMetricsEnabled can enable metrics', () => {
      dht.metricsEnabled = false;
      dht.setMetricsEnabled(true);
      expect(dht.metricsEnabled).toBe(true);
    });

    test('setMetricsEnabled resets failure tracking when re-enabling', () => {
      dht.metricsFailureCount = 5;
      dht.metricsDisabledDueToFailures = true;
      
      dht.setMetricsEnabled(true);
      
      expect(dht.metricsFailureCount).toBe(0);
      expect(dht.metricsDisabledDueToFailures).toBe(false);
    });

    test('safeRecordMetrics handles tracker errors gracefully', () => {
      dht.metricsTracker = {
        recordDataTransfer: () => {
          throw new Error('Tracker error');
        }
      };
      
      // Should not throw, should return false
      const result = dht.safeRecordMetrics(100, 0);
      expect(result).toBe(false);
      expect(dht.metricsFailureCount).toBe(1);
    });
  });

  describe('Requirement 5.4: Identical operation when disabled', () => {
    test('getMetricsStatus returns correct status when enabled', () => {
      dht.metricsEnabled = true;
      dht.metricsTracker = { recordDataTransfer: () => {} };
      
      const status = dht.getMetricsStatus();
      
      expect(status.enabled).toBe(true);
      expect(status.trackerAvailable).toBe(true);
      expect(status.failureCount).toBe(0);
      expect(status.autoDisabled).toBe(false);
    });

    test('getMetricsStatus returns correct status when disabled', () => {
      dht.metricsEnabled = false;
      
      const status = dht.getMetricsStatus();
      
      expect(status.enabled).toBe(false);
    });
  });

  describe('Requirement 5.5: Fallback mechanisms', () => {
    test('metrics auto-disable after max failures', () => {
      dht.metricsTracker = {
        recordDataTransfer: () => {
          throw new Error('Persistent error');
        }
      };
      
      // Trigger max failures
      for (let i = 0; i < dht.metricsMaxFailures; i++) {
        dht.safeRecordMetrics(100, 0);
      }
      
      expect(dht.metricsDisabledDueToFailures).toBe(true);
      
      // Further calls should be skipped
      const result = dht.safeRecordMetrics(100, 0);
      expect(result).toBe(false);
    });

    test('failure count resets on successful recording', () => {
      dht.metricsFailureCount = 5;
      dht.metricsTracker = {
        recordDataTransfer: () => {}
      };
      
      dht.safeRecordMetrics(100, 0);
      
      expect(dht.metricsFailureCount).toBe(0);
    });

    test('safeRecordMetrics skips when tracker has invalid recordDataTransfer', () => {
      dht.metricsTracker = {
        recordDataTransfer: 'not a function'
      };
      
      const result = dht.safeRecordMetrics(100, 0);
      expect(result).toBe(false);
    });
  });

  describe('Default configuration', () => {
    test('metrics are enabled by default', () => {
      const newDht = new KademliaDHT({
        bootstrapServers: ['ws://localhost:8080']
      });
      expect(newDht.metricsEnabled).toBe(true);
    });

    test('metrics can be disabled via constructor option', () => {
      const newDht = new KademliaDHT({
        bootstrapServers: ['ws://localhost:8080'],
        metricsEnabled: false
      });
      expect(newDht.metricsEnabled).toBe(false);
    });
  });
});
