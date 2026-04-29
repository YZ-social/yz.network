/**
 * PathQualityComparison.test.js
 * 
 * Task 4.4: Tests for path quality comparison using latency, packet loss, and jitter
 * 
 * Tests the composite quality score calculation and path comparison logic
 * that determines which connection path (IPv6, WebRTC, relay) is best.
 */

import { PathTracker, PathType, PathState, PathPriority } from '../../src/network/PathTracker.js';

describe('PathTracker Quality Comparison', () => {
  let tracker;
  const testPeerId = 'test-peer-12345678';

  beforeEach(() => {
    tracker = new PathTracker(testPeerId, {
      measurementInterval: 1000,
      switchThreshold: 50,
      qualitySwitchThreshold: 0.15,
      maxLatencyForScore: 500,
      maxJitterForScore: 100
    });
  });

  afterEach(() => {
    if (tracker) {
      tracker.destroy();
    }
  });

  describe('calculatePathQualityScore', () => {
    test('should return null for path without latency measurement', () => {
      tracker.addPath(PathType.WEBRTC_DIRECT);
      
      const score = tracker.calculatePathQualityScore(PathType.WEBRTC_DIRECT);
      
      expect(score).toBeNull();
    });

    test('should calculate perfect score for 0ms latency, 0% loss, 0ms jitter', () => {
      tracker.addPath(PathType.WEBRTC_DIRECT);
      const path = tracker.getPath(PathType.WEBRTC_DIRECT);
      path.latency = 0;
      path.packetLoss = 0;
      path.jitter = 0;
      
      const score = tracker.calculatePathQualityScore(PathType.WEBRTC_DIRECT);
      
      expect(score).toBe(1);
    });

    test('should calculate lower score for higher latency', () => {
      tracker.addPath(PathType.WEBRTC_DIRECT);
      tracker.addPath(PathType.WEBSOCKET_RELAY);
      
      const webrtcPath = tracker.getPath(PathType.WEBRTC_DIRECT);
      webrtcPath.latency = 50;
      webrtcPath.packetLoss = 0;
      webrtcPath.jitter = 0;
      
      const relayPath = tracker.getPath(PathType.WEBSOCKET_RELAY);
      relayPath.latency = 200;
      relayPath.packetLoss = 0;
      relayPath.jitter = 0;
      
      const webrtcScore = tracker.calculatePathQualityScore(PathType.WEBRTC_DIRECT);
      const relayScore = tracker.calculatePathQualityScore(PathType.WEBSOCKET_RELAY);
      
      expect(webrtcScore).toBeGreaterThan(relayScore);
    });

    test('should calculate lower score for higher packet loss', () => {
      tracker.addPath(PathType.WEBRTC_DIRECT);
      tracker.addPath(PathType.WEBSOCKET_RELAY);
      
      const webrtcPath = tracker.getPath(PathType.WEBRTC_DIRECT);
      webrtcPath.latency = 100;
      webrtcPath.packetLoss = 0.02; // 2% loss
      webrtcPath.jitter = 10;
      
      const relayPath = tracker.getPath(PathType.WEBSOCKET_RELAY);
      relayPath.latency = 100;
      relayPath.packetLoss = 0.15; // 15% loss
      relayPath.jitter = 10;
      
      const webrtcScore = tracker.calculatePathQualityScore(PathType.WEBRTC_DIRECT);
      const relayScore = tracker.calculatePathQualityScore(PathType.WEBSOCKET_RELAY);
      
      expect(webrtcScore).toBeGreaterThan(relayScore);
    });

    test('should calculate lower score for higher jitter', () => {
      tracker.addPath(PathType.WEBRTC_DIRECT);
      tracker.addPath(PathType.WEBSOCKET_RELAY);
      
      const webrtcPath = tracker.getPath(PathType.WEBRTC_DIRECT);
      webrtcPath.latency = 100;
      webrtcPath.packetLoss = 0;
      webrtcPath.jitter = 5; // Low jitter
      
      const relayPath = tracker.getPath(PathType.WEBSOCKET_RELAY);
      relayPath.latency = 100;
      relayPath.packetLoss = 0;
      relayPath.jitter = 80; // High jitter
      
      const webrtcScore = tracker.calculatePathQualityScore(PathType.WEBRTC_DIRECT);
      const relayScore = tracker.calculatePathQualityScore(PathType.WEBSOCKET_RELAY);
      
      expect(webrtcScore).toBeGreaterThan(relayScore);
    });

    test('should use default jitter score when jitter not measured', () => {
      tracker.addPath(PathType.WEBRTC_DIRECT);
      const path = tracker.getPath(PathType.WEBRTC_DIRECT);
      path.latency = 100;
      path.packetLoss = 0;
      path.jitter = null; // Not measured
      
      const score = tracker.calculatePathQualityScore(PathType.WEBRTC_DIRECT);
      
      // Should still calculate a score using default jitter value
      expect(score).not.toBeNull();
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThan(1);
    });

    test('should handle worst-case metrics gracefully', () => {
      tracker.addPath(PathType.WEBSOCKET_RELAY);
      const path = tracker.getPath(PathType.WEBSOCKET_RELAY);
      path.latency = 1000; // Very high latency (above max)
      path.packetLoss = 0.5; // 50% loss
      path.jitter = 200; // Very high jitter (above max)
      
      const score = tracker.calculatePathQualityScore(PathType.WEBSOCKET_RELAY);
      
      // Score should be clamped to valid range
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });
  });

  describe('path comparison with quality scores', () => {
    test('should prefer path with better quality score over path type priority', () => {
      // Add relay path with excellent metrics
      tracker.addPath(PathType.WEBSOCKET_RELAY);
      const relayPath = tracker.getPath(PathType.WEBSOCKET_RELAY);
      relayPath.latency = 30;
      relayPath.packetLoss = 0;
      relayPath.jitter = 2;
      relayPath.state = PathState.AVAILABLE;
      
      // Add WebRTC path with poor metrics
      tracker.addPath(PathType.WEBRTC_DIRECT);
      const webrtcPath = tracker.getPath(PathType.WEBRTC_DIRECT);
      webrtcPath.latency = 300;
      webrtcPath.packetLoss = 0.1;
      webrtcPath.jitter = 50;
      webrtcPath.state = PathState.AVAILABLE;
      
      // Relay should be ranked better despite lower priority
      const ranking = tracker.getPathQualityRanking();
      
      expect(ranking[0].pathType).toBe(PathType.WEBSOCKET_RELAY);
      expect(ranking[1].pathType).toBe(PathType.WEBRTC_DIRECT);
    });

    test('should use priority when quality scores are similar', () => {
      // Add paths with similar quality
      tracker.addPath(PathType.WEBRTC_DIRECT);
      const webrtcPath = tracker.getPath(PathType.WEBRTC_DIRECT);
      webrtcPath.latency = 100;
      webrtcPath.packetLoss = 0.02;
      webrtcPath.jitter = 10;
      webrtcPath.state = PathState.AVAILABLE;
      
      tracker.addPath(PathType.WEBSOCKET_RELAY);
      const relayPath = tracker.getPath(PathType.WEBSOCKET_RELAY);
      relayPath.latency = 105; // Very similar
      relayPath.packetLoss = 0.02;
      relayPath.jitter = 10;
      relayPath.state = PathState.AVAILABLE;
      
      // WebRTC should be preferred due to higher priority
      const bestPath = tracker.getBestPath();
      
      expect(bestPath.type).toBe(PathType.WEBRTC_DIRECT);
    });

    test('should always rank failed paths last', () => {
      tracker.addPath(PathType.WEBRTC_DIRECT);
      const webrtcPath = tracker.getPath(PathType.WEBRTC_DIRECT);
      webrtcPath.latency = 50;
      webrtcPath.packetLoss = 0;
      webrtcPath.jitter = 5;
      webrtcPath.state = PathState.FAILED;
      
      tracker.addPath(PathType.WEBSOCKET_RELAY);
      const relayPath = tracker.getPath(PathType.WEBSOCKET_RELAY);
      relayPath.latency = 200;
      relayPath.packetLoss = 0.05;
      relayPath.jitter = 20;
      relayPath.state = PathState.AVAILABLE;
      
      const ranking = tracker.getPathQualityRanking();
      
      // Relay should be first (available), WebRTC last (failed)
      expect(ranking[0].pathType).toBe(PathType.WEBSOCKET_RELAY);
      expect(ranking[1].pathType).toBe(PathType.WEBRTC_DIRECT);
    });
  });

  describe('getPathQualityBreakdown', () => {
    test('should return detailed quality breakdown', () => {
      tracker.addPath(PathType.WEBRTC_DIRECT);
      const path = tracker.getPath(PathType.WEBRTC_DIRECT);
      path.latency = 100;
      path.packetLoss = 0.05;
      path.jitter = 15;
      path.measurementCount = 10;
      path.successCount = 9;
      path.failureCount = 1;
      
      const breakdown = tracker.getPathQualityBreakdown(PathType.WEBRTC_DIRECT);
      
      expect(breakdown).not.toBeNull();
      expect(breakdown.pathType).toBe(PathType.WEBRTC_DIRECT);
      expect(breakdown.latency).toBe(100);
      expect(breakdown.packetLoss).toBe(0.05);
      expect(breakdown.jitter).toBe(15);
      expect(breakdown.scores.latency).toBeGreaterThan(0);
      expect(breakdown.scores.packetLoss).toBeGreaterThan(0);
      expect(breakdown.scores.jitter).toBeGreaterThan(0);
      expect(breakdown.qualityScore).toBeGreaterThan(0);
      expect(breakdown.weights).toBeDefined();
      expect(breakdown.measurementCount).toBe(10);
    });

    test('should return null for unknown path', () => {
      const breakdown = tracker.getPathQualityBreakdown('unknown-path');
      
      expect(breakdown).toBeNull();
    });
  });

  describe('getPathQualityRanking', () => {
    test('should return all paths sorted by quality', () => {
      // Add three paths with different quality
      tracker.addPath(PathType.IPV6_DIRECT);
      const ipv6Path = tracker.getPath(PathType.IPV6_DIRECT);
      ipv6Path.latency = 20;
      ipv6Path.packetLoss = 0;
      ipv6Path.jitter = 2;
      ipv6Path.state = PathState.AVAILABLE;
      
      tracker.addPath(PathType.WEBRTC_DIRECT);
      const webrtcPath = tracker.getPath(PathType.WEBRTC_DIRECT);
      webrtcPath.latency = 80;
      webrtcPath.packetLoss = 0.02;
      webrtcPath.jitter = 10;
      webrtcPath.state = PathState.AVAILABLE;
      
      tracker.addPath(PathType.WEBSOCKET_RELAY);
      const relayPath = tracker.getPath(PathType.WEBSOCKET_RELAY);
      relayPath.latency = 150;
      relayPath.packetLoss = 0.05;
      relayPath.jitter = 25;
      relayPath.state = PathState.AVAILABLE;
      
      const ranking = tracker.getPathQualityRanking();
      
      expect(ranking).toHaveLength(3);
      expect(ranking[0].pathType).toBe(PathType.IPV6_DIRECT);
      expect(ranking[1].pathType).toBe(PathType.WEBRTC_DIRECT);
      expect(ranking[2].pathType).toBe(PathType.WEBSOCKET_RELAY);
      
      // Verify quality scores are included
      expect(ranking[0].qualityScore).toBeGreaterThan(ranking[1].qualityScore);
      expect(ranking[1].qualityScore).toBeGreaterThan(ranking[2].qualityScore);
    });

    test('should mark active path in ranking', () => {
      tracker.addPath(PathType.WEBRTC_DIRECT);
      const path = tracker.getPath(PathType.WEBRTC_DIRECT);
      path.latency = 100;
      path.state = PathState.AVAILABLE;
      
      tracker.setActivePath(PathType.WEBRTC_DIRECT);
      
      const ranking = tracker.getPathQualityRanking();
      
      expect(ranking[0].isActive).toBe(true);
    });
  });

  describe('betterPathFound event with quality scores', () => {
    test('should emit event with quality score information', async () => {
      // Set up relay as active path
      tracker.addPath(PathType.WEBSOCKET_RELAY);
      const relayPath = tracker.getPath(PathType.WEBSOCKET_RELAY);
      relayPath.latency = 200;
      relayPath.packetLoss = 0.1;
      relayPath.jitter = 30;
      relayPath.state = PathState.ACTIVE;
      tracker.setActivePath(PathType.WEBSOCKET_RELAY);
      
      // Add WebRTC path with much better quality
      tracker.addPath(PathType.WEBRTC_DIRECT);
      const webrtcPath = tracker.getPath(PathType.WEBRTC_DIRECT);
      webrtcPath.packetLoss = 0;
      webrtcPath.jitter = 5;
      webrtcPath.state = PathState.AVAILABLE;
      
      // Listen for betterPathFound event
      const eventPromise = new Promise(resolve => {
        tracker.on('betterPathFound', resolve);
      });
      
      // Record latency which triggers path comparison
      tracker.recordLatency(PathType.WEBRTC_DIRECT, 50);
      
      const event = await eventPromise;
      
      expect(event.currentPath).toBe(PathType.WEBSOCKET_RELAY);
      expect(event.betterPath).toBe(PathType.WEBRTC_DIRECT);
      expect(event.currentQualityScore).toBeDefined();
      expect(event.betterQualityScore).toBeDefined();
      expect(event.betterQualityScore).toBeGreaterThan(event.currentQualityScore);
      expect(event.qualityImprovement).toBeGreaterThan(0);
    });
  });

  describe('getSummary with quality scores', () => {
    test('should include quality scores in summary', () => {
      tracker.addPath(PathType.WEBRTC_DIRECT);
      const path = tracker.getPath(PathType.WEBRTC_DIRECT);
      path.latency = 100;
      path.packetLoss = 0.05;
      path.jitter = 10;
      path.state = PathState.AVAILABLE;
      
      const summary = tracker.getSummary();
      
      // Summary should include quality score (Q0.xx format)
      expect(summary).toMatch(/Q\d+\.\d+/);
      expect(summary).toContain('webrtc-direct');
      expect(summary).toContain('100ms');
      expect(summary).toContain('5%loss');
    });
  });

  describe('getStats with quality scores', () => {
    test('should include quality scores in stats', () => {
      tracker.addPath(PathType.WEBRTC_DIRECT);
      const path = tracker.getPath(PathType.WEBRTC_DIRECT);
      path.latency = 100;
      path.packetLoss = 0.02;
      path.jitter = 10;
      path.state = PathState.ACTIVE;
      tracker.setActivePath(PathType.WEBRTC_DIRECT);
      
      const stats = tracker.getStats();
      
      expect(stats.activePathQuality).not.toBeNull();
      expect(stats.paths[PathType.WEBRTC_DIRECT].qualityScore).not.toBeNull();
      expect(stats.paths[PathType.WEBRTC_DIRECT].successCount).toBeDefined();
      expect(stats.paths[PathType.WEBRTC_DIRECT].failureCount).toBeDefined();
    });
  });

  describe('quality score edge cases', () => {
    test('should handle path with only latency (no loss/jitter)', () => {
      tracker.addPath(PathType.WEBRTC_DIRECT);
      const path = tracker.getPath(PathType.WEBRTC_DIRECT);
      path.latency = 100;
      // packetLoss defaults to 0, jitter is null
      
      const score = tracker.calculatePathQualityScore(PathType.WEBRTC_DIRECT);
      
      expect(score).not.toBeNull();
      expect(score).toBeGreaterThan(0);
    });

    test('should handle 100% packet loss', () => {
      tracker.addPath(PathType.WEBRTC_DIRECT);
      const path = tracker.getPath(PathType.WEBRTC_DIRECT);
      path.latency = 100;
      path.packetLoss = 1.0; // 100% loss
      path.jitter = 10;
      
      const score = tracker.calculatePathQualityScore(PathType.WEBRTC_DIRECT);
      
      // Score should be low but still valid
      // With 100% packet loss (35% weight = 0), latency 100ms (50% weight ≈ 0.4), jitter 10ms (15% weight ≈ 0.135)
      // Expected score ≈ 0.4 * 0.5 + 0 * 0.35 + 0.9 * 0.15 ≈ 0.335
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThan(0.7); // Should be noticeably lower than a healthy path
    });

    test('should accept path object directly', () => {
      tracker.addPath(PathType.WEBRTC_DIRECT);
      const path = tracker.getPath(PathType.WEBRTC_DIRECT);
      path.latency = 100;
      path.packetLoss = 0;
      path.jitter = 10;
      
      // Pass path object directly instead of path type string
      const score = tracker.calculatePathQualityScore(path);
      
      expect(score).not.toBeNull();
      expect(score).toBeGreaterThan(0);
    });
  });
});
