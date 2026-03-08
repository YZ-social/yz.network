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
  server: {
    cpu: { usage: 0, cores: 0 },
    memory: { total: 0, used: 0, free: 0, usedPercent: 0 },
    disk: { total: 0, used: 0, free: 0, usedPercent: 0 },
    uptime: 0
  },
  serverHistory: [],  // Time-series for server stats (memory trend)
  lastUpdate: null,
  history: []  // Time-series data for charts
};

/**
 * Collect server stats (CPU, Memory, Disk)
 * Uses Docker host stats when running in container
 */
async function collectServerStats() {
  try {
    // Get CPU info
    const cpuStats = await getCPUStats();
    
    // Get memory info from /proc/meminfo (works in Docker with host access)
    const memStats = await getMemoryStats();
    
    // Get disk info
    const diskStats = await getDiskStats();
    
    // Get uptime
    const uptime = await getUptime();
    
    metrics.server = {
      cpu: cpuStats,
      memory: memStats,
      disk: diskStats,
      uptime: uptime
    };
    
    // Add to server history (keep last 60 data points = 10 minutes at 10s interval)
    metrics.serverHistory.push({
      timestamp: Date.now(),
      memoryUsedPercent: memStats.usedPercent,
      memoryUsedMB: Math.round(memStats.used / (1024 * 1024)),
      cpuUsage: cpuStats.usage,
      diskUsedPercent: diskStats.usedPercent
    });
    
    if (metrics.serverHistory.length > 60) {
      metrics.serverHistory.shift();
    }
    
    console.log(`📈 Server stats: CPU ${cpuStats.usage.toFixed(1)}%, Memory ${memStats.usedPercent.toFixed(1)}%, Disk ${diskStats.usedPercent.toFixed(1)}%`);
  } catch (error) {
    console.error('Error collecting server stats:', error.message);
  }
}

/**
 * Get CPU usage stats
 */
async function getCPUStats() {
  try {
    // Get CPU info from /proc/stat
    const { stdout: statOutput } = await execAsync('cat /proc/stat | head -1');
    const cpuLine = statOutput.trim().split(/\s+/);
    
    // cpu user nice system idle iowait irq softirq steal guest guest_nice
    const user = parseInt(cpuLine[1]) || 0;
    const nice = parseInt(cpuLine[2]) || 0;
    const system = parseInt(cpuLine[3]) || 0;
    const idle = parseInt(cpuLine[4]) || 0;
    const iowait = parseInt(cpuLine[5]) || 0;
    
    const total = user + nice + system + idle + iowait;
    const used = user + nice + system + iowait;
    const usage = total > 0 ? (used / total) * 100 : 0;
    
    // Get number of CPU cores
    const { stdout: cpuInfo } = await execAsync('nproc 2>/dev/null || echo 1');
    const cores = parseInt(cpuInfo.trim()) || 1;
    
    return { usage, cores };
  } catch (error) {
    console.warn('Failed to get CPU stats:', error.message);
    return { usage: 0, cores: 1 };
  }
}

/**
 * Get memory stats
 */
async function getMemoryStats() {
  try {
    const { stdout } = await execAsync('cat /proc/meminfo');
    const lines = stdout.split('\n');
    
    let total = 0, free = 0, available = 0, buffers = 0, cached = 0;
    
    for (const line of lines) {
      const parts = line.split(':');
      if (parts.length < 2) continue;
      
      const key = parts[0].trim();
      const value = parseInt(parts[1].trim()) * 1024; // Convert from KB to bytes
      
      switch (key) {
        case 'MemTotal': total = value; break;
        case 'MemFree': free = value; break;
        case 'MemAvailable': available = value; break;
        case 'Buffers': buffers = value; break;
        case 'Cached': cached = value; break;
      }
    }
    
    // Calculate used memory (excluding buffers/cache for more accurate "real" usage)
    const used = total - available;
    const usedPercent = total > 0 ? (used / total) * 100 : 0;
    
    return {
      total,
      used,
      free: available,
      usedPercent,
      buffers,
      cached
    };
  } catch (error) {
    console.warn('Failed to get memory stats:', error.message);
    return { total: 0, used: 0, free: 0, usedPercent: 0 };
  }
}

/**
 * Get disk stats
 */
async function getDiskStats() {
  try {
    // Get disk usage for root filesystem
    const { stdout } = await execAsync("df -B1 / | tail -1");
    const parts = stdout.trim().split(/\s+/);
    
    // Format: Filesystem 1B-blocks Used Available Use% Mounted
    const total = parseInt(parts[1]) || 0;
    const used = parseInt(parts[2]) || 0;
    const free = parseInt(parts[3]) || 0;
    const usedPercent = parseFloat(parts[4]) || 0;
    
    return { total, used, free, usedPercent };
  } catch (error) {
    console.warn('Failed to get disk stats:', error.message);
    return { total: 0, used: 0, free: 0, usedPercent: 0 };
  }
}

/**
 * Get system uptime
 */
async function getUptime() {
  try {
    const { stdout } = await execAsync('cat /proc/uptime');
    return parseFloat(stdout.split(' ')[0]) || 0;
  } catch (error) {
    return 0;
  }
}

/**
 * Discover all DHT node containers
 */
async function discoverNodes() {
  try {
    // First, let's see what containers are actually running
    console.log('🔍 Checking all running containers...');
    const { stdout: allContainers } = await execAsync('docker ps --format "{{.Names}}"');
    console.log('All running containers:', allContainers.trim().split('\n'));

    // Find all containers running DHT nodes - use simpler approach
    const { stdout } = await execAsync(
      'docker ps --filter "name=yz-dht-node" --format "{{.Names}}"'
    );

    console.log('DEBUG: DHT node search stdout =', JSON.stringify(stdout));
    console.log('DEBUG: stdout length =', stdout.length);

    if (stdout.trim().length === 0) {
      console.log('⚠️ No DHT nodes found. Trying broader search...');
      
      // Try broader search patterns
      const patterns = ['dht-node', 'yz-', 'node'];
      for (const pattern of patterns) {
        const { stdout: broadStdout } = await execAsync(
          `docker ps --filter "name=${pattern}" --format "{{.Names}}:{{.Ports}}"`
        );
        if (broadStdout.trim().length > 0) {
          console.log(`Found containers with pattern "${pattern}":`, broadStdout.trim());
        }
      }
      return [];
    }

    const containerNames = stdout.trim().split('\n').filter(Boolean);
    console.log('DEBUG: container names =', containerNames);
    console.log('DEBUG: container count =', containerNames.length);

    const nodes = [];

    for (const name of containerNames) {
      console.log('DEBUG: processing container =', name);
      
      // For now, use default metrics port 9090 (internal port)
      // We can get the external port later if needed
      nodes.push({
        name: name.trim(),
        host: name.trim(),  // Docker container name is DNS name
        port: 9090,  // Internal port
        metricsUrl: `http://${name.trim()}:9090/metrics`
      });
    }

    console.log('DEBUG: final nodes array =', nodes);
    return nodes;
  } catch (error) {
    console.error('Error discovering nodes:', error.message);
    console.error('Error stack:', error.stack);
    return [];
  }
}

/**
 * Fetch metrics from a single node
 */
async function fetchNodeMetrics(node) {
  try {
    console.log(`📊 Fetching metrics from ${node.name} at ${node.metricsUrl}`);
    
    const response = await fetch(node.metricsUrl, {
      signal: AbortSignal.timeout(5000)
    });

    console.log(`📊 Response from ${node.name}: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    console.log(`✅ Successfully fetched metrics from ${node.name}`);
    
    return {
      ...data,
      nodeName: node.name,
      timestamp: Date.now(),
      healthy: data.node_healthy === 1
    };
  } catch (error) {
    console.warn(`❌ Failed to fetch metrics from ${node.name}:`, error.message);
    
    // Try health endpoint as fallback
    try {
      console.log(`🔄 Trying health endpoint for ${node.name}...`);
      const healthUrl = node.metricsUrl.replace('/metrics', '/health');
      const healthResponse = await fetch(healthUrl, {
        signal: AbortSignal.timeout(3000)
      });
      
      if (healthResponse.ok) {
        console.log(`✅ Health endpoint accessible for ${node.name}`);
        const healthData = await healthResponse.json();
        return {
          nodeName: node.name,
          timestamp: Date.now(),
          healthy: healthData.healthy || false,
          error: 'Metrics endpoint failed, using health data',
          node_healthy: healthData.healthy ? 1 : 0,
          dht_connected_peers: healthData.connectedPeers || 0
        };
      }
    } catch (healthError) {
      console.warn(`❌ Health endpoint also failed for ${node.name}:`, healthError.message);
    }
    
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
  
  // Collect server stats
  await collectServerStats();

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

    // Connection stability statistics
    totalConnectionsEstablished: healthyNodes.reduce((sum, n) => sum + (n.connections_established_total || 0), 0),
    totalConnectionsLost: healthyNodes.reduce((sum, n) => sum + (n.connections_lost_total || 0), 0),
    totalConnectionChurn: healthyNodes.reduce((sum, n) => sum + (n.connection_churn_per_minute || 0), 0),
    avgChurnPerNode: healthyNodes.length > 0
      ? healthyNodes.reduce((sum, n) => sum + (n.connection_churn_per_minute || 0), 0) / healthyNodes.length
      : 0,
    peakConnections: Math.max(...healthyNodes.map(n => n.peak_connections || 0), 0),
    avgStabilityRatio: healthyNodes.length > 0
      ? healthyNodes.reduce((sum, n) => sum + (parseFloat(n.connection_stability_ratio) || 100), 0) / healthyNodes.length
      : 100,

    // DHT operation statistics
    totalDHTOps: healthyNodes.reduce((sum, n) =>
      sum + (n.dht_store_operations_total || 0) + (n.dht_get_operations_total || 0) + (n.dht_findnode_operations_total || 0), 0),

    // PubSub operation statistics
    totalPubSubOps: healthyNodes.reduce((sum, n) =>
      sum + (n.pubsub_publish_operations_total || 0) + (n.pubsub_subscribe_operations_total || 0), 0),

    // Data transfer statistics (bytes)
    totalBytesReceived: healthyNodes.reduce((sum, n) => sum + (n.data_bytes_received_total || 0), 0),
    totalBytesSent: healthyNodes.reduce((sum, n) => sum + (n.data_bytes_sent_total || 0), 0),
    avgBytesReceivedPerSecond: healthyNodes.length > 0
      ? healthyNodes.reduce((sum, n) => sum + (n.data_bytes_received_per_second || 0), 0) / healthyNodes.length
      : 0,
    avgBytesSentPerSecond: healthyNodes.length > 0
      ? healthyNodes.reduce((sum, n) => sum + (n.data_bytes_sent_per_second || 0), 0) / healthyNodes.length
      : 0,

    // Average latencies
    avgLatencyP50: healthyNodes.length > 0
      ? healthyNodes.reduce((sum, n) => sum + (n.ping_latency_p50 || 0), 0) / healthyNodes.length
      : 0,
    avgLatencyP95: healthyNodes.length > 0
      ? healthyNodes.reduce((sum, n) => sum + (n.ping_latency_p95 || 0), 0) / healthyNodes.length
      : 0,
    avgLatencyP99: healthyNodes.length > 0
      ? healthyNodes.reduce((sum, n) => sum + (n.ping_latency_p99 || 0), 0) / healthyNodes.length
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

  if (req.url === '/api/server') {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({
      server: metrics.server,
      history: metrics.serverHistory
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
