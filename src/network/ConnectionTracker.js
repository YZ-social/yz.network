/**
 * ConnectionTracker.js
 * 
 * Provides WebRTC connection state classification and metrics tracking
 * for robust resource cleanup and monitoring.
 */

/**
 * Connection state classification for cleanup decisions.
 * Classifies RTCPeerConnection states as transitional (unsafe for cleanup)
 * or stable (safe for cleanup).
 */
export const ConnectionStates = {
  /** States where cleanup is unsafe - connection may still be negotiating */
  TRANSITIONAL: ['new', 'connecting', 'disconnected'],
  
  /** States where cleanup is safe - connection is terminal or stable */
  STABLE: ['connected', 'failed', 'closed'],
  
  /**
   * Check if state is transitional (cleanup should wait)
   * @param {string} state - RTCPeerConnection.connectionState value
   * @returns {boolean}
   */
  isTransitional(state) {
    return this.TRANSITIONAL.includes(state);
  },
  
  /**
   * Check if state is stable (cleanup can proceed)
   * @param {string} state - RTCPeerConnection.connectionState value
   * @returns {boolean}
   */
  isStable(state) {
    return this.STABLE.includes(state);
  }
};

/**
 * Tracks WebRTC connection metrics for monitoring and debugging.
 * Singleton pattern - shared across all WebRTCConnectionManager instances.
 * 
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 */
export class ConnectionTracker {
  /** Number of currently active connections */
  static activeConnections = 0;
  
  /** Number of successful cleanup operations */
  static cleanupSuccesses = 0;
  
  /** Number of failed cleanup operations */
  static cleanupFailures = 0;
  
  /** Detailed cleanup failure logs */
  static failureLogs = [];

  /** Maximum number of failure logs to retain */
  static MAX_FAILURE_LOGS = 10;
  
  /**
   * Track a new connection being established.
   * Called when RTCPeerConnection is successfully created.
   */
  static trackConnectionCreated() {
    this.activeConnections++;
  }
  
  /**
   * Track a connection being closed.
   * @param {boolean} success - Whether cleanup succeeded
   * @param {string} reason - Reason for closure (e.g., 'manual', 'timeout', 'unexpected_disconnect')
   * @param {Object} details - Additional details
   * @param {string} [details.peerId] - Peer ID being cleaned up
   * @param {string} [details.connectionState] - Connection state at cleanup time
   * @param {string} [details.iceConnectionState] - ICE connection state at cleanup time
   * @param {string} [details.error] - Error message if cleanup failed
   */
  static trackConnectionClosed(success, reason, details = {}) {
    if (success) {
      this.cleanupSuccesses++;
      if (this.activeConnections > 0) {
        this.activeConnections--;
      }
    } else {
      this.cleanupFailures++;
      // Log failure details for debugging
      const failureLog = {
        timestamp: Date.now(),
        reason,
        peerId: details.peerId || 'unknown',
        connectionState: details.connectionState || 'unknown',
        iceConnectionState: details.iceConnectionState || 'unknown',
        error: details.error || 'unknown error'
      };
      this.failureLogs.push(failureLog);
      // Keep only the most recent failures
      if (this.failureLogs.length > this.MAX_FAILURE_LOGS) {
        this.failureLogs.shift();
      }
    }
  }
  
  /**
   * Get current resource statistics.
   * @returns {Object} Stats object with connection metrics
   */
  static getResourceStats() {
    const total = this.cleanupSuccesses + this.cleanupFailures;
    const successRate = total > 0 
      ? ((this.cleanupSuccesses / total) * 100).toFixed(1) + '%'
      : 'N/A';
    
    return {
      activeConnections: this.activeConnections,
      cleanupSuccesses: this.cleanupSuccesses,
      cleanupFailures: this.cleanupFailures,
      successRate,
      recentFailures: [...this.failureLogs]
    };
  }
  
  /**
   * Reset all counters (for testing).
   */
  static reset() {
    this.activeConnections = 0;
    this.cleanupSuccesses = 0;
    this.cleanupFailures = 0;
    this.failureLogs = [];
  }
}
