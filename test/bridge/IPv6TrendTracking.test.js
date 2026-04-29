/**
 * IPv6TrendTracking.test.js
 * 
 * Tests for Task 6.2: Report IPv6 adoption trends over time
 * 
 * These tests verify that:
 * 1. IPv6 trend snapshots are taken correctly
 * 2. Trend calculations work with various data patterns
 * 3. Platform and browser-specific trends are tracked
 * 4. Insights are generated based on trend data
 * 5. Trend data is included in the metrics endpoint
 */

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// Mock WebSocket
const mockWebSocket = {
  OPEN: 1,
  CLOSED: 3
};

// Mock the ws module
jest.unstable_mockModule('ws', () => ({
  WebSocketServer: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    close: jest.fn()
  })),
  WebSocket: mockWebSocket,
  default: {
    Server: jest.fn().mockImplementation(() => ({
      on: jest.fn(),
      close: jest.fn()
    })),
    OPEN: 1,
    CLOSED: 3
  }
}));

// Mock http module
jest.unstable_mockModule('http', () => ({
  createServer: jest.fn().mockReturnValue({
    listen: jest.fn((port, cb) => cb && cb()),
    close: jest.fn(),
    on: jest.fn()
  }),
  default: {
    createServer: jest.fn().mockReturnValue({
      listen: jest.fn((port, cb) => cb && cb()),
      close: jest.fn(),
      on: jest.fn()
    })
  }
}));

// Import after mocking
const { EnhancedBootstrapServer } = await import('../../src/bridge/EnhancedBootstrapServer.js');

describe('IPv6 Trend Tracking (Task 6.2)', () => {
  let server;

  beforeEach(() => {
    jest.useFakeTimers();
    server = new EnhancedBootstrapServer({ port: 9999 });
    
    // Stop the automatic trend tracking timer for controlled testing
    server._stopIPv6TrendTracking();
  });

  afterEach(() => {
    if (server) {
      server._stopIPv6TrendTracking();
    }
    jest.useRealTimers();
  });

  describe('Snapshot Creation', () => {
    test('should create hourly snapshot with correct structure', () => {
      // Set up some connection profile data
      server.connectionProfileMetrics.totalReports = 100;
      server.connectionProfileMetrics.ipv6Capable = 45;
      server.connectionProfileMetrics.needsRelay = 20;
      server.connectionProfileMetrics.natTypes = { open: 10, easy: 50, hard: 30, unknown: 10 };
      server.connectionProfileMetrics.ipv6ByCategory = {
        'desktop-windows': { total: 50, ipv6Capable: 20 },
        'mobile-android': { total: 30, ipv6Capable: 15 },
        'desktop-macos': { total: 20, ipv6Capable: 10 }
      };
      server.connectionProfileMetrics.ipv6ByBrowser = {
        'chrome': { total: 60, ipv6Capable: 30 },
        'firefox': { total: 25, ipv6Capable: 10 },
        'safari': { total: 15, ipv6Capable: 5 }
      };

      // Take a snapshot
      server._takeIPv6Snapshot('hourly');

      // Verify snapshot was created
      expect(server.ipv6TrendData.hourlySnapshots.length).toBe(1);
      
      const snapshot = server.ipv6TrendData.hourlySnapshots[0];
      expect(snapshot.totalPeers).toBe(100);
      expect(snapshot.ipv6Capable).toBe(45);
      expect(snapshot.ipv6Percentage).toBe(45);
      expect(snapshot.needsRelay).toBe(20);
      expect(snapshot.needsRelayPercentage).toBe(20);
      expect(snapshot.timestamp).toBeDefined();
      expect(snapshot.timestampISO).toBeDefined();
      expect(snapshot.byCategory).toBeDefined();
      expect(snapshot.byBrowser).toBeDefined();
    });

    test('should not create snapshot when no data', () => {
      server.connectionProfileMetrics.totalReports = 0;
      
      server._takeIPv6Snapshot('hourly');
      
      expect(server.ipv6TrendData.hourlySnapshots.length).toBe(0);
    });

    test('should limit hourly snapshots to maxHourlySnapshots', () => {
      server.connectionProfileMetrics.totalReports = 100;
      server.connectionProfileMetrics.ipv6Capable = 50;
      server.ipv6TrendData.maxHourlySnapshots = 5;

      // Take more snapshots than the limit
      for (let i = 0; i < 10; i++) {
        server._takeIPv6Snapshot('hourly');
      }

      expect(server.ipv6TrendData.hourlySnapshots.length).toBe(5);
    });

    test('should create daily and weekly snapshots', () => {
      server.connectionProfileMetrics.totalReports = 100;
      server.connectionProfileMetrics.ipv6Capable = 50;

      server._takeIPv6Snapshot('daily');
      server._takeIPv6Snapshot('weekly');

      expect(server.ipv6TrendData.dailySnapshots.length).toBe(1);
      expect(server.ipv6TrendData.weeklySnapshots.length).toBe(1);
      expect(server.ipv6TrendData.lastDailySnapshot).toBeDefined();
      expect(server.ipv6TrendData.lastWeeklySnapshot).toBeDefined();
    });
  });

  describe('Trend Calculation', () => {
    test('should return insufficient_data when less than 2 snapshots', () => {
      const trends = server.getIPv6AdoptionTrends();
      
      expect(trends.shortTerm.trend).toBe('insufficient_data');
      expect(trends.shortTerm.direction).toBe('unknown');
      expect(trends.shortTerm.dataPoints).toBe(0);
    });

    test('should detect increasing trend', () => {
      // Create snapshots with increasing IPv6 adoption
      const baseTime = Date.now();
      server.ipv6TrendData.hourlySnapshots = [
        { timestamp: baseTime - 3600000 * 3, ipv6Percentage: 30, totalPeers: 100, ipv6Capable: 30 },
        { timestamp: baseTime - 3600000 * 2, ipv6Percentage: 35, totalPeers: 100, ipv6Capable: 35 },
        { timestamp: baseTime - 3600000, ipv6Percentage: 40, totalPeers: 100, ipv6Capable: 40 },
        { timestamp: baseTime, ipv6Percentage: 45, totalPeers: 100, ipv6Capable: 45 }
      ];

      const trends = server.getIPv6AdoptionTrends();
      
      expect(trends.shortTerm.direction).toBe('increasing');
      expect(trends.shortTerm.changePercentagePoints).toBe(15);
      expect(trends.shortTerm.startValue).toBe(30);
      expect(trends.shortTerm.endValue).toBe(45);
    });

    test('should detect decreasing trend', () => {
      const baseTime = Date.now();
      server.ipv6TrendData.hourlySnapshots = [
        { timestamp: baseTime - 3600000 * 3, ipv6Percentage: 50, totalPeers: 100, ipv6Capable: 50 },
        { timestamp: baseTime - 3600000 * 2, ipv6Percentage: 45, totalPeers: 100, ipv6Capable: 45 },
        { timestamp: baseTime - 3600000, ipv6Percentage: 40, totalPeers: 100, ipv6Capable: 40 },
        { timestamp: baseTime, ipv6Percentage: 35, totalPeers: 100, ipv6Capable: 35 }
      ];

      const trends = server.getIPv6AdoptionTrends();
      
      expect(trends.shortTerm.direction).toBe('decreasing');
      expect(trends.shortTerm.changePercentagePoints).toBe(-15);
    });

    test('should detect stable trend', () => {
      const baseTime = Date.now();
      server.ipv6TrendData.hourlySnapshots = [
        { timestamp: baseTime - 3600000 * 3, ipv6Percentage: 40, totalPeers: 100, ipv6Capable: 40 },
        { timestamp: baseTime - 3600000 * 2, ipv6Percentage: 41, totalPeers: 100, ipv6Capable: 41 },
        { timestamp: baseTime - 3600000, ipv6Percentage: 40, totalPeers: 100, ipv6Capable: 40 },
        { timestamp: baseTime, ipv6Percentage: 41, totalPeers: 100, ipv6Capable: 41 }
      ];

      const trends = server.getIPv6AdoptionTrends();
      
      expect(trends.shortTerm.direction).toBe('stable');
      expect(Math.abs(trends.shortTerm.changePercentagePoints)).toBeLessThanOrEqual(2);
    });

    test('should calculate min, max, and average values', () => {
      const baseTime = Date.now();
      server.ipv6TrendData.hourlySnapshots = [
        { timestamp: baseTime - 3600000 * 4, ipv6Percentage: 30, totalPeers: 100, ipv6Capable: 30 },
        { timestamp: baseTime - 3600000 * 3, ipv6Percentage: 50, totalPeers: 100, ipv6Capable: 50 },
        { timestamp: baseTime - 3600000 * 2, ipv6Percentage: 20, totalPeers: 100, ipv6Capable: 20 },
        { timestamp: baseTime - 3600000, ipv6Percentage: 40, totalPeers: 100, ipv6Capable: 40 },
        { timestamp: baseTime, ipv6Percentage: 35, totalPeers: 100, ipv6Capable: 35 }
      ];

      const trends = server.getIPv6AdoptionTrends();
      
      expect(trends.shortTerm.minValue).toBe(20);
      expect(trends.shortTerm.maxValue).toBe(50);
      expect(trends.shortTerm.avgValue).toBe(35); // (30+50+20+40+35)/5 = 35
    });

    test('should include regression analysis', () => {
      const baseTime = Date.now();
      server.ipv6TrendData.hourlySnapshots = [
        { timestamp: baseTime - 3600000 * 3, ipv6Percentage: 30, totalPeers: 100, ipv6Capable: 30 },
        { timestamp: baseTime - 3600000 * 2, ipv6Percentage: 35, totalPeers: 100, ipv6Capable: 35 },
        { timestamp: baseTime - 3600000, ipv6Percentage: 40, totalPeers: 100, ipv6Capable: 40 },
        { timestamp: baseTime, ipv6Percentage: 45, totalPeers: 100, ipv6Capable: 45 }
      ];

      const trends = server.getIPv6AdoptionTrends();
      
      expect(trends.shortTerm.regression).toBeDefined();
      expect(trends.shortTerm.regression.slope).toBeGreaterThan(0); // Positive slope for increasing trend
      expect(trends.shortTerm.regression.r2).toBeGreaterThan(0.9); // High R² for linear data
    });
  });

  describe('Platform and Browser Trends', () => {
    test('should calculate platform-specific trends', () => {
      const baseTime = Date.now();
      server.ipv6TrendData.dailySnapshots = [
        {
          timestamp: baseTime - 86400000 * 2,
          ipv6Percentage: 40,
          byCategory: {
            'desktop-windows': { total: 50, ipv6Capable: 15, ipv6Percentage: 30 },
            'mobile-android': { total: 30, ipv6Capable: 18, ipv6Percentage: 60 }
          }
        },
        {
          timestamp: baseTime,
          ipv6Percentage: 50,
          byCategory: {
            'desktop-windows': { total: 50, ipv6Capable: 20, ipv6Percentage: 40 },
            'mobile-android': { total: 30, ipv6Capable: 21, ipv6Percentage: 70 }
          }
        }
      ];

      const trends = server.getIPv6AdoptionTrends();
      
      expect(trends.platformTrends['desktop-windows']).toBeDefined();
      expect(trends.platformTrends['desktop-windows'].changePercentagePoints).toBe(10);
      expect(trends.platformTrends['mobile-android']).toBeDefined();
      expect(trends.platformTrends['mobile-android'].changePercentagePoints).toBe(10);
    });

    test('should calculate browser-specific trends', () => {
      const baseTime = Date.now();
      server.ipv6TrendData.dailySnapshots = [
        {
          timestamp: baseTime - 86400000 * 2,
          ipv6Percentage: 40,
          byBrowser: {
            'chrome': { total: 60, ipv6Capable: 24, ipv6Percentage: 40 },
            'firefox': { total: 25, ipv6Capable: 10, ipv6Percentage: 40 }
          }
        },
        {
          timestamp: baseTime,
          ipv6Percentage: 50,
          byBrowser: {
            'chrome': { total: 60, ipv6Capable: 30, ipv6Percentage: 50 },
            'firefox': { total: 25, ipv6Capable: 15, ipv6Percentage: 60 }
          }
        }
      ];

      const trends = server.getIPv6AdoptionTrends();
      
      expect(trends.browserTrends['chrome']).toBeDefined();
      expect(trends.browserTrends['chrome'].changePercentagePoints).toBe(10);
      expect(trends.browserTrends['firefox']).toBeDefined();
      expect(trends.browserTrends['firefox'].changePercentagePoints).toBe(20);
    });
  });

  describe('Insights Generation', () => {
    test('should generate positive insight for high IPv6 adoption', () => {
      server.connectionProfileMetrics.totalReports = 100;
      server.connectionProfileMetrics.ipv6Capable = 60;
      server.connectionProfileMetrics.needsRelay = 10;

      const trends = server.getIPv6AdoptionTrends();
      
      const adoptionInsight = trends.insights.find(i => i.category === 'adoption');
      expect(adoptionInsight).toBeDefined();
      expect(adoptionInsight.type).toBe('positive');
    });

    test('should generate info insight for low IPv6 adoption', () => {
      server.connectionProfileMetrics.totalReports = 100;
      server.connectionProfileMetrics.ipv6Capable = 15;
      server.connectionProfileMetrics.needsRelay = 40;

      const trends = server.getIPv6AdoptionTrends();
      
      const adoptionInsight = trends.insights.find(i => i.category === 'adoption');
      expect(adoptionInsight).toBeDefined();
      expect(adoptionInsight.type).toBe('info');
    });

    test('should generate mobile vs desktop comparison insight', () => {
      server.connectionProfileMetrics.totalReports = 100;
      server.connectionProfileMetrics.ipv6Capable = 50;
      server.connectionProfileMetrics.ipv6ByCategory = {
        'mobile-android': { total: 40, ipv6Capable: 32 }, // 80%
        'desktop-windows': { total: 60, ipv6Capable: 18 }  // 30%
      };

      const trends = server.getIPv6AdoptionTrends();
      
      const platformInsight = trends.insights.find(i => i.category === 'platform');
      expect(platformInsight).toBeDefined();
      expect(platformInsight.message).toContain('Mobile');
    });
  });

  describe('Trend Caching', () => {
    test('should cache trend results', () => {
      server.connectionProfileMetrics.totalReports = 100;
      server.connectionProfileMetrics.ipv6Capable = 50;

      // First call
      const trends1 = server.getIPv6AdoptionTrends();
      
      // Modify data
      server.connectionProfileMetrics.ipv6Capable = 60;
      
      // Second call should return cached result
      const trends2 = server.getIPv6AdoptionTrends();
      
      expect(trends2.current.ipv6Capable).toBe(trends1.current.ipv6Capable);
    });

    test('should invalidate cache after snapshot', () => {
      server.connectionProfileMetrics.totalReports = 100;
      server.connectionProfileMetrics.ipv6Capable = 50;

      // First call
      const trends1 = server.getIPv6AdoptionTrends();
      
      // Take a snapshot (invalidates cache)
      server._takeIPv6Snapshot('hourly');
      
      // Modify data
      server.connectionProfileMetrics.ipv6Capable = 60;
      
      // Second call should return fresh result
      const trends2 = server.getIPv6AdoptionTrends();
      
      expect(trends2.current.ipv6Capable).toBe(60);
    });
  });

  describe('Metrics Endpoint Integration', () => {
    test('should include ipv6Trends in getConnectionMetrics', () => {
      server.connectionProfileMetrics.totalReports = 100;
      server.connectionProfileMetrics.ipv6Capable = 50;

      const metrics = server.getConnectionMetrics();
      
      expect(metrics.ipv6Trends).toBeDefined();
      expect(metrics.ipv6Trends.current).toBeDefined();
      expect(metrics.ipv6Trends.shortTerm).toBeDefined();
      expect(metrics.ipv6Trends.mediumTerm).toBeDefined();
      expect(metrics.ipv6Trends.longTerm).toBeDefined();
      expect(metrics.ipv6Trends.insights).toBeDefined();
    });
  });

  describe('Linear Regression', () => {
    test('should calculate correct regression for linear data', () => {
      // y = 2x + 10
      const points = [[0, 10], [1, 12], [2, 14], [3, 16], [4, 18]];
      
      const result = server._linearRegression(points);
      
      expect(result.slope).toBeCloseTo(2, 1);
      expect(result.intercept).toBeCloseTo(10, 1);
      expect(result.r2).toBeCloseTo(1, 2); // Perfect linear fit
    });

    test('should handle insufficient data', () => {
      const result = server._linearRegression([[0, 10]]);
      
      expect(result.slope).toBe(0);
      expect(result.intercept).toBe(0);
      expect(result.r2).toBe(0);
    });
  });

  describe('Automatic Snapshot Scheduling', () => {
    test('should start trend tracking on initialization', () => {
      const newServer = new EnhancedBootstrapServer({ port: 9998 });
      
      // The timer should be set
      expect(newServer._ipv6HourlyTimer).toBeDefined();
      
      // Clean up
      newServer._stopIPv6TrendTracking();
    });

    test('should stop trend tracking on cleanup', () => {
      const newServer = new EnhancedBootstrapServer({ port: 9997 });
      
      newServer._stopIPv6TrendTracking();
      
      expect(newServer._ipv6HourlyTimer).toBeNull();
    });
  });
});
