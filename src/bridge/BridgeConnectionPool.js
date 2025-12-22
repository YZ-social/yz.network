import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { RequestMultiplexer } from './RequestMultiplexer.js';

/**
 * Connection states for bridge connections
 */
export const ConnectionState = {
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  AUTHENTICATING: 'AUTHENTICATING',
  READY: 'READY',
  BUSY: 'BUSY',
  IDLE: 'IDLE',
  FAILED: 'FAILED'
};

/**
 * Individual bridge connection wrapper
 */
class BridgeConnection extends EventEmitter {
  constructor(bridgeAddr, authToken, options = {}) {
    super();
    
    this.bridgeAddr = bridgeAddr;
    this.authToken = authToken;
    this.options = options;
    
    // Connection state
    this.state = ConnectionState.DISCONNECTED;
    this.ws = null;
    this.lastActivity = 0;
    this.connectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
    
    // Request multiplexing
    this.multiplexer = new RequestMultiplexer({
      nodeId: this.bridgeAddr,
      defaultTimeout: this.requestTimeout,
      queue: {
        maxQueueSize: options.maxQueueSize || 50,
        maxConcurrent: options.maxConcurrent || 5
      }
    });

    // Set up multiplexer event handlers
    this.multiplexer.on('success', ({ requestId, data }) => {
      console.log(`✅ Request ${requestId.substring(0, 16)}... completed successfully`);
    });

    this.multiplexer.on('error', ({ requestId, error }) => {
      console.warn(`❌ Request ${requestId.substring(0, 16)}... failed: ${error}`);
    });

    this.multiplexer.on('responseTimeout', ({ requestId }) => {
      console.warn(`⏰ Request ${requestId.substring(0, 16)}... timed out`);
    });
    
    // Health monitoring
    this.lastPing = 0;
    this.lastPong = 0;
    this.healthCheckFailures = 0;
    this.maxHealthCheckFailures = options.maxHealthCheckFailures || 3;
    
    // Timers
    this.reconnectTimer = null;
    this.idleTimer = null;
    this.healthCheckTimer = null;
    
    // Configuration
    this.idleTimeout = options.idleTimeout || 300000; // 5 minutes
    this.healthCheckInterval = options.healthCheckInterval || 30000; // 30 seconds
    this.requestTimeout = options.requestTimeout || 10000; // 10 seconds
  }

  /**
   * Connect to the bridge node
   */
  async connect() {
    if (this.state === ConnectionState.CONNECTING || this.state === ConnectionState.READY) {
      return;
    }

    this.state = ConnectionState.CONNECTING;
    this.connectAttempts++;
    
    console.log(`🔗 Connecting to bridge ${this.bridgeAddr} (attempt ${this.connectAttempts})`);

    try {
      // Handle protocol prefix correctly
      let wsUrl;
      if (this.bridgeAddr.startsWith('wss://') || this.bridgeAddr.startsWith('ws://')) {
        wsUrl = this.bridgeAddr;
      } else {
        const protocol = this.bridgeAddr.includes('imeyouwe.com') ? 'wss' : 'ws';
        wsUrl = `${protocol}://${this.bridgeAddr}`;
      }

      // FIXED: Add WebSocket options to handle SSL and connection issues
      const wsOptions = {
        // Disable SSL certificate validation for internal Docker connections
        rejectUnauthorized: false,
        // Add connection timeout
        handshakeTimeout: 10000,
        // Add headers for better proxy compatibility
        headers: {
          'User-Agent': 'YZ-Bootstrap-ConnectionPool/1.0'
        }
      };

      this.ws = new WebSocket(wsUrl, wsOptions);
      this.setupWebSocketHandlers();

      // Wait for connection to be established
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Connection timeout'));
        }, 10000);

        this.ws.once('open', () => {
          clearTimeout(timeout);
          resolve();
        });

        this.ws.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      // Authenticate
      await this.authenticate();
      
      this.state = ConnectionState.READY;
      this.connectAttempts = 0;
      this.lastActivity = Date.now();
      
      console.log(`✅ Connected to bridge ${this.bridgeAddr}`);
      this.emit('connected');
      
      // Start health monitoring
      this.startHealthCheck();
      this.startIdleTimer();

    } catch (error) {
      console.error(`❌ Failed to connect to bridge ${this.bridgeAddr}:`, error.message);
      this.state = ConnectionState.FAILED;
      this.emit('error', error);
      
      // Schedule reconnection with exponential backoff
      this.scheduleReconnect();
    }
  }

  /**
   * Authenticate with the bridge node
   */
  async authenticate() {
    this.state = ConnectionState.AUTHENTICATING;
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Authentication timeout'));
      }, 5000);

      const authHandler = (message) => {
        if (message.type === 'auth_success') {
          clearTimeout(timeout);
          this.ws.off('message', authHandler);
          resolve();
        } else if (message.type === 'auth_failed' || message.type === 'error') {
          clearTimeout(timeout);
          this.ws.off('message', authHandler);
          reject(new Error(message.message || 'Authentication failed'));
        }
      };

      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          authHandler(message);
        } catch (error) {
          // Ignore parse errors during auth
        }
      });

      // Send authentication
      this.ws.send(JSON.stringify({
        type: 'bootstrap_auth',
        auth_token: this.authToken,
        bootstrapServer: 'connection-pool'
      }));
    });
  }

  /**
   * Setup WebSocket event handlers
   */
  setupWebSocketHandlers() {
    this.ws.on('open', () => {
      console.log(`🔗 WebSocket opened to ${this.bridgeAddr}`);
    });

    this.ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleMessage(message);
      } catch (error) {
        console.error(`❌ Failed to parse message from ${this.bridgeAddr}:`, error);
      }
    });

    this.ws.on('close', (code, reason) => {
      console.log(`🔌 WebSocket closed to ${this.bridgeAddr}: ${code} ${reason}`);
      this.handleDisconnection();
    });

    this.ws.on('error', (error) => {
      console.error(`❌ WebSocket error from ${this.bridgeAddr}:`, error);
      this.handleDisconnection();
    });

    this.ws.on('pong', () => {
      this.lastPong = Date.now();
      this.healthCheckFailures = 0;
    });
  }

  /**
   * Handle incoming messages
   */
  handleMessage(message) {
    this.lastActivity = Date.now();
    this.resetIdleTimer();

    // Try to handle with multiplexer first
    const handled = this.multiplexer.handleResponse(message);
    
    if (!handled) {
      // Handle other message types that aren't request responses
      this.emit('message', message);
    }
  }

  /**
   * Send a request using the multiplexer
   */
  async sendRequest(request, options = {}) {
    if (this.state !== ConnectionState.READY) {
      throw new Error(`Bridge connection not ready: ${this.state}`);
    }

    try {
      // Use multiplexer to create and track the request
      const result = await this.multiplexer.createRequest(request, {
        timeout: options.timeout || this.requestTimeout,
        priority: options.priority || 0
      });

      // Process the request through the queue
      const queuedRequest = this.multiplexer.processNext();
      if (queuedRequest) {
        // Send the request over WebSocket
        this.ws.send(JSON.stringify(queuedRequest));
        this.lastActivity = Date.now();
        this.resetIdleTimer();
      }

      return result;
      
    } catch (error) {
      throw error;
    }
  }

  /**
   * Handle connection disconnection
   */
  handleDisconnection() {
    const wasReady = this.state === ConnectionState.READY;
    this.state = ConnectionState.DISCONNECTED;
    this.ws = null;
    
    // Clear timers
    this.clearTimers();
    
    // Cancel all pending requests in multiplexer
    this.multiplexer.shutdown();

    if (wasReady) {
      console.log(`🔌 Bridge connection lost: ${this.bridgeAddr}`);
      this.emit('disconnected');
      
      // Schedule reconnection
      this.scheduleReconnect();
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  scheduleReconnect() {
    if (this.connectAttempts >= this.maxReconnectAttempts) {
      console.error(`❌ Max reconnection attempts reached for ${this.bridgeAddr}`);
      this.state = ConnectionState.FAILED;
      this.emit('failed');
      return;
    }

    // FIXED: Add longer delays for 502 errors (nginx/proxy issues)
    // Exponential backoff: 2s, 4s, 8s, 16s, 32s, max 60s
    const baseDelay = 2000; // Start with 2 seconds instead of 1
    const delay = Math.min(baseDelay * Math.pow(2, this.connectAttempts - 1), 60000); // Max 60s instead of 30s
    
    console.log(`⏰ Reconnecting to ${this.bridgeAddr} in ${delay}ms (attempt ${this.connectAttempts}/${this.maxReconnectAttempts})`);
    
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {
        // Error already handled in connect()
      });
    }, delay);
  }

  /**
   * Start health check monitoring
   */
  startHealthCheck() {
    this.healthCheckTimer = setInterval(() => {
      if (this.state === ConnectionState.READY && this.ws) {
        this.lastPing = Date.now();
        this.ws.ping();
        
        // Check if previous ping was answered
        if (this.lastPing - this.lastPong > this.healthCheckInterval * 2) {
          this.healthCheckFailures++;
          console.warn(`⚠️ Health check failure ${this.healthCheckFailures}/${this.maxHealthCheckFailures} for ${this.bridgeAddr}`);
          
          if (this.healthCheckFailures >= this.maxHealthCheckFailures) {
            console.error(`❌ Bridge health check failed: ${this.bridgeAddr}`);
            this.ws.terminate();
          }
        }
      }
    }, this.healthCheckInterval);
  }

  /**
   * Start idle timer
   */
  startIdleTimer() {
    this.resetIdleTimer();
  }

  /**
   * Reset idle timer
   */
  resetIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }

    this.idleTimer = setTimeout(() => {
      const multiplexerStats = this.multiplexer.getStats();
      const hasPendingRequests = multiplexerStats.responses.pendingRequests > 0 || 
                                multiplexerStats.queue.processing > 0;
      
      if (!hasPendingRequests && this.state === ConnectionState.READY) {
        console.log(`💤 Closing idle connection to ${this.bridgeAddr}`);
        this.state = ConnectionState.IDLE;
        this.ws.close(1000, 'Idle timeout');
      }
    }, this.idleTimeout);
  }

  /**
   * Clear all timers
   */
  clearTimers() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Disconnect and cleanup
   */
  disconnect() {
    this.clearTimers();
    
    if (this.ws) {
      this.ws.close(1000, 'Manual disconnect');
    }
    
    this.state = ConnectionState.DISCONNECTED;
  }

  /**
   * Get connection statistics
   */
  getStats() {
    const multiplexerStats = this.multiplexer.getStats();
    
    return {
      bridgeAddr: this.bridgeAddr,
      state: this.state,
      connectAttempts: this.connectAttempts,
      lastActivity: this.lastActivity,
      multiplexer: multiplexerStats,
      healthCheck: {
        lastPing: this.lastPing,
        lastPong: this.lastPong,
        failures: this.healthCheckFailures
      }
    };
  }
}

/**
 * Bridge Connection Pool Manager
 * Manages persistent WebSocket connections to bridge nodes with intelligent lifecycle management
 */
export class BridgeConnectionPool extends EventEmitter {
  constructor(bridgeNodes, authToken, options = {}) {
    super();
    
    this.bridgeNodes = Array.isArray(bridgeNodes) ? bridgeNodes : [bridgeNodes];
    this.authToken = authToken;
    this.options = options;
    
    // Connection management
    this.connections = new Map(); // bridgeAddr -> BridgeConnection
    this.roundRobinIndex = 0;
    
    // Statistics
    this.totalRequests = 0;
    this.successfulRequests = 0;
    this.failedRequests = 0;
    
    // Create connections immediately (but don't connect yet)
    this.createConnections();
    
    console.log(`🏊 Bridge Connection Pool initialized with ${this.bridgeNodes.length} bridge nodes`);
  }

  /**
   * Create connection objects for all bridge nodes
   */
  createConnections() {
    for (const bridgeAddr of this.bridgeNodes) {
      const connection = new BridgeConnection(bridgeAddr, this.authToken, this.options);
      this.connections.set(bridgeAddr, connection);
      
      // Set up event handlers
      connection.on('connected', () => {
        console.log(`✅ Bridge connection ready: ${bridgeAddr}`);
        this.emit('connectionReady', bridgeAddr);
      });
      
      connection.on('disconnected', () => {
        console.log(`🔌 Bridge connection lost: ${bridgeAddr}`);
        this.emit('connectionLost', bridgeAddr);
      });
      
      connection.on('failed', () => {
        console.log(`❌ Bridge connection failed: ${bridgeAddr}`);
        this.emit('connectionFailed', bridgeAddr);
      });
    }
  }

  /**
   * Initialize connections to all bridge nodes
   */
  async initialize() {
    console.log(`🚀 Initializing connections to ${this.bridgeNodes.length} bridge nodes`);
    
    // FIXED: Add retry logic for connection pool initialization
    const maxRetries = 3;
    let attempt = 0;
    
    while (attempt < maxRetries) {
      attempt++;
      console.log(`🔄 Connection pool initialization attempt ${attempt}/${maxRetries}`);
      
      const connectionPromises = Array.from(this.connections.values()).map(connection => {
        // Connect (don't wait for all to succeed)
        return connection.connect().catch(error => {
          console.warn(`⚠️ Initial connection failed for ${connection.bridgeAddr}: ${error.message}`);
        });
      });
      
      // Wait for all connection attempts to complete (some may fail)
      await Promise.allSettled(connectionPromises);
      
      const readyConnections = this.getReadyConnections().length;
      console.log(`🏊 Connection pool attempt ${attempt}: ${readyConnections}/${this.bridgeNodes.length} bridges ready`);
      
      // If we have at least one connection, consider it successful
      if (readyConnections > 0) {
        console.log(`✅ Connection pool initialized successfully with ${readyConnections} bridge(s)`);
        return;
      }
      
      // If no connections and not the last attempt, wait and retry
      if (attempt < maxRetries) {
        const delay = attempt * 2000; // 2s, 4s, 6s
        console.log(`⏳ No connections established, retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    // If we get here, all attempts failed
    console.warn(`⚠️ Connection pool initialization completed with 0/${this.bridgeNodes.length} bridges ready`);
    console.warn(`   Bridge connections will be retried automatically in the background`);
  }

  /**
   * Get a connection for sending requests (round-robin)
   */
  getConnection() {
    const readyConnections = this.getReadyConnections();
    
    if (readyConnections.length === 0) {
      throw new Error('No bridge connections available');
    }
    
    // Round-robin selection
    const connection = readyConnections[this.roundRobinIndex % readyConnections.length];
    this.roundRobinIndex++;
    
    return connection;
  }

  /**
   * Get all ready connections
   */
  getReadyConnections() {
    return Array.from(this.connections.values())
      .filter(conn => conn.state === ConnectionState.READY);
  }

  /**
   * Send request to any available bridge
   */
  async sendRequest(request) {
    this.totalRequests++;
    
    const maxRetries = Math.min(3, this.connections.size);
    let lastError = null;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const connection = this.getConnection();
        const result = await connection.sendRequest(request);
        
        this.successfulRequests++;
        return result;
        
      } catch (error) {
        lastError = error;
        console.warn(`⚠️ Request attempt ${attempt + 1} failed: ${error.message}`);
        
        // If it's a connection issue, try another bridge
        if (error.message.includes('not ready') || error.message.includes('Connection lost')) {
          continue;
        }
        
        // For other errors, don't retry
        break;
      }
    }
    
    this.failedRequests++;
    throw lastError || new Error('All bridge connections failed');
  }

  /**
   * Get connection pool statistics
   */
  getStats() {
    const connectionStats = {};
    for (const [addr, conn] of this.connections) {
      connectionStats[addr] = conn.getStats();
    }
    
    const readyCount = this.getReadyConnections().length;
    
    return {
      totalBridges: this.bridgeNodes.length,
      readyConnections: readyCount,
      connectionStats,
      requests: {
        total: this.totalRequests,
        successful: this.successfulRequests,
        failed: this.failedRequests,
        successRate: this.totalRequests > 0 ? (this.successfulRequests / this.totalRequests) : 0
      }
    };
  }

  /**
   * Shutdown all connections
   */
  async shutdown() {
    console.log('🛑 Shutting down bridge connection pool');
    
    for (const connection of this.connections.values()) {
      connection.disconnect();
    }
    
    this.connections.clear();
  }
}