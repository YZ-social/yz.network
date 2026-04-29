/**
 * Tests for Task 4.4: Add RTT measurement to relay path (ping/pong through relay)
 * 
 * These tests verify that:
 * 1. HybridConnectionManager can measure RTT through relay path
 * 2. Relay ping/pong messages are properly handled
 * 3. PathTracker records relay latency measurements
 * 4. Timeout handling works correctly
 */

import { jest } from '@jest/globals';
import { HybridConnectionManager } from '../../src/network/HybridConnectionManager.js';
import { RelayManager } from '../../src/network/RelayManager.js';
import { PathType, PathState } from '../../src/network/PathTracker.js';

describe('Relay RTT Measurement (Task 4.4)', () => {
  let hybridManager;
  let relayManager;
  
  beforeEach(() => {
    // Create a mock RelayManager
    relayManager = new RelayManager();
    relayManager.initialize('local-node-id', false);
    
    // Create HybridConnectionManager with the relay manager
    hybridManager = new HybridConnectionManager({
      relayManager,
      bridgeNodeId: 'bridge-node-id',
      attemptWebRTC: false // Disable WebRTC for these tests
    });
    
    // Set up peer ID and initialize path tracker
    hybridManager.peerId = 'target-peer-id';
    hybridManager._initializePathTracker('target-peer-id');
    
    // Simulate an active relay session
    hybridManager.relaySession = {
      sessionId: 'test-session-id',
      relayNodeId: 'bridge-node-id',
      state: 'active',
      createdAt: Date.now(),
      lastActivity: Date.now()
    };
    hybridManager.relayConnected = true;
    hybridManager.activeTransport = 'relay';
    hybridManager.connectionState = 'connected';
    
    // Add relay path to PathTracker
    hybridManager.pathTracker.addPath(PathType.WEBSOCKET_RELAY, {
      sessionId: 'test-session-id',
      relayNodeId: 'bridge-node-id'
    });
    hybridManager.pathTracker.setPathState(PathType.WEBSOCKET_RELAY, PathState.ACTIVE, 'test');
  });
  
  afterEach(() => {
    if (hybridManager) {
      // Stop measurement timer before destroying
      if (hybridManager.pathTracker) {
        hybridManager.pathTracker.stopMeasurementTimer();
      }
      hybridManager.destroy();
    }
    if (relayManager) {
      relayManager.destroy();
    }
    jest.clearAllTimers();
  });
  
  describe('_measurePathLatencies', () => {
    test('should send relay ping when relay is connected', () => {
      const sendRelayPingHandler = jest.fn();
      relayManager.on('sendRelayPing', sendRelayPingHandler);
      
      // Trigger measurement
      hybridManager._measurePathLatencies();
      
      // Verify ping was sent
      expect(sendRelayPingHandler).toHaveBeenCalledTimes(1);
      const pingCall = sendRelayPingHandler.mock.calls[0][0];
      expect(pingCall.toPeerId).toBe('bridge-node-id');
      expect(pingCall.message.type).toBe('relay_ping');
      expect(pingCall.message.sessionId).toBe('test-session-id');
      expect(pingCall.message.pingId).toBeDefined();
      expect(pingCall.message.timestamp).toBeDefined();
    });
    
    test('should track pending ping for RTT calculation', () => {
      // Trigger measurement
      hybridManager._measurePathLatencies();
      
      // Verify pending ping is tracked
      expect(hybridManager._pendingPathPings).toBeDefined();
      expect(hybridManager._pendingPathPings.size).toBe(1);
      
      const [pingId, pending] = [...hybridManager._pendingPathPings.entries()][0];
      expect(pending.pathType).toBe(PathType.WEBSOCKET_RELAY);
      expect(pending.sentAt).toBeDefined();
      expect(pending.sessionId).toBe('test-session-id');
    });
    
    test('should not send ping when relay is not connected', () => {
      hybridManager.relayConnected = false;
      
      const sendRelayPingHandler = jest.fn();
      relayManager.on('sendRelayPing', sendRelayPingHandler);
      
      // Trigger measurement
      hybridManager._measurePathLatencies();
      
      // Verify no ping was sent
      expect(sendRelayPingHandler).not.toHaveBeenCalled();
    });
  });
  
  describe('handleRelayPong', () => {
    test('should complete RTT measurement when pong is received', () => {
      // Start measurement
      hybridManager._measurePathLatencies();
      
      // Get the ping ID
      const [pingId] = [...hybridManager._pendingPathPings.keys()];
      
      // Simulate pong response after 50ms
      const sentAt = hybridManager._pendingPathPings.get(pingId).sentAt;
      
      // Fast-forward time simulation
      jest.spyOn(Date, 'now').mockReturnValue(sentAt + 50);
      
      // Handle pong
      hybridManager.handleRelayPong({
        sessionId: 'test-session-id',
        pingId,
        timestamp: sentAt,
        respondedAt: sentAt + 25
      });
      
      // Verify measurement was completed
      expect(hybridManager._pendingPathPings.has(pingId)).toBe(false);
      
      // Verify latency was recorded in PathTracker
      const relayPath = hybridManager.pathTracker.getPath(PathType.WEBSOCKET_RELAY);
      expect(relayPath.latency).toBeDefined();
      
      // Restore Date.now
      jest.restoreAllMocks();
    });
    
    test('should emit pathRttMeasured event', (done) => {
      // Start measurement
      hybridManager._measurePathLatencies();
      
      // Get the ping ID
      const [pingId] = [...hybridManager._pendingPathPings.keys()];
      const sentAt = hybridManager._pendingPathPings.get(pingId).sentAt;
      
      // Listen for event
      hybridManager.on('pathRttMeasured', (data) => {
        expect(data.peerId).toBe('target-peer-id');
        expect(data.pathType).toBe(PathType.WEBSOCKET_RELAY);
        expect(data.latency).toBeDefined();
        expect(data.pingId).toBe(pingId);
        done();
      });
      
      // Handle pong
      hybridManager.handleRelayPong({
        sessionId: 'test-session-id',
        pingId,
        timestamp: sentAt,
        respondedAt: Date.now()
      });
    });
    
    test('should ignore pong for unknown ping', () => {
      // Handle pong without starting measurement
      hybridManager.handleRelayPong({
        sessionId: 'test-session-id',
        pingId: 'unknown-ping-id',
        timestamp: Date.now(),
        respondedAt: Date.now()
      });
      
      // Should not throw or cause issues
      expect(hybridManager._pendingPathPings?.size || 0).toBe(0);
    });
  });
  
  describe('handleRelayPing', () => {
    test('should respond with relay pong', () => {
      // Mock sendThroughRelay
      const sendThroughRelaySpy = jest.spyOn(relayManager, 'sendThroughRelay')
        .mockResolvedValue(undefined);
      
      // Handle incoming ping
      hybridManager.handleRelayPing({
        sessionId: 'test-session-id',
        pingId: 'incoming-ping-123',
        timestamp: Date.now()
      });
      
      // Verify pong was sent
      expect(sendThroughRelaySpy).toHaveBeenCalledTimes(1);
      const [sessionId, pongMessage] = sendThroughRelaySpy.mock.calls[0];
      expect(sessionId).toBe('test-session-id');
      expect(pongMessage.type).toBe('relay_pong');
      expect(pongMessage.pingId).toBe('incoming-ping-123');
      expect(pongMessage.respondedAt).toBeDefined();
    });
    
    test('should ignore ping for wrong session', () => {
      const sendThroughRelaySpy = jest.spyOn(relayManager, 'sendThroughRelay')
        .mockResolvedValue(undefined);
      
      // Handle ping with wrong session ID
      hybridManager.handleRelayPing({
        sessionId: 'wrong-session-id',
        pingId: 'incoming-ping-123',
        timestamp: Date.now()
      });
      
      // Verify no pong was sent
      expect(sendThroughRelaySpy).not.toHaveBeenCalled();
    });
  });
  
  describe('getRelayRtt', () => {
    test('should return null when no measurement exists', () => {
      expect(hybridManager.getRelayRtt()).toBeNull();
    });
    
    test('should return measured RTT', () => {
      // Record a latency measurement
      hybridManager.pathTracker.recordLatency(PathType.WEBSOCKET_RELAY, 75);
      
      // Get RTT
      const rtt = hybridManager.getRelayRtt();
      expect(rtt).toBe(75);
    });
  });
  
  describe('handleRelayMessage routing', () => {
    test('should route relay_ping to handleRelayPing', () => {
      const handleRelayPingSpy = jest.spyOn(hybridManager, 'handleRelayPing');
      
      // Simulate incoming relay message with relay_ping payload
      hybridManager.handleRelayMessage({
        sessionId: 'test-session-id',
        from: 'target-peer-id',
        payload: {
          type: 'relay_ping',
          sessionId: 'test-session-id',
          pingId: 'test-ping-id',
          timestamp: Date.now()
        }
      });
      
      expect(handleRelayPingSpy).toHaveBeenCalledTimes(1);
    });
    
    test('should route relay_pong to handleRelayPong', () => {
      const handleRelayPongSpy = jest.spyOn(hybridManager, 'handleRelayPong');
      
      // Simulate incoming relay message with relay_pong payload
      hybridManager.handleRelayMessage({
        sessionId: 'test-session-id',
        from: 'target-peer-id',
        payload: {
          type: 'relay_pong',
          sessionId: 'test-session-id',
          pingId: 'test-ping-id',
          timestamp: Date.now(),
          respondedAt: Date.now()
        }
      });
      
      expect(handleRelayPongSpy).toHaveBeenCalledTimes(1);
    });
  });
  
  describe('timeout handling', () => {
    test('should handle relay ping timeout', (done) => {
      // Listen for timeout event
      hybridManager.on('relayRttTimeout', (data) => {
        expect(data.peerId).toBe('target-peer-id');
        expect(data.pingId).toBeDefined();
        expect(data.sessionId).toBe('test-session-id');
        done();
      });
      
      // Start measurement with short timeout
      hybridManager._measurePathLatencies();
      
      // Get the ping ID and manually trigger timeout
      const [pingId] = [...hybridManager._pendingPathPings.keys()];
      hybridManager._handleRelayPingTimeout(pingId);
    });
    
    test('should record measurement failure on timeout', () => {
      // Start measurement
      hybridManager._measurePathLatencies();
      
      // Get the ping ID
      const [pingId] = [...hybridManager._pendingPathPings.keys()];
      
      // Trigger timeout
      hybridManager._handleRelayPingTimeout(pingId);
      
      // Verify pending ping was removed
      expect(hybridManager._pendingPathPings.has(pingId)).toBe(false);
      
      // Verify failure was recorded in PathTracker
      const relayPath = hybridManager.pathTracker.getPath(PathType.WEBSOCKET_RELAY);
      expect(relayPath.failureCount).toBeGreaterThan(0);
    });
  });
  
  describe('RelayManager pong routing', () => {
    test('should route pong to HybridConnectionManager', () => {
      // Register the hybrid manager with relay manager
      relayManager.registerPeerManager('target-peer-id', hybridManager);
      
      // Create a session in RelayManager
      relayManager._sessions.set('test-session-id', {
        sessionId: 'test-session-id',
        fromPeerId: 'local-node-id',
        toPeerId: 'target-peer-id',
        relayNodeId: 'bridge-node-id',
        state: 'active',
        lastActivity: Date.now()
      });
      
      // Start measurement in HybridConnectionManager
      hybridManager._measurePathLatencies();
      const [pingId] = [...hybridManager._pendingPathPings.keys()];
      
      // Spy on handleRelayPong
      const handleRelayPongSpy = jest.spyOn(hybridManager, 'handleRelayPong');
      
      // Simulate pong arriving at RelayManager
      relayManager.handleRelayPong('bridge-node-id', {
        sessionId: 'test-session-id',
        pingId,
        timestamp: Date.now()
      });
      
      // Verify pong was routed to HybridConnectionManager
      expect(handleRelayPongSpy).toHaveBeenCalledTimes(1);
    });
  });
});
