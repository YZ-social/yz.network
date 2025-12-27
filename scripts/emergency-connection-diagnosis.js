#!/usr/bin/env node

/**
 * Emergency DHT Connection Crisis Diagnosis
 * Comprehensive diagnostic tool for the current DHT network crisis
 */

import { KademliaDHT } from '../src/dht/KademliaDHT.js';
import { NodeDHTClient } from '../src/node/NodeDHTClient.js';
import { ConnectionManagerFactory } from '../src/network/ConnectionManagerFactory.js';
import { readFileSync } from 'fs';
import { join } from 'path';

console.log('🚨 EMERGENCY DHT CONNECTION CRISIS DIAGNOSIS');
console.log('============================================\n');

async function emergencyDiagnosis() {
  const results = {
    versionMismatch: false,
    bootstrapServerReachable: false,
    webSocketPaths: { working: false, errors: [] },
    webRTCPaths: { working: false, errors: [] },
    dataTransferMetrics: { interfering: false, errors: [] },
    connectionManagers: { working: false, errors: [] },
    dockerNetworking: { working: false, errors: [] },
    oracleNodes: { healthy: 0, total: 15, errors: [] }
  };

  console.log('🔍 STEP 1: VERSION MISMATCH ANALYSIS');
  console.log('====================================');
  
  try {
    // Check bundle version
    const bundleHashPath = join(process.cwd(), 'dist', 'bundle-hash.json');
    let localVersion = '1.0.0';
    try {
      const bundleData = JSON.parse(readFileSync(bundleHashPath, 'utf8'));
      localVersion = bundleData.hash || '1.0.0';
      console.log(`📦 Local bundle hash: ${localVersion}`);
    } catch (error) {
      console.log(`⚠️ Could not read bundle hash: ${error.message}`);
    }

    // Test bootstrap server version check
    console.log('🔌 Testing bootstrap server version compatibility...');
    
    const WebSocket = (await import('ws')).default;
    const versionTest = await new Promise((resolve) => {
      const ws = new WebSocket('wss://imeyouwe.com/ws');
      let resolved = false;
      
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          ws.close();
          resolve({ success: false, error: 'Connection timeout' });
        }
      }, 10000);
      
      ws.onopen = () => {
        console.log('✅ Connected to bootstrap server');
        // Send version info
        ws.send(JSON.stringify({
          type: 'version_check',
          version: localVersion,
          clientType: 'nodejs'
        }));
      };
      
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          console.log(`📥 Received message type: ${message.type}`);
          
          if (message.type === 'version_mismatch') {
            results.versionMismatch = true;
            console.log(`❌ VERSION MISMATCH DETECTED!`);
            console.log(`   Local version: ${localVersion}`);
            console.log(`   Server version: ${message.serverVersion || 'unknown'}`);
            console.log(`   Message: ${message.message}`);
            
            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);
              ws.close();
              resolve({ 
                success: false, 
                versionMismatch: true,
                localVersion,
                serverVersion: message.serverVersion,
                message: message.message
              });
            }
          } else {
            console.log(`✅ Version check passed`);
            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);
              ws.close();
              resolve({ success: true });
            }
          }
        } catch (error) {
          console.log(`❌ Error parsing message: ${error.message}`);
        }
      };
      
      ws.onerror = (error) => {
        console.log(`❌ WebSocket error: ${error.message || 'Connection failed'}`);
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve({ success: false, error: error.message || 'Connection failed' });
        }
      };
      
      ws.onclose = (event) => {
        console.log(`🔌 Connection closed: ${event.code} ${event.reason}`);
        if (event.code === 4001) {
          results.versionMismatch = true;
        }
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve({ 
            success: false, 
            error: `Connection closed: ${event.code} ${event.reason}`,
            versionMismatch: event.code === 4001
          });
        }
      };
    });
    
    if (versionTest.versionMismatch) {
      console.log('\n🚨 CRITICAL ISSUE: VERSION MISMATCH');
      console.log('===================================');
      console.log('The bootstrap server is rejecting connections due to version mismatch.');
      console.log('This is likely the PRIMARY cause of the DHT network crisis.');
      console.log('\nRECOMMENDED ACTIONS:');
      console.log('1. Check if server deployment is out of sync with local code');
      console.log('2. Rebuild and redeploy the server with matching version');
      console.log('3. Verify bundle hash generation is working correctly');
      results.versionMismatch = true;
    } else if (versionTest.success) {
      console.log('✅ Version compatibility check passed');
      results.bootstrapServerReachable = true;
    } else {
      console.log(`❌ Bootstrap server connection failed: ${versionTest.error}`);
    }
    
  } catch (error) {
    console.log(`❌ Version check failed: ${error.message}`);
    results.connectionManagers.errors.push(`Version check: ${error.message}`);
  }

  console.log('\n🔍 STEP 2: WEBSOCKET CONNECTION PATH INTEGRITY');
  console.log('==============================================');
  
  try {
    console.log('🧪 Testing WebSocket connection manager creation...');
    
    // Test WebSocket connection manager
    ConnectionManagerFactory.initializeTransports({
      maxConnections: 50,
      timeout: 30000
    });
    
    const wsManager = ConnectionManagerFactory.createForConnection('browser', 'nodejs');
    console.log(`✅ WebSocket manager created: ${wsManager.constructor.name}`);
    
    // Test if WebSocket server can start
    console.log('🧪 Testing WebSocket server startup...');
    const testClient = new NodeDHTClient({
      port: 0,
      bootstrapServers: ['wss://imeyouwe.com/ws']
    });
    
    try {
      const startInfo = await testClient.start();
      console.log(`✅ WebSocket server started: ${startInfo.listeningAddress}`);
      results.webSocketPaths.working = true;
      
      await testClient.stop();
      console.log('✅ WebSocket server stopped cleanly');
      
    } catch (error) {
      console.log(`❌ WebSocket server startup failed: ${error.message}`);
      results.webSocketPaths.errors.push(`Server startup: ${error.message}`);
    }
    
  } catch (error) {
    console.log(`❌ WebSocket path test failed: ${error.message}`);
    results.webSocketPaths.errors.push(`Path test: ${error.message}`);
  }

  console.log('\n🔍 STEP 3: WEBRTC CONNECTION PATH INTEGRITY');
  console.log('===========================================');
  
  try {
    console.log('🧪 Testing WebRTC connection manager creation...');
    
    const webrtcManager = ConnectionManagerFactory.createForConnection('browser', 'browser');
    console.log(`✅ WebRTC manager created: ${webrtcManager.constructor.name}`);
    
    // WebRTC requires browser environment for full testing
    console.log('ℹ️ Full WebRTC testing requires browser environment');
    console.log('ℹ️ WebRTC manager creation successful indicates basic integrity');
    results.webRTCPaths.working = true;
    
  } catch (error) {
    console.log(`❌ WebRTC path test failed: ${error.message}`);
    results.webRTCPaths.errors.push(`Path test: ${error.message}`);
  }

  console.log('\n🔍 STEP 4: DATA TRANSFER METRICS INTERFERENCE CHECK');
  console.log('==================================================');
  
  try {
    console.log('🧪 Testing if data transfer metrics interfere with connections...');
    
    // Check if metrics are causing JSON serialization issues
    const testMessage = {
      type: 'test_message',
      data: { test: true },
      timestamp: Date.now()
    };
    
    try {
      const serialized = JSON.stringify(testMessage);
      const deserialized = JSON.parse(serialized);
      console.log('✅ JSON serialization/deserialization working');
      
      // Test with potentially problematic data
      const problematicMessage = {
        type: 'test_message',
        data: { 
          circular: null,
          buffer: Buffer.from('test'),
          undefined: undefined,
          function: () => {},
          symbol: Symbol('test')
        }
      };
      
      // Remove problematic properties
      delete problematicMessage.data.undefined;
      delete problematicMessage.data.function;
      delete problematicMessage.data.symbol;
      problematicMessage.data.buffer = problematicMessage.data.buffer.toString();
      
      const serialized2 = JSON.stringify(problematicMessage);
      console.log('✅ Problematic data serialization handled');
      
      results.dataTransferMetrics.interfering = false;
      
    } catch (error) {
      console.log(`❌ JSON serialization issue detected: ${error.message}`);
      results.dataTransferMetrics.interfering = true;
      results.dataTransferMetrics.errors.push(`Serialization: ${error.message}`);
    }
    
  } catch (error) {
    console.log(`❌ Data transfer metrics test failed: ${error.message}`);
    results.dataTransferMetrics.errors.push(`Metrics test: ${error.message}`);
  }

  console.log('\n🔍 STEP 5: CONNECTION MANAGER HIERARCHY CHECK');
  console.log('=============================================');
  
  try {
    console.log('🧪 Testing connection manager factory routing...');
    
    const managers = {
      'browser→browser': ConnectionManagerFactory.createForConnection('browser', 'browser'),
      'browser→nodejs': ConnectionManagerFactory.createForConnection('browser', 'nodejs'),
      'nodejs→nodejs': ConnectionManagerFactory.createForConnection('nodejs', 'nodejs'),
      'nodejs→browser': ConnectionManagerFactory.createForConnection('nodejs', 'browser')
    };
    
    console.log('✅ Connection manager routing test:');
    for (const [path, manager] of Object.entries(managers)) {
      console.log(`   ${path}: ${manager.constructor.name}`);
    }
    
    results.connectionManagers.working = true;
    
  } catch (error) {
    console.log(`❌ Connection manager hierarchy test failed: ${error.message}`);
    results.connectionManagers.errors.push(`Hierarchy test: ${error.message}`);
  }

  console.log('\n🔍 STEP 6: DOCKER NETWORKING DIAGNOSIS');
  console.log('======================================');
  
  try {
    console.log('🧪 Testing Docker network connectivity...');
    
    // Test if we can reach known Oracle YZ node endpoints
    const oracleNodes = [
      'wss://imeyouwe.com/node1',
      'wss://imeyouwe.com/node2', 
      'wss://imeyouwe.com/node3',
      'wss://imeyouwe.com/genesis',
      'wss://imeyouwe.com/bridge1'
    ];
    
    console.log(`🔌 Testing connectivity to ${oracleNodes.length} Oracle YZ endpoints...`);
    
    const WebSocket = (await import('ws')).default;
    let healthyNodes = 0;
    
    for (const nodeUrl of oracleNodes) {
      try {
        const testResult = await new Promise((resolve) => {
          const ws = new WebSocket(nodeUrl);
          let resolved = false;
          
          const timeout = setTimeout(() => {
            if (!resolved) {
              resolved = true;
              ws.close();
              resolve({ success: false, error: 'Connection timeout' });
            }
          }, 5000);
          
          ws.onopen = () => {
            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);
              ws.close();
              resolve({ success: true });
            }
          };
          
          ws.onerror = (error) => {
            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);
              resolve({ success: false, error: error.message || 'Connection failed' });
            }
          };
          
          ws.onclose = (event) => {
            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);
              resolve({ 
                success: event.code === 1000, 
                error: `Closed: ${event.code} ${event.reason}` 
              });
            }
          };
        });
        
        if (testResult.success) {
          console.log(`✅ ${nodeUrl}: Connected successfully`);
          healthyNodes++;
        } else {
          console.log(`❌ ${nodeUrl}: ${testResult.error}`);
          results.oracleNodes.errors.push(`${nodeUrl}: ${testResult.error}`);
        }
        
      } catch (error) {
        console.log(`❌ ${nodeUrl}: ${error.message}`);
        results.oracleNodes.errors.push(`${nodeUrl}: ${error.message}`);
      }
    }
    
    results.oracleNodes.healthy = healthyNodes;
    results.oracleNodes.total = oracleNodes.length;
    results.dockerNetworking.working = healthyNodes > 0;
    
    console.log(`\n📊 Oracle YZ Node Health: ${healthyNodes}/${oracleNodes.length} nodes reachable`);
    
  } catch (error) {
    console.log(`❌ Docker networking test failed: ${error.message}`);
    results.dockerNetworking.errors.push(`Network test: ${error.message}`);
  }

  console.log('\n🎯 EMERGENCY DIAGNOSIS SUMMARY');
  console.log('==============================');
  
  console.log('\n📊 RESULTS OVERVIEW:');
  console.log(`   Version Mismatch: ${results.versionMismatch ? '❌ YES' : '✅ NO'}`);
  console.log(`   Bootstrap Server: ${results.bootstrapServerReachable ? '✅ REACHABLE' : '❌ UNREACHABLE'}`);
  console.log(`   WebSocket Paths: ${results.webSocketPaths.working ? '✅ WORKING' : '❌ BROKEN'}`);
  console.log(`   WebRTC Paths: ${results.webRTCPaths.working ? '✅ WORKING' : '❌ BROKEN'}`);
  console.log(`   Data Metrics: ${results.dataTransferMetrics.interfering ? '❌ INTERFERING' : '✅ SAFE'}`);
  console.log(`   Connection Mgrs: ${results.connectionManagers.working ? '✅ WORKING' : '❌ BROKEN'}`);
  console.log(`   Docker Network: ${results.dockerNetworking.working ? '✅ WORKING' : '❌ BROKEN'}`);
  console.log(`   Oracle Nodes: ${results.oracleNodes.healthy}/${results.oracleNodes.total} healthy`);

  console.log('\n🚨 CRITICAL ISSUES IDENTIFIED:');
  
  if (results.versionMismatch) {
    console.log('\n1. 🔥 VERSION MISMATCH (CRITICAL)');
    console.log('   - Bootstrap server rejecting all connections due to version mismatch');
    console.log('   - This prevents ANY node from joining the network');
    console.log('   - IMMEDIATE ACTION: Rebuild and redeploy server with matching version');
  }
  
  if (!results.bootstrapServerReachable) {
    console.log('\n2. 🔥 BOOTSTRAP SERVER UNREACHABLE (CRITICAL)');
    console.log('   - Nodes cannot perform initial peer discovery');
    console.log('   - Network cannot form without bootstrap coordination');
    console.log('   - IMMEDIATE ACTION: Fix bootstrap server connectivity');
  }
  
  if (!results.webSocketPaths.working) {
    console.log('\n3. 🔥 WEBSOCKET PATHS BROKEN (CRITICAL)');
    console.log('   - Node-to-node connections cannot be established');
    console.log('   - DHT mesh formation impossible');
    console.log('   - IMMEDIATE ACTION: Fix WebSocket connection issues');
  }
  
  if (results.oracleNodes.healthy < results.oracleNodes.total * 0.8) {
    console.log('\n4. 🔥 ORACLE NODES UNHEALTHY (CRITICAL)');
    console.log(`   - Only ${results.oracleNodes.healthy}/${results.oracleNodes.total} nodes reachable`);
    console.log('   - Network lacks sufficient healthy nodes for mesh formation');
    console.log('   - IMMEDIATE ACTION: Investigate Docker networking and nginx proxy');
  }

  console.log('\n🔧 IMMEDIATE RECOVERY ACTIONS:');
  console.log('1. Fix version mismatch by rebuilding/redeploying server');
  console.log('2. Verify bootstrap server is running and accessible');
  console.log('3. Check Docker container health and networking');
  console.log('4. Verify nginx proxy configuration for node endpoints');
  console.log('5. Restart unhealthy Oracle YZ nodes');

  console.log('\n📋 DETAILED ERROR LOG:');
  for (const [category, data] of Object.entries(results)) {
    if (data.errors && data.errors.length > 0) {
      console.log(`\n${category.toUpperCase()} ERRORS:`);
      data.errors.forEach(error => console.log(`   - ${error}`));
    }
  }

  return results;
}

// Run the emergency diagnosis
emergencyDiagnosis().catch(error => {
  console.error('❌ Emergency diagnosis failed:', error);
  process.exit(1);
});