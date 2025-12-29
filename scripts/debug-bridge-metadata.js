#!/usr/bin/env node

/**
 * Debug Bridge Metadata Storage
 * 
 * Tests whether bridge node metadata is being stored correctly
 * by keeping the bridge connection open while testing.
 */

import WebSocket from 'ws';
import crypto from 'crypto';

const BOOTSTRAP_URL = 'wss://imeyouwe.com/ws';
const BUILD_ID = '1175e908e202515e8b1a';

function generateNodeId() {
  return crypto.randomBytes(20).toString('hex');
}

async function main() {
  console.log('🧪 DEBUG BRIDGE METADATA STORAGE');
  console.log('=================================\n');
  
  const bridgeNodeId = generateNodeId();
  console.log(`🆔 Bridge Node ID: ${bridgeNodeId.substring(0, 16)}...`);
  
  // Step 1: Connect and register as bridge node
  console.log('\n📡 Step 1: Connecting as bridge node...');
  
  const bridgeWs = await new Promise((resolve, reject) => {
    const ws = new WebSocket(BOOTSTRAP_URL, { rejectUnauthorized: false });
    
    ws.on('open', () => {
      console.log('✅ Bridge connected');
      
      // Register as bridge node
      ws.send(JSON.stringify({
        type: 'register',
        nodeId: bridgeNodeId,
        protocolVersion: '1.0.0',
        buildId: BUILD_ID,
        timestamp: Date.now(),
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
      console.log(`📥 Bridge received: ${msg.type}`);
      
      if (msg.type === 'registered') {
        console.log('✅ Bridge registered successfully');
        resolve(ws);
      }
      
      if (msg.type === 'version_mismatch') {
        console.log('❌ Version mismatch');
        reject(new Error('Version mismatch'));
      }
    });
    
    ws.on('error', (e) => reject(e));
    
    setTimeout(() => reject(new Error('Timeout')), 10000);
  });
  
  // Step 2: Wait a moment for server to process
  console.log('\n⏳ Step 2: Waiting 2 seconds for server to process...');
  await new Promise(r => setTimeout(r, 2000));
  
  // Step 3: Connect as browser client and request peers (while bridge is still connected)
  console.log('\n📡 Step 3: Connecting as browser client (bridge still connected)...');
  
  const browserNodeId = generateNodeId();
  console.log(`🆔 Browser Node ID: ${browserNodeId.substring(0, 16)}...`);
  
  const result = await new Promise((resolve) => {
    const ws = new WebSocket(BOOTSTRAP_URL, { rejectUnauthorized: false });
    
    ws.on('open', () => {
      console.log('✅ Browser connected');
      
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
        console.log('✅ Browser registered, requesting peers...');
        
        ws.send(JSON.stringify({
          type: 'get_peers_or_genesis',
          nodeId: browserNodeId,
          requestId: 'test_' + Date.now(),
          maxPeers: 20,
          metadata: {
            nodeType: 'browser'
          }
        }));
      }
      
      if (msg.type === 'response') {
        console.log('\n📊 PEER RESPONSE:');
        console.log('   Status:', msg.data?.status);
        console.log('   Peers:', msg.data?.peers?.length || 0);
        console.log('   Message:', msg.data?.message);
        
        if (msg.data?.peers?.length > 0) {
          console.log('\n   Peer details:');
          for (const peer of msg.data.peers) {
            console.log(`   - ${peer.nodeId?.substring(0, 16)}... (${peer.metadata?.nodeType || 'unknown'})`);
          }
        }
        
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
    }, 10000);
  });
  
  // Step 4: Check if bridge was found
  console.log('\n📋 Step 4: Analysis');
  console.log('===================');
  
  if (result?.message?.includes('No bridge nodes')) {
    console.log('❌ PROBLEM: Bridge node was NOT found in connectedClients');
    console.log('   Even though the bridge connection is still open!');
    console.log('   This suggests the metadata is not being stored correctly.');
  } else if (result?.status === 'helper_coordinating') {
    console.log('✅ Bridge node WAS found (helper_coordinating status)');
    console.log('   The issue might be with the bridge response, not storage.');
  } else if (result?.status === 'genesis') {
    console.log('⚠️ Genesis mode - no existing DHT network');
  } else {
    console.log('❓ Unexpected result:', result);
  }
  
  // Clean up
  console.log('\n🧹 Cleaning up...');
  bridgeWs.close();
  
  console.log('\n✅ Test complete');
}

main().catch(console.error);
