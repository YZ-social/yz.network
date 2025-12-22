#!/usr/bin/env node

/**
 * Diagnostic script to check connection pool status using external nginx addresses
 * All connections (internal Docker + external browser) use external addresses via nginx proxy
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function checkDockerLogs() {
  console.log('🔍 Checking Docker container logs for connection pool issues...');
  
  try {
    // Check bootstrap server logs for connection pool messages
    console.log('\n📋 Bootstrap Server Connection Pool Logs:');
    const { stdout: bootstrapLogs } = await execAsync('docker logs yz-bootstrap-server --tail 100');
    
    // Look for connection pool related messages
    const poolMessages = bootstrapLogs.split('\n').filter(line => 
      line.includes('Bridge Connection Pool') ||
      line.includes('connection pool') ||
      line.includes('Connecting to bridge') ||
      line.includes('Bridge connection') ||
      line.includes('🔗') ||
      line.includes('🏊') ||
      line.includes('wss://imeyouwe.com/bridge')
    );
    
    if (poolMessages.length > 0) {
      console.log('🔗 Connection Pool Messages:');
      poolMessages.forEach(msg => console.log(`   ${msg}`));
    } else {
      console.log('❌ No connection pool messages found - pool may not be initializing');
    }
    
    // Check for WebSocket connection errors
    const connectionErrors = bootstrapLogs.split('\n').filter(line =>
      line.includes('WebSocket') && (line.includes('error') || line.includes('failed') || line.includes('❌'))
    );
    
    if (connectionErrors.length > 0) {
      console.log('\n❌ WebSocket Connection Errors:');
      connectionErrors.slice(-10).forEach(msg => console.log(`   ${msg}`));
    }
    
  } catch (error) {
    console.error('❌ Error checking bootstrap logs:', error.message);
  }
  
  try {
    // Check bridge node logs for connection attempts
    console.log('\n🌉 Bridge Node Connection Logs:');
    
    const { stdout: bridge1Logs } = await execAsync('docker logs yz-bridge-node-1 --tail 50');
    const bridge1Connections = bridge1Logs.split('\n').filter(line =>
      line.includes('bootstrap') ||
      line.includes('connection') ||
      line.includes('WebSocket') ||
      line.includes('auth') ||
      line.includes('🔐') ||
      line.includes('✅') ||
      line.includes('❌')
    );
    
    if (bridge1Connections.length > 0) {
      console.log('Bridge Node 1 Recent Activity:');
      bridge1Connections.slice(-5).forEach(msg => console.log(`   ${msg}`));
    } else {
      console.log('Bridge Node 1: No recent connection activity');
    }
    
    const { stdout: bridge2Logs } = await execAsync('docker logs yz-bridge-node-2 --tail 50');
    const bridge2Connections = bridge2Logs.split('\n').filter(line =>
      line.includes('bootstrap') ||
      line.includes('connection') ||
      line.includes('WebSocket') ||
      line.includes('auth') ||
      line.includes('🔐') ||
      line.includes('✅') ||
      line.includes('❌')
    );
    
    if (bridge2Connections.length > 0) {
      console.log('Bridge Node 2 Recent Activity:');
      bridge2Connections.slice(-5).forEach(msg => console.log(`   ${msg}`));
    } else {
      console.log('Bridge Node 2: No recent connection activity');
    }
    
  } catch (error) {
    console.error('❌ Error checking bridge logs:', error.message);
  }
}

async function checkExternalConnectivity() {
  console.log('\n🔍 Testing external nginx-proxied addresses (as used by connection pool)...');
  
  try {
    // Test bridge health endpoints via nginx proxy
    console.log('Testing bridge health via nginx proxy:');
    
    const { stdout: bridge1Health } = await execAsync('curl -s --max-time 10 https://imeyouwe.com/bridge1/health || echo "FAILED"');
    console.log(`   Bridge 1 Health: ${bridge1Health.includes('FAILED') ? '❌ FAILED' : '✅ OK'}`);
    
    const { stdout: bridge2Health } = await execAsync('curl -s --max-time 10 https://imeyouwe.com/bridge2/health || echo "FAILED"');
    console.log(`   Bridge 2 Health: ${bridge2Health.includes('FAILED') ? '❌ FAILED' : '✅ OK'}`);
    
  } catch (error) {
    console.error('❌ Error testing external connectivity:', error.message);
  }
}

async function checkEnvironmentVariables() {
  console.log('\n🔍 Checking bootstrap server bridge configuration...');
  
  try {
    const { stdout: envVars } = await execAsync('docker exec yz-bootstrap-server env | grep BRIDGE');
    console.log('Bootstrap Server Bridge Configuration:');
    envVars.split('\n').forEach(line => {
      if (line.trim()) {
        console.log(`   ${line}`);
      }
    });
  } catch (error) {
    console.error('❌ Error checking environment variables:', error.message);
  }
}

async function checkBootstrapHealth() {
  console.log('\n🔍 Checking bootstrap server health endpoints...');
  
  try {
    // Check main health
    const { stdout: health } = await execAsync('curl -s http://localhost:8080/health');
    const healthData = JSON.parse(health);
    console.log('Bootstrap Health:', healthData);
    
    // Check bridge health endpoint (this uses the connection pool)
    const { stdout: bridgeHealth } = await execAsync('curl -s http://localhost:8080/bridge-health');
    const bridgeHealthData = JSON.parse(bridgeHealth);
    console.log('Bridge Health (via connection pool):', bridgeHealthData);
    
  } catch (error) {
    console.error('❌ Error checking health endpoints:', error.message);
  }
}

async function identifyRootCause() {
  console.log('\n🔍 ROOT CAUSE ANALYSIS');
  console.log('======================');
  
  try {
    // Check if the bootstrap server is actually using the connection pool
    const { stdout: bootstrapLogs } = await execAsync('docker logs yz-bootstrap-server --tail 200');
    
    const hasConnectionPool = bootstrapLogs.includes('Bridge Connection Pool') || 
                             bootstrapLogs.includes('connection pool');
    const hasOldStateless = bootstrapLogs.includes('stateless') || 
                           bootstrapLogs.includes('queryBridgeForOnboardingPeer');
    
    console.log(`Connection Pool Implementation: ${hasConnectionPool ? '✅ ACTIVE' : '❌ NOT FOUND'}`);
    console.log(`Old Stateless Pattern: ${hasOldStateless ? '⚠️ STILL PRESENT' : '✅ REMOVED'}`);
    
    if (!hasConnectionPool) {
      console.log('\n❌ CRITICAL: Connection pool not initializing');
      console.log('   - Check if BridgeConnectionPool import is working');
      console.log('   - Verify bridgePool.initialize() is being called');
      console.log('   - Look for JavaScript errors in bootstrap startup');
    }
    
    if (hasConnectionPool && hasOldStateless) {
      console.log('\n⚠️ WARNING: Both old and new patterns detected');
      console.log('   - May have incomplete migration');
      console.log('   - Old stateless code may be interfering');
    }
    
    // Check for specific error patterns
    const hasWebSocketErrors = bootstrapLogs.includes('WebSocket') && 
                              (bootstrapLogs.includes('error') || bootstrapLogs.includes('failed'));
    const hasAuthErrors = bootstrapLogs.includes('auth') && bootstrapLogs.includes('failed');
    const hasTimeoutErrors = bootstrapLogs.includes('timeout');
    
    if (hasWebSocketErrors) {
      console.log('\n❌ WebSocket connection errors detected');
    }
    if (hasAuthErrors) {
      console.log('\n❌ Authentication errors detected');
    }
    if (hasTimeoutErrors) {
      console.log('\n❌ Timeout errors detected');
    }
    
  } catch (error) {
    console.error('❌ Error in root cause analysis:', error.message);
  }
}

async function main() {
  console.log('🔍 Connection Pool Diagnostic Tool (External Addresses Only)');
  console.log('============================================================');
  console.log('All connections use external nginx-proxied addresses:');
  console.log('- wss://imeyouwe.com/bridge1');
  console.log('- wss://imeyouwe.com/bridge2');
  console.log('');
  
  await checkEnvironmentVariables();
  await checkExternalConnectivity();
  await checkBootstrapHealth();
  await checkDockerLogs();
  await identifyRootCause();
  
  console.log('\n📋 NEXT STEPS:');
  console.log('1. If connection pool not initializing: Check JavaScript errors');
  console.log('2. If WebSocket errors: Check nginx proxy configuration');
  console.log('3. If auth errors: Verify BRIDGE_AUTH tokens match');
  console.log('4. If timeouts: Check if bridge nodes are responding');
  console.log('5. Consider temporary rollback if connection pool is broken');
}

main().catch(console.error);