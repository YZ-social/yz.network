#!/usr/bin/env node

/**
 * Test the bridge onboarding flow
 * 
 * This script simulates what happens when a browser requests peers:
 * 1. Connect to bootstrap server
 * 2. Register as a browser client
 * 3. Request peers via get_peers_or_genesis
 * 4. Analyze the response
 */

import WebSocket from 'ws';

const BOOTSTRAP_URL = 'wss://imeyouwe.com/ws';
const BUILD_ID = '4dc3012681af4cde9c5a';

async function testBridgeOnboardingFlow() {
  console.log('🧪 TESTING BRIDGE ONBOARDING FLOW');
  console.log('==================================');
  console.log(`Bootstrap URL: ${BOOTSTRAP_URL}`);
  console.log(`Build ID: ${BUILD_ID}`);
  console.log('');
  
  return new Promise((resolve) => {
    const ws = new WebSocket(BOOTSTRAP_URL, {
      rejectUnauthorized: false
    });
    
    const timeout = setTimeout(() => {
      console.log('\n⏰ Test timeout after 30 seconds');
      ws.close();
      resolve({ success: false, error: 'timeout' });
    }, 30000);
    
    let testStartTime = Date.now();
    
    ws.on('open', () => {
      console.log('✅ Connected to bootstrap server');
      console.log('📤 Registering as browser client...');
      
      // Register as a browser client (like the real browser does)
      ws.send(JSON.stringify({
        type: 'register',
        nodeId: 'test_browser_' + Date.now(),
        protocolVersion: '1.0.0',
        buildId: BUILD_ID,
        metadata: {
          nodeType: 'browser',
          capabilities: ['webrtc', 'websocket-client'],
          canAcceptConnections: false,
          canInitiateConnections: true,
          tabVisible: true
        }
      }));
    });
    
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      const elapsed = Date.now() - testStartTime;
      
      console.log(`\n📥 [${elapsed}ms] Received: ${msg.type}`);
      
      if (msg.type === 'version_mismatch') {
        console.log('❌ VERSION MISMATCH!');
        console.log(`   Client build: ${msg.clientBuildId}`);
        console.log(`   Server build: ${msg.serverBuildId}`);
        clearTimeout(timeout);
        ws.close();
        resolve({ success: false, error: 'version_mismatch', details: msg });
        return;
      }
      
      if (msg.type === 'registered') {
        console.log('✅ Registered successfully');
        console.log('📤 Requesting peers via get_peers_or_genesis...');
        
        // Request peers (like the real browser does)
        ws.send(JSON.stringify({
          type: 'get_peers_or_genesis',
          requestId: 'test_' + Date.now(),
          nodeId: 'test_browser_' + Date.now(),
          maxPeers: 20,
          metadata: {
            nodeType: 'browser',
            capabilities: ['webrtc', 'websocket-client'],
            canAcceptConnections: false,
            canInitiateConnections: true,
            tabVisible: true
          }
        }));
      }
      
      if (msg.type === 'response') {
        console.log('\n📊 PEER RESPONSE ANALYSIS:');
        console.log(`   Success: ${msg.success}`);
        console.log(`   Status: ${msg.data?.status || 'N/A'}`);
        console.log(`   Emergency Mode: ${msg.data?.emergencyMode || false}`);
        console.log(`   Is Genesis: ${msg.data?.isGenesis || false}`);
        console.log(`   Message: ${msg.data?.message || 'N/A'}`);
        
        const peers = msg.data?.peers || [];
        console.log(`\n📋 PEERS RECEIVED: ${peers.length}`);
        
        if (peers.length === 0) {
          console.log('\n❌ NO PEERS AVAILABLE!');
          console.log('   This is why the browser cannot connect.');
          console.log('');
          console.log('   Possible causes:');
          console.log('   1. No bridge nodes connected to bootstrap');
          console.log('   2. Bridge nodes have empty DHT routing tables');
          console.log('   3. No DHT nodes (genesis, regular nodes) are running');
          console.log('   4. All DHT nodes are filtered out (inactive tabs, too new, etc.)');
        } else {
          console.log('\n✅ PEERS AVAILABLE:');
          for (const peer of peers) {
            const nodeType = peer.metadata?.nodeType || 'unknown';
            const isBridge = peer.metadata?.isBridgeNode || nodeType === 'bridge';
            const fromBridgeRouting = peer.metadata?.fromBridgeRouting || false;
            const emergencyTarget = peer.metadata?.emergencyTarget || false;
            
            console.log(`   - ${peer.nodeId?.substring(0, 16)}...`);
            console.log(`     Type: ${nodeType}`);
            console.log(`     Is Bridge: ${isBridge}`);
            console.log(`     From Bridge Routing: ${fromBridgeRouting}`);
            console.log(`     Emergency Target: ${emergencyTarget}`);
            if (peer.metadata?.websocketAddress) {
              console.log(`     WebSocket: ${peer.metadata.websocketAddress}`);
            }
          }
        }
        
        // Check for specific status messages
        if (msg.data?.status === 'emergency_bridge_routing') {
          console.log('\n🔧 FIX WORKING: Using peers from bridge routing table');
        } else if (msg.data?.status === 'emergency_direct_connect') {
          console.log('\n⚠️ FALLBACK: Using direct connection targets from bootstrap');
        } else if (msg.data?.status === 'network_empty') {
          console.log('\n🚨 CRITICAL: Network is completely empty');
        }
        
        clearTimeout(timeout);
        setTimeout(() => {
          ws.close();
          resolve({ 
            success: peers.length > 0, 
            peerCount: peers.length,
            status: msg.data?.status,
            emergencyMode: msg.data?.emergencyMode,
            peers 
          });
        }, 1000);
      }
    });
    
    ws.on('error', (e) => {
      console.log('❌ WebSocket error:', e.message);
      clearTimeout(timeout);
      resolve({ success: false, error: e.message });
    });
    
    ws.on('close', () => {
      console.log('\n🔌 Connection closed');
    });
  });
}

// Run the test
testBridgeOnboardingFlow()
  .then(result => {
    console.log('\n========================================');
    console.log('TEST RESULT:', result.success ? '✅ PASS' : '❌ FAIL');
    if (result.peerCount !== undefined) {
      console.log(`Peers found: ${result.peerCount}`);
    }
    if (result.error) {
      console.log(`Error: ${result.error}`);
    }
    process.exit(result.success ? 0 : 1);
  })
  .catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
  });
