#!/usr/bin/env node

/**
 * Oracle YZ Node Mesh Formation Debugger
 * 
 * This script diagnoses why 13 out of 15 Oracle YZ nodes are unhealthy.
 * It tests:
 * 1. Direct container-to-container connectivity within Docker network
 * 2. Nginx proxy routing for /nodeX paths
 * 3. Whether nodes can reach their own advertised addresses
 * 4. Why bridge node shows connections but DHT nodes can't connect
 * 5. Manual WebSocket connections to specific node endpoints
 */

import WebSocket from 'ws';
import http from 'http';
import https from 'https';

const BOOTSTRAP_URL = 'wss://imeyouwe.com/ws';
const BASE_URL = 'https://imeyouwe.com';

// Node configuration matching docker-compose.nodes.yml
const NODES = [
  { name: 'genesis', path: '/genesis', internalPort: 8085, metricsPort: 9095 },
  { name: 'bridge-1', path: '/bridge1', internalPort: 8083, metricsPort: 9083 },
  { name: 'bridge-2', path: '/bridge2', internalPort: 8084, metricsPort: 9084 },
  ...Array.from({ length: 15 }, (_, i) => ({
    name: `node-${i + 1}`,
    path: `/node${i + 1}`,
    internalPort: 8086 + i,
    metricsPort: 9096 + i
  }))
];

console.log('🔍 Oracle YZ Node Mesh Formation Debugger');
console.log('=========================================\n');

/**
 * Test HTTP endpoint
 */
async function testHttpEndpoint(url, timeout = 10000) {
  return new Promise((resolve) => {
    const isHttps = url.startsWith('https');
    const client = isHttps ? https : http;
    
    const req = client.get(url, { timeout }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ success: true, status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ success: true, status: res.statusCode, data });
        }
      });
    });
    
    req.on('error', (error) => {
      resolve({ success: false, error: error.message });
    });
    
    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, error: 'Timeout' });
    });
  });
}

/**
 * Test WebSocket connection
 */
async function testWebSocketConnection(url, timeout = 10000) {
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(url, {
        handshakeTimeout: timeout,
        headers: {
          'User-Agent': 'YZ-Mesh-Debugger/1.0'
        }
      });
      
      const timeoutId = setTimeout(() => {
        ws.terminate();
        resolve({ success: false, error: 'Connection timeout' });
      }, timeout);
      
      ws.on('open', () => {
        clearTimeout(timeoutId);
        ws.close();
        resolve({ success: true, message: 'Connected successfully' });
      });
      
      ws.on('error', (error) => {
        clearTimeout(timeoutId);
        resolve({ success: false, error: error.message });
      });
      
      ws.on('unexpected-response', (req, res) => {
        clearTimeout(timeoutId);
        resolve({ success: false, error: `Unexpected response: ${res.statusCode}` });
      });
    } catch (error) {
      resolve({ success: false, error: error.message });
    }
  });
}

/**
 * Test node health endpoint
 */
async function testNodeHealth(node) {
  const healthUrl = `${BASE_URL}${node.path}/health`;
  const result = await testHttpEndpoint(healthUrl, 5000);
  
  return {
    node: node.name,
    path: node.path,
    healthUrl,
    ...result
  };
}

/**
 * Test WebSocket connection to node
 */
async function testNodeWebSocket(node) {
  const wsUrl = `wss://imeyouwe.com${node.path}`;
  const result = await testWebSocketConnection(wsUrl, 10000);
  
  return {
    node: node.name,
    path: node.path,
    wsUrl,
    ...result
  };
}

/**
 * Get node status from metrics endpoint
 */
async function getNodeStatus(node) {
  const statusUrl = `${BASE_URL}${node.path}/status`;
  const result = await testHttpEndpoint(statusUrl, 5000);
  
  return {
    node: node.name,
    path: node.path,
    statusUrl,
    ...result
  };
}

/**
 * Test bootstrap server connectivity
 */
async function testBootstrapServer() {
  console.log('📡 Testing Bootstrap Server...');
  console.log('------------------------------');
  
  // Test health endpoint
  const healthResult = await testHttpEndpoint(`${BASE_URL}/ws/health`, 5000);
  console.log(`   Health: ${healthResult.success ? '✅' : '❌'} ${healthResult.success ? healthResult.status : healthResult.error}`);
  
  // Test WebSocket connection
  const wsResult = await testWebSocketConnection(BOOTSTRAP_URL, 10000);
  console.log(`   WebSocket: ${wsResult.success ? '✅' : '❌'} ${wsResult.success ? wsResult.message : wsResult.error}`);
  
  // Test bridge health
  const bridgeHealthResult = await testHttpEndpoint(`${BASE_URL}/bridge-health`, 5000);
  if (bridgeHealthResult.success && bridgeHealthResult.data) {
    console.log(`   Bridge Health: ✅`);
    if (bridgeHealthResult.data.bridgeAvailability) {
      console.log(`      Available: ${bridgeHealthResult.data.bridgeAvailability.available}/${bridgeHealthResult.data.bridgeAvailability.total}`);
    }
    if (bridgeHealthResult.data.bridges) {
      for (const bridge of bridgeHealthResult.data.bridges) {
        console.log(`      ${bridge.name}: ${bridge.healthy ? '✅' : '❌'} (${bridge.connections || 0} connections)`);
      }
    }
  } else {
    console.log(`   Bridge Health: ❌ ${bridgeHealthResult.error || 'No data'}`);
  }
  
  return { healthResult, wsResult, bridgeHealthResult };
}

/**
 * Test all node health endpoints
 */
async function testAllNodeHealth() {
  console.log('\n🏥 Testing Node Health Endpoints...');
  console.log('-----------------------------------');
  
  const results = {
    healthy: [],
    unhealthy: [],
    unreachable: []
  };
  
  for (const node of NODES) {
    const result = await testNodeHealth(node);
    
    if (!result.success) {
      results.unreachable.push(result);
      console.log(`   ❌ ${node.name}: Unreachable (${result.error})`);
    } else if (result.data && result.data.healthy) {
      results.healthy.push(result);
      console.log(`   ✅ ${node.name}: Healthy (${result.data.connectedPeers || 0} peers)`);
    } else {
      results.unhealthy.push(result);
      const peers = result.data?.connectedPeers || 0;
      const bootstrap = result.data?.bootstrapConnected ? 'bootstrap ✓' : 'bootstrap ✗';
      console.log(`   ⚠️ ${node.name}: Unhealthy (${peers} peers, ${bootstrap})`);
    }
  }
  
  console.log(`\n   Summary: ${results.healthy.length} healthy, ${results.unhealthy.length} unhealthy, ${results.unreachable.length} unreachable`);
  
  return results;
}

/**
 * Test WebSocket connections to all nodes
 */
async function testAllNodeWebSockets() {
  console.log('\n🔌 Testing WebSocket Connections to Nodes...');
  console.log('--------------------------------------------');
  
  const results = {
    connected: [],
    failed: []
  };
  
  for (const node of NODES) {
    const result = await testNodeWebSocket(node);
    
    if (result.success) {
      results.connected.push(result);
      console.log(`   ✅ ${node.name}: WebSocket OK`);
    } else {
      results.failed.push(result);
      console.log(`   ❌ ${node.name}: ${result.error}`);
    }
  }
  
  console.log(`\n   Summary: ${results.connected.length} connected, ${results.failed.length} failed`);
  
  return results;
}

/**
 * Get detailed status from all nodes
 */
async function getAllNodeStatus() {
  console.log('\n📊 Getting Detailed Node Status...');
  console.log('----------------------------------');
  
  const statuses = [];
  
  for (const node of NODES) {
    const result = await getNodeStatus(node);
    statuses.push(result);
    
    if (result.success && result.data) {
      const dht = result.data.dht || {};
      const health = result.data.health || {};
      console.log(`   ${node.name}:`);
      console.log(`      Node ID: ${result.data.nodeId || 'unknown'}`);
      console.log(`      Connected Peers: ${dht.connectedPeers || 0}`);
      console.log(`      Routing Table: ${dht.routingTableSize || 0} nodes`);
      console.log(`      Healthy: ${health.isHealthy ? '✅' : '❌'}`);
    } else {
      console.log(`   ${node.name}: ❌ ${result.error || 'No status data'}`);
    }
  }
  
  return statuses;
}

/**
 * Analyze connection patterns
 */
async function analyzeConnectionPatterns(statuses) {
  console.log('\n🔍 Analyzing Connection Patterns...');
  console.log('-----------------------------------');
  
  const nodeIds = new Map();
  const connectionCounts = [];
  
  for (const status of statuses) {
    if (status.success && status.data) {
      const nodeId = status.data.nodeId;
      const connectedPeers = status.data.dht?.connectedPeers || 0;
      
      if (nodeId) {
        nodeIds.set(status.node, nodeId);
      }
      connectionCounts.push({ node: status.node, connections: connectedPeers });
    }
  }
  
  // Sort by connection count
  connectionCounts.sort((a, b) => b.connections - a.connections);
  
  console.log('   Connection Distribution:');
  for (const { node, connections } of connectionCounts) {
    const bar = '█'.repeat(Math.min(connections, 20));
    console.log(`      ${node.padEnd(12)}: ${connections.toString().padStart(2)} ${bar}`);
  }
  
  const totalConnections = connectionCounts.reduce((sum, c) => sum + c.connections, 0);
  const avgConnections = totalConnections / connectionCounts.length;
  const nodesWithConnections = connectionCounts.filter(c => c.connections > 0).length;
  
  console.log(`\n   Total Connections: ${totalConnections}`);
  console.log(`   Average per Node: ${avgConnections.toFixed(1)}`);
  console.log(`   Nodes with Connections: ${nodesWithConnections}/${connectionCounts.length}`);
  
  // Identify isolated nodes
  const isolatedNodes = connectionCounts.filter(c => c.connections === 0);
  if (isolatedNodes.length > 0) {
    console.log(`\n   ⚠️ Isolated Nodes (0 connections):`);
    for (const { node } of isolatedNodes) {
      console.log(`      - ${node}`);
    }
  }
  
  return { nodeIds, connectionCounts, avgConnections, isolatedNodes };
}

/**
 * Test if nodes can connect to each other via external addresses
 */
async function testCrossNodeConnectivity() {
  console.log('\n🔗 Testing Cross-Node Connectivity...');
  console.log('-------------------------------------');
  console.log('   (Testing if nodes can reach each other via wss://imeyouwe.com/nodeX)');
  
  // Pick a few representative nodes to test
  const testPairs = [
    { from: 'node-1', to: 'node-2' },
    { from: 'node-1', to: 'genesis' },
    { from: 'genesis', to: 'bridge-1' },
    { from: 'node-5', to: 'node-10' }
  ];
  
  for (const pair of testPairs) {
    const fromNode = NODES.find(n => n.name === pair.from);
    const toNode = NODES.find(n => n.name === pair.to);
    
    if (!fromNode || !toNode) continue;
    
    // Test if we can connect to the target node's WebSocket
    const wsUrl = `wss://imeyouwe.com${toNode.path}`;
    const result = await testWebSocketConnection(wsUrl, 5000);
    
    console.log(`   ${pair.from} → ${pair.to}: ${result.success ? '✅' : '❌'} ${result.success ? 'OK' : result.error}`);
  }
}

/**
 * Main diagnostic function
 */
async function main() {
  console.log('🚀 Starting Oracle YZ Mesh Formation Diagnostics...\n');
  
  // Test bootstrap server first
  await testBootstrapServer();
  
  // Test all node health endpoints
  const healthResults = await testAllNodeHealth();
  
  // Test WebSocket connections to all nodes
  const wsResults = await testAllNodeWebSockets();
  
  // Get detailed status from all nodes
  const statuses = await getAllNodeStatus();
  
  // Analyze connection patterns
  const analysis = await analyzeConnectionPatterns(statuses);
  
  // Test cross-node connectivity
  await testCrossNodeConnectivity();
  
  // Generate diagnosis
  console.log('\n🎯 DIAGNOSIS');
  console.log('============');
  
  const healthyCount = healthResults.healthy.length;
  const unhealthyCount = healthResults.unhealthy.length;
  const unreachableCount = healthResults.unreachable.length;
  const totalNodes = NODES.length;
  
  if (unreachableCount > 0) {
    console.log(`\n❌ CRITICAL: ${unreachableCount} nodes are unreachable`);
    console.log('   Possible causes:');
    console.log('   - Docker containers not running');
    console.log('   - Nginx proxy misconfiguration');
    console.log('   - Network connectivity issues');
    console.log('   - SSL certificate problems');
  }
  
  if (unhealthyCount > totalNodes * 0.5) {
    console.log(`\n⚠️ WARNING: ${unhealthyCount}/${totalNodes} nodes are unhealthy`);
    console.log('   Possible causes:');
    console.log('   - Nodes cannot connect to each other');
    console.log('   - Bootstrap coordination failing');
    console.log('   - Internal Docker networking issues');
    console.log('   - Nodes using external addresses for internal connections');
  }
  
  if (analysis.isolatedNodes.length > 0) {
    console.log(`\n🔴 ISOLATED NODES: ${analysis.isolatedNodes.length} nodes have 0 connections`);
    console.log('   This is the core problem - nodes are not forming a mesh.');
    console.log('   Likely causes:');
    console.log('   1. Nodes advertise wss://imeyouwe.com/nodeX but cannot connect to it');
    console.log('   2. Internal Docker DNS resolution failing');
    console.log('   3. Bootstrap server not coordinating peer introductions');
    console.log('   4. Connection manager not establishing connections');
  }
  
  if (analysis.avgConnections < 2) {
    console.log(`\n⚠️ LOW CONNECTIVITY: Average ${analysis.avgConnections.toFixed(1)} connections per node`);
    console.log('   Target is 3-8 connections per node for healthy DHT operation.');
  }
  
  console.log('\n💡 RECOMMENDED ACTIONS:');
  console.log('------------------------');
  
  if (unreachableCount > 0) {
    console.log('1. Check Docker container status: docker ps | grep yz-');
    console.log('2. Check nginx logs: docker logs yz-webserver');
    console.log('3. Verify SSL certificates are valid');
  }
  
  if (analysis.isolatedNodes.length > 0) {
    console.log('1. Check if nodes can resolve internal Docker hostnames');
    console.log('2. Verify bootstrap server is coordinating peer introductions');
    console.log('3. Check if nodes should use internal addresses for Docker-to-Docker connections');
    console.log('4. Review connection manager logs for connection failures');
  }
  
  console.log('\n🔧 DEBUGGING COMMANDS:');
  console.log('-----------------------');
  console.log('# Check container logs for a specific node:');
  console.log('docker logs yz-dht-node-1 --tail 100');
  console.log('');
  console.log('# Check bootstrap server logs:');
  console.log('docker logs yz-bootstrap-server --tail 100');
  console.log('');
  console.log('# Test internal Docker connectivity:');
  console.log('docker exec yz-dht-node-1 wget -qO- http://dht-node-2:8087/health');
  console.log('');
  console.log('# Restart all DHT nodes:');
  console.log('docker-compose -f docker-compose.production.yml -f docker-compose.nodes.yml restart');
}

// Run diagnostics
main().catch(error => {
  console.error('❌ Diagnostic failed:', error);
  process.exit(1);
});
