import { ConnectionStates, ConnectionTracker } from '../../src/network/ConnectionTracker.js';

/**
 * ConnectionTracker Unit Tests
 * 
 * Tests for the ConnectionStates utility and ConnectionTracker singleton class.
 * 
 * Requirements: 1.4, 1.5, 4.1, 4.2, 4.3, 4.4, 4.5
 */
describe('ConnectionStates', () => {
  describe('State Classification', () => {
    test('should classify "new" as transitional', () => {
      expect(ConnectionStates.isTransitional('new')).toBe(true);
      expect(ConnectionStates.isStable('new')).toBe(false);
    });

    test('should classify "connecting" as transitional', () => {
      expect(ConnectionStates.isTransitional('connecting')).toBe(true);
      expect(ConnectionStates.isStable('connecting')).toBe(false);
    });

    test('should classify "disconnected" as transitional', () => {
      expect(ConnectionStates.isTransitional('disconnected')).toBe(true);
      expect(ConnectionStates.isStable('disconnected')).toBe(false);
    });

    test('should classify "connected" as stable', () => {
      expect(ConnectionStates.isStable('connected')).toBe(true);
      expect(ConnectionStates.isTransitional('connected')).toBe(false);
    });

    test('should classify "failed" as stable', () => {
      expect(ConnectionStates.isStable('failed')).toBe(true);
      expect(ConnectionStates.isTransitional('failed')).toBe(false);
    });

    test('should classify "closed" as stable', () => {
      expect(ConnectionStates.isStable('closed')).toBe(true);
      expect(ConnectionStates.isTransitional('closed')).toBe(false);
    });

    test('should return false for unknown states', () => {
      expect(ConnectionStates.isTransitional('unknown')).toBe(false);
      expect(ConnectionStates.isStable('unknown')).toBe(false);
    });
  });
});


describe('ConnectionTracker', () => {
  beforeEach(() => {
    ConnectionTracker.reset();
  });

  describe('trackConnectionCreated', () => {
    test('should increment active connection count', () => {
      expect(ConnectionTracker.activeConnections).toBe(0);
      
      ConnectionTracker.trackConnectionCreated();
      expect(ConnectionTracker.activeConnections).toBe(1);
      
      ConnectionTracker.trackConnectionCreated();
      expect(ConnectionTracker.activeConnections).toBe(2);
    });
  });

  describe('trackConnectionClosed', () => {
    test('should increment success count and decrement active on successful cleanup', () => {
      ConnectionTracker.trackConnectionCreated();
      ConnectionTracker.trackConnectionCreated();
      expect(ConnectionTracker.activeConnections).toBe(2);
      
      ConnectionTracker.trackConnectionClosed(true, 'manual');
      
      expect(ConnectionTracker.activeConnections).toBe(1);
      expect(ConnectionTracker.cleanupSuccesses).toBe(1);
      expect(ConnectionTracker.cleanupFailures).toBe(0);
    });

    test('should not decrement active below zero', () => {
      ConnectionTracker.trackConnectionClosed(true, 'manual');
      
      expect(ConnectionTracker.activeConnections).toBe(0);
      expect(ConnectionTracker.cleanupSuccesses).toBe(1);
    });

    test('should increment failure count on failed cleanup', () => {
      ConnectionTracker.trackConnectionCreated();
      
      ConnectionTracker.trackConnectionClosed(false, 'error', {
        peerId: 'peer-123',
        connectionState: 'connecting',
        error: 'Connection timeout'
      });
      
      expect(ConnectionTracker.activeConnections).toBe(1); // Not decremented on failure
      expect(ConnectionTracker.cleanupSuccesses).toBe(0);
      expect(ConnectionTracker.cleanupFailures).toBe(1);
    });

    test('should log failure details on failed cleanup', () => {
      ConnectionTracker.trackConnectionClosed(false, 'timeout', {
        peerId: 'peer-456',
        connectionState: 'connecting',
        iceConnectionState: 'checking',
        error: 'ICE negotiation failed'
      });
      
      expect(ConnectionTracker.failureLogs.length).toBe(1);
      const log = ConnectionTracker.failureLogs[0];
      expect(log.peerId).toBe('peer-456');
      expect(log.connectionState).toBe('connecting');
      expect(log.iceConnectionState).toBe('checking');
      expect(log.error).toBe('ICE negotiation failed');
      expect(log.reason).toBe('timeout');
      expect(log.timestamp).toBeDefined();
    });

    test('should limit failure logs to MAX_FAILURE_LOGS', () => {
      for (let i = 0; i < 15; i++) {
        ConnectionTracker.trackConnectionClosed(false, 'error', {
          peerId: `peer-${i}`
        });
      }
      
      expect(ConnectionTracker.failureLogs.length).toBe(ConnectionTracker.MAX_FAILURE_LOGS);
      // Should keep the most recent logs
      expect(ConnectionTracker.failureLogs[0].peerId).toBe('peer-5');
      expect(ConnectionTracker.failureLogs[9].peerId).toBe('peer-14');
    });
  });

  describe('getResourceStats', () => {
    test('should return correct structure with initial values', () => {
      const stats = ConnectionTracker.getResourceStats();
      
      expect(stats).toEqual({
        activeConnections: 0,
        cleanupSuccesses: 0,
        cleanupFailures: 0,
        successRate: 'N/A',
        recentFailures: []
      });
    });

    test('should calculate success rate correctly', () => {
      ConnectionTracker.trackConnectionCreated();
      ConnectionTracker.trackConnectionCreated();
      ConnectionTracker.trackConnectionCreated();
      
      ConnectionTracker.trackConnectionClosed(true, 'manual');
      ConnectionTracker.trackConnectionClosed(true, 'manual');
      ConnectionTracker.trackConnectionClosed(false, 'error');
      
      const stats = ConnectionTracker.getResourceStats();
      
      expect(stats.activeConnections).toBe(1);
      expect(stats.cleanupSuccesses).toBe(2);
      expect(stats.cleanupFailures).toBe(1);
      expect(stats.successRate).toBe('66.7%');
    });

    test('should return a copy of failure logs', () => {
      ConnectionTracker.trackConnectionClosed(false, 'error', { peerId: 'peer-1' });
      
      const stats = ConnectionTracker.getResourceStats();
      stats.recentFailures.push({ fake: true });
      
      // Original should not be modified
      expect(ConnectionTracker.failureLogs.length).toBe(1);
    });
  });

  describe('reset', () => {
    test('should clear all counters and logs', () => {
      ConnectionTracker.trackConnectionCreated();
      ConnectionTracker.trackConnectionCreated();
      ConnectionTracker.trackConnectionClosed(true, 'manual');
      ConnectionTracker.trackConnectionClosed(false, 'error', { peerId: 'peer-1' });
      
      ConnectionTracker.reset();
      
      expect(ConnectionTracker.activeConnections).toBe(0);
      expect(ConnectionTracker.cleanupSuccesses).toBe(0);
      expect(ConnectionTracker.cleanupFailures).toBe(0);
      expect(ConnectionTracker.failureLogs).toEqual([]);
    });
  });
});
