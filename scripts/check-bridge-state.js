#!/usr/bin/env node

/**
 * Check bridge node state by connecting directly
 */

import WebSocket from 'ws';

const BRIDGE_URLS = [
  'wss://imeyouwe.com/bridge1',
  'wss://imeyouwe.com/bridge2'
];

const BRIDGE_AUTH = process.env.BRIDGE_AUTH || 'default-bridge-auth-key';

async function checkBridgeState(bridgeUrl) {
  console.log(`\n🔍 Checking bridge state: ${bridgeUrl}`);
  
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.log(`   ⏰ Timeout`);
      resolve({ url: bridgeUrl, success: false, error: 'timeout' });
    }, 15000);
    
    const ws = new WebSocket(bridgeUrl, {
      rejectUnauthorized: false
    });
    
    ws.on('open', () => {
      console.log(`   ✅ Connected`);
      
      // Send a get_onboarding_peer request (like bootstrap would)
      const request = {
        type: 'get_onboarding_peer',
        requestId: 'diag_' + Date.now(),
        newNodeId: 'diagnostic_node_' + Date.now(),
        newNodeMetadata: {
          nodeType: 'browser',
          capabilities: ['webrtc']
        }
      };
      
      console.log(`   📤 Sending get_onboarding_peer request...`);
      ws.send(JSON.stringify(request));
    });
    
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        console.log(`   📥 Received: ${msg.type}`);
        
        if (msg.type === 'onboarding_peer_response') {
          console.log(`   📊 Response:`);
          console.log(`      Success: ${msg.success}`);
          if (msg.success) {
            console.log(`      Inviter: ${msg.data?.inviterPeerId?.substring(0, 16)}...`);
          } else {
            console.log(`      Error: ${msg.error}`);
            if (msg.data?.emergencyMode) {
              console.log(`      Emergency Mode: true`);
              console.log(`      Network State:`);
              console.log(`         Connected peers: ${msg.data.networkState?.connectedPeerCount}`);
              console.log(`         Routing table: ${msg.data.networkState?.routingTableSize}`);
              console.log(`         Available peers: ${msg.data.networkState?.availablePeers?.length || 0}`);
            }
          }
          
          clearTimeout(timeout);
          ws.close();
          resolve({ url: bridgeUrl, success: true, response: msg });
        } else if (msg.type === 'error') {
          console.log(`   ❌ Error: ${msg.message || msg.error}`);
        }
      } catch (e) {
        console.log(`   📥 Raw: ${data.toString().substring(0, 200)}`);
      }
    });
    
    ws.on('error', (e) => {
      console.log(`   ❌ Error: ${e.message}`);
      clearTimeout(timeout);
      resolve({ url: bridgeUrl, success: false, error: e.message });
    });
    
    ws.on('close', (code, reason) => {
      console.log(`   🔌 Closed: ${code} ${reason || ''}`);
      if (code === 1000 && reason === 'Invalid handshake') {
        console.log(`   ⚠️ Bridge requires authentication - this is expected`);
      }
    });
  });
}

async function main() {
  console.log('🔍 CHECKING BRIDGE NODE STATES');
  console.log('===============================');
  console.log(`Auth: ${BRIDGE_AUTH === 'default-bridge-auth-key' ? 'DEFAULT' : 'CUSTOM'}`);
  
  for (const url of BRIDGE_URLS) {
    await checkBridgeState(url);
  }
  
  console.log('\n📊 ANALYSIS');
  console.log('===========');
  console.log('If bridges close with "Invalid handshake", they are running but');
  console.log('require proper authentication from the bootstrap server.');
  console.log('');
  console.log('The bootstrap server needs to use the connection pool to connect');
  console.log('to bridge nodes on-demand with proper authentication.');
}

main().catch(console.error);
