/**
 * ConnectionMetricsTracker.js
 * 
 * Tracks connection attempt outcomes for the Symmetric NAT Relay System.
 * Provides metrics on direct success, relay needed, and failure rates.
 * 
 * Requirements: Task 1.3 - Track connection attempt outcomes
 */

/**
 * Connection outcome types
 */
export const ConnectionOutcome = {
  DIRECT_SUCCESS: 'direct_success',      // WebRTC direct connection succeeded
  RELAY_NEEDED: 'relay_needed',          // Fell back to relay (WebSocket through bridge)
  FAILURE: 'failure',                    // Connection failed completely
  WEBSOCKET_SUCCESS: 'websocket_success' // WebSocket connection (Node.js ↔ any)
};

/**
 * Connection types for categorization
 */
export const ConnectionType = {
  BROWSER_TO_BROWSER: 'browser_to_browser',   // WebRTC path
  BROWSER_TO_NODEJS: 'browser_to_nodejs',     // WebSocket path
  NODEJS_TO_BROWSER: 'nodejs_to_browser',     // WebSocket path
  NODEJS_TO_NODEJS: 'nodejs_to_nodejs'        // WebSocket path
};

/**
 * Singleton tracker for connection metrics across all connection managers.
 * Provides network-wide visibility into connection success rates.
 */
export class ConnectionMetricsTracker {
  // Outcome counters by connection type
  static outcomes = {
    [ConnectionType.BROWSER_TO_BROWSER]: {
      [ConnectionOutcome.DIRECT_SUCCESS]: 0,
      [ConnectionOutcome.RELAY_NEEDED]: 0,
      [ConnectionOutcome.FAILURE]: 0
    },
    [ConnectionType.BROWSER_TO_NODEJS]: {
      [ConnectionOutcome.WEBSOCKET_SUCCESS]: 0,
      [ConnectionOutcome.FAILURE]: 0
    },
    [ConnectionType.NODEJS_TO_BROWSER]: {
      [ConnectionOutcome.WEBSOCKET_SUCCESS]: 0,
      [ConnectionOutcome.FAILURE]: 0
    },
    [ConnectionType.NODEJS_TO_NODEJS]: {
      [ConnectionOutcome.WEBSOCKET_SUCCESS]: 0,
      [ConnectionOutcome.FAILURE]: 0
    }
  };

  // Detailed attempt logs (circular buffer)
  static attemptLogs = [];
  static MAX_LOGS = 100;

  // Timing metrics
  static connectionTimes = {
    direct: [],      // Time to establish direct WebRTC connections
    relay: [],       // Time to establish relay connections
    websocket: []    // Time to establish WebSocket connections
  };
  static MAX_TIMING_SAMPLES = 50;

  // NAT type distribution for connected browsers
  static natTypeDistribution = {
    open: 0,
    easy: 0,
    hard: 0,
    unknown: 0
  };

  // ICE candidate types used for successful connections (Task 1.3)
  // Tracks which candidate types actually resulted in successful connections
  static successfulCandidateTypes = {
    local: {
      host: 0,      // Direct local IP (no NAT traversal needed)
      srflx: 0,     // Server reflexive (STUN-discovered public IP)
      prflx: 0,     // Peer reflexive (discovered during ICE)
      relay: 0      // TURN relay (not used in our system)
    },
    remote: {
      host: 0,
      srflx: 0,
      prflx: 0,
      relay: 0
    }
  };

  // IPv6 connection tracking (Task 6.2)
  // Tracks percentage of connections using IPv6 vs IPv4
  static ipv6Stats = {
    ipv6Connections: 0,      // Connections using IPv6 addresses
    ipv4Connections: 0,      // Connections using IPv4 addresses
    ipv6Available: 0,        // Peers that had IPv6 available (even if not used)
    totalConnections: 0      // Total successful connections tracked
  };

  // IPv6 vs IPv4 latency comparison tracking (Task 6.2)
  // Tracks latency measurements for IPv6 and IPv4 connections to enable comparison
  static ipv6LatencyStats = {
    // IPv6 latency samples (circular buffer)
    ipv6Latencies: [],
    // IPv4 latency samples (circular buffer)
    ipv4Latencies: [],
    // Connections where both IPv6 and IPv4 were available (for direct comparison)
    dualStackComparisons: [],
    // Maximum samples to keep
    maxSamples: 50
  };

  /**
   * Record a connection attempt outcome
   * @param {Object} params - Connection attempt details
   * @param {string} params.connectionType - Type of connection (from ConnectionType)
   * @param {string} params.outcome - Outcome of attempt (from ConnectionOutcome)
   * @param {string} params.localNodeType - Local node type ('browser' or 'nodejs')
   * @param {string} params.remoteNodeType - Remote node type ('browser' or 'nodejs')
   * @param {string} [params.peerId] - Remote peer ID (truncated for privacy)
   * @param {number} [params.duration] - Time taken in ms
   * @param {string} [params.natType] - NAT type if known
   * @param {string} [params.failureReason] - Reason for failure if applicable
   * @param {Object} [params.candidateTypes] - ICE candidate types gathered
   * @param {Object} [params.selectedCandidatePair] - The actual candidate pair used for connection
   * @param {string} [params.selectedCandidatePair.localType] - Local candidate type (host/srflx/prflx/relay)
   * @param {string} [params.selectedCandidatePair.remoteType] - Remote candidate type (host/srflx/prflx/relay)
   * @param {string} [params.selectedCandidatePair.localAddress] - Local candidate address
   * @param {string} [params.selectedCandidatePair.remoteAddress] - Remote candidate address
   * @param {string} [params.selectedCandidatePair.protocol] - Transport protocol (udp/tcp)
   * @param {boolean} [params.usedIPv6] - Whether the connection used IPv6 (Task 6.2)
   * @param {boolean} [params.ipv6Available] - Whether IPv6 was available for this peer (Task 6.2)
   */
  static recordAttempt(params) {
    const {
      connectionType,
      outcome,
      localNodeType,
      remoteNodeType,
      peerId,
      duration,
      natType,
      failureReason,
      candidateTypes,
      selectedCandidatePair,
      usedIPv6,
      ipv6Available
    } = params;

    // Update outcome counter
    if (this.outcomes[connectionType] && this.outcomes[connectionType][outcome] !== undefined) {
      this.outcomes[connectionType][outcome]++;
    }

    // Update NAT type distribution
    if (natType && this.natTypeDistribution[natType] !== undefined) {
      this.natTypeDistribution[natType]++;
    }

    // Track successful candidate types (Task 1.3)
    // Only track for successful direct WebRTC connections
    if (outcome === ConnectionOutcome.DIRECT_SUCCESS && selectedCandidatePair) {
      const { localType, remoteType } = selectedCandidatePair;
      if (localType && this.successfulCandidateTypes.local[localType] !== undefined) {
        this.successfulCandidateTypes.local[localType]++;
      }
      if (remoteType && this.successfulCandidateTypes.remote[remoteType] !== undefined) {
        this.successfulCandidateTypes.remote[remoteType]++;
      }
      console.log(`📊 ICE candidate pair used: local=${localType}, remote=${remoteType}`);
    }

    // Track IPv6 usage (Task 6.2)
    // Only track for successful connections (direct or WebSocket)
    const isSuccessfulConnection = outcome === ConnectionOutcome.DIRECT_SUCCESS || 
                                   outcome === ConnectionOutcome.WEBSOCKET_SUCCESS ||
                                   outcome === ConnectionOutcome.RELAY_NEEDED;
    if (isSuccessfulConnection) {
      this.ipv6Stats.totalConnections++;
      
      // Track if IPv6 was used for this connection
      if (usedIPv6 === true) {
        this.ipv6Stats.ipv6Connections++;
        console.log(`📊 IPv6 connection established to ${peerId ? peerId.substring(0, 8) : 'unknown'}...`);
      } else if (usedIPv6 === false) {
        this.ipv6Stats.ipv4Connections++;
      }
      // If usedIPv6 is undefined, we don't count it either way (legacy calls)
      
      // Track if IPv6 was available (even if not used)
      if (ipv6Available === true) {
        this.ipv6Stats.ipv6Available++;
      }
    }

    // Record timing if provided
    if (duration !== undefined) {
      if (outcome === ConnectionOutcome.DIRECT_SUCCESS) {
        this._addTimingSample('direct', duration);
      } else if (outcome === ConnectionOutcome.RELAY_NEEDED) {
        this._addTimingSample('relay', duration);
      } else if (outcome === ConnectionOutcome.WEBSOCKET_SUCCESS) {
        this._addTimingSample('websocket', duration);
      }
    }

    // Add to detailed log
    const logEntry = {
      timestamp: Date.now(),
      connectionType,
      outcome,
      localNodeType,
      remoteNodeType,
      peerId: peerId ? peerId.substring(0, 8) : 'unknown',
      duration,
      natType,
      failureReason,
      candidateTypes,
      selectedCandidatePair
    };

    this.attemptLogs.push(logEntry);
    if (this.attemptLogs.length > this.MAX_LOGS) {
      this.attemptLogs.shift();
    }

    // Log significant events
    if (outcome === ConnectionOutcome.FAILURE) {
      console.warn(`📊 Connection failed: ${connectionType} to ${logEntry.peerId}... - ${failureReason || 'unknown reason'}`);
    } else if (outcome === ConnectionOutcome.RELAY_NEEDED) {
      console.log(`📊 Relay fallback: ${connectionType} to ${logEntry.peerId}...`);
    }
  }

  /**
   * Add a timing sample to the circular buffer
   * @private
   */
  static _addTimingSample(type, duration) {
    this.connectionTimes[type].push(duration);
    if (this.connectionTimes[type].length > this.MAX_TIMING_SAMPLES) {
      this.connectionTimes[type].shift();
    }
  }

  /**
   * Get success rate for browser-to-browser connections
   * @returns {Object} Success rate metrics
   */
  static getBrowserToBrowserSuccessRate() {
    const b2b = this.outcomes[ConnectionType.BROWSER_TO_BROWSER];
    const total = b2b[ConnectionOutcome.DIRECT_SUCCESS] + 
                  b2b[ConnectionOutcome.RELAY_NEEDED] + 
                  b2b[ConnectionOutcome.FAILURE];

    if (total === 0) {
      return { total: 0, directRate: 0, relayRate: 0, failureRate: 0 };
    }

    return {
      total,
      directRate: ((b2b[ConnectionOutcome.DIRECT_SUCCESS] / total) * 100).toFixed(1),
      relayRate: ((b2b[ConnectionOutcome.RELAY_NEEDED] / total) * 100).toFixed(1),
      failureRate: ((b2b[ConnectionOutcome.FAILURE] / total) * 100).toFixed(1),
      directCount: b2b[ConnectionOutcome.DIRECT_SUCCESS],
      relayCount: b2b[ConnectionOutcome.RELAY_NEEDED],
      failureCount: b2b[ConnectionOutcome.FAILURE]
    };
  }

  /**
   * Get overall connection success rate (all types)
   * @returns {Object} Overall success metrics
   */
  static getOverallSuccessRate() {
    let totalAttempts = 0;
    let totalSuccesses = 0;
    let totalFailures = 0;

    for (const [type, outcomes] of Object.entries(this.outcomes)) {
      for (const [outcome, count] of Object.entries(outcomes)) {
        totalAttempts += count;
        if (outcome === ConnectionOutcome.FAILURE) {
          totalFailures += count;
        } else {
          totalSuccesses += count;
        }
      }
    }

    if (totalAttempts === 0) {
      return { total: 0, successRate: 0, failureRate: 0 };
    }

    return {
      total: totalAttempts,
      successRate: ((totalSuccesses / totalAttempts) * 100).toFixed(1),
      failureRate: ((totalFailures / totalAttempts) * 100).toFixed(1),
      successes: totalSuccesses,
      failures: totalFailures
    };
  }

  /**
   * Get average connection times
   * @returns {Object} Average times in ms
   */
  static getAverageConnectionTimes() {
    const avg = (arr) => arr.length > 0 
      ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) 
      : null;

    return {
      direct: avg(this.connectionTimes.direct),
      relay: avg(this.connectionTimes.relay),
      websocket: avg(this.connectionTimes.websocket),
      samples: {
        direct: this.connectionTimes.direct.length,
        relay: this.connectionTimes.relay.length,
        websocket: this.connectionTimes.websocket.length
      }
    };
  }

  /**
   * Get NAT type distribution
   * @returns {Object} NAT type counts and percentages
   */
  static getNatTypeDistribution() {
    const total = Object.values(this.natTypeDistribution).reduce((a, b) => a + b, 0);
    
    if (total === 0) {
      return { total: 0, distribution: this.natTypeDistribution };
    }

    const percentages = {};
    for (const [type, count] of Object.entries(this.natTypeDistribution)) {
      percentages[type] = ((count / total) * 100).toFixed(1);
    }

    return {
      total,
      counts: { ...this.natTypeDistribution },
      percentages
    };
  }

  /**
   * Get ICE candidate types used for successful connections (Task 1.3)
   * @returns {Object} Candidate type statistics
   */
  static getSuccessfulCandidateTypes() {
    const localTotal = Object.values(this.successfulCandidateTypes.local).reduce((a, b) => a + b, 0);
    const remoteTotal = Object.values(this.successfulCandidateTypes.remote).reduce((a, b) => a + b, 0);

    const calcPercentages = (counts, total) => {
      if (total === 0) return {};
      const percentages = {};
      for (const [type, count] of Object.entries(counts)) {
        percentages[type] = ((count / total) * 100).toFixed(1);
      }
      return percentages;
    };

    return {
      local: {
        total: localTotal,
        counts: { ...this.successfulCandidateTypes.local },
        percentages: calcPercentages(this.successfulCandidateTypes.local, localTotal)
      },
      remote: {
        total: remoteTotal,
        counts: { ...this.successfulCandidateTypes.remote },
        percentages: calcPercentages(this.successfulCandidateTypes.remote, remoteTotal)
      }
    };
  }

  /**
   * Get IPv6 usage statistics (Task 6.2)
   * Tracks percentage of connections using IPv6 vs IPv4
   * @returns {Object} IPv6 usage statistics
   */
  static getIPv6Stats() {
    const { ipv6Connections, ipv4Connections, ipv6Available, totalConnections } = this.ipv6Stats;
    
    // Calculate tracked connections (those with explicit IPv6/IPv4 info)
    const trackedConnections = ipv6Connections + ipv4Connections;
    
    if (totalConnections === 0) {
      return {
        totalConnections: 0,
        trackedConnections: 0,
        ipv6Connections: 0,
        ipv4Connections: 0,
        ipv6Available: 0,
        ipv6Rate: 0,
        ipv4Rate: 0,
        ipv6AvailableRate: 0
      };
    }

    return {
      totalConnections,
      trackedConnections,
      ipv6Connections,
      ipv4Connections,
      ipv6Available,
      // Percentage of tracked connections using IPv6
      ipv6Rate: trackedConnections > 0 
        ? ((ipv6Connections / trackedConnections) * 100).toFixed(1) 
        : 0,
      // Percentage of tracked connections using IPv4
      ipv4Rate: trackedConnections > 0 
        ? ((ipv4Connections / trackedConnections) * 100).toFixed(1) 
        : 0,
      // Percentage of connections where IPv6 was available
      ipv6AvailableRate: totalConnections > 0 
        ? ((ipv6Available / totalConnections) * 100).toFixed(1) 
        : 0
    };
  }

  /**
   * Get recent connection attempts
   * @param {number} count - Number of recent attempts to return
   * @returns {Array} Recent attempt logs
   */
  static getRecentAttempts(count = 10) {
    return this.attemptLogs.slice(-count);
  }

  /**
   * Get comprehensive metrics summary
   * @returns {Object} Full metrics summary
   */
  static getSummary() {
    return {
      timestamp: Date.now(),
      browserToBrowser: this.getBrowserToBrowserSuccessRate(),
      overall: this.getOverallSuccessRate(),
      averageTimes: this.getAverageConnectionTimes(),
      natDistribution: this.getNatTypeDistribution(),
      successfulCandidateTypes: this.getSuccessfulCandidateTypes(),
      ipv6Stats: this.getIPv6Stats(),
      ipv6LatencyComparison: this.getIPv6LatencyComparison(),
      outcomesByType: { ...this.outcomes },
      recentAttempts: this.getRecentAttempts(5)
    };
  }

  /**
   * Get metrics formatted for logging/display
   * @returns {string} Formatted metrics string
   */
  static getFormattedSummary() {
    const summary = this.getSummary();
    const b2b = summary.browserToBrowser;
    const overall = summary.overall;
    const times = summary.averageTimes;
    const nat = summary.natDistribution;
    const candidates = summary.successfulCandidateTypes;
    const ipv6 = summary.ipv6Stats;
    const latencyComp = summary.ipv6LatencyComparison;

    // Build latency comparison section
    let latencySection = '';
    if (latencyComp.ipv6.sampleCount > 0 || latencyComp.ipv4.sampleCount > 0) {
      latencySection = `
IPv6 vs IPv4 Latency:
  IPv6: ${latencyComp.ipv6.avgLatency !== null ? latencyComp.ipv6.avgLatency + 'ms avg' : 'N/A'} (${latencyComp.ipv6.sampleCount} samples)
  IPv4: ${latencyComp.ipv4.avgLatency !== null ? latencyComp.ipv4.avgLatency + 'ms avg' : 'N/A'} (${latencyComp.ipv4.sampleCount} samples)`;
      
      if (latencyComp.comparison) {
        const faster = latencyComp.comparison.fasterProtocol;
        const diff = Math.abs(latencyComp.comparison.difference);
        latencySection += `
  → ${faster === 'equal' ? 'Latencies equal' : `${faster} is ${diff}ms faster`}`;
      }
      
      if (latencyComp.dualStack) {
        latencySection += `
  Dual-stack: IPv6 faster ${latencyComp.dualStack.ipv6FasterRate}%, IPv4 faster ${latencyComp.dualStack.ipv4FasterRate}%`;
      }
    }

    return `
📊 Connection Metrics Summary
═══════════════════════════════════════
Browser↔Browser: ${b2b.total} attempts
  ✓ Direct: ${b2b.directRate}% (${b2b.directCount})
  ↻ Relay:  ${b2b.relayRate}% (${b2b.relayCount})
  ✗ Failed: ${b2b.failureRate}% (${b2b.failureCount})

Overall: ${overall.total} attempts
  Success: ${overall.successRate}%
  Failure: ${overall.failureRate}%

Average Connection Times:
  Direct WebRTC: ${times.direct !== null ? times.direct + 'ms' : 'N/A'}
  Relay:         ${times.relay !== null ? times.relay + 'ms' : 'N/A'}
  WebSocket:     ${times.websocket !== null ? times.websocket + 'ms' : 'N/A'}

NAT Type Distribution (${nat.total} browsers):
  Open:    ${nat.percentages?.open || 0}%
  Easy:    ${nat.percentages?.easy || 0}%
  Hard:    ${nat.percentages?.hard || 0}%
  Unknown: ${nat.percentages?.unknown || 0}%

ICE Candidate Types Used (${candidates.local.total} successful connections):
  Local:  host=${candidates.local.percentages?.host || 0}% srflx=${candidates.local.percentages?.srflx || 0}% prflx=${candidates.local.percentages?.prflx || 0}%
  Remote: host=${candidates.remote.percentages?.host || 0}% srflx=${candidates.remote.percentages?.srflx || 0}% prflx=${candidates.remote.percentages?.prflx || 0}%

IPv6 Usage (${ipv6.trackedConnections} tracked connections):
  IPv6: ${ipv6.ipv6Rate}% (${ipv6.ipv6Connections})
  IPv4: ${ipv6.ipv4Rate}% (${ipv6.ipv4Connections})
  IPv6 Available: ${ipv6.ipv6AvailableRate}% of peers${latencySection}
═══════════════════════════════════════`;
  }

  /**
   * Report a connection outcome to the bootstrap server for network-wide metrics (Task 1.3)
   * This sends the outcome to the bootstrap server's /metrics endpoint aggregation
   * 
   * @param {Object} bootstrapClient - The BootstrapClient instance
   * @param {Object} params - Connection outcome details
   * @param {boolean} params.success - Whether the connection succeeded
   * @param {string} params.connectionType - 'webrtc', 'websocket', or 'relay'
   * @param {string} [params.localNatType] - Local peer's NAT type
   * @param {string} [params.remoteNatType] - Remote peer's NAT type
   * @param {string} [params.iceCandidateType] - ICE candidate type used (for successful WebRTC)
   * @param {string} [params.failureReason] - Reason for failure (if applicable)
   */
  static reportToBootstrap(bootstrapClient, params) {
    if (!bootstrapClient || typeof bootstrapClient.reportConnectionOutcome !== 'function') {
      // Bootstrap client not available or doesn't support reporting
      return;
    }
    
    try {
      bootstrapClient.reportConnectionOutcome(params);
    } catch (error) {
      console.warn('⚠️ Failed to report connection outcome to bootstrap:', error.message);
    }
  }

  /**
   * Log NAT type distribution to console (Task 1.3)
   * Useful for debugging and monitoring NAT characteristics of connected browsers
   */
  static logNatTypeDistribution() {
    const nat = this.getNatTypeDistribution();
    
    if (nat.total === 0) {
      console.log('📊 NAT Distribution: No data collected yet');
      return;
    }
    
    console.log(`📊 NAT Distribution (${nat.total} connections): Open=${nat.counts.open} (${nat.percentages.open}%) | Easy=${nat.counts.easy} (${nat.percentages.easy}%) | Hard=${nat.counts.hard} (${nat.percentages.hard}%) | Unknown=${nat.counts.unknown} (${nat.percentages.unknown}%)`);
    
    // Log warning if high percentage of hard NAT
    const hardPct = parseFloat(nat.percentages.hard);
    if (hardPct > 30 && nat.total >= 3) {
      console.log(`⚠️ High hard NAT percentage (${hardPct}%) - relay may be needed for many connections`);
    }
  }

  /**
   * Log IPv6 usage statistics to console (Task 6.2)
   * Useful for monitoring IPv6 adoption and connectivity
   */
  static logIPv6Stats() {
    const ipv6 = this.getIPv6Stats();
    
    if (ipv6.totalConnections === 0) {
      console.log('📊 IPv6 Stats: No data collected yet');
      return;
    }
    
    if (ipv6.trackedConnections === 0) {
      console.log(`📊 IPv6 Stats: ${ipv6.totalConnections} connections, but no IPv6/IPv4 tracking data`);
      return;
    }
    
    console.log(`📊 IPv6 Stats (${ipv6.trackedConnections} tracked): IPv6=${ipv6.ipv6Connections} (${ipv6.ipv6Rate}%) | IPv4=${ipv6.ipv4Connections} (${ipv6.ipv4Rate}%) | IPv6 Available=${ipv6.ipv6Available} (${ipv6.ipv6AvailableRate}%)`);
    
    // Log info if IPv6 adoption is high
    const ipv6Pct = parseFloat(ipv6.ipv6Rate);
    if (ipv6Pct > 50 && ipv6.trackedConnections >= 3) {
      console.log(`✅ Good IPv6 adoption (${ipv6Pct}%) - NAT traversal bypassed for many connections`);
    } else if (ipv6Pct < 10 && ipv6.trackedConnections >= 5) {
      console.log(`ℹ️ Low IPv6 usage (${ipv6Pct}%) - most connections require NAT traversal`);
    }
  }

  /**
   * Record a latency measurement for IPv6 or IPv4 connection (Task 6.2)
   * This enables comparison of latency between IPv6 and IPv4 paths
   * 
   * @param {Object} params - Latency measurement details
   * @param {boolean} params.isIPv6 - Whether this is an IPv6 connection
   * @param {number} params.latency - Measured latency in milliseconds
   * @param {string} [params.peerId] - Remote peer ID (truncated for privacy)
   * @param {boolean} [params.ipv6Available] - Whether IPv6 was available (for dual-stack comparison)
   * @param {boolean} [params.ipv4Available] - Whether IPv4 was available (for dual-stack comparison)
   * @param {number} [params.alternateLatency] - Latency of the alternate path (for dual-stack comparison)
   */
  static recordLatencyMeasurement(params) {
    const {
      isIPv6,
      latency,
      peerId,
      ipv6Available,
      ipv4Available,
      alternateLatency
    } = params;

    if (latency === undefined || latency === null) {
      return;
    }

    const sample = {
      latency,
      timestamp: Date.now(),
      peerId: peerId ? peerId.substring(0, 8) : 'unknown'
    };

    // Add to appropriate latency buffer
    if (isIPv6) {
      this.ipv6LatencyStats.ipv6Latencies.push(sample);
      if (this.ipv6LatencyStats.ipv6Latencies.length > this.ipv6LatencyStats.maxSamples) {
        this.ipv6LatencyStats.ipv6Latencies.shift();
      }
    } else {
      this.ipv6LatencyStats.ipv4Latencies.push(sample);
      if (this.ipv6LatencyStats.ipv4Latencies.length > this.ipv6LatencyStats.maxSamples) {
        this.ipv6LatencyStats.ipv4Latencies.shift();
      }
    }

    // If both IPv6 and IPv4 were available, record dual-stack comparison
    if (ipv6Available && ipv4Available && alternateLatency !== undefined) {
      const comparison = {
        timestamp: Date.now(),
        peerId: peerId ? peerId.substring(0, 8) : 'unknown',
        usedIPv6: isIPv6,
        ipv6Latency: isIPv6 ? latency : alternateLatency,
        ipv4Latency: isIPv6 ? alternateLatency : latency,
        difference: isIPv6 ? (alternateLatency - latency) : (latency - alternateLatency) // Positive = IPv6 faster
      };

      this.ipv6LatencyStats.dualStackComparisons.push(comparison);
      if (this.ipv6LatencyStats.dualStackComparisons.length > this.ipv6LatencyStats.maxSamples) {
        this.ipv6LatencyStats.dualStackComparisons.shift();
      }

      // Log the comparison
      const fasterPath = comparison.difference > 0 ? 'IPv6' : 'IPv4';
      const diffMs = Math.abs(comparison.difference);
      console.log(`📊 IPv6 vs IPv4 Latency: IPv6=${comparison.ipv6Latency}ms, IPv4=${comparison.ipv4Latency}ms → ${fasterPath} is ${diffMs}ms faster (peer: ${comparison.peerId}...)`);
    }
  }

  /**
   * Get IPv6 vs IPv4 latency comparison statistics (Task 6.2)
   * @returns {Object} Latency comparison statistics
   */
  static getIPv6LatencyComparison() {
    const { ipv6Latencies, ipv4Latencies, dualStackComparisons } = this.ipv6LatencyStats;

    // Calculate average latencies
    const avgIPv6 = ipv6Latencies.length > 0
      ? Math.round(ipv6Latencies.reduce((sum, s) => sum + s.latency, 0) / ipv6Latencies.length)
      : null;

    const avgIPv4 = ipv4Latencies.length > 0
      ? Math.round(ipv4Latencies.reduce((sum, s) => sum + s.latency, 0) / ipv4Latencies.length)
      : null;

    // Calculate min/max latencies
    const minIPv6 = ipv6Latencies.length > 0
      ? Math.min(...ipv6Latencies.map(s => s.latency))
      : null;
    const maxIPv6 = ipv6Latencies.length > 0
      ? Math.max(...ipv6Latencies.map(s => s.latency))
      : null;

    const minIPv4 = ipv4Latencies.length > 0
      ? Math.min(...ipv4Latencies.map(s => s.latency))
      : null;
    const maxIPv4 = ipv4Latencies.length > 0
      ? Math.max(...ipv4Latencies.map(s => s.latency))
      : null;

    // Analyze dual-stack comparisons
    let dualStackAnalysis = null;
    if (dualStackComparisons.length > 0) {
      const ipv6FasterCount = dualStackComparisons.filter(c => c.difference > 0).length;
      const ipv4FasterCount = dualStackComparisons.filter(c => c.difference < 0).length;
      const equalCount = dualStackComparisons.filter(c => c.difference === 0).length;
      const avgDifference = Math.round(
        dualStackComparisons.reduce((sum, c) => sum + c.difference, 0) / dualStackComparisons.length
      );

      dualStackAnalysis = {
        totalComparisons: dualStackComparisons.length,
        ipv6FasterCount,
        ipv4FasterCount,
        equalCount,
        ipv6FasterRate: ((ipv6FasterCount / dualStackComparisons.length) * 100).toFixed(1),
        ipv4FasterRate: ((ipv4FasterCount / dualStackComparisons.length) * 100).toFixed(1),
        avgDifferenceMs: avgDifference, // Positive = IPv6 faster on average
        recentComparisons: dualStackComparisons.slice(-5) // Last 5 comparisons
      };
    }

    return {
      ipv6: {
        sampleCount: ipv6Latencies.length,
        avgLatency: avgIPv6,
        minLatency: minIPv6,
        maxLatency: maxIPv6
      },
      ipv4: {
        sampleCount: ipv4Latencies.length,
        avgLatency: avgIPv4,
        minLatency: minIPv4,
        maxLatency: maxIPv4
      },
      comparison: avgIPv6 !== null && avgIPv4 !== null ? {
        difference: avgIPv4 - avgIPv6, // Positive = IPv6 faster
        fasterProtocol: avgIPv6 < avgIPv4 ? 'IPv6' : (avgIPv4 < avgIPv6 ? 'IPv4' : 'equal'),
        percentageDifference: avgIPv4 > 0 
          ? (((avgIPv4 - avgIPv6) / avgIPv4) * 100).toFixed(1)
          : '0'
      } : null,
      dualStack: dualStackAnalysis
    };
  }

  /**
   * Log IPv6 vs IPv4 latency comparison to console (Task 6.2)
   * Useful for monitoring latency differences between IPv6 and IPv4 paths
   */
  static logIPv6LatencyComparison() {
    const stats = this.getIPv6LatencyComparison();

    if (stats.ipv6.sampleCount === 0 && stats.ipv4.sampleCount === 0) {
      console.log('📊 IPv6 vs IPv4 Latency: No latency data collected yet');
      return;
    }

    // Log individual protocol stats
    const ipv6Info = stats.ipv6.sampleCount > 0
      ? `IPv6: avg=${stats.ipv6.avgLatency}ms (min=${stats.ipv6.minLatency}ms, max=${stats.ipv6.maxLatency}ms, n=${stats.ipv6.sampleCount})`
      : 'IPv6: no data';

    const ipv4Info = stats.ipv4.sampleCount > 0
      ? `IPv4: avg=${stats.ipv4.avgLatency}ms (min=${stats.ipv4.minLatency}ms, max=${stats.ipv4.maxLatency}ms, n=${stats.ipv4.sampleCount})`
      : 'IPv4: no data';

    console.log(`📊 IPv6 vs IPv4 Latency Comparison:`);
    console.log(`   ${ipv6Info}`);
    console.log(`   ${ipv4Info}`);

    // Log comparison if both have data
    if (stats.comparison) {
      const faster = stats.comparison.fasterProtocol;
      const diff = Math.abs(stats.comparison.difference);
      const pct = Math.abs(parseFloat(stats.comparison.percentageDifference));
      
      if (faster === 'equal') {
        console.log(`   → Latencies are equal`);
      } else {
        console.log(`   → ${faster} is ${diff}ms (${pct}%) faster on average`);
      }
    }

    // Log dual-stack analysis if available
    if (stats.dualStack) {
      const ds = stats.dualStack;
      console.log(`   Dual-stack comparisons (${ds.totalComparisons} samples):`);
      console.log(`     IPv6 faster: ${ds.ipv6FasterRate}% (${ds.ipv6FasterCount})`);
      console.log(`     IPv4 faster: ${ds.ipv4FasterRate}% (${ds.ipv4FasterCount})`);
      if (ds.avgDifferenceMs !== 0) {
        const avgFaster = ds.avgDifferenceMs > 0 ? 'IPv6' : 'IPv4';
        console.log(`     Average: ${avgFaster} is ${Math.abs(ds.avgDifferenceMs)}ms faster`);
      }
    }

    // Log insights
    if (stats.comparison && stats.ipv6.sampleCount >= 3 && stats.ipv4.sampleCount >= 3) {
      const diff = stats.comparison.difference;
      if (diff > 20) {
        console.log(`   ✅ IPv6 provides significantly lower latency (${diff}ms improvement)`);
      } else if (diff < -20) {
        console.log(`   ⚠️ IPv4 has lower latency than IPv6 (${Math.abs(diff)}ms difference) - unusual, may indicate IPv6 routing issues`);
      } else {
        console.log(`   ℹ️ IPv6 and IPv4 latencies are similar (within 20ms)`);
      }
    }
  }

  /**
   * Reset all metrics (for testing)
   */
  static reset() {
    this.outcomes = {
      [ConnectionType.BROWSER_TO_BROWSER]: {
        [ConnectionOutcome.DIRECT_SUCCESS]: 0,
        [ConnectionOutcome.RELAY_NEEDED]: 0,
        [ConnectionOutcome.FAILURE]: 0
      },
      [ConnectionType.BROWSER_TO_NODEJS]: {
        [ConnectionOutcome.WEBSOCKET_SUCCESS]: 0,
        [ConnectionOutcome.FAILURE]: 0
      },
      [ConnectionType.NODEJS_TO_BROWSER]: {
        [ConnectionOutcome.WEBSOCKET_SUCCESS]: 0,
        [ConnectionOutcome.FAILURE]: 0
      },
      [ConnectionType.NODEJS_TO_NODEJS]: {
        [ConnectionOutcome.WEBSOCKET_SUCCESS]: 0,
        [ConnectionOutcome.FAILURE]: 0
      }
    };
    this.attemptLogs = [];
    this.connectionTimes = {
      direct: [],
      relay: [],
      websocket: []
    };
    this.natTypeDistribution = {
      open: 0,
      easy: 0,
      hard: 0,
      unknown: 0
    };
    this.successfulCandidateTypes = {
      local: {
        host: 0,
        srflx: 0,
        prflx: 0,
        relay: 0
      },
      remote: {
        host: 0,
        srflx: 0,
        prflx: 0,
        relay: 0
      }
    };
    this.ipv6Stats = {
      ipv6Connections: 0,
      ipv4Connections: 0,
      ipv6Available: 0,
      totalConnections: 0
    };
    this.ipv6LatencyStats = {
      ipv6Latencies: [],
      ipv4Latencies: [],
      dualStackComparisons: [],
      maxSamples: 50
    };
  }
}
