/**
 * Tests for aggregate path statistics reporting
 * Task 5.4: Report aggregate statistics: % direct, % relay
 * 
 * These tests verify that the RelayManager correctly aggregates path statistics
 * across all browser-to-browser connections.
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { RelayManager } from '../../src/network/RelayManager.js';

describe('RelayManager - Aggregate Path Statistics (Task 5.4)', () => {
  let relayManager;
  
  beforeEach(() => {
    relayManager = new RelayManager({
      maxRelaySessions: 100,
      sessionTimeout: 5 * 60 * 1000
    });
    relayManager.initialize('local-node-id', false);
  });
  
  afterEach(() => {
    relayManager.destroy();
  });
  
  describe('getAggregatePathStats', () => {
    test('should return empty stats when no peer managers registered', () => {
      const stats = relayManager.getAggregatePathStats();
      
      expect(stats.totalConnections).toBe(0);
      expect(stats.totalConnectionTime).toBe(0);
      expect(stats.aggregateRelayTime).toBe(0);
      expect(stats.aggregateDirectTime).toBe(0);
      expect(stats.relayPercentage).toBe(0);
      expect(stats.directPercentage).toBe(0);
      expect(stats.meetsDirectTarget).toBe(false);
      expect(stats.perConnection).toEqual([]);
      expect(stats.timestamp).toBeDefined();
    });
    
    test('should aggregate stats from single peer manager', () => {
      // Create mock peer manager with path time stats
      const mockManager = {
        getPathTimeStats: jest.fn().mockReturnValue({
          totalConnectionTime: 10000,
          currentPath: 'webrtc_direct',
          aggregate: {
            relayTime: 2000,
            directTime: 8000,
            relayPercentage: 20,
            directPercentage: 80,
            meetsDirectTarget: true
          }
        })
      };
      
      relayManager.registerPeerManager('peer-1', mockManager);
      
      const stats = relayManager.getAggregatePathStats();
      
      expect(stats.totalConnections).toBe(1);
      expect(stats.totalConnectionTime).toBe(10000);
      expect(stats.aggregateRelayTime).toBe(2000);
      expect(stats.aggregateDirectTime).toBe(8000);
      expect(stats.relayPercentage).toBe(20);
      expect(stats.directPercentage).toBe(80);
      expect(stats.meetsDirectTarget).toBe(true);
      expect(stats.perConnection.length).toBe(1);
    });
    
    test('should aggregate stats from multiple peer managers', () => {
      // Create mock peer managers with different path time stats
      const mockManager1 = {
        getPathTimeStats: jest.fn().mockReturnValue({
          totalConnectionTime: 10000,
          currentPath: 'webrtc_direct',
          aggregate: {
            relayTime: 2000,
            directTime: 8000,
            relayPercentage: 20,
            directPercentage: 80,
            meetsDirectTarget: true
          }
        })
      };
      
      const mockManager2 = {
        getPathTimeStats: jest.fn().mockReturnValue({
          totalConnectionTime: 10000,
          currentPath: 'websocket_relay',
          aggregate: {
            relayTime: 10000,
            directTime: 0,
            relayPercentage: 100,
            directPercentage: 0,
            meetsDirectTarget: false
          }
        })
      };
      
      relayManager.registerPeerManager('peer-1', mockManager1);
      relayManager.registerPeerManager('peer-2', mockManager2);
      
      const stats = relayManager.getAggregatePathStats();
      
      expect(stats.totalConnections).toBe(2);
      expect(stats.totalConnectionTime).toBe(20000);
      expect(stats.aggregateRelayTime).toBe(12000);
      expect(stats.aggregateDirectTime).toBe(8000);
      expect(stats.relayPercentage).toBe(60); // 12000/20000 = 60%
      expect(stats.directPercentage).toBe(40); // 8000/20000 = 40%
      expect(stats.meetsDirectTarget).toBe(false); // 40% < 80%
      expect(stats.perConnection.length).toBe(2);
    });
    
    test('should track current connection distribution', () => {
      // Create mock peer managers with different current paths
      const mockManager1 = {
        getPathTimeStats: jest.fn().mockReturnValue({
          totalConnectionTime: 10000,
          currentPath: 'webrtc_direct',
          aggregate: { relayTime: 0, directTime: 10000, relayPercentage: 0, directPercentage: 100, meetsDirectTarget: true }
        })
      };
      
      const mockManager2 = {
        getPathTimeStats: jest.fn().mockReturnValue({
          totalConnectionTime: 10000,
          currentPath: 'websocket_relay',
          aggregate: { relayTime: 10000, directTime: 0, relayPercentage: 100, directPercentage: 0, meetsDirectTarget: false }
        })
      };
      
      const mockManager3 = {
        getPathTimeStats: jest.fn().mockReturnValue({
          totalConnectionTime: 10000,
          currentPath: 'ipv6_direct',
          aggregate: { relayTime: 0, directTime: 10000, relayPercentage: 0, directPercentage: 100, meetsDirectTarget: true }
        })
      };
      
      relayManager.registerPeerManager('peer-1', mockManager1);
      relayManager.registerPeerManager('peer-2', mockManager2);
      relayManager.registerPeerManager('peer-3', mockManager3);
      
      const stats = relayManager.getAggregatePathStats();
      
      expect(stats.currentlyOnRelay).toBe(1);
      expect(stats.currentlyOnDirect).toBe(2);
      expect(stats.currentRelayPercentage).toBeCloseTo(33.33, 1);
      expect(stats.currentDirectPercentage).toBeCloseTo(66.67, 1);
    });
    
    test('should skip managers without getPathTimeStats method', () => {
      const mockManagerWithStats = {
        getPathTimeStats: jest.fn().mockReturnValue({
          totalConnectionTime: 10000,
          currentPath: 'webrtc_direct',
          aggregate: { relayTime: 0, directTime: 10000, relayPercentage: 0, directPercentage: 100, meetsDirectTarget: true }
        })
      };
      
      const mockManagerWithoutStats = {
        // No getPathTimeStats method
      };
      
      relayManager.registerPeerManager('peer-1', mockManagerWithStats);
      relayManager.registerPeerManager('peer-2', mockManagerWithoutStats);
      
      const stats = relayManager.getAggregatePathStats();
      
      expect(stats.totalConnections).toBe(1);
      expect(stats.perConnection.length).toBe(1);
    });
    
    test('should skip connections with zero connection time', () => {
      const mockManagerWithTime = {
        getPathTimeStats: jest.fn().mockReturnValue({
          totalConnectionTime: 10000,
          currentPath: 'webrtc_direct',
          aggregate: { relayTime: 0, directTime: 10000, relayPercentage: 0, directPercentage: 100, meetsDirectTarget: true }
        })
      };
      
      const mockManagerNoTime = {
        getPathTimeStats: jest.fn().mockReturnValue({
          totalConnectionTime: 0,
          currentPath: null,
          aggregate: { relayTime: 0, directTime: 0, relayPercentage: 0, directPercentage: 0, meetsDirectTarget: false }
        })
      };
      
      relayManager.registerPeerManager('peer-1', mockManagerWithTime);
      relayManager.registerPeerManager('peer-2', mockManagerNoTime);
      
      const stats = relayManager.getAggregatePathStats();
      
      expect(stats.totalConnections).toBe(1);
      expect(stats.perConnection.length).toBe(1);
    });
    
    test('should handle errors from peer managers gracefully', () => {
      const mockManagerGood = {
        getPathTimeStats: jest.fn().mockReturnValue({
          totalConnectionTime: 10000,
          currentPath: 'webrtc_direct',
          aggregate: { relayTime: 0, directTime: 10000, relayPercentage: 0, directPercentage: 100, meetsDirectTarget: true }
        })
      };
      
      const mockManagerBad = {
        getPathTimeStats: jest.fn().mockImplementation(() => {
          throw new Error('Test error');
        })
      };
      
      relayManager.registerPeerManager('peer-1', mockManagerGood);
      relayManager.registerPeerManager('peer-2', mockManagerBad);
      
      // Should not throw
      const stats = relayManager.getAggregatePathStats();
      
      expect(stats.totalConnections).toBe(1);
      expect(stats.perConnection.length).toBe(1);
    });
    
    test('should meet direct target when 80%+ time is on direct paths', () => {
      const mockManager = {
        getPathTimeStats: jest.fn().mockReturnValue({
          totalConnectionTime: 10000,
          currentPath: 'webrtc_direct',
          aggregate: {
            relayTime: 1000,
            directTime: 9000,
            relayPercentage: 10,
            directPercentage: 90,
            meetsDirectTarget: true
          }
        })
      };
      
      relayManager.registerPeerManager('peer-1', mockManager);
      
      const stats = relayManager.getAggregatePathStats();
      
      expect(stats.directPercentage).toBe(90);
      expect(stats.meetsDirectTarget).toBe(true);
    });
    
    test('should not meet direct target when less than 80% time is on direct paths', () => {
      const mockManager = {
        getPathTimeStats: jest.fn().mockReturnValue({
          totalConnectionTime: 10000,
          currentPath: 'websocket_relay',
          aggregate: {
            relayTime: 3000,
            directTime: 7000,
            relayPercentage: 30,
            directPercentage: 70,
            meetsDirectTarget: false
          }
        })
      };
      
      relayManager.registerPeerManager('peer-1', mockManager);
      
      const stats = relayManager.getAggregatePathStats();
      
      expect(stats.directPercentage).toBe(70);
      expect(stats.meetsDirectTarget).toBe(false);
    });
    
    test('should include per-connection breakdown with truncated peer IDs', () => {
      const mockManager = {
        getPathTimeStats: jest.fn().mockReturnValue({
          totalConnectionTime: 10000,
          currentPath: 'webrtc_direct',
          aggregate: {
            relayTime: 2000,
            directTime: 8000,
            relayPercentage: 20,
            directPercentage: 80,
            meetsDirectTarget: true
          }
        })
      };
      
      relayManager.registerPeerManager('abcdefghijklmnop', mockManager);
      
      const stats = relayManager.getAggregatePathStats();
      
      expect(stats.perConnection[0].peerId).toBe('abcdefgh...');
      expect(stats.perConnection[0].totalTime).toBe(10000);
      expect(stats.perConnection[0].relayTime).toBe(2000);
      expect(stats.perConnection[0].directTime).toBe(8000);
      expect(stats.perConnection[0].relayPercentage).toBe(20);
      expect(stats.perConnection[0].directPercentage).toBe(80);
      expect(stats.perConnection[0].currentPath).toBe('webrtc_direct');
      expect(stats.perConnection[0].meetsTarget).toBe(true);
    });
    
    test('should update stats after unregistering peer manager', () => {
      const mockManager1 = {
        getPathTimeStats: jest.fn().mockReturnValue({
          totalConnectionTime: 10000,
          currentPath: 'webrtc_direct',
          aggregate: { relayTime: 0, directTime: 10000, relayPercentage: 0, directPercentage: 100, meetsDirectTarget: true }
        })
      };
      
      const mockManager2 = {
        getPathTimeStats: jest.fn().mockReturnValue({
          totalConnectionTime: 10000,
          currentPath: 'websocket_relay',
          aggregate: { relayTime: 10000, directTime: 0, relayPercentage: 100, directPercentage: 0, meetsDirectTarget: false }
        })
      };
      
      relayManager.registerPeerManager('peer-1', mockManager1);
      relayManager.registerPeerManager('peer-2', mockManager2);
      
      let stats = relayManager.getAggregatePathStats();
      expect(stats.totalConnections).toBe(2);
      expect(stats.directPercentage).toBe(50);
      
      // Unregister one manager
      relayManager.unregisterPeerManager('peer-2');
      
      stats = relayManager.getAggregatePathStats();
      expect(stats.totalConnections).toBe(1);
      expect(stats.directPercentage).toBe(100);
      expect(stats.meetsDirectTarget).toBe(true);
    });
  });
});
