#!/usr/bin/env node

/**
 * DHT Network Monitoring Dashboard
 *
 * Features:
 * - Discovers all DHT nodes via Docker network
 * - Scrapes metrics from each node's /metrics endpoint
 * - Aggregates network-wide statistics
 * - Provides web UI for visualization
 * - Tracks node health and failures
 */

import http from 'http';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const SCRAPE_INTERVAL = parseInt(process.env.METRICS_SCRAPE_INTERVAL) || 10000;

// In-memory metrics storage
const metrics = {
  nodes: new Map(),  // nodeId -> latest metrics
  aggregate: {
    totalNodes: 0,
    healthyNodes: 0,
    unhealthyNodes: 0,
    totalConnections: 0,
    avgConnectionsPerNode: 0,
    totalDHTOps: 0,
    totalPubSubOps: 0,
    avgLatencyP50: 0,
    avgLatencyP95: 0,
    avgLatencyP99: 0,
    opsPerSecond: 0
  },
  lastUpdate: null,
  history: []  // Time-series data for charts
};

/**
 * Discover all DHT node containers
 */
async function discoverNodes() {
  try {
    // Find all containers running DHT nodes
    const { stdout } = await execAsync(
      `docker ps --filter "name=yz-network[-_]dht-node" --format "{{.Names}}:{{.Ports}}"`
    );

    const containers = stdout.trim().split('\n').filter(Boolean);
    const nodes = [];

    for (const container of containers) {
      const [name, ports] = container.split(':');

      // Extract metrics port (defaults to 9090)
      const portMatch = ports.match(/0\.0\.0\.0:(\d+)->9090/);
      const metricsPort = portMatch ? portMatch[1] : '9090';

      nodes.push({
        name,
        host: name,  // Docker container name is DNS name
        port: 9090,  // Internal port
        metricsUrl: `http://${name}:9090`
      });
    }

    return nodes;
  } catch (error) {
    console.error('Error discovering nodes:', error.message);
    return [];
  }
}

/**
 * Fetch metrics from a single node
 */
async function fetchNodeMetrics(node) {
  try {
    const response = await fetch(`${node.metricsUrl}/metrics`, {
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    return {
      ...data,
      nodeName: node.name,
      timestamp: Date.now(),
      healthy: data.node_healthy === 1
    };
  } catch (error) {
    console.warn(`Failed to fetch metrics from ${node.name}:`, error.message);
    return {
      nodeName: node.name,
      timestamp: Date.now(),
      healthy: false,
      error: error.message
    };
  }
}

/**
 * Scrape metrics from all nodes
 */
async function scrapeAllMetrics() {
  console.log('🔍 Discovering nodes...');
  const nodes = await discoverNodes();

  console.log(`📊 Scraping metrics from ${nodes.length} nodes...`);

  // Fetch metrics from all nodes in parallel
  const metricsPromises = nodes.map(node => fetchNodeMetrics(node));
  const nodeMetrics = await Promise.all(metricsPromises);

  // Update metrics store
  for (const data of nodeMetrics) {
    metrics.nodes.set(data.nodeName, data);
  }

  // Calculate aggregate statistics
  calculateAggregates();

  metrics.lastUpdate = Date.now();

  console.log(`✅ Updated metrics: ${metrics.aggregate.healthyNodes}/${metrics.aggregate.totalNodes} nodes healthy`);
}

/**
 * Calculate aggregate network statistics
 */
function calculateAggregates() {
  const nodeArray = Array.from(metrics.nodes.values());
  const healthyNodes = nodeArray.filter(n => n.healthy);

  metrics.aggregate = {
    totalNodes: nodeArray.length,
    healthyNodes: healthyNodes.length,
    unhealthyNodes: nodeArray.length - healthyNodes.length,

    // Connection statistics
    totalConnections: healthyNodes.reduce((sum, n) => sum + (n.dht_connected_peers || 0), 0),
    avgConnectionsPerNode: healthyNodes.length > 0
      ? healthyNodes.reduce((sum, n) => sum + (n.dht_connected_peers || 0), 0) / healthyNodes.length
      : 0,

    // DHT operation statistics
    totalDHTOps: healthyNodes.reduce((sum, n) =>
      sum + (n.dht_store_operations_total || 0) + (n.dht_get_operations_total || 0), 0),

    // PubSub operation statistics
    totalPubSubOps: healthyNodes.reduce((sum, n) =>
      sum + (n.pubsub_publish_operations_total || 0) + (n.pubsub_subscribe_operations_total || 0), 0),

    // Average latencies
    avgLatencyP50: healthyNodes.length > 0
      ? healthyNodes.reduce((sum, n) => sum + (n.dht_store_latency_p50 || 0), 0) / healthyNodes.length
      : 0,
    avgLatencyP95: healthyNodes.length > 0
      ? healthyNodes.reduce((sum, n) => sum + (n.dht_store_latency_p95 || 0), 0) / healthyNodes.length
      : 0,
    avgLatencyP99: healthyNodes.length > 0
      ? healthyNodes.reduce((sum, n) => sum + (n.dht_store_latency_p99 || 0), 0) / healthyNodes.length
      : 0,

    // Throughput
    opsPerSecond: healthyNodes.reduce((sum, n) => sum + (n.operations_per_second || 0), 0)
  };

  // Add to history for time-series charts (keep last 100 data points)
  metrics.history.push({
    timestamp: Date.now(),
    ...metrics.aggregate
  });

  if (metrics.history.length > 100) {
    metrics.history.shift();
  }
}

/**
 * HTTP server for dashboard
 */
const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // API endpoints
  if (req.url === '/api/metrics') {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({
      aggregate: metrics.aggregate,
      lastUpdate: metrics.lastUpdate,
      nodeCount: metrics.nodes.size
    }));
    return;
  }

  if (req.url === '/api/nodes') {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({
      nodes: Array.from(metrics.nodes.values())
    }));
    return;
  }

  if (req.url === '/api/history') {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({
      history: metrics.history
    }));
    return;
  }

  if (req.url === '/health') {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({
      healthy: true,
      nodesDiscovered: metrics.nodes.size,
      lastUpdate: metrics.lastUpdate
    }));
    return;
  }

  // Serve static files
  try {
    let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
    const content = await fs.readFile(filePath);

    const ext = path.extname(filePath);
    const contentTypes = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json'
    };

    res.setHeader('Content-Type', contentTypes[ext] || 'text/plain');
    res.writeHead(200);
    res.end(content);
  } catch (error) {
    res.writeHead(404);
    res.end('Not found');
  }
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 YZ Network - Monitoring Dashboard');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🌐 Dashboard: http://localhost:${PORT}`);
  console.log(`🔄 Scrape Interval: ${SCRAPE_INTERVAL}ms`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Start metrics scraping
  scrapeAllMetrics();  // Immediate first scrape
  setInterval(scrapeAllMetrics, SCRAPE_INTERVAL);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down dashboard...');
  server.close(() => {
    console.log('✅ Dashboard stopped');
    process.exit(0);
  });
});
