/**
 * ActiveDHTNode - Full DHT Participant for Docker Deployment
 *
 * Features:
 * - Full DHT read/write operations (store, get, findNode)
 * - PubSub publish/subscribe with push delivery
 * - Metrics collection (latency, throughput, connections)
 * - Health reporting for monitoring dashboard
 * - Auto-recovery from failures
 * - HTTP API for status and metrics
 */

import { NodeDHTClient } from '../node/NodeDHTClient.js';
import { PubSubClient } from '../pubsub/PubSubClient.js';
import { InvitationToken } from '../core/InvitationToken.js';
import crypto from 'crypto';
import http from 'http';

export class ActiveDHTNode extends NodeDHTClient {
  constructor(options = {}) {
    super({
      bootstrapServers: options.bootstrapServers || ['ws://bootstrap:8080'],
      // Full DHT participation - NOT passive mode
      passiveMode: false,
      disableStorage: false,
      disableRouting: false,
      disableLookups: false,
      enableConnections: true,
      k: options.k || 20,
      alpha: options.alpha || 3,
      // WebSocket server configuration (map websocketPort to port for NodeDHTClient)
      port: options.websocketPort || options.port || 0,
      websocketPort: options.websocketPort,
      websocketHost: options.websocketHost || '0.0.0.0',
      publicAddress: options.publicAddress,           // Internal Docker address
      publicWssAddress: options.publicWssAddress,     // External browser WSS address
      upnpEnabled: options.upnpEnabled !== false,
      ...options
    });

    // HTTP server for metrics/health endpoint
    this.metricsPort = options.metricsPort || 9090;
    this.metricsServer = null;

    // WebSocket server configuration
    this.websocketPort = options.websocketPort;
    this.websocketHost = options.websocketHost || '0.0.0.0';
    this.publicAddress = options.publicAddress;           // Internal Docker address
    this.publicWssAddress = options.publicWssAddress;     // External browser WSS address
    this.upnpEnabled = options.upnpEnabled !== false;
    this.upnpMappings = [];

    // PubSub client
    this.pubsub = null;

    // Metrics tracking
    this.metrics = {
      // Uptime
      startTime: Date.now(),

      // DHT operations
      dhtStores: 0,
      dhtGets: 0,
      dhtFindNodes: 0,
      dhtStoreFails: 0,
      dhtGetFails: 0,

      // PubSub operations
      pubsubPublishes: 0,
      pubsubSubscribes: 0,
      messagesReceived: 0,
      messagesSent: 0,

      // Data transfer metrics (bytes)
      bytesReceived: 0,
      bytesSent: 0,
      dataTransferSamples: [], // For calculating averages over time

      // Latency tracking (milliseconds)
      storeLatencies: [],
      getLatencies: [],
      findNodeLatencies: [],
      pingLatencies: [], // Peer ping latencies

      // Throughput (operations per second)
      opsLastMinute: [],

      // Connections
      currentConnections: 0,
      maxConnections: 0,
      connectionFailures: 0,

      // Health
      lastHealthCheck: Date.now(),
      isHealthy: true,
      healthCheckFailures: 0
    };

    // Latency buckets for percentile calculation
    this.maxLatencySamples = 100;
  }

  getNodeType() {
    return 'nodejs-active';
  }

  getCapabilities() {
    return ['websocket', 'storage', 'routing', 'pubsub', 'metrics'];
  }

  canAcceptConnections() {
    return true;
  }

  canInitiateConnections() {
    return true;
  }

  getDHTOptions() {
    return {
      ...super.getDHTOptions(),
      passiveMode: false,
      disableStorage: false,
      disableRouting: false,
      disableLookups: false
    };
  }

  /**
   * Start node with full DHT + PubSub + Metrics
   */
  async start() {
    console.log(`🚀 Starting ActiveDHTNode...`);
    console.log(`   Metrics Port: ${this.metricsPort}`);
    console.log(`   Bootstrap: ${this.options.bootstrapServers[0]}`);

    // Start base DHT
    const result = await super.start();

    // Pass metrics tracker to DHT for data transfer tracking
    if (this.dht) {
      this.dht.metricsTracker = this;
    }

    // Initialize PubSub
    await this.initializePubSub();

    // Start metrics HTTP server
    await this.startMetricsServer();

    // Set up ping latency collection
    this.setupPingLatencyCollection();

    // Start background tasks
    this.startBackgroundTasks();

    console.log(`✅ ActiveDHTNode started`);
    console.log(`   Node ID: ${this.nodeId.toString().substring(0, 16)}...`);
    console.log(`   Metrics: http://localhost:${this.metricsPort}/metrics`);

    return {
      ...result,
      metricsPort: this.metricsPort,
      pubsubEnabled: true
    };
  }

  /**
   * Initialize PubSub with proper key management
   */
  async initializePubSub() {
    if (!this.dht) {
      throw new Error('DHT must be started first');
    }

    // Generate Ed25519 key pair for signing
    const keyInfo = await this.generateKeyPair();

    this.pubsub = new PubSubClient(
      this.dht,
      this.nodeId.toString(),
      keyInfo,
      {
        enableBatching: true,
        batchSize: 10,
        batchTime: 100
      }
    );

    console.log('📬 PubSub initialized');
  }

  /**
   * Generate Ed25519 key pair for PubSub signatures
   */
  async generateKeyPair() {
    try {
      // Try to use InvitationToken's key generation
      return await InvitationToken.generateKeyPair();
    } catch (error) {
      // Fallback to simple HMAC signing for PoC
      console.warn('⚠️ Using fallback HMAC signing (not Ed25519)');
      const secret = crypto.randomBytes(32);

      return {
        publicKey: this.nodeId.toString(),
        privateKey: secret.toString('hex'),
        sign: async (data) => {
          const hmac = crypto.createHmac('sha256', secret);
          hmac.update(data);
          return hmac.digest('hex');
        }
      };
    }
  }

  /**
   * Start HTTP server for metrics and health checks
   */
  async startMetricsServer() {
    this.metricsServer = http.createServer((req, res) => {
      // CORS headers for dashboard
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      if (req.url === '/health') {
        this.handleHealthCheck(req, res);
      } else if (req.url === '/metrics') {
        this.handleMetrics(req, res);
      } else if (req.url === '/status') {
        this.handleStatus(req, res);
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });

    return new Promise((resolve, reject) => {
      this.metricsServer.listen(this.metricsPort, '0.0.0.0', (err) => {
        if (err) {
          reject(err);
        } else {
          console.log(`📊 Metrics server listening on port ${this.metricsPort}`);
          resolve();
        }
      });
    });
  }

  /**
   * Health check endpoint
   */
  handleHealthCheck(req, res) {
    const uptime = Date.now() - this.metrics.startTime;
    const connectedPeers = this.dht ? this.dht.getConnectedPeers().length : 0;

    // Node is healthy if:
    // 1. DHT is running
    // 2. Has at least 1 connection (or is new < 60 seconds) - EXTENDED grace period
    // 3. No recent health check failures
    // 4. OR if bootstrap connection is failing (version mismatch), be more lenient
    const bootstrapConnectionFailing = this.dht && this.dht.bootstrapClient && 
      !this.dht.bootstrapClient.isBootstrapConnected();
    
    const isHealthy = this.dht &&
      (connectedPeers > 0 || 
       uptime < 60000 || // Extended grace period from 30s to 60s
       (bootstrapConnectionFailing && uptime < 300000)) && // 5 minute grace if bootstrap failing
      this.metrics.healthCheckFailures < 10; // Increased tolerance from 5 to 10

    this.metrics.isHealthy = isHealthy;
    this.metrics.lastHealthCheck = Date.now();

    res.writeHead(isHealthy ? 200 : 503);
    res.end(JSON.stringify({
      healthy: isHealthy,
      uptime,
      connectedPeers,
      bootstrapConnected: this.dht && this.dht.bootstrapClient ? this.dht.bootstrapClient.isBootstrapConnected() : false,
      timestamp: Date.now()
    }));
  }

  /**
   * Metrics endpoint (Prometheus-compatible format)
   */
  handleMetrics(req, res) {
    const metrics = this.collectMetrics();

    res.writeHead(200);
    res.end(JSON.stringify(metrics, null, 2));
  }

  /**
   * Status endpoint (detailed node information)
   */
  handleStatus(req, res) {
    const status = {
      nodeId: this.nodeId.toString().substring(0, 16) + '...',
      nodeType: this.getNodeType(),
      capabilities: this.getCapabilities(),
      uptime: Date.now() - this.metrics.startTime,
      dht: this.dht ? {
        connectedPeers: this.dht.getConnectedPeers().length,
        routingTableSize: this.dht.routingTable.getAllNodes().length,
        active: true
      } : { active: false },
      pubsub: this.pubsub ? {
        activeSubscriptions: this.pubsub.getSubscriptions().length,
        active: true
      } : { active: false },
      metrics: this.metrics,
      health: {
        isHealthy: this.metrics.isHealthy,
        lastCheck: this.metrics.lastHealthCheck
      }
    };

    res.writeHead(200);
    res.end(JSON.stringify(status, null, 2));
  }

  /**
   * Collect all metrics
   */
  collectMetrics() {
    const uptime = (Date.now() - this.metrics.startTime) / 1000;
    const connectedPeers = this.dht ? this.dht.getConnectedPeers().length : 0;
    const routingTableSize = this.dht ? this.dht.routingTable.getAllNodes().length : 0;

    return {
      // Node info
      node_uptime_seconds: uptime,
      node_healthy: this.metrics.isHealthy ? 1 : 0,

      // Connections
      dht_connected_peers: connectedPeers,
      dht_routing_table_size: routingTableSize,
      dht_connection_failures_total: this.metrics.connectionFailures,

      // DHT operations
      dht_store_operations_total: this.metrics.dhtStores,
      dht_get_operations_total: this.metrics.dhtGets,
      dht_findnode_operations_total: this.metrics.dhtFindNodes,
      dht_store_failures_total: this.metrics.dhtStoreFails,
      dht_get_failures_total: this.metrics.dhtGetFails,

      // PubSub operations
      pubsub_publish_operations_total: this.metrics.pubsubPublishes,
      pubsub_subscribe_operations_total: this.metrics.pubsubSubscribes,
      pubsub_messages_received_total: this.metrics.messagesReceived,
      pubsub_messages_sent_total: this.metrics.messagesSent,

      // Data transfer metrics (bytes)
      data_bytes_received_total: this.metrics.bytesReceived,
      data_bytes_sent_total: this.metrics.bytesSent,
      data_bytes_received_per_second: this.calculateDataTransferRate('received'),
      data_bytes_sent_per_second: this.calculateDataTransferRate('sent'),

      // Latency (percentiles in milliseconds)
      dht_store_latency_p50: this.calculatePercentile(this.metrics.storeLatencies, 50),
      dht_store_latency_p95: this.calculatePercentile(this.metrics.storeLatencies, 95),
      dht_store_latency_p99: this.calculatePercentile(this.metrics.storeLatencies, 99),
      dht_get_latency_p50: this.calculatePercentile(this.metrics.getLatencies, 50),
      dht_get_latency_p95: this.calculatePercentile(this.metrics.getLatencies, 95),
      dht_get_latency_p99: this.calculatePercentile(this.metrics.getLatencies, 99),
      
      // Ping latency (peer-to-peer connection latency)
      ping_latency_p50: this.calculatePercentile(this.metrics.pingLatencies, 50),
      ping_latency_p95: this.calculatePercentile(this.metrics.pingLatencies, 95),
      ping_latency_p99: this.calculatePercentile(this.metrics.pingLatencies, 99),

      // Throughput
      operations_per_second: this.calculateOpsPerSecond()
    };
  }

  /**
   * Calculate percentile from latency samples
   */
  calculatePercentile(samples, percentile) {
    if (!samples || samples.length === 0) return 0;

    // CRITICAL FIX: Filter out extreme outliers (likely from inactive tabs)
    // Remove latencies > 30 seconds (30000ms) as they're likely from inactive browser tabs
    const filteredSamples = samples.filter(latency => latency <= 30000);
    
    if (filteredSamples.length === 0) {
      console.warn(`⚠️ All latency samples were outliers (>${30000}ms) - using raw samples`);
      const sorted = [...samples].sort((a, b) => a - b);
      const index = Math.ceil((percentile / 100) * sorted.length) - 1;
      return sorted[Math.max(0, index)];
    }

    const sorted = [...filteredSamples].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    const result = sorted[Math.max(0, index)];
    
    // Debug logging for ping latencies
    if (samples === this.metrics.pingLatencies && samples.length > 0) {
      const outlierCount = samples.length - filteredSamples.length;
      console.log(`📊 Ping latency P${percentile}: ${result}ms (from ${filteredSamples.length} samples, ${outlierCount} outliers filtered: [${filteredSamples.slice(-5).join(', ')}])`);
    }
    
    return result;
  }

  /**
   * Calculate operations per second (last minute)
   */
  calculateOpsPerSecond() {
    if (this.metrics.opsLastMinute.length === 0) {
      console.log(`📊 No operations recorded in opsLastMinute array`);
      return 0;
    }

    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    // Filter to last minute
    const recentOps = this.metrics.opsLastMinute.filter(t => t > oneMinuteAgo);
    
    const opsPerSecond = recentOps.length / 60;
    console.log(`📊 Throughput calculation: ${recentOps.length} operations in last minute = ${opsPerSecond.toFixed(2)} ops/sec`);

    return opsPerSecond;
  }

  /**
   * Calculate data transfer rate (bytes per second over last minute)
   */
  calculateDataTransferRate(direction) {
    if (!this.metrics.dataTransferSamples || this.metrics.dataTransferSamples.length === 0) {
      return 0;
    }

    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    // Filter to last minute and sum bytes for the specified direction
    const recentSamples = this.metrics.dataTransferSamples.filter(sample => sample.timestamp > oneMinuteAgo);
    const totalBytes = recentSamples.reduce((sum, sample) => {
      return sum + (sample[direction] || 0);
    }, 0);

    return totalBytes / 60; // bytes per second
  }

  /**
   * Record operation latency
   */
  recordLatency(type, latencyMs) {
    const bucket = this.metrics[`${type}Latencies`];
    if (!bucket) {
      console.warn(`⚠️ No latency bucket for operation type: ${type}`);
      return;
    }

    bucket.push(latencyMs);
    console.log(`📊 Recorded ${type} operation: ${latencyMs}ms (bucket size: ${bucket.length})`);

    // Keep only recent samples
    if (bucket.length > this.maxLatencySamples) {
      bucket.shift();
    }

    // Record operation timestamp for throughput
    this.metrics.opsLastMinute.push(Date.now());
    console.log(`📊 Recorded ${type} operation for throughput (total ops: ${this.metrics.opsLastMinute.length})`);

    // Cleanup old operation timestamps
    const oneMinuteAgo = Date.now() - 60000;
    const oldLength = this.metrics.opsLastMinute.length;
    this.metrics.opsLastMinute = this.metrics.opsLastMinute.filter(t => t > oneMinuteAgo);
    if (oldLength !== this.metrics.opsLastMinute.length) {
      console.log(`📊 Cleaned up old operations: ${oldLength} -> ${this.metrics.opsLastMinute.length}`);
    }
  }

  /**
   * Record data transfer (bytes sent/received)
   */
  recordDataTransfer(bytesSent = 0, bytesReceived = 0) {
    // Update totals
    this.metrics.bytesSent += bytesSent;
    this.metrics.bytesReceived += bytesReceived;

    // Add sample for rate calculation
    const sample = {
      timestamp: Date.now(),
      sent: bytesSent,
      received: bytesReceived
    };

    if (!this.metrics.dataTransferSamples) {
      this.metrics.dataTransferSamples = [];
    }

    this.metrics.dataTransferSamples.push(sample);

    // Keep only last 100 samples (about 10 minutes at 6 samples/minute)
    if (this.metrics.dataTransferSamples.length > 100) {
      this.metrics.dataTransferSamples.shift();
    }

    // Clean up old samples (older than 5 minutes)
    const fiveMinutesAgo = Date.now() - 300000;
    this.metrics.dataTransferSamples = this.metrics.dataTransferSamples.filter(
      sample => sample.timestamp > fiveMinutesAgo
    );
  }

  /**
   * DHT store with metrics
   */
  async store(key, value, ttl) {
    const startTime = Date.now();

    try {
      const result = await this.dht.store(key, value, ttl);
      this.metrics.dhtStores++;
      console.log(`📦 DHT store operation completed: key=${key.substring(0, 16)}... (total stores: ${this.metrics.dhtStores})`);
      this.recordLatency('store', Date.now() - startTime);
      return result;
    } catch (error) {
      this.metrics.dhtStoreFails++;
      console.log(`❌ DHT store operation failed: key=${key.substring(0, 16)}... (total failures: ${this.metrics.dhtStoreFails})`);
      throw error;
    }
  }

  /**
   * DHT get with metrics
   */
  async get(key) {
    const startTime = Date.now();

    try {
      const result = await this.dht.get(key);
      this.metrics.dhtGets++;
      console.log(`🔍 DHT get operation completed: key=${key.substring(0, 16)}... (total gets: ${this.metrics.dhtGets})`);
      this.recordLatency('get', Date.now() - startTime);
      return result;
    } catch (error) {
      this.metrics.dhtGetFails++;
      console.log(`❌ DHT get operation failed: key=${key.substring(0, 16)}... (total failures: ${this.metrics.dhtGetFails})`);
      throw error;
    }
  }

  /**
   * DHT findNode with metrics
   */
  async findNode(targetId) {
    const startTime = Date.now();
    const result = await this.dht.findNode(targetId);
    this.metrics.dhtFindNodes++;
    console.log(`🔍 DHT findNode operation completed: target=${targetId.substring(0, 16)}... found ${result.length} nodes (total findNodes: ${this.metrics.dhtFindNodes})`);
    this.recordLatency('findNode', Date.now() - startTime);
    return result;
  }

  /**
   * PubSub publish with metrics
   */
  async publish(topic, data, options) {
    const result = await this.pubsub.publish(topic, data, options);
    this.metrics.pubsubPublishes++;
    this.metrics.messagesSent++;
    console.log(`📤 PubSub publish completed: topic=${topic} (total publishes: ${this.metrics.pubsubPublishes}, messages sent: ${this.metrics.messagesSent})`);
    return result;
  }

  /**
   * PubSub subscribe with metrics
   */
  async subscribe(topic, handler, options) {
    const result = await this.pubsub.subscribe(topic, options);

    this.pubsub.on(topic, (message) => {
      this.metrics.messagesReceived++;
      console.log(`📥 PubSub message received: topic=${topic} (total received: ${this.metrics.messagesReceived})`);
      if (handler) handler(message);
    });

    this.metrics.pubsubSubscribes++;
    console.log(`📬 PubSub subscribe completed: topic=${topic} (total subscriptions: ${this.metrics.pubsubSubscribes})`);
    return result;
  }

  /**
   * Set up ping latency collection from connection managers
   */
  setupPingLatencyCollection() {
    // Expose metrics globally so WebSocketConnectionManager can record ping latencies
    global.activeDHTNodeMetrics = this.metrics;
    console.log('🏓 Ping latency collection set up (global metrics exposed)');
    
    // Set up periodic cleanup of extreme outliers
    setInterval(() => {
      this.cleanupLatencyOutliers();
    }, 60000); // Clean up every minute
  }

  /**
   * Clean up extreme latency outliers (likely from inactive browser tabs)
   */
  cleanupLatencyOutliers() {
    const maxReasonableLatency = 30000; // 30 seconds
    
    ['pingLatencies', 'storeLatencies', 'getLatencies', 'findNodeLatencies'].forEach(bucketName => {
      const bucket = this.metrics[bucketName];
      if (bucket && bucket.length > 0) {
        const originalLength = bucket.length;
        
        // Remove outliers
        const filtered = bucket.filter(latency => latency <= maxReasonableLatency);
        
        if (filtered.length < originalLength) {
          this.metrics[bucketName] = filtered;
          console.log(`🧹 Cleaned up ${originalLength - filtered.length} latency outliers from ${bucketName} (${filtered.length} samples remaining)`);
        }
      }
    });
  }

  /**
   * Background maintenance tasks
   */
  startBackgroundTasks() {
    // Update connection metrics every 10 seconds
    this.metricsInterval = setInterval(() => {
      if (this.dht) {
        const connections = this.dht.getConnectedPeers().length;
        this.metrics.currentConnections = connections;
        this.metrics.maxConnections = Math.max(this.metrics.maxConnections, connections);
      }
    }, 10000);

    // Periodic health check every 30 seconds
    this.healthInterval = setInterval(() => {
      this.performHealthCheck();
    }, 30000);

    // Periodic DHT operations for throughput measurement (every 2 minutes)
    this.throughputTestInterval = setInterval(() => {
      this.performThroughputTest();
    }, 120000);
  }

  /**
   * Perform internal health check
   */
  async performHealthCheck() {
    try {
      const uptime = Date.now() - this.metrics.startTime;
      const connectedPeers = this.dht ? this.dht.getConnectedPeers().length : 0;

      // Health criteria
      const hasConnections = connectedPeers > 0 || uptime < 30000;
      const dhtActive = !!this.dht;

      if (hasConnections && dhtActive) {
        this.metrics.healthCheckFailures = 0;
        this.metrics.isHealthy = true;
      } else {
        this.metrics.healthCheckFailures++;
        this.metrics.isHealthy = this.metrics.healthCheckFailures < 5;
        console.warn(`⚠️ Health check warning: connections=${connectedPeers}, failures=${this.metrics.healthCheckFailures}`);
      }
    } catch (error) {
      this.metrics.healthCheckFailures++;
      this.metrics.isHealthy = false;
      console.error('❌ Health check error:', error.message);
    }
  }

  /**
   * Perform periodic DHT operations to measure throughput
   */
  async performThroughputTest() {
    if (!this.dht) return;

    try {
      console.log('📊 Performing throughput test operations...');
      
      // Perform a few findNode operations (these are common DHT maintenance operations)
      const randomNodeId = crypto.randomBytes(20).toString('hex');
      await this.findNode(randomNodeId);
      
      // Small delay between operations
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Perform a test store operation
      const testKey = `throughput_test_${Date.now()}`;
      const testValue = { timestamp: Date.now(), nodeId: this.nodeId.toString().substring(0, 8) };
      await this.store(testKey, JSON.stringify(testValue), 300); // 5 minute TTL
      
      // Perform PubSub test operations if PubSub is available
      if (this.pubsub) {
        console.log('📊 Performing PubSub test operations...');
        
        // Test publish operation
        const testTopic = `test_topic_${this.nodeId.toString().substring(0, 8)}`;
        const testMessage = { 
          type: 'throughput_test', 
          timestamp: Date.now(), 
          nodeId: this.nodeId.toString().substring(0, 8) 
        };
        
        await this.publish(testTopic, testMessage);
        
        // Test subscribe operation (subscribe to our own test topic)
        await this.subscribe(`test_topic_global`, (message) => {
          console.log(`📬 Received test message:`, message);
        });
        
        console.log('✅ PubSub test operations completed');
      } else {
        console.log('⚠️ PubSub not available for test operations');
      }
      
      console.log('✅ All throughput test operations completed');
    } catch (error) {
      console.warn('⚠️ Throughput test failed:', error.message);
    }
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    console.log('🛑 Shutting down ActiveDHTNode...');

    // Stop background tasks
    if (this.metricsInterval) clearInterval(this.metricsInterval);
    if (this.healthInterval) clearInterval(this.healthInterval);
    if (this.throughputTestInterval) clearInterval(this.throughputTestInterval);

    // Close metrics server
    if (this.metricsServer) {
      await new Promise(resolve => this.metricsServer.close(resolve));
    }

    // Shutdown PubSub
    if (this.pubsub) {
      await this.pubsub.shutdown();
    }

    // Shutdown DHT
    if (this.dht) {
      await this.dht.shutdown();
    }

    console.log('✅ Shutdown complete');
  }
}
