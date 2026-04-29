/**
 * Unit tests for HybridConnectionManager path failure detection
 * 
 * Task 4.6: Detect when current path fails (no pong response)
 * 
 * Tests the consecutive pong timeout tracking and automatic failover
 * when the active path fails.
 */

import { jest } from '@jest/globals';
import { HybridConnectionManager } from '../../src/network/HybridConnectionManager.js';
import { PathType, PathState } from '../../src/network/PathTracker.js';

describe('HybridConnectionManager - Path Failure Detection (Task 4.6)', () => {
  let manager;
  let mockRelayManager;
  
  beforeEach(() => {
    // Create mock RelayManager
    mockRelayManager = {
      registerPeerManager: jest.fn(),
      unregisterPeerManager: jest.fn(),
      requestRelaySession: jest.fn().mockResolvedValue({
        sessionId: 'test-session-123',
        relayNodeId: 'relay-node-1'
      }),
      sendThroughRelay: jest.fn().mockResolvedValue(true),
      closeSession: jest.fn(),
      emit: jest.fn(),
      getActiveSessionForPeer: jest.fn().mockReturnValue(null),
      hasRelayPath: jest.fn().mockReturnValue(false)
    };
    
    manager = new HybridConnectionManager({
      relayManager: mockRelayManager,
      bridgeNodeId: 'bridge-node-1',
      attemptWebRTC: false, // Disable WebRTC for these tests
      pathFailureThreshold: 3, // 3 consecutive failures to trigger failover
      pathProbingDelay: 100 // Short delay for testing
    });
  });
  
  afterEach(async () => {
    if (manager && !manager.isDestroyed) {
      await manager.destroyConnection(manager.peerId, 'test_cleanup');
    }
  });
  
  describe('Consecutive Failure Tracking', () => {
    it('should track consecutive pong timeouts', async () => {
      // Establish connection
      await manager.createConnection('peer-123', true);
      
      // Simulate a ping timeout
      manager._trackConsecutiveFailure(PathType.WEBSOCKET_RELAY);
      
      expect(manager.getConsecutiveFailures(PathType.WEBSOCKET_RELAY)).toBe(1);
      
      // Simulate another timeout
      manager._trackConsecutiveFailure(PathType.WEBSOCKET_RELAY);
      
      expect(manager.getConsecutiveFailures(PathType.WEBSOCKET_RELAY)).toBe(2);
    });
    
    it('should reset consecutive failures on successful pong', async () => {
      // Establish connection
      await manager.createConnection('peer-123', true);
      
      // Simulate some failures
      manager._trackConsecutiveFailure(PathType.WEBSOCKET_RELAY);
      manager._trackConsecutiveFailure(PathType.WEBSOCKET_RELAY);
      
      expect(manager.getConsecutiveFailures(PathType.WEBSOCKET_RELAY)).toBe(2);
      
      // Reset on successful pong
      manager._resetConsecutiveFailures(PathType.WEBSOCKET_RELAY);
      
      expect(manager.getConsecutiveFailures(PathType.WEBSOCKET_RELAY)).toBe(0);
    });
    
    it('should track failures independently per path type', async () => {
      // Establish connection
      await manager.createConnection('peer-123', true);
      
      // Simulate failures on different paths
      manager._trackConsecutiveFailure(PathType.WEBSOCKET_RELAY);
      manager._trackConsecutiveFailure(PathType.WEBSOCKET_RELAY);
      manager._trackConsecutiveFailure(PathType.WEBRTC_DIRECT);
      
      expect(manager.getConsecutiveFailures(PathType.WEBSOCKET_RELAY)).toBe(2);
      expect(manager.getConsecutiveFailures(PathType.WEBRTC_DIRECT)).toBe(1);
    });
    
    it('should include consecutive failures in metrics', async () => {
      // Establish connection
      await manager.createConnection('peer-123', true);
      
      // Simulate some failures
      manager._trackConsecutiveFailure(PathType.WEBSOCKET_RELAY);
      manager._trackConsecutiveFailure(PathType.WEBRTC_DIRECT);
      manager._trackConsecutiveFailure(PathType.WEBRTC_DIRECT);
      
      const metrics = manager.getMetrics();
      
      expect(metrics.consecutiveFailures).toBeDefined();
      expect(metrics.consecutiveFailures[PathType.WEBSOCKET_RELAY]).toBe(1);
      expect(metrics.consecutiveFailures[PathType.WEBRTC_DIRECT]).toBe(2);
    });
  });
  
  describe('Path Failure Detection', () => {
    it('should emit activePathFailed event when threshold exceeded', async () => {
      // Establish connection
      await manager.createConnection('peer-123', true);
      
      const activePathFailedHandler = jest.fn();
      manager.on('activePathFailed', activePathFailedHandler);
      
      // Simulate consecutive failures up to threshold
      manager._trackConsecutiveFailure(PathType.WEBSOCKET_RELAY);
      manager._trackConsecutiveFailure(PathType.WEBSOCKET_RELAY);
      
      // Should not have emitted yet (only 2 failures, threshold is 3)
      expect(activePathFailedHandler).not.toHaveBeenCalled();
      
      // Third failure should trigger the event
      manager._trackConsecutiveFailure(PathType.WEBSOCKET_RELAY);
      
      expect(activePathFailedHandler).toHaveBeenCalledWith({
        peerId: 'peer-123',
        pathType: PathType.WEBSOCKET_RELAY,
        consecutiveFailures: 3,
        reason: 'no_pong_response'
      });
    });
    
    it('should not emit activePathFailed for non-active path', async () => {
      // Establish connection (relay is active)
      await manager.createConnection('peer-123', true);
      
      const activePathFailedHandler = jest.fn();
      manager.on('activePathFailed', activePathFailedHandler);
      
      // Simulate failures on WebRTC (not the active path)
      manager._trackConsecutiveFailure(PathType.WEBRTC_DIRECT);
      manager._trackConsecutiveFailure(PathType.WEBRTC_DIRECT);
      manager._trackConsecutiveFailure(PathType.WEBRTC_DIRECT);
      
      // Should not emit because WebRTC is not the active path
      expect(activePathFailedHandler).not.toHaveBeenCalled();
    });
    
    it('should mark path as failed in PathTracker when threshold exceeded', async () => {
      // Establish connection
      await manager.createConnection('peer-123', true);
      
      // Simulate consecutive failures
      manager._trackConsecutiveFailure(PathType.WEBSOCKET_RELAY);
      manager._trackConsecutiveFailure(PathType.WEBSOCKET_RELAY);
      manager._trackConsecutiveFailure(PathType.WEBSOCKET_RELAY);
      
      // Check PathTracker state
      const relayPath = manager.pathTracker.getPath(PathType.WEBSOCKET_RELAY);
      expect(relayPath.state).toBe(PathState.FAILED);
    });
  });
  
  describe('Path Change Events (Task 4.6)', () => {
    it('should emit pathFailed event when path fails', async () => {
      // Establish connection
      await manager.createConnection('peer-123', true);
      
      const pathFailedHandler = jest.fn();
      manager.on('pathFailed', pathFailedHandler);
      
      // Simulate path failure
      manager._handleActivePathFailure(PathType.WEBSOCKET_RELAY);
      
      expect(pathFailedHandler).toHaveBeenCalledWith({
        peerId: 'peer-123',
        pathType: PathType.WEBSOCKET_RELAY,
        reason: 'no_pong_response',
        timestamp: expect.any(Number)
      });
    });
    
    it('should emit pathFailover event when failing over from WebRTC to relay', async () => {
      // Establish connection
      await manager.createConnection('peer-123', true);
      
      // Simulate WebRTC being connected and active
      manager.webrtcConnected = true;
      manager.webrtcManager = { restartIce: jest.fn() };
      manager.activeTransport = 'webrtc';
      
      // Update PathTracker to reflect WebRTC as active
      manager.pathTracker.addPath(PathType.WEBRTC_DIRECT, {});
      manager.pathTracker.setPathState(PathType.WEBRTC_DIRECT, PathState.ACTIVE);
      manager.pathTracker.setActivePath(PathType.WEBRTC_DIRECT);
      
      const pathFailoverHandler = jest.fn();
      manager.on('pathFailover', pathFailoverHandler);
      
      // Simulate WebRTC failure
      manager._handleActivePathFailure(PathType.WEBRTC_DIRECT);
      
      expect(pathFailoverHandler).toHaveBeenCalledWith({
        peerId: 'peer-123',
        fromPath: PathType.WEBRTC_DIRECT,
        toPath: PathType.WEBSOCKET_RELAY,
        reason: 'webrtc_failed',
        timestamp: expect.any(Number)
      });
    });
    
    it('should emit relayReestablishmentStarted event when attempting re-establishment', async () => {
      // Establish connection
      await manager.createConnection('peer-123', true);
      
      const reestablishmentHandler = jest.fn();
      manager.on('relayReestablishmentStarted', reestablishmentHandler);
      
      // Clear relay state to trigger re-establishment
      manager.relayConnected = false;
      manager.relaySession = null;
      
      // Simulate path failure (will trigger re-establishment)
      manager._handleActivePathFailure(PathType.WEBSOCKET_RELAY);
      
      expect(reestablishmentHandler).toHaveBeenCalledWith({
        peerId: 'peer-123',
        timestamp: expect.any(Number)
      });
    });
  });
  
  describe('Automatic Failover', () => {
    it('should attempt relay re-establishment when relay fails and no WebRTC', async () => {
      // Establish connection
      await manager.createConnection('peer-123', true);
      
      // Reset the mock to track new calls
      mockRelayManager.requestRelaySession.mockClear();
      
      // Simulate relay failure
      manager._handleActivePathFailure(PathType.WEBSOCKET_RELAY);
      
      // Should attempt to re-establish relay
      // Wait for async operation
      await new Promise(resolve => setTimeout(resolve, 50));
      
      expect(mockRelayManager.requestRelaySession).toHaveBeenCalled();
    });
    
    it('should schedule path probing after WebRTC failover to relay', async () => {
      // Establish connection with WebRTC available
      await manager.createConnection('peer-123', true);
      
      // Simulate WebRTC being connected
      manager.webrtcConnected = true;
      manager.webrtcManager = { restartIce: jest.fn() };
      manager.activeTransport = 'webrtc';
      
      // Update PathTracker to reflect WebRTC as active
      manager.pathTracker.addPath(PathType.WEBRTC_DIRECT, {});
      manager.pathTracker.setPathState(PathType.WEBRTC_DIRECT, PathState.ACTIVE);
      manager.pathTracker.setActivePath(PathType.WEBRTC_DIRECT);
      
      const pathProbingHandler = jest.fn();
      manager.on('pathProbingRequested', pathProbingHandler);
      
      // Simulate WebRTC failure
      manager._handleActivePathFailure(PathType.WEBRTC_DIRECT);
      
      // Should have scheduled path probing
      expect(manager._pathProbingScheduled).toBe(true);
      
      // Wait for probing to be triggered
      await new Promise(resolve => setTimeout(resolve, 150));
      
      expect(pathProbingHandler).toHaveBeenCalledWith({
        peerId: 'peer-123',
        reason: 'failover_recovery',
        attempt: expect.any(Number),
        timestamp: expect.any(Number)
      });
    });
    
    it('should emit peerDisconnected when all paths fail', async () => {
      // Establish connection
      await manager.createConnection('peer-123', true);
      
      // Make relay re-establishment fail
      mockRelayManager.requestRelaySession.mockResolvedValue(null);
      
      const disconnectedHandler = jest.fn();
      manager.on('peerDisconnected', disconnectedHandler);
      
      // Simulate relay failure with no WebRTC backup
      manager.relayConnected = false;
      manager.relaySession = null;
      manager.webrtcConnected = false;
      
      manager._handleActivePathFailure(PathType.WEBSOCKET_RELAY);
      
      // Wait for async operation
      await new Promise(resolve => setTimeout(resolve, 50));
      
      expect(disconnectedHandler).toHaveBeenCalledWith({
        peerId: 'peer-123',
        reason: 'all_paths_failed'
      });
    });
  });
  
  describe('Integration with Ping Timeout Handlers', () => {
    it('should track failure when relay ping times out', async () => {
      // Establish connection
      await manager.createConnection('peer-123', true);
      
      // Set up a pending ping
      manager._pendingPathPings = new Map();
      const pingId = 'test-ping-123';
      manager._pendingPathPings.set(pingId, {
        pathType: PathType.WEBSOCKET_RELAY,
        sentAt: Date.now() - 10000,
        sessionId: 'test-session-123'
      });
      
      // Trigger timeout handler
      manager._handleRelayPingTimeout(pingId);
      
      // Should have tracked the failure
      expect(manager.getConsecutiveFailures(PathType.WEBSOCKET_RELAY)).toBe(1);
    });
    
    it('should track failure when WebRTC ping times out', async () => {
      // Establish connection
      await manager.createConnection('peer-123', true);
      
      // Set up a pending ping
      manager._pendingPathPings = new Map();
      const pingId = 'test-ping-456';
      manager._pendingPathPings.set(pingId, {
        pathType: PathType.WEBRTC_DIRECT,
        sentAt: Date.now() - 10000
      });
      
      // Trigger timeout handler
      manager._handleWebRTCPingTimeout(pingId);
      
      // Should have tracked the failure
      expect(manager.getConsecutiveFailures(PathType.WEBRTC_DIRECT)).toBe(1);
    });
    
    it('should reset failures when pong is received', async () => {
      // Establish connection
      await manager.createConnection('peer-123', true);
      
      // Simulate some failures
      manager._trackConsecutiveFailure(PathType.WEBSOCKET_RELAY);
      manager._trackConsecutiveFailure(PathType.WEBSOCKET_RELAY);
      
      expect(manager.getConsecutiveFailures(PathType.WEBSOCKET_RELAY)).toBe(2);
      
      // Set up a pending ping
      manager._pendingPathPings = new Map();
      const pingId = 'test-ping-789';
      manager._pendingPathPings.set(pingId, {
        pathType: PathType.WEBSOCKET_RELAY,
        sentAt: Date.now() - 50
      });
      
      // Start a measurement in PathTracker
      manager.pathTracker.startMeasurement(PathType.WEBSOCKET_RELAY);
      
      // Simulate pong received
      manager._handlePathPong({
        pingId,
        timestamp: Date.now() - 50
      });
      
      // Should have reset failures
      expect(manager.getConsecutiveFailures(PathType.WEBSOCKET_RELAY)).toBe(0);
    });
  });
  
  describe('Cleanup', () => {
    it('should clean up path probing timer on destroy', async () => {
      // Establish connection
      await manager.createConnection('peer-123', true);
      
      // Schedule path probing
      manager._schedulePathProbing();
      
      expect(manager._pathProbingScheduled).toBe(true);
      expect(manager._pathProbingTimer).toBeDefined();
      
      // Destroy
      await manager.destroyConnection('peer-123', 'test');
      
      expect(manager._pathProbingTimer).toBeNull();
      expect(manager._pathProbingScheduled).toBe(false);
    });
    
    it('should clean up consecutive failure tracking on destroy', async () => {
      // Establish connection
      await manager.createConnection('peer-123', true);
      
      // Track some failures
      manager._trackConsecutiveFailure(PathType.WEBSOCKET_RELAY);
      
      expect(manager._consecutiveFailures).toBeDefined();
      expect(manager._consecutiveFailures.size).toBeGreaterThan(0);
      
      // Destroy
      await manager.destroyConnection('peer-123', 'test');
      
      expect(manager._consecutiveFailures).toBeNull();
    });
    
    it('should clean up WebRTC reconnection state on destroy', async () => {
      // Establish connection
      await manager.createConnection('peer-123', true);
      
      // Set up some reconnection state
      manager._webrtcReconnectAttempts = 3;
      manager._webrtcReconnectionInProgress = true;
      manager._coordinatedRestartAttempted = true;
      
      // Destroy
      await manager.destroyConnection('peer-123', 'test');
      
      expect(manager._webrtcReconnectAttempts).toBe(0);
      expect(manager._webrtcReconnectionInProgress).toBe(false);
      expect(manager._coordinatedRestartAttempted).toBe(false);
    });
  });
  
  describe('Path Probing Restart (Task 4.6)', () => {
    it('should emit pathProbingScheduled event when scheduling probing', async () => {
      await manager.createConnection('peer-123', true);
      
      const scheduledHandler = jest.fn();
      manager.on('pathProbingScheduled', scheduledHandler);
      
      manager._schedulePathProbing();
      
      expect(scheduledHandler).toHaveBeenCalledWith({
        peerId: 'peer-123',
        delay: expect.any(Number),
        attempt: 0,
        timestamp: expect.any(Number)
      });
    });
    
    it('should accept custom delay for exponential backoff', async () => {
      await manager.createConnection('peer-123', true);
      
      const scheduledHandler = jest.fn();
      manager.on('pathProbingScheduled', scheduledHandler);
      
      // Schedule with custom delay
      manager._schedulePathProbing(10000);
      
      expect(scheduledHandler).toHaveBeenCalledWith({
        peerId: 'peer-123',
        delay: 10000,
        attempt: 0,
        timestamp: expect.any(Number)
      });
    });
    
    it('should not schedule probing if already connected via WebRTC', async () => {
      await manager.createConnection('peer-123', true);
      
      // Simulate WebRTC connected
      manager.webrtcConnected = true;
      manager.activeTransport = 'webrtc';
      
      const scheduledHandler = jest.fn();
      manager.on('pathProbingScheduled', scheduledHandler);
      
      manager._schedulePathProbing();
      
      expect(scheduledHandler).not.toHaveBeenCalled();
      expect(manager._pathProbingScheduled).toBeFalsy();
    });
    
    it('should cancel probing if WebRTC connects during delay', async () => {
      const customManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-1',
        attemptWebRTC: false,
        pathProbingDelay: 200
      });
      
      await customManager.createConnection('peer-123', true);
      
      const probingHandler = jest.fn();
      customManager.on('pathProbingRequested', probingHandler);
      
      // Schedule probing
      customManager._schedulePathProbing();
      
      // Simulate WebRTC connecting during the delay
      await new Promise(resolve => setTimeout(resolve, 50));
      customManager.webrtcConnected = true;
      customManager.activeTransport = 'webrtc';
      
      // Wait for the scheduled time
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Should not have triggered probing
      expect(probingHandler).not.toHaveBeenCalled();
      
      await customManager.destroyConnection('peer-123', 'test');
    });
    
    it('should cancel path probing with _cancelPathProbing', async () => {
      await manager.createConnection('peer-123', true);
      
      manager._schedulePathProbing();
      expect(manager._pathProbingScheduled).toBe(true);
      expect(manager._pathProbingTimer).toBeDefined();
      
      manager._cancelPathProbing();
      
      expect(manager._pathProbingScheduled).toBe(false);
      expect(manager._pathProbingTimer).toBeNull();
    });
  });
  
  describe('WebRTC Reconnection (Task 4.6)', () => {
    it('should emit webrtcReconnectionStarted event', async () => {
      await manager.createConnection('peer-123', true);
      
      // Add a mock WebRTC manager
      manager.webrtcManager = {
        restartIce: jest.fn().mockResolvedValue(true)
      };
      
      const startedHandler = jest.fn();
      manager.on('webrtcReconnectionStarted', startedHandler);
      
      await manager._attemptWebRTCReconnection();
      
      expect(startedHandler).toHaveBeenCalledWith({
        peerId: 'peer-123',
        attempt: 1,
        maxAttempts: 5,
        timestamp: expect.any(Number)
      });
    });
    
    it('should track reconnection attempts', async () => {
      await manager.createConnection('peer-123', true);
      
      manager.webrtcManager = {
        restartIce: jest.fn().mockResolvedValue(true)
      };
      
      await manager._attemptWebRTCReconnection();
      expect(manager._webrtcReconnectAttempts).toBe(1);
      
      // Wait for the in-progress flag to clear
      await new Promise(resolve => setTimeout(resolve, 50));
      
      await manager._attemptWebRTCReconnection();
      expect(manager._webrtcReconnectAttempts).toBe(2);
    });
    
    it('should stop after max attempts', async () => {
      await manager.createConnection('peer-123', true);
      
      manager.webrtcManager = {
        restartIce: jest.fn().mockResolvedValue(true)
      };
      
      // Set attempts to max
      manager._webrtcReconnectAttempts = 5;
      
      const abandonedHandler = jest.fn();
      manager.on('webrtcReconnectionAbandoned', abandonedHandler);
      
      await manager._attemptWebRTCReconnection();
      
      expect(abandonedHandler).toHaveBeenCalledWith({
        peerId: 'peer-123',
        attempts: 6,
        reason: 'max_attempts_reached',
        timestamp: expect.any(Number)
      });
    });
    
    it('should not attempt reconnection if already in progress', async () => {
      await manager.createConnection('peer-123', true);
      
      manager.webrtcManager = {
        restartIce: jest.fn().mockResolvedValue(true)
      };
      
      manager._webrtcReconnectionInProgress = true;
      
      const startedHandler = jest.fn();
      manager.on('webrtcReconnectionStarted', startedHandler);
      
      await manager._attemptWebRTCReconnection();
      
      expect(startedHandler).not.toHaveBeenCalled();
    });
    
    it('should reset reconnection state on successful WebRTC connection', async () => {
      await manager.createConnection('peer-123', true);
      
      // Set up some reconnection state
      manager._webrtcReconnectAttempts = 3;
      manager._coordinatedRestartAttempted = true;
      
      // Simulate successful WebRTC connection
      manager._resetWebRTCReconnectionState();
      
      expect(manager._webrtcReconnectAttempts).toBe(0);
      expect(manager._webrtcReconnectionInProgress).toBe(false);
      expect(manager._coordinatedRestartAttempted).toBe(false);
    });
    
    it('should include reconnection state in metrics', async () => {
      await manager.createConnection('peer-123', true);
      
      manager._webrtcReconnectAttempts = 2;
      manager._webrtcReconnectionInProgress = true;
      manager._coordinatedRestartAttempted = true;
      
      const metrics = manager.getMetrics();
      
      expect(metrics.webrtcReconnection).toEqual({
        inProgress: true,
        attempts: 2,
        coordinatedRestartAttempted: true
      });
    });
    
    it('should use coordinated ICE restart for hard NAT pairs', async () => {
      await manager.createConnection('peer-123', true);
      
      manager.webrtcManager = {
        restartIce: jest.fn().mockResolvedValue(true)
      };
      
      // Mark as hard NAT pair
      manager._hardNatPairDetected = true;
      
      const iceRestartHandler = jest.fn();
      manager.on('iceRestartRequest', iceRestartHandler);
      
      await manager._attemptWebRTCReconnection();
      
      expect(iceRestartHandler).toHaveBeenCalledWith({
        targetPeerId: 'peer-123',
        sessionId: expect.any(String),
        reason: 'path_failure_recovery'
      });
      
      // Should mark coordinated restart as attempted
      expect(manager._coordinatedRestartAttempted).toBe(true);
    });
    
    it('should use regular ICE restart after coordinated restart attempted', async () => {
      await manager.createConnection('peer-123', true);
      
      manager.webrtcManager = {
        restartIce: jest.fn().mockResolvedValue(true)
      };
      
      // Mark as hard NAT pair but coordinated restart already attempted
      manager._hardNatPairDetected = true;
      manager._coordinatedRestartAttempted = true;
      
      const iceRestartHandler = jest.fn();
      manager.on('iceRestartRequest', iceRestartHandler);
      
      await manager._attemptWebRTCReconnection();
      
      // Should NOT emit iceRestartRequest
      expect(iceRestartHandler).not.toHaveBeenCalled();
      
      // Should call regular restartIce
      expect(manager.webrtcManager.restartIce).toHaveBeenCalled();
    });
  });
  
  describe('Configuration Options', () => {
    it('should use custom pathFailureThreshold', async () => {
      const customManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-1',
        attemptWebRTC: false,
        pathFailureThreshold: 5 // Custom threshold
      });
      
      await customManager.createConnection('peer-456', true);
      
      const activePathFailedHandler = jest.fn();
      customManager.on('activePathFailed', activePathFailedHandler);
      
      // Simulate 4 failures (below threshold)
      for (let i = 0; i < 4; i++) {
        customManager._trackConsecutiveFailure(PathType.WEBSOCKET_RELAY);
      }
      
      expect(activePathFailedHandler).not.toHaveBeenCalled();
      
      // 5th failure should trigger
      customManager._trackConsecutiveFailure(PathType.WEBSOCKET_RELAY);
      
      expect(activePathFailedHandler).toHaveBeenCalled();
      
      await customManager.destroyConnection('peer-456', 'test');
    });
    
    it('should use custom pathProbingDelay', async () => {
      const customManager = new HybridConnectionManager({
        relayManager: mockRelayManager,
        bridgeNodeId: 'bridge-node-1',
        attemptWebRTC: false,
        pathProbingDelay: 50 // Very short delay for testing
      });
      
      await customManager.createConnection('peer-789', true);
      
      const pathProbingHandler = jest.fn();
      customManager.on('pathProbingRequested', pathProbingHandler);
      
      // Schedule probing
      customManager._schedulePathProbing();
      
      // Should not have fired yet
      expect(pathProbingHandler).not.toHaveBeenCalled();
      
      // Wait for the delay
      await new Promise(resolve => setTimeout(resolve, 100));
      
      expect(pathProbingHandler).toHaveBeenCalled();
      
      await customManager.destroyConnection('peer-789', 'test');
    });
  });
});
