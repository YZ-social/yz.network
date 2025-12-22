#!/usr/bin/env node

/**
 * Test the bridge connection pool directly
 * This script tests if the connection pool can connect to bridge nodes
 */

import { BridgeConnectionPool } from '../src/bridge/BridgeConnectionPool.js';

async function testConnectionPool() {
  console.log('🧪 Testing Bridge Connection Pool');
  console.log('=================================');
  
  // Test with the same addresses that should be used in production
  const bridgeNodes = [
    'ws://yz-bridge-node-1:8083',
    'ws://yz-bridge-node-2:8084'
  ];
  
  const authToken = process.env.BRIDGE_AUTH || 'default-bridge-auth-key';
  
  console.log('Bridge Nodes:', bridgeNodes);
  console.log('Auth Token:', authToken.substring(0, 8) + '...');
  
  try {
    // Create connection pool
    console.log('\n🏊 Creating connection pool...');
    const pool = new BridgeConnectionPool(bridgeNodes, authToken, {
      maxReconnectAttempts: 3,
      idleTimeout: 60000, // 1 minute for testing
      healthCheckInterval: 10000, // 10 seconds
      requestTimeout: 5000
    });
    
    // Set up event listeners
    pool.on('connectionReady', (bridgeAddr) => {
      console.log(`✅ Connection ready: ${bridgeAddr}`);
    });
    
    pool.on('connectionLost', (bridgeAddr) => {
      console.log(`🔌 Connection lost: ${bridgeAddr}`);
    });
    
    pool.on('connectionFailed', (bridgeAddr) => {
      console.log(`❌ Connection failed: ${bridgeAddr}`);
    });
    
    // Initialize connections
    console.log('🚀 Initializing connections...');
    await pool.initialize();
    
    // Wait a bit for connections to establish
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Check statistics
    const stats = pool.getStats();
    console.log('\n📊 Connection Pool Statistics:');
    console.log(`Total bridges: ${stats.totalBridges}`);
    console.log(`Ready connections: ${stats.readyConnections}`);
    console.log(`Success rate: ${(stats.requests.successRate * 100).toFixed(1)}%`);
    
    // Show individual connection status
    console.log('\n🔗 Individual Connection Status:');
    for (const [addr, connStats] of Object.entries(stats.connectionStats)) {
      console.log(`${addr}:`);
      console.log(`   State: ${connStats.state}`);
      console.log(`   Attempts: ${connStats.connectAttempts}`);
      console.log(`   Last Activity: ${connStats.lastActivity ? new Date(connStats.lastActivity).toISOString() : 'Never'}`);
    }
    
    // Try to send a test request if any connections are ready
    if (stats.readyConnections > 0) {
      console.log('\n📤 Testing request sending...');
      try {
        const result = await pool.sendRequest({
          type: 'get_onboarding_peer',
          newNodeId: 'test-node-' + Date.now(),
          newNodeMetadata: { nodeType: 'test' }
        });
        console.log('✅ Request successful:', result);
      } catch (error) {
        console.log('❌ Request failed:', error.message);
      }
    } else {
      console.log('❌ No ready connections available for testing requests');
    }
    
    // Cleanup
    console.log('\n🛑 Shutting down connection pool...');
    await pool.shutdown();
    console.log('✅ Test completed');
    
  } catch (error) {
    console.error('❌ Connection pool test failed:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Received SIGINT, shutting down...');
  process.exit(0);
});

testConnectionPool().catch(error => {
  console.error('❌ Test execution failed:', error);
  process.exit(1);
});