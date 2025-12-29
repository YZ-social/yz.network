#!/usr/bin/env node

/**
 * Diagnose Bridge DHT State
 * 
 * This script checks what the bridge node sees in its DHT routing table
 * to understand why it reports "No active peers found in DHT network"
 */

import https from 'https';
import http from 'http';

const BASE_URL = 'https://imeyouwe.com';

async function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, { rejectUnauthorized: false }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ raw: data, error: e.message });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

async function checkNodeHealth(nodePath, nodeName) {
  try {
    // Health endpoints are on the metrics port, not the WebSocket path
    // The metrics server runs on port 9090 internally, exposed via nginx
    const url = `${BASE_URL}${nodePath}`;
    console.log(`\n🔍 Checking ${nodeName}: ${url}`);
    
    const health = await fetchJSON(url);
    
    if (health.status === 'healthy') {
      console.log(`   ✅ Status: ${health.status}`);
      console.log(`   📊 Connected peers: ${health.connectedPeers || 'N/A'}`);
      console.log(`   📋 Routing table: ${health.routingTableSize || 'N/A'} nodes`);
      console.log(`   🆔 Node ID: ${health.nodeId?.substring(0, 12) || 'N/A'}...`);
      
      if (health.connectedPeers !== undefined) {
        return {
          name: nodeName,
          healthy: true,
          connectedPeers: health.connectedPeers,
          routingTableSize: health.routingTableSize || 0,
          nodeId: health.nodeId
        };
      }
    } else {
      console.log(`   ⚠️ Status: ${health.status || 'unknown'}`);
      console.log(`   Raw response:`, JSON.stringify(health).substring(0, 200));
    }
    
    return { name: nodeName, healthy: false, error: health.status || 'unknown' };
  } catch (error) {
    console.log(`   ❌ Error: ${error.message}`);
    return { name: nodeName, healthy: false, error: error.message };
  }
}

async function checkBootstrapServer() {
  try {
    const url = `${BASE_URL}/ws/health`;
    console.log(`\n🔍 Checking Bootstrap Server: ${url}`);
    
    const health = await fetchJSON(url);
    console.log(`   📊 Response:`, JSON.stringify(health));
    
    return health;
  } catch (error) {
    console.log(`   ❌ Error: ${error.message}`);
    return { error: error.message };
  }
}

async function checkBridgeHealth() {
  try {
    const url = `${BASE_URL}/ws/bridge-health`;
    console.log(`\n🔍 Checking Bridge Health: ${url}`);
    
    const health = await fetchJSON(url);
    console.log(`   📊 Response:`, JSON.stringify(health, null, 2));
    
    return health;
  } catch (error) {
    console.log(`   ❌ Error: ${error.message}`);
    return { error: error.message };
  }
}

async function main() {
  console.log('🏥 BRIDGE DHT STATE DIAGNOSIS');
  console.log('==============================');
  console.log(`Time: ${new Date().toISOString()}`);
  
  // Check bootstrap server
  const bootstrapHealth = await checkBootstrapServer();
  
  // Check bridge health endpoint
  const bridgeHealth = await checkBridgeHealth();
  
  // Check all 15 DHT nodes - use metrics endpoints
  const nodeResults = [];
  
  // Genesis node - metrics on port 9091
  nodeResults.push(await checkNodeHealth('/genesis-metrics/health', 'Genesis'));
  
  // Bridge nodes - metrics on ports 9092, 9093
  nodeResults.push(await checkNodeHealth('/bridge1-metrics/health', 'Bridge1'));
  nodeResults.push(await checkNodeHealth('/bridge2-metrics/health', 'Bridge2'));
  
  // DHT nodes 1-12 - metrics on ports 9094-9105
  for (let i = 1; i <= 12; i++) {
    nodeResults.push(await checkNodeHealth(`/node${i}-metrics/health`, `Node${i}`));
  }
  
  // Summary
  console.log('\n📊 SUMMARY');
  console.log('==========');
  
  const healthyNodes = nodeResults.filter(n => n.healthy);
  const unhealthyNodes = nodeResults.filter(n => !n.healthy);
  
  console.log(`Total nodes checked: ${nodeResults.length}`);
  console.log(`Healthy nodes: ${healthyNodes.length}`);
  console.log(`Unhealthy nodes: ${unhealthyNodes.length}`);
  
  if (healthyNodes.length > 0) {
    console.log('\n✅ HEALTHY NODES:');
    for (const node of healthyNodes) {
      console.log(`   ${node.name}: ${node.connectedPeers} peers, ${node.routingTableSize} routing entries`);
    }
  }
  
  if (unhealthyNodes.length > 0) {
    console.log('\n❌ UNHEALTHY NODES:');
    for (const node of unhealthyNodes) {
      console.log(`   ${node.name}: ${node.error}`);
    }
  }
  
  // Calculate total connected peers across all nodes
  const totalConnectedPeers = healthyNodes.reduce((sum, n) => sum + (n.connectedPeers || 0), 0);
  const avgConnectedPeers = healthyNodes.length > 0 ? totalConnectedPeers / healthyNodes.length : 0;
  
  console.log(`\n📈 NETWORK METRICS:`);
  console.log(`   Total connected peer count (sum): ${totalConnectedPeers}`);
  console.log(`   Average peers per node: ${avgConnectedPeers.toFixed(1)}`);
  
  // Analysis
  console.log('\n💡 ANALYSIS:');
  
  if (healthyNodes.length === 0) {
    console.log('   🚨 CRITICAL: No healthy nodes found!');
    console.log('      - Check if Docker containers are running');
    console.log('      - Check nginx proxy configuration');
    console.log('      - Check container logs for errors');
  } else if (avgConnectedPeers < 2) {
    console.log('   ⚠️ LOW CONNECTIVITY: Nodes have very few peer connections');
    console.log('      - This explains why bridge findNode returns 0 peers');
    console.log('      - Nodes may not be connecting to each other properly');
    console.log('      - Check WebSocket connection establishment between nodes');
  } else if (healthyNodes.length < 10) {
    console.log('   ⚠️ PARTIAL FAILURE: Some nodes are unhealthy');
    console.log('      - Check container logs for unhealthy nodes');
    console.log('      - May need to restart specific containers');
  } else {
    console.log('   ✅ Network appears healthy');
    console.log('      - If browser still can\'t connect, issue may be with bootstrap coordination');
  }
  
  // Check if bridge nodes specifically have peers
  const bridgeNodes = healthyNodes.filter(n => n.name.startsWith('Bridge'));
  if (bridgeNodes.length > 0) {
    console.log('\n🌉 BRIDGE NODE STATUS:');
    for (const bridge of bridgeNodes) {
      console.log(`   ${bridge.name}: ${bridge.connectedPeers} connected peers, ${bridge.routingTableSize} routing entries`);
      if (bridge.connectedPeers === 0) {
        console.log(`      ⚠️ Bridge has 0 connected peers - this is why findNode fails!`);
      }
    }
  }
}

main().catch(console.error);
