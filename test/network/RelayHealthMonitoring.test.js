/**
 * Unit tests for RelayManager health monitoring and failover
 * 
 * Tests the health check ping/pong mechanism and automatic failover
 * when relay nodes become unhealthy.
 */

import { RelayManager } from '../../src/network/RelayManager.js';

describe('RelayManager - Health Monitoring and Failover', () => {
  let relayManager;
  let emittedEvents;

  beforeEach(() => {
    relayManager = new RelayManager({
      healthCheckInterval: 1000, // 1 second for faster tests
      pingTimeout: 500, // 500ms timeout for faster tests
      maxConsecutiveFailures: 2, // Fail after 2 consecutive failures
      unhealthyRetryInterval: 2000 // 2 seconds before retry
    });
    relayManager.initialize('local-node-id', false);
    
    // Track emitted events
    emittedEvents = [];
    const originalEmit = relayManager.emit.bind(relayManager);
    relayManager.emit = (event, data) => {
      emittedEvents.push({ event, data });
      return originalEmit(event, data);
    };
  });

  afterEach(() => {
    relayManager.destroy();
  });

  describe('handleRelayPing', () => {
    it('should respond with pong when receiving ping for valid session', () => {
      // Create a session
      relayManager._sessions.set('session-1', {
        sessionId: 'session-1',
        fromPeerId: 'peer-a',
        toPeerId: 'peer-b',
        relayNodeId: 'relay-1',
        state: 'active',
        lastActivity: Date.now() - 1000
      });

      const pingMessage = {
        sessionId: 'session-1',
        pingId: 'ping-123',
        timestamp: Date.now()
      };

      relayManager.handleRelayPing('peer-a', pingMessage);

      // Should emit sendRelayPong
      const pongEvent = emittedEvents.find(e => e.event === 'sendRelayPong');
      expect(pongEvent).toBeDefined();
      expect(pongEvent.data.toPeerId).toBe('peer-a');
      expect(pongEvent.data.message.type).toBe('relay_pong');
      expect(pongEvent.data.message.pingId).toBe('ping-123');
      expect(pongEvent.data.message.sessionId).toBe('session-1');
    });

    it('should update session lastActivity on ping', () => {
      const oldActivity = Date.now() - 10000;
      relayManager._sessions.set('session-1', {
        sessionId: 'session-1',
        fromPeerId: 'peer-a',
        toPeerId: 'peer-b',
        relayNodeId: 'relay-1',
        state: 'active',
        lastActivity: oldActivity
      });

      relayManager.handleRelayPing('peer-a', {
        sessionId: 'session-1',
        pingId: 'ping-123',
        timestamp: Date.now()
      });

      const session = relayManager._sessions.get('session-1');
      expect(session.lastActivity).toBeGreaterThan(oldActivity);
    });

    it('should ignore ping for unknown session', () => {
      relayManager.handleRelayPing('peer-a', {
        sessionId: 'unknown-session',
        pingId: 'ping-123',
        timestamp: Date.now()
      });

      // Should not emit pong
      const pongEvent = emittedEvents.find(e => e.event === 'sendRelayPong');
      expect(pongEvent).toBeUndefined();
    });
  });

  describe('handleRelayPong', () => {
    it('should update relay health on successful pong', () => {
      const sentAt = Date.now() - 50; // 50ms ago
      
      // Set up pending ping
      relayManager._pendingPings.set('ping-123', {
        sessionId: 'session-1',
        relayNodeId: 'relay-1',
        sentAt,
        timeout: setTimeout(() => {}, 10000)
      });

      // Create session
      relayManager._sessions.set('session-1', {
        sessionId: 'session-1',
        fromPeerId: 'local-node-id',
        toPeerId: 'peer-b',
        relayNodeId: 'relay-1',
        state: 'active',
        lastActivity: sentAt,
        rtt: null
      });

      relayManager.handleRelayPong('relay-1', {
        sessionId: 'session-1',
        pingId: 'ping-123',
        timestamp: sentAt
      });

      // Pending ping should be cleared
      expect(relayManager._pendingPings.has('ping-123')).toBe(false);

      // Session RTT should be updated
      const session = relayManager._sessions.get('session-1');
      expect(session.rtt).toBeGreaterThanOrEqual(50);

      // Relay health should be updated
      const health = relayManager.getRelayHealth('relay-1');
      expect(health).not.toBeNull();
      expect(health.healthy).toBe(true);
      expect(health.consecutiveFailures).toBe(0);
      expect(health.lastRtt).toBeGreaterThanOrEqual(50);

      // Metrics should be updated
      expect(relayManager._metrics.healthChecksReceived).toBe(1);
    });

    it('should emit healthCheckSuccess event', () => {
      const sentAt = Date.now() - 30;
      
      relayManager._pendingPings.set('ping-123', {
        sessionId: 'session-1',
        relayNodeId: 'relay-1',
        sentAt,
        timeout: setTimeout(() => {}, 10000)
      });

      relayManager._sessions.set('session-1', {
        sessionId: 'session-1',
        state: 'active',
        relayNodeId: 'relay-1'
      });

      relayManager.handleRelayPong('relay-1', {
        sessionId: 'session-1',
        pingId: 'ping-123',
        timestamp: sentAt
      });

      const successEvent = emittedEvents.find(e => e.event === 'healthCheckSuccess');
      expect(successEvent).toBeDefined();
      expect(successEvent.data.sessionId).toBe('session-1');
      expect(successEvent.data.relayNodeId).toBe('relay-1');
      expect(successEvent.data.rtt).toBeGreaterThanOrEqual(30);
    });

    it('should ignore pong for unknown ping', () => {
      relayManager.handleRelayPong('relay-1', {
        sessionId: 'session-1',
        pingId: 'unknown-ping',
        timestamp: Date.now()
      });

      // No health update should occur
      expect(relayManager.getRelayHealth('relay-1')).toBeNull();
    });
  });

  describe('_handlePingTimeout', () => {
    it('should mark relay as unhealthy after consecutive failures', async () => {
      // Set up relay health with one prior failure
      relayManager._relayHealth.set('relay-1', {
        healthy: true,
        consecutiveFailures: 1, // One prior failure
        lastRtt: 50,
        lastCheck: Date.now() - 30000,
        totalChecks: 5,
        totalFailures: 1
      });

      // Set up pending ping
      relayManager._pendingPings.set('ping-123', {
        sessionId: 'session-1',
        relayNodeId: 'relay-1',
        sentAt: Date.now() - 1000,
        timeout: null
      });

      // Create active session
      relayManager._sessions.set('session-1', {
        sessionId: 'session-1',
        fromPeerId: 'local-node-id',
        toPeerId: 'peer-b',
        relayNodeId: 'relay-1',
        state: 'active',
        lastActivity: Date.now()
      });

      // Add alternate relay for failover
      relayManager.updateRelayNodes([{
        nodeId: 'relay-2',
        metadata: {
          canRelay: true,
          publicAddress: 'wss://relay2.example.com',
          relayLoad: 0.1,
          relayCapacity: 100
        }
      }]);

      relayManager._handlePingTimeout('ping-123');

      // Pending ping should be cleared
      expect(relayManager._pendingPings.has('ping-123')).toBe(false);

      // Relay should be marked unhealthy (2 consecutive failures = maxConsecutiveFailures)
      const health = relayManager.getRelayHealth('relay-1');
      expect(health.healthy).toBe(false);
      expect(health.consecutiveFailures).toBe(2);

      // Metrics should be updated
      expect(relayManager._metrics.healthCheckTimeouts).toBe(1);

      // Should emit relayUnhealthy event
      const unhealthyEvent = emittedEvents.find(e => e.event === 'relayUnhealthy');
      expect(unhealthyEvent).toBeDefined();
      expect(unhealthyEvent.data.relayNodeId).toBe('relay-1');
    });

    it('should not mark relay unhealthy before max consecutive failures', () => {
      // Set up relay health with no prior failures
      relayManager._relayHealth.set('relay-1', {
        healthy: true,
        consecutiveFailures: 0,
        lastRtt: 50,
        lastCheck: Date.now() - 30000,
        totalChecks: 5,
        totalFailures: 0
      });

      relayManager._pendingPings.set('ping-123', {
        sessionId: 'session-1',
        relayNodeId: 'relay-1',
        sentAt: Date.now() - 1000,
        timeout: null
      });

      relayManager._handlePingTimeout('ping-123');

      // Relay should still be healthy (only 1 failure, need 2)
      const health = relayManager.getRelayHealth('relay-1');
      expect(health.healthy).toBe(true);
      expect(health.consecutiveFailures).toBe(1);
    });
  });

  describe('_initiateFailover', () => {
    it('should switch session to alternate relay', async () => {
      // Create session on relay-1
      relayManager._sessions.set('session-1', {
        sessionId: 'session-1',
        fromPeerId: 'local-node-id',
        toPeerId: 'peer-b',
        relayNodeId: 'relay-1',
        relayAddress: 'wss://relay1.example.com',
        state: 'active',
        lastActivity: Date.now()
      });

      // Add alternate relay
      relayManager.updateRelayNodes([
        {
          nodeId: 'relay-1',
          metadata: {
            canRelay: true,
            publicAddress: 'wss://relay1.example.com',
            relayLoad: 0.5,
            relayCapacity: 100
          }
        },
        {
          nodeId: 'relay-2',
          metadata: {
            canRelay: true,
            publicAddress: 'wss://relay2.example.com',
            relayLoad: 0.1,
            relayCapacity: 100
          }
        }
      ]);

      await relayManager._initiateFailover('session-1', 'relay-1', 'test_failover');

      // Session should now use relay-2
      const session = relayManager._sessions.get('session-1');
      expect(session.relayNodeId).toBe('relay-2');
      expect(session.relayAddress).toBe('wss://relay2.example.com');

      // Metrics should be updated
      expect(relayManager._metrics.failovers).toBe(1);

      // Should emit failoverComplete event
      const failoverEvent = emittedEvents.find(e => e.event === 'failoverComplete');
      expect(failoverEvent).toBeDefined();
      expect(failoverEvent.data.sessionId).toBe('session-1');
      expect(failoverEvent.data.oldRelayId).toBe('relay-1');
      expect(failoverEvent.data.newRelayId).toBe('relay-2');
    });

    it('should emit failoverFailed when no alternate relay available', async () => {
      relayManager._sessions.set('session-1', {
        sessionId: 'session-1',
        fromPeerId: 'local-node-id',
        toPeerId: 'peer-b',
        relayNodeId: 'relay-1',
        state: 'active',
        lastActivity: Date.now()
      });

      // Only one relay available (the failed one)
      relayManager.updateRelayNodes([{
        nodeId: 'relay-1',
        metadata: {
          canRelay: true,
          publicAddress: 'wss://relay1.example.com',
          relayLoad: 0.5,
          relayCapacity: 100
        }
      }]);

      await relayManager._initiateFailover('session-1', 'relay-1', 'test_failover');

      // Session should still use relay-1 (no change)
      const session = relayManager._sessions.get('session-1');
      expect(session.relayNodeId).toBe('relay-1');

      // Should emit failoverFailed event
      const failedEvent = emittedEvents.find(e => e.event === 'failoverFailed');
      expect(failedEvent).toBeDefined();
      expect(failedEvent.data.sessionId).toBe('session-1');
      expect(failedEvent.data.reason).toBe('no_alternate_relay');
    });

    it('should not failover inactive sessions', async () => {
      relayManager._sessions.set('session-1', {
        sessionId: 'session-1',
        fromPeerId: 'local-node-id',
        toPeerId: 'peer-b',
        relayNodeId: 'relay-1',
        state: 'pending', // Not active
        lastActivity: Date.now()
      });

      await relayManager._initiateFailover('session-1', 'relay-1', 'test_failover');

      // No failover events should be emitted
      const failoverEvent = emittedEvents.find(e => e.event === 'failoverComplete');
      const failedEvent = emittedEvents.find(e => e.event === 'failoverFailed');
      expect(failoverEvent).toBeUndefined();
      expect(failedEvent).toBeUndefined();
    });
  });

  describe('isRelayHealthy', () => {
    it('should return true for unknown relay', () => {
      expect(relayManager.isRelayHealthy('unknown-relay')).toBe(true);
    });

    it('should return true for healthy relay', () => {
      relayManager._relayHealth.set('relay-1', {
        healthy: true,
        consecutiveFailures: 0,
        lastCheck: Date.now()
      });

      expect(relayManager.isRelayHealthy('relay-1')).toBe(true);
    });

    it('should return false for unhealthy relay within retry interval', () => {
      relayManager._relayHealth.set('relay-1', {
        healthy: false,
        consecutiveFailures: 3,
        lastCheck: Date.now() - 1000 // 1 second ago (within 2 second retry interval)
      });

      expect(relayManager.isRelayHealthy('relay-1')).toBe(false);
    });

    it('should return true for unhealthy relay after retry interval', () => {
      relayManager._relayHealth.set('relay-1', {
        healthy: false,
        consecutiveFailures: 3,
        lastCheck: Date.now() - 3000 // 3 seconds ago (past 2 second retry interval)
      });

      expect(relayManager.isRelayHealthy('relay-1')).toBe(true);
    });
  });

  describe('_selectRelayNode with health filtering', () => {
    it('should exclude unhealthy relays', async () => {
      // Mark relay-1 as unhealthy
      relayManager._relayHealth.set('relay-1', {
        healthy: false,
        consecutiveFailures: 3,
        lastCheck: Date.now() - 1000 // Within retry interval
      });

      relayManager.updateRelayNodes([
        {
          nodeId: 'relay-1',
          metadata: {
            canRelay: true,
            publicAddress: 'wss://relay1.example.com',
            relayLoad: 0.1, // Better load
            relayCapacity: 100
          }
        },
        {
          nodeId: 'relay-2',
          metadata: {
            canRelay: true,
            publicAddress: 'wss://relay2.example.com',
            relayLoad: 0.5, // Worse load
            relayCapacity: 100
          }
        }
      ]);

      const result = await relayManager._selectRelayNode('target-peer');

      // Should select relay-2 even though relay-1 has better load
      expect(result.nodeId).toBe('relay-2');
    });

    it('should exclude explicitly excluded nodes', async () => {
      relayManager.updateRelayNodes([
        {
          nodeId: 'relay-1',
          metadata: {
            canRelay: true,
            publicAddress: 'wss://relay1.example.com',
            relayLoad: 0.1,
            relayCapacity: 100
          }
        },
        {
          nodeId: 'relay-2',
          metadata: {
            canRelay: true,
            publicAddress: 'wss://relay2.example.com',
            relayLoad: 0.5,
            relayCapacity: 100
          }
        }
      ]);

      const result = await relayManager._selectRelayNode('target-peer', {
        excludeNodes: ['relay-1']
      });

      expect(result.nodeId).toBe('relay-2');
    });

    it('should give health bonus to relays with good history', async () => {
      // Set up health history for relay-1 (100% success rate)
      relayManager._relayHealth.set('relay-1', {
        healthy: true,
        consecutiveFailures: 0,
        lastRtt: 50,
        lastCheck: Date.now(),
        totalChecks: 100,
        totalFailures: 0
      });

      // Set up health history for relay-2 (50% success rate)
      relayManager._relayHealth.set('relay-2', {
        healthy: true,
        consecutiveFailures: 0,
        lastRtt: 50,
        lastCheck: Date.now(),
        totalChecks: 100,
        totalFailures: 50
      });

      relayManager.updateRelayNodes([
        {
          nodeId: 'relay-1',
          metadata: {
            canRelay: true,
            publicAddress: 'wss://relay1.example.com',
            relayLoad: 0.22, // Slightly worse load (11 point penalty)
            relayCapacity: 100
          }
        },
        {
          nodeId: 'relay-2',
          metadata: {
            canRelay: true,
            publicAddress: 'wss://relay2.example.com',
            relayLoad: 0.2, // Better load (10 point penalty)
            relayCapacity: 100
          }
        }
      ]);

      const result = await relayManager._selectRelayNode('target-peer');

      // relay-1: 100 - 11 (load) + 10 (health 100%) = 99
      // relay-2: 100 - 10 (load) + 5 (health 50%) = 95
      // relay-1 should win due to health bonus
      expect(result.nodeId).toBe('relay-1');
    });
  });

  describe('getMetrics', () => {
    it('should include health-related metrics', () => {
      relayManager._relayHealth.set('relay-1', { healthy: true });
      relayManager._relayHealth.set('relay-2', { healthy: false });
      relayManager._pendingPings.set('ping-1', {});

      const metrics = relayManager.getMetrics();

      expect(metrics.healthyRelays).toBe(1);
      expect(metrics.unhealthyRelays).toBe(1);
      expect(metrics.pendingPings).toBe(1);
      expect(metrics.healthChecksSent).toBe(0);
      expect(metrics.healthChecksReceived).toBe(0);
      expect(metrics.healthCheckTimeouts).toBe(0);
    });
  });

  describe('_updateRelayHealth', () => {
    it('should restore health after successful check on unhealthy relay', () => {
      relayManager._relayHealth.set('relay-1', {
        healthy: false,
        consecutiveFailures: 3,
        lastRtt: null,
        lastCheck: Date.now() - 60000,
        totalChecks: 10,
        totalFailures: 5
      });

      relayManager._updateRelayHealth('relay-1', true, 45);

      const health = relayManager.getRelayHealth('relay-1');
      expect(health.healthy).toBe(true);
      expect(health.consecutiveFailures).toBe(0);
      expect(health.lastRtt).toBe(45);

      // Should emit relayHealthRestored event
      const restoredEvent = emittedEvents.find(e => e.event === 'relayHealthRestored');
      expect(restoredEvent).toBeDefined();
      expect(restoredEvent.data.relayNodeId).toBe('relay-1');
      expect(restoredEvent.data.rtt).toBe(45);
    });
  });

  describe('destroy', () => {
    it('should clear pending ping timeouts', () => {
      const timeout1 = setTimeout(() => {}, 10000);
      const timeout2 = setTimeout(() => {}, 10000);

      relayManager._pendingPings.set('ping-1', { timeout: timeout1 });
      relayManager._pendingPings.set('ping-2', { timeout: timeout2 });

      relayManager.destroy();

      expect(relayManager._pendingPings.size).toBe(0);
      expect(relayManager._relayHealth.size).toBe(0);
    });
  });
});
