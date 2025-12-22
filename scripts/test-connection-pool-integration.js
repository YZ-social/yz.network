#!/usr/bin/env node

/**
 * Test script to verify connection pool integration with bootstrap server
 * This script tests the basic functionality without requiring full bridge nodes
 */

import { BridgeConnectionPool } from '../src/bridge/BridgeConnectionPool.js';
import { EnhancedBootstrapServer } from '../src/bridge/EnhancedBootstrapServer.js';

async function testConnectionPoolIntegration() {
  console.log('🧪 Testing Connection Pool Integration');
  console.log('=====================================');

  // Test 1: BridgeConnectionPool creation
  console.log('\n1. Testing BridgeConnectionPool creation...');
  try {
    const pool = new BridgeConnectionPool(
      ['localhost:8083', 'localhost:8084'],
      'test-auth-token',
      {
        maxReconnectAttempts: 3,
        idleTimeout: 60000, // 1 minute for testing
        healthCheckInterval: 10000, // 10 seconds for testing
        requestTimeout: 5000
      }
    );
    
    console.log('✅ BridgeConnectionPool created successfully');
    
    // Test pool statistics
    const stats = pool.getStats();
    console.log(`   - Total connections: ${stats.totalConnections}`);
    console.log(`   - Success rate: ${stats.successRate}%`);
    
    // Cleanup
    pool.shutdown();
    console.log('✅ BridgeConnectionPool shutdown successfully');
    
  } catch (error) {
    console.error('❌ BridgeConnectionPool test failed:', error.message);
    return false;
  }

  // Test 2: EnhancedBootstrapServer with connection pool
  console.log('\n2. Testing EnhancedBootstrapServer with connection pool...');
  try {
    const server = new EnhancedBootstrapServer({
      port: 0, // Use random available port
      bridgeNodes: ['localhost:8083', 'localhost:8084'],
      bridgeAuth: 'test-auth-token',
      bridgeTimeout: 5000
    });
    
    console.log('✅ EnhancedBootstrapServer created with connection pool');
    
    // Verify connection pool is initialized
    if (server.bridgePool) {
      console.log('✅ Bridge connection pool is properly initialized');
      const poolStats = server.bridgePool.getStats();
      console.log(`   - Pool has ${poolStats.totalConnections} configured connections`);
    } else {
      console.error('❌ Bridge connection pool not initialized');
      return false;
    }
    
    console.log('✅ EnhancedBootstrapServer integration test passed');
    
  } catch (error) {
    console.error('❌ EnhancedBootstrapServer test failed:', error.message);
    return false;
  }

  // Test 3: Request multiplexing components
  console.log('\n3. Testing request multiplexing components...');
  try {
    const { RequestMultiplexer } = await import('../src/bridge/RequestMultiplexer.js');
    
    const multiplexer = new RequestMultiplexer({
      nodeId: 'test-bootstrap',
      defaultTimeout: 5000
    });
    
    console.log('✅ RequestMultiplexer created successfully');
    
    // Test statistics
    const stats = multiplexer.getStats();
    console.log(`   - Node ID: ${stats.nodeId}`);
    console.log(`   - Queue length: ${stats.queue.queueLength}`);
    console.log(`   - Pending requests: ${stats.responses.pendingRequests}`);
    
    // Cleanup
    multiplexer.shutdown();
    console.log('✅ RequestMultiplexer shutdown successfully');
    
  } catch (error) {
    console.error('❌ RequestMultiplexer test failed:', error.message);
    return false;
  }

  console.log('\n🎉 All connection pool integration tests passed!');
  console.log('\nNext steps:');
  console.log('- Deploy the updated bootstrap server');
  console.log('- Monitor connection count reduction (558+ → 2)');
  console.log('- Verify bridge nodes can discover DHT peers');
  console.log('- Test onboarding performance improvement');
  
  return true;
}

// Run the test
testConnectionPoolIntegration()
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error('❌ Test execution failed:', error);
    process.exit(1);
  });