/**
 * ConnectionMetricsTracker Unit Tests
 * 
 * Tests for Task 1.3: Track connection attempt outcomes
 */

import { jest } from '@jest/globals';
import { 
  ConnectionMetricsTracker, 
  ConnectionOutcome, 
  ConnectionType 
} from '../../src/network/ConnectionMetricsTracker.js';

describe('ConnectionMetricsTracker', () => {
  beforeEach(() => {
    // Reset metrics before each test
    ConnectionMetricsTracker.reset();
  });

  describe('recordAttempt', () => {
    test('should record direct success for browser-to-browser', () => {
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.DIRECT_SUCCESS,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'test-peer-12345678',
        duration: 1500
      });

      const b2b = ConnectionMetricsTracker.getBrowserToBrowserSuccessRate();
      expect(b2b.total).toBe(1);
      expect(b2b.directCount).toBe(1);
      expect(b2b.relayCount).toBe(0);
      expect(b2b.failureCount).toBe(0);
    });

    test('should record relay needed for browser-to-browser', () => {
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.RELAY_NEEDED,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'test-peer-12345678',
        duration: 2000
      });

      const b2b = ConnectionMetricsTracker.getBrowserToBrowserSuccessRate();
      expect(b2b.total).toBe(1);
      expect(b2b.directCount).toBe(0);
      expect(b2b.relayCount).toBe(1);
      expect(b2b.failureCount).toBe(0);
    });

    test('should record failure for browser-to-browser', () => {
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.FAILURE,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'test-peer-12345678',
        duration: 30000,
        failureReason: 'timeout'
      });

      const b2b = ConnectionMetricsTracker.getBrowserToBrowserSuccessRate();
      expect(b2b.total).toBe(1);
      expect(b2b.directCount).toBe(0);
      expect(b2b.relayCount).toBe(0);
      expect(b2b.failureCount).toBe(1);
    });

    test('should record WebSocket success for browser-to-nodejs', () => {
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_NODEJS,
        outcome: ConnectionOutcome.WEBSOCKET_SUCCESS,
        localNodeType: 'browser',
        remoteNodeType: 'nodejs',
        peerId: 'test-peer-12345678',
        duration: 500
      });

      const overall = ConnectionMetricsTracker.getOverallSuccessRate();
      expect(overall.total).toBe(1);
      expect(overall.successes).toBe(1);
      expect(overall.failures).toBe(0);
    });

    test('should track NAT type distribution', () => {
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.DIRECT_SUCCESS,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'peer1',
        natType: 'easy'
      });

      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.FAILURE,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'peer2',
        natType: 'hard'
      });

      const nat = ConnectionMetricsTracker.getNatTypeDistribution();
      expect(nat.total).toBe(2);
      expect(nat.counts.easy).toBe(1);
      expect(nat.counts.hard).toBe(1);
    });

    test('should track ICE candidate types', () => {
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.DIRECT_SUCCESS,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'test-peer',
        candidateTypes: { host: 2, srflx: 1, relay: 0 }
      });

      const recent = ConnectionMetricsTracker.getRecentAttempts(1);
      expect(recent[0].candidateTypes).toEqual({ host: 2, srflx: 1, relay: 0 });
    });
  });

  describe('getBrowserToBrowserSuccessRate', () => {
    test('should calculate correct percentages', () => {
      // 7 direct, 2 relay, 1 failure = 10 total
      for (let i = 0; i < 7; i++) {
        ConnectionMetricsTracker.recordAttempt({
          connectionType: ConnectionType.BROWSER_TO_BROWSER,
          outcome: ConnectionOutcome.DIRECT_SUCCESS,
          localNodeType: 'browser',
          remoteNodeType: 'browser',
          peerId: `peer-${i}`
        });
      }
      for (let i = 0; i < 2; i++) {
        ConnectionMetricsTracker.recordAttempt({
          connectionType: ConnectionType.BROWSER_TO_BROWSER,
          outcome: ConnectionOutcome.RELAY_NEEDED,
          localNodeType: 'browser',
          remoteNodeType: 'browser',
          peerId: `peer-relay-${i}`
        });
      }
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.FAILURE,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'peer-fail'
      });

      const b2b = ConnectionMetricsTracker.getBrowserToBrowserSuccessRate();
      expect(b2b.total).toBe(10);
      expect(b2b.directRate).toBe('70.0');
      expect(b2b.relayRate).toBe('20.0');
      expect(b2b.failureRate).toBe('10.0');
    });

    test('should return zeros when no attempts', () => {
      const b2b = ConnectionMetricsTracker.getBrowserToBrowserSuccessRate();
      expect(b2b.total).toBe(0);
      expect(b2b.directRate).toBe(0);
      expect(b2b.relayRate).toBe(0);
      expect(b2b.failureRate).toBe(0);
    });
  });

  describe('getOverallSuccessRate', () => {
    test('should aggregate all connection types', () => {
      // Browser-to-browser success
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.DIRECT_SUCCESS,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'peer1'
      });

      // Browser-to-nodejs success
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_NODEJS,
        outcome: ConnectionOutcome.WEBSOCKET_SUCCESS,
        localNodeType: 'browser',
        remoteNodeType: 'nodejs',
        peerId: 'peer2'
      });

      // Nodejs-to-nodejs failure
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.NODEJS_TO_NODEJS,
        outcome: ConnectionOutcome.FAILURE,
        localNodeType: 'nodejs',
        remoteNodeType: 'nodejs',
        peerId: 'peer3'
      });

      const overall = ConnectionMetricsTracker.getOverallSuccessRate();
      expect(overall.total).toBe(3);
      expect(overall.successes).toBe(2);
      expect(overall.failures).toBe(1);
      expect(overall.successRate).toBe('66.7');
    });
  });

  describe('getAverageConnectionTimes', () => {
    test('should calculate average times by type', () => {
      // Direct connections: 1000, 1500, 2000 = avg 1500
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.DIRECT_SUCCESS,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'peer1',
        duration: 1000
      });
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.DIRECT_SUCCESS,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'peer2',
        duration: 1500
      });
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.DIRECT_SUCCESS,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'peer3',
        duration: 2000
      });

      // WebSocket: 500, 700 = avg 600
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_NODEJS,
        outcome: ConnectionOutcome.WEBSOCKET_SUCCESS,
        localNodeType: 'browser',
        remoteNodeType: 'nodejs',
        peerId: 'peer4',
        duration: 500
      });
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_NODEJS,
        outcome: ConnectionOutcome.WEBSOCKET_SUCCESS,
        localNodeType: 'browser',
        remoteNodeType: 'nodejs',
        peerId: 'peer5',
        duration: 700
      });

      const times = ConnectionMetricsTracker.getAverageConnectionTimes();
      expect(times.direct).toBe(1500);
      expect(times.websocket).toBe(600);
      expect(times.relay).toBeNull(); // No relay connections
      expect(times.samples.direct).toBe(3);
      expect(times.samples.websocket).toBe(2);
    });
  });

  describe('getRecentAttempts', () => {
    test('should return most recent attempts', () => {
      for (let i = 0; i < 15; i++) {
        ConnectionMetricsTracker.recordAttempt({
          connectionType: ConnectionType.BROWSER_TO_BROWSER,
          outcome: ConnectionOutcome.DIRECT_SUCCESS,
          localNodeType: 'browser',
          remoteNodeType: 'browser',
          peerId: `peer-${i.toString().padStart(8, '0')}`
        });
      }

      const recent = ConnectionMetricsTracker.getRecentAttempts(5);
      expect(recent.length).toBe(5);
      // PeerIds are truncated to 8 chars, so peer-00000010 becomes peer-000
      // The last 5 entries should be peer-10 through peer-14
      expect(recent[0].peerId).toBe('peer-000'); // peer-00000010 truncated
      expect(recent[4].peerId).toBe('peer-000'); // peer-00000014 truncated
    });

    test('should respect MAX_LOGS limit', () => {
      // Record more than MAX_LOGS (100) attempts
      for (let i = 0; i < 110; i++) {
        ConnectionMetricsTracker.recordAttempt({
          connectionType: ConnectionType.BROWSER_TO_BROWSER,
          outcome: ConnectionOutcome.DIRECT_SUCCESS,
          localNodeType: 'browser',
          remoteNodeType: 'browser',
          peerId: `peer-${i}`
        });
      }

      const all = ConnectionMetricsTracker.getRecentAttempts(200);
      expect(all.length).toBe(100); // Capped at MAX_LOGS
    });
  });

  describe('getSummary', () => {
    test('should return comprehensive summary', () => {
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.DIRECT_SUCCESS,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'test-peer',
        duration: 1000,
        natType: 'easy'
      });

      const summary = ConnectionMetricsTracker.getSummary();
      
      expect(summary).toHaveProperty('timestamp');
      expect(summary).toHaveProperty('browserToBrowser');
      expect(summary).toHaveProperty('overall');
      expect(summary).toHaveProperty('averageTimes');
      expect(summary).toHaveProperty('natDistribution');
      expect(summary).toHaveProperty('outcomesByType');
      expect(summary).toHaveProperty('recentAttempts');
      
      expect(summary.browserToBrowser.total).toBe(1);
      expect(summary.overall.total).toBe(1);
    });
  });

  describe('getFormattedSummary', () => {
    test('should return formatted string', () => {
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.DIRECT_SUCCESS,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'test-peer',
        duration: 1000
      });

      const formatted = ConnectionMetricsTracker.getFormattedSummary();
      
      expect(typeof formatted).toBe('string');
      expect(formatted).toContain('Connection Metrics Summary');
      expect(formatted).toContain('Browser↔Browser');
      expect(formatted).toContain('Direct');
    });
  });

  describe('reset', () => {
    test('should clear all metrics', () => {
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.DIRECT_SUCCESS,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'test-peer'
      });

      expect(ConnectionMetricsTracker.getOverallSuccessRate().total).toBe(1);

      ConnectionMetricsTracker.reset();

      expect(ConnectionMetricsTracker.getOverallSuccessRate().total).toBe(0);
      expect(ConnectionMetricsTracker.getRecentAttempts(10).length).toBe(0);
    });
  });

  describe('getSuccessfulCandidateTypes', () => {
    test('should track selected candidate pair for successful connections', () => {
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.DIRECT_SUCCESS,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'test-peer',
        selectedCandidatePair: {
          localType: 'host',
          remoteType: 'srflx',
          localAddress: '192.168.1.100',
          remoteAddress: '203.0.113.50',
          protocol: 'udp'
        }
      });

      const candidates = ConnectionMetricsTracker.getSuccessfulCandidateTypes();
      expect(candidates.local.counts.host).toBe(1);
      expect(candidates.remote.counts.srflx).toBe(1);
    });

    test('should calculate percentages correctly', () => {
      // 3 host-to-host, 2 srflx-to-srflx, 1 host-to-srflx
      for (let i = 0; i < 3; i++) {
        ConnectionMetricsTracker.recordAttempt({
          connectionType: ConnectionType.BROWSER_TO_BROWSER,
          outcome: ConnectionOutcome.DIRECT_SUCCESS,
          localNodeType: 'browser',
          remoteNodeType: 'browser',
          peerId: `peer-${i}`,
          selectedCandidatePair: { localType: 'host', remoteType: 'host' }
        });
      }
      for (let i = 0; i < 2; i++) {
        ConnectionMetricsTracker.recordAttempt({
          connectionType: ConnectionType.BROWSER_TO_BROWSER,
          outcome: ConnectionOutcome.DIRECT_SUCCESS,
          localNodeType: 'browser',
          remoteNodeType: 'browser',
          peerId: `peer-srflx-${i}`,
          selectedCandidatePair: { localType: 'srflx', remoteType: 'srflx' }
        });
      }
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.DIRECT_SUCCESS,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'peer-mixed',
        selectedCandidatePair: { localType: 'host', remoteType: 'srflx' }
      });

      const candidates = ConnectionMetricsTracker.getSuccessfulCandidateTypes();
      
      // Local: 4 host, 2 srflx = 6 total
      expect(candidates.local.total).toBe(6);
      expect(candidates.local.counts.host).toBe(4);
      expect(candidates.local.counts.srflx).toBe(2);
      expect(candidates.local.percentages.host).toBe('66.7');
      expect(candidates.local.percentages.srflx).toBe('33.3');

      // Remote: 3 host, 3 srflx = 6 total
      expect(candidates.remote.total).toBe(6);
      expect(candidates.remote.counts.host).toBe(3);
      expect(candidates.remote.counts.srflx).toBe(3);
      expect(candidates.remote.percentages.host).toBe('50.0');
      expect(candidates.remote.percentages.srflx).toBe('50.0');
    });

    test('should not track candidate types for failed connections', () => {
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.FAILURE,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'test-peer',
        selectedCandidatePair: { localType: 'host', remoteType: 'host' }
      });

      const candidates = ConnectionMetricsTracker.getSuccessfulCandidateTypes();
      expect(candidates.local.total).toBe(0);
      expect(candidates.remote.total).toBe(0);
    });

    test('should handle prflx (peer reflexive) candidates', () => {
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.DIRECT_SUCCESS,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'test-peer',
        selectedCandidatePair: { localType: 'prflx', remoteType: 'prflx' }
      });

      const candidates = ConnectionMetricsTracker.getSuccessfulCandidateTypes();
      expect(candidates.local.counts.prflx).toBe(1);
      expect(candidates.remote.counts.prflx).toBe(1);
    });

    test('should include candidate types in log entries', () => {
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.DIRECT_SUCCESS,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'test-peer',
        selectedCandidatePair: {
          localType: 'host',
          remoteType: 'srflx',
          localAddress: '192.168.1.100',
          remoteAddress: '203.0.113.50',
          protocol: 'udp'
        }
      });

      const recent = ConnectionMetricsTracker.getRecentAttempts(1);
      expect(recent[0].selectedCandidatePair).toEqual({
        localType: 'host',
        remoteType: 'srflx',
        localAddress: '192.168.1.100',
        remoteAddress: '203.0.113.50',
        protocol: 'udp'
      });
    });

    test('should include candidate types in summary', () => {
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.DIRECT_SUCCESS,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'test-peer',
        selectedCandidatePair: { localType: 'host', remoteType: 'host' }
      });

      const summary = ConnectionMetricsTracker.getSummary();
      expect(summary.successfulCandidateTypes).toBeDefined();
      expect(summary.successfulCandidateTypes.local.counts.host).toBe(1);
    });

    test('should include candidate types in formatted summary', () => {
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.DIRECT_SUCCESS,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'test-peer',
        selectedCandidatePair: { localType: 'host', remoteType: 'srflx' }
      });

      const formatted = ConnectionMetricsTracker.getFormattedSummary();
      expect(formatted).toContain('ICE Candidate Types Used');
      expect(formatted).toContain('Local:');
      expect(formatted).toContain('Remote:');
    });

    test('should reset candidate types on reset', () => {
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.DIRECT_SUCCESS,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'test-peer',
        selectedCandidatePair: { localType: 'host', remoteType: 'host' }
      });

      expect(ConnectionMetricsTracker.getSuccessfulCandidateTypes().local.total).toBe(1);

      ConnectionMetricsTracker.reset();

      const candidates = ConnectionMetricsTracker.getSuccessfulCandidateTypes();
      expect(candidates.local.total).toBe(0);
      expect(candidates.remote.total).toBe(0);
    });
  });

  describe('getIPv6Stats (Task 6.2)', () => {
    test('should track IPv6 connections', () => {
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.DIRECT_SUCCESS,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'test-peer-ipv6',
        usedIPv6: true,
        ipv6Available: true
      });

      const ipv6Stats = ConnectionMetricsTracker.getIPv6Stats();
      expect(ipv6Stats.totalConnections).toBe(1);
      expect(ipv6Stats.trackedConnections).toBe(1);
      expect(ipv6Stats.ipv6Connections).toBe(1);
      expect(ipv6Stats.ipv4Connections).toBe(0);
      expect(ipv6Stats.ipv6Available).toBe(1);
      expect(ipv6Stats.ipv6Rate).toBe('100.0');
    });

    test('should track IPv4 connections', () => {
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.DIRECT_SUCCESS,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'test-peer-ipv4',
        usedIPv6: false,
        ipv6Available: false
      });

      const ipv6Stats = ConnectionMetricsTracker.getIPv6Stats();
      expect(ipv6Stats.totalConnections).toBe(1);
      expect(ipv6Stats.trackedConnections).toBe(1);
      expect(ipv6Stats.ipv6Connections).toBe(0);
      expect(ipv6Stats.ipv4Connections).toBe(1);
      expect(ipv6Stats.ipv4Rate).toBe('100.0');
    });

    test('should calculate correct IPv6 percentage with mixed connections', () => {
      // 3 IPv6 connections
      for (let i = 0; i < 3; i++) {
        ConnectionMetricsTracker.recordAttempt({
          connectionType: ConnectionType.BROWSER_TO_BROWSER,
          outcome: ConnectionOutcome.DIRECT_SUCCESS,
          localNodeType: 'browser',
          remoteNodeType: 'browser',
          peerId: `peer-ipv6-${i}`,
          usedIPv6: true,
          ipv6Available: true
        });
      }

      // 7 IPv4 connections
      for (let i = 0; i < 7; i++) {
        ConnectionMetricsTracker.recordAttempt({
          connectionType: ConnectionType.BROWSER_TO_BROWSER,
          outcome: ConnectionOutcome.DIRECT_SUCCESS,
          localNodeType: 'browser',
          remoteNodeType: 'browser',
          peerId: `peer-ipv4-${i}`,
          usedIPv6: false,
          ipv6Available: false
        });
      }

      const ipv6Stats = ConnectionMetricsTracker.getIPv6Stats();
      expect(ipv6Stats.totalConnections).toBe(10);
      expect(ipv6Stats.trackedConnections).toBe(10);
      expect(ipv6Stats.ipv6Connections).toBe(3);
      expect(ipv6Stats.ipv4Connections).toBe(7);
      expect(ipv6Stats.ipv6Rate).toBe('30.0');
      expect(ipv6Stats.ipv4Rate).toBe('70.0');
    });

    test('should track IPv6 availability separately from usage', () => {
      // IPv6 available but not used (fell back to IPv4)
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.DIRECT_SUCCESS,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'peer-ipv6-available',
        usedIPv6: false,
        ipv6Available: true
      });

      // IPv6 not available
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.DIRECT_SUCCESS,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'peer-ipv4-only',
        usedIPv6: false,
        ipv6Available: false
      });

      const ipv6Stats = ConnectionMetricsTracker.getIPv6Stats();
      expect(ipv6Stats.totalConnections).toBe(2);
      expect(ipv6Stats.ipv6Available).toBe(1);
      expect(ipv6Stats.ipv6AvailableRate).toBe('50.0');
      expect(ipv6Stats.ipv6Connections).toBe(0);
    });

    test('should track IPv6 for relay connections', () => {
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.RELAY_NEEDED,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'peer-relay',
        usedIPv6: false,
        ipv6Available: true
      });

      const ipv6Stats = ConnectionMetricsTracker.getIPv6Stats();
      expect(ipv6Stats.totalConnections).toBe(1);
      expect(ipv6Stats.ipv4Connections).toBe(1);
      expect(ipv6Stats.ipv6Available).toBe(1);
    });

    test('should track IPv6 for WebSocket connections', () => {
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_NODEJS,
        outcome: ConnectionOutcome.WEBSOCKET_SUCCESS,
        localNodeType: 'browser',
        remoteNodeType: 'nodejs',
        peerId: 'nodejs-peer',
        usedIPv6: true,
        ipv6Available: true
      });

      const ipv6Stats = ConnectionMetricsTracker.getIPv6Stats();
      expect(ipv6Stats.totalConnections).toBe(1);
      expect(ipv6Stats.ipv6Connections).toBe(1);
    });

    test('should not track IPv6 for failed connections', () => {
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.FAILURE,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'failed-peer',
        usedIPv6: true,
        ipv6Available: true,
        failureReason: 'timeout'
      });

      const ipv6Stats = ConnectionMetricsTracker.getIPv6Stats();
      expect(ipv6Stats.totalConnections).toBe(0);
      expect(ipv6Stats.ipv6Connections).toBe(0);
    });

    test('should handle legacy calls without IPv6 params', () => {
      // Legacy call without usedIPv6 or ipv6Available
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.DIRECT_SUCCESS,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'legacy-peer'
      });

      const ipv6Stats = ConnectionMetricsTracker.getIPv6Stats();
      expect(ipv6Stats.totalConnections).toBe(1);
      // trackedConnections should be 0 since no IPv6/IPv4 info provided
      expect(ipv6Stats.trackedConnections).toBe(0);
      expect(ipv6Stats.ipv6Connections).toBe(0);
      expect(ipv6Stats.ipv4Connections).toBe(0);
    });

    test('should return zeros when no connections', () => {
      const ipv6Stats = ConnectionMetricsTracker.getIPv6Stats();
      expect(ipv6Stats.totalConnections).toBe(0);
      expect(ipv6Stats.trackedConnections).toBe(0);
      expect(ipv6Stats.ipv6Rate).toBe(0);
      expect(ipv6Stats.ipv4Rate).toBe(0);
      expect(ipv6Stats.ipv6AvailableRate).toBe(0);
    });

    test('should include IPv6 stats in summary', () => {
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.DIRECT_SUCCESS,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'test-peer',
        usedIPv6: true,
        ipv6Available: true
      });

      const summary = ConnectionMetricsTracker.getSummary();
      expect(summary.ipv6Stats).toBeDefined();
      expect(summary.ipv6Stats.ipv6Connections).toBe(1);
    });

    test('should include IPv6 stats in formatted summary', () => {
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.DIRECT_SUCCESS,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'test-peer',
        usedIPv6: true,
        ipv6Available: true
      });

      const formatted = ConnectionMetricsTracker.getFormattedSummary();
      expect(formatted).toContain('IPv6 Usage');
      expect(formatted).toContain('IPv6:');
      expect(formatted).toContain('IPv4:');
      expect(formatted).toContain('IPv6 Available:');
    });

    test('should reset IPv6 stats on reset', () => {
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.DIRECT_SUCCESS,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'test-peer',
        usedIPv6: true,
        ipv6Available: true
      });

      expect(ConnectionMetricsTracker.getIPv6Stats().ipv6Connections).toBe(1);

      ConnectionMetricsTracker.reset();

      const ipv6Stats = ConnectionMetricsTracker.getIPv6Stats();
      expect(ipv6Stats.totalConnections).toBe(0);
      expect(ipv6Stats.ipv6Connections).toBe(0);
      expect(ipv6Stats.ipv4Connections).toBe(0);
      expect(ipv6Stats.ipv6Available).toBe(0);
    });
  });

  describe('logIPv6Stats (Task 6.2)', () => {
    test('should log IPv6 stats without error', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      // No data
      ConnectionMetricsTracker.logIPv6Stats();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No data collected yet'));

      consoleSpy.mockClear();

      // With data
      ConnectionMetricsTracker.recordAttempt({
        connectionType: ConnectionType.BROWSER_TO_BROWSER,
        outcome: ConnectionOutcome.DIRECT_SUCCESS,
        localNodeType: 'browser',
        remoteNodeType: 'browser',
        peerId: 'test-peer',
        usedIPv6: true,
        ipv6Available: true
      });

      ConnectionMetricsTracker.logIPv6Stats();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('IPv6 Stats'));

      consoleSpy.mockRestore();
    });

    test('should log good IPv6 adoption message when rate is high', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      // 3 IPv6 connections (60%)
      for (let i = 0; i < 3; i++) {
        ConnectionMetricsTracker.recordAttempt({
          connectionType: ConnectionType.BROWSER_TO_BROWSER,
          outcome: ConnectionOutcome.DIRECT_SUCCESS,
          localNodeType: 'browser',
          remoteNodeType: 'browser',
          peerId: `peer-${i}`,
          usedIPv6: true,
          ipv6Available: true
        });
      }

      // 2 IPv4 connections (40%)
      for (let i = 0; i < 2; i++) {
        ConnectionMetricsTracker.recordAttempt({
          connectionType: ConnectionType.BROWSER_TO_BROWSER,
          outcome: ConnectionOutcome.DIRECT_SUCCESS,
          localNodeType: 'browser',
          remoteNodeType: 'browser',
          peerId: `peer-ipv4-${i}`,
          usedIPv6: false,
          ipv6Available: false
        });
      }

      ConnectionMetricsTracker.logIPv6Stats();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Good IPv6 adoption'));

      consoleSpy.mockRestore();
    });
  });

  describe('IPv6 vs IPv4 Latency Comparison (Task 6.2)', () => {
    test('should record IPv6 latency measurement', () => {
      ConnectionMetricsTracker.recordLatencyMeasurement({
        isIPv6: true,
        latency: 50,
        peerId: 'test-peer-12345678'
      });

      const stats = ConnectionMetricsTracker.getIPv6LatencyComparison();
      expect(stats.ipv6.sampleCount).toBe(1);
      expect(stats.ipv6.avgLatency).toBe(50);
      expect(stats.ipv4.sampleCount).toBe(0);
    });

    test('should record IPv4 latency measurement', () => {
      ConnectionMetricsTracker.recordLatencyMeasurement({
        isIPv6: false,
        latency: 75,
        peerId: 'test-peer-12345678'
      });

      const stats = ConnectionMetricsTracker.getIPv6LatencyComparison();
      expect(stats.ipv4.sampleCount).toBe(1);
      expect(stats.ipv4.avgLatency).toBe(75);
      expect(stats.ipv6.sampleCount).toBe(0);
    });

    test('should calculate average latency from multiple samples', () => {
      // Record multiple IPv6 samples
      ConnectionMetricsTracker.recordLatencyMeasurement({ isIPv6: true, latency: 40, peerId: 'peer1' });
      ConnectionMetricsTracker.recordLatencyMeasurement({ isIPv6: true, latency: 50, peerId: 'peer2' });
      ConnectionMetricsTracker.recordLatencyMeasurement({ isIPv6: true, latency: 60, peerId: 'peer3' });

      // Record multiple IPv4 samples
      ConnectionMetricsTracker.recordLatencyMeasurement({ isIPv6: false, latency: 70, peerId: 'peer1' });
      ConnectionMetricsTracker.recordLatencyMeasurement({ isIPv6: false, latency: 80, peerId: 'peer2' });
      ConnectionMetricsTracker.recordLatencyMeasurement({ isIPv6: false, latency: 90, peerId: 'peer3' });

      const stats = ConnectionMetricsTracker.getIPv6LatencyComparison();
      expect(stats.ipv6.sampleCount).toBe(3);
      expect(stats.ipv6.avgLatency).toBe(50); // (40+50+60)/3
      expect(stats.ipv4.sampleCount).toBe(3);
      expect(stats.ipv4.avgLatency).toBe(80); // (70+80+90)/3
    });

    test('should calculate min/max latencies', () => {
      ConnectionMetricsTracker.recordLatencyMeasurement({ isIPv6: true, latency: 30, peerId: 'peer1' });
      ConnectionMetricsTracker.recordLatencyMeasurement({ isIPv6: true, latency: 50, peerId: 'peer2' });
      ConnectionMetricsTracker.recordLatencyMeasurement({ isIPv6: true, latency: 70, peerId: 'peer3' });

      const stats = ConnectionMetricsTracker.getIPv6LatencyComparison();
      expect(stats.ipv6.minLatency).toBe(30);
      expect(stats.ipv6.maxLatency).toBe(70);
    });

    test('should compare IPv6 vs IPv4 latency when both have data', () => {
      // IPv6 is faster (lower latency)
      ConnectionMetricsTracker.recordLatencyMeasurement({ isIPv6: true, latency: 40, peerId: 'peer1' });
      ConnectionMetricsTracker.recordLatencyMeasurement({ isIPv6: false, latency: 80, peerId: 'peer1' });

      const stats = ConnectionMetricsTracker.getIPv6LatencyComparison();
      expect(stats.comparison).not.toBeNull();
      expect(stats.comparison.fasterProtocol).toBe('IPv6');
      expect(stats.comparison.difference).toBe(40); // 80 - 40 = 40 (positive = IPv6 faster)
    });

    test('should identify IPv4 as faster when it has lower latency', () => {
      // IPv4 is faster (lower latency)
      ConnectionMetricsTracker.recordLatencyMeasurement({ isIPv6: true, latency: 100, peerId: 'peer1' });
      ConnectionMetricsTracker.recordLatencyMeasurement({ isIPv6: false, latency: 50, peerId: 'peer1' });

      const stats = ConnectionMetricsTracker.getIPv6LatencyComparison();
      expect(stats.comparison.fasterProtocol).toBe('IPv4');
      expect(stats.comparison.difference).toBe(-50); // 50 - 100 = -50 (negative = IPv4 faster)
    });

    test('should record dual-stack comparison when both paths available', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      ConnectionMetricsTracker.recordLatencyMeasurement({
        isIPv6: true,
        latency: 40,
        peerId: 'test-peer-12345678',
        ipv6Available: true,
        ipv4Available: true,
        alternateLatency: 80 // IPv4 latency
      });

      const stats = ConnectionMetricsTracker.getIPv6LatencyComparison();
      expect(stats.dualStack).not.toBeNull();
      expect(stats.dualStack.totalComparisons).toBe(1);
      expect(stats.dualStack.ipv6FasterCount).toBe(1);
      expect(stats.dualStack.ipv4FasterCount).toBe(0);

      // Should log the comparison
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('IPv6 vs IPv4 Latency'));

      consoleSpy.mockRestore();
    });

    test('should track dual-stack comparison rates', () => {
      // 3 comparisons where IPv6 is faster
      for (let i = 0; i < 3; i++) {
        ConnectionMetricsTracker.recordLatencyMeasurement({
          isIPv6: true,
          latency: 40,
          peerId: `peer-${i}`,
          ipv6Available: true,
          ipv4Available: true,
          alternateLatency: 80
        });
      }

      // 2 comparisons where IPv4 is faster
      for (let i = 0; i < 2; i++) {
        ConnectionMetricsTracker.recordLatencyMeasurement({
          isIPv6: false,
          latency: 30,
          peerId: `peer-ipv4-${i}`,
          ipv6Available: true,
          ipv4Available: true,
          alternateLatency: 60
        });
      }

      const stats = ConnectionMetricsTracker.getIPv6LatencyComparison();
      expect(stats.dualStack.totalComparisons).toBe(5);
      expect(stats.dualStack.ipv6FasterCount).toBe(3);
      expect(stats.dualStack.ipv4FasterCount).toBe(2);
      expect(stats.dualStack.ipv6FasterRate).toBe('60.0');
      expect(stats.dualStack.ipv4FasterRate).toBe('40.0');
    });

    test('should limit samples to maxSamples', () => {
      // Record more than maxSamples (50)
      for (let i = 0; i < 60; i++) {
        ConnectionMetricsTracker.recordLatencyMeasurement({
          isIPv6: true,
          latency: 50 + i,
          peerId: `peer-${i}`
        });
      }

      const stats = ConnectionMetricsTracker.getIPv6LatencyComparison();
      expect(stats.ipv6.sampleCount).toBe(50); // Should be capped at maxSamples
    });

    test('should reset latency stats on reset', () => {
      ConnectionMetricsTracker.recordLatencyMeasurement({ isIPv6: true, latency: 50, peerId: 'peer1' });
      ConnectionMetricsTracker.recordLatencyMeasurement({ isIPv6: false, latency: 80, peerId: 'peer1' });

      expect(ConnectionMetricsTracker.getIPv6LatencyComparison().ipv6.sampleCount).toBe(1);

      ConnectionMetricsTracker.reset();

      const stats = ConnectionMetricsTracker.getIPv6LatencyComparison();
      expect(stats.ipv6.sampleCount).toBe(0);
      expect(stats.ipv4.sampleCount).toBe(0);
    });

    test('should include latency comparison in getSummary', () => {
      ConnectionMetricsTracker.recordLatencyMeasurement({ isIPv6: true, latency: 40, peerId: 'peer1' });
      ConnectionMetricsTracker.recordLatencyMeasurement({ isIPv6: false, latency: 80, peerId: 'peer1' });

      const summary = ConnectionMetricsTracker.getSummary();
      expect(summary.ipv6LatencyComparison).toBeDefined();
      expect(summary.ipv6LatencyComparison.ipv6.avgLatency).toBe(40);
      expect(summary.ipv6LatencyComparison.ipv4.avgLatency).toBe(80);
    });

    test('should include latency comparison in getFormattedSummary', () => {
      ConnectionMetricsTracker.recordLatencyMeasurement({ isIPv6: true, latency: 40, peerId: 'peer1' });
      ConnectionMetricsTracker.recordLatencyMeasurement({ isIPv6: false, latency: 80, peerId: 'peer1' });

      const formatted = ConnectionMetricsTracker.getFormattedSummary();
      expect(formatted).toContain('IPv6 vs IPv4 Latency');
      expect(formatted).toContain('40ms avg');
      expect(formatted).toContain('80ms avg');
    });
  });

  describe('logIPv6LatencyComparison (Task 6.2)', () => {
    test('should log no data message when empty', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      ConnectionMetricsTracker.logIPv6LatencyComparison();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No latency data collected yet'));

      consoleSpy.mockRestore();
    });

    test('should log latency comparison with insights', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      // Record enough samples for insights
      for (let i = 0; i < 3; i++) {
        ConnectionMetricsTracker.recordLatencyMeasurement({ isIPv6: true, latency: 40, peerId: `peer-${i}` });
        ConnectionMetricsTracker.recordLatencyMeasurement({ isIPv6: false, latency: 80, peerId: `peer-${i}` });
      }

      ConnectionMetricsTracker.logIPv6LatencyComparison();
      
      // Should log the comparison
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('IPv6 vs IPv4 Latency Comparison'));
      // Should log insight about IPv6 being faster
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('IPv6 provides significantly lower latency'));

      consoleSpy.mockRestore();
    });

    test('should log warning when IPv4 is faster than IPv6', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      // Record samples where IPv4 is faster (unusual)
      for (let i = 0; i < 3; i++) {
        ConnectionMetricsTracker.recordLatencyMeasurement({ isIPv6: true, latency: 100, peerId: `peer-${i}` });
        ConnectionMetricsTracker.recordLatencyMeasurement({ isIPv6: false, latency: 50, peerId: `peer-${i}` });
      }

      ConnectionMetricsTracker.logIPv6LatencyComparison();
      
      // Should log warning about unusual IPv4 being faster
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('IPv4 has lower latency than IPv6'));

      consoleSpy.mockRestore();
    });
  });
});
