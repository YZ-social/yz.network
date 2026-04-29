import { jest } from '@jest/globals';
import { PathTracker, PathType, PathState, PathPriority } from '../../src/network/PathTracker.js';

describe('PathTracker', () => {
  let tracker;
  const testPeerId = 'test-peer-id-12345678';

  beforeEach(() => {
    tracker = new PathTracker(testPeerId, {
      measurementInterval: 1000,
      staleThreshold: 2000,
      switchThreshold: 50,
      measurementTimeout: 500
    });
  });

  afterEach(() => {
    if (tracker) {
      tracker.destroy();
      tracker = null;
    }
  });

  describe('Path Management', () => {
    it('should add a new path', () => {
      const path = tracker.addPath(PathType.WEBSOCKET_RELAY, { relayNodeId: 'relay-1' });
      
      expect(path).toBeDefined();
      expect(path.type).toBe(PathType.WEBSOCKET_RELAY);
      expect(path.state).toBe(PathState.PROBING);
      expect(path.metadata.relayNodeId).toBe('relay-1');
    });

    it('should update existing path metadata', () => {
      tracker.addPath(PathType.WEBSOCKET_RELAY, { relayNodeId: 'relay-1' });
      const path = tracker.addPath(PathType.WEBSOCKET_RELAY, { sessionId: 'session-1' });
      
      expect(path.metadata.relayNodeId).toBe('relay-1');
      expect(path.metadata.sessionId).toBe('session-1');
    });

    it('should remove a path', () => {
      tracker.addPath(PathType.WEBSOCKET_RELAY);
      expect(tracker.hasPath(PathType.WEBSOCKET_RELAY)).toBe(true);
      
      tracker.removePath(PathType.WEBSOCKET_RELAY);
      expect(tracker.hasPath(PathType.WEBSOCKET_RELAY)).toBe(false);
    });

    it('should track multiple paths', () => {
      tracker.addPath(PathType.WEBSOCKET_RELAY);
      tracker.addPath(PathType.WEBRTC_DIRECT);
      
      const paths = tracker.getAllPaths();
      expect(paths.length).toBe(2);
    });
  });

  describe('Path State Management', () => {
    it('should update path state', () => {
      tracker.addPath(PathType.WEBSOCKET_RELAY);
      tracker.addPath(PathType.WEBRTC_DIRECT); // Add another path so relay doesn't auto-activate
      tracker.setPathState(PathType.WEBRTC_DIRECT, PathState.AVAILABLE); // Make WebRTC available first
      tracker.setActivePath(PathType.WEBRTC_DIRECT); // Activate WebRTC
      
      tracker.setPathState(PathType.WEBSOCKET_RELAY, PathState.AVAILABLE, 'connected');
      
      const path = tracker.getPath(PathType.WEBSOCKET_RELAY);
      expect(path.state).toBe(PathState.AVAILABLE); // Should stay available since WebRTC is active
    });

    it('should emit pathStateChanged event', () => {
      const handler = jest.fn();
      tracker.on('pathStateChanged', handler);
      
      tracker.addPath(PathType.WEBSOCKET_RELAY);
      tracker.setPathState(PathType.WEBSOCKET_RELAY, PathState.AVAILABLE, 'connected');
      
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        pathType: PathType.WEBSOCKET_RELAY,
        oldState: PathState.PROBING,
        newState: PathState.AVAILABLE
      }));
    });

    it('should select new path when active path fails', () => {
      tracker.addPath(PathType.WEBSOCKET_RELAY);
      tracker.addPath(PathType.WEBRTC_DIRECT);
      
      tracker.setPathState(PathType.WEBSOCKET_RELAY, PathState.AVAILABLE);
      tracker.setPathState(PathType.WEBRTC_DIRECT, PathState.AVAILABLE);
      
      tracker.setActivePath(PathType.WEBRTC_DIRECT);
      expect(tracker.getActivePathType()).toBe(PathType.WEBRTC_DIRECT);
      
      tracker.setPathState(PathType.WEBRTC_DIRECT, PathState.FAILED, 'disconnected');
      
      // Should auto-select relay as fallback
      expect(tracker.getActivePathType()).toBe(PathType.WEBSOCKET_RELAY);
    });
  });

  describe('Latency Measurement', () => {
    it('should record latency and update path', () => {
      tracker.addPath(PathType.WEBSOCKET_RELAY);
      tracker.addPath(PathType.WEBRTC_DIRECT); // Add another path
      tracker.setPathState(PathType.WEBRTC_DIRECT, PathState.AVAILABLE);
      tracker.setActivePath(PathType.WEBRTC_DIRECT); // Make WebRTC active
      
      tracker.recordLatency(PathType.WEBSOCKET_RELAY, 100);
      
      const path = tracker.getPath(PathType.WEBSOCKET_RELAY);
      expect(path.latency).toBe(100);
      expect(path.state).toBe(PathState.AVAILABLE); // Should be available, not active
    });

    it('should calculate average latency from multiple samples', () => {
      tracker.addPath(PathType.WEBSOCKET_RELAY);
      
      tracker.recordLatency(PathType.WEBSOCKET_RELAY, 100);
      tracker.recordLatency(PathType.WEBSOCKET_RELAY, 120);
      tracker.recordLatency(PathType.WEBSOCKET_RELAY, 80);
      
      const path = tracker.getPath(PathType.WEBSOCKET_RELAY);
      expect(path.latency).toBe(100); // Average of 100, 120, 80
    });

    it('should calculate jitter from latency samples', () => {
      tracker.addPath(PathType.WEBSOCKET_RELAY);
      
      tracker.recordLatency(PathType.WEBSOCKET_RELAY, 100);
      tracker.recordLatency(PathType.WEBSOCKET_RELAY, 150);
      tracker.recordLatency(PathType.WEBSOCKET_RELAY, 50);
      
      const path = tracker.getPath(PathType.WEBSOCKET_RELAY);
      expect(path.jitter).toBeGreaterThan(0);
    });

    it('should emit latencyMeasured event', () => {
      const handler = jest.fn();
      tracker.on('latencyMeasured', handler);
      
      tracker.addPath(PathType.WEBSOCKET_RELAY);
      tracker.recordLatency(PathType.WEBSOCKET_RELAY, 100);
      
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        pathType: PathType.WEBSOCKET_RELAY,
        latency: 100
      }));
    });

    it('should track packet loss from measurement failures', () => {
      tracker.addPath(PathType.WEBSOCKET_RELAY);
      
      tracker.recordLatency(PathType.WEBSOCKET_RELAY, 100);
      tracker.recordMeasurementFailure(PathType.WEBSOCKET_RELAY, 'timeout');
      
      const path = tracker.getPath(PathType.WEBSOCKET_RELAY);
      expect(path.packetLoss).toBe(0.5); // 1 success, 1 failure
    });
  });

  describe('Path Selection', () => {
    it('should select best path based on latency', () => {
      tracker.addPath(PathType.WEBSOCKET_RELAY);
      tracker.addPath(PathType.WEBRTC_DIRECT);
      
      tracker.recordLatency(PathType.WEBSOCKET_RELAY, 200);
      tracker.recordLatency(PathType.WEBRTC_DIRECT, 50);
      
      tracker.setPathState(PathType.WEBSOCKET_RELAY, PathState.AVAILABLE);
      tracker.setPathState(PathType.WEBRTC_DIRECT, PathState.AVAILABLE);
      
      const best = tracker.getBestPath();
      expect(best.type).toBe(PathType.WEBRTC_DIRECT);
    });

    it('should prefer higher priority path when latencies are similar', () => {
      tracker.addPath(PathType.WEBSOCKET_RELAY);
      tracker.addPath(PathType.WEBRTC_DIRECT);
      
      // Latencies within switchThreshold (50ms)
      tracker.recordLatency(PathType.WEBSOCKET_RELAY, 100);
      tracker.recordLatency(PathType.WEBRTC_DIRECT, 120);
      
      tracker.setPathState(PathType.WEBSOCKET_RELAY, PathState.AVAILABLE);
      tracker.setPathState(PathType.WEBRTC_DIRECT, PathState.AVAILABLE);
      
      const best = tracker.getBestPath();
      // WebRTC has higher priority (lower number)
      expect(best.type).toBe(PathType.WEBRTC_DIRECT);
    });

    it('should exclude failed paths from selection', () => {
      tracker.addPath(PathType.WEBSOCKET_RELAY);
      tracker.addPath(PathType.WEBRTC_DIRECT);
      
      tracker.recordLatency(PathType.WEBSOCKET_RELAY, 200);
      tracker.recordLatency(PathType.WEBRTC_DIRECT, 50);
      
      tracker.setPathState(PathType.WEBSOCKET_RELAY, PathState.AVAILABLE);
      tracker.setPathState(PathType.WEBRTC_DIRECT, PathState.FAILED);
      
      const best = tracker.getBestPath();
      expect(best.type).toBe(PathType.WEBSOCKET_RELAY);
    });

    it('should emit betterPathFound when significantly better path is available', () => {
      const handler = jest.fn();
      tracker.on('betterPathFound', handler);
      
      tracker.addPath(PathType.WEBSOCKET_RELAY);
      tracker.addPath(PathType.WEBRTC_DIRECT);
      
      tracker.recordLatency(PathType.WEBSOCKET_RELAY, 200);
      tracker.setPathState(PathType.WEBSOCKET_RELAY, PathState.AVAILABLE);
      tracker.setActivePath(PathType.WEBSOCKET_RELAY);
      
      // WebRTC becomes available with much better latency
      tracker.recordLatency(PathType.WEBRTC_DIRECT, 50);
      tracker.setPathState(PathType.WEBRTC_DIRECT, PathState.AVAILABLE);
      
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        currentPath: PathType.WEBSOCKET_RELAY,
        betterPath: PathType.WEBRTC_DIRECT,
        improvement: 150
      }));
    });
  });

  describe('Active Path Management', () => {
    it('should set active path', () => {
      tracker.addPath(PathType.WEBSOCKET_RELAY);
      tracker.setPathState(PathType.WEBSOCKET_RELAY, PathState.AVAILABLE);
      
      const result = tracker.setActivePath(PathType.WEBSOCKET_RELAY);
      
      expect(result).toBe(true);
      expect(tracker.getActivePathType()).toBe(PathType.WEBSOCKET_RELAY);
      expect(tracker.getActivePath().state).toBe(PathState.ACTIVE);
    });

    it('should not activate failed path', () => {
      tracker.addPath(PathType.WEBSOCKET_RELAY);
      tracker.setPathState(PathType.WEBSOCKET_RELAY, PathState.FAILED);
      
      const result = tracker.setActivePath(PathType.WEBSOCKET_RELAY);
      
      expect(result).toBe(false);
      expect(tracker.getActivePathType()).toBeNull();
    });

    it('should emit pathSwitched event', () => {
      const handler = jest.fn();
      tracker.on('pathSwitched', handler);
      
      tracker.addPath(PathType.WEBSOCKET_RELAY);
      tracker.addPath(PathType.WEBRTC_DIRECT);
      
      tracker.setPathState(PathType.WEBSOCKET_RELAY, PathState.AVAILABLE);
      tracker.setPathState(PathType.WEBRTC_DIRECT, PathState.AVAILABLE);
      
      tracker.setActivePath(PathType.WEBSOCKET_RELAY);
      tracker.setActivePath(PathType.WEBRTC_DIRECT);
      
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        fromPath: PathType.WEBSOCKET_RELAY,
        toPath: PathType.WEBRTC_DIRECT
      }));
    });
  });

  describe('Measurement Lifecycle', () => {
    it('should start and complete measurement', () => {
      tracker.addPath(PathType.WEBSOCKET_RELAY);
      
      const { pingId, sentAt } = tracker.startMeasurement(PathType.WEBSOCKET_RELAY);
      
      expect(pingId).toBeDefined();
      expect(sentAt).toBeDefined();
      
      // Simulate some delay
      const latency = tracker.completeMeasurement(pingId);
      
      expect(latency).toBeGreaterThanOrEqual(0);
    });

    it('should handle measurement timeout', async () => {
      const handler = jest.fn();
      tracker.on('measurementFailed', handler);
      
      tracker.addPath(PathType.WEBSOCKET_RELAY);
      tracker.startMeasurement(PathType.WEBSOCKET_RELAY);
      
      // Wait for timeout
      await new Promise(resolve => setTimeout(resolve, 600));
      
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        pathType: PathType.WEBSOCKET_RELAY,
        reason: 'timeout'
      }));
    });

    it('should return null for unknown pingId', () => {
      const latency = tracker.completeMeasurement('unknown-ping-id');
      expect(latency).toBeNull();
    });
  });

  describe('Statistics', () => {
    it('should return stats', () => {
      tracker.addPath(PathType.WEBSOCKET_RELAY);
      tracker.recordLatency(PathType.WEBSOCKET_RELAY, 100);
      tracker.setActivePath(PathType.WEBSOCKET_RELAY);
      
      const stats = tracker.getStats();
      
      expect(stats.peerId).toBe(testPeerId);
      expect(stats.activePath).toBe(PathType.WEBSOCKET_RELAY);
      expect(stats.pathCount).toBe(1);
      expect(stats.paths[PathType.WEBSOCKET_RELAY]).toBeDefined();
    });

    it('should return summary string', () => {
      tracker.addPath(PathType.WEBSOCKET_RELAY);
      tracker.recordLatency(PathType.WEBSOCKET_RELAY, 100);
      tracker.setActivePath(PathType.WEBSOCKET_RELAY);
      
      const summary = tracker.getSummary();
      
      expect(summary).toContain('websocket-relay');
      expect(summary).toContain('100ms');
    });
  });

  describe('Cleanup', () => {
    it('should clean up on destroy', () => {
      tracker.addPath(PathType.WEBSOCKET_RELAY);
      tracker.startMeasurementTimer();
      
      tracker.destroy();
      
      expect(tracker.getAllPaths().length).toBe(0);
      expect(tracker.getActivePathType()).toBeNull();
    });

    it('should not add paths after destroy', () => {
      tracker.destroy();
      
      const path = tracker.addPath(PathType.WEBSOCKET_RELAY);
      expect(path).toBeNull();
    });
  });
});
