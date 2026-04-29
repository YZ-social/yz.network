/**
 * Unit tests for Background Path Discovery (Task 5.1)
 * 
 * Tests the continuous background probing feature that:
 * 1. Probes for better paths after initial connection
 * 2. Uses adaptive intervals (30s on relay, 5min on direct)
 * 3. Re-runs ICE gathering to detect NAT state changes
 * 4. Handles max attempts and cooldown periods
 * 
 * See: .kiro/specs/symmetric-nat-relay/tasks.md - Task 5.1
 */

import { jest } from '@jest/globals';
import { HybridConnectionManager } from '../../src/network/HybridConnectionManager.js';
import { RelayManager } from '../../src/network/RelayManager.js';

describe('HybridConnectionManager - Background Path Discovery (Task 5.1)', () => {
  let hybridManager;
  let mockRelayManager;
  
  beforeEach(() => {
    // Create mock relay manager
    mockRelayManager = new RelayManager();
    mockRelayManager.initialize('local-node-id', false);
    
    mockRelayManager.requestRelaySession = jest.fn().mockResolvedValue({
      sessionId: 'test-session-123',
      fromPeerId: 'local-node-id',
      toPeerId: 'target-peer-id',
      relayNodeId: 'bridge-node-id',
      state: 'active'
    });
    
    mockRelayManager.sendThroughRelay = jest.fn().mockResolvedValue(undefined);
    mockRelayManager.closeSession = jest.fn();
  });
  
  afterEach(async () => {
    if (hybridManager && !hybridManager.isDestroyed) {
      await hybridManager.destroy();
    }
    mockRelayManager.destroy();
    jest.clearAllTimers();
  });
  
  describe('Background Probing Configuration', () => {
    it('should have default background probing options', () => {
      hybridManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-id',
        attemptWebRTC: false
      });
      
      expect(hybridManager.options.backgroundProbeIntervalRelay).toBe(30000);
      expect(hybridManager.options.backgroundProbeIntervalDirect).toBe(300000);
      expect(hybridManager.options.enableBackgroundProbing).toBe(true);
      expect(hybridManager.options.maxBackgroundProbeAttempts).toBe(10);
      expect(hybridManager.options.backgroundProbeCooldown).toBe(600000);
    });
    
    it('should allow custom background probing options', () => {
      hybridManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-id',
        attemptWebRTC: false,
        backgroundProbeIntervalRelay: 10000,
        backgroundProbeIntervalDirect: 60000,
        enableBackgroundProbing: false,
        maxBackgroundProbeAttempts: 5,
        backgroundProbeCooldown: 120000
      });
      
      expect(hybridManager.options.backgroundProbeIntervalRelay).toBe(10000);
      expect(hybridManager.options.backgroundProbeIntervalDirect).toBe(60000);
      expect(hybridManager.options.enableBackgroundProbing).toBe(false);
      expect(hybridManager.options.maxBackgroundProbeAttempts).toBe(5);
      expect(hybridManager.options.backgroundProbeCooldown).toBe(120000);
    });
  });
  
  describe('Background Probing Lifecycle', () => {
    it('should start background probing after relay connection', async () => {
      hybridManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-id',
        attemptWebRTC: false,
        backgroundProbeIntervalRelay: 100 // Short interval for testing
      });
      
      const probingStartedPromise = new Promise(resolve => {
        hybridManager.on('backgroundProbingStarted', resolve);
      });
      
      await hybridManager.createConnection('target-peer-id', true, null);
      
      const event = await probingStartedPromise;
      
      expect(event.peerId).toBe('target-peer-id');
      expect(event.activeTransport).toBe('relay');
      expect(event.interval).toBe(100);
    });
    
    it('should stop background probing on destroy', async () => {
      hybridManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-id',
        attemptWebRTC: false,
        backgroundProbeIntervalRelay: 100
      });
      
      await hybridManager.createConnection('target-peer-id', true, null);
      
      const probingStoppedPromise = new Promise(resolve => {
        hybridManager.on('backgroundProbingStopped', resolve);
      });
      
      await hybridManager.destroy();
      
      const event = await probingStoppedPromise;
      expect(event.peerId).toBe('target-peer-id');
    });
    
    it('should not start background probing if disabled', async () => {
      hybridManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-id',
        attemptWebRTC: false,
        enableBackgroundProbing: false
      });
      
      let probingStarted = false;
      hybridManager.on('backgroundProbingStarted', () => {
        probingStarted = true;
      });
      
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Wait a bit to ensure no probing started
      await new Promise(resolve => setTimeout(resolve, 50));
      
      expect(probingStarted).toBe(false);
    });
  });
  
  describe('Adaptive Probe Intervals', () => {
    it('should use shorter interval when on relay', async () => {
      hybridManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-id',
        attemptWebRTC: false,
        backgroundProbeIntervalRelay: 100,
        backgroundProbeIntervalDirect: 500
      });
      
      await hybridManager.createConnection('target-peer-id', true, null);
      
      expect(hybridManager.activeTransport).toBe('relay');
      expect(hybridManager._getBackgroundProbeInterval()).toBe(100);
    });
    
    it('should use longer interval when on direct', async () => {
      hybridManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-id',
        attemptWebRTC: false,
        backgroundProbeIntervalRelay: 100,
        backgroundProbeIntervalDirect: 500
      });
      
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Simulate being on WebRTC
      hybridManager.activeTransport = 'webrtc';
      
      expect(hybridManager._getBackgroundProbeInterval()).toBe(500);
    });
  });
  
  describe('Background Probe Execution', () => {
    it('should emit backgroundProbe event during probing', async () => {
      hybridManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-id',
        attemptWebRTC: false,
        backgroundProbeIntervalRelay: 50
      });
      
      const probeEvents = [];
      hybridManager.on('backgroundProbe', (data) => {
        probeEvents.push(data);
      });
      
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Wait for at least one probe
      await new Promise(resolve => setTimeout(resolve, 100));
      
      expect(probeEvents.length).toBeGreaterThanOrEqual(1);
      expect(probeEvents[0].peerId).toBe('target-peer-id');
      expect(probeEvents[0].activeTransport).toBe('relay');
    });
    
    it('should attempt WebRTC probe when on relay', async () => {
      hybridManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-id',
        attemptWebRTC: true,
        backgroundProbeIntervalRelay: 50
      });
      
      const webrtcProbeEvents = [];
      hybridManager.on('backgroundWebRTCProbe', (data) => {
        webrtcProbeEvents.push(data);
      });
      
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Wait for at least one WebRTC probe attempt
      await new Promise(resolve => setTimeout(resolve, 150));
      
      expect(webrtcProbeEvents.length).toBeGreaterThanOrEqual(1);
      expect(webrtcProbeEvents[0].attempt).toBeGreaterThanOrEqual(1);
    });
  });
  
  describe('Max Attempts and Cooldown', () => {
    it('should enter cooldown after max attempts', async () => {
      hybridManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-id',
        attemptWebRTC: true,
        backgroundProbeIntervalRelay: 10,
        maxBackgroundProbeAttempts: 2,
        backgroundProbeCooldown: 1000
      });
      
      const cooldownEvents = [];
      hybridManager.on('backgroundProbeCooldown', (data) => {
        cooldownEvents.push(data);
      });
      
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Wait for max attempts to be reached
      await new Promise(resolve => setTimeout(resolve, 200));
      
      expect(cooldownEvents.length).toBe(1);
      expect(cooldownEvents[0].attempts).toBe(2);
      expect(cooldownEvents[0].cooldownDuration).toBe(1000);
    });
    
    it('should reset attempts on successful WebRTC connection', async () => {
      hybridManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-id',
        attemptWebRTC: false
      });
      
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Simulate some failed attempts
      hybridManager._backgroundProbeAttempts = 5;
      
      // Simulate WebRTC connection success
      hybridManager._resetBackgroundProbeAttempts();
      
      expect(hybridManager._backgroundProbeAttempts).toBe(0);
      expect(hybridManager._backgroundProbeCooldownUntil).toBeNull();
    });
  });
  
  describe('Background Probing Status', () => {
    it('should provide accurate probing status', async () => {
      hybridManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-id',
        attemptWebRTC: false,
        backgroundProbeIntervalRelay: 100,
        maxBackgroundProbeAttempts: 10
      });
      
      await hybridManager.createConnection('target-peer-id', true, null);
      
      const status = hybridManager.getBackgroundProbingStatus();
      
      expect(status.enabled).toBe(true);
      expect(status.running).toBe(true);
      expect(status.attempts).toBe(0);
      expect(status.maxAttempts).toBe(10);
      expect(status.inCooldown).toBe(false);
      expect(status.currentInterval).toBe(100);
      expect(status.activeTransport).toBe('relay');
    });
    
    it('should include probing status in metrics', async () => {
      hybridManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-id',
        attemptWebRTC: false
      });
      
      await hybridManager.createConnection('target-peer-id', true, null);
      
      const metrics = hybridManager.getMetrics();
      
      expect(metrics.backgroundProbing).toBeDefined();
      expect(metrics.backgroundProbing.enabled).toBe(true);
      expect(metrics.backgroundProbing.running).toBe(true);
    });
  });
  
  describe('Runtime Control', () => {
    it('should allow enabling/disabling background probing at runtime', async () => {
      hybridManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-id',
        attemptWebRTC: false,
        enableBackgroundProbing: true
      });
      
      await hybridManager.createConnection('target-peer-id', true, null);
      
      expect(hybridManager.getBackgroundProbingStatus().running).toBe(true);
      
      // Disable probing
      hybridManager.setBackgroundProbingEnabled(false);
      
      expect(hybridManager.getBackgroundProbingStatus().enabled).toBe(false);
      expect(hybridManager.getBackgroundProbingStatus().running).toBe(false);
      
      // Re-enable probing
      hybridManager.setBackgroundProbingEnabled(true);
      
      expect(hybridManager.getBackgroundProbingStatus().enabled).toBe(true);
      expect(hybridManager.getBackgroundProbingStatus().running).toBe(true);
    });
  });
  
  describe('Transport Change Handling', () => {
    it('should restart probing with new interval when transport changes', async () => {
      hybridManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-id',
        attemptWebRTC: false,
        backgroundProbeIntervalRelay: 100,
        backgroundProbeIntervalDirect: 500
      });
      
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Initial interval should be relay interval
      expect(hybridManager._getBackgroundProbeInterval()).toBe(100);
      
      // Simulate WebRTC connection and transport change
      hybridManager.webrtcConnected = true;
      hybridManager.activeTransport = 'webrtc';
      hybridManager._restartBackgroundProbing();
      
      // Interval should now be direct interval
      expect(hybridManager._getBackgroundProbeInterval()).toBe(500);
    });
    
    it('should restart probing when downgrading to relay', async () => {
      hybridManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-id',
        attemptWebRTC: false,
        backgroundProbeIntervalRelay: 100,
        backgroundProbeIntervalDirect: 500
      });
      
      await hybridManager.createConnection('target-peer-id', true, null);
      
      // Simulate being on WebRTC
      hybridManager.webrtcConnected = true;
      hybridManager.activeTransport = 'webrtc';
      hybridManager._restartBackgroundProbing();
      
      expect(hybridManager._getBackgroundProbeInterval()).toBe(500);
      
      // Simulate downgrade to relay
      hybridManager.webrtcConnected = false;
      hybridManager._downgradeToRelay();
      
      // Should now use relay interval
      expect(hybridManager._getBackgroundProbeInterval()).toBe(100);
    });
  });
});
