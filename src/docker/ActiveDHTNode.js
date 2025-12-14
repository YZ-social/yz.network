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
    // 2. Has at least 1 connection (or is new < 30 seconds)
    // 3. No recent health check failures
    const isHealthy = this.dht &&
      (connectedPeers > 0 || uptime < 30000) &&
      this.metrics.healthCheckFailures < 5;

    this.metrics.isHealthy = isHealthy;
    this.metrics.lastHealthCheck = Date.now();

    res.writeHead(isHealthy ? 200 : 503);
    res.end(JSON.stringify({
      healthy: isHealthy,
      uptime,
      connectedPeers,
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

    const sorted = [...samples].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    const result = sorted[Math.max(0, index)];
    
    // Debug logging for ping latencies
    if (samples === this.metrics.pingLatencies && samples.length > 0) {
      console.log(`📊 Ping latency P${percentile}: ${result}ms (from ${samples.length} samples: [${samples.slice(-5).join(', ')}])`);
    }
    
    return result;
  }

  /**
   * Calculate operations per second (last minute)
   */
  calculateOpsPerSecond() {
    if (this.metrics.opsLastMinute.length === 0) return 0;

    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    // Filter to last minute
    const recentOps = this.metrics.opsLastMinute.filter(t => t > oneMinuteAgo);

    return recentOps.length / 60;
  }

  /**
   * Record operation latency
   */
  recordLatency(type, latencyMs) {
    const bucket = this.metrics[`${type}Latencies`];
    if (!bucket) return;

    bucket.push(latencyMs);

    // Keep only recent samples
    if (bucket.length > this.maxLatencySamples) {
      bucket.shift();
    }

    // Record operation timestamp for throughput
    this.metrics.opsLastMinute.push(Date.now());

    // Cleanup old operation timestamps
    const oneMinuteAgo = Date.now() - 60000;
    this.metrics.opsLastMinute = this.metrics.opsLastMinute.filter(t => t > oneMinuteAgo);
  }

  /**
   * DHT store with metrics
   */
  async store(key, value, ttl) {
    const startTime = Date.now();

    try {
      const result = await this.dht.store(key, value, ttl);
      this.metrics.dhtStores++;
      this.recordLatency('store', Date.now() - startTime);
      return result;
    } catch (error) {
      this.metrics.dhtStoreFails++;
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
      this.recordLatency('get', Date.now() - startTime);
      return result;
    } catch (error) {
      this.metrics.dhtGetFails++;
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
    return result;
  }

  /**
   * PubSub subscribe with metrics
   */
  async subscribe(topic, handler, options) {
    const result = await this.pubsub.subscribe(topic, options);

    this.pubsub.on(topic, (message) => {
      this.metrics.messagesReceived++;
      if (handler) handler(message);
    });

    this.metrics.pubsubSubscribes++;
    return result;
  }

  /**
   * Set up ping latency collection from connection managers
   */
  setupPingLatencyCollection() {
    // Expose metrics globally so WebSocketConnectionManager can record ping latencies
    global.activeDHTNodeMetrics = this.metrics;
    console.log('🏓 Ping latency collection set up (global metrics exposed)');
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
   * Graceful shutdown
   */
  async shutdown() {
    console.log('🛑 Shutting down ActiveDHTNode...');

    // Stop background tasks
    if (this.metricsInterval) clearInterval(this.metricsInterval);
    if (this.healthInterval) clearInterval(this.healthInterval);

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
