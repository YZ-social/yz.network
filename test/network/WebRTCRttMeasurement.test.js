/**
 * Tests for Task 4.4: Add RTT measurement to WebRTC path (existing keep-alive)
 * 
 * These tests verify that:
 * 1. WebRTCConnectionManager calculates RTT from keep-alive pong messages
 * 2. RTT history is maintained and averaged correctly
 * 3. RTT jitter is calculated from variance
 * 4. rttMeasured event is emitted with correct data
 * 5. RTT stats getters return correct values
 */

import { jest } from '@jest/globals';
import { WebRTCConnectionManager } from '../../src/network/WebRTCConnectionManager.js';
import { WebRTCManager } from '../../src/network/WebRTCManager.js';

describe('WebRTC RTT Measurement (Task 4.4)', () => {
  describe('WebRTCConnectionManager', () => {
    let manager;
    
    beforeEach(() => {
      manager = new WebRTCConnectionManager({
        localNodeId: 'test-node-id'
      });
      manager.peerId = 'target-peer-id';
    });
    
    afterEach(() => {
      if (manager) {
        manager.destroy();
      }
    });
    
    describe('handleKeepAlivePong RTT calculation', () => {
      test('should calculate RTT from originalTimestamp', () => {
        const sentTime = Date.now() - 50; // Simulate 50ms ago
        
        manager.handleKeepAlivePong({
          pingId: 'test-ping-1',
          originalTimestamp: sentTime,
          responseTimestamp: Date.now()
        });
        
        const lastRtt = manager.getLastRtt();
        expect(lastRtt).toBeGreaterThanOrEqual(45);
        expect(lastRtt).toBeLessThanOrEqual(60);
      });
      
      test('should store RTT in history', () => {
        const sentTime = Date.now() - 100;
        
        manager.handleKeepAlivePong({
          pingId: 'test-ping-1',
          originalTimestamp: sentTime,
          responseTimestamp: Date.now()
        });
        
        expect(manager._rttHistory).toBeDefined();
        expect(manager._rttHistory.length).toBe(1);
        expect(manager._rttHistory[0].rtt).toBeGreaterThanOrEqual(95);
      });
      
      test('should calculate average RTT from multiple samples', () => {
        // Simulate 5 pings with different RTTs
        const rtts = [50, 60, 70, 80, 90];
        
        for (let i = 0; i < rtts.length; i++) {
          const sentTime = Date.now() - rtts[i];
          manager.handleKeepAlivePong({
            pingId: `test-ping-${i}`,
            originalTimestamp: sentTime,
            responseTimestamp: Date.now()
          });
        }
        
        const avgRtt = manager.getAverageRtt();
        // Average of 50, 60, 70, 80, 90 = 70
        expect(avgRtt).toBeGreaterThanOrEqual(65);
        expect(avgRtt).toBeLessThanOrEqual(75);
      });
      
      test('should calculate RTT jitter from variance', () => {
        // Simulate pings with varying RTTs
        const rtts = [50, 100, 50, 100, 50];
        
        for (let i = 0; i < rtts.length; i++) {
          const sentTime = Date.now() - rtts[i];
          manager.handleKeepAlivePong({
            pingId: `test-ping-${i}`,
            originalTimestamp: sentTime,
            responseTimestamp: Date.now()
          });
        }
        
        const jitter = manager.getRttJitter();
        expect(jitter).toBeDefined();
        expect(jitter).toBeGreaterThan(0); // Should have some jitter
      });
      
      test('should limit RTT history to 10 samples', () => {
        // Send 15 pings
        for (let i = 0; i < 15; i++) {
          const sentTime = Date.now() - (50 + i);
          manager.handleKeepAlivePong({
            pingId: `test-ping-${i}`,
            originalTimestamp: sentTime,
            responseTimestamp: Date.now()
          });
        }
        
        expect(manager._rttHistory.length).toBe(10);
      });
      
      test('should emit rttMeasured event', (done) => {
        const sentTime = Date.now() - 75;
        
        manager.on('rttMeasured', (data) => {
          expect(data.peerId).toBe('target-peer-id');
          expect(data.rtt).toBeGreaterThanOrEqual(70);
          expect(data.rtt).toBeLessThanOrEqual(85);
          expect(data.avgRtt).toBeDefined();
          expect(data.pingId).toBe('test-ping-event');
          done();
        });
        
        manager.handleKeepAlivePong({
          pingId: 'test-ping-event',
          originalTimestamp: sentTime,
          responseTimestamp: Date.now()
        });
      });
      
      test('should not calculate RTT if originalTimestamp is missing', () => {
        manager.handleKeepAlivePong({
          pingId: 'test-ping-no-timestamp'
        });
        
        expect(manager.getLastRtt()).toBeNull();
      });
    });
    
    describe('RTT stats getters', () => {
      test('getLastRtt should return null when no measurements', () => {
        expect(manager.getLastRtt()).toBeNull();
      });
      
      test('getAverageRtt should return null when no measurements', () => {
        expect(manager.getAverageRtt()).toBeNull();
      });
      
      test('getRttJitter should return null when insufficient samples', () => {
        // Only one sample - not enough for jitter
        manager.handleKeepAlivePong({
          pingId: 'test-ping-1',
          originalTimestamp: Date.now() - 50,
          responseTimestamp: Date.now()
        });
        
        expect(manager.getRttJitter()).toBeNull();
      });
      
      test('getRttStats should return comprehensive stats', () => {
        // Add multiple samples
        for (let i = 0; i < 5; i++) {
          manager.handleKeepAlivePong({
            pingId: `test-ping-${i}`,
            originalTimestamp: Date.now() - (50 + i * 10),
            responseTimestamp: Date.now()
          });
        }
        
        const stats = manager.getRttStats();
        expect(stats.lastRtt).toBeDefined();
        expect(stats.avgRtt).toBeDefined();
        expect(stats.jitter).toBeDefined();
        expect(stats.sampleCount).toBe(5);
      });
    });
  });
  
  describe('WebRTCManager (multi-peer)', () => {
    let manager;
    
    beforeEach(() => {
      manager = new WebRTCManager({
        localNodeId: 'test-node-id'
      });
    });
    
    afterEach(() => {
      if (manager) {
        manager.destroy();
      }
    });
    
    describe('handleKeepAlivePong RTT calculation', () => {
      test('should calculate RTT per peer', () => {
        const sentTime = Date.now() - 50;
        
        manager.handleKeepAlivePong('peer-1', {
          pingId: 'test-ping-1',
          originalTimestamp: sentTime,
          responseTimestamp: Date.now(),
          tabVisible: true
        });
        
        const lastRtt = manager.getLastRtt('peer-1');
        expect(lastRtt).toBeGreaterThanOrEqual(45);
        expect(lastRtt).toBeLessThanOrEqual(60);
      });
      
      test('should maintain separate RTT history per peer', () => {
        // Peer 1 with 50ms RTT
        manager.handleKeepAlivePong('peer-1', {
          pingId: 'test-ping-1',
          originalTimestamp: Date.now() - 50,
          responseTimestamp: Date.now(),
          tabVisible: true
        });
        
        // Peer 2 with 100ms RTT
        manager.handleKeepAlivePong('peer-2', {
          pingId: 'test-ping-2',
          originalTimestamp: Date.now() - 100,
          responseTimestamp: Date.now(),
          tabVisible: true
        });
        
        const peer1Rtt = manager.getLastRtt('peer-1');
        const peer2Rtt = manager.getLastRtt('peer-2');
        
        expect(peer1Rtt).toBeGreaterThanOrEqual(45);
        expect(peer1Rtt).toBeLessThanOrEqual(60);
        expect(peer2Rtt).toBeGreaterThanOrEqual(95);
        expect(peer2Rtt).toBeLessThanOrEqual(110);
      });
      
      test('should emit rttMeasured event with peerId', (done) => {
        const sentTime = Date.now() - 75;
        
        manager.on('rttMeasured', (data) => {
          expect(data.peerId).toBe('peer-1');
          expect(data.rtt).toBeGreaterThanOrEqual(70);
          expect(data.avgRtt).toBeDefined();
          done();
        });
        
        manager.handleKeepAlivePong('peer-1', {
          pingId: 'test-ping-event',
          originalTimestamp: sentTime,
          responseTimestamp: Date.now(),
          tabVisible: true
        });
      });
      
      test('getRttStats should return stats for specific peer', () => {
        // Add multiple samples for peer-1
        for (let i = 0; i < 5; i++) {
          manager.handleKeepAlivePong('peer-1', {
            pingId: `test-ping-${i}`,
            originalTimestamp: Date.now() - (50 + i * 10),
            responseTimestamp: Date.now(),
            tabVisible: true
          });
        }
        
        const stats = manager.getRttStats('peer-1');
        expect(stats.lastRtt).toBeDefined();
        expect(stats.avgRtt).toBeDefined();
        expect(stats.jitter).toBeDefined();
        expect(stats.sampleCount).toBe(5);
        
        // Unknown peer should return null
        expect(manager.getRttStats('unknown-peer')).toBeNull();
      });
    });
  });
});
