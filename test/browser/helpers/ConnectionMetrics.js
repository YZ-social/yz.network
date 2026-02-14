/**
 * ConnectionMetrics - Data structure for per-connection metrics
 * Tracks connection state changes and calculates time-based metrics
 * 
 * Requirements: 3.1, 3.2, 4.1
 */
class ConnectionMetrics {
  constructor(peerId) {
    this.peerId = peerId;
    this.connectTime = null;
    this.disconnectTimes = [];
    this.reconnectTimes = [];
    this.totalConnectedTime = 0;
    this.totalDisconnectedTime = 0;
    this._lastStateChangeTime = null;
    this._isConnected = false;
  }

  /**
   * Record initial connection
   * @param {number} timestamp - Connection timestamp in ms
   */
  recordConnect(timestamp) {
    this.connectTime = timestamp;
    this._lastStateChangeTime = timestamp;
    this._isConnected = true;
  }

  /**
   * Record a disconnect event
   * @param {number} timestamp - Disconnect timestamp in ms
   */
  recordDisconnect(timestamp) {
    if (this._isConnected && this._lastStateChangeTime !== null) {
      this.totalConnectedTime += timestamp - this._lastStateChangeTime;
    }
    this.disconnectTimes.push(timestamp);
    this._lastStateChangeTime = timestamp;
    this._isConnected = false;
  }

  /**
   * Record a reconnect event
   * @param {number} timestamp - Reconnect timestamp in ms
   */
  recordReconnect(timestamp) {
    if (!this._isConnected && this._lastStateChangeTime !== null) {
      this.totalDisconnectedTime += timestamp - this._lastStateChangeTime;
    }
    this.reconnectTimes.push(timestamp);
    this._lastStateChangeTime = timestamp;
    this._isConnected = true;
  }

  /**
   * Finalize metrics calculation at end of monitoring period
   * @param {number} endTime - End timestamp in ms
   */
  finalize(endTime) {
    if (this._lastStateChangeTime !== null) {
      if (this._isConnected) {
        this.totalConnectedTime += endTime - this._lastStateChangeTime;
      } else {
        this.totalDisconnectedTime += endTime - this._lastStateChangeTime;
      }
    }
  }

  /**
   * Get total monitoring duration
   * @returns {number} Total time in ms
   */
  getTotalTime() {
    return this.totalConnectedTime + this.totalDisconnectedTime;
  }

  /**
   * Get number of failures (disconnects)
   * @returns {number} Number of disconnect events
   */
  getFailureCount() {
    return this.disconnectTimes.length;
  }
}

export { ConnectionMetrics };
