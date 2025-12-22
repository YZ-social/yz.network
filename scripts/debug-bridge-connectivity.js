#!/usr/bin/env node

/**
 * Debug bridge connectivity issues
 * Run this on the Oracle server to diagnose connection pool problems
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function checkContainerStatus() {
  console.log('🔍 Checking container status...');
  
  try {
    const { stdout } = await execAsync('docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"');
    console.log(stdout);
  } catch (error) {
    console.error('❌ Error checking containers:', error.message);
  }
}

async function checkBootstrapLogs() {
  console.log('\n📋 Bootstrap Server - Connection Pool Messages:');
  
  try {
    const { stdout } = await execAsync('docker logs yz-bootstrap-server --tail 100');
    
    // Filter for connection pool related messages
    const relevantLines = stdout.split('\n').filter(line => 
      line.includes('Bridge Connection Pool') ||
      line.includes('connection pool') ||
      line.includes('Connecting to bridge') ||
      line.includes('ws://yz-bridge-node') ||
      line.includes('🔗') ||
      line.includes('🏊') ||
      line.includes('bridge') ||
      line.includes('BRIDGE_NODE')
    );
    
    if (relevantLines.length > 0) {
      relevantLines.forEach(line => console.log(`   ${line}`));
    } else {
      console.log('❌ No connection pool messages found');
      
      // Show last 20 lines to see what's actually happening
      console.log('\n📋 Last 20 lines of bootstrap logs:');
      const lastLines = stdout.split('\n').slice(-20);
      lastLines.forEach(line => console.log(`   ${line}`));
    }
    
  } catch (error) {
    console.error('❌ Error checking bootstrap logs:', error.message);
  }
}

async function testDirectConnection() {
  console.log('\n🔍 Testing direct WebSocket connections...');
  
  try {
    // Test if we can reach bridge nodes from bootstrap container
    console.log('Testing ws://yz-bridge-node-1:8083...');
    const test1 = await execAsync('docker exec yz-bootstrap-server timeout 5 nc -z yz-bridge-node-1 8083 && echo "REACHABLE" || echo "UNREACHABLE"');
    console.log(`   Bridge Node 1 (port 8083): ${test1.stdout.trim()}`);
    
    console.log('Testing ws://yz-bridge-node-2:8084...');
    const test2 = await execAsync('docker exec yz-bootstrap-server timeout 5 nc -z yz-bridge-node-2 8084 && echo "REACHABLE" || echo "UNREACHABLE"');
    console.log(`   Bridge Node 2 (port 8084): ${test2.stdout.trim()}`);
    
  } catch (error) {
    console.error('❌ Error testing connections:', error.message);
  }
}

async function checkBridgeNodeLogs() {
  console.log('\n🌉 Bridge Node Connection Messages:');
  
  try {
    console.log('Bridge Node 1:');
    const { stdout: logs1 } = await execAsync('docker logs yz-bridge-node-1 --tail 50');
    const relevant1 = logs1.split('\n').filter(line =>
      line.includes('bootstrap') ||
      line.includes('WebSocket') ||
      line.includes('connection') ||
      line.includes('auth') ||
      line.includes('listening')
    );
    
    if (relevant1.length > 0) {
      relevant1.forEach(line => console.log(`   ${line}`));
    } else {
      console.log('   No connection messages found');
    }
    
    console.log('\nBridge Node 2:');
    const { stdout: logs2 } = await execAsync('docker logs yz-bridge-node-2 --tail 50');
    const relevant2 = logs2.split('\n').filter(line =>
      line.includes('bootstrap') ||
      line.includes('WebSocket') ||
      line.includes('connection') ||
      line.includes('auth') ||
      line.includes('listening')
    );
    
    if (relevant2.length > 0) {
      relevant2.forEach(line => console.log(`   ${line}`));
    } else {
      console.log('   No connection messages found');
    }
    
  } catch (error) {
    console.error('❌ Error checking bridge logs:', error.message);
  }
}

async function checkEnvironmentConfig() {
  console.log('\n⚙️ Environment Configuration:');
  
  try {
    const { stdout } = await execAsync('docker exec yz-bootstrap-server env | grep -E "(BRIDGE|NODE)" | sort');
    console.log('Bootstrap Environment:');
    stdout.split('\n').forEach(line => {
      if (line.trim()) {
        console.log(`   ${line}`);
      }
    });
  } catch (error) {
    console.error('❌ Error checking environment:', error.message);
  }
}

async function checkHealthEndpoints() {
  console.log('\n🏥 Health Check Results:');
  
  try {
    // Bootstrap health
    const { stdout: health } = await execAsync('curl -s http://localhost:8080/health');
    console.log('Bootstrap Health:', JSON.parse(health));
    
    // Bridge health endpoint (this should show connection pool status)
    const { stdout: bridgeHealth } = await execAsync('curl -s http://localhost:8080/bridge-health');
    const bridgeData = JSON.parse(bridgeHealth);
    console.log('Bridge Health:', bridgeData);
    
    if (bridgeData.bridgeAvailability) {
      console.log(`Available bridges: ${bridgeData.bridgeAvailability.available}/${bridgeData.bridgeAvailability.total}`);
    }
    
  } catch (error) {
    console.error('❌ Error checking health endpoints:', error.message);
  }
}

async function main() {
  console.log('🔍 Bridge Connectivity Debug Tool');
  console.log('=================================');
  
  await checkContainerStatus();
  await checkEnvironmentConfig();
  await testDirectConnection();
  await checkHealthEndpoints();
  await checkBootstrapLogs();
  await checkBridgeNodeLogs();
  
  console.log('\n📋 Next Steps:');
  console.log('1. Verify BRIDGE_NODE_1 and BRIDGE_NODE_2 environment variables');
  console.log('2. Check if connection pool is being initialized');
  console.log('3. Verify bridge nodes are listening on correct ports');
  console.log('4. Test WebSocket connections manually if needed');
}

main().catch(console.error);