#!/usr/bin/env node

/**
 * Test Bridge Registration
 * 
 * Simulates a bridge node registering with the bootstrap server
 * to verify that isBridgeNode metadata is being sent correctly.
 */

import WebSocket from 'ws';
import crypto from 'crypto';

const BOOTSTRAP_URL = 'wss://imeyouwe.com/ws';
const BUILD_ID = '1175e908e202515e8b1a';

function generateNodeId() {
  return crypto.randomBytes(20).toString('hex');
}

async function testBridgeRegistration() {
  console.log('🧪 TESTING BRIDGE NODE REGISTRATION');
  console.log('====================================');
  
  const nodeId = generateNodeId();
  console.log(`\n🆔 Generated Node ID: ${nodeId.substring(0, 16)}...`);
  
  return new Promise((resolve) => {
    console.log('\n📡 Connecting to bootstrap server...');
    
    const ws = new WebSocket(BOOTSTRAP_URL, {
      rejectUnauthorized: false
    });
    
    const timeout = setTimeout(() => {
      console.log('\n⏰ Test timeout');
      ws.close();
      resolve();
    }, 15000);
    
    ws.on('open', () => {
      console.log('✅ Connected to bootstrap server');
      
      // Register as a BRIDGE NODE with isBridgeNode: true
      console.log('\n📤 Sending bridge node registration...');
      const registerMsg = {
        type: 'register',
        nodeId: nodeId,
        protocolVersion: '1.0.0',
        buildId: BUILD_ID,
        timestamp: Date.now(),
        metadata: {
          isBridgeNode: true,  // THIS IS THE KEY FIELD
          nodeType: 'bridge',
          capabilities: ['websocket', 'observer'],
          listeningAddress: 'wss://imeyouwe.com/bridge-test',
          bridgeAuthToken: 'test-bridge-auth'
        }
      };
      ws.send(JSON.stringify(registerMsg));
      console.log('   Sent:', JSON.stringify(registerMsg, null, 2));
    });
    
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      console.log(`\n📥 Received: ${msg.type}`);
      console.log('   Full message:', JSON.stringify(msg, null, 2));
      
      if (msg.type === 'registered') {
        console.log('\n✅ Bridge node registered successfully!');
        console.log('   The bootstrap server should now have this node in connectedClients');
        console.log('   with metadata.isBridgeNode = true');
        
        // Now test if we can be found as a bridge node
        // by requesting peers as a different client
        setTimeout(() => {
          testFindBridgeNode(nodeId).then(() => {
            clearTimeout(timeout);
            ws.close();
            resolve();
          });
        }, 2000);
      }
      
      if (msg.type === 'version_mismatch') {
        console.log('\n❌ Version mismatch - cannot test');
        clearTimeout(timeout);
        ws.close();
        resolve();
      }
    });
    
    ws.on('error', (e) => {
      console.log('❌ Error:', e.message);
      clearTimeout(timeout);
      resolve();
    });
    
    ws.on('close', () => {
      console.log('🔌 Connection closed');
    });
  });
}

async function testFindBridgeNode(bridgeNodeId) {
  console.log('\n🔍 Testing if bridge node can be found...');
  
  return new Promise((resolve) => {
    const ws = new WebSocket(BOOTSTRAP_URL, {
      rejectUnauthorized: false
    });
    
    const testNodeId = crypto.randomBytes(20).toString('hex');
    
    ws.on('open', () => {
      // Register as a regular browser client
      ws.send(JSON.stringify({
        type: 'register',
        nodeId: testNodeId,
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
      
      if (msg.type === 'registered') {
        // Request peers
        ws.send(JSON.stringify({
          type: 'get_peers_or_genesis',
          nodeId: testNodeId,
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
        
        if (msg.data?.message?.includes('No bridge nodes')) {
          console.log('\n❌ PROBLEM CONFIRMED: Bootstrap server has no bridge nodes!');
          console.log('   Even though we just registered one, it\'s not being found.');
          console.log('   This means the metadata.isBridgeNode is not being stored correctly.');
        }
        
        ws.close();
        resolve();
      }
    });
    
    ws.on('error', () => {
      resolve();
    });
    
    setTimeout(() => {
      ws.close();
      resolve();
    }, 5000);
  });
}

testBridgeRegistration().catch(console.error);
