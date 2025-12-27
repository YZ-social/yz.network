#!/usr/bin/env node

/**
 * Debug script to diagnose DHT connection issues
 * This script will help identify why nodes cannot connect to each other
 */

import { KademliaDHT } from './src/dht/KademliaDHT.js';
import { NodeDHTClient } from './src/node/NodeDHTClient.js';
import { ConnectionManagerFactory } from './src/network/ConnectionManagerFactory.js';

console.log('🔍 DHT Connection Issues Diagnostic Tool');
console.log('=====================================\n');

async function diagnoseConnectionIssues() {
  console.log('📋 Step 1: Environment Detection');
  console.log('--------------------------------');
  
  // Check environment
  const nodeType = ConnectionManagerFactory.detectNodeType();
  console.log(`Environment: ${nodeType}`);
  console.log(`Process: ${typeof process !== 'undefined' ? 'Available' : 'Not Available'}`);
  console.log(`Window: ${typeof window !== 'undefined' ? 'Available' : 'Not Available'}`);
  console.log(`Document: ${typeof document !== 'undefined' ? 'Available' : 'Not Available'}\n`);

  console.log('📋 Step 2: WebSocket Support Check');
  console.log('----------------------------------');
  
  try {
    if (nodeType === 'nodejs') {
      const ws = await import('ws');
      console.log(`✅ WebSocket library available`);
      console.log(`   WebSocket: ${!!ws.default}`);
      console.log(`   WebSocketServer: ${!!(ws.WebSocketServer || ws.default?.Server)}`);
    } else {
      console.log(`✅ Browser WebSocket: ${!!window.WebSocket}`);
    }
  } catch (error) {
    console.log(`❌ WebSocket library error: ${error.message}`);
  }
  
  console.log('\n📋 Step 3: DHT Node Creation Test');
  console.log('----------------------------------');
  
  let dht = null;
  try {
    // Test creating a DHT node
    dht = new KademliaDHT({
      bootstrapServers: ['wss://imeyouwe.com/ws']
    });
    
    console.log(`✅ KademliaDHT created successfully`);
    console.log(`   Node ID: ${dht.localNodeId.toString().substring(0, 16)}...`);
    console.log(`   Bootstrap servers: ${dht.options.bootstrapServers.join(', ')}`);
    
    // Check if it has WebSocket server capability
    console.log(`   Platform limits: max connections = ${dht.platformLimits.maxConnections}`);
    
    // Clean up the DHT node to prevent background tasks
    if (dht && typeof dht.stop === 'function') {
      await dht.stop();
      console.log(`   ✅ DHT node stopped`);
    }
    
  } catch (error) {
    console.log(`❌ DHT creation error: ${error.message}`);
  } finally {
    // Ensure cleanup even if error occurs
    if (dht && typeof dht.stop === 'function') {
      try {
        await dht.stop();
      } catch (cleanupError) {
        console.log(`   ⚠️ DHT cleanup error: ${cleanupError.message}`);
      }
    }
  }
  
  console.log('\n📋 Step 4: NodeDHTClient Test (Node.js only)');
  console.log('--------------------------------------------');
  
  if (nodeType === 'nodejs') {
    try {
      const nodeClient = new NodeDHTClient({
        port: 0, // Use random port
        bootstrapServers: ['wss://imeyouwe.com/ws']
      });
      
      console.log(`✅ NodeDHTClient created successfully`);
      console.log(`   Node ID: ${nodeClient.nodeId.toString().substring(0, 16)}...`);
      
      // Try to start it briefly to test WebSocket server
      console.log(`🚀 Testing WebSocket server startup...`);
      
      const startInfo = await nodeClient.start();
      console.log(`✅ NodeDHTClient started successfully`);
      console.log(`   Listening address: ${startInfo.listeningAddress}`);
      console.log(`   Node type: ${startInfo.nodeType}`);
      
      // Stop it immediately
      await nodeClient.stop();
      console.log(`✅ NodeDHTClient stopped successfully`);
      
    } catch (error) {
      console.log(`❌ NodeDHTClient error: ${error.message}`);
      console.log(`   Stack: ${error.stack}`);
    }
  } else {
    console.log(`ℹ️ Skipping NodeDHTClient test (browser environment)`);
  }
  
  console.log('\n📋 Step 5: Connection Manager Factory Test');
  console.log('------------------------------------------');
  
  try {
    ConnectionManagerFactory.initializeTransports({
      maxConnections: 50,
      timeout: 30000
    });
    
    console.log(`✅ ConnectionManagerFactory initialized`);
    console.log(`   Local node type: ${ConnectionManagerFactory.localNodeType}`);
    
    // Test creating managers for different scenarios
    const browserToBrowser = ConnectionManagerFactory.createForConnection('browser', 'browser');
    console.log(`✅ Browser→Browser manager: ${browserToBrowser.constructor.name}`);
    
    const browserToNodejs = ConnectionManagerFactory.createForConnection('browser', 'nodejs');
    console.log(`✅ Browser→Node.js manager: ${browserToNodejs.constructor.name}`);
    
    const nodejsToNodejs = ConnectionManagerFactory.createForConnection('nodejs', 'nodejs');
    console.log(`✅ Node.js→Node.js manager: ${nodejsToNodejs.constructor.name}`);
    
  } catch (error) {
    console.log(`❌ ConnectionManagerFactory error: ${error.message}`);
  }
  
  console.log('\n📋 Step 6: Bootstrap Server Connection Test');
  console.log('-------------------------------------------');
  
  try {
    // Test if bootstrap server is reachable
    const WebSocket = nodeType === 'nodejs' ? (await import('ws')).default : window.WebSocket;
    
    console.log(`🔌 Testing connection to bootstrap server...`);
    
    const testConnection = () => {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket('ws://localhost:8080');
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error('Connection timeout'));
        }, 5000);
        
        ws.onopen = () => {
          clearTimeout(timeout);
          ws.close();
          resolve('Connected successfully');
        };
        
        ws.onerror = (error) => {
          clearTimeout(timeout);
          reject(error);
        };
      });
    };
    
    const result = await testConnection();
    console.log(`✅ Bootstrap server: ${result}`);
    
  } catch (error) {
    console.log(`❌ Bootstrap server connection failed: ${error.message}`);
    console.log(`   This might be expected if bootstrap server is not running`);
  }
  
  console.log('\n🎯 DIAGNOSIS SUMMARY');
  console.log('===================');
  console.log('Based on the tests above, here are the likely issues:');
  console.log('');
  console.log('1. **WebSocket Server Startup**: Check if nodes are starting WebSocket servers');
  console.log('   - KademliaDHT alone does NOT start WebSocket servers');
  console.log('   - NodeDHTClient DOES start WebSocket servers');
  console.log('   - Nodes need WebSocket servers to accept incoming connections');
  console.log('');
  console.log('2. **Bootstrap Server**: Check if bootstrap server is running');
  console.log('   - Nodes need bootstrap server for initial peer discovery');
  console.log('   - Run: npm run bootstrap or npm run bootstrap:genesis');
  console.log('');
  console.log('3. **Address Resolution**: Nodes need to know each other\'s addresses');
  console.log('   - WebSocket connections require listeningAddress metadata');
  console.log('   - Check if nodes are advertising their WebSocket server addresses');
  console.log('');
  console.log('4. **Docker Networking**: Check Docker network configuration');
  console.log('   - Nodes in Docker need proper port mapping and network setup');
  console.log('   - Check if nginx proxy is configured correctly');
  console.log('');
  console.log('🔧 RECOMMENDED FIXES:');
  console.log('1. Ensure nodes use NodeDHTClient instead of KademliaDHT directly');
  console.log('2. Start bootstrap server: npm run bootstrap:genesis');
  console.log('3. Check Docker networking and port mappings');
  console.log('4. Verify nginx proxy configuration for external addressing');
}

// Run the diagnostic
diagnoseConnectionIssues()
  .then(() => {
    console.log('\n✅ Diagnostic completed successfully');
    process.exit(0);
  })
  .catch(error => {
    console.error('❌ Diagnostic failed:', error);
    process.exit(1);
  });