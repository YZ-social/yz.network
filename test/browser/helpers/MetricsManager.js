/**
 * MetricsManager - Tracks and calculates stability metrics
 * 
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.6
 */
import { ConnectionMetrics } from './ConnectionMetrics.js';

class MetricsManager {
  constructor() {
    this.connections = new Map(); // peerId -> ConnectionMetrics
    this.events = [];             // All connection events
    this.startTime = null;
    this.endTime = null;
  }

  /**
   * Start monitoring period
   * @param {number} timestamp - Start timestamp in ms
   */
  start(timestamp) {
    this.startTime = timestamp;
  }

  /**
   * End monitoring period and finalize all metrics
   * @param {number} timestamp - End timestamp in ms
   */
  stop(timestamp) {
    this.endTime = timestamp;
    for (const metrics of this.connections.values()) {
      metrics.finalize(timestamp);
    }
  }

  /**
   * Record a connection event
   * @param {string} type - Event type: 'connect', 'disconnect', 'reconnect'
   * @param {string} peerId - Peer identifier
   * @param {number} timestamp - Event timestamp in ms
   * @param {Object} metadata - Additional event metadata
   */
  recordEvent(type, peerId, timestamp, metadata = {}) {
    const event = { type, peerId, timestamp, metadata };
    this.events.push(event);

    if (!this.connections.has(peerId)) {
      this.connections.set(peerId, new ConnectionMetrics(peerId));
    }

    const metrics = this.connections.get(peerId);
    switch (type) {
      case 'connect':
        metrics.recordConnect(timestamp);
        break;
      case 'disconnect':
        metrics.recordDisconnect(timestamp);
        break;
      case 'reconnect':
        metrics.recordReconnect(timestamp);
        break;
    }
  }

  /**
   * Calculate uptime percentage for a connection
   * @param {string} peerId - Peer identifier
   * @returns {number} Uptime percentage (0-100)
   */
  calculateUptime(peerId) {
    const metrics = this.connections.get(peerId);
    if (!metrics) return 0;

    const totalTime = metrics.getTotalTime();
    if (totalTime === 0) return 0;

    return (metrics.totalConnectedTime / totalTime) * 100;
  }

  /**
   * Calculate churn rate (disconnects per minute)
   * @returns {number} Churn rate
   */
  calculateChurnRate() {
    if (this.startTime === null || this.endTime === null) return 0;

    const durationMinutes = (this.endTime - this.startTime) / 60000;
    if (durationMinutes === 0) return 0;

    const disconnectCount = this.events.filter(e => e.type === 'disconnect').length;
    return disconnectCount / durationMinutes;
  }

  /**
   * Calculate MTBF (Mean Time Between Failures) for a connection
   * @param {string} peerId - Peer identifier
   * @returns {number|null} MTBF in ms, or null if no failures
   */
  calculateMTBF(peerId) {
    const metrics = this.connections.get(peerId);
    if (!metrics) return null;

    const failureCount = metrics.getFailureCount();
    if (failureCount === 0) return null;

    return metrics.totalConnectedTime / failureCount;
  }

  /**
   * Check if a connection is stable (uptime >= 99%)
   * @param {string} peerId - Peer identifier
   * @returns {boolean} True if stable
   */
  isStable(peerId) {
    return this.calculateUptime(peerId) >= 99;
  }

  /**
   * Get total event counts
   * @returns {Object} Event counts by type
   */
  getEventCounts() {
    const counts = { connect: 0, disconnect: 0, reconnect: 0 };
    for (const event of this.events) {
      if (counts.hasOwnProperty(event.type)) {
        counts[event.type]++;
      }
    }
    return counts;
  }

  /**
   * Get summary of all metrics
   * @returns {Object} StabilityReport
   */
  getSummary() {
    const duration = this.endTime && this.startTime 
      ? this.endTime - this.startTime 
      : 0;

    const eventCounts = this.getEventCounts();
    const connectionSummaries = [];

    for (const [peerId, metrics] of this.connections) {
      connectionSummaries.push({
        peerId,
        uptime: this.calculateUptime(peerId),
        mtbf: this.calculateMTBF(peerId),
        isStable: this.isStable(peerId),
        disconnects: metrics.disconnectTimes.length,
        reconnects: metrics.reconnectTimes.length
      });
    }

    const overallStability = connectionSummaries.every(c => c.isStable);

    return {
      duration,
      totalConnections: this.connections.size,
      totalDisconnects: eventCounts.disconnect,
      totalReconnects: eventCounts.reconnect,
      churnRate: this.calculateChurnRate(),
      connections: connectionSummaries,
      overallStability
    };
  }
}

export { MetricsManager };
