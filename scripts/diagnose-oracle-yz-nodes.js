#!/usr/bin/env node

/**
 * Oracle YZ Network Diagnostic Tool
 * 
 * Diagnoses the Oracle Cloud DHT deployment to identify why browser nodes
 * cannot connect to existing peers.
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const BOOTSTRAP_URL = 'https://imeyouwe.com';
const BOOTSTRAP_WS = 'wss://imeyouwe.com/ws';

console.log('🔍 Oracle YZ Network Diagnostic Tool');
console.log('====================================\n');

/**
 * Test HTTP endpoint
 */
async function testHttpEndpoint(url, description) {
  try {
    const response = await fetch(url, { 
      signal: AbortSignal.timeout(10000),
      headers: {
        'User-Agent': 'YZ-Network-Diagnostic/1.0'
      }
    });
    
    if (response.ok) {
      const data = await response.text();
      return { success: true, status: response.status, data };
    } else {
      return { success: false, status: response.status, error: `HTTP ${response.status}` };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Test WebSocket connection
 */
async function testWebSocketConnection(url, description) {
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(url);
      const timeout = setTimeout(() => {
        ws.close();
        resolve({ success: false, error: 'Connection timeout (10s)' });
      }, 10000);
      
      ws.onopen = () => {
        clearTimeout(timeout);
        ws.close();
        resolve({ success: true, message: 'Connected successfully' });
      };
      
      ws.onerror = (error) => {
        clearTimeout(timeout);
        resolve({ success: false, error: 'WebSocket error' });
      };
      
      ws.onclose = (event) => {
        clearTimeout(timeout);
        if (event.wasClean) {
          resolve({ success: true, message: 'Connected and closed cleanly' });
        } else {
          resolve({ success: false, error: `Connection closed unexpectedly (${event.code})` });
        }
      };
    } catch (error) {
      resolve({ success: false, error: error.message });
    }
  });
}

/**
 * Test bootstrap server API endpoints
 */
async function testBootstrapAPI() {
  console.log('📡 Testing Bootstrap Server API...');
  console.log('----------------------------------');
  
  const endpoints = [
    { url: `${BOOTSTRAP_URL}/health`, name: 'Health Check' },
    { url: `${BOOTSTRAP_URL}/bridge-health`, name: 'Bridge Health' },
    { url: `${BOOTSTRAP_URL}/api/metrics`, name: 'Metrics' },
    { url: `${BOOTSTRAP_URL}/api/stats`, name: 'Statistics' }
  ];
  
  for (const endpoint of endpoints) {
    const result = await testHttpEndpoint(endpoint.url, endpoint.name);
    
    if (result.success) {
      console.log(`✅ ${endpoint.name}: HTTP ${result.status}`);
      
      // Parse and show relevant data
      try {
        const data = JSON.parse(result.data);
        if (endpoint.name === 'Bridge Health' && data.bridgeAvailability) {
          console.log(`   Available bridges: ${data.bridgeAvailability.available}/${data.bridgeAvailability.total}`);
        }
        if (endpoint.name === 'Metrics' && data.connectedPeers !== undefined) {
          console.log(`   Connected peers: ${data.connectedPeers}`);
        }
      } catch (e) {
        // Not JSON, that's fine
      }
    } else {
      console.log(`❌ ${endpoint.name}: ${result.error}`);
    }
  }
}

/**
 * Test WebSocket connection
 */
async function testWebSocketAPI() {
  console.log('\n🔌 Testing Bootstrap WebSocket...');
  console.log('--------------------------------');
  
  const result = await testWebSocketConnection(BOOTSTRAP_WS, 'Bootstrap WebSocket');
  
  if (result.success) {
    console.log(`✅ WebSocket: ${result.message}`);
  } else {
    console.log(`❌ WebSocket: ${result.error}`);
  }
}

/**
 * Simulate browser DHT connection attempt
 */
async function simulateBrowserConnection() {
  console.log('\n🌐 Simulating Browser DHT Connection...');
  console.log('--------------------------------------');
  
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(BOOTSTRAP_WS);
      let authenticated = false;
      let peersReceived = false;
      
      const timeout = setTimeout(() => {
        ws.close();
        resolve({
          success: false,
          authenticated,
          peersReceived,
          error: 'Connection timeout (30s)'
        });
      }, 30000);
      
      ws.onopen = async () => {
        console.log('🔌 WebSocket connected');
        
        // Import current version info
        const { PROTOCOL_VERSION, BUILD_ID } = await import('../src/version.js');
        
        // Simulate registration with proper version information
        ws.send(JSON.stringify({
          type: 'register_peer',
          nodeId: 'diagnostic-browser-node',
          nodeType: 'browser',
          protocolVersion: PROTOCOL_VERSION,
          buildId: BUILD_ID,
          timestamp: Date.now(),
          metadata: {}
        }));
      };
      
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          console.log(`📥 Received: ${message.type}`);
          
          if (message.type === 'version_mismatch') {
            console.log('🔍 VERSION MISMATCH DETAILS:');
            console.log(`   Client version: ${message.clientVersion}`);
            console.log(`   Client build ID: ${message.clientBuildId}`);
            console.log(`   Server version: ${message.serverVersion}`);
            console.log(`   Server build ID: ${message.serverBuildId}`);
            console.log(`   Message: ${message.message}`);
          }
          
          if (message.type === 'registered') {
            console.log('✅ Registration successful');
          }
          
          if (message.type === 'auth_challenge') {
            console.log('🔐 Authentication challenge received');
            // In real scenario, we'd sign this, but for diagnostic we'll skip
            ws.send(JSON.stringify({
              type: 'auth_response',
              signature: 'diagnostic-signature'
            }));
          }
          
          if (message.type === 'auth_success') {
            console.log('✅ Authentication successful');
            authenticated = true;
            
            // Request peers
            ws.send(JSON.stringify({
              type: 'get_peers_or_genesis',
              requestId: 'diagnostic-request'
            }));
          }
          
          if (message.type === 'response' && message.data) {
            console.log('📥 Peer response received');
            peersReceived = true;
            
            if (message.data.peers) {
              console.log(`   Peers available: ${message.data.peers.length}`);
              if (message.data.peers.length > 0) {
                console.log('✅ Peers found - network is active');
              } else {
                console.log('⚠️ No peers available - network may be empty');
              }
            }
            
            if (message.data.helperPeer) {
              console.log(`   Helper peer: ${message.data.helperPeer}`);
            }
            
            clearTimeout(timeout);
            ws.close();
            resolve({
              success: true,
              authenticated,
              peersReceived,
              peerCount: message.data.peers?.length || 0
            });
          }
        } catch (e) {
          console.log(`📥 Non-JSON message: ${event.data}`);
        }
      };
      
      ws.onerror = (error) => {
        clearTimeout(timeout);
        resolve({
          success: false,
          authenticated,
          peersReceived,
          error: 'WebSocket error'
        });
      };
      
      ws.onclose = (event) => {
        clearTimeout(timeout);
        if (!authenticated && !peersReceived) {
          resolve({
            success: false,
            authenticated,
            peersReceived,
            error: `Connection closed before completion (${event.code})`
          });
        }
      };
    } catch (error) {
      resolve({
        success: false,
        authenticated: false,
        peersReceived: false,
        error: error.message
      });
    }
  });
}

/**
 * Check Oracle Cloud infrastructure status
 */
async function checkOracleInfrastructure() {
  console.log('\n☁️ Checking Oracle Cloud Infrastructure...');
  console.log('------------------------------------------');
  
  // Test main domain
  const domainResult = await testHttpEndpoint('https://imeyouwe.com', 'Main Domain');
  if (domainResult.success) {
    console.log('✅ Domain accessible');
  } else {
    console.log(`❌ Domain issue: ${domainResult.error}`);
  }
  
  // Test if it's behind a proxy/CDN
  try {
    const response = await fetch('https://imeyouwe.com', { 
      method: 'HEAD',
      signal: AbortSignal.timeout(5000)
    });
    
    const server = response.headers.get('server');
    const cfRay = response.headers.get('cf-ray');
    const xForwardedFor = response.headers.get('x-forwarded-for');
    
    if (server) console.log(`   Server: ${server}`);
    if (cfRay) console.log(`   Cloudflare: ${cfRay}`);
    if (xForwardedFor) console.log(`   Proxy: detected`);
    
  } catch (e) {
    console.log('   Could not check headers');
  }
}

/**
 * Main diagnostic function
 */
async function main() {
  console.log('🚀 Starting Oracle YZ Network diagnostics...\n');
  
  // Test bootstrap server
  await testBootstrapAPI();
  
  // Test WebSocket
  await testWebSocketAPI();
  
  // Check Oracle infrastructure
  await checkOracleInfrastructure();
  
  // Simulate browser connection
  const connectionResult = await simulateBrowserConnection();
  
  console.log('\n🎯 DIAGNOSTIC SUMMARY');
  console.log('====================');
  
  if (connectionResult.success) {
    console.log('✅ Bootstrap connection: SUCCESS');
    console.log(`✅ Authentication: ${connectionResult.authenticated ? 'SUCCESS' : 'FAILED'}`);
    console.log(`✅ Peer discovery: ${connectionResult.peersReceived ? 'SUCCESS' : 'FAILED'}`);
    
    if (connectionResult.peerCount > 0) {
      console.log(`✅ Network status: ACTIVE (${connectionResult.peerCount} peers)`);
      console.log('\n💡 CONCLUSION: Oracle DHT network is running normally');
      console.log('   Browser connection issues may be due to:');
      console.log('   - Local network/firewall blocking WebSocket');
      console.log('   - Browser security settings');
      console.log('   - Temporary network glitch');
    } else {
      console.log('⚠️ Network status: EMPTY (no peers available)');
      console.log('\n💡 CONCLUSION: Bootstrap server is working but no DHT nodes are connected');
      console.log('   This suggests:');
      console.log('   - Oracle DHT nodes may be down');
      console.log('   - Bridge nodes are not connected');
      console.log('   - Genesis node may need restart');
    }
  } else {
    console.log('❌ Bootstrap connection: FAILED');
    console.log(`❌ Error: ${connectionResult.error}`);
    console.log('\n💡 CONCLUSION: Oracle infrastructure has issues');
    console.log('   Possible causes:');
    console.log('   - Bootstrap server is down');
    console.log('   - Oracle Cloud instance is down');
    console.log('   - Network connectivity issues');
    console.log('   - SSL/TLS certificate problems');
  }
  
  console.log('\n🔧 RECOMMENDED ACTIONS:');
  
  if (!connectionResult.success) {
    console.log('1. Check Oracle Cloud instance status');
    console.log('2. SSH into Oracle instance and check Docker containers');
    console.log('3. Restart bootstrap server: docker restart yz-bootstrap-server');
    console.log('4. Check nginx/proxy configuration');
  } else if (connectionResult.peerCount === 0) {
    console.log('1. SSH into Oracle instance');
    console.log('2. Check DHT node containers: docker ps | grep dht-node');
    console.log('3. Check bridge node status: docker logs yz-bridge-node-1');
    console.log('4. Restart DHT infrastructure: ./RestartServerImproved.sh');
    console.log('5. Run bridge connection fix: node scripts/fix-bridge-connections.js');
  } else {
    console.log('1. Try refreshing browser and reconnecting');
    console.log('2. Check browser console for additional errors');
    console.log('3. Try different browser or incognito mode');
    console.log('4. Check local network/firewall settings');
  }
}

// Run diagnostics
main().catch(error => {
  console.error('❌ Diagnostic failed:', error);
  process.exit(1);
});