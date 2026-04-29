/**
 * Tests for KademliaDHT.getConnectionStats()
 * Task 5.4: Report aggregate statistics: % direct, % relay
 * 
 * These tests verify that the KademliaDHT correctly exposes connection statistics
 * including aggregate path stats from the RelayManager.
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { KademliaDHT } from '../../src/dht/KademliaDHT.js';
import { ConnectionManagerFactory } from '../../src/network/ConnectionManagerFactory.js';

describe('KademliaDHT - Connection Statistics (Task 5.4)', () => {
  let dht;
  let originalGetRelayManager;
  
  beforeEach(() => {
    // Save original method
    originalGetRelayManager = ConnectionManagerFactory.getRelayManager;
    
    // Create a minimal DHT instance for testing
    dht = new KademliaDHT({
      bootstrapServers: ['ws://localhost:8080'],
      metricsEnabled: false
    });
  });
  
  afterEach(() => {
    // Restore original method
    ConnectionManagerFactory.getRelayManager = originalGetRelayManager;
    
    if (dht) {
      dht.removeAllListeners();
    }
  });
  
  describe('getConnectionStats', () => {
    test('should return basic connection info', () => {
      const stats = dht.getConnectionStats();
      
      expect(stats).toBeDefined();
      expect(stats.connectedPeers).toBeDefined();
      expect(Array.isArray(stats.connectedPeers)).toBe(true);
      expect(stats.connectedPeerCount).toBeDefined();
      expect(typeof stats.connectedPeerCount).toBe('number');
    });
    
    test('should return null pathStats when no RelayManager available', () => {
      // Mock no relay manager
      ConnectionManagerFactory.getRelayManager = jest.fn().mockReturnValue(null);
      
      const stats = dht.getConnectionStats();
      
      expect(stats.pathStats).toBeNull();
      expect(stats.relayMetrics).toBeNull();
    });
    
    test('should include pathStats when RelayManager is available', () => {
      // Mock relay manager with aggregate path stats
      const mockRelayManager = {
        getAggregatePathStats: jest.fn().mockReturnValue({
          totalConnections: 2,
          totalConnectionTime: 20000,
          aggregateRelayTime: 5000,
          aggregateDirectTime: 15000,
          relayPercentage: 25,
          directPercentage: 75,
          meetsDirectTarget: false,
          currentlyOnRelay: 1,
          currentlyOnDirect: 1,
          currentRelayPercentage: 50,
          currentDirectPercentage: 50,
          perConnection: [
            { peerId: 'peer-1...', totalTime: 10000, relayTime: 2500, directTime: 7500 },
            { peerId: 'peer-2...', totalTime: 10000, relayTime: 2500, directTime: 7500 }
          ],
          timestamp: Date.now()
        }),
        getMetrics: jest.fn().mockReturnValue({
          sessionsCreated: 5,
          sessionsClosed: 3,
          messagesRelayed: 100,
          activeSessions: 2
        })
      };
      
      ConnectionManagerFactory.getRelayManager = jest.fn().mockReturnValue(mockRelayManager);
      
      const stats = dht.getConnectionStats();
      
      expect(stats.pathStats).toBeDefined();
      expect(stats.pathStats.totalBrowserConnections).toBe(2);
      expect(stats.pathStats.relayTimePercentage).toBe(25);
      expect(stats.pathStats.directTimePercentage).toBe(75);
      expect(stats.pathStats.meetsDirectTarget).toBe(false);
      expect(stats.pathStats.currentlyOnRelay).toBe(1);
      expect(stats.pathStats.currentlyOnDirect).toBe(1);
      expect(stats.pathStats.perConnection.length).toBe(2);
    });
    
    test('should include relayMetrics when RelayManager is available', () => {
      const mockRelayManager = {
        getAggregatePathStats: jest.fn().mockReturnValue({
          totalConnections: 0,
          totalConnectionTime: 0,
          aggregateRelayTime: 0,
          aggregateDirectTime: 0,
          relayPercentage: 0,
          directPercentage: 0,
          meetsDirectTarget: false,
          currentlyOnRelay: 0,
          currentlyOnDirect: 0,
          currentRelayPercentage: 0,
          currentDirectPercentage: 0,
          perConnection: [],
          timestamp: Date.now()
        }),
        getMetrics: jest.fn().mockReturnValue({
          sessionsCreated: 10,
          sessionsClosed: 8,
          messagesRelayed: 500,
          bytesRelayed: 50000,
          activeSessions: 2,
          relayLoad: 0.2,
          relayNodesKnown: 5,
          healthyRelays: 4,
          unhealthyRelays: 1
        })
      };
      
      ConnectionManagerFactory.getRelayManager = jest.fn().mockReturnValue(mockRelayManager);
      
      const stats = dht.getConnectionStats();
      
      expect(stats.relayMetrics).toBeDefined();
      expect(stats.relayMetrics.sessionsCreated).toBe(10);
      expect(stats.relayMetrics.activeSessions).toBe(2);
      expect(stats.relayMetrics.relayLoad).toBe(0.2);
      expect(stats.relayMetrics.healthyRelays).toBe(4);
    });
    
    test('should handle RelayManager without getAggregatePathStats method', () => {
      const mockRelayManager = {
        // No getAggregatePathStats method
        getMetrics: jest.fn().mockReturnValue({
          activeSessions: 0
        })
      };
      
      ConnectionManagerFactory.getRelayManager = jest.fn().mockReturnValue(mockRelayManager);
      
      const stats = dht.getConnectionStats();
      
      expect(stats.pathStats).toBeNull();
      expect(stats.relayMetrics).toBeDefined();
    });
    
    test('should truncate peer IDs in connectedPeers list', () => {
      // Mock getConnectedPeers to return full peer IDs
      dht.getConnectedPeers = jest.fn().mockReturnValue([
        'abcdefghijklmnopqrstuvwxyz123456',
        '123456789abcdefghijklmnopqrstuv'
      ]);
      
      ConnectionManagerFactory.getRelayManager = jest.fn().mockReturnValue(null);
      
      const stats = dht.getConnectionStats();
      
      expect(stats.connectedPeers[0]).toBe('abcdefgh...');
      expect(stats.connectedPeers[1]).toBe('12345678...');
      expect(stats.connectedPeerCount).toBe(2);
    });
    
    test('should report meetsDirectTarget correctly', () => {
      // Test case: meets target (80%+ direct)
      const mockRelayManagerMeetsTarget = {
        getAggregatePathStats: jest.fn().mockReturnValue({
          totalConnections: 1,
          totalConnectionTime: 10000,
          aggregateRelayTime: 1000,
          aggregateDirectTime: 9000,
          relayPercentage: 10,
          directPercentage: 90,
          meetsDirectTarget: true,
          currentlyOnRelay: 0,
          currentlyOnDirect: 1,
          currentRelayPercentage: 0,
          currentDirectPercentage: 100,
          perConnection: [],
          timestamp: Date.now()
        }),
        getMetrics: jest.fn().mockReturnValue({})
      };
      
      ConnectionManagerFactory.getRelayManager = jest.fn().mockReturnValue(mockRelayManagerMeetsTarget);
      
      let stats = dht.getConnectionStats();
      expect(stats.pathStats.meetsDirectTarget).toBe(true);
      expect(stats.pathStats.directTimePercentage).toBe(90);
      
      // Test case: does not meet target (less than 80% direct)
      const mockRelayManagerDoesNotMeetTarget = {
        getAggregatePathStats: jest.fn().mockReturnValue({
          totalConnections: 1,
          totalConnectionTime: 10000,
          aggregateRelayTime: 5000,
          aggregateDirectTime: 5000,
          relayPercentage: 50,
          directPercentage: 50,
          meetsDirectTarget: false,
          currentlyOnRelay: 1,
          currentlyOnDirect: 0,
          currentRelayPercentage: 100,
          currentDirectPercentage: 0,
          perConnection: [],
          timestamp: Date.now()
        }),
        getMetrics: jest.fn().mockReturnValue({})
      };
      
      ConnectionManagerFactory.getRelayManager = jest.fn().mockReturnValue(mockRelayManagerDoesNotMeetTarget);
      
      stats = dht.getConnectionStats();
      expect(stats.pathStats.meetsDirectTarget).toBe(false);
      expect(stats.pathStats.directTimePercentage).toBe(50);
    });
  });
});
