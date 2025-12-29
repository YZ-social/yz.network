#!/usr/bin/env node

/**
 * Diagnose Bridge Node Issue
 * 
 * This script connects to the bootstrap server and sends a special
 * diagnostic request to see the actual state of connectedClients.
 */

import WebSocket from 'ws';
import crypto from 'crypto';

const BOOTSTRAP_URL = 'wss://imeyouwe.com/ws';
const BUILD_ID = '1175e908e202515e8b1a';

function generateNodeId() {
  return crypto.randomBytes(20).toString('hex');
}

async function main() {
  console.log('🔍 DIAGNOSING BRIDGE NODE ISSUE');
  console.log('================================\n');
  
  // Step 1: Connect as a bridge node and keep connection open
  console.log('📡 Step 1: Registering as bridge node...');
  
  const bridgeNodeId = generateNodeId();
  let bridgeWs;
  
  try {
    bridgeWs = await new Promise((resolve, reject) => {
      const ws = new WebSocket(BOOTSTRAP_URL, { rejectUnauthorized: false });
      
      ws.on('open', () => {
        console.log(`✅ Connected as bridge: ${bridgeNodeId.substring(0, 16)}...`);
        
        ws.send(JSON.stringify({
          type: 'register',
          nodeId: bridgeNodeId,
          protocolVersion: '1.0.0',
          buildId: BUILD_ID,
          metadata: {
            isBridgeNode: true,
            nodeType: 'bridge',
            capabilities: ['websocket', 'observer'],
            listeningAddress: 'wss://imeyouwe.com/bridge-test'
          }
        }));
      });
      
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'registered') {
          console.log('✅ Bridge registered');
          resolve(ws);
        } else if (msg.type === 'version_mismatch') {
          reject(new Error('Version mismatch'));
        }
      });
      
      ws.on('error', reject);
      setTimeout(() => reject(new Error('Timeout')), 10000);
    });
  } catch (e) {
    console.log('❌ Failed to register bridge:', e.message);
    return;
  }
  
  // Step 2: Wait for server to process
  console.log('\n⏳ Step 2: Waiting 3 seconds...');
  await new Promise(r => setTimeout(r, 3000));
  
  // Step 3: Connect as browser and request peers
  console.log('\n📡 Step 3: Connecting as browser client...');
  
  const browserNodeId = generateNodeId();
  
  const result = await new Promise((resolve) => {
    const ws = new WebSocket(BOOTSTRAP_URL, { rejectUnauthorized: false });
    
    ws.on('open', () => {
      console.log(`✅ Connected as browser: ${browserNodeId.substring(0, 16)}...`);
      
      ws.send(JSON.stringify({
        type: 'register',
        nodeId: browserNodeId,
        protocolVersion: '1.0.0',
        buildId: BUILD_ID,
        metadata: {
          nodeType: 'browser',
          capabilities: ['webrtc']
        }
      }));
    });
    
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      console.log(`📥 Browser received: ${msg.type}`);
      
      if (msg.type === 'registered') {
        // Request peers
        ws.send(JSON.stringify({
          type: 'get_peers_or_genesis',
          nodeId: browserNodeId,
          requestId: 'diag_' + Date.now(),
          maxPeers: 20,
          metadata: { nodeType: 'browser' }
        }));
      }
      
      if (msg.type === 'response') {
        ws.close();
        resolve(msg.data);
      }
    });
    
    ws.on('error', (e) => {
      console.log('❌ Browser error:', e.message);
      resolve(null);
    });
    
    setTimeout(() => {
      ws.close();
      resolve(null);
    }, 15000);
  });
  
  // Step 4: Analyze results
  console.log('\n📊 Step 4: Analysis');
  console.log('===================');
  
  if (!result) {
    console.log('❌ No response received');
  } else {
    console.log('Status:', result.status);
    console.log('Message:', result.message);
    console.log('Peers:', result.peers?.length || 0);
    
    if (result.message?.includes('No bridge nodes')) {
      console.log('\n❌ CONFIRMED: Bridge node not found in connectedClients');
      console.log('\n🔍 POSSIBLE CAUSES:');
      console.log('   1. The handleNewPeer method is not storing metadata correctly');
      console.log('   2. The connectedClients map is being cleared somewhere');
      console.log('   3. The requestOnboardingPeerFromBridge is checking wrong field');
      console.log('   4. There\'s a race condition in metadata storage');
      
      console.log('\n📝 NEXT STEPS:');
      console.log('   1. Check server logs for the DEBUG output we added');
      console.log('   2. Look for "DEBUG: Checking X connected clients for bridge nodes"');
      console.log('   3. See what metadata is actually stored for each client');
    } else if (result.status === 'helper_coordinating') {
      console.log('\n✅ Bridge node WAS found!');
      console.log('   The issue might be with the bridge response, not storage.');
    } else if (result.status === 'genesis') {
      console.log('\n⚠️ Genesis mode - no existing DHT network');
      console.log('   This means the server thinks there are no DHT nodes.');
    }
  }
  
  // Clean up
  console.log('\n🧹 Cleaning up...');
  bridgeWs.close();
  
  console.log('\n✅ Diagnosis complete');
}

main().catch(console.error);
