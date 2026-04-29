import { EventEmitter } from 'events';

/**
 * PathTracker - Tracks multiple candidate connection paths with measured latency
 * 
 * Task 4.1: Track multiple candidate paths with measured latency
 * 
 * This module implements the Tailscale philosophy: "try everything at once, and pick
 * the best thing that works." It tracks all available paths to a peer and continuously
 * measures their quality (latency, packet loss, availability).
 * 
 * Path Types:
 * - ipv6-direct: Direct IPv6 connection (best - no NAT traversal needed)
 * - webrtc-direct: WebRTC peer-to-peer via ICE/STUN hole-punching
 * - websocket-relay: WebSocket relay through bridge/DHT nodes (guaranteed fallback)
 * 
 * Each path has:
 * - type: Path type identifier
 * - state: 'probing' | 'available' | 'active' | 'failed' | 'stale'
 * - latency: Measured RTT in milliseconds (null if not measured)
 * - lastMeasured: Timestamp of last latency measurement
 * - packetLoss: Estimated packet loss ratio (0-1)
 * - metadata: Path-specific metadata (relay node ID, ICE candidate type, etc.)
 * 
 * See: .kiro/specs/symmetric-nat-relay/design.md for detailed rationale
 */

/**
 * Path types in priority order (lower number = higher priority when latencies are equal)
 */
export const PathType = {
  IPV6_DIRECT: 'ipv6-direct',
  WEBRTC_DIRECT: 'webrtc-direct',
  WEBSOCKET_RELAY: 'websocket-relay'
};

/**
 * Path priority (used when latencies are similar)
 */
export const PathPriority = {
  [PathType.IPV6_DIRECT]: 1,      // Best: No NAT at all
  [PathType.WEBRTC_DIRECT]: 2,    // Good: ICE hole-punch via STUN
  [PathType.WEBSOCKET_RELAY]: 3   // Fallback: Our relay nodes
};

/**
 * Path states
 */
export const PathState = {
  PROBING: 'probing',     // Currently being tested
  AVAILABLE: 'available', // Working but not active
  ACTIVE: 'active',       // Currently in use
  FAILED: 'failed',       // Failed to establish or lost
  STALE: 'stale'          // Not measured recently, may still work
};

/**
 * Default configuration
 */
const DEFAULT_OPTIONS = {
  // How often to re-measure path latency (ms)
  measurementInterval: 30000, // 30 seconds
  
  // How long before a path is considered stale (ms)
  staleThreshold: 60000, // 1 minute
  
  // Number of ping samples to average for latency
  latencySamples: 5,
  
  // Timeout for latency measurement (ms)
  measurementTimeout: 5000,
  
  // Latency difference threshold for path switching (ms)
  // Only switch paths if new path is this much better
  switchThreshold: 50,
  
  // Maximum latency history to keep per path
  maxLatencyHistory: 20,
  
  // Packet loss threshold to consider path degraded
  packetLossThreshold: 0.1, // 10%
  
  // Quality score weights for path comparison
  // Task 4.4: Compare path quality using latency, packet loss, and jitter
  qualityWeights: {
    latency: 0.50,      // 50% weight on latency (most important for real-time)
    packetLoss: 0.35,   // 35% weight on packet loss (critical for reliability)
    jitter: 0.15        // 15% weight on jitter (affects consistency)
  },
  
  // Reference values for quality score normalization
  // Latency: 0ms = perfect, 500ms = worst
  maxLatencyForScore: 500,
  // Jitter: 0ms = perfect, 100ms = worst
  maxJitterForScore: 100,
  
  // Quality score threshold for path switching
  // Only switch if new path's quality score is this much better (0-1 scale)
  qualitySwitchThreshold: 0.15
};

/**
 * PathTracker - Tracks and measures multiple connection paths to a peer
 */
export class PathTracker extends EventEmitter {
  /**
   * Create a new PathTracker for a specific peer
   * @param {string} peerId - The peer ID this tracker is for
   * @param {Object} options - Configuration options
   */
  constructor(peerId, options = {}) {
    super();
    
    this.peerId = peerId;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    
    // Map of pathType → PathInfo
    this._paths = new Map();
    
    // Currently active path type
    this._activePath = null;
    
    // Measurement state
    this._pendingMeasurements = new Map(); // pingId → { pathType, sentAt, timeout }
    this._measurementTimer = null;
    
    // Statistics
    this._stats = {
      pathSwitches: 0,
      measurementsSent: 0,
      measurementsReceived: 0,
      measurementsTimedOut: 0
    };
    
    // Destroyed flag
    this._destroyed = false;
  }

  /**
   * Add or update a path
   * @param {string} pathType - Path type (from PathType enum)
   * @param {Object} metadata - Path-specific metadata
   * @returns {Object} The path info object
   */
  addPath(pathType, metadata = {}) {
    if (this._destroyed) return null;
    
    let path = this._paths.get(pathType);
    
    if (!path) {
      path = {
        type: pathType,
        priority: PathPriority[pathType] || 99,
        state: PathState.PROBING,
        latency: null,
        latencyHistory: [],
        jitter: null,
        packetLoss: 0,
        lastMeasured: null,
        lastUsed: null,
        createdAt: Date.now(),
        metadata: {},
        measurementCount: 0,
        successCount: 0,
        failureCount: 0
      };
      this._paths.set(pathType, path);
      
      console.log(`📊 PathTracker[${this.peerId.substring(0, 8)}]: Added path ${pathType}`);
      this.emit('pathAdded', { peerId: this.peerId, pathType, path });
    }
    
    // Update metadata
    path.metadata = { ...path.metadata, ...metadata };
    
    return path;
  }

  /**
   * Remove a path
   * @param {string} pathType - Path type to remove
   */
  removePath(pathType) {
    const path = this._paths.get(pathType);
    if (!path) return;
    
    // If this was the active path, we need to switch
    if (this._activePath === pathType) {
      this._activePath = null;
      this._selectBestPath();
    }
    
    this._paths.delete(pathType);
    
    console.log(`📊 PathTracker[${this.peerId.substring(0, 8)}]: Removed path ${pathType}`);
    this.emit('pathRemoved', { peerId: this.peerId, pathType });
  }

  /**
   * Update path state
   * @param {string} pathType - Path type
   * @param {string} state - New state (from PathState enum)
   * @param {string} reason - Reason for state change
   */
  setPathState(pathType, state, reason = '') {
    const path = this._paths.get(pathType);
    if (!path) return;
    
    const oldState = path.state;
    if (oldState === state) return;
    
    path.state = state;
    
    console.log(`📊 PathTracker[${this.peerId.substring(0, 8)}]: Path ${pathType} state: ${oldState} → ${state}${reason ? ` (${reason})` : ''}`);
    
    this.emit('pathStateChanged', {
      peerId: this.peerId,
      pathType,
      oldState,
      newState: state,
      reason
    });
    
    // If active path failed, select a new one
    if (state === PathState.FAILED && this._activePath === pathType) {
      this._activePath = null;
      this._selectBestPath();
    }
    
    // If a path became available and we have no active path, select it
    if (state === PathState.AVAILABLE && !this._activePath) {
      this._selectBestPath();
    }
  }

  /**
   * Record a latency measurement for a path
   * @param {string} pathType - Path type
   * @param {number} latencyMs - Measured latency in milliseconds
   */
  recordLatency(pathType, latencyMs) {
    const path = this._paths.get(pathType);
    if (!path) return;
    
    // Add to history
    path.latencyHistory.push({
      latency: latencyMs,
      timestamp: Date.now()
    });
    
    // Trim history if needed
    while (path.latencyHistory.length > this.options.maxLatencyHistory) {
      path.latencyHistory.shift();
    }
    
    // Calculate average latency from recent samples
    const recentSamples = path.latencyHistory.slice(-this.options.latencySamples);
    const avgLatency = recentSamples.reduce((sum, s) => sum + s.latency, 0) / recentSamples.length;
    
    // Calculate jitter (standard deviation of latency)
    if (recentSamples.length >= 2) {
      const variance = recentSamples.reduce((sum, s) => sum + Math.pow(s.latency - avgLatency, 2), 0) / recentSamples.length;
      path.jitter = Math.sqrt(variance);
    }
    
    path.latency = Math.round(avgLatency);
    path.lastMeasured = Date.now();
    path.measurementCount++;
    path.successCount++;
    
    // Update state if was probing
    if (path.state === PathState.PROBING) {
      path.state = PathState.AVAILABLE;
    }
    
    // Update packet loss estimate
    path.packetLoss = path.failureCount / (path.successCount + path.failureCount);
    
    console.log(`📊 PathTracker[${this.peerId.substring(0, 8)}]: Path ${pathType} latency: ${latencyMs}ms (avg: ${path.latency}ms, jitter: ${path.jitter?.toFixed(1) || 'N/A'}ms)`);
    
    this.emit('latencyMeasured', {
      peerId: this.peerId,
      pathType,
      latency: latencyMs,
      avgLatency: path.latency,
      jitter: path.jitter
    });
    
    // Check if we should switch paths
    this._checkPathSwitch();
  }

  /**
   * Record a measurement failure (timeout or error)
   * @param {string} pathType - Path type
   * @param {string} reason - Failure reason
   */
  recordMeasurementFailure(pathType, reason = 'timeout') {
    const path = this._paths.get(pathType);
    if (!path) return;
    
    path.measurementCount++;
    path.failureCount++;
    
    // Update packet loss estimate
    path.packetLoss = path.failureCount / (path.successCount + path.failureCount);
    
    console.log(`📊 PathTracker[${this.peerId.substring(0, 8)}]: Path ${pathType} measurement failed: ${reason} (loss: ${(path.packetLoss * 100).toFixed(1)}%)`);
    
    // If packet loss exceeds threshold, mark path as degraded
    if (path.packetLoss > this.options.packetLossThreshold) {
      if (path.state === PathState.ACTIVE || path.state === PathState.AVAILABLE) {
        this.setPathState(pathType, PathState.FAILED, `high packet loss (${(path.packetLoss * 100).toFixed(1)}%)`);
      }
    }
    
    this.emit('measurementFailed', {
      peerId: this.peerId,
      pathType,
      reason,
      packetLoss: path.packetLoss
    });
  }

  /**
   * Set the active path
   * @param {string} pathType - Path type to make active
   * @returns {boolean} True if path was activated
   */
  setActivePath(pathType) {
    const path = this._paths.get(pathType);
    if (!path) {
      console.warn(`📊 PathTracker[${this.peerId.substring(0, 8)}]: Cannot activate unknown path ${pathType}`);
      return false;
    }
    
    if (path.state === PathState.FAILED) {
      console.warn(`📊 PathTracker[${this.peerId.substring(0, 8)}]: Cannot activate failed path ${pathType}`);
      return false;
    }
    
    const oldActivePath = this._activePath;
    
    // Deactivate old path
    if (oldActivePath && oldActivePath !== pathType) {
      const oldPath = this._paths.get(oldActivePath);
      if (oldPath && oldPath.state === PathState.ACTIVE) {
        oldPath.state = PathState.AVAILABLE;
      }
    }
    
    // Activate new path
    this._activePath = pathType;
    path.state = PathState.ACTIVE;
    path.lastUsed = Date.now();
    
    if (oldActivePath !== pathType) {
      this._stats.pathSwitches++;
      
      console.log(`📊 PathTracker[${this.peerId.substring(0, 8)}]: Switched path: ${oldActivePath || 'none'} → ${pathType}`);
      
      this.emit('pathSwitched', {
        peerId: this.peerId,
        fromPath: oldActivePath,
        toPath: pathType,
        reason: 'manual'
      });
    }
    
    return true;
  }

  /**
   * Get the currently active path
   * @returns {Object|null} Active path info or null
   */
  getActivePath() {
    if (!this._activePath) return null;
    return this._paths.get(this._activePath) || null;
  }

  /**
   * Get the active path type
   * @returns {string|null} Active path type or null
   */
  getActivePathType() {
    return this._activePath;
  }

  /**
   * Get all paths sorted by quality (best first)
   * @returns {Array} Array of path info objects
   */
  getAllPaths() {
    return Array.from(this._paths.values())
      .sort((a, b) => this._comparePaths(a, b));
  }

  /**
   * Get the best available path (may not be active)
   * @returns {Object|null} Best path info or null
   */
  getBestPath() {
    const availablePaths = Array.from(this._paths.values())
      .filter(p => p.state === PathState.AVAILABLE || p.state === PathState.ACTIVE)
      .sort((a, b) => this._comparePaths(a, b));
    
    return availablePaths[0] || null;
  }

  /**
   * Get path by type
   * @param {string} pathType - Path type
   * @returns {Object|null} Path info or null
   */
  getPath(pathType) {
    return this._paths.get(pathType) || null;
  }

  /**
   * Check if a specific path type exists
   * @param {string} pathType - Path type
   * @returns {boolean}
   */
  hasPath(pathType) {
    return this._paths.has(pathType);
  }

  /**
   * Check if any path is available
   * @returns {boolean}
   */
  hasAvailablePath() {
    for (const path of this._paths.values()) {
      if (path.state === PathState.AVAILABLE || path.state === PathState.ACTIVE) {
        return true;
      }
    }
    return false;
  }

  /**
   * Start a latency measurement for a path
   * Returns a ping ID that should be echoed back in the pong
   * @param {string} pathType - Path type to measure
   * @returns {Object} Measurement info { pingId, sentAt }
   */
  startMeasurement(pathType) {
    const path = this._paths.get(pathType);
    if (!path) {
      throw new Error(`Unknown path type: ${pathType}`);
    }
    
    const pingId = `path_${pathType}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const sentAt = Date.now();
    
    // Set up timeout
    const timeout = setTimeout(() => {
      this._handleMeasurementTimeout(pingId);
    }, this.options.measurementTimeout);
    
    this._pendingMeasurements.set(pingId, {
      pathType,
      sentAt,
      timeout
    });
    
    this._stats.measurementsSent++;
    
    return { pingId, sentAt };
  }

  /**
   * Complete a latency measurement (called when pong is received)
   * @param {string} pingId - The ping ID from startMeasurement
   * @returns {number|null} Measured latency in ms, or null if ping not found
   */
  completeMeasurement(pingId) {
    const pending = this._pendingMeasurements.get(pingId);
    if (!pending) {
      return null;
    }
    
    // Clear timeout
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    this._pendingMeasurements.delete(pingId);
    
    const latency = Date.now() - pending.sentAt;
    this._stats.measurementsReceived++;
    
    // Record the latency
    this.recordLatency(pending.pathType, latency);
    
    return latency;
  }

  /**
   * Handle measurement timeout
   * @param {string} pingId - The ping ID that timed out
   * @private
   */
  _handleMeasurementTimeout(pingId) {
    const pending = this._pendingMeasurements.get(pingId);
    if (!pending) return;
    
    this._pendingMeasurements.delete(pingId);
    this._stats.measurementsTimedOut++;
    
    this.recordMeasurementFailure(pending.pathType, 'timeout');
  }

  /**
   * Compare two paths for sorting (better path first)
   * Task 4.4: Compare path quality using latency, packet loss, and jitter
   * @param {Object} a - First path
   * @param {Object} b - Second path
   * @returns {number} Comparison result
   * @private
   */
  _comparePaths(a, b) {
    // Failed paths go last
    if (a.state === PathState.FAILED && b.state !== PathState.FAILED) return 1;
    if (b.state === PathState.FAILED && a.state !== PathState.FAILED) return -1;
    
    // Stale paths go after available/active
    if (a.state === PathState.STALE && (b.state === PathState.AVAILABLE || b.state === PathState.ACTIVE)) return 1;
    if (b.state === PathState.STALE && (a.state === PathState.AVAILABLE || a.state === PathState.ACTIVE)) return -1;
    
    // Task 4.4: Compare using composite quality score (latency + packet loss + jitter)
    const scoreA = this.calculatePathQualityScore(a);
    const scoreB = this.calculatePathQualityScore(b);
    
    // If both have quality scores, compare them (higher is better, so reverse order)
    if (scoreA !== null && scoreB !== null) {
      const scoreDiff = scoreB - scoreA; // Higher score = better, so B - A
      
      // If quality difference is significant, use it
      if (Math.abs(scoreDiff) > this.options.qualitySwitchThreshold) {
        return scoreDiff > 0 ? 1 : -1;
      }
    }
    
    // If quality scores are similar or unavailable, use priority (path type preference)
    // IPv6 > WebRTC direct > WebSocket relay
    return a.priority - b.priority;
  }

  /**
   * Calculate composite quality score for a path (0-1, higher is better)
   * Task 4.4: Compare path quality using latency, packet loss, and jitter
   * 
   * The quality score combines:
   * - Latency: Lower is better (normalized to 0-1)
   * - Packet loss: Lower is better (0% = 1.0, 100% = 0.0)
   * - Jitter: Lower is better (normalized to 0-1)
   * 
   * @param {Object|string} pathOrType - Path object or path type string
   * @returns {number|null} Quality score (0-1) or null if insufficient data
   */
  calculatePathQualityScore(pathOrType) {
    const path = typeof pathOrType === 'string' 
      ? this._paths.get(pathOrType) 
      : pathOrType;
    
    if (!path) return null;
    
    // Need at least latency measurement to calculate score
    if (path.latency === null) {
      return null;
    }
    
    const weights = this.options.qualityWeights;
    
    // Latency score: 0ms = 1.0, maxLatencyForScore ms = 0.0
    const latencyScore = Math.max(0, 1 - (path.latency / this.options.maxLatencyForScore));
    
    // Packet loss score: 0% = 1.0, 100% = 0.0
    const packetLossScore = 1 - (path.packetLoss || 0);
    
    // Jitter score: 0ms = 1.0, maxJitterForScore ms = 0.0
    const jitterScore = path.jitter !== null 
      ? Math.max(0, 1 - (path.jitter / this.options.maxJitterForScore))
      : 0.8; // Default to 0.8 if jitter not yet measured
    
    // Calculate weighted composite score
    const qualityScore = (
      latencyScore * weights.latency +
      packetLossScore * weights.packetLoss +
      jitterScore * weights.jitter
    );
    
    return Math.round(qualityScore * 1000) / 1000; // Round to 3 decimal places
  }

  /**
   * Get detailed quality breakdown for a path
   * Task 4.4: Provides visibility into path quality components
   * 
   * @param {string} pathType - Path type
   * @returns {Object|null} Quality breakdown or null if path not found
   */
  getPathQualityBreakdown(pathType) {
    const path = this._paths.get(pathType);
    if (!path) return null;
    
    const weights = this.options.qualityWeights;
    
    // Calculate individual component scores
    const latencyScore = path.latency !== null 
      ? Math.max(0, 1 - (path.latency / this.options.maxLatencyForScore))
      : null;
    
    const packetLossScore = 1 - (path.packetLoss || 0);
    
    const jitterScore = path.jitter !== null 
      ? Math.max(0, 1 - (path.jitter / this.options.maxJitterForScore))
      : null;
    
    const compositeScore = this.calculatePathQualityScore(path);
    
    return {
      pathType,
      state: path.state,
      
      // Raw metrics
      latency: path.latency,
      packetLoss: path.packetLoss,
      jitter: path.jitter,
      
      // Component scores (0-1)
      scores: {
        latency: latencyScore !== null ? Math.round(latencyScore * 1000) / 1000 : null,
        packetLoss: Math.round(packetLossScore * 1000) / 1000,
        jitter: jitterScore !== null ? Math.round(jitterScore * 1000) / 1000 : null
      },
      
      // Weights used
      weights: { ...weights },
      
      // Composite quality score
      qualityScore: compositeScore,
      
      // Measurement stats
      measurementCount: path.measurementCount,
      successCount: path.successCount,
      failureCount: path.failureCount,
      lastMeasured: path.lastMeasured
    };
  }

  /**
   * Compare quality of all paths and return ranking
   * Task 4.4: Provides overview of path quality comparison
   * 
   * @returns {Array} Array of paths with quality scores, sorted best to worst
   */
  getPathQualityRanking() {
    const ranking = [];
    
    for (const [pathType, path] of this._paths) {
      const qualityScore = this.calculatePathQualityScore(path);
      
      ranking.push({
        pathType,
        state: path.state,
        isActive: pathType === this._activePath,
        qualityScore,
        latency: path.latency,
        packetLoss: path.packetLoss,
        jitter: path.jitter,
        priority: path.priority
      });
    }
    
    // Sort by quality score (descending), then by priority (ascending)
    return ranking.sort((a, b) => {
      // Failed paths go last
      if (a.state === PathState.FAILED && b.state !== PathState.FAILED) return 1;
      if (b.state === PathState.FAILED && a.state !== PathState.FAILED) return -1;
      
      // Compare by quality score if both have one
      if (a.qualityScore !== null && b.qualityScore !== null) {
        const scoreDiff = b.qualityScore - a.qualityScore;
        if (Math.abs(scoreDiff) > 0.01) return scoreDiff > 0 ? 1 : -1;
      }
      
      // Fall back to priority
      return a.priority - b.priority;
    });
  }

  /**
   * Check if we should switch to a better path
   * Task 4.4: Uses composite quality score (latency + packet loss + jitter) for comparison
   * @private
   */
  _checkPathSwitch() {
    if (!this._activePath) {
      this._selectBestPath();
      return;
    }
    
    const activePath = this._paths.get(this._activePath);
    const bestPath = this.getBestPath();
    
    if (!bestPath || bestPath.type === this._activePath) {
      return; // Already on best path
    }
    
    // Task 4.4: Compare using composite quality score (latency + packet loss + jitter)
    const activeScore = this.calculatePathQualityScore(activePath);
    const bestScore = this.calculatePathQualityScore(bestPath);
    
    if (activeScore !== null && bestScore !== null) {
      const improvement = bestScore - activeScore;
      
      if (improvement >= this.options.qualitySwitchThreshold) {
        // Calculate latency improvement for logging
        const latencyImprovement = activePath.latency && bestPath.latency 
          ? activePath.latency - bestPath.latency 
          : 0;
        
        console.log(`📊 PathTracker[${this.peerId.substring(0, 8)}]: Better path found: ${bestPath.type} (score: ${bestScore.toFixed(3)}, ${bestPath.latency}ms, ${((bestPath.packetLoss || 0) * 100).toFixed(1)}% loss) vs ${this._activePath} (score: ${activeScore.toFixed(3)}, ${activePath.latency}ms, ${((activePath.packetLoss || 0) * 100).toFixed(1)}% loss)`);
        
        this.emit('betterPathFound', {
          peerId: this.peerId,
          currentPath: this._activePath,
          betterPath: bestPath.type,
          currentLatency: activePath.latency,
          betterLatency: bestPath.latency,
          currentPacketLoss: activePath.packetLoss,
          betterPacketLoss: bestPath.packetLoss,
          currentQualityScore: activeScore,
          betterQualityScore: bestScore,
          improvement: latencyImprovement,
          qualityImprovement: improvement
        });
        
        // Auto-switch if the improvement is significant
        // The HybridConnectionManager can listen to this event and decide whether to switch
      }
    } else if (activePath && bestPath.latency !== null && activePath.latency !== null) {
      // Fallback to latency-only comparison if quality scores unavailable
      const improvement = activePath.latency - bestPath.latency;
      
      if (improvement >= this.options.switchThreshold) {
        console.log(`📊 PathTracker[${this.peerId.substring(0, 8)}]: Better path found (latency only): ${bestPath.type} (${bestPath.latency}ms) vs ${this._activePath} (${activePath.latency}ms)`);
        
        this.emit('betterPathFound', {
          peerId: this.peerId,
          currentPath: this._activePath,
          betterPath: bestPath.type,
          currentLatency: activePath.latency,
          betterLatency: bestPath.latency,
          improvement
        });
      }
    }
  }

  /**
   * Select the best available path and make it active
   * @private
   */
  _selectBestPath() {
    const bestPath = this.getBestPath();
    
    if (bestPath) {
      this.setActivePath(bestPath.type);
    } else {
      console.log(`📊 PathTracker[${this.peerId.substring(0, 8)}]: No available paths`);
      this.emit('noPathsAvailable', { peerId: this.peerId });
    }
  }

  /**
   * Start periodic measurement timer
   */
  startMeasurementTimer() {
    if (this._measurementTimer) {
      clearInterval(this._measurementTimer);
    }
    
    this._measurementTimer = setInterval(() => {
      this._markStalePaths();
      this.emit('measurementDue', { peerId: this.peerId, paths: this.getAllPaths() });
    }, this.options.measurementInterval);
  }

  /**
   * Stop periodic measurement timer
   */
  stopMeasurementTimer() {
    if (this._measurementTimer) {
      clearInterval(this._measurementTimer);
      this._measurementTimer = null;
    }
  }

  /**
   * Mark paths as stale if not measured recently
   * @private
   */
  _markStalePaths() {
    const now = Date.now();
    
    for (const path of this._paths.values()) {
      if (path.state === PathState.AVAILABLE || path.state === PathState.ACTIVE) {
        if (path.lastMeasured && (now - path.lastMeasured) > this.options.staleThreshold) {
          // Don't mark active path as stale, just note it needs measurement
          if (path.state !== PathState.ACTIVE) {
            this.setPathState(path.type, PathState.STALE, 'no recent measurement');
          }
        }
      }
    }
  }

  /**
   * Get tracker statistics
   * Task 4.4: Includes quality scores for each path
   * @returns {Object} Statistics
   */
  getStats() {
    const paths = {};
    for (const [type, path] of this._paths) {
      paths[type] = {
        state: path.state,
        latency: path.latency,
        jitter: path.jitter,
        packetLoss: path.packetLoss,
        qualityScore: this.calculatePathQualityScore(path),
        measurementCount: path.measurementCount,
        successCount: path.successCount,
        failureCount: path.failureCount
      };
    }
    
    return {
      peerId: this.peerId,
      activePath: this._activePath,
      activePathQuality: this._activePath ? this.calculatePathQualityScore(this._paths.get(this._activePath)) : null,
      pathCount: this._paths.size,
      paths,
      ...this._stats
    };
  }

  /**
   * Get a summary of path quality for logging
   * Task 4.4: Includes quality scores in summary
   * @returns {string} Summary string
   */
  getSummary() {
    const parts = [];
    
    for (const path of this.getAllPaths()) {
      const active = path.type === this._activePath ? '*' : '';
      const latency = path.latency !== null ? `${path.latency}ms` : '?';
      const loss = path.packetLoss > 0 ? `,${(path.packetLoss * 100).toFixed(0)}%loss` : '';
      const score = this.calculatePathQualityScore(path);
      const scoreStr = score !== null ? `,Q${score.toFixed(2)}` : '';
      const state = path.state.substring(0, 3);
      parts.push(`${active}${path.type}(${latency}${loss}${scoreStr},${state})`);
    }
    
    return parts.join(' | ') || 'no paths';
  }

  /**
   * Destroy the tracker and clean up resources
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    
    this.stopMeasurementTimer();
    
    // Clear pending measurement timeouts
    for (const pending of this._pendingMeasurements.values()) {
      if (pending.timeout) {
        clearTimeout(pending.timeout);
      }
    }
    this._pendingMeasurements.clear();
    
    this._paths.clear();
    this._activePath = null;
    
    this.removeAllListeners();
    
    console.log(`📊 PathTracker[${this.peerId.substring(0, 8)}]: Destroyed`);
  }
}

export default PathTracker;
