import { EventEmitter } from 'events';
import { WebRTCConnectionManager } from './WebRTCConnectionManager.js';
import { ConnectionMetricsTracker, ConnectionOutcome, ConnectionType } from './ConnectionMetricsTracker.js';
import { PathTracker, PathType, PathState } from './PathTracker.js';
import { Logger } from '../utils/Logger.js';

/**
 * HybridConnectionManager - Implements parallel connection strategy for browser-to-browser
 * 
 * Strategy (from Tailscale): "try everything at once, and pick the best thing that works"
 * 
 * 1. Start BOTH relay and WebRTC ICE gathering simultaneously
 * 2. Relay typically succeeds first (guaranteed path via bridge node)
 * 3. Use relay for initial messages while WebRTC continues probing
 * 4. Upgrade to WebRTC when direct path is established
 * 5. Keep relay as backup for instant failover
 * 
 * This ensures instant connectivity while still attempting the optimal direct path.
 * By starting WebRTC ICE gathering in parallel (not after relay), we reduce the
 * total time to establish a direct connection when one is possible.
 * 
 * ARCHITECTURE NOTE:
 * Each HybridConnectionManager instance manages the connection to ONE specific peer.
 * It owns its relay session state - the RelayManager is just a message router that
 * dispatches incoming relay messages to the correct HybridConnectionManager.
 * 
 * See: .kiro/specs/symmetric-nat-relay/design.md for detailed rationale
 */
export class HybridConnectionManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // Timeout for relay establishment
      relayTimeout: options.relayTimeout || 5000,
      // Timeout for WebRTC connection
      webrtcTimeout: options.webrtcTimeout || 30000,
      // Whether to attempt WebRTC at all (can be disabled for known hard NAT pairs)
      attemptWebRTC: options.attemptWebRTC !== false,
      // Minimum time to wait before upgrading from relay to WebRTC
      upgradeDelay: options.upgradeDelay || 1000,
      // Task 4.5 & 4.6: Whether to close the old path after migration is confirmed
      // Default is FALSE to keep relay as backup for instant failover (Task 4.6)
      // Set to true only if you want to free relay resources and don't need instant failover
      closeOldPathAfterMigration: options.closeOldPathAfterMigration === true,
      // Task 4.5: Grace period (ms) before closing old path after migration confirmed
      // This ensures the new path is stable before closing the backup
      oldPathCloseDelay: options.oldPathCloseDelay || 5000,
      // Task 4.6: Number of consecutive pong timeouts before considering path failed
      pathFailureThreshold: options.pathFailureThreshold || 3,
      // Task 4.6: Delay (ms) before starting path probing after failover
      pathProbingDelay: options.pathProbingDelay || 5000,
      // Task 5.1: Background path discovery intervals
      // Probe more frequently when on relay (trying to find direct path)
      // Probe less frequently when on direct (just monitoring quality)
      backgroundProbeIntervalRelay: options.backgroundProbeIntervalRelay || 30000, // 30 seconds on relay
      backgroundProbeIntervalDirect: options.backgroundProbeIntervalDirect || 300000, // 5 minutes on direct
      // Task 5.1: Whether to enable background path discovery
      enableBackgroundProbing: options.enableBackgroundProbing !== false,
      // Task 5.1: Maximum number of WebRTC re-probe attempts before giving up
      maxBackgroundProbeAttempts: options.maxBackgroundProbeAttempts || 10,
      // Task 5.1: Cooldown period after max attempts reached (ms)
      backgroundProbeCooldown: options.backgroundProbeCooldown || 600000, // 10 minutes
      // Task 5.1: NAT mapping timeout handling
      // Most NATs have a 30-second UDP mapping timeout, some aggressive NATs use 20 seconds
      // We need to send traffic before the mapping expires to keep the connection alive
      natMappingTimeout: options.natMappingTimeout || 30000, // Typical NAT mapping timeout (30s)
      natMappingRefreshMargin: options.natMappingRefreshMargin || 5000, // Refresh 5s before timeout
      // Keep-alive interval should be under NAT timeout minus margin
      // Default: 30000 - 5000 = 25000ms (25 seconds)
      keepAliveInterval: options.keepAliveInterval || 25000,
      ...options
    };
    
    // Connection state
    this.peerId = null;
    this.connectionState = 'disconnected'; // disconnected, connecting, connected, failed
    this.activeTransport = null; // 'relay' | 'webrtc' | null
    
    // Relay session state (owned by this instance, not shared)
    this.relaySession = null; // { sessionId, relayNodeId, state, ... }
    this.relayConnected = false;
    
    // Reference to shared RelayManager for relay node selection and message sending
    // The RelayManager routes incoming messages TO us, we use it to SEND messages
    this.relayManager = options.relayManager || null;
    
    // WebRTC connection (created on demand)
    this.webrtcManager = null;
    this.webrtcConnected = false;
    this.webrtcAttempted = false;
    
    // Bridge node for relay (must be set before connecting)
    this.bridgeNodeId = options.bridgeNodeId || null;
    
    // Message queue for messages sent before connection is ready
    this.messageQueue = [];
    
    // Metrics
    this.connectionStartTime = null;
    this.relayEstablishedTime = null;
    this.webrtcEstablishedTime = null;
    
    // Cleanup tracking
    this.isDestroyed = false;
    
    // Compatibility with ConnectionManager interface
    this.connection = null; // Will be set when connected
    this.localMetadataStore = new Map(); // For metadata storage
    
    // Task 4.1: Path tracker for multiple candidate paths with measured latency
    this.pathTracker = null; // Created when peerId is known
    
    // Task 5.1: Background path discovery state
    this._backgroundProbeTimer = null;
    this._backgroundProbeAttempts = 0;
    this._backgroundProbeCooldownUntil = null;
    this._lastBackgroundProbeTime = null;
    this._backgroundProbingEnabled = this.options.enableBackgroundProbing;
    
    // Task 5.1: NAT state change detection state
    this._lastConnectionProfile = null;
    this._natStateCheckCounter = 0;
    
    // Task 5.1: NAT mapping timeout handling state
    // Track when we last sent traffic on each path to detect potential NAT mapping expiration
    this._lastWebRTCTrafficTime = null;
    this._lastRelayTrafficTime = null;
    this._natMappingCheckTimer = null;
    
    // Task 5.3: Keep-alive timer state for sending periodic packets on active path
    // This keeps NAT mappings alive by sending traffic before they expire
    this._keepAliveTimer = null;
    this._keepAliveEnabled = options.enableKeepAlive !== false; // Enabled by default
    this._lastKeepAliveSentTime = null;
    this._keepAliveFailureCount = 0;
    this._maxKeepAliveFailures = options.maxKeepAliveFailures || 3;
    
    // Task: Detect path failure if keep-alive times out
    // Track pending keep-alive pings waiting for pong response
    // If pong is not received within timeout, count as failure
    this._pendingKeepAlivePings = new Map(); // pingId -> { sentAt, timeoutId, transport }
    this._keepAlivePongTimeout = options.keepAlivePongTimeout || 10000; // 10 second timeout for pong
    
    // Task 5.3: Warm backup paths - keep backup paths ready for instant failover
    // This sends periodic keep-alive packets on backup paths (not just active path)
    // to maintain NAT mappings and track health/latency of backup paths
    this._warmBackupPathsEnabled = options.enableWarmBackupPaths !== false; // Enabled by default
    this._warmBackupPathsTimer = null;
    // Warm backup paths less frequently than active path to reduce overhead
    // Default: 25 seconds for active, 45 seconds for backup (still under 60s NAT timeout)
    this._warmBackupPathsInterval = options.warmBackupPathsInterval || 45000;
    // Track pending backup path pings
    this._pendingBackupPathPings = new Map(); // pingId -> { sentAt, timeoutId, pathType }
    // Track backup path health metrics
    this._backupPathHealth = new Map(); // pathType -> { lastPingTime, lastPongTime, consecutiveFailures, latency }
    
    // Task 5.4: Path time tracking - track time spent on each path type per connection
    // This tracks how long the connection has been using each path type (relay, webrtc-direct, ipv6-direct)
    // Used for aggregate statistics: % direct, % relay
    this._pathTimeStats = {
      // Time tracking per path type
      [PathType.WEBSOCKET_RELAY]: { totalTime: 0, startTime: null, switchCount: 0 },
      [PathType.WEBRTC_DIRECT]: { totalTime: 0, startTime: null, switchCount: 0 },
      [PathType.IPV6_DIRECT]: { totalTime: 0, startTime: null, switchCount: 0 }
    };
    // Track when connection was established for calculating percentages
    this._connectionEstablishedTime = null;
    // Track the current active path for time tracking
    this._currentPathForTimeTracking = null;
    
    // Task 5.4: Path event history - log all path upgrade/downgrade events with timestamps
    // This provides a queryable history of all path changes for debugging and analysis
    // Each event includes: timestamp, eventType, fromPath, toPath, reason, duration, metadata
    this._pathEventHistory = [];
    // Maximum number of events to keep in history (prevents unbounded memory growth)
    this._maxPathEventHistory = options.maxPathEventHistory || 100;
    
    // Register with RelayManager for incoming message routing
    this._registerWithRelayManager();
  }
  
  /**
   * Register this manager with the RelayManager for incoming message routing
   * The RelayManager will call handleRelayMessage() when messages arrive for our peer
   * @private
   */
  _registerWithRelayManager() {
    if (this.relayManager && this.peerId) {
      this.relayManager.registerPeerManager(this.peerId, this);
    }
  }
  
  /**
   * Initialize PathTracker for tracking multiple candidate paths
   * Task 4.1: Track multiple candidate paths with measured latency
   * @param {string} peerId - The peer ID
   * @private
   */
  _initializePathTracker(peerId) {
    if (this.pathTracker) {
      this.pathTracker.destroy();
    }
    
    this.pathTracker = new PathTracker(peerId, {
      measurementInterval: 30000, // 30 seconds
      switchThreshold: 50 // Only switch if 50ms+ improvement
    });
    
    // Listen for path events
    this.pathTracker.on('pathSwitched', ({ fromPath, toPath, reason }) => {
      // Task 4.5: Log path switch for debugging
      Logger.path(`🔄 PATH_SWITCHED peer=${peerId?.substring(0, 8)} from=${fromPath} to=${toPath} reason=${reason}`);
      console.log(`🔄 HybridConnectionManager: Path switched ${fromPath} → ${toPath} (${reason})`);
      this.emit('pathSwitched', { peerId, fromPath, toPath, reason });
    });
    
    this.pathTracker.on('betterPathFound', ({ currentPath, betterPath, improvement }) => {
      // Task 4.5: Log better path discovery for debugging
      Logger.path(`📊 BETTER_PATH_FOUND peer=${peerId?.substring(0, 8)} current=${currentPath} better=${betterPath} improvement=${improvement}ms`);
      console.log(`📊 HybridConnectionManager: Better path available: ${betterPath} (${improvement}ms faster)`);
      this.emit('betterPathFound', { peerId, currentPath, betterPath, improvement });
      
      // Task 4.4: Auto-upgrade to better path based on path preference
      // Path preference: IPv6 > WebRTC direct > WebSocket relay
      if (currentPath === PathType.WEBSOCKET_RELAY) {
        // Upgrade from relay to either IPv6 or WebRTC direct
        if (betterPath === PathType.IPV6_DIRECT || betterPath === PathType.WEBRTC_DIRECT) {
          this._upgradeToWebRTC();
        }
      } else if (currentPath === PathType.WEBRTC_DIRECT && betterPath === PathType.IPV6_DIRECT) {
        // Upgrade from WebRTC direct to IPv6 (if IPv6 becomes available later)
        // This is rare but possible if IPv6 connectivity is established after initial connection
        Logger.path(`🌐 IPV6_UPGRADE peer=${peerId?.substring(0, 8)} from=webrtc to=ipv6`);
        console.log(`🌐 HybridConnectionManager: Upgrading from WebRTC to IPv6 for ${peerId.substring(0, 8)}...`);
        if (this.pathTracker) {
          this.pathTracker.setActivePath(PathType.IPV6_DIRECT);
        }
        this.emit('transportUpgraded', {
          peerId,
          from: 'webrtc',
          to: 'ipv6',
          isIPv6: true
        });
      }
    });
    
    this.pathTracker.on('noPathsAvailable', () => {
      Logger.path(`⚠️ NO_PATHS_AVAILABLE peer=${peerId?.substring(0, 8)}`);
      console.warn(`⚠️ HybridConnectionManager: No paths available to ${peerId.substring(0, 8)}...`);
    });
    
    // Start measurement timer for continuous path quality monitoring
    this.pathTracker.startMeasurementTimer();
    
    this.pathTracker.on('measurementDue', () => {
      this._measurePathLatencies();
    });
  }
  
  /**
   * Unregister from RelayManager
   * @private
   */
  _unregisterFromRelayManager() {
    if (this.relayManager && this.peerId) {
      this.relayManager.unregisterPeerManager(this.peerId);
    }
  }
  
  /**
   * Measure latencies for all tracked paths
   * Task 4.1 & 4.4: Track multiple candidate paths with measured latency
   * Task 4.4: Add RTT measurement to relay path (ping/pong through relay)
   * @private
   */
  async _measurePathLatencies() {
    if (!this.pathTracker || this.isDestroyed) return;
    
    // Task 4.4: Measure relay path latency via ping/pong through relay
    if (this.relayConnected && this.relaySession && this.relayManager) {
      try {
        const { pingId, sentAt } = this.pathTracker.startMeasurement(PathType.WEBSOCKET_RELAY);
        
        // Store pingId for when pong arrives (before sending to avoid race condition)
        this._pendingPathPings = this._pendingPathPings || new Map();
        this._pendingPathPings.set(pingId, { 
          pathType: PathType.WEBSOCKET_RELAY, 
          sentAt,
          sessionId: this.relaySession.sessionId
        });
        
        // Send ping through relay to the target peer
        // The ping travels: us → relay node → target peer → relay node → us
        // This measures the full round-trip through the relay path
        console.log(`📊 HybridConnectionManager: Sending relay RTT ping ${pingId.substring(0, 12)}... to ${this.peerId?.substring(0, 8)}...`);
        
        this.relayManager.emit('sendRelayPing', {
          toPeerId: this.relaySession.relayNodeId,
          message: {
            type: 'relay_ping',
            sessionId: this.relaySession.sessionId,
            pingId,
            timestamp: sentAt,
            // Include target peer so relay knows where to forward
            targetPeerId: this.peerId
          }
        });
        
        // Set up timeout for this measurement
        const timeoutId = setTimeout(() => {
          this._handleRelayPingTimeout(pingId);
        }, 10000); // 10 second timeout
        
        // Store timeout ID for cleanup
        const pending = this._pendingPathPings.get(pingId);
        if (pending) {
          pending.timeoutId = timeoutId;
        }
      } catch (error) {
        console.warn(`⚠️ Failed to measure relay path latency: ${error.message}`);
      }
    }
    
    // Task 4.4: Measure WebRTC path latency via data channel ping
    // Use the correct path type based on whether it's IPv6 or IPv4
    if (this.webrtcConnected && this.webrtcManager) {
      try {
        // Task 4.4: Use IPv6 path type if connection is IPv6, otherwise WebRTC direct
        const pathType = this._webrtcIsIPv6 ? PathType.IPV6_DIRECT : PathType.WEBRTC_DIRECT;
        const { pingId, sentAt } = this.pathTracker.startMeasurement(pathType);
        
        // Store pingId for when pong arrives (before sending to avoid race condition)
        this._pendingPathPings = this._pendingPathPings || new Map();
        this._pendingPathPings.set(pingId, { 
          pathType, 
          sentAt 
        });
        
        // Send ping through WebRTC data channel
        const pathName = this._webrtcIsIPv6 ? 'IPv6' : 'WebRTC';
        console.log(`📊 HybridConnectionManager: Sending ${pathName} RTT ping ${pingId.substring(0, 12)}... to ${this.peerId?.substring(0, 8)}...`);
        
        await this.webrtcManager.sendRawMessage(this.peerId, {
          type: 'path_ping',
          pingId,
          timestamp: sentAt
        });
        
        // Set up timeout for this measurement
        const timeoutId = setTimeout(() => {
          this._handleWebRTCPingTimeout(pingId);
        }, 10000); // 10 second timeout
        
        // Store timeout ID for cleanup
        const pending = this._pendingPathPings.get(pingId);
        if (pending) {
          pending.timeoutId = timeoutId;
        }
      } catch (error) {
        console.warn(`⚠️ Failed to measure WebRTC path latency: ${error.message}`);
      }
    }
  }
  
  /**
   * Handle relay ping timeout
   * Task 4.4: RTT measurement timeout handling for relay path
   * Task 4.6: Detect when current path fails (no pong response)
   * @param {string} pingId - The ping ID that timed out
   * @private
   */
  _handleRelayPingTimeout(pingId) {
    if (!this._pendingPathPings) return;
    
    const pending = this._pendingPathPings.get(pingId);
    if (!pending || pending.pathType !== PathType.WEBSOCKET_RELAY) return;
    
    this._pendingPathPings.delete(pingId);
    
    console.warn(`⚠️ HybridConnectionManager: Relay RTT ping ${pingId.substring(0, 12)}... timed out`);
    
    // Record measurement failure in PathTracker
    if (this.pathTracker) {
      this.pathTracker.recordMeasurementFailure(PathType.WEBSOCKET_RELAY, 'timeout');
    }
    
    // Task 4.6: Track consecutive failures for path failure detection
    this._trackConsecutiveFailure(PathType.WEBSOCKET_RELAY);
    
    this.emit('relayRttTimeout', { 
      peerId: this.peerId, 
      pingId,
      sessionId: pending.sessionId 
    });
  }
  
  /**
   * Handle WebRTC ping timeout
   * Task 4.4: RTT measurement timeout handling for WebRTC/IPv6 path
   * Task 4.6: Detect when current path fails (no pong response)
   * @param {string} pingId - The ping ID that timed out
   * @private
   */
  _handleWebRTCPingTimeout(pingId) {
    if (!this._pendingPathPings) return;
    
    const pending = this._pendingPathPings.get(pingId);
    // Task 4.4: Handle both IPv6 and WebRTC direct path types
    if (!pending || (pending.pathType !== PathType.WEBRTC_DIRECT && pending.pathType !== PathType.IPV6_DIRECT)) return;
    
    this._pendingPathPings.delete(pingId);
    
    const pathName = pending.pathType === PathType.IPV6_DIRECT ? 'IPv6' : 'WebRTC';
    console.warn(`⚠️ HybridConnectionManager: ${pathName} RTT ping ${pingId.substring(0, 12)}... timed out`);
    
    // Record measurement failure in PathTracker
    if (this.pathTracker) {
      this.pathTracker.recordMeasurementFailure(pending.pathType, 'timeout');
    }
    
    // Task 4.6: Track consecutive failures for path failure detection
    this._trackConsecutiveFailure(pending.pathType);
    
    this.emit('webrtcRttTimeout', { 
      peerId: this.peerId, 
      pingId,
      pathType: pending.pathType,
      isIPv6: pending.pathType === PathType.IPV6_DIRECT
    });
  }
  
  /**
   * Track consecutive pong failures for a path and detect path failure
   * Task 4.6: Detect when current path fails (no pong response)
   * 
   * When consecutive pong timeouts exceed the threshold, the path is considered
   * failed and we trigger failover to the backup path.
   * 
   * @param {string} pathType - The path type that had a failure
   * @private
   */
  _trackConsecutiveFailure(pathType) {
    // Initialize failure tracking if needed
    if (!this._consecutiveFailures) {
      this._consecutiveFailures = new Map();
    }
    
    // Get or initialize failure count for this path
    const currentCount = (this._consecutiveFailures.get(pathType) || 0) + 1;
    this._consecutiveFailures.set(pathType, currentCount);
    
    // Threshold for considering a path failed (3 consecutive timeouts)
    const failureThreshold = this.options.pathFailureThreshold || 3;
    
    // Task 4.5: Log consecutive failure tracking for debugging
    Logger.path(`📊 CONSECUTIVE_FAILURE peer=${this.peerId?.substring(0, 8)} pathType=${pathType} count=${currentCount}/${failureThreshold}`);
    console.log(`📊 HybridConnectionManager: Path ${pathType} consecutive failures: ${currentCount}/${failureThreshold}`);
    
    // Check if this is the active path and if we've exceeded the threshold
    const activePath = this.pathTracker?.getActivePathType();
    
    if (pathType === activePath && currentCount >= failureThreshold) {
      // Task 4.5: Log threshold exceeded for debugging
      Logger.path(`❌ PATH_THRESHOLD_EXCEEDED peer=${this.peerId?.substring(0, 8)} pathType=${pathType} failures=${currentCount} threshold=${failureThreshold} isActivePath=true`);
      console.warn(`❌ HybridConnectionManager: Active path ${pathType} failed (${currentCount} consecutive pong timeouts)`);
      
      // Emit path failure event
      this.emit('activePathFailed', {
        peerId: this.peerId,
        pathType,
        consecutiveFailures: currentCount,
        reason: 'no_pong_response'
      });
      
      // Task 4.6: Trigger failover based on path type
      this._handleActivePathFailure(pathType);
    }
  }
  
  /**
   * Reset consecutive failure count for a path (called when pong is received)
   * Task 4.6: Reset failure tracking on successful pong
   * @param {string} pathType - The path type to reset
   * @private
   */
  _resetConsecutiveFailures(pathType) {
    if (this._consecutiveFailures) {
      this._consecutiveFailures.set(pathType, 0);
    }
  }
  
  /**
   * Handle active path failure - trigger failover to backup path
   * Task 4.6: Immediately fall back to relay (always available)
   * 
   * When the active path fails due to no pong response:
   * - If WebRTC/IPv6 fails → fall back to relay (immediate, relay is always available)
   * - If relay fails → try to re-establish relay or switch to WebRTC if available
   * 
   * The relay is kept as a backup by default (closeOldPathAfterMigration: false)
   * to ensure instant failover is always possible.
   * 
   * @param {string} failedPathType - The path type that failed
   * @private
   */
  _handleActivePathFailure(failedPathType) {
    // Task 4.5: Log path failure detection for debugging
    Logger.path(`⚠️ PATH_FAILURE_DETECTED peer=${this.peerId?.substring(0, 8)} failedPath=${failedPathType} relayConnected=${this.relayConnected} webrtcConnected=${this.webrtcConnected}`);
    
    // Mark the path as failed in PathTracker
    if (this.pathTracker) {
      this.pathTracker.setPathState(failedPathType, PathState.FAILED, 'no_pong_response');
    }
    
    // Task 4.6: Emit path failure event for monitoring
    this.emit('pathFailed', {
      peerId: this.peerId,
      pathType: failedPathType,
      reason: 'no_pong_response',
      timestamp: Date.now()
    });
    
    // Determine failover action based on which path failed
    if (failedPathType === PathType.WEBRTC_DIRECT || failedPathType === PathType.IPV6_DIRECT) {
      // WebRTC/IPv6 failed - fall back to relay (always available)
      if (this.relayConnected && this.relaySession) {
        // Task 4.5: Log failover decision for debugging
        Logger.path(`🔄 FAILOVER_TO_RELAY peer=${this.peerId?.substring(0, 8)} from=${failedPathType} reason=webrtc_failed relaySessionId=${this.relaySession?.sessionId?.substring(0, 8)}`);
        console.log(`🔄 HybridConnectionManager: Failing over from ${failedPathType} to relay (instant failover)`);
        this._downgradeToRelay();
        
        // Task 4.6: Emit failover event
        this.emit('pathFailover', {
          peerId: this.peerId,
          fromPath: failedPathType,
          toPath: PathType.WEBSOCKET_RELAY,
          reason: 'webrtc_failed',
          timestamp: Date.now()
        });
        
        // Task 4.6: Emit pathChanged event for unified monitoring
        this.emit('pathChanged', {
          peerId: this.peerId,
          changeType: 'failover',
          fromPath: failedPathType,
          toPath: PathType.WEBSOCKET_RELAY,
          fromTransport: failedPathType === PathType.IPV6_DIRECT ? 'ipv6' : 'webrtc',
          toTransport: 'relay',
          reason: 'webrtc_failed',
          timestamp: Date.now()
        });
        
        // Task 4.6: Restart path probing to find new direct path
        this._schedulePathProbing();
      } else {
        // No relay available (shouldn't happen with default settings) - try to re-establish
        Logger.path(`⚠️ NO_RELAY_AVAILABLE peer=${this.peerId?.substring(0, 8)} failedPath=${failedPathType} attempting=relay_reestablishment`);
        console.warn(`⚠️ HybridConnectionManager: ${failedPathType} failed and no relay available - attempting re-establishment`);
        this._attemptRelayReestablishment();
      }
    } else if (failedPathType === PathType.WEBSOCKET_RELAY) {
      // Relay failed - check if WebRTC is available as backup
      if (this.webrtcConnected && this.webrtcManager) {
        const toPathType = this._webrtcIsIPv6 ? PathType.IPV6_DIRECT : PathType.WEBRTC_DIRECT;
        // Task 4.5: Log failover to WebRTC for debugging
        Logger.path(`🔄 FAILOVER_TO_WEBRTC peer=${this.peerId?.substring(0, 8)} from=relay to=${toPathType} reason=relay_failed isIPv6=${this._webrtcIsIPv6}`);
        console.log(`🔄 HybridConnectionManager: Relay failed, switching to WebRTC`);
        this._upgradeToWebRTC();
        
        // Task 4.6: Emit failover event
        this.emit('pathFailover', {
          peerId: this.peerId,
          fromPath: PathType.WEBSOCKET_RELAY,
          toPath: toPathType,
          reason: 'relay_failed',
          timestamp: Date.now()
        });
        
        // Task 4.6: Emit pathChanged event for unified monitoring
        this.emit('pathChanged', {
          peerId: this.peerId,
          changeType: 'failover',
          fromPath: PathType.WEBSOCKET_RELAY,
          toPath: toPathType,
          fromTransport: 'relay',
          toTransport: this._webrtcIsIPv6 ? 'ipv6' : 'webrtc',
          reason: 'relay_failed',
          timestamp: Date.now()
        });
      } else {
        // No backup path available - try to re-establish relay
        Logger.path(`⚠️ NO_WEBRTC_AVAILABLE peer=${this.peerId?.substring(0, 8)} failedPath=relay attempting=relay_reestablishment`);
        console.warn(`⚠️ HybridConnectionManager: Relay failed and no WebRTC available - attempting re-establishment`);
        this._attemptRelayReestablishment();
      }
    }
  }
  
  /**
   * Schedule path probing to find a new direct path after failover
   * Task 4.6: Restart path probing to find new direct path
   * 
   * This method schedules a path probing attempt after a delay. It's called:
   * 1. After failing over from WebRTC to relay (to try to find a new direct path)
   * 2. After a failed WebRTC reconnection attempt (with exponential backoff)
   * 
   * The probing will attempt to re-establish a direct WebRTC connection by:
   * - Restarting ICE gathering to get fresh NAT mappings
   * - Using coordinated ICE restart for hard NAT pairs
   * - Emitting events for external monitoring
   * 
   * @param {number} [customDelay] - Optional custom delay in ms (for exponential backoff)
   * @private
   */
  _schedulePathProbing(customDelay = null) {
    // Don't schedule if already probing or destroyed
    if (this._pathProbingScheduled || this.isDestroyed) return;
    
    // Don't schedule if we're already connected via WebRTC
    if (this.webrtcConnected && this.activeTransport === 'webrtc') {
      Logger.path(`🔍 PROBING_SKIPPED peer=${this.peerId?.substring(0, 8)} reason=already_webrtc_connected`);
      console.log(`🔍 HybridConnectionManager: Skipping path probing - already connected via WebRTC`);
      return;
    }
    
    this._pathProbingScheduled = true;
    
    // Use custom delay if provided (for exponential backoff), otherwise use default
    const probingDelay = customDelay !== null ? customDelay : (this.options.pathProbingDelay || 5000);
    
    // Task 4.5: Log path probing schedule for debugging
    Logger.path(`🔍 PROBING_SCHEDULED peer=${this.peerId?.substring(0, 8)} delay=${probingDelay}ms attempt=${this._webrtcReconnectAttempts || 0} activeTransport=${this.activeTransport}`);
    console.log(`🔍 HybridConnectionManager: Scheduling path probing in ${probingDelay}ms for ${this.peerId?.substring(0, 8)}...`);
    
    // Emit event for monitoring
    this.emit('pathProbingScheduled', {
      peerId: this.peerId,
      delay: probingDelay,
      attempt: this._webrtcReconnectAttempts || 0,
      timestamp: Date.now()
    });
    
    this._pathProbingTimer = setTimeout(() => {
      this._pathProbingScheduled = false;
      
      if (this.isDestroyed) return;
      
      // Double-check we're not already connected via WebRTC
      if (this.webrtcConnected && this.activeTransport === 'webrtc') {
        Logger.path(`🔍 PROBING_CANCELLED peer=${this.peerId?.substring(0, 8)} reason=webrtc_connected_during_delay`);
        console.log(`🔍 HybridConnectionManager: Path probing cancelled - WebRTC connected during delay`);
        return;
      }
      
      // Task 4.5: Log path probing start for debugging
      Logger.path(`🔍 PROBING_START peer=${this.peerId?.substring(0, 8)} reason=failover_recovery attempt=${this._webrtcReconnectAttempts || 0}`);
      console.log(`🔍 HybridConnectionManager: Starting path probing for ${this.peerId?.substring(0, 8)}...`);
      
      // Emit event to trigger WebRTC re-probing
      this.emit('pathProbingRequested', {
        peerId: this.peerId,
        reason: 'failover_recovery',
        attempt: this._webrtcReconnectAttempts || 0,
        timestamp: Date.now()
      });
      
      // Attempt WebRTC reconnection
      // This will handle both cases:
      // 1. WebRTC manager exists but isn't connected - attempt ICE restart
      // 2. No WebRTC manager - log and stay on relay
      this._attemptWebRTCReconnection();
    }, probingDelay);
  }
  
  /**
   * Cancel any scheduled path probing
   * Task 4.6: Clean up path probing state
   * @private
   */
  _cancelPathProbing() {
    if (this._pathProbingTimer) {
      clearTimeout(this._pathProbingTimer);
      this._pathProbingTimer = null;
    }
    this._pathProbingScheduled = false;
  }
  
  /**
   * Start background path discovery
   * Task 5.1: After initial connection, continue probing for better paths
   * 
   * This method starts a timer that periodically attempts to discover better paths.
   * The probe interval is adaptive:
   * - 30 seconds when on relay (actively trying to find direct path)
   * - 5 minutes when on direct (just monitoring quality)
   * 
   * Background probing will:
   * 1. Re-run ICE gathering to detect NAT state changes
   * 2. Attempt to establish WebRTC when currently on relay
   * 3. Measure path quality for all available paths
   * 
   * @private
   */
  _startBackgroundProbing() {
    if (!this._backgroundProbingEnabled || this.isDestroyed) {
      return;
    }
    
    // Don't start if already running
    if (this._backgroundProbeTimer) {
      return;
    }
    
    // Check if we're in cooldown period
    if (this._backgroundProbeCooldownUntil && Date.now() < this._backgroundProbeCooldownUntil) {
      const remainingCooldown = this._backgroundProbeCooldownUntil - Date.now();
      Logger.path(`⏳ BACKGROUND_PROBE_COOLDOWN peer=${this.peerId?.substring(0, 8)} remaining=${Math.round(remainingCooldown / 1000)}s`);
      console.log(`⏳ HybridConnectionManager: Background probing in cooldown for ${Math.round(remainingCooldown / 1000)}s`);
      
      // Schedule to start after cooldown
      this._backgroundProbeTimer = setTimeout(() => {
        this._backgroundProbeTimer = null;
        this._backgroundProbeCooldownUntil = null;
        this._backgroundProbeAttempts = 0;
        this._startBackgroundProbing();
      }, remainingCooldown);
      return;
    }
    
    // Determine probe interval based on current transport
    const interval = this._getBackgroundProbeInterval();
    
    Logger.path(`🔍 BACKGROUND_PROBE_START peer=${this.peerId?.substring(0, 8)} interval=${interval}ms activeTransport=${this.activeTransport} attempts=${this._backgroundProbeAttempts}`);
    console.log(`🔍 HybridConnectionManager: Starting background probing for ${this.peerId?.substring(0, 8)}... (interval: ${interval / 1000}s)`);
    
    this.emit('backgroundProbingStarted', {
      peerId: this.peerId,
      interval,
      activeTransport: this.activeTransport,
      attempts: this._backgroundProbeAttempts,
      timestamp: Date.now()
    });
    
    this._backgroundProbeTimer = setInterval(() => {
      this._performBackgroundProbe();
    }, interval);
    
    // Also perform an immediate probe
    this._performBackgroundProbe();
  }
  
  /**
   * Stop background path discovery
   * Task 5.1: Clean up background probing resources
   * @private
   */
  _stopBackgroundProbing() {
    if (this._backgroundProbeTimer) {
      clearInterval(this._backgroundProbeTimer);
      this._backgroundProbeTimer = null;
    }
    
    Logger.path(`🔍 BACKGROUND_PROBE_STOP peer=${this.peerId?.substring(0, 8)} attempts=${this._backgroundProbeAttempts}`);
    console.log(`🔍 HybridConnectionManager: Stopped background probing for ${this.peerId?.substring(0, 8)}...`);
    
    this.emit('backgroundProbingStopped', {
      peerId: this.peerId,
      attempts: this._backgroundProbeAttempts,
      timestamp: Date.now()
    });
  }
  
  /**
   * Restart background probing with updated interval
   * Task 5.1: Called when transport changes to adjust probe frequency
   * @private
   */
  _restartBackgroundProbing() {
    if (!this._backgroundProbingEnabled) return;
    
    this._stopBackgroundProbing();
    this._startBackgroundProbing();
  }
  
  /**
   * Get the appropriate background probe interval based on current transport
   * Task 5.1: Adaptive probe intervals
   * @returns {number} Probe interval in milliseconds
   * @private
   */
  _getBackgroundProbeInterval() {
    // Probe more frequently when on relay (trying to find direct path)
    if (this.activeTransport === 'relay') {
      return this.options.backgroundProbeIntervalRelay;
    }
    // Probe less frequently when on direct (just monitoring quality)
    return this.options.backgroundProbeIntervalDirect;
  }
  
  /**
   * Perform a background probe attempt
   * Task 5.1: Re-run ICE gathering periodically to detect NAT state changes
   * 
   * This method:
   * 1. Measures latency on all available paths
   * 2. If on relay and WebRTC not connected, attempts to establish WebRTC
   * 3. Handles NAT mapping timeout by refreshing ICE candidates
   * 4. Periodically re-gathers ICE candidates to detect NAT state changes
   * 
   * @private
   */
  async _performBackgroundProbe() {
    if (this.isDestroyed || !this._backgroundProbingEnabled) {
      return;
    }
    
    this._lastBackgroundProbeTime = Date.now();
    
    Logger.path(`🔍 BACKGROUND_PROBE peer=${this.peerId?.substring(0, 8)} activeTransport=${this.activeTransport} webrtcConnected=${this.webrtcConnected} relayConnected=${this.relayConnected} attempt=${this._backgroundProbeAttempts}`);
    console.log(`🔍 HybridConnectionManager: Background probe for ${this.peerId?.substring(0, 8)}... (transport: ${this.activeTransport})`);
    
    this.emit('backgroundProbe', {
      peerId: this.peerId,
      activeTransport: this.activeTransport,
      webrtcConnected: this.webrtcConnected,
      relayConnected: this.relayConnected,
      attempt: this._backgroundProbeAttempts,
      timestamp: Date.now()
    });
    
    // Task 5.1: Measure latency on all available paths
    await this._measurePathLatencies();
    
    // Task 5.1: Handle NAT mapping timeout - check if we need to refresh mappings
    await this._checkNatMappingTimeout();
    
    // Task 5.1: If on relay and WebRTC not connected, try to establish WebRTC
    if (this.activeTransport === 'relay' && !this.webrtcConnected && this.options.attemptWebRTC) {
      await this._attemptBackgroundWebRTCProbe();
    }
    
    // Task 5.1: If WebRTC is connected but we're on relay, check if we should upgrade
    if (this.activeTransport === 'relay' && this.webrtcConnected) {
      Logger.path(`⬆️ BACKGROUND_UPGRADE_CHECK peer=${this.peerId?.substring(0, 8)} webrtcConnected=true activeTransport=relay`);
      console.log(`⬆️ HybridConnectionManager: WebRTC available but on relay, triggering upgrade check`);
      this._upgradeToWebRTC();
    }
    
    // Task 5.1: Periodically re-gather ICE candidates to detect NAT state changes
    // This helps detect:
    // - Network switches (WiFi to cellular, etc.)
    // - IP address changes
    // - NAT mapping refreshes
    // - IPv6 availability changes
    await this._checkForNatStateChanges();
  }
  
  /**
   * Check and handle NAT mapping timeout
   * Task 5.1: Handle NAT mapping timeout (typically 30 seconds for UDP)
   * 
   * NAT mappings for UDP typically expire after 30 seconds of inactivity.
   * This method checks if we're approaching the timeout threshold and
   * proactively sends traffic to keep the mapping alive.
   * 
   * For WebRTC connections, the keep-alive ping serves this purpose.
   * For relay connections, we may need to send a relay ping.
   * 
   * @private
   */
  async _checkNatMappingTimeout() {
    const now = Date.now();
    const { natMappingTimeout, natMappingRefreshMargin } = this.options;
    const refreshThreshold = natMappingTimeout - natMappingRefreshMargin;
    
    // Check WebRTC path NAT mapping
    if (this.webrtcConnected && this._lastWebRTCTrafficTime) {
      const timeSinceWebRTCTraffic = now - this._lastWebRTCTrafficTime;
      
      if (timeSinceWebRTCTraffic >= refreshThreshold) {
        Logger.path(`⏰ NAT_MAPPING_REFRESH_NEEDED peer=${this.peerId?.substring(0, 8)} path=webrtc timeSinceTraffic=${timeSinceWebRTCTraffic}ms threshold=${refreshThreshold}ms`);
        console.log(`⏰ HybridConnectionManager: WebRTC NAT mapping approaching timeout, sending keep-alive`);
        
        // Trigger a keep-alive ping to refresh the NAT mapping
        if (this.webrtcManager && typeof this.webrtcManager.sendKeepAlivePing === 'function') {
          try {
            await this.webrtcManager.sendKeepAlivePing();
            this._lastWebRTCTrafficTime = now;
            
            this.emit('natMappingRefreshed', {
              peerId: this.peerId,
              path: 'webrtc',
              timeSinceLastTraffic: timeSinceWebRTCTraffic,
              timestamp: now
            });
          } catch (error) {
            Logger.path(`⚠️ NAT_MAPPING_REFRESH_FAILED peer=${this.peerId?.substring(0, 8)} path=webrtc error=${error.message}`);
            console.warn(`⚠️ HybridConnectionManager: Failed to refresh WebRTC NAT mapping: ${error.message}`);
          }
        }
      }
    }
    
    // Check relay path - relay uses WebSocket which doesn't have NAT mapping issues
    // (WebSocket is TCP-based and maintains persistent connection)
    // However, we still track traffic time for monitoring purposes
    if (this.relayConnected && this._lastRelayTrafficTime) {
      const timeSinceRelayTraffic = now - this._lastRelayTrafficTime;
      
      // Relay doesn't need NAT refresh (TCP), but log if it's been quiet
      if (timeSinceRelayTraffic >= refreshThreshold) {
        Logger.path(`📊 RELAY_QUIET peer=${this.peerId?.substring(0, 8)} timeSinceTraffic=${timeSinceRelayTraffic}ms`);
        // No action needed - WebSocket maintains its own connection
      }
    }
  }
  
  /**
   * Update the last traffic time for a path
   * Called when traffic is sent or received on a path
   * Task 5.1: Track traffic for NAT mapping timeout handling
   * 
   * @param {string} pathType - 'webrtc' or 'relay'
   * @private
   */
  _updateTrafficTime(pathType) {
    const now = Date.now();
    if (pathType === 'webrtc') {
      this._lastWebRTCTrafficTime = now;
    } else if (pathType === 'relay') {
      this._lastRelayTrafficTime = now;
    }
  }
  
  // ===========================================
  // KEEP-ALIVE SYSTEM (Task 5.3)
  // ===========================================
  
  /**
   * Start the keep-alive timer for sending periodic packets on the active path
   * Task 5.3: Send periodic packets on active path to keep NAT mappings alive
   * 
   * NAT mappings for UDP typically expire after 30 seconds of inactivity.
   * By sending keep-alive packets every 25 seconds (configurable via keepAliveInterval),
   * we ensure the NAT mapping stays active and the connection remains viable.
   * 
   * The keep-alive system:
   * 1. Sends a ping on the active path (WebRTC or relay)
   * 2. Tracks failures and triggers path failover if too many consecutive failures
   * 3. Updates traffic timestamps to prevent NAT mapping expiration
   * 
   * @private
   */
  _startKeepAlive() {
    if (!this._keepAliveEnabled || this.isDestroyed) {
      return;
    }
    
    // Don't start if already running
    if (this._keepAliveTimer) {
      return;
    }
    
    // Don't start if not connected
    if (this.connectionState !== 'connected') {
      return;
    }
    
    const interval = this.options.keepAliveInterval;
    
    Logger.path(`💓 KEEPALIVE_START peer=${this.peerId?.substring(0, 8)} interval=${interval}ms activeTransport=${this.activeTransport}`);
    console.log(`💓 HybridConnectionManager: Starting keep-alive timer (${interval}ms interval) for ${this.peerId?.substring(0, 8)}...`);
    
    // Initialize state
    this._keepAliveFailureCount = 0;
    this._lastKeepAliveSentTime = Date.now();
    
    // Set up keep-alive interval
    this._keepAliveTimer = setInterval(() => {
      this._sendKeepAlivePing();
    }, interval);
    
    this.emit('keepAliveStarted', {
      peerId: this.peerId,
      interval,
      activeTransport: this.activeTransport,
      timestamp: Date.now()
    });
  }
  
  /**
   * Stop the keep-alive timer
   * Task 5.3: Clean up keep-alive resources
   * Task: Detect path failure if keep-alive times out - clear pending pings
   * @private
   */
  _stopKeepAlive() {
    if (this._keepAliveTimer) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = null;
      
      Logger.path(`💓 KEEPALIVE_STOP peer=${this.peerId?.substring(0, 8)}`);
      console.log(`💓 HybridConnectionManager: Stopped keep-alive timer for ${this.peerId?.substring(0, 8)}...`);
      
      this.emit('keepAliveStopped', {
        peerId: this.peerId,
        timestamp: Date.now()
      });
    }
    
    // Clear all pending keep-alive pings and their timeouts
    this._clearAllPendingKeepAlivePings();
    
    // Reset state
    this._keepAliveFailureCount = 0;
    this._lastKeepAliveSentTime = null;
  }
  
  /**
   * Restart the keep-alive timer (e.g., after transport change)
   * Task 5.3: Restart keep-alive when active transport changes
   * @private
   */
  _restartKeepAlive() {
    this._stopKeepAlive();
    this._startKeepAlive();
  }
  
  /**
   * Send a keep-alive ping on the active path
   * Task 5.3: Send periodic packets on active path to keep NAT mappings alive
   * Task: Detect path failure if keep-alive times out
   * 
   * This method sends a lightweight ping message on the currently active transport
   * (WebRTC or relay). The ping serves two purposes:
   * 1. Keep NAT mappings alive by generating traffic
   * 2. Detect path failures early (before application messages fail)
   * 
   * For WebRTC: Uses the WebRTCConnectionManager's keep-alive mechanism
   * For Relay: Sends a relay_keepalive message through the relay session
   * 
   * Each ping is tracked with a timeout. If the pong is not received within
   * the timeout period (default 10 seconds), it counts as a failure.
   * 
   * @private
   */
  async _sendKeepAlivePing() {
    if (this.isDestroyed || this.connectionState !== 'connected') {
      this._stopKeepAlive();
      return;
    }
    
    const now = Date.now();
    this._lastKeepAliveSentTime = now;
    
    // Generate unique ping ID for tracking
    const pingId = `ka_${now}_${Math.random().toString(36).substr(2, 6)}`;
    
    try {
      if (this.activeTransport === 'webrtc' && this.webrtcConnected && this.webrtcManager) {
        // For WebRTC, send a keepalive_ping message with tracking
        const pingMessage = {
          type: 'keepalive_ping',
          pingId,
          timestamp: now
        };
        
        await this.webrtcManager.sendRawMessage(this.peerId, pingMessage);
        this._updateTrafficTime('webrtc');
        
        // Track this ping and set timeout for pong response
        this._trackPendingKeepAlivePing(pingId, 'webrtc');
        
        Logger.path(`💓 KEEPALIVE_SENT peer=${this.peerId?.substring(0, 8)} transport=webrtc pingId=${pingId.substring(0, 12)}`);
      } else if (this.activeTransport === 'relay' && this.relayConnected && this.relaySession && this.relayManager) {
        // For relay, send a keepalive message through the relay session
        const keepaliveMessage = {
          type: 'relay_keepalive',
          pingId,
          sessionId: this.relaySession.sessionId,
          timestamp: now
        };
        
        await this.relayManager.sendThroughRelay(this.relaySession.sessionId, keepaliveMessage);
        this._updateTrafficTime('relay');
        
        // Track this ping and set timeout for pong response
        this._trackPendingKeepAlivePing(pingId, 'relay');
        
        Logger.path(`💓 KEEPALIVE_SENT peer=${this.peerId?.substring(0, 8)} transport=relay pingId=${pingId.substring(0, 12)} sessionId=${this.relaySession.sessionId?.substring(0, 8)}`);
      } else {
        // No active transport available
        Logger.path(`⚠️ KEEPALIVE_NO_TRANSPORT peer=${this.peerId?.substring(0, 8)} activeTransport=${this.activeTransport} webrtcConnected=${this.webrtcConnected} relayConnected=${this.relayConnected}`);
        console.warn(`⚠️ HybridConnectionManager: No transport available for keep-alive`);
        this._handleKeepAliveFailure('no_transport');
      }
    } catch (error) {
      Logger.path(`⚠️ KEEPALIVE_SEND_FAILED peer=${this.peerId?.substring(0, 8)} transport=${this.activeTransport} error=${error.message}`);
      console.warn(`⚠️ HybridConnectionManager: Keep-alive ping send failed: ${error.message}`);
      this._handleKeepAliveFailure(`send_failed: ${error.message}`);
    }
  }
  
  /**
   * Track a pending keep-alive ping and set timeout for pong response
   * Task: Detect path failure if keep-alive times out
   * 
   * @param {string} pingId - The unique ping ID
   * @param {string} transport - The transport used ('webrtc' or 'relay')
   * @private
   */
  _trackPendingKeepAlivePing(pingId, transport) {
    // Set timeout for this ping
    const timeoutId = setTimeout(() => {
      this._handleKeepAlivePongTimeout(pingId);
    }, this._keepAlivePongTimeout);
    
    // Store pending ping info
    this._pendingKeepAlivePings.set(pingId, {
      sentAt: Date.now(),
      timeoutId,
      transport
    });
    
    Logger.path(`💓 KEEPALIVE_TRACKING peer=${this.peerId?.substring(0, 8)} pingId=${pingId.substring(0, 12)} timeout=${this._keepAlivePongTimeout}ms`);
  }
  
  /**
   * Handle keep-alive pong timeout - pong was not received in time
   * Task: Detect path failure if keep-alive times out
   * 
   * When a pong is not received within the timeout period, this indicates
   * the path may be failing. We track consecutive timeouts and trigger
   * path failover after reaching the threshold.
   * 
   * @param {string} pingId - The ping ID that timed out
   * @private
   */
  _handleKeepAlivePongTimeout(pingId) {
    const pending = this._pendingKeepAlivePings.get(pingId);
    if (!pending) {
      // Already handled (pong received or cleaned up)
      return;
    }
    
    // Remove from pending
    this._pendingKeepAlivePings.delete(pingId);
    
    const elapsed = Date.now() - pending.sentAt;
    
    Logger.path(`⚠️ KEEPALIVE_PONG_TIMEOUT peer=${this.peerId?.substring(0, 8)} pingId=${pingId.substring(0, 12)} transport=${pending.transport} elapsed=${elapsed}ms timeout=${this._keepAlivePongTimeout}ms`);
    console.warn(`⚠️ HybridConnectionManager: Keep-alive pong timeout for ${this.peerId?.substring(0, 8)}... (${elapsed}ms elapsed, ${pending.transport})`);
    
    // Emit timeout event for monitoring
    this.emit('keepAlivePongTimeout', {
      peerId: this.peerId,
      pingId,
      transport: pending.transport,
      elapsed,
      timeout: this._keepAlivePongTimeout,
      timestamp: Date.now()
    });
    
    // Count this as a failure
    this._handleKeepAliveFailure(`pong_timeout: ${elapsed}ms`);
  }
  
  /**
   * Clear a pending keep-alive ping (called when pong is received)
   * Task: Detect path failure if keep-alive times out
   * 
   * @param {string} pingId - The ping ID to clear
   * @returns {Object|null} The pending ping info if found, null otherwise
   * @private
   */
  _clearPendingKeepAlivePing(pingId) {
    const pending = this._pendingKeepAlivePings.get(pingId);
    if (!pending) {
      return null;
    }
    
    // Clear the timeout
    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
    }
    
    // Remove from pending
    this._pendingKeepAlivePings.delete(pingId);
    
    return pending;
  }
  
  /**
   * Clear all pending keep-alive pings (called on cleanup)
   * Task: Detect path failure if keep-alive times out
   * @private
   */
  _clearAllPendingKeepAlivePings() {
    for (const [pingId, pending] of this._pendingKeepAlivePings) {
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
    }
    this._pendingKeepAlivePings.clear();
  }
  
  /**
   * Handle keep-alive failure
   * Task 5.3: Track failures and trigger path failover if needed
   * 
   * @param {string} reason - Reason for failure
   * @private
   */
  _handleKeepAliveFailure(reason) {
    this._keepAliveFailureCount++;
    
    Logger.path(`⚠️ KEEPALIVE_FAILURE peer=${this.peerId?.substring(0, 8)} count=${this._keepAliveFailureCount}/${this._maxKeepAliveFailures} reason=${reason}`);
    
    this.emit('keepAliveFailure', {
      peerId: this.peerId,
      failureCount: this._keepAliveFailureCount,
      maxFailures: this._maxKeepAliveFailures,
      reason,
      activeTransport: this.activeTransport,
      timestamp: Date.now()
    });
    
    // If too many consecutive failures, consider the path failed
    if (this._keepAliveFailureCount >= this._maxKeepAliveFailures) {
      Logger.path(`❌ KEEPALIVE_PATH_FAILED peer=${this.peerId?.substring(0, 8)} transport=${this.activeTransport} failures=${this._keepAliveFailureCount}`);
      console.error(`❌ HybridConnectionManager: Keep-alive failed ${this._keepAliveFailureCount} times, path may be dead`);
      
      // Emit path failure event (similar to pong timeout handling)
      const pathType = this.activeTransport === 'webrtc' 
        ? (this._webrtcIsIPv6 ? PathType.IPV6_DIRECT : PathType.WEBRTC_DIRECT)
        : PathType.WEBSOCKET_RELAY;
      
      this.emit('activePathFailed', {
        peerId: this.peerId,
        pathType,
        consecutiveFailures: this._keepAliveFailureCount,
        reason: 'keepalive_failed'
      });
      
      // Trigger failover
      this._handleActivePathFailure(pathType);
      
      // Reset failure count after triggering failover
      this._keepAliveFailureCount = 0;
    }
  }
  
  /**
   * Handle incoming keep-alive ping (respond with pong)
   * Task 5.3: Respond to keep-alive pings from peer
   * 
   * @param {Object} message - The keep-alive ping message
   * @private
   */
  _handleKeepAlivePing(message) {
    const { pingId, timestamp, type } = message;
    
    // Respond with pong
    const pongMessage = {
      type: type === 'relay_keepalive' ? 'relay_keepalive_pong' : 'keepalive_pong',
      pingId,
      timestamp, // Echo back original timestamp
      respondedAt: Date.now()
    };
    
    // Send pong back through the same transport
    if (this.activeTransport === 'webrtc' && this.webrtcManager) {
      this.webrtcManager.sendRawMessage(this.peerId, pongMessage).catch(err => {
        console.warn(`⚠️ Failed to send keep-alive pong via WebRTC: ${err.message}`);
      });
    } else if (this.activeTransport === 'relay' && this.relaySession && this.relayManager) {
      this.relayManager.sendThroughRelay(this.relaySession.sessionId, pongMessage).catch(err => {
        console.warn(`⚠️ Failed to send keep-alive pong via relay: ${err.message}`);
      });
    }
  }
  
  /**
   * Handle incoming keep-alive pong (confirms path is alive)
   * Task 5.3: Process keep-alive pong response
   * Task: Detect path failure if keep-alive times out
   * 
   * When a pong is received, we:
   * 1. Clear the pending ping timeout (prevents false timeout)
   * 2. Reset the failure count (path is confirmed alive)
   * 3. Calculate and emit RTT for monitoring
   * 
   * @param {Object} message - The keep-alive pong message
   * @private
   */
  _handleKeepAlivePong(message) {
    const { pingId, timestamp, respondedAt } = message;
    
    // Clear the pending ping timeout
    const pending = this._clearPendingKeepAlivePing(pingId);
    
    if (pending) {
      // Pong received for a tracked ping - reset failure count
      this._keepAliveFailureCount = 0;
      
      // Calculate RTT
      const rtt = Date.now() - pending.sentAt;
      
      Logger.path(`💓 KEEPALIVE_PONG peer=${this.peerId?.substring(0, 8)} pingId=${pingId?.substring(0, 12)} rtt=${rtt}ms transport=${pending.transport}`);
      
      this.emit('keepAlivePong', {
        peerId: this.peerId,
        pingId,
        rtt,
        transport: pending.transport,
        activeTransport: this.activeTransport,
        timestamp: Date.now()
      });
    } else {
      // Pong received but no pending ping found (might be duplicate or late)
      // Still reset failure count as it indicates the path is alive
      this._keepAliveFailureCount = 0;
      
      // Calculate RTT if timestamps are available
      if (timestamp && respondedAt) {
        const rtt = Date.now() - timestamp;
        Logger.path(`💓 KEEPALIVE_PONG peer=${this.peerId?.substring(0, 8)} rtt=${rtt}ms (untracked)`);
        
        this.emit('keepAlivePong', {
          peerId: this.peerId,
          pingId,
          rtt,
          activeTransport: this.activeTransport,
          timestamp: Date.now()
        });
      }
    }
  }
  
  /**
   * Get keep-alive status
   * Task 5.3: Returns current keep-alive state for monitoring
   * Task: Detect path failure if keep-alive times out - include pending ping info
   * 
   * @returns {Object} Keep-alive status
   */
  getKeepAliveStatus() {
    return {
      enabled: this._keepAliveEnabled,
      running: this._keepAliveTimer !== null,
      interval: this.options.keepAliveInterval,
      pongTimeout: this._keepAlivePongTimeout,
      lastSentTime: this._lastKeepAliveSentTime,
      timeSinceLastSent: this._lastKeepAliveSentTime 
        ? Date.now() - this._lastKeepAliveSentTime 
        : null,
      failureCount: this._keepAliveFailureCount,
      maxFailures: this._maxKeepAliveFailures,
      pendingPings: this._pendingKeepAlivePings.size,
      activeTransport: this.activeTransport
    };
  }
  
  // ===========================================
  // WARM BACKUP PATHS SYSTEM (Task 5.3)
  // ===========================================
  
  /**
   * Start the warm backup paths timer
   * Task 5.3: Maintain "warm" backup paths ready for instant failover
   * 
   * This keeps backup paths (paths that are not currently active) warm by:
   * 1. Periodically sending keep-alive packets on backup paths
   * 2. Maintaining NAT mappings on backup paths so they're ready to use instantly
   * 3. Tracking the health/latency of backup paths
   * 
   * The warm backup paths interval is longer than the active path keep-alive
   * (45s vs 25s by default) to reduce overhead while still keeping paths viable.
   * 
   * @private
   */
  _startWarmBackupPaths() {
    if (!this._warmBackupPathsEnabled || this.isDestroyed) {
      return;
    }
    
    // Don't start if already running
    if (this._warmBackupPathsTimer) {
      return;
    }
    
    // Don't start if not connected
    if (this.connectionState !== 'connected') {
      return;
    }
    
    const interval = this._warmBackupPathsInterval;
    
    Logger.path(`🔥 WARM_BACKUP_START peer=${this.peerId?.substring(0, 8)} interval=${interval}ms activeTransport=${this.activeTransport}`);
    console.log(`🔥 HybridConnectionManager: Starting warm backup paths timer (${interval}ms interval) for ${this.peerId?.substring(0, 8)}...`);
    
    // Set up warm backup paths interval
    this._warmBackupPathsTimer = setInterval(() => {
      this._sendBackupPathKeepAlives();
    }, interval);
    
    // Also send an initial ping to warm up backup paths
    setTimeout(() => {
      this._sendBackupPathKeepAlives();
    }, 5000); // Wait 5 seconds after connection before first backup path ping
    
    this.emit('warmBackupPathsStarted', {
      peerId: this.peerId,
      interval,
      activeTransport: this.activeTransport,
      timestamp: Date.now()
    });
  }
  
  /**
   * Stop the warm backup paths timer
   * Task 5.3: Clean up warm backup paths resources
   * @private
   */
  _stopWarmBackupPaths() {
    if (this._warmBackupPathsTimer) {
      clearInterval(this._warmBackupPathsTimer);
      this._warmBackupPathsTimer = null;
      
      Logger.path(`🔥 WARM_BACKUP_STOP peer=${this.peerId?.substring(0, 8)}`);
      console.log(`🔥 HybridConnectionManager: Stopped warm backup paths timer for ${this.peerId?.substring(0, 8)}...`);
      
      this.emit('warmBackupPathsStopped', {
        peerId: this.peerId,
        timestamp: Date.now()
      });
    }
    
    // Clear all pending backup path pings and their timeouts
    this._clearAllPendingBackupPathPings();
  }
  
  /**
   * Restart the warm backup paths timer (e.g., after transport change)
   * Task 5.3: Restart warm backup paths when active transport changes
   * @private
   */
  _restartWarmBackupPaths() {
    this._stopWarmBackupPaths();
    this._startWarmBackupPaths();
  }
  
  /**
   * Send keep-alive pings on all backup paths (paths that are not currently active)
   * Task 5.3: Maintain "warm" backup paths ready for instant failover
   * 
   * This method identifies all available backup paths and sends a keep-alive
   * ping on each one. This serves two purposes:
   * 1. Keeps NAT mappings alive on backup paths
   * 2. Measures latency/health of backup paths for failover decisions
   * 
   * @private
   */
  async _sendBackupPathKeepAlives() {
    if (this.isDestroyed || this.connectionState !== 'connected') {
      return;
    }
    
    const now = Date.now();
    const backupPaths = this._getBackupPaths();
    
    if (backupPaths.length === 0) {
      Logger.path(`🔥 WARM_BACKUP_NO_PATHS peer=${this.peerId?.substring(0, 8)} activeTransport=${this.activeTransport}`);
      return;
    }
    
    Logger.path(`🔥 WARM_BACKUP_PING peer=${this.peerId?.substring(0, 8)} backupPaths=${backupPaths.join(',')} activeTransport=${this.activeTransport}`);
    console.log(`🔥 HybridConnectionManager: Sending keep-alive on ${backupPaths.length} backup path(s) for ${this.peerId?.substring(0, 8)}...`);
    
    for (const pathType of backupPaths) {
      try {
        await this._sendBackupPathPing(pathType, now);
      } catch (error) {
        Logger.path(`⚠️ WARM_BACKUP_PING_ERROR peer=${this.peerId?.substring(0, 8)} pathType=${pathType} error=${error.message}`);
        console.warn(`⚠️ HybridConnectionManager: Failed to send backup path ping on ${pathType}: ${error.message}`);
        this._recordBackupPathFailure(pathType, 'send_error');
      }
    }
    
    this.emit('backupPathsPinged', {
      peerId: this.peerId,
      paths: backupPaths,
      activeTransport: this.activeTransport,
      timestamp: now
    });
  }
  
  /**
   * Get list of backup paths (paths that are not currently active but are available)
   * Task 5.3: Identify backup paths for warming
   * 
   * @returns {Array<string>} Array of backup path types
   * @private
   */
  _getBackupPaths() {
    const backupPaths = [];
    
    // Check relay as backup (if not active)
    if (this.activeTransport !== 'relay' && this.relayConnected && this.relaySession) {
      backupPaths.push(PathType.WEBSOCKET_RELAY);
    }
    
    // Check WebRTC as backup (if not active)
    if (this.activeTransport !== 'webrtc' && this.webrtcConnected && this.webrtcManager) {
      // Use the correct path type based on IPv6 status
      const webrtcPathType = this._webrtcIsIPv6 ? PathType.IPV6_DIRECT : PathType.WEBRTC_DIRECT;
      backupPaths.push(webrtcPathType);
    }
    
    return backupPaths;
  }
  
  /**
   * Send a keep-alive ping on a specific backup path
   * Task 5.3: Send periodic packets on backup paths to keep NAT mappings alive
   * 
   * @param {string} pathType - The path type to ping
   * @param {number} timestamp - The timestamp for the ping
   * @private
   */
  async _sendBackupPathPing(pathType, timestamp) {
    const pingId = `backup_${pathType}_${timestamp}_${Math.random().toString(36).substr(2, 6)}`;
    
    // Initialize health tracking for this path if needed
    if (!this._backupPathHealth.has(pathType)) {
      this._backupPathHealth.set(pathType, {
        lastPingTime: null,
        lastPongTime: null,
        consecutiveFailures: 0,
        latency: null,
        latencyHistory: []
      });
    }
    
    const health = this._backupPathHealth.get(pathType);
    health.lastPingTime = timestamp;
    
    // Set up timeout for this ping
    const timeoutId = setTimeout(() => {
      this._handleBackupPathPingTimeout(pingId);
    }, this._keepAlivePongTimeout);
    
    // Store pending ping info
    this._pendingBackupPathPings.set(pingId, {
      sentAt: timestamp,
      timeoutId,
      pathType
    });
    
    // Send ping on the appropriate transport
    if (pathType === PathType.WEBSOCKET_RELAY) {
      await this._sendBackupRelayPing(pingId, timestamp);
    } else if (pathType === PathType.WEBRTC_DIRECT || pathType === PathType.IPV6_DIRECT) {
      await this._sendBackupWebRTCPing(pingId, timestamp);
    }
    
    Logger.path(`🔥 WARM_BACKUP_PING_SENT peer=${this.peerId?.substring(0, 8)} pathType=${pathType} pingId=${pingId.substring(0, 12)}`);
  }
  
  /**
   * Send a backup path ping through the relay
   * Task 5.3: Keep relay path warm when WebRTC is active
   * 
   * @param {string} pingId - The ping ID
   * @param {number} timestamp - The timestamp
   * @private
   */
  async _sendBackupRelayPing(pingId, timestamp) {
    if (!this.relaySession || !this.relayManager) {
      throw new Error('No relay session available');
    }
    
    const pingMessage = {
      type: 'backup_path_ping',
      pingId,
      timestamp,
      pathType: PathType.WEBSOCKET_RELAY
    };
    
    await this.relayManager.sendThroughRelay(this.relaySession.sessionId, pingMessage);
    
    // Update traffic time to track NAT mapping freshness
    this._updateTrafficTime('relay');
  }
  
  /**
   * Send a backup path ping through WebRTC
   * Task 5.3: Keep WebRTC path warm when relay is active
   * 
   * @param {string} pingId - The ping ID
   * @param {number} timestamp - The timestamp
   * @private
   */
  async _sendBackupWebRTCPing(pingId, timestamp) {
    if (!this.webrtcManager || !this.webrtcConnected) {
      throw new Error('No WebRTC connection available');
    }
    
    const pathType = this._webrtcIsIPv6 ? PathType.IPV6_DIRECT : PathType.WEBRTC_DIRECT;
    
    const pingMessage = {
      type: 'backup_path_ping',
      pingId,
      timestamp,
      pathType
    };
    
    await this.webrtcManager.sendRawMessage(this.peerId, pingMessage);
    
    // Update traffic time to track NAT mapping freshness
    this._updateTrafficTime('webrtc');
  }
  
  /**
   * Handle backup path ping timeout
   * Task 5.3: Track backup path health when pong is not received
   * 
   * @param {string} pingId - The ping ID that timed out
   * @private
   */
  _handleBackupPathPingTimeout(pingId) {
    const pending = this._pendingBackupPathPings.get(pingId);
    if (!pending) {
      return; // Already handled
    }
    
    this._pendingBackupPathPings.delete(pingId);
    
    const elapsed = Date.now() - pending.sentAt;
    
    Logger.path(`⚠️ WARM_BACKUP_PONG_TIMEOUT peer=${this.peerId?.substring(0, 8)} pathType=${pending.pathType} pingId=${pingId.substring(0, 12)} elapsed=${elapsed}ms`);
    console.warn(`⚠️ HybridConnectionManager: Backup path pong timeout for ${pending.pathType} (${elapsed}ms elapsed)`);
    
    // Record failure
    this._recordBackupPathFailure(pending.pathType, 'pong_timeout');
    
    // Emit timeout event for monitoring
    this.emit('backupPathPongTimeout', {
      peerId: this.peerId,
      pathType: pending.pathType,
      pingId,
      elapsed,
      timeout: this._keepAlivePongTimeout,
      timestamp: Date.now()
    });
  }
  
  /**
   * Handle incoming backup path ping (respond with pong)
   * Task 5.3: Respond to backup path pings from peer
   * 
   * @param {Object} message - The backup path ping message
   * @private
   */
  _handleBackupPathPing(message) {
    const { pingId, timestamp, pathType } = message;
    
    Logger.path(`🔥 WARM_BACKUP_PING_RECEIVED peer=${this.peerId?.substring(0, 8)} pathType=${pathType} pingId=${pingId?.substring(0, 12)}`);
    
    // Respond with pong through the same transport
    const pongMessage = {
      type: 'backup_path_pong',
      pingId,
      timestamp, // Echo back original timestamp
      respondedAt: Date.now(),
      pathType
    };
    
    // Send pong back through the appropriate transport
    if (pathType === PathType.WEBSOCKET_RELAY && this.relaySession && this.relayManager) {
      this.relayManager.sendThroughRelay(this.relaySession.sessionId, pongMessage).catch(err => {
        console.warn(`⚠️ Failed to send backup path pong via relay: ${err.message}`);
      });
    } else if ((pathType === PathType.WEBRTC_DIRECT || pathType === PathType.IPV6_DIRECT) && this.webrtcManager) {
      this.webrtcManager.sendRawMessage(this.peerId, pongMessage).catch(err => {
        console.warn(`⚠️ Failed to send backup path pong via WebRTC: ${err.message}`);
      });
    }
  }
  
  /**
   * Handle incoming backup path pong (confirms backup path is alive)
   * Task 5.3: Process backup path pong response and update health metrics
   * 
   * @param {Object} message - The backup path pong message
   * @private
   */
  _handleBackupPathPong(message) {
    const { pingId, timestamp, respondedAt, pathType } = message;
    
    const pending = this._pendingBackupPathPings.get(pingId);
    if (!pending) {
      // Pong received but no pending ping found (might be duplicate or late)
      Logger.path(`🔥 WARM_BACKUP_PONG_UNTRACKED peer=${this.peerId?.substring(0, 8)} pathType=${pathType} pingId=${pingId?.substring(0, 12)}`);
      return;
    }
    
    // Clear the timeout
    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
    }
    this._pendingBackupPathPings.delete(pingId);
    
    // Calculate RTT
    const rtt = Date.now() - pending.sentAt;
    
    // Update health metrics
    this._recordBackupPathSuccess(pending.pathType, rtt);
    
    Logger.path(`🔥 WARM_BACKUP_PONG peer=${this.peerId?.substring(0, 8)} pathType=${pending.pathType} pingId=${pingId?.substring(0, 12)} rtt=${rtt}ms`);
    console.log(`🔥 HybridConnectionManager: Backup path ${pending.pathType} is warm (RTT: ${rtt}ms)`);
    
    // Update PathTracker with the measured latency
    if (this.pathTracker && this.pathTracker.hasPath(pending.pathType)) {
      this.pathTracker.recordLatency(pending.pathType, rtt);
    }
    
    this.emit('backupPathPong', {
      peerId: this.peerId,
      pathType: pending.pathType,
      pingId,
      rtt,
      timestamp: Date.now()
    });
  }
  
  /**
   * Record a successful backup path ping/pong
   * Task 5.3: Track backup path health metrics
   * 
   * @param {string} pathType - The path type
   * @param {number} rtt - The round-trip time in milliseconds
   * @private
   */
  _recordBackupPathSuccess(pathType, rtt) {
    if (!this._backupPathHealth.has(pathType)) {
      this._backupPathHealth.set(pathType, {
        lastPingTime: null,
        lastPongTime: null,
        consecutiveFailures: 0,
        latency: null,
        latencyHistory: []
      });
    }
    
    const health = this._backupPathHealth.get(pathType);
    health.lastPongTime = Date.now();
    health.consecutiveFailures = 0;
    health.latency = rtt;
    
    // Keep latency history for averaging
    health.latencyHistory.push(rtt);
    if (health.latencyHistory.length > 10) {
      health.latencyHistory.shift();
    }
  }
  
  /**
   * Record a backup path failure
   * Task 5.3: Track backup path health metrics
   * 
   * @param {string} pathType - The path type
   * @param {string} reason - The failure reason
   * @private
   */
  _recordBackupPathFailure(pathType, reason) {
    if (!this._backupPathHealth.has(pathType)) {
      this._backupPathHealth.set(pathType, {
        lastPingTime: null,
        lastPongTime: null,
        consecutiveFailures: 0,
        latency: null,
        latencyHistory: []
      });
    }
    
    const health = this._backupPathHealth.get(pathType);
    health.consecutiveFailures++;
    
    Logger.path(`⚠️ WARM_BACKUP_FAILURE peer=${this.peerId?.substring(0, 8)} pathType=${pathType} failures=${health.consecutiveFailures} reason=${reason}`);
    
    // If too many consecutive failures, mark the backup path as unhealthy
    const maxFailures = 3;
    if (health.consecutiveFailures >= maxFailures) {
      Logger.path(`❌ WARM_BACKUP_UNHEALTHY peer=${this.peerId?.substring(0, 8)} pathType=${pathType} failures=${health.consecutiveFailures}`);
      console.warn(`❌ HybridConnectionManager: Backup path ${pathType} is unhealthy (${health.consecutiveFailures} consecutive failures)`);
      
      // Update PathTracker to mark path as degraded
      if (this.pathTracker && this.pathTracker.hasPath(pathType)) {
        this.pathTracker.recordMeasurementFailure(pathType, reason);
      }
      
      this.emit('backupPathUnhealthy', {
        peerId: this.peerId,
        pathType,
        consecutiveFailures: health.consecutiveFailures,
        reason,
        timestamp: Date.now()
      });
    }
  }
  
  /**
   * Clear a pending backup path ping
   * @param {string} pingId - The ping ID to clear
   * @private
   */
  _clearPendingBackupPathPing(pingId) {
    const pending = this._pendingBackupPathPings.get(pingId);
    if (!pending) {
      return null;
    }
    
    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
    }
    this._pendingBackupPathPings.delete(pingId);
    
    return pending;
  }
  
  /**
   * Clear all pending backup path pings
   * @private
   */
  _clearAllPendingBackupPathPings() {
    for (const [pingId, pending] of this._pendingBackupPathPings) {
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
    }
    this._pendingBackupPathPings.clear();
  }
  
  /**
   * Get warm backup paths status
   * Task 5.3: Returns current warm backup paths state for monitoring
   * 
   * @returns {Object} Warm backup paths status
   */
  getWarmBackupPathsStatus() {
    const backupPaths = this._getBackupPaths();
    const healthStatus = {};
    
    for (const pathType of backupPaths) {
      const health = this._backupPathHealth.get(pathType);
      if (health) {
        const avgLatency = health.latencyHistory.length > 0
          ? Math.round(health.latencyHistory.reduce((a, b) => a + b, 0) / health.latencyHistory.length)
          : null;
        
        healthStatus[pathType] = {
          lastPingTime: health.lastPingTime,
          lastPongTime: health.lastPongTime,
          timeSinceLastPong: health.lastPongTime ? Date.now() - health.lastPongTime : null,
          consecutiveFailures: health.consecutiveFailures,
          latency: health.latency,
          avgLatency,
          isHealthy: health.consecutiveFailures < 3,
          isWarm: health.lastPongTime && (Date.now() - health.lastPongTime) < this._warmBackupPathsInterval * 2
        };
      }
    }
    
    return {
      enabled: this._warmBackupPathsEnabled,
      running: this._warmBackupPathsTimer !== null,
      interval: this._warmBackupPathsInterval,
      activeTransport: this.activeTransport,
      backupPaths,
      pendingPings: this._pendingBackupPathPings.size,
      health: healthStatus
    };
  }
  
  /**
   * Check for NAT state changes by re-gathering ICE candidates
   * Task 5.1: Re-run ICE gathering periodically to detect NAT state changes
   * 
   * NAT state can change due to:
   * - Network interface changes (WiFi ↔ cellular)
   * - IP address changes (DHCP renewal, roaming)
   * - NAT mapping timeout and refresh
   * - IPv6 availability changes
   * 
   * This method uses the ConnectionProfileDetector to re-detect the connection
   * profile and compares it with the cached profile to detect changes.
   * 
   * @private
   */
  async _checkForNatStateChanges() {
    // Only check periodically (not every probe)
    // Check every 5th probe when on relay, every 10th probe when on direct
    const checkInterval = this.activeTransport === 'relay' ? 5 : 10;
    this._natStateCheckCounter = (this._natStateCheckCounter || 0) + 1;
    
    if (this._natStateCheckCounter % checkInterval !== 0) {
      return;
    }
    
    Logger.path(`🔍 NAT_STATE_CHECK peer=${this.peerId?.substring(0, 8)} counter=${this._natStateCheckCounter} activeTransport=${this.activeTransport}`);
    console.log(`🔍 HybridConnectionManager: Checking for NAT state changes...`);
    
    try {
      // Import ConnectionProfileDetector dynamically to avoid circular dependency
      const { ConnectionProfileDetector } = await import('./ConnectionProfileDetector.js');
      
      // Create a temporary detector with a short cache (force re-detection)
      const detector = new ConnectionProfileDetector({
        cacheMaxAge: 0, // Force fresh detection
        gatheringTimeout: 5000 // Shorter timeout for background check
      });
      
      // Get fresh connection profile
      const newProfile = await detector.getConnectionProfile();
      
      // Compare with stored profile (if any)
      const profileChanged = this._detectProfileChanges(newProfile);
      
      if (profileChanged.hasChanges) {
        Logger.path(`🔄 NAT_STATE_CHANGED peer=${this.peerId?.substring(0, 8)} changes=${JSON.stringify(profileChanged.changes)}`);
        console.log(`🔄 HybridConnectionManager: NAT state changed:`, profileChanged.changes);
        
        // Store the new profile
        this._lastConnectionProfile = newProfile;
        
        // Emit event for monitoring
        this.emit('natStateChanged', {
          peerId: this.peerId,
          changes: profileChanged.changes,
          oldProfile: profileChanged.oldProfile,
          newProfile: newProfile,
          timestamp: Date.now()
        });
        
        // If NAT type improved (hard → easy or gained IPv6), try to upgrade connection
        if (profileChanged.improved) {
          Logger.path(`⬆️ NAT_STATE_IMPROVED peer=${this.peerId?.substring(0, 8)} reason=${profileChanged.improvementReason}`);
          console.log(`⬆️ HybridConnectionManager: NAT state improved (${profileChanged.improvementReason}), attempting connection upgrade`);
          
          // If we're on relay and NAT improved, try WebRTC again
          if (this.activeTransport === 'relay' && this.webrtcManager && !this.webrtcConnected) {
            this.emit('backgroundIceRestart', {
              peerId: this.peerId,
              reason: 'nat_state_improved',
              changes: profileChanged.changes,
              timestamp: Date.now()
            });
            
            await this.webrtcManager.restartIce({ peerId: this.peerId });
          }
        }
        
        // If NAT type degraded (easy → hard or lost IPv6), prepare for potential failover
        if (profileChanged.degraded) {
          Logger.path(`⬇️ NAT_STATE_DEGRADED peer=${this.peerId?.substring(0, 8)} reason=${profileChanged.degradationReason}`);
          console.log(`⬇️ HybridConnectionManager: NAT state degraded (${profileChanged.degradationReason}), ensuring relay is ready`);
          
          // Ensure relay is available as backup
          if (!this.relayConnected && this.relayManager) {
            this._attemptRelayReestablishment();
          }
        }
      }
    } catch (error) {
      Logger.path(`⚠️ NAT_STATE_CHECK_ERROR peer=${this.peerId?.substring(0, 8)} error=${error.message}`);
      console.warn(`⚠️ HybridConnectionManager: Failed to check NAT state: ${error.message}`);
    }
  }
  
  /**
   * Detect changes between old and new connection profiles
   * Task 5.1: Compare connection profiles to detect NAT state changes
   * 
   * @param {Object} newProfile - The newly detected connection profile
   * @returns {Object} Change detection result
   * @private
   */
  _detectProfileChanges(newProfile) {
    const result = {
      hasChanges: false,
      changes: [],
      improved: false,
      degraded: false,
      improvementReason: null,
      degradationReason: null,
      oldProfile: this._lastConnectionProfile
    };
    
    const oldProfile = this._lastConnectionProfile;
    
    // First time detection - store profile but don't report changes
    if (!oldProfile) {
      this._lastConnectionProfile = newProfile;
      return result;
    }
    
    // Check IPv6 availability change
    if (oldProfile.hasIPv6 !== newProfile.hasIPv6) {
      result.hasChanges = true;
      if (newProfile.hasIPv6) {
        result.changes.push('gained_ipv6');
        result.improved = true;
        result.improvementReason = 'gained IPv6 connectivity';
      } else {
        result.changes.push('lost_ipv6');
        result.degraded = true;
        result.degradationReason = 'lost IPv6 connectivity';
      }
    }
    
    // Check NAT type change
    if (oldProfile.natType !== newProfile.natType) {
      result.hasChanges = true;
      result.changes.push(`nat_type_${oldProfile.natType}_to_${newProfile.natType}`);
      
      // NAT type improvement order: hard < unknown < easy < open
      const natTypeOrder = { hard: 0, unknown: 1, easy: 2, open: 3 };
      const oldOrder = natTypeOrder[oldProfile.natType] ?? 1;
      const newOrder = natTypeOrder[newProfile.natType] ?? 1;
      
      if (newOrder > oldOrder) {
        result.improved = true;
        result.improvementReason = `NAT type improved from ${oldProfile.natType} to ${newProfile.natType}`;
      } else if (newOrder < oldOrder) {
        result.degraded = true;
        result.degradationReason = `NAT type degraded from ${oldProfile.natType} to ${newProfile.natType}`;
      }
    }
    
    // Check external IP change (indicates network switch)
    if (oldProfile.ipv4External !== newProfile.ipv4External) {
      result.hasChanges = true;
      result.changes.push('external_ip_changed');
      // IP change is neutral - could be better or worse depending on new NAT
    }
    
    // Check port pattern change
    if (oldProfile.portPattern !== newProfile.portPattern) {
      result.hasChanges = true;
      result.changes.push(`port_pattern_${oldProfile.portPattern}_to_${newProfile.portPattern}`);
      
      // Sequential is better than random for NAT traversal
      if (newProfile.portPattern === 'sequential' && oldProfile.portPattern === 'random') {
        result.improved = true;
        result.improvementReason = result.improvementReason 
          ? `${result.improvementReason}, port pattern improved`
          : 'port pattern improved to sequential';
      } else if (newProfile.portPattern === 'random' && oldProfile.portPattern === 'sequential') {
        result.degraded = true;
        result.degradationReason = result.degradationReason
          ? `${result.degradationReason}, port pattern degraded`
          : 'port pattern degraded to random';
      }
    }
    
    return result;
  }
  
  /**
   * Attempt to establish WebRTC connection during background probing
   * Task 5.1: Re-run ICE gathering periodically to detect NAT state changes
   * 
   * This is different from _attemptWebRTCReconnection (Task 4.6) which is for
   * failover recovery. This method is for proactive path discovery when we're
   * stable on relay but want to find a better direct path.
   * 
   * @private
   */
  async _attemptBackgroundWebRTCProbe() {
    // Check if we've exceeded max attempts
    if (this._backgroundProbeAttempts >= this.options.maxBackgroundProbeAttempts) {
      Logger.path(`🔍 BACKGROUND_PROBE_MAX_ATTEMPTS peer=${this.peerId?.substring(0, 8)} attempts=${this._backgroundProbeAttempts} max=${this.options.maxBackgroundProbeAttempts}`);
      console.log(`🔍 HybridConnectionManager: Max background probe attempts reached (${this._backgroundProbeAttempts}), entering cooldown`);
      
      // Enter cooldown period
      this._backgroundProbeCooldownUntil = Date.now() + this.options.backgroundProbeCooldown;
      this._stopBackgroundProbing();
      
      this.emit('backgroundProbeCooldown', {
        peerId: this.peerId,
        attempts: this._backgroundProbeAttempts,
        cooldownUntil: this._backgroundProbeCooldownUntil,
        cooldownDuration: this.options.backgroundProbeCooldown,
        timestamp: Date.now()
      });
      
      // Schedule restart after cooldown
      this._backgroundProbeTimer = setTimeout(() => {
        this._backgroundProbeTimer = null;
        this._backgroundProbeCooldownUntil = null;
        this._backgroundProbeAttempts = 0;
        this._startBackgroundProbing();
      }, this.options.backgroundProbeCooldown);
      
      return;
    }
    
    this._backgroundProbeAttempts++;
    
    Logger.path(`🔍 BACKGROUND_WEBRTC_PROBE peer=${this.peerId?.substring(0, 8)} attempt=${this._backgroundProbeAttempts}/${this.options.maxBackgroundProbeAttempts}`);
    console.log(`🔍 HybridConnectionManager: Background WebRTC probe attempt ${this._backgroundProbeAttempts}/${this.options.maxBackgroundProbeAttempts}`);
    
    this.emit('backgroundWebRTCProbe', {
      peerId: this.peerId,
      attempt: this._backgroundProbeAttempts,
      maxAttempts: this.options.maxBackgroundProbeAttempts,
      timestamp: Date.now()
    });
    
    try {
      // If we have an existing WebRTC manager that failed, try ICE restart
      if (this.webrtcManager && !this.webrtcConnected) {
        Logger.path(`❄️ BACKGROUND_ICE_RESTART peer=${this.peerId?.substring(0, 8)} reason=nat_state_change_detection`);
        console.log(`❄️ HybridConnectionManager: Attempting ICE restart for NAT state change detection`);
        
        // Task 5.1: Re-run ICE gathering to detect NAT state changes
        // NAT mappings typically timeout after 30 seconds for UDP
        // By restarting ICE, we get fresh NAT mappings that might succeed
        await this.webrtcManager.restartIce({ peerId: this.peerId });
        
        this.emit('backgroundIceRestart', {
          peerId: this.peerId,
          attempt: this._backgroundProbeAttempts,
          reason: 'nat_state_change_detection',
          timestamp: Date.now()
        });
      } else if (!this.webrtcManager) {
        // No WebRTC manager exists, try to create one
        Logger.path(`🌐 BACKGROUND_WEBRTC_CREATE peer=${this.peerId?.substring(0, 8)} reason=no_existing_manager`);
        console.log(`🌐 HybridConnectionManager: Creating new WebRTC manager for background probing`);
        
        // Attempt to establish WebRTC (this will run in background)
        await this._establishWebRTC(this.peerId, true, null);
        
        this.emit('backgroundWebRTCCreated', {
          peerId: this.peerId,
          attempt: this._backgroundProbeAttempts,
          timestamp: Date.now()
        });
      }
    } catch (error) {
      Logger.path(`⚠️ BACKGROUND_WEBRTC_PROBE_ERROR peer=${this.peerId?.substring(0, 8)} attempt=${this._backgroundProbeAttempts} error=${error.message}`);
      console.warn(`⚠️ HybridConnectionManager: Background WebRTC probe failed: ${error.message}`);
      
      this.emit('backgroundWebRTCProbeFailed', {
        peerId: this.peerId,
        attempt: this._backgroundProbeAttempts,
        error: error.message,
        timestamp: Date.now()
      });
    }
  }
  
  /**
   * Reset background probe attempts counter
   * Task 5.1: Called when WebRTC successfully connects
   * @private
   */
  _resetBackgroundProbeAttempts() {
    this._backgroundProbeAttempts = 0;
    this._backgroundProbeCooldownUntil = null;
    
    Logger.path(`🔍 BACKGROUND_PROBE_RESET peer=${this.peerId?.substring(0, 8)}`);
  }
  
  /**
   * Enable or disable background probing
   * Task 5.1: Allows runtime control of background probing
   * @param {boolean} enabled - Whether to enable background probing
   */
  setBackgroundProbingEnabled(enabled) {
    this._backgroundProbingEnabled = enabled;
    
    if (enabled && this.connectionState === 'connected') {
      this._startBackgroundProbing();
    } else if (!enabled) {
      this._stopBackgroundProbing();
    }
    
    Logger.path(`🔍 BACKGROUND_PROBE_ENABLED peer=${this.peerId?.substring(0, 8)} enabled=${enabled}`);
    console.log(`🔍 HybridConnectionManager: Background probing ${enabled ? 'enabled' : 'disabled'}`);
  }
  
  /**
   * Get background probing status
   * Task 5.1: Returns current background probing state
   * @returns {Object} Background probing status
   */
  getBackgroundProbingStatus() {
    return {
      enabled: this._backgroundProbingEnabled,
      running: this._backgroundProbeTimer !== null,
      attempts: this._backgroundProbeAttempts,
      maxAttempts: this.options.maxBackgroundProbeAttempts,
      inCooldown: this._backgroundProbeCooldownUntil !== null && Date.now() < this._backgroundProbeCooldownUntil,
      cooldownUntil: this._backgroundProbeCooldownUntil,
      lastProbeTime: this._lastBackgroundProbeTime,
      currentInterval: this._getBackgroundProbeInterval(),
      activeTransport: this.activeTransport
    };
  }
  
  /**
   * Get NAT state check status
   * Task 5.1: Returns current NAT state monitoring state
   * @returns {Object} NAT state check status
   */
  getNatStateCheckStatus() {
    return {
      checkCounter: this._natStateCheckCounter,
      lastProfile: this._lastConnectionProfile,
      hasProfile: this._lastConnectionProfile !== null,
      natType: this._lastConnectionProfile?.natType || 'unknown',
      hasIPv6: this._lastConnectionProfile?.hasIPv6 || false,
      portPattern: this._lastConnectionProfile?.portPattern || 'unknown',
      needsRelay: this._lastConnectionProfile?.needsRelay || false
    };
  }
  
  /**
   * Get NAT mapping timeout status
   * Task 5.1: Returns current NAT mapping health status for monitoring
   * 
   * NAT mappings for UDP typically expire after 30 seconds of inactivity.
   * This method returns the current status of NAT mapping health for each path.
   * 
   * @returns {Object} NAT mapping status
   */
  getNatMappingStatus() {
    const now = Date.now();
    const { natMappingTimeout, natMappingRefreshMargin } = this.options;
    const refreshThreshold = natMappingTimeout - natMappingRefreshMargin;
    
    // Calculate time since last traffic on each path
    const webrtcTimeSinceTraffic = this._lastWebRTCTrafficTime 
      ? now - this._lastWebRTCTrafficTime 
      : null;
    const relayTimeSinceTraffic = this._lastRelayTrafficTime 
      ? now - this._lastRelayTrafficTime 
      : null;
    
    // Determine health status for each path
    const getHealthStatus = (timeSinceTraffic) => {
      if (timeSinceTraffic === null) return 'unknown';
      if (timeSinceTraffic < refreshThreshold) return 'healthy';
      if (timeSinceTraffic < natMappingTimeout) return 'warning';
      return 'expired';
    };
    
    return {
      // Configuration
      natMappingTimeout,
      natMappingRefreshMargin,
      refreshThreshold,
      keepAliveInterval: this.options.keepAliveInterval,
      
      // WebRTC path status
      webrtc: {
        lastTrafficTime: this._lastWebRTCTrafficTime,
        timeSinceTraffic: webrtcTimeSinceTraffic,
        health: this.webrtcConnected ? getHealthStatus(webrtcTimeSinceTraffic) : 'disconnected',
        timeUntilExpiry: webrtcTimeSinceTraffic !== null 
          ? Math.max(0, natMappingTimeout - webrtcTimeSinceTraffic) 
          : null
      },
      
      // Relay path status (TCP-based, doesn't have NAT mapping issues)
      relay: {
        lastTrafficTime: this._lastRelayTrafficTime,
        timeSinceTraffic: relayTimeSinceTraffic,
        health: this.relayConnected ? 'healthy' : 'disconnected', // TCP doesn't have NAT mapping timeout
        note: 'Relay uses WebSocket (TCP) which maintains persistent connection'
      },
      
      // Overall status
      activePathHealth: this.activeTransport === 'webrtc' 
        ? getHealthStatus(webrtcTimeSinceTraffic)
        : (this.relayConnected ? 'healthy' : 'disconnected')
    };
  }
  
  /**
   * Force a NAT state check
   * Task 5.1: Allows manual triggering of NAT state check
   * @returns {Promise<Object>} The change detection result
   */
  async forceNatStateCheck() {
    // Reset counter to force check on next call
    this._natStateCheckCounter = 0;
    await this._checkForNatStateChanges();
    return this.getNatStateCheckStatus();
  }
  
  /**
   * Start tracking time on a specific path type
   * Task 5.4: Track time spent on each path type per connection
   * 
   * Called when switching to a new path to start the timer for that path.
   * Also stops the timer for the previous path if one was active.
   * 
   * @param {string} pathType - The path type to start tracking (from PathType enum)
   * @private
   */
  _startPathTimeTracking(pathType) {
    const now = Date.now();
    
    // Stop tracking the previous path if one was active
    if (this._currentPathForTimeTracking && this._currentPathForTimeTracking !== pathType) {
      this._stopPathTimeTracking(this._currentPathForTimeTracking);
    }
    
    // Initialize connection established time if this is the first path
    if (!this._connectionEstablishedTime) {
      this._connectionEstablishedTime = now;
    }
    
    // Start tracking the new path
    if (this._pathTimeStats[pathType]) {
      this._pathTimeStats[pathType].startTime = now;
      this._pathTimeStats[pathType].switchCount++;
      this._currentPathForTimeTracking = pathType;
      
      Logger.path(`⏱️ PATH_TIME_START peer=${this.peerId?.substring(0, 8)} pathType=${pathType} switchCount=${this._pathTimeStats[pathType].switchCount}`);
    }
  }
  
  /**
   * Stop tracking time on a specific path type
   * Task 5.4: Track time spent on each path type per connection
   * 
   * Called when switching away from a path to accumulate the time spent on it.
   * 
   * @param {string} pathType - The path type to stop tracking (from PathType enum)
   * @private
   */
  _stopPathTimeTracking(pathType) {
    const now = Date.now();
    
    if (this._pathTimeStats[pathType] && this._pathTimeStats[pathType].startTime !== null) {
      const duration = now - this._pathTimeStats[pathType].startTime;
      this._pathTimeStats[pathType].totalTime += duration;
      this._pathTimeStats[pathType].startTime = null;
      
      Logger.path(`⏱️ PATH_TIME_STOP peer=${this.peerId?.substring(0, 8)} pathType=${pathType} duration=${duration}ms totalTime=${this._pathTimeStats[pathType].totalTime}ms`);
    }
    
    if (this._currentPathForTimeTracking === pathType) {
      this._currentPathForTimeTracking = null;
    }
  }
  
  /**
   * Get path time statistics for this connection
   * Task 5.4: Track time spent on each path type per connection
   * 
   * Returns detailed statistics about how much time has been spent on each path type,
   * including percentages of total connection time.
   * 
   * @returns {Object} Path time statistics
   */
  getPathTimeStats() {
    const now = Date.now();
    
    // Calculate total connection time
    const totalConnectionTime = this._connectionEstablishedTime 
      ? now - this._connectionEstablishedTime 
      : 0;
    
    // Build stats for each path type
    const pathStats = {};
    let totalTrackedTime = 0;
    
    for (const [pathType, stats] of Object.entries(this._pathTimeStats)) {
      // Calculate current time including any ongoing session
      let currentTotalTime = stats.totalTime;
      if (stats.startTime !== null) {
        currentTotalTime += now - stats.startTime;
      }
      
      totalTrackedTime += currentTotalTime;
      
      pathStats[pathType] = {
        totalTime: currentTotalTime,
        switchCount: stats.switchCount,
        isActive: stats.startTime !== null,
        currentSessionDuration: stats.startTime !== null ? now - stats.startTime : null,
        percentage: totalConnectionTime > 0 
          ? Math.round((currentTotalTime / totalConnectionTime) * 10000) / 100 // 2 decimal places
          : 0
      };
    }
    
    // Calculate aggregate stats
    const relayTime = pathStats[PathType.WEBSOCKET_RELAY]?.totalTime || 0;
    const directTime = (pathStats[PathType.WEBRTC_DIRECT]?.totalTime || 0) + 
                       (pathStats[PathType.IPV6_DIRECT]?.totalTime || 0);
    
    return {
      peerId: this.peerId,
      connectionEstablishedTime: this._connectionEstablishedTime,
      totalConnectionTime,
      currentPath: this._currentPathForTimeTracking,
      
      // Per-path statistics
      paths: pathStats,
      
      // Aggregate statistics (Task 5.4: Report aggregate statistics: % direct, % relay)
      aggregate: {
        relayTime,
        directTime,
        relayPercentage: totalConnectionTime > 0 
          ? Math.round((relayTime / totalConnectionTime) * 10000) / 100 
          : 0,
        directPercentage: totalConnectionTime > 0 
          ? Math.round((directTime / totalConnectionTime) * 10000) / 100 
          : 0,
        // Target metric from spec: 80%+ direct connections on desktop networks
        meetsDirectTarget: totalConnectionTime > 0 && (directTime / totalConnectionTime) >= 0.8
      },
      
      // Total switches across all paths
      totalSwitches: Object.values(this._pathTimeStats).reduce((sum, s) => sum + s.switchCount, 0)
    };
  }
  
  /**
   * Reset path time statistics
   * Task 5.4: Allows resetting stats for testing or new measurement period
   * @private
   */
  _resetPathTimeStats() {
    for (const pathType of Object.keys(this._pathTimeStats)) {
      this._pathTimeStats[pathType] = { totalTime: 0, startTime: null, switchCount: 0 };
    }
    this._connectionEstablishedTime = null;
    this._currentPathForTimeTracking = null;
    
    Logger.path(`⏱️ PATH_TIME_RESET peer=${this.peerId?.substring(0, 8)}`);
  }
  
  /**
   * Attempt to re-establish relay connection after failure
   * Task 4.6: Handle case when relay fails and needs re-establishment
   * 
   * This is called when:
   * 1. WebRTC fails and relay was not available (shouldn't happen with default settings)
   * 2. Relay fails and WebRTC is not available
   * 
   * The relay is the "always available" fallback, so we try hard to re-establish it.
   * 
   * @private
   */
  async _attemptRelayReestablishment() {
    if (this._relayReestablishmentInProgress || this.isDestroyed) return;
    
    this._relayReestablishmentInProgress = true;
    
    // Task 4.5: Log relay re-establishment attempt for debugging
    Logger.path(`🔄 RELAY_REESTABLISH_START peer=${this.peerId?.substring(0, 8)} webrtcConnected=${this.webrtcConnected} connectionState=${this.connectionState}`);
    console.log(`🔄 HybridConnectionManager: Attempting to re-establish relay for ${this.peerId?.substring(0, 8)}...`);
    
    // Task 4.6: Emit event for relay re-establishment attempt
    this.emit('relayReestablishmentStarted', {
      peerId: this.peerId,
      timestamp: Date.now()
    });
    
    try {
      // Clear old relay state
      this.relaySession = null;
      this.relayConnected = false;
      
      // Attempt to establish new relay
      const result = await this._establishRelay(this.peerId, null);
      
      if (result) {
        // Task 4.5: Log relay re-establishment success for debugging
        Logger.path(`✅ RELAY_REESTABLISH_SUCCESS peer=${this.peerId?.substring(0, 8)} activeTransport=${this.activeTransport}`);
        console.log(`✅ HybridConnectionManager: Relay re-established successfully`);
        
        // Task 4.6: Emit event for successful relay re-establishment
        this.emit('relayReestablished', {
          peerId: this.peerId,
          timestamp: Date.now()
        });
        
        // If we were disconnected, update state
        if (this.connectionState !== 'connected') {
          this.connectionState = 'connected';
          this.activeTransport = 'relay';
          
          Logger.path(`🔄 RELAY_RECONNECTED peer=${this.peerId?.substring(0, 8)} previousState=disconnected newTransport=relay`);
          
          this.emit('peerReconnected', {
            peerId: this.peerId,
            transport: 'relay',
            reason: 'relay_reestablished'
          });
        }
        
        // Reset failure count
        this._resetConsecutiveFailures(PathType.WEBSOCKET_RELAY);
      } else {
        // Task 4.5: Log relay re-establishment failure for debugging
        Logger.path(`❌ RELAY_REESTABLISH_FAILED peer=${this.peerId?.substring(0, 8)} webrtcConnected=${this.webrtcConnected}`);
        console.error(`❌ HybridConnectionManager: Failed to re-establish relay`);
        
        // Task 4.6: Emit event for failed relay re-establishment
        this.emit('relayReestablishmentFailed', {
          peerId: this.peerId,
          timestamp: Date.now()
        });
        
        // If no paths available, emit disconnect
        if (!this.webrtcConnected) {
          Logger.path(`⚠️ ALL_PATHS_FAILED peer=${this.peerId?.substring(0, 8)} relayConnected=false webrtcConnected=false`);
          this.connectionState = 'disconnected';
          this.emit('peerDisconnected', {
            peerId: this.peerId,
            reason: 'all_paths_failed'
          });
        }
      }
    } catch (error) {
      // Task 4.5: Log relay re-establishment error for debugging
      Logger.path(`❌ RELAY_REESTABLISH_ERROR peer=${this.peerId?.substring(0, 8)} error=${error.message}`);
      console.error(`❌ HybridConnectionManager: Relay re-establishment error: ${error.message}`);
      
      // Task 4.6: Emit event for relay re-establishment error
      this.emit('relayReestablishmentFailed', {
        peerId: this.peerId,
        error: error.message,
        timestamp: Date.now()
      });
    } finally {
      this._relayReestablishmentInProgress = false;
    }
  }
  
  /**
   * Attempt to reconnect WebRTC after path failure
   * Task 4.6: Try to find new direct path after failover
   * 
   * This method is called after failing over to relay to attempt to re-establish
   * a direct WebRTC connection. It implements the following strategy:
   * 
   * 1. If WebRTC manager exists and isn't connected, attempt ICE restart
   * 2. For hard NAT pairs, use coordinated ICE restart via bootstrap server
   * 3. Track retry attempts and use exponential backoff
   * 4. Emit events for monitoring and debugging
   * 
   * @private
   */
  async _attemptWebRTCReconnection() {
    if (this.isDestroyed) return;
    
    // Don't attempt if already reconnecting
    if (this._webrtcReconnectionInProgress) {
      Logger.path(`🔄 RECONNECT_SKIPPED peer=${this.peerId?.substring(0, 8)} reason=already_in_progress`);
      console.log(`🔄 HybridConnectionManager: WebRTC reconnection already in progress`);
      return;
    }
    
    this._webrtcReconnectionInProgress = true;
    
    // Track retry attempts for exponential backoff
    this._webrtcReconnectAttempts = (this._webrtcReconnectAttempts || 0) + 1;
    const maxAttempts = 5;
    
    if (this._webrtcReconnectAttempts > maxAttempts) {
      // Task 4.5: Log reconnection abandonment for debugging
      Logger.path(`🔄 RECONNECT_ABANDONED peer=${this.peerId?.substring(0, 8)} attempts=${this._webrtcReconnectAttempts} maxAttempts=${maxAttempts} reason=max_attempts_reached activeTransport=${this.activeTransport}`);
      console.log(`🔄 HybridConnectionManager: Max WebRTC reconnection attempts (${maxAttempts}) reached, staying on relay`);
      this._webrtcReconnectionInProgress = false;
      
      this.emit('webrtcReconnectionAbandoned', {
        peerId: this.peerId,
        attempts: this._webrtcReconnectAttempts,
        reason: 'max_attempts_reached',
        timestamp: Date.now()
      });
      return;
    }
    
    // Task 4.5: Log reconnection attempt for debugging
    Logger.path(`🔄 RECONNECT_START peer=${this.peerId?.substring(0, 8)} attempt=${this._webrtcReconnectAttempts}/${maxAttempts} hardNatPair=${this._hardNatPairDetected || false} coordinatedRestartAttempted=${this._coordinatedRestartAttempted || false}`);
    console.log(`🔄 HybridConnectionManager: Attempting WebRTC reconnection for ${this.peerId?.substring(0, 8)}... (attempt ${this._webrtcReconnectAttempts}/${maxAttempts})`);
    
    // Emit event for monitoring
    this.emit('webrtcReconnectionStarted', {
      peerId: this.peerId,
      attempt: this._webrtcReconnectAttempts,
      maxAttempts,
      timestamp: Date.now()
    });
    
    try {
      // Check if WebRTC manager exists
      if (!this.webrtcManager) {
        Logger.path(`🔄 RECONNECT_FAILED peer=${this.peerId?.substring(0, 8)} reason=no_webrtc_manager`);
        console.log(`🔄 HybridConnectionManager: No WebRTC manager, cannot attempt reconnection`);
        // Note: We don't recreate the WebRTC manager here because that would require
        // full signaling setup. Instead, we rely on the existing manager if available.
        // If the manager was destroyed, we stay on relay until a new connection is initiated.
        this._webrtcReconnectionInProgress = false;
        return;
      }
      
      // Request coordinated ICE restart if we detected hard NAT pair
      if (this._hardNatPairDetected && !this._coordinatedRestartAttempted) {
        Logger.path(`❄️ ICE_RESTART_COORDINATED peer=${this.peerId?.substring(0, 8)} reason=hard_nat_pair`);
        console.log(`❄️ HybridConnectionManager: Requesting coordinated ICE restart for hard NAT pair`);
        
        this.emit('iceRestartRequest', {
          targetPeerId: this.peerId,
          sessionId: `ice-restart-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
          reason: 'path_failure_recovery'
        });
        
        this._coordinatedRestartAttempted = true;
      } else {
        // Regular ICE restart
        Logger.path(`❄️ ICE_RESTART_REGULAR peer=${this.peerId?.substring(0, 8)} attempt=${this._webrtcReconnectAttempts}`);
        console.log(`❄️ HybridConnectionManager: Attempting regular ICE restart`);
        await this.webrtcManager.restartIce({ peerId: this.peerId });
      }
      
      // Set up a timeout to check if reconnection succeeded
      // If not, schedule another probing attempt with exponential backoff
      const checkTimeout = setTimeout(() => {
        if (this.isDestroyed) return;
        
        if (!this.webrtcConnected) {
          // Task 4.5: Log reconnection timeout for debugging
          Logger.path(`🔄 RECONNECT_TIMEOUT peer=${this.peerId?.substring(0, 8)} attempt=${this._webrtcReconnectAttempts} webrtcConnected=false`);
          console.log(`🔄 HybridConnectionManager: WebRTC reconnection attempt ${this._webrtcReconnectAttempts} did not succeed`);
          
          this.emit('webrtcReconnectionFailed', {
            peerId: this.peerId,
            attempt: this._webrtcReconnectAttempts,
            reason: 'timeout',
            timestamp: Date.now()
          });
          
          // Schedule next attempt with exponential backoff
          // Base delay: 5 seconds, max delay: 60 seconds
          const baseDelay = this.options.pathProbingDelay || 5000;
          const backoffDelay = Math.min(baseDelay * Math.pow(2, this._webrtcReconnectAttempts - 1), 60000);
          
          Logger.path(`🔄 RECONNECT_BACKOFF peer=${this.peerId?.substring(0, 8)} nextDelay=${backoffDelay}ms attempt=${this._webrtcReconnectAttempts}`);
          console.log(`🔄 HybridConnectionManager: Scheduling next reconnection attempt in ${backoffDelay}ms`);
          
          this._schedulePathProbing(backoffDelay);
        } else {
          // Task 4.5: Log reconnection success for debugging
          Logger.path(`✅ RECONNECT_SUCCESS peer=${this.peerId?.substring(0, 8)} attempt=${this._webrtcReconnectAttempts} activeTransport=${this.activeTransport}`);
          console.log(`✅ HybridConnectionManager: WebRTC reconnection succeeded!`);
          
          // Reset retry counter on success
          this._webrtcReconnectAttempts = 0;
          
          this.emit('webrtcReconnectionSucceeded', {
            peerId: this.peerId,
            attempt: this._webrtcReconnectAttempts,
            timestamp: Date.now()
          });
        }
      }, 15000); // 15 second timeout to check reconnection result
      
      // Store timeout for cleanup
      this._webrtcReconnectCheckTimer = checkTimeout;
      
    } catch (error) {
      // Task 4.5: Log reconnection error for debugging
      Logger.path(`⚠️ RECONNECT_ERROR peer=${this.peerId?.substring(0, 8)} attempt=${this._webrtcReconnectAttempts} error=${error.message}`);
      console.warn(`⚠️ HybridConnectionManager: WebRTC reconnection failed: ${error.message}`);
      
      this.emit('webrtcReconnectionFailed', {
        peerId: this.peerId,
        attempt: this._webrtcReconnectAttempts,
        reason: error.message,
        timestamp: Date.now()
      });
      
      // Schedule next attempt with exponential backoff
      const baseDelay = this.options.pathProbingDelay || 5000;
      const backoffDelay = Math.min(baseDelay * Math.pow(2, this._webrtcReconnectAttempts - 1), 60000);
      
      this._schedulePathProbing(backoffDelay);
    } finally {
      this._webrtcReconnectionInProgress = false;
    }
  }
  
  /**
   * Reset WebRTC reconnection state
   * Called when WebRTC successfully connects or when connection is destroyed
   * @private
   */
  _resetWebRTCReconnectionState() {
    this._webrtcReconnectAttempts = 0;
    this._webrtcReconnectionInProgress = false;
    this._coordinatedRestartAttempted = false;
    
    if (this._webrtcReconnectCheckTimer) {
      clearTimeout(this._webrtcReconnectCheckTimer);
      this._webrtcReconnectCheckTimer = null;
    }
  }
  
  /**
   * Handle path ping message (respond with pong)
   * Task 4.4: Respond to RTT measurement pings
   * @param {Object} message - The ping message
   * @private
   */
  _handlePathPing(message) {
    const { pingId, timestamp, type } = message;
    
    console.log(`📊 HybridConnectionManager: Received path ping ${pingId?.substring(0, 12)}... from ${this.peerId?.substring(0, 8)}...`);
    
    // Respond with pong through the same transport
    const pongMessage = {
      type: 'path_pong',
      pingId,
      timestamp, // Echo back original timestamp for RTT calculation
      respondedAt: Date.now()
    };
    
    // Send pong back through the active transport
    if (this.activeTransport === 'webrtc' && this.webrtcManager) {
      this.webrtcManager.sendRawMessage(this.peerId, pongMessage).catch(err => {
        console.warn(`⚠️ Failed to send path pong via WebRTC: ${err.message}`);
      });
    } else if (this.activeTransport === 'relay' && this.relaySession && this.relayManager) {
      // Send pong through relay
      this.relayManager.sendThroughRelay(this.relaySession.sessionId, pongMessage).catch(err => {
        console.warn(`⚠️ Failed to send path pong via relay: ${err.message}`);
      });
    } else {
      console.warn(`⚠️ HybridConnectionManager: No transport available to send path pong`);
    }
  }
  
  /**
   * Handle relay ping message (respond with relay pong)
   * Task 4.4: Respond to relay RTT measurement pings
   * This is called when we receive a relay_ping through the relay path
   * @param {Object} message - The relay ping message
   */
  handleRelayPing(message) {
    const { sessionId, pingId, timestamp } = message;
    
    console.log(`📊 HybridConnectionManager: Received relay ping ${pingId?.substring(0, 12)}... for session ${sessionId?.substring(0, 8)}...`);
    
    // Verify this is for our session
    if (this.relaySession && sessionId !== this.relaySession.sessionId) {
      console.warn(`⚠️ HybridConnectionManager: Relay ping session mismatch`);
      return;
    }
    
    // Respond with relay pong through the relay
    if (this.relaySession && this.relayManager) {
      const pongMessage = {
        type: 'relay_pong',
        sessionId,
        pingId,
        timestamp, // Echo back original timestamp
        respondedAt: Date.now()
      };
      
      // Send pong back through relay
      this.relayManager.sendThroughRelay(this.relaySession.sessionId, pongMessage).catch(err => {
        console.warn(`⚠️ Failed to send relay pong: ${err.message}`);
      });
    }
  }
  
  /**
   * Handle path pong message (complete latency measurement)
   * Task 4.4: Complete RTT measurement when pong is received
   * Task 4.6: Reset consecutive failure count on successful pong
   * Task 6.2: Log IPv6 vs IPv4 latency comparison
   * @param {Object} message - The pong message
   * @private
   */
  _handlePathPong(message) {
    const { pingId, timestamp } = message;
    
    if (!this._pendingPathPings || !this.pathTracker) return;
    
    const pending = this._pendingPathPings.get(pingId);
    if (!pending) {
      console.log(`📊 HybridConnectionManager: Received pong for unknown ping ${pingId?.substring(0, 12)}...`);
      return;
    }
    
    // Clear the timeout
    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
    }
    
    this._pendingPathPings.delete(pingId);
    
    // Task 4.6: Reset consecutive failure count on successful pong
    this._resetConsecutiveFailures(pending.pathType);
    
    // Complete the measurement in PathTracker
    const latency = this.pathTracker.completeMeasurement(pingId);
    
    if (latency !== null) {
      console.log(`📊 HybridConnectionManager: Path ${pending.pathType} RTT: ${latency}ms (peer: ${this.peerId?.substring(0, 8)}...)`);
      
      // Task 6.2: Log IPv6 vs IPv4 latency comparison
      this._recordIPv6LatencyComparison(pending.pathType, latency);
      
      // Emit event for monitoring
      this.emit('pathRttMeasured', {
        peerId: this.peerId,
        pathType: pending.pathType,
        latency,
        pingId
      });
    }
  }
  
  /**
   * Record IPv6 vs IPv4 latency measurement for comparison (Task 6.2)
   * Logs latency measurements and compares when both path types are available
   * 
   * @param {string} pathType - The path type (ipv6-direct, webrtc-direct, websocket-relay)
   * @param {number} latency - The measured latency in milliseconds
   * @private
   */
  _recordIPv6LatencyComparison(pathType, latency) {
    // Determine if this is an IPv6 or IPv4 measurement
    const isIPv6 = pathType === PathType.IPV6_DIRECT;
    const isIPv4 = pathType === PathType.WEBRTC_DIRECT; // WebRTC direct uses IPv4 (srflx/host)
    
    // Skip relay paths for IPv6 vs IPv4 comparison (relay is neither)
    if (pathType === PathType.WEBSOCKET_RELAY) {
      return;
    }
    
    // Check if both paths are available for dual-stack comparison
    const ipv6Path = this.pathTracker?.getPath(PathType.IPV6_DIRECT);
    const ipv4Path = this.pathTracker?.getPath(PathType.WEBRTC_DIRECT);
    
    const ipv6Available = ipv6Path && ipv6Path.state !== PathState.FAILED;
    const ipv4Available = ipv4Path && ipv4Path.state !== PathState.FAILED;
    
    // Get alternate path latency for comparison
    let alternateLatency = null;
    if (isIPv6 && ipv4Available && ipv4Path.latency !== null) {
      alternateLatency = ipv4Path.latency;
    } else if (isIPv4 && ipv6Available && ipv6Path.latency !== null) {
      alternateLatency = ipv6Path.latency;
    }
    
    // Record the latency measurement using the already-imported ConnectionMetricsTracker
    ConnectionMetricsTracker.recordLatencyMeasurement({
      isIPv6,
      latency,
      peerId: this.peerId,
      ipv6Available,
      ipv4Available,
      alternateLatency
    });
    
    // Log comparison when both paths have latency data
    if (ipv6Available && ipv4Available && ipv6Path.latency !== null && ipv4Path.latency !== null) {
      const ipv6Latency = ipv6Path.latency;
      const ipv4Latency = ipv4Path.latency;
      const diff = ipv4Latency - ipv6Latency; // Positive = IPv6 faster
      const fasterPath = diff > 0 ? 'IPv6' : (diff < 0 ? 'IPv4' : 'equal');
      
      Logger.path(`📊 IPV6_VS_IPV4_LATENCY peer=${this.peerId?.substring(0, 8)} ipv6=${ipv6Latency}ms ipv4=${ipv4Latency}ms diff=${diff}ms faster=${fasterPath}`);
      
      // Log significant differences
      if (Math.abs(diff) > 20) {
        console.log(`📊 IPv6 vs IPv4 Latency (${this.peerId?.substring(0, 8)}...): IPv6=${ipv6Latency}ms, IPv4=${ipv4Latency}ms → ${fasterPath} is ${Math.abs(diff)}ms faster`);
      }
    }
  }
  
  /**
   * Handle relay pong message from RelayManager
   * Task 4.4: Process relay RTT measurement response
   * This is called when a relay_pong message is received for our session
   * @param {Object} message - The relay pong message { sessionId, pingId, timestamp, respondedAt }
   */
  handleRelayPong(message) {
    const { sessionId, pingId, timestamp, respondedAt } = message;
    
    // Verify this is for our session
    if (this.relaySession && sessionId !== this.relaySession.sessionId) {
      return; // Not for us
    }
    
    // Convert to path_pong format and handle
    this._handlePathPong({
      type: 'path_pong',
      pingId,
      timestamp,
      respondedAt
    });
  }
  
  /**
   * Handle incoming relay message from RelayManager
   * Called by RelayManager when a relay_forward message arrives for our peer
   * Task 4.5: Handles migration messages and deduplicates dual-send messages
   * Task 5.1: Track traffic time for NAT mapping timeout handling
   * @param {Object} message - The relay message { sessionId, from, payload }
   */
  handleRelayMessage({ sessionId, from, payload }) {
    // Task 5.1: Track incoming relay traffic for NAT mapping timeout handling
    this._updateTrafficTime('relay');
    
    // Verify this message is for our session (or create session on-the-fly)
    if (!this.relaySession) {
      // Create session on-the-fly for incoming relay connection
      console.log(`🔄 HybridConnectionManager: Creating relay session on-the-fly for ${from.substring(0, 8)}...`);
      this.relaySession = {
        sessionId,
        relayNodeId: null, // Will be set when we know the relay
        state: 'active',
        createdAt: Date.now(),
        lastActivity: Date.now()
      };
      this.relayConnected = true;
      this.activeTransport = 'relay';
      this.connectionState = 'connected';
      
      // Task 5.4: Start path time tracking for relay
      this._startPathTimeTracking(PathType.WEBSOCKET_RELAY);
      
      // Task 4.1: Add relay path to PathTracker
      if (this.pathTracker) {
        this.pathTracker.addPath(PathType.WEBSOCKET_RELAY, { sessionId, relayNodeId: null });
        this.pathTracker.setPathState(PathType.WEBSOCKET_RELAY, PathState.ACTIVE, 'relay connected');
        this.pathTracker.setActivePath(PathType.WEBSOCKET_RELAY);
      }
      
      // Emit connected event
      this.emit('peerConnected', {
        peerId: from,
        connection: this,
        manager: this,
        initiator: false,
        transport: 'relay'
      });
    }
    
    // Verify session ID matches (if we have one)
    if (this.relaySession.sessionId && sessionId !== this.relaySession.sessionId) {
      console.warn(`⚠️ HybridConnectionManager: Session ID mismatch (expected ${this.relaySession.sessionId.substring(0, 8)}..., got ${sessionId.substring(0, 8)}...)`);
      // Accept anyway - might be a new session from the same peer
      this.relaySession.sessionId = sessionId;
    }
    
    // Update session activity
    this.relaySession.lastActivity = Date.now();
    
    // Task 4.1 & 4.4: Handle path ping/pong messages for latency measurement
    if (payload && payload.type === 'path_ping') {
      this._handlePathPing(payload);
      return; // Don't forward to DHT
    }
    if (payload && payload.type === 'path_pong') {
      this._handlePathPong(payload);
      return; // Don't forward to DHT
    }
    
    // Task 4.4: Handle relay_ping messages that come through relay_forward
    // This happens when the peer sends us a relay RTT ping
    if (payload && payload.type === 'relay_ping') {
      this.handleRelayPing(payload);
      return; // Don't forward to DHT
    }
    
    // Task 4.4: Handle relay_pong messages that come through relay_forward
    // This happens when the peer responds to our relay RTT ping
    if (payload && payload.type === 'relay_pong') {
      this.handleRelayPong(payload);
      return; // Don't forward to DHT
    }
    
    // Task 5.3: Handle keep-alive messages
    if (payload && (payload.type === 'relay_keepalive' || payload.type === 'keepalive_ping')) {
      this._handleKeepAlivePing(payload);
      return; // Don't forward to DHT
    }
    if (payload && (payload.type === 'relay_keepalive_pong' || payload.type === 'keepalive_pong')) {
      this._handleKeepAlivePong(payload);
      return; // Don't forward to DHT
    }
    
    // Task 5.3: Handle backup path ping/pong messages for warm backup paths
    if (payload && payload.type === 'backup_path_ping') {
      this._handleBackupPathPing(payload);
      return; // Don't forward to DHT
    }
    if (payload && payload.type === 'backup_path_pong') {
      this._handleBackupPathPong(payload);
      return; // Don't forward to DHT
    }
    
    // Task 4.5: Handle migration confirmation messages
    if (payload && payload.type === 'migration_confirm') {
      this._handleMigrationConfirm(payload);
      return; // Don't forward to DHT
    }
    
    // Task 4.5: Handle migration acknowledgment messages
    if (payload && payload.type === 'migration_ack') {
      this._handleMigrationAck(payload);
      return; // Don't forward to DHT
    }
    
    // Task 4.5: Deduplicate dual-send messages
    if (payload && payload._dualSend && payload._migrationId) {
      if (this._isDuplicateMessage(payload, 'relay')) {
        console.log(`📥 HybridConnectionManager: Dropping duplicate dual-send message via relay`);
        return; // Already received via WebRTC
      }
      // Mark as received via relay
      this._markMessageReceived(payload, 'relay');
      
      // Remove migration markers before forwarding
      const cleanPayload = { ...payload };
      delete cleanPayload._dualSend;
      delete cleanPayload._migrationId;
      
      // Emit as dhtMessage for DHT to process
      this.emit('dhtMessage', {
        peerId: from,
        message: cleanPayload,
        sourceManager: this
      });
      return;
    }
    
    // Emit as dhtMessage for DHT to process
    this.emit('dhtMessage', {
      peerId: from,
      message: payload,
      sourceManager: this
    });
  }
  
  /**
   * Check if a dual-send message is a duplicate (already received on another path)
   * Task 4.5: Deduplication for dual-send messages during migration
   * @param {Object} message - The message to check
   * @param {string} receivedVia - The transport this message was received on
   * @returns {boolean} True if this is a duplicate
   * @private
   */
  _isDuplicateMessage(message, receivedVia) {
    if (!this._recentMessages) {
      this._recentMessages = new Map();
    }
    
    // Create a unique key for this message
    // Use migrationId + message type + any unique identifier in the message
    const messageKey = `${message._migrationId}_${message.type}_${message.id || message.requestId || message.timestamp || ''}`;
    
    const existing = this._recentMessages.get(messageKey);
    if (existing && existing.receivedVia !== receivedVia) {
      // Already received on a different path
      return true;
    }
    
    return false;
  }
  
  /**
   * Mark a message as received for deduplication
   * Task 4.5: Tracks received messages for dual-send deduplication
   * @param {Object} message - The message that was received
   * @param {string} receivedVia - The transport this message was received on
   * @private
   */
  _markMessageReceived(message, receivedVia) {
    if (!this._recentMessages) {
      this._recentMessages = new Map();
    }
    
    const messageKey = `${message._migrationId}_${message.type}_${message.id || message.requestId || message.timestamp || ''}`;
    
    this._recentMessages.set(messageKey, {
      receivedVia,
      timestamp: Date.now()
    });
    
    // Clean up old entries (keep last 100 or entries from last 30 seconds)
    if (this._recentMessages.size > 100) {
      const cutoff = Date.now() - 30000;
      for (const [key, value] of this._recentMessages) {
        if (value.timestamp < cutoff) {
          this._recentMessages.delete(key);
        }
      }
    }
  }
  
  /**
   * Handle relay session closed notification
   * Called by RelayManager when the relay session is closed
   * @param {string} reason - Reason for closure
   */
  handleRelaySessionClosed(reason) {
    this.relayConnected = false;
    this.relaySession = null;
    
    // If relay was active transport and WebRTC isn't available, disconnect
    if (this.activeTransport === 'relay' && !this.webrtcConnected) {
      this.connectionState = 'disconnected';
      this.emit('peerDisconnected', { peerId: this.peerId, reason: 'relay_closed' });
    }
  }


  /**
   * Set the bridge node to use for relay connections
   * @param {string} bridgeNodeId - Bridge node ID
   */
  setBridgeNode(bridgeNodeId) {
    this.bridgeNodeId = bridgeNodeId;
  }

  /**
   * Create a hybrid connection to a peer
   * Immediately establishes relay, then probes for WebRTC in parallel
   * 
   * @param {string} peerId - Target peer ID
   * @param {boolean} initiator - Whether this side initiates
   * @param {Object} metadata - Peer metadata
   * @returns {Promise} Resolves when at least one path is connected
   */
  async createConnection(peerId, initiator = true, metadata = null) {
    if (this.isDestroyed) {
      throw new Error('HybridConnectionManager is destroyed');
    }
    
    if (this.connectionState === 'connected' || this.connectionState === 'connecting') {
      console.log(`🔄 HybridConnectionManager already ${this.connectionState} to ${peerId.substring(0, 8)}...`);
      return;
    }
    
    this.peerId = peerId;
    this.connectionState = 'connecting';
    this.connectionStartTime = Date.now();
    
    // Task 4.1: Initialize PathTracker for this peer
    this._initializePathTracker(peerId);
    
    // Register with RelayManager for incoming message routing
    this._registerWithRelayManager();
    
    // Task 6.1: Check if both peers have IPv6 - if so, skip relay entirely
    // IPv6 addresses are globally routable, so no NAT hole-punching needed
    const useIPv6DirectOnly = this._shouldUseIPv6DirectOnly(metadata);
    
    if (useIPv6DirectOnly) {
      console.log(`🌐 HybridConnectionManager: Both peers have IPv6 - using direct-only strategy (skipping relay)`);
      return this._createIPv6DirectConnection(peerId, initiator, metadata);
    }
    
    console.log(`🚀 HybridConnectionManager: Creating connection to ${peerId.substring(0, 8)}... (parallel strategy: relay + WebRTC)`);
    
    // Task 4.1: Start BOTH relay and WebRTC in parallel
    // This follows the Tailscale philosophy: "try everything at once, and pick the best thing that works"
    // Relay is expected to succeed faster (guaranteed path), WebRTC probes in background
    
    // Start WebRTC ICE gathering immediately (non-blocking, runs in background)
    // This gives WebRTC a head start on ICE candidate gathering while relay establishes
    let webrtcPromise = null;
    if (this.options.attemptWebRTC) {
      console.log(`🌐 HybridConnectionManager: Starting WebRTC ICE gathering in parallel...`);
      webrtcPromise = this._establishWebRTC(peerId, initiator, metadata).catch(err => {
        console.log(`🌐 WebRTC parallel probing failed: ${err.message}`);
        return null;
      });
    }
    
    // Start relay establishment (this is the priority path, expected to succeed first)
    const relayResult = await this._establishRelay(peerId, metadata);
    
    // If relay succeeded, we're connected via relay
    // WebRTC continues probing in background and will upgrade when ready
    if (relayResult) {
      this.connectionState = 'connected';
      this.activeTransport = 'relay';
      this.connection = this;
      
      console.log(`✅ HybridConnectionManager: Connected via relay to ${peerId.substring(0, 8)}... (WebRTC probing continues in background)`);
      
      // Emit peerConnected event (DHT expects this)
      this.emit('peerConnected', {
        peerId,
        connection: this,
        manager: this,
        initiator,
        transport: 'relay'
      });
      
      // Emit connected event for hybrid-specific listeners
      this.emit('connected', {
        peerId,
        transport: 'relay',
        duration: Date.now() - this.connectionStartTime
      });
      
      // Flush any queued messages
      this._flushMessageQueue();
      
      // Task 5.1: Start background probing to find better paths
      // This will periodically attempt to establish WebRTC when on relay
      this._startBackgroundProbing();
      
      // Task 5.3: Start keep-alive timer to keep NAT mappings alive
      this._startKeepAlive();
      
      // Task 5.3: Start warm backup paths timer to keep backup paths ready for instant failover
      this._startWarmBackupPaths();
      
      // WebRTC is already running in parallel (started above)
      // It will emit 'peerConnected' when ready, triggering _upgradeToWebRTC()
      
      return { type: 'relay', success: true };
    }
    
    // Relay failed - wait for WebRTC if it's still trying
    if (webrtcPromise) {
      console.log(`⚠️ Relay failed, waiting for parallel WebRTC attempt...`);
      
      try {
        // Wait for the WebRTC attempt that's already in progress
        const webrtcResult = await webrtcPromise;
        
        // Give WebRTC a moment to complete connection (it may have started but not finished)
        if (webrtcResult && !this.webrtcConnected) {
          console.log(`🔄 WebRTC started but not yet connected, waiting briefly...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        if (this.webrtcConnected) {
          this.connectionState = 'connected';
          this.activeTransport = 'webrtc';
          this.connection = this;
          
          this.emit('peerConnected', {
            peerId,
            connection: this,
            manager: this,
            initiator,
            transport: 'webrtc'
          });
          
          this.emit('connected', {
            peerId,
            transport: 'webrtc',
            duration: Date.now() - this.connectionStartTime
          });
          
          this._flushMessageQueue();
          
          // Task 5.3: Start keep-alive timer to keep NAT mappings alive
          this._startKeepAlive();
          
          // Task 5.3: Start warm backup paths timer to keep backup paths ready for instant failover
          this._startWarmBackupPaths();
          
          return { type: 'webrtc', success: true };
        }
      } catch (error) {
        console.warn(`⚠️ WebRTC parallel attempt also failed: ${error.message}`);
      }
    }
    
    // Both paths failed
    this.connectionState = 'failed';
    console.error(`❌ HybridConnectionManager: Failed to connect to ${peerId.substring(0, 8)}...`);
    
    this.emit('connectionFailed', {
      peerId,
      error: 'Both relay and WebRTC failed',
      duration: Date.now() - this.connectionStartTime
    });
    
    throw new Error('Connection failed: both relay and WebRTC paths failed');
  }

  /**
   * Establish relay connection via bridge node
   * Creates a local relay session and requests the relay node to set up forwarding
   * @private
   */
  async _establishRelay(peerId, metadata) {
    if (!this.bridgeNodeId) {
      console.warn('⚠️ HybridConnectionManager: No bridge node configured for relay');
      this.emit('relayFailed', { peerId, error: 'No bridge node configured' });
      return null;
    }
    
    if (!this.relayManager) {
      console.warn('⚠️ HybridConnectionManager: No RelayManager available');
      this.emit('relayFailed', { peerId, error: 'No RelayManager available' });
      return null;
    }
    
    console.log(`🔄 HybridConnectionManager: Establishing relay via ${this.bridgeNodeId.substring(0, 8)}...`);
    
    try {
      // Request relay session through the relay manager
      // The RelayManager handles relay node selection and session setup
      const session = await this.relayManager.requestRelaySession(peerId, {
        preferredRelay: this.bridgeNodeId,
        timeout: this.options.relayTimeout
      });
      
      if (session) {
        // Store session info locally (we own this session)
        this.relaySession = {
          sessionId: session.sessionId,
          relayNodeId: session.relayNodeId,
          state: 'active',
          createdAt: Date.now(),
          lastActivity: Date.now()
        };
        
        this.relayConnected = true;
        this.relayEstablishedTime = Date.now();
        
        // Task 5.4: Start path time tracking for relay (if this is the first connection)
        if (!this._connectionEstablishedTime) {
          this._startPathTimeTracking(PathType.WEBSOCKET_RELAY);
        }
        
        const duration = this.relayEstablishedTime - this.connectionStartTime;
        console.log(`✅ HybridConnectionManager: Relay established in ${duration}ms`);
        
        // Task 4.1: Add relay path to PathTracker with initial latency estimate
        if (this.pathTracker) {
          this.pathTracker.addPath(PathType.WEBSOCKET_RELAY, {
            sessionId: session.sessionId,
            relayNodeId: session.relayNodeId
          });
          this.pathTracker.setPathState(PathType.WEBSOCKET_RELAY, PathState.AVAILABLE, 'relay established');
          // Record initial latency estimate based on establishment time
          this.pathTracker.recordLatency(PathType.WEBSOCKET_RELAY, duration);
        }
        
        this.emit('relayEstablished', {
          peerId,
          sessionId: this.relaySession.sessionId,
          relayNodeId: this.relaySession.relayNodeId,
          duration
        });
        
        // Task 5.4: Log initial relay connection event with timestamp to history
        this._logPathEvent({
          eventType: 'initial',
          fromPath: null,
          toPath: PathType.WEBSOCKET_RELAY,
          fromTransport: null,
          toTransport: 'relay',
          reason: 'initial_connection',
          duration,
          metadata: {
            sessionId: this.relaySession.sessionId,
            relayNodeId: this.relaySession.relayNodeId
          }
        });
        
        // Track relay connection metric
        ConnectionMetricsTracker.recordAttempt({
          connectionType: ConnectionType.BROWSER_TO_BROWSER,
          outcome: ConnectionOutcome.RELAY_FALLBACK,
          localNodeType: 'browser',
          remoteNodeType: 'browser',
          peerId,
          duration,
          usedIPv6: false,  // Relay connections use WebSocket, not IPv6 direct
          ipv6Available: this.connectionProfile?.hasIPv6 || false
        });
        
        return this.relaySession;
      }
    } catch (error) {
      console.warn(`⚠️ HybridConnectionManager: Relay establishment failed:`, error.message);
      this.emit('relayFailed', { peerId, error: error.message });
      
      // Task 4.1: Mark relay path as failed in PathTracker
      if (this.pathTracker) {
        this.pathTracker.addPath(PathType.WEBSOCKET_RELAY, {});
        this.pathTracker.setPathState(PathType.WEBSOCKET_RELAY, PathState.FAILED, error.message);
      }
    }
    
    return null;
  }


  /**
   * Establish WebRTC connection in parallel with relay
   * Task 4.1: Uses non-blocking mode so WebRTC probes don't block relay usage
   * Task 4.2: Sends ICE coordination request for synchronized NAT traversal
   * @private
   */
  async _establishWebRTC(peerId, initiator, metadata) {
    if (this.webrtcAttempted) {
      return null;
    }
    
    this.webrtcAttempted = true;
    console.log(`🌐 HybridConnectionManager: Starting WebRTC ICE gathering for ${peerId.substring(0, 8)}... (non-blocking)`);
    
    // Task 4.2: Send ICE coordination request to bootstrap server
    // This implements the Tailscale technique for synchronized NAT traversal:
    // When Browser A wants to connect to Browser B, both send ice_coordinate requests
    // Bootstrap holds requests until both are ready, then sends ice_start to both simultaneously
    if (initiator) {
      console.log(`❄️ HybridConnectionManager: Requesting ICE coordination for ${peerId.substring(0, 8)}...`);
      this.emit('iceCoordinateRequest', {
        targetPeerId: peerId,
        sessionId: `ice-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
      });
    }
    
    try {
      // Create WebRTC manager
      this.webrtcManager = new WebRTCConnectionManager({
        ...this.options,
        timeout: this.options.webrtcTimeout
      });
      
      // Forward WebRTC signal events (for DHT signaling)
      this.webrtcManager.on('signal', (signal) => {
        this.emit('signal', signal);
      });
      
      // Forward dhtMessage events from WebRTC
      // Task 4.5: Handle migration messages and deduplicate dual-send messages
      this.webrtcManager.on('dhtMessage', (data) => {
        const { peerId: msgPeerId, message, sourceManager } = data;
        
        // Task 4.5: Handle migration confirmation messages
        if (message && message.type === 'migration_confirm') {
          this._handleMigrationConfirm(message);
          return; // Don't forward to DHT
        }
        
        // Task 4.5: Handle migration acknowledgment messages
        if (message && message.type === 'migration_ack') {
          this._handleMigrationAck(message);
          return; // Don't forward to DHT
        }
        
        // Task 4.5: Handle path ping/pong messages for latency measurement
        if (message && message.type === 'path_ping') {
          this._handlePathPing(message);
          return; // Don't forward to DHT
        }
        if (message && message.type === 'path_pong') {
          this._handlePathPong(message);
          return; // Don't forward to DHT
        }
        
        // Task 5.3: Handle keep-alive messages
        if (message && (message.type === 'keepalive_ping' || message.type === 'relay_keepalive')) {
          this._handleKeepAlivePing(message);
          return; // Don't forward to DHT
        }
        if (message && (message.type === 'keepalive_pong' || message.type === 'relay_keepalive_pong')) {
          this._handleKeepAlivePong(message);
          return; // Don't forward to DHT
        }
        
        // Task 5.3: Handle backup path ping/pong messages for warm backup paths
        if (message && message.type === 'backup_path_ping') {
          this._handleBackupPathPing(message);
          return; // Don't forward to DHT
        }
        if (message && message.type === 'backup_path_pong') {
          this._handleBackupPathPong(message);
          return; // Don't forward to DHT
        }
        
        // Task 4.5: Deduplicate dual-send messages
        if (message && message._dualSend && message._migrationId) {
          if (this._isDuplicateMessage(message, 'webrtc')) {
            console.log(`📥 HybridConnectionManager: Dropping duplicate dual-send message via WebRTC`);
            return; // Already received via relay
          }
          // Mark as received via WebRTC
          this._markMessageReceived(message, 'webrtc');
          
          // Remove migration markers before forwarding
          const cleanMessage = { ...message };
          delete cleanMessage._dualSend;
          delete cleanMessage._migrationId;
          
          // Forward cleaned message
          this.emit('dhtMessage', { peerId: msgPeerId, message: cleanMessage, sourceManager: this });
          return;
        }
        
        // Only forward if WebRTC is the active transport (or during dual-send migration)
        if (this.activeTransport === 'webrtc' || this.isDualSendActive()) {
          this.emit('dhtMessage', data);
        }
      });
      
      // Task 4.1: Listen for iceGatheringStarted event (non-blocking mode)
      this.webrtcManager.on('iceGatheringStarted', ({ peerId: pid }) => {
        console.log(`🧊 HybridConnectionManager: ICE gathering started for ${pid.substring(0, 8)}...`);
        this.emit('webrtcProbing', { peerId: pid });
      });
      
      // Task 4.1: Listen for connectionFailed event (non-blocking mode)
      this.webrtcManager.on('connectionFailed', ({ peerId: pid, reason }) => {
        console.log(`❌ HybridConnectionManager: WebRTC connection failed for ${pid.substring(0, 8)}...: ${reason}`);
        this.emit('webrtcFailed', { peerId: pid, error: reason });
        
        // Task 4.1: Mark WebRTC path as failed in PathTracker
        if (this.pathTracker) {
          this.pathTracker.addPath(PathType.WEBRTC_DIRECT, {});
          this.pathTracker.setPathState(PathType.WEBRTC_DIRECT, PathState.FAILED, reason);
        }
      });
      
      // Task 4.3: Listen for iceConnectionFailed event to request coordinated ICE restart
      // This is triggered when ICE fails, and we should attempt coordinated restart
      // if both peers have hard NAT and this is the initial ICE failure (not a restart)
      this.webrtcManager.on('iceConnectionFailed', ({ peerId: pid, wasIceRestart, sessionId, candidateTypes }) => {
        console.log(`❄️ HybridConnectionManager: ICE connection failed for ${pid.substring(0, 8)}... (wasRestart: ${wasIceRestart})`);
        
        // Only attempt coordinated ICE restart if:
        // 1. This was NOT already an ICE restart attempt (avoid infinite loop)
        // 2. We detected a hard NAT pair earlier
        // 3. The bootstrap server recommended attempting coordinated restart
        if (!wasIceRestart && this._hardNatPairDetected && this._shouldAttemptCoordinatedRestart) {
          console.log(`❄️ HybridConnectionManager: Requesting coordinated ICE restart for hard NAT pair`);
          console.log(`   → Estimated success rate: ${((this._estimatedSuccessRate || 0) * 100).toFixed(0)}%`);
          
          // Emit event to request coordinated ICE restart via bootstrap server
          // The DHT/BootstrapClient will handle sending the ice_restart_coordinate message
          this.emit('iceRestartRequest', {
            targetPeerId: pid,
            sessionId: sessionId || `ice-restart-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
            reason: 'hard_nat_pair_initial_failure',
            candidateTypes
          });
          
          // Mark that we've attempted coordinated restart (prevent multiple attempts)
          this._coordinatedRestartAttempted = true;
        } else if (wasIceRestart) {
          console.log(`❄️ HybridConnectionManager: ICE restart also failed for ${pid.substring(0, 8)}... - giving up on direct connection`);
          // ICE restart failed too - we're stuck on relay
          this.emit('iceRestartFailed', { peerId: pid, reason: 'restart_also_failed' });
        } else {
          console.log(`❄️ HybridConnectionManager: Not attempting coordinated restart (hardNat: ${this._hardNatPairDetected}, shouldRestart: ${this._shouldAttemptCoordinatedRestart})`);
        }
      });
      
      // Task 4.3: Listen for iceRestartInitiated event
      this.webrtcManager.on('iceRestartInitiated', ({ peerId: pid, sessionId }) => {
        console.log(`❄️ HybridConnectionManager: ICE restart initiated for ${pid.substring(0, 8)}... (session: ${sessionId?.substring(0, 12) || 'none'})`);
        this.emit('iceRestartInitiated', { peerId: pid, sessionId });
      });
      
      // Task 4.3: Listen for iceRestartSucceeded event
      this.webrtcManager.on('iceRestartSucceeded', ({ peerId: pid, sessionId }) => {
        console.log(`❄️ HybridConnectionManager: ICE restart succeeded for ${pid.substring(0, 8)}...`);
        this._coordinatedRestartAttempted = false;  // Reset for future attempts
        this.emit('iceRestartSucceeded', { peerId: pid, sessionId });
      });
      
      // Task 4.3: Listen for iceRestartFailed event from WebRTC manager
      this.webrtcManager.on('iceRestartFailed', ({ peerId: pid, reason, sessionId }) => {
        console.log(`❄️ HybridConnectionManager: ICE restart failed for ${pid.substring(0, 8)}...: ${reason}`);
        this.emit('iceRestartFailed', { peerId: pid, reason, sessionId });
      });
      
      // Task 4.4: Listen for RTT measurements from WebRTC keep-alive
      // This integrates the existing keep-alive ping/pong with PathTracker
      this.webrtcManager.on('rttMeasured', ({ peerId: pid, rtt, avgRtt, jitter, pingId }) => {
        // Update PathTracker with the measured RTT
        // Task 4.4: Update the correct path type (IPv6 or WebRTC direct)
        const pathType = this._webrtcIsIPv6 ? PathType.IPV6_DIRECT : PathType.WEBRTC_DIRECT;
        if (this.pathTracker && this.pathTracker.hasPath(pathType)) {
          this.pathTracker.recordLatency(pathType, rtt);
        }
        
        // Forward the event for external monitoring
        this.emit('webrtcRttMeasured', {
          peerId: pid,
          pathType,
          rtt,
          avgRtt,
          jitter,
          pingId
        });
      });
      
      // Task 4.4: Listen for selectedCandidatePair event to detect IPv6 connections
      // This allows us to distinguish IPv6 from IPv4 WebRTC connections for path preference
      this.webrtcManager.on('selectedCandidatePair', ({ peerId: pid, selectedCandidatePair, isIPv6, duration }) => {
        console.log(`🧊 HybridConnectionManager: Selected candidate pair for ${pid?.substring(0, 8)}... - IPv6: ${isIPv6}`);
        
        // Store IPv6 status for this connection
        this._webrtcIsIPv6 = isIPv6;
        this._selectedCandidatePair = selectedCandidatePair;
        
        // Task 4.4: If IPv6, upgrade the path type from WEBRTC_DIRECT to IPV6_DIRECT
        // IPv6 connections bypass NAT entirely and should be preferred
        if (isIPv6 && this.pathTracker) {
          console.log(`🌐 HybridConnectionManager: IPv6 connection detected - upgrading path type`);
          
          // Get current WebRTC path info
          const webrtcPath = this.pathTracker.getPath(PathType.WEBRTC_DIRECT);
          
          // Add IPv6 path with the same latency info
          this.pathTracker.addPath(PathType.IPV6_DIRECT, {
            candidateType: selectedCandidatePair?.localType || 'host',
            localAddress: selectedCandidatePair?.localAddress,
            remoteAddress: selectedCandidatePair?.remoteAddress,
            protocol: selectedCandidatePair?.protocol
          });
          
          // Copy latency from WebRTC path if available
          if (webrtcPath && webrtcPath.latency !== null) {
            this.pathTracker.recordLatency(PathType.IPV6_DIRECT, webrtcPath.latency);
          } else if (duration) {
            // Use establishment duration as initial latency estimate
            this.pathTracker.recordLatency(PathType.IPV6_DIRECT, Math.min(duration, 500));
          }
          
          this.pathTracker.setPathState(PathType.IPV6_DIRECT, PathState.AVAILABLE, 'ipv6 connection detected');
          
          // Remove the WebRTC direct path since we're using IPv6
          this.pathTracker.removePath(PathType.WEBRTC_DIRECT);
          
          // Set IPv6 as active path (highest priority)
          this.pathTracker.setActivePath(PathType.IPV6_DIRECT);
          
          // Emit event for monitoring
          this.emit('ipv6Detected', {
            peerId: pid,
            localAddress: selectedCandidatePair?.localAddress,
            remoteAddress: selectedCandidatePair?.remoteAddress
          });
        }
      });
      
      this.webrtcManager.on('peerConnected', (data) => {
        this.webrtcConnected = true;
        this.webrtcEstablishedTime = Date.now();
        
        const duration = this.webrtcEstablishedTime - this.connectionStartTime;
        console.log(`✅ HybridConnectionManager: WebRTC connected in ${duration}ms`);
        
        // Task 4.6: Reset WebRTC reconnection state on successful connection
        this._resetWebRTCReconnectionState();
        
        // Task 4.6: Cancel any pending path probing since we're now connected
        this._cancelPathProbing();
        
        // Task 5.1: Reset background probe attempts on successful WebRTC connection
        this._resetBackgroundProbeAttempts();
        
        // Task 4.1: Add WebRTC path to PathTracker with initial latency estimate
        // Note: This may be upgraded to IPV6_DIRECT when selectedCandidatePair event arrives
        if (this.pathTracker) {
          this.pathTracker.addPath(PathType.WEBRTC_DIRECT, {
            candidateType: data.candidateType || 'unknown'
          });
          this.pathTracker.setPathState(PathType.WEBRTC_DIRECT, PathState.AVAILABLE, 'webrtc connected');
          // Record initial latency estimate based on establishment time
          // WebRTC establishment time is a rough proxy for RTT
          this.pathTracker.recordLatency(PathType.WEBRTC_DIRECT, Math.min(duration, 500));
        }
        
        this.emit('webrtcEstablished', {
          peerId,
          duration
        });
        
        // Track successful WebRTC connection
        ConnectionMetricsTracker.recordAttempt({
          connectionType: ConnectionType.BROWSER_TO_BROWSER,
          outcome: ConnectionOutcome.SUCCESS,
          localNodeType: 'browser',
          remoteNodeType: 'browser',
          peerId,
          duration,
          usedIPv6: this._webrtcIsIPv6 || false,
          ipv6Available: this.connectionProfile?.hasIPv6 || false
        });
        
        // If we were on relay, upgrade to WebRTC
        if (this.activeTransport === 'relay') {
          this._upgradeToWebRTC();
        }
        
        // Task 5.1: Restart background probing with longer interval (now on direct path)
        this._restartBackgroundProbing();
      });
      
      this.webrtcManager.on('peerDisconnected', (data) => {
        this.webrtcConnected = false;
        
        // Task 4.4: Mark the correct path type as failed (IPv6 or WebRTC direct)
        if (this.pathTracker) {
          if (this._webrtcIsIPv6) {
            this.pathTracker.setPathState(PathType.IPV6_DIRECT, PathState.FAILED, 'disconnected');
          } else {
            this.pathTracker.setPathState(PathType.WEBRTC_DIRECT, PathState.FAILED, 'disconnected');
          }
        }
        
        // If WebRTC was active, fall back to relay
        if (this.activeTransport === 'webrtc' && this.relayConnected) {
          this._downgradeToRelay();
        } else if (this.activeTransport === 'webrtc' && !this.relayConnected) {
          // No relay backup, emit disconnect
          this.connectionState = 'disconnected';
          this.emit('peerDisconnected', { peerId: this.peerId, reason: 'webrtc_disconnected' });
        }
      });
      
      // Task 4.1: Add WebRTC path to PathTracker in probing state
      if (this.pathTracker) {
        this.pathTracker.addPath(PathType.WEBRTC_DIRECT, {});
        // State is PROBING until peerConnected event fires
      }
      
      // Task 4.1: Start WebRTC connection in non-blocking mode
      // This returns immediately after ICE gathering starts, allowing relay to be used
      // while WebRTC probes in the background. Connection success/failure is handled
      // via the peerConnected/connectionFailed events above.
      await this.webrtcManager.createConnection(peerId, initiator, metadata, { nonBlocking: true });
      
      console.log(`🔄 HybridConnectionManager: WebRTC ICE probing started for ${peerId.substring(0, 8)}... (running in background)`);
      
      return this.webrtcManager;
    } catch (error) {
      console.warn(`⚠️ HybridConnectionManager: WebRTC failed to start:`, error.message);
      this.emit('webrtcFailed', { peerId, error: error.message });
      
      // Task 4.1: Mark WebRTC path as failed in PathTracker
      if (this.pathTracker) {
        this.pathTracker.addPath(PathType.WEBRTC_DIRECT, {});
        this.pathTracker.setPathState(PathType.WEBRTC_DIRECT, PathState.FAILED, error.message);
      }
      
      // WebRTC failure is not fatal if relay is working
      return null;
    }
  }

  /**
   * Check if both peers have IPv6 and should use direct-only strategy
   * Task 6.1: Skip NAT traversal entirely for IPv6-capable peers
   * 
   * IPv6 addresses are globally routable, so when both peers have IPv6:
   * - No NAT hole-punching is needed
   * - Direct connection should succeed with high probability
   * - Relay is unnecessary overhead
   * 
   * @param {Object} metadata - Remote peer's metadata (may contain connectionProfile)
   * @returns {boolean} True if both peers have IPv6 and should skip relay
   * @private
   */
  _shouldUseIPv6DirectOnly(metadata) {
    // Check local peer's IPv6 status from stored connection profile
    // First try the cached profile from background probing
    let localProfile = this._lastConnectionProfile;
    
    // If no cached profile, try to get it from the options (passed during construction)
    // or from the global metadata store via dynamic import
    if (!localProfile && this.options.localConnectionProfile) {
      localProfile = this.options.localConnectionProfile;
    }
    
    const localHasIPv6 = localProfile && localProfile.hasIPv6;
    
    if (!localHasIPv6) {
      // Local peer doesn't have IPv6 or profile not available
      // Fall back to relay-first strategy
      return false;
    }
    
    // Check remote peer's IPv6 status from metadata
    // The remote peer's connection profile is included in their metadata
    // when exchanged during the invitation/connection process
    const remoteProfile = metadata && metadata.connectionProfile;
    const remoteHasIPv6 = remoteProfile && remoteProfile.hasIPv6;
    
    if (!remoteHasIPv6) {
      // Remote profile not available or doesn't have IPv6
      // Fall back to relay-first strategy
      return false;
    }
    
    console.log(`🌐 IPv6 detected on both peers:`);
    console.log(`   Local IPv6: ${localProfile.ipv6Addresses?.join(', ') || 'yes'}`);
    console.log(`   Remote IPv6: ${remoteProfile.ipv6Addresses?.join(', ') || 'yes'}`);
    
    return true;
  }

  /**
   * Create a direct IPv6 connection without relay fallback
   * Task 6.1: Skip NAT traversal entirely for IPv6-capable peers
   * 
   * This is used when both peers have IPv6, which means:
   * - No NAT traversal is needed (IPv6 is globally routable)
   * - Direct WebRTC connection should succeed with high probability
   * - We skip relay establishment to reduce latency and overhead
   * 
   * @param {string} peerId - Target peer ID
   * @param {boolean} initiator - Whether this side initiates
   * @param {Object} metadata - Peer metadata
   * @returns {Promise} Resolves when connection is established
   * @private
   */
  async _createIPv6DirectConnection(peerId, initiator, metadata) {
    console.log(`🌐 HybridConnectionManager: Creating IPv6 direct connection to ${peerId.substring(0, 8)}... (no relay)`);
    
    // Task 5.4: Log IPv6 direct connection event
    this._logPathEvent({
      eventType: 'ipv6_direct_start',
      fromPath: null,
      toPath: PathType.IPV6_DIRECT,
      fromTransport: null,
      toTransport: 'webrtc',
      reason: 'ipv6_both_peers',
      metadata: {
        strategy: 'ipv6-direct-only',
        skipRelay: true
      }
    });
    
    try {
      // Establish WebRTC directly (blocking mode since we're not using relay)
      await this._establishWebRTC(peerId, initiator, metadata);
      
      // Wait for WebRTC to connect (with timeout)
      const timeout = this.options.webrtcTimeout || 30000;
      const startTime = Date.now();
      
      while (!this.webrtcConnected && (Date.now() - startTime) < timeout) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      if (this.webrtcConnected) {
        this.connectionState = 'connected';
        this.activeTransport = 'webrtc';
        this.connection = this;
        
        const duration = Date.now() - this.connectionStartTime;
        console.log(`✅ HybridConnectionManager: IPv6 direct connection established in ${duration}ms`);
        
        // Mark as IPv6 connection
        this._webrtcIsIPv6 = true;
        
        // Task 4.1: Update PathTracker to use IPv6 path type
        if (this.pathTracker) {
          this.pathTracker.addPath(PathType.IPV6_DIRECT, {
            strategy: 'ipv6-direct-only'
          });
          this.pathTracker.setPathState(PathType.IPV6_DIRECT, PathState.AVAILABLE, 'ipv6 direct connected');
          this.pathTracker.recordLatency(PathType.IPV6_DIRECT, Math.min(duration, 500));
          this.pathTracker.setActivePath(PathType.IPV6_DIRECT);
        }
        
        // Task 5.4: Start path time tracking for IPv6
        this._startPathTimeTracking(PathType.IPV6_DIRECT);
        
        // Task 5.4: Log successful IPv6 connection
        this._logPathEvent({
          eventType: 'initial',
          fromPath: null,
          toPath: PathType.IPV6_DIRECT,
          fromTransport: null,
          toTransport: 'webrtc',
          reason: 'ipv6_direct_success',
          duration,
          metadata: {
            strategy: 'ipv6-direct-only',
            skipRelay: true
          }
        });
        
        // Emit peerConnected event (DHT expects this)
        this.emit('peerConnected', {
          peerId,
          connection: this,
          manager: this,
          initiator,
          transport: 'webrtc',
          isIPv6: true
        });
        
        // Emit connected event for hybrid-specific listeners
        this.emit('connected', {
          peerId,
          transport: 'webrtc',
          isIPv6: true,
          duration
        });
        
        // Emit ipv6Detected event
        this.emit('ipv6Detected', {
          peerId,
          strategy: 'ipv6-direct-only'
        });
        
        // Flush any queued messages
        this._flushMessageQueue();
        
        // Task 5.3: Start keep-alive timer
        this._startKeepAlive();
        
        // Note: No background probing needed since we're already on the best path (IPv6)
        // Note: No warm backup paths since we skipped relay
        
        // Track successful IPv6 connection
        ConnectionMetricsTracker.recordAttempt({
          connectionType: ConnectionType.BROWSER_TO_BROWSER,
          outcome: ConnectionOutcome.DIRECT_SUCCESS,
          localNodeType: 'browser',
          remoteNodeType: 'browser',
          peerId,
          duration,
          candidateTypes: { ipv6: true },
          usedIPv6: true,
          ipv6Available: true
        });
        
        return { type: 'ipv6-direct', success: true };
      }
      
      // IPv6 direct connection failed - fall back to relay-first strategy
      console.warn(`⚠️ HybridConnectionManager: IPv6 direct connection failed, falling back to relay-first strategy`);
      
      // Reset state for retry with relay
      this.webrtcAttempted = false;
      this.webrtcConnected = false;
      if (this.webrtcManager) {
        await this.webrtcManager.destroy().catch(() => {});
        this.webrtcManager = null;
      }
      
      // Task 5.4: Log IPv6 failure and fallback
      this._logPathEvent({
        eventType: 'ipv6_direct_failed',
        fromPath: PathType.IPV6_DIRECT,
        toPath: PathType.WEBSOCKET_RELAY,
        fromTransport: 'webrtc',
        toTransport: 'relay',
        reason: 'ipv6_direct_timeout',
        metadata: {
          strategy: 'fallback_to_relay',
          timeout
        }
      });
      
      // Fall back to standard relay-first strategy
      return this._createConnectionWithRelay(peerId, initiator, metadata);
      
    } catch (error) {
      console.warn(`⚠️ HybridConnectionManager: IPv6 direct connection error: ${error.message}`);
      
      // Reset state for retry with relay
      this.webrtcAttempted = false;
      this.webrtcConnected = false;
      if (this.webrtcManager) {
        await this.webrtcManager.destroy().catch(() => {});
        this.webrtcManager = null;
      }
      
      // Fall back to standard relay-first strategy
      return this._createConnectionWithRelay(peerId, initiator, metadata);
    }
  }

  /**
   * Create connection using standard relay-first strategy
   * This is the fallback when IPv6 direct fails or when IPv6 is not available
   * @private
   */
  async _createConnectionWithRelay(peerId, initiator, metadata) {
    console.log(`🔄 HybridConnectionManager: Using relay-first strategy for ${peerId.substring(0, 8)}...`);
    
    // Start WebRTC ICE gathering in parallel
    let webrtcPromise = null;
    if (this.options.attemptWebRTC) {
      console.log(`🌐 HybridConnectionManager: Starting WebRTC ICE gathering in parallel...`);
      webrtcPromise = this._establishWebRTC(peerId, initiator, metadata).catch(err => {
        console.log(`🌐 WebRTC parallel probing failed: ${err.message}`);
        return null;
      });
    }
    
    // Start relay establishment
    const relayResult = await this._establishRelay(peerId, metadata);
    
    if (relayResult) {
      this.connectionState = 'connected';
      this.activeTransport = 'relay';
      this.connection = this;
      
      console.log(`✅ HybridConnectionManager: Connected via relay to ${peerId.substring(0, 8)}... (WebRTC probing continues in background)`);
      
      this.emit('peerConnected', {
        peerId,
        connection: this,
        manager: this,
        initiator,
        transport: 'relay'
      });
      
      this.emit('connected', {
        peerId,
        transport: 'relay',
        duration: Date.now() - this.connectionStartTime
      });
      
      this._flushMessageQueue();
      this._startBackgroundProbing();
      this._startKeepAlive();
      this._startWarmBackupPaths();
      
      return { type: 'relay', success: true };
    }
    
    // Relay failed - wait for WebRTC
    if (webrtcPromise) {
      console.log(`⚠️ Relay failed, waiting for parallel WebRTC attempt...`);
      
      try {
        const webrtcResult = await webrtcPromise;
        
        if (webrtcResult && !this.webrtcConnected) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        if (this.webrtcConnected) {
          this.connectionState = 'connected';
          this.activeTransport = 'webrtc';
          this.connection = this;
          
          this.emit('peerConnected', {
            peerId,
            connection: this,
            manager: this,
            initiator,
            transport: 'webrtc'
          });
          
          this.emit('connected', {
            peerId,
            transport: 'webrtc',
            duration: Date.now() - this.connectionStartTime
          });
          
          this._flushMessageQueue();
          this._startKeepAlive();
          this._startWarmBackupPaths();
          
          return { type: 'webrtc', success: true };
        }
      } catch (error) {
        console.warn(`⚠️ WebRTC parallel attempt also failed: ${error.message}`);
      }
    }
    
    // Both paths failed
    this.connectionState = 'failed';
    console.error(`❌ HybridConnectionManager: Failed to connect to ${peerId.substring(0, 8)}...`);
    
    this.emit('connectionFailed', {
      peerId,
      error: 'Both relay and WebRTC failed',
      duration: Date.now() - this.connectionStartTime
    });
    
    throw new Error('Connection failed: both relay and WebRTC paths failed');
  }

  /**
   * Upgrade from relay to WebRTC when direct path is available
   * Task 4.4: Handles both IPv6 and IPv4 WebRTC connections
   * Task 4.5: Implements transparent path migration without dropping messages
   * Path preference: IPv6 > WebRTC direct > WebSocket relay
   * @private
   */
  _upgradeToWebRTC() {
    if (!this.webrtcConnected || this.activeTransport === 'webrtc') {
      return;
    }
    
    // Prevent concurrent migrations
    if (this._migrationInProgress) {
      Logger.path(`⏳ UPGRADE_BLOCKED peer=${this.peerId?.substring(0, 8)} reason=migration_in_progress`);
      console.log(`⏳ HybridConnectionManager: Migration already in progress, skipping`);
      return;
    }
    
    // Task 4.4: Determine the path type based on whether it's IPv6
    const pathType = this._webrtcIsIPv6 ? PathType.IPV6_DIRECT : PathType.WEBRTC_DIRECT;
    const pathName = this._webrtcIsIPv6 ? 'IPv6' : 'WebRTC';
    
    // Task 4.5: Log path upgrade for debugging
    Logger.path(`⬆️ UPGRADE_START peer=${this.peerId?.substring(0, 8)} from=relay to=${pathName.toLowerCase()} pathType=${pathType} isIPv6=${this._webrtcIsIPv6}`);
    
    console.log(`⬆️ HybridConnectionManager: Upgrading from relay to ${pathName} for ${this.peerId.substring(0, 8)}...`);
    
    // Task 4.5: Start transparent path migration
    this._startPathMigration('relay', 'webrtc', pathType, pathName);
  }
  
  /**
   * Start transparent path migration from one transport to another
   * Task 4.5: Implements brief dual-send period during migration to prevent message loss
   * 
   * Migration process:
   * 1. Enter dual-send mode: send messages on BOTH old and new paths
   * 2. Wait for upgradeDelay to ensure new path is stable
   * 3. Send migration confirmation message on new path
   * 4. Wait for confirmation acknowledgment (or timeout)
   * 5. Exit dual-send mode and switch to new path exclusively
   * 6. Keep old path as backup (don't close it)
   * 
   * @param {string} fromTransport - Current transport ('relay' or 'webrtc')
   * @param {string} toTransport - Target transport ('relay' or 'webrtc')
   * @param {string} pathType - PathTracker path type for the target
   * @param {string} pathName - Human-readable path name for logging
   * @private
   */
  _startPathMigration(fromTransport, toTransport, pathType, pathName) {
    if (this._migrationInProgress) {
      console.warn(`⚠️ HybridConnectionManager: Migration already in progress`);
      return;
    }
    
    this._migrationInProgress = true;
    this._migrationState = {
      fromTransport,
      toTransport,
      pathType,
      pathName,
      startTime: Date.now(),
      dualSendEnabled: true,
      confirmationSent: false,
      confirmationReceived: false,
      migrationId: `mig-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
    };
    
    // Task 4.5: Log path migration start for debugging
    Logger.path(`🔄 MIGRATION_START peer=${this.peerId?.substring(0, 8)} migrationId=${this._migrationState.migrationId} from=${fromTransport} to=${toTransport} pathType=${pathType} dualSend=true upgradeDelay=${this.options.upgradeDelay}ms`);
    
    console.log(`🔄 HybridConnectionManager: Starting path migration ${fromTransport} → ${toTransport} (migration ID: ${this._migrationState.migrationId.substring(0, 12)}...)`);
    
    this.emit('migrationStarted', {
      peerId: this.peerId,
      fromTransport,
      toTransport,
      pathType,
      migrationId: this._migrationState.migrationId
    });
    
    // Task 4.5: Wait for upgradeDelay to ensure new path is stable, then complete migration
    setTimeout(() => {
      this._completeMigration();
    }, this.options.upgradeDelay);
  }
  
  /**
   * Complete the path migration after dual-send period
   * Task 4.5: Sends migration confirmation and switches to new path
   * @private
   */
  async _completeMigration() {
    if (!this._migrationInProgress || !this._migrationState) {
      return;
    }
    
    const { fromTransport, toTransport, pathType, pathName, migrationId } = this._migrationState;
    
    // Verify the target transport is still available
    if (toTransport === 'webrtc' && !this.webrtcConnected) {
      console.warn(`⚠️ HybridConnectionManager: WebRTC disconnected during migration, aborting`);
      this._abortMigration('target_disconnected');
      return;
    }
    
    if (toTransport === 'relay' && !this.relayConnected) {
      console.warn(`⚠️ HybridConnectionManager: Relay disconnected during migration, aborting`);
      this._abortMigration('target_disconnected');
      return;
    }
    
    // Task 4.5: Send migration confirmation message on new path
    // This helps the peer know we've switched and can stop dual-receiving
    try {
      const confirmationMessage = {
        type: 'migration_confirm',
        migrationId,
        fromTransport,
        toTransport,
        timestamp: Date.now()
      };
      
      if (toTransport === 'webrtc' && this.webrtcManager) {
        await this.webrtcManager.sendRawMessage(this.peerId, confirmationMessage);
        this._migrationState.confirmationSent = true;
        console.log(`📤 HybridConnectionManager: Sent migration confirmation via ${pathName}`);
      } else if (toTransport === 'relay' && this.relaySession && this.relayManager) {
        await this.relayManager.sendThroughRelay(this.relaySession.sessionId, confirmationMessage);
        this._migrationState.confirmationSent = true;
        console.log(`📤 HybridConnectionManager: Sent migration confirmation via relay`);
      }
    } catch (error) {
      Logger.path(`⚠️ MIGRATION_CONFIRM_FAILED peer=${this.peerId?.substring(0, 8)} migrationId=${migrationId} error=${error.message}`);
      console.warn(`⚠️ HybridConnectionManager: Failed to send migration confirmation: ${error.message}`);
      // Continue with migration anyway - confirmation is optional
    }
    
    // Task 4.5: Switch to new transport
    this.activeTransport = toTransport;
    this._migrationState.dualSendEnabled = false;
    
    // Task 5.4: Update path time tracking for the new path
    this._startPathTimeTracking(pathType);
    
    // Task 4.4: Update PathTracker active path
    if (this.pathTracker) {
      this.pathTracker.setActivePath(pathType);
    }
    
    const duration = Date.now() - this._migrationState.startTime;
    
    // Task 4.5: Log path migration completion for debugging
    Logger.path(`✅ MIGRATION_COMPLETE peer=${this.peerId?.substring(0, 8)} migrationId=${migrationId} from=${fromTransport} to=${toTransport} pathType=${pathType} duration=${duration}ms isIPv6=${this._webrtcIsIPv6}`);
    
    console.log(`✅ HybridConnectionManager: Migration complete ${fromTransport} → ${toTransport} in ${duration}ms`);
    
    this.emit('transportUpgraded', {
      peerId: this.peerId,
      from: fromTransport,
      to: toTransport === 'webrtc' ? pathName.toLowerCase() : 'relay',
      fromPath: fromTransport === 'relay' ? PathType.WEBSOCKET_RELAY : (this._webrtcIsIPv6 ? PathType.IPV6_DIRECT : PathType.WEBRTC_DIRECT),
      toPath: pathType,
      isIPv6: this._webrtcIsIPv6,
      migrationId,
      duration,
      timestamp: Date.now()
    });
    
    // Task 4.6: Emit pathChanged event for unified path change monitoring
    // This provides a single event type that captures all path changes (upgrades, downgrades, switches)
    this.emit('pathChanged', {
      peerId: this.peerId,
      changeType: 'upgrade',
      fromPath: fromTransport === 'relay' ? PathType.WEBSOCKET_RELAY : (this._webrtcIsIPv6 ? PathType.IPV6_DIRECT : PathType.WEBRTC_DIRECT),
      toPath: pathType,
      fromTransport,
      toTransport: toTransport === 'webrtc' ? pathName.toLowerCase() : 'relay',
      isIPv6: this._webrtcIsIPv6,
      migrationId,
      duration,
      timestamp: Date.now()
    });
    
    // Task 5.4: Log path upgrade event with timestamp to history
    this._logPathEvent({
      eventType: 'upgrade',
      fromPath: fromTransport === 'relay' ? PathType.WEBSOCKET_RELAY : (this._webrtcIsIPv6 ? PathType.IPV6_DIRECT : PathType.WEBRTC_DIRECT),
      toPath: pathType,
      fromTransport,
      toTransport: toTransport === 'webrtc' ? pathName.toLowerCase() : 'relay',
      reason: 'better_path_available',
      duration,
      metadata: {
        migrationId,
        isIPv6: this._webrtcIsIPv6
      }
    });
    
    this.emit('migrationCompleted', {
      peerId: this.peerId,
      fromTransport,
      toTransport,
      pathType,
      migrationId,
      duration
    });
    
    // Task 4.5: Store the old transport info for potential closure
    const oldTransportInfo = {
      transport: fromTransport,
      migrationId,
      completedAt: Date.now()
    };
    
    // Clean up migration state
    this._migrationInProgress = false;
    this._migrationState = null;
    
    // Task 5.3: Restart keep-alive timer for the new transport
    // The keep-alive interval and behavior may differ between transports
    this._restartKeepAlive();
    
    // Task 5.3: Restart warm backup paths timer since backup paths have changed
    this._restartWarmBackupPaths();
    
    // Task 4.5: Schedule old path closure after grace period
    // This allows time for the migration ack to be received and ensures stability
    if (this.options.closeOldPathAfterMigration) {
      Logger.path(`⏳ OLD_PATH_CLOSURE_SCHEDULED peer=${this.peerId?.substring(0, 8)} oldPath=${fromTransport} delay=${this.options.oldPathCloseDelay}ms`);
      console.log(`⏳ HybridConnectionManager: Scheduling old path (${fromTransport}) closure in ${this.options.oldPathCloseDelay}ms`);
      
      this._oldPathCloseTimer = setTimeout(() => {
        this._closeOldPath(oldTransportInfo);
      }, this.options.oldPathCloseDelay);
    } else {
      Logger.path(`🔄 OLD_PATH_KEPT peer=${this.peerId?.substring(0, 8)} oldPath=${fromTransport} reason=backup_for_failover`);
      console.log(`🔄 HybridConnectionManager: Keeping old path (${fromTransport}) as backup for failover`);
    }
  }
  
  /**
   * Abort an in-progress migration
   * Task 4.5: Handles migration failures gracefully
   * @param {string} reason - Reason for aborting
   * @private
   */
  _abortMigration(reason) {
    if (!this._migrationInProgress || !this._migrationState) {
      return;
    }
    
    const { fromTransport, toTransport, migrationId, startTime } = this._migrationState;
    const duration = Date.now() - startTime;
    
    // Task 4.5: Log migration abort for debugging
    Logger.path(`❌ MIGRATION_ABORTED peer=${this.peerId?.substring(0, 8)} migrationId=${migrationId} from=${fromTransport} to=${toTransport} reason=${reason} duration=${duration}ms`);
    
    console.warn(`⚠️ HybridConnectionManager: Migration aborted: ${reason}`);
    
    // Task 4.5: Cancel any pending old path closure since migration failed
    this._cancelOldPathClosure();
    
    this.emit('migrationAborted', {
      peerId: this.peerId,
      fromTransport,
      toTransport,
      migrationId,
      reason
    });
    
    // Stay on the original transport
    this._migrationInProgress = false;
    this._migrationState = null;
  }
  
  /**
   * Handle incoming migration confirmation message
   * Task 4.5: Acknowledges that peer has completed migration
   * @param {Object} message - Migration confirmation message
   * @private
   */
  _handleMigrationConfirm(message) {
    const { migrationId, fromTransport, toTransport, timestamp } = message;
    
    console.log(`📥 HybridConnectionManager: Received migration confirmation from ${this.peerId?.substring(0, 8)}... (${fromTransport} → ${toTransport})`);
    
    // Send acknowledgment back
    const ackMessage = {
      type: 'migration_ack',
      migrationId,
      timestamp: Date.now()
    };
    
    // Send ack on the same transport the confirmation came on
    if (this.activeTransport === 'webrtc' && this.webrtcManager) {
      this.webrtcManager.sendRawMessage(this.peerId, ackMessage).catch(err => {
        console.warn(`⚠️ Failed to send migration ack via WebRTC: ${err.message}`);
      });
    } else if (this.activeTransport === 'relay' && this.relaySession && this.relayManager) {
      this.relayManager.sendThroughRelay(this.relaySession.sessionId, ackMessage).catch(err => {
        console.warn(`⚠️ Failed to send migration ack via relay: ${err.message}`);
      });
    }
    
    this.emit('peerMigrationConfirmed', {
      peerId: this.peerId,
      migrationId,
      fromTransport,
      toTransport
    });
  }
  
  /**
   * Handle incoming migration acknowledgment message
   * Task 4.5: Confirms peer received our migration confirmation
   * @param {Object} message - Migration acknowledgment message
   * @private
   */
  _handleMigrationAck(message) {
    const { migrationId, timestamp } = message;
    
    console.log(`📥 HybridConnectionManager: Received migration ack from ${this.peerId?.substring(0, 8)}...`);
    
    // If we're still in migration and this is for our migration, mark confirmation received
    if (this._migrationState && this._migrationState.migrationId === migrationId) {
      this._migrationState.confirmationReceived = true;
    }
    
    this.emit('migrationAckReceived', {
      peerId: this.peerId,
      migrationId
    });
  }
  
  /**
   * Close the old transport path after migration is confirmed
   * Task 4.5: Closes old path after migration to free up resources
   * 
   * This is called after a grace period following migration completion.
   * It closes the old transport (relay or WebRTC) that is no longer the active path.
   * 
   * @param {Object} oldTransportInfo - Info about the old transport to close
   * @param {string} oldTransportInfo.transport - The transport type ('relay' or 'webrtc')
   * @param {string} oldTransportInfo.migrationId - The migration ID for logging
   * @param {number} oldTransportInfo.completedAt - When the migration completed
   * @private
   */
  _closeOldPath(oldTransportInfo) {
    const { transport, migrationId, completedAt } = oldTransportInfo;
    
    // Safety check: don't close if it's now the active transport (failover may have occurred)
    if (this.activeTransport === transport) {
      Logger.path(`⚠️ OLD_PATH_CLOSE_SKIPPED peer=${this.peerId?.substring(0, 8)} transport=${transport} migrationId=${migrationId} reason=now_active`);
      console.log(`⚠️ HybridConnectionManager: Skipping old path closure - ${transport} is now active (failover occurred)`);
      this.emit('oldPathCloseSkipped', {
        peerId: this.peerId,
        transport,
        migrationId,
        reason: 'now_active'
      });
      return;
    }
    
    // Safety check: don't close if we're disconnected
    if (this.connectionState !== 'connected') {
      Logger.path(`⚠️ OLD_PATH_CLOSE_SKIPPED peer=${this.peerId?.substring(0, 8)} transport=${transport} migrationId=${migrationId} reason=not_connected connectionState=${this.connectionState}`);
      console.log(`⚠️ HybridConnectionManager: Skipping old path closure - connection state is ${this.connectionState}`);
      this.emit('oldPathCloseSkipped', {
        peerId: this.peerId,
        transport,
        migrationId,
        reason: 'not_connected'
      });
      return;
    }
    
    // Safety check: don't close if a new migration is in progress
    if (this._migrationInProgress) {
      Logger.path(`⚠️ OLD_PATH_CLOSE_SKIPPED peer=${this.peerId?.substring(0, 8)} transport=${transport} migrationId=${migrationId} reason=migration_in_progress`);
      console.log(`⚠️ HybridConnectionManager: Skipping old path closure - new migration in progress`);
      this.emit('oldPathCloseSkipped', {
        peerId: this.peerId,
        transport,
        migrationId,
        reason: 'migration_in_progress'
      });
      return;
    }
    
    const gracePeriod = Date.now() - completedAt;
    
    // Task 4.5: Log old path closure for debugging
    Logger.path(`🗑️ OLD_PATH_CLOSED peer=${this.peerId?.substring(0, 8)} transport=${transport} migrationId=${migrationId} gracePeriod=${gracePeriod}ms`);
    
    console.log(`🗑️ HybridConnectionManager: Closing old path (${transport}) after ${gracePeriod}ms grace period`);
    
    if (transport === 'relay') {
      this._closeRelayPath(migrationId);
    } else if (transport === 'webrtc') {
      this._closeWebRTCPath(migrationId);
    }
    
    this.emit('oldPathClosed', {
      peerId: this.peerId,
      transport,
      migrationId,
      gracePeriod
    });
  }
  
  /**
   * Close the relay path (used after upgrading to WebRTC)
   * Task 4.5: Closes relay session to free up relay node resources
   * @param {string} migrationId - The migration ID for logging
   * @private
   */
  _closeRelayPath(migrationId) {
    if (!this.relaySession) {
      console.log(`🔄 HybridConnectionManager: No relay session to close`);
      return;
    }
    
    const sessionId = this.relaySession.sessionId;
    console.log(`🗑️ HybridConnectionManager: Closing relay session ${sessionId?.substring(0, 8)}... (migration: ${migrationId?.substring(0, 12)}...)`);
    
    // Close the relay session via RelayManager
    if (this.relayManager) {
      try {
        this.relayManager.closeSession(sessionId, 'migration_complete');
      } catch (error) {
        console.warn(`⚠️ HybridConnectionManager: Error closing relay session: ${error.message}`);
      }
    }
    
    // Update local state
    this.relaySession = null;
    this.relayConnected = false;
    
    // Update PathTracker
    if (this.pathTracker) {
      this.pathTracker.setPathState(PathType.WEBSOCKET_RELAY, PathState.CLOSED, 'migration_complete');
    }
    
    this.emit('relayPathClosed', {
      peerId: this.peerId,
      sessionId,
      migrationId,
      reason: 'migration_complete'
    });
  }
  
  /**
   * Close the WebRTC path (used after downgrading to relay)
   * Task 4.5: Closes WebRTC connection to free up resources
   * @param {string} migrationId - The migration ID for logging
   * @private
   */
  async _closeWebRTCPath(migrationId) {
    if (!this.webrtcManager) {
      console.log(`🔄 HybridConnectionManager: No WebRTC manager to close`);
      return;
    }
    
    console.log(`🗑️ HybridConnectionManager: Closing WebRTC connection (migration: ${migrationId?.substring(0, 12)}...)`);
    
    try {
      // Destroy the WebRTC manager
      await this.webrtcManager.destroy();
    } catch (error) {
      console.warn(`⚠️ HybridConnectionManager: Error closing WebRTC connection: ${error.message}`);
    }
    
    // Update local state
    this.webrtcManager = null;
    this.webrtcConnected = false;
    this._webrtcIsIPv6 = false;
    this._selectedCandidatePair = null;
    
    // Update PathTracker
    if (this.pathTracker) {
      this.pathTracker.setPathState(PathType.WEBRTC_DIRECT, PathState.CLOSED, 'migration_complete');
      this.pathTracker.setPathState(PathType.IPV6_DIRECT, PathState.CLOSED, 'migration_complete');
    }
    
    this.emit('webrtcPathClosed', {
      peerId: this.peerId,
      migrationId,
      reason: 'migration_complete'
    });
  }
  
  /**
   * Cancel any pending old path closure
   * Task 4.5: Used when failover occurs or connection is destroyed
   * @private
   */
  _cancelOldPathClosure() {
    if (this._oldPathCloseTimer) {
      clearTimeout(this._oldPathCloseTimer);
      this._oldPathCloseTimer = null;
      console.log(`🔄 HybridConnectionManager: Cancelled pending old path closure`);
    }
  }

  /**
   * Check if dual-send mode is active (during migration)
   * Task 4.5: Used by sendRawMessage to determine if messages should be sent on both paths
   * @returns {boolean} True if dual-send is active
   */
  isDualSendActive() {
    return this._migrationInProgress && 
           this._migrationState && 
           this._migrationState.dualSendEnabled;
  }

  /**
   * Downgrade from WebRTC to relay when direct path fails
   * Task 4.4: Handles both IPv6 and IPv4 WebRTC connections
   * Task 4.5: Uses immediate switch (no dual-send) since WebRTC is failing
   * Task 4.6: Emits comprehensive path change events for monitoring
   * @private
   */
  _downgradeToRelay() {
    if (!this.relayConnected || this.activeTransport === 'relay') {
      return;
    }
    
    const downgradeStartTime = Date.now();
    
    // Task 4.5: Cancel any pending old path closure (we need the relay now!)
    this._cancelOldPathClosure();
    
    // If migration is in progress, abort it
    if (this._migrationInProgress) {
      this._abortMigration('webrtc_failed_during_migration');
    }
    
    const pathName = this._webrtcIsIPv6 ? 'IPv6' : 'WebRTC';
    const fromPathType = this._webrtcIsIPv6 ? PathType.IPV6_DIRECT : PathType.WEBRTC_DIRECT;
    
    // Task 4.5: Log path downgrade for debugging
    Logger.path(`⬇️ DOWNGRADE_START peer=${this.peerId?.substring(0, 8)} from=${pathName.toLowerCase()} to=relay wasIPv6=${this._webrtcIsIPv6} reason=webrtc_failed`);
    
    console.log(`⬇️ HybridConnectionManager: Downgrading from ${pathName} to relay for ${this.peerId.substring(0, 8)}...`);
    
    // Task 4.6: Emit pathDowngradeStarted event for monitoring
    this.emit('pathDowngradeStarted', {
      peerId: this.peerId,
      fromPath: fromPathType,
      toPath: PathType.WEBSOCKET_RELAY,
      fromTransport: pathName.toLowerCase(),
      toTransport: 'relay',
      wasIPv6: this._webrtcIsIPv6,
      reason: 'webrtc_failed',
      timestamp: downgradeStartTime
    });
    
    // Task 4.5: Immediate switch for downgrade (no dual-send since WebRTC is failing)
    // This is different from upgrade where we want to ensure no message loss
    this.activeTransport = 'relay';
    
    // Task 5.4: Update path time tracking for relay
    this._startPathTimeTracking(PathType.WEBSOCKET_RELAY);
    
    // Task 4.1: Update PathTracker active path
    if (this.pathTracker) {
      this.pathTracker.setActivePath(PathType.WEBSOCKET_RELAY);
    }
    
    const downgradeDuration = Date.now() - downgradeStartTime;
    
    // Task 4.6: Emit comprehensive transportDowngraded event with timing info
    this.emit('transportDowngraded', {
      peerId: this.peerId,
      from: pathName.toLowerCase(),
      to: 'relay',
      fromPath: fromPathType,
      toPath: PathType.WEBSOCKET_RELAY,
      wasIPv6: this._webrtcIsIPv6,
      reason: 'webrtc_failed',
      duration: downgradeDuration,
      timestamp: Date.now()
    });
    
    // Task 4.6: Emit pathChanged event for unified path change monitoring
    // This provides a single event type that captures all path changes (upgrades, downgrades, switches)
    this.emit('pathChanged', {
      peerId: this.peerId,
      changeType: 'downgrade',
      fromPath: fromPathType,
      toPath: PathType.WEBSOCKET_RELAY,
      fromTransport: pathName.toLowerCase(),
      toTransport: 'relay',
      wasIPv6: this._webrtcIsIPv6,
      reason: 'webrtc_failed',
      duration: downgradeDuration,
      timestamp: Date.now()
    });
    
    // Task 5.4: Log path downgrade event with timestamp to history
    this._logPathEvent({
      eventType: 'downgrade',
      fromPath: fromPathType,
      toPath: PathType.WEBSOCKET_RELAY,
      fromTransport: pathName.toLowerCase(),
      toTransport: 'relay',
      reason: 'webrtc_failed',
      duration: downgradeDuration,
      metadata: {
        wasIPv6: this._webrtcIsIPv6
      }
    });
    
    // Task 4.5: Log path downgrade completion for debugging
    Logger.path(`✅ DOWNGRADE_COMPLETE peer=${this.peerId?.substring(0, 8)} from=${pathName.toLowerCase()} to=relay duration=${downgradeDuration}ms`);
    
    console.log(`✅ HybridConnectionManager: Downgraded to relay in ${downgradeDuration}ms`);
    
    // Task 5.1: Restart background probing with shorter interval (now on relay, need to find direct path)
    this._restartBackgroundProbing();
    
    // Task 5.3: Restart keep-alive timer for the relay transport
    this._restartKeepAlive();
    
    // Task 5.3: Restart warm backup paths timer since backup paths have changed
    this._restartWarmBackupPaths();
  }

  /**
   * Handle incoming WebRTC signal
   * @param {string} peerId - Peer ID
   * @param {Object} signal - WebRTC signal (offer/answer/candidate)
   */
  async handleSignal(peerId, signal) {
    if (this.webrtcManager) {
      await this.webrtcManager.handleSignal(peerId, signal);
    }
  }

  /**
   * Handle synchronized ICE start signal (Task 4.2: Coordinated ICE timing)
   * 
   * This is called when both peers have sent ice_coordinate requests and the
   * bootstrap server is telling us to start ICE probing at a synchronized time.
   * Both peers start ICE probing at exactly the same time, causing packets to
   * cross in flight and open both firewalls simultaneously.
   * 
   * @param {Object} data - ICE start data
   * @param {string} data.peerId - The peer we're coordinating with
   * @param {Array} data.peerCandidates - Peer's ICE candidates to add
   * @param {Object} data.peerProfile - Peer's connection profile (NAT type, etc.)
   * @param {string} data.sessionId - Session ID for tracking
   * @param {boolean} data.hardNatPair - Task 4.3: Whether both peers have hard NAT
   * @param {boolean} data.shouldAttemptCoordinatedRestart - Task 4.3: Whether to attempt coordinated ICE restart on failure
   * @param {number} data.estimatedSuccessRate - Task 4.3: Estimated success rate for direct connection
   */
  async handleIceStart(data) {
    const { peerId, peerCandidates, peerProfile, sessionId, hardNatPair, shouldAttemptCoordinatedRestart, estimatedSuccessRate } = data;
    
    console.log(`❄️ [Hybrid] Synchronized ICE start for ${peerId?.substring(0, 8)}...`);
    
    // Task 4.3: Store hard NAT detection result for later use (coordinated ICE restart)
    if (hardNatPair !== undefined) {
      this._hardNatPairDetected = hardNatPair;
      this._shouldAttemptCoordinatedRestart = shouldAttemptCoordinatedRestart;
      this._estimatedSuccessRate = estimatedSuccessRate;
      
      if (hardNatPair) {
        console.log(`🔒 [Hybrid] Hard NAT pair detected with ${peerId?.substring(0, 8)}...`);
        console.log(`   → Estimated success rate: ${(estimatedSuccessRate * 100).toFixed(0)}%`);
        console.log(`   → Will attempt coordinated ICE restart if initial ICE fails: ${shouldAttemptCoordinatedRestart}`);
        
        // Emit event so other components can react
        this.emit('hardNatPairDetected', {
          peerId,
          hardNatPair,
          shouldAttemptCoordinatedRestart,
          estimatedSuccessRate,
          peerProfile
        });
      }
    }
    
    // Forward to WebRTC manager if available
    if (this.webrtcManager && this.webrtcManager.handleIceStart) {
      await this.webrtcManager.handleIceStart(data);
    } else if (this.webrtcManager) {
      // WebRTC manager exists but doesn't have handleIceStart - add candidates directly
      console.log(`❄️ [Hybrid] WebRTC manager doesn't have handleIceStart, adding candidates directly`);
      
      if (peerCandidates && peerCandidates.length > 0) {
        for (const candidate of peerCandidates) {
          try {
            await this.webrtcManager.handleSignal(peerId, {
              type: 'candidate',
              candidate: candidate.candidate || candidate,
              sdpMLineIndex: candidate.sdpMLineIndex || 0,
              sdpMid: candidate.sdpMid || '0'
            });
          } catch (error) {
            console.warn(`❄️ [Hybrid] Failed to add candidate: ${error.message}`);
          }
        }
      }
    } else {
      console.warn(`❄️ [Hybrid] No WebRTC manager available for synchronized ICE start`);
      // Emit event so other components can handle it
      this.emit('iceStartFailed', { peerId, reason: 'no_webrtc_manager', sessionId });
    }
  }

  /**
   * Check if this connection has a hard NAT pair detected
   * Task 4.3: Used to determine if coordinated ICE restart should be attempted
   * @returns {boolean} True if both peers have hard NAT
   */
  isHardNatPair() {
    return this._hardNatPairDetected === true;
  }

  /**
   * Check if this connection is using IPv6
   * Task 4.4: Used to determine path type for logging and metrics
   * @returns {boolean} True if the WebRTC connection is using IPv6
   */
  isIPv6Connection() {
    return this._webrtcIsIPv6 === true;
  }

  /**
   * Get the selected ICE candidate pair info
   * Task 4.4: Used for debugging and metrics
   * @returns {Object|null} The selected candidate pair or null
   */
  getSelectedCandidatePair() {
    return this._selectedCandidatePair || null;
  }

  /**
   * Get the current path type being used
   * Task 4.4: Returns the active path type (ipv6-direct, webrtc-direct, or websocket-relay)
   * @returns {string|null} The active path type or null if not connected
   */
  getActivePathType() {
    if (!this.pathTracker) return null;
    return this.pathTracker.getActivePathType();
  }

  /**
   * Check if coordinated ICE restart should be attempted for this connection
   * Task 4.3: Used when initial ICE fails to decide whether to try coordinated restart
   * @returns {boolean} True if coordinated restart is recommended
   */
  shouldAttemptCoordinatedRestart() {
    return this._shouldAttemptCoordinatedRestart === true;
  }

  /**
   * Restart ICE for the WebRTC connection (Task 4.3: Coordinated ICE restart for hard NAT pairs)
   * 
   * This is called when the bootstrap server sends ice_restart_go to both peers.
   * It forwards the restart request to the WebRTC manager.
   * 
   * @param {Object} options - Restart options
   * @param {string} options.peerId - The peer we're restarting ICE with
   * @param {string} options.sessionId - Session ID for tracking
   * @returns {Promise<boolean>} True if restart was initiated successfully
   */
  async restartIce(options = {}) {
    const { peerId, sessionId } = options;
    
    if (!this.webrtcManager) {
      console.warn(`❄️ [Hybrid] Cannot restart ICE - no WebRTC manager`);
      this.emit('iceRestartFailed', { peerId, reason: 'no_webrtc_manager', sessionId });
      return false;
    }
    
    console.log(`❄️ [Hybrid] Forwarding ICE restart to WebRTC manager for ${peerId?.substring(0, 8)}...`);
    return await this.webrtcManager.restartIce(options);
  }

  /**
   * Get the estimated success rate for direct connection
   * Task 4.3: Used for logging and decision making
   * @returns {number} Estimated success rate (0-1)
   */
  getEstimatedSuccessRate() {
    return this._estimatedSuccessRate || 0.8;
  }

  /**
   * Send a message to the peer using the best available transport
   * Task 3.3: Browser sends to peer → check if relay path exists, use it
   * Task 4.5: Implements dual-send during migration to prevent message loss
   * Task 5.1: Track traffic time for NAT mapping timeout handling
   * @param {string} peerId - Target peer ID
   * @param {Object} message - Message to send
   */
  async sendRawMessage(peerId, message) {
    if (this.isDestroyed) {
      throw new Error('HybridConnectionManager is destroyed');
    }
    
    // Queue message if not yet connected
    if (this.connectionState !== 'connected') {
      this.messageQueue.push({ peerId, message });
      return;
    }
    
    // Task 4.5: During migration, send on BOTH paths to prevent message loss
    if (this.isDualSendActive()) {
      await this._sendDualPath(peerId, message);
      return;
    }
    
    // Use the active transport
    if (this.activeTransport === 'webrtc' && this.webrtcConnected && this.webrtcManager) {
      try {
        await this.webrtcManager.sendRawMessage(peerId, message);
        // Task 5.1: Track traffic time for NAT mapping timeout handling
        this._updateTrafficTime('webrtc');
        return;
      } catch (error) {
        console.warn(`⚠️ WebRTC send failed, falling back to relay:`, error.message);
        // Fall through to relay
      }
    }
    
    // Use our own relay session if available
    if (this.relayConnected && this.relaySession) {
      try {
        await this.relayManager.sendThroughRelay(this.relaySession.sessionId, message);
        // Task 5.1: Track traffic time for NAT mapping timeout handling
        this._updateTrafficTime('relay');
        return;
      } catch (error) {
        console.error(`❌ Relay send failed:`, error.message);
        // Fall through to check for other relay paths
      }
    }
    
    // Task 3.3: Check if RelayManager has an existing relay path to this peer
    // This handles cases where another component established a relay session
    if (this.relayManager) {
      const existingSession = this.relayManager.getActiveSessionForPeer(peerId);
      if (existingSession) {
        console.log(`🔄 HybridConnectionManager: Using existing relay session ${existingSession.sessionId.substring(0, 8)}... for ${peerId.substring(0, 8)}...`);
        try {
          await this.relayManager.sendThroughRelay(existingSession.sessionId, message);
          // Update our local state to use this session
          this.relaySession = {
            sessionId: existingSession.sessionId,
            relayNodeId: existingSession.relayNodeId,
            state: 'active',
            createdAt: existingSession.createdAt,
            lastActivity: Date.now()
          };
          this.relayConnected = true;
          return;
        } catch (error) {
          console.error(`❌ Existing relay session send failed:`, error.message);
          throw error;
        }
      }
    }
    
    throw new Error('No transport available for sending message');
  }
  
  /**
   * Send a message on both paths during migration (dual-send mode)
   * Task 4.5: Ensures no message loss during path migration
   * 
   * During migration, we send on both the old and new paths. The receiver
   * should deduplicate messages (using message IDs if present). This ensures
   * that even if one path has issues, the message gets through on the other.
   * 
   * @param {string} peerId - Target peer ID
   * @param {Object} message - Message to send
   * @private
   */
  async _sendDualPath(peerId, message) {
    const errors = [];
    let sentOnAnyPath = false;
    
    // Add migration marker to help receiver deduplicate
    const messageWithMarker = {
      ...message,
      _migrationId: this._migrationState?.migrationId,
      _dualSend: true
    };
    
    // Send on WebRTC if available
    if (this.webrtcConnected && this.webrtcManager) {
      try {
        await this.webrtcManager.sendRawMessage(peerId, messageWithMarker);
        sentOnAnyPath = true;
        console.log(`📤 HybridConnectionManager: Dual-send via WebRTC`);
      } catch (error) {
        errors.push({ transport: 'webrtc', error: error.message });
        console.warn(`⚠️ Dual-send WebRTC failed: ${error.message}`);
      }
    }
    
    // Send on relay if available
    if (this.relayConnected && this.relaySession && this.relayManager) {
      try {
        await this.relayManager.sendThroughRelay(this.relaySession.sessionId, messageWithMarker);
        sentOnAnyPath = true;
        console.log(`📤 HybridConnectionManager: Dual-send via relay`);
      } catch (error) {
        errors.push({ transport: 'relay', error: error.message });
        console.warn(`⚠️ Dual-send relay failed: ${error.message}`);
      }
    }
    
    if (!sentOnAnyPath) {
      throw new Error(`Dual-send failed on all paths: ${errors.map(e => `${e.transport}: ${e.error}`).join(', ')}`);
    }
    
    // Log if only one path succeeded
    if (errors.length > 0) {
      console.log(`📤 HybridConnectionManager: Dual-send partial success (${errors.length} path(s) failed)`);
    }
  }

  /**
   * Flush queued messages after connection is established
   * @private
   */
  async _flushMessageQueue() {
    if (this.messageQueue.length === 0) {
      return;
    }
    
    console.log(`📤 HybridConnectionManager: Flushing ${this.messageQueue.length} queued messages`);
    
    const queue = [...this.messageQueue];
    this.messageQueue = [];
    
    for (const { peerId, message } of queue) {
      try {
        await this.sendRawMessage(peerId, message);
      } catch (error) {
        console.error(`❌ Failed to send queued message:`, error.message);
      }
    }
  }

  /**
   * Check if connected via any transport
   * @returns {boolean}
   */
  isConnected() {
    return this.connectionState === 'connected' && 
           (this.relayConnected || this.webrtcConnected);
  }

  /**
   * Check if a relay path exists to the peer
   * Task 3.3: Maintain mapping of peerId → relay session
   * @returns {boolean} True if a relay path exists (either our own session or via RelayManager)
   */
  hasRelayPath() {
    // Check our own relay session
    if (this.relayConnected && this.relaySession) {
      return true;
    }
    
    // Check RelayManager for existing sessions to this peer
    if (this.relayManager && this.peerId) {
      return this.relayManager.hasRelayPath(this.peerId);
    }
    
    return false;
  }

  /**
   * Get the relay session for this peer (if one exists)
   * Task 3.3: Maintain mapping of peerId → relay session
   * @returns {Object|null} Relay session or null
   */
  getRelaySession() {
    // Return our own session if available
    if (this.relaySession) {
      return this.relaySession;
    }
    
    // Check RelayManager for existing sessions to this peer
    if (this.relayManager && this.peerId) {
      return this.relayManager.getActiveSessionForPeer(this.peerId);
    }
    
    return null;
  }

  /**
   * Get the current active transport type
   * @returns {string|null} 'relay' | 'webrtc' | null
   */
  getActiveTransport() {
    return this.activeTransport;
  }

  /**
   * Get connection metrics
   * @returns {Object}
   */
  getMetrics() {
    const metrics = {
      peerId: this.peerId,
      connectionState: this.connectionState,
      activeTransport: this.activeTransport,
      relayConnected: this.relayConnected,
      webrtcConnected: this.webrtcConnected,
      connectionDuration: this.connectionStartTime ? Date.now() - this.connectionStartTime : null,
      relayEstablishTime: this.relayEstablishedTime ? this.relayEstablishedTime - this.connectionStartTime : null,
      webrtcEstablishTime: this.webrtcEstablishedTime ? this.webrtcEstablishedTime - this.connectionStartTime : null,
      // Task 4.5: Include migration state
      migrationInProgress: this._migrationInProgress || false,
      migrationState: this._migrationState ? {
        fromTransport: this._migrationState.fromTransport,
        toTransport: this._migrationState.toTransport,
        dualSendEnabled: this._migrationState.dualSendEnabled,
        duration: Date.now() - this._migrationState.startTime
      } : null,
      // Task 4.6: Include consecutive failure counts for path health monitoring
      consecutiveFailures: this._consecutiveFailures ? Object.fromEntries(this._consecutiveFailures) : {},
      pathProbingScheduled: this._pathProbingScheduled || false,
      // Task 4.6: Include WebRTC reconnection state for monitoring
      webrtcReconnection: {
        inProgress: this._webrtcReconnectionInProgress || false,
        attempts: this._webrtcReconnectAttempts || 0,
        coordinatedRestartAttempted: this._coordinatedRestartAttempted || false
      },
      // Task 5.1: Include background probing status
      backgroundProbing: this.getBackgroundProbingStatus(),
      // Task 5.1: Include NAT state check status
      natStateCheck: this.getNatStateCheckStatus(),
      // Task 5.1: Include NAT mapping timeout status
      natMappingStatus: this.getNatMappingStatus(),
      // Task 5.3: Include keep-alive status
      keepAlive: this.getKeepAliveStatus(),
      // Task 5.3: Include warm backup paths status
      warmBackupPaths: this.getWarmBackupPathsStatus()
    };
    
    // Task 4.1: Include PathTracker stats
    if (this.pathTracker) {
      metrics.paths = this.pathTracker.getStats();
      metrics.pathSummary = this.pathTracker.getSummary();
    }
    
    // Task 5.4: Include path time statistics
    metrics.pathTimeStats = this.getPathTimeStats();
    
    return metrics;
  }

  /**
   * Get consecutive failure count for a specific path
   * Task 4.6: Expose failure count for monitoring
   * @param {string} pathType - The path type to check
   * @returns {number} Number of consecutive failures
   */
  getConsecutiveFailures(pathType) {
    if (!this._consecutiveFailures) return 0;
    return this._consecutiveFailures.get(pathType) || 0;
  }

  /**
   * Get the PathTracker for this connection
   * Task 4.1: Expose PathTracker for external monitoring
   * @returns {PathTracker|null}
   */
  getPathTracker() {
    return this.pathTracker;
  }

  /**
   * Measure RTT to the peer through the relay path
   * Task 4.4: Add RTT measurement to relay path (ping/pong through relay)
   * 
   * This sends a ping through the relay and measures the round-trip time.
   * The measurement is recorded in the PathTracker for path quality comparison.
   * 
   * @returns {Promise<number|null>} RTT in milliseconds, or null if measurement failed
   */
  async measureRelayRtt() {
    if (!this.relayConnected || !this.relaySession || !this.relayManager) {
      console.warn(`⚠️ HybridConnectionManager: Cannot measure relay RTT - no relay connection`);
      return null;
    }
    
    if (!this.pathTracker) {
      console.warn(`⚠️ HybridConnectionManager: Cannot measure relay RTT - no PathTracker`);
      return null;
    }
    
    return new Promise((resolve) => {
      const { pingId, sentAt } = this.pathTracker.startMeasurement(PathType.WEBSOCKET_RELAY);
      
      // Store pingId for when pong arrives
      this._pendingPathPings = this._pendingPathPings || new Map();
      
      // Set up timeout
      const timeoutId = setTimeout(() => {
        const pending = this._pendingPathPings.get(pingId);
        if (pending) {
          this._pendingPathPings.delete(pingId);
          if (this.pathTracker) {
            this.pathTracker.recordMeasurementFailure(PathType.WEBSOCKET_RELAY, 'timeout');
          }
          console.warn(`⚠️ HybridConnectionManager: Relay RTT measurement timed out`);
          resolve(null);
        }
      }, 10000);
      
      // Store pending measurement with resolve callback
      this._pendingPathPings.set(pingId, { 
        pathType: PathType.WEBSOCKET_RELAY, 
        sentAt,
        sessionId: this.relaySession.sessionId,
        timeoutId,
        resolve // Store resolve to call when pong arrives
      });
      
      console.log(`📊 HybridConnectionManager: Measuring relay RTT to ${this.peerId?.substring(0, 8)}...`);
      
      // Send ping through relay
      this.relayManager.emit('sendRelayPing', {
        toPeerId: this.relaySession.relayNodeId,
        message: {
          type: 'relay_ping',
          sessionId: this.relaySession.sessionId,
          pingId,
          timestamp: sentAt,
          targetPeerId: this.peerId
        }
      });
      
      // Override _handlePathPong to resolve the promise
      const originalHandler = this._handlePathPong.bind(this);
      const wrappedHandler = (message) => {
        const pending = this._pendingPathPings?.get(message.pingId);
        if (pending && pending.resolve) {
          // Clear timeout
          if (pending.timeoutId) {
            clearTimeout(pending.timeoutId);
          }
          
          // Calculate latency
          const latency = Date.now() - pending.sentAt;
          
          // Record in PathTracker
          if (this.pathTracker) {
            this.pathTracker.completeMeasurement(message.pingId);
          }
          
          this._pendingPathPings.delete(message.pingId);
          
          console.log(`📊 HybridConnectionManager: Relay RTT measured: ${latency}ms`);
          pending.resolve(latency);
        } else {
          // Not a measurement ping, use original handler
          originalHandler(message);
        }
      };
      
      // Temporarily replace handler
      this._handlePathPong = wrappedHandler;
    });
  }

  /**
   * Get the last measured relay RTT
   * Task 4.4: Retrieve cached relay RTT measurement
   * @returns {number|null} Last measured RTT in milliseconds, or null if not measured
   */
  getRelayRtt() {
    if (!this.pathTracker) return null;
    
    const relayPath = this.pathTracker.getPath(PathType.WEBSOCKET_RELAY);
    return relayPath?.latency || null;
  }

  /**
   * Get the last measured WebRTC RTT
   * Task 4.4: Retrieve cached WebRTC RTT measurement
   * @returns {number|null} Last measured RTT in milliseconds, or null if not measured
   */
  getWebRTCRtt() {
    if (!this.pathTracker) return null;
    
    const webrtcPath = this.pathTracker.getPath(PathType.WEBRTC_DIRECT);
    return webrtcPath?.latency || null;
  }
  
  /**
   * Get detailed WebRTC RTT statistics from the keep-alive mechanism
   * Task 4.4: Retrieve comprehensive WebRTC RTT stats
   * @returns {Object|null} RTT statistics { lastRtt, avgRtt, jitter, sampleCount } or null
   */
  getWebRTCRttStats() {
    if (!this.webrtcManager) return null;
    return this.webrtcManager.getRttStats();
  }

  /**
   * Destroy the connection and clean up resources
   * @param {string} peerId - Peer ID
   * @param {string} reason - Reason for destruction
   */
  async destroyConnection(peerId, reason = 'manual') {
    if (this.isDestroyed) {
      return;
    }
    
    console.log(`🗑️ HybridConnectionManager: Destroying connection to ${peerId?.substring(0, 8) || 'unknown'}... (${reason})`);
    
    this.isDestroyed = true;
    this.connectionState = 'disconnected';
    this.activeTransport = null;
    
    // Task 4.5: Cancel any pending old path closure
    this._cancelOldPathClosure();
    
    // Task 4.5: Clean up migration state
    this._migrationInProgress = false;
    this._migrationState = null;
    
    // Task 4.5: Clean up recent messages deduplication map
    if (this._recentMessages) {
      this._recentMessages.clear();
      this._recentMessages = null;
    }
    
    // Task 4.6: Cancel any pending path probing
    this._cancelPathProbing();
    
    // Task 5.1: Stop background probing
    this._stopBackgroundProbing();
    
    // Task 5.1: Clean up NAT state check variables
    this._lastConnectionProfile = null;
    this._natStateCheckCounter = 0;
    
    // Task 5.1: Clean up NAT mapping timeout tracking
    this._lastWebRTCTrafficTime = null;
    this._lastRelayTrafficTime = null;
    if (this._natMappingCheckTimer) {
      clearInterval(this._natMappingCheckTimer);
      this._natMappingCheckTimer = null;
    }
    
    // Task 5.3: Stop keep-alive timer
    this._stopKeepAlive();
    
    // Task 5.3: Stop warm backup paths timer
    this._stopWarmBackupPaths();
    
    // Task 5.3: Clean up backup path health tracking
    if (this._backupPathHealth) {
      this._backupPathHealth.clear();
    }
    
    // Task 4.6: Clean up WebRTC reconnection state
    this._resetWebRTCReconnectionState();
    
    // Task 4.6: Clean up consecutive failure tracking
    if (this._consecutiveFailures) {
      this._consecutiveFailures.clear();
      this._consecutiveFailures = null;
    }
    
    // Unregister from RelayManager
    this._unregisterFromRelayManager();
    
    // Task 4.1: Destroy PathTracker
    if (this.pathTracker) {
      this.pathTracker.destroy();
      this.pathTracker = null;
    }
    
    // Task 5.4: Stop path time tracking and log final stats
    if (this._currentPathForTimeTracking) {
      this._stopPathTimeTracking(this._currentPathForTimeTracking);
    }
    // Log final path time stats before cleanup
    const finalStats = this.getPathTimeStats();
    Logger.path(`⏱️ PATH_TIME_FINAL peer=${peerId?.substring(0, 8)} relay=${finalStats.aggregate.relayPercentage}% direct=${finalStats.aggregate.directPercentage}% totalTime=${finalStats.totalConnectionTime}ms switches=${finalStats.totalSwitches}`);
    
    // Clear pending path pings
    if (this._pendingPathPings) {
      this._pendingPathPings.clear();
      this._pendingPathPings = null;
    }
    
    // Close relay session
    if (this.relaySession && this.relayManager) {
      try {
        this.relayManager.closeSession(this.relaySession.sessionId, reason);
      } catch (error) {
        console.warn(`⚠️ Error closing relay session:`, error.message);
      }
      this.relaySession = null;
      this.relayConnected = false;
    }
    
    // Destroy WebRTC manager
    if (this.webrtcManager) {
      try {
        await this.webrtcManager.destroy();
      } catch (error) {
        console.warn(`⚠️ Error destroying WebRTC manager:`, error.message);
      }
      this.webrtcManager = null;
      this.webrtcConnected = false;
    }
    
    // Clear message queue
    this.messageQueue = [];
    
    this.emit('disconnected', { peerId, reason });
  }

  /**
   * Alias for destroyConnection for compatibility
   */
  async destroy() {
    await this.destroyConnection(this.peerId, 'destroy');
  }

  // ============================================================================
  // Task 5.4: Path Event History - Log path upgrade/downgrade events with timestamps
  // ============================================================================

  /**
   * Log a path event to the history
   * Task 5.4: Log path upgrade/downgrade events with timestamps
   * 
   * This method records path change events in a structured format that can be
   * queried later for debugging and analysis. Each event includes:
   * - timestamp: ISO 8601 timestamp of when the event occurred
   * - eventType: Type of event (upgrade, downgrade, failover, switch)
   * - fromPath: Previous path type (or null if initial connection)
   * - toPath: New path type
   * - fromTransport: Previous transport name
   * - toTransport: New transport name
   * - reason: Why the path change occurred
   * - duration: How long the migration took (if applicable)
   * - metadata: Additional event-specific data
   * 
   * @param {Object} event - Path event data
   * @param {string} event.eventType - Type of event: 'upgrade', 'downgrade', 'failover', 'switch', 'initial'
   * @param {string|null} event.fromPath - Previous path type (PathType enum value)
   * @param {string} event.toPath - New path type (PathType enum value)
   * @param {string|null} event.fromTransport - Previous transport name
   * @param {string} event.toTransport - New transport name
   * @param {string} event.reason - Reason for the path change
   * @param {number} [event.duration] - Duration of migration in ms (optional)
   * @param {Object} [event.metadata] - Additional metadata (optional)
   * @private
   */
  _logPathEvent(event) {
    const timestamp = new Date().toISOString();
    const timestampMs = Date.now();
    
    const pathEvent = {
      timestamp,
      timestampMs,
      peerId: this.peerId,
      eventType: event.eventType,
      fromPath: event.fromPath || null,
      toPath: event.toPath,
      fromTransport: event.fromTransport || null,
      toTransport: event.toTransport,
      reason: event.reason || 'unknown',
      duration: event.duration || null,
      metadata: event.metadata || {}
    };
    
    // Add to history
    this._pathEventHistory.push(pathEvent);
    
    // Trim history if it exceeds max size
    while (this._pathEventHistory.length > this._maxPathEventHistory) {
      this._pathEventHistory.shift();
    }
    
    // Log with structured format for easy parsing
    // Format: [PATH_EVENT timestamp] eventType: fromPath → toPath (reason) [duration]
    const durationStr = pathEvent.duration ? ` [${pathEvent.duration}ms]` : '';
    const fromStr = pathEvent.fromPath || 'none';
    Logger.path(`📝 PATH_EVENT ${pathEvent.eventType.toUpperCase()} peer=${this.peerId?.substring(0, 8)} ${fromStr} → ${pathEvent.toPath} reason=${pathEvent.reason}${durationStr}`);
    
    // Emit event for external monitoring
    this.emit('pathEventLogged', pathEvent);
    
    return pathEvent;
  }

  /**
   * Get the path event history
   * Task 5.4: Provides access to logged path events for analysis
   * 
   * @param {Object} [options] - Filter options
   * @param {string} [options.eventType] - Filter by event type
   * @param {number} [options.since] - Only events after this timestamp (ms)
   * @param {number} [options.limit] - Maximum number of events to return
   * @returns {Array} Array of path events
   */
  getPathEventHistory(options = {}) {
    let events = [...this._pathEventHistory];
    
    // Filter by event type
    if (options.eventType) {
      events = events.filter(e => e.eventType === options.eventType);
    }
    
    // Filter by timestamp
    if (options.since) {
      events = events.filter(e => e.timestampMs >= options.since);
    }
    
    // Limit results
    if (options.limit && options.limit > 0) {
      events = events.slice(-options.limit);
    }
    
    return events;
  }

  /**
   * Get a summary of path events for logging/debugging
   * Task 5.4: Provides a human-readable summary of path change history
   * 
   * @returns {Object} Summary object with counts and recent events
   */
  getPathEventSummary() {
    const events = this._pathEventHistory;
    
    // Count events by type
    const countsByType = {
      upgrade: 0,
      downgrade: 0,
      failover: 0,
      switch: 0,
      initial: 0
    };
    
    for (const event of events) {
      if (countsByType[event.eventType] !== undefined) {
        countsByType[event.eventType]++;
      }
    }
    
    // Get recent events (last 5)
    const recentEvents = events.slice(-5).map(e => ({
      timestamp: e.timestamp,
      eventType: e.eventType,
      fromPath: e.fromPath,
      toPath: e.toPath,
      reason: e.reason
    }));
    
    // Calculate average migration duration for upgrades
    const upgrades = events.filter(e => e.eventType === 'upgrade' && e.duration);
    const avgUpgradeDuration = upgrades.length > 0
      ? Math.round(upgrades.reduce((sum, e) => sum + e.duration, 0) / upgrades.length)
      : null;
    
    return {
      peerId: this.peerId,
      totalEvents: events.length,
      countsByType,
      avgUpgradeDuration,
      recentEvents,
      oldestEvent: events[0]?.timestamp || null,
      newestEvent: events[events.length - 1]?.timestamp || null
    };
  }

  /**
   * Clear the path event history
   * Task 5.4: Allows resetting the history for testing or memory management
   */
  clearPathEventHistory() {
    this._pathEventHistory = [];
    Logger.path(`🗑️ PATH_EVENT_HISTORY_CLEARED peer=${this.peerId?.substring(0, 8)}`);
  }

  /**
   * Export path event history as JSON string
   * Task 5.4: Enables exporting history for external analysis
   * 
   * @returns {string} JSON string of path events
   */
  exportPathEventHistory() {
    return JSON.stringify({
      peerId: this.peerId,
      exportedAt: new Date().toISOString(),
      events: this._pathEventHistory
    }, null, 2);
  }
}
export default HybridConnectionManager;
