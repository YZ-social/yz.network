#!/usr/bin/env node

/**
 * Test Browser Onboarding Flow
 * 
 * Simulates what happens when a browser client tries to join the DHT network.
 * This will help identify why the browser receives 0 peers despite 15 healthy nodes.
 */

import WebSocket from 'ws';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const BOOTSTRAP_URL = 'wss://imeyouwe.com/ws';
const PROTOCOL_VERSION = '1.0.0';

// Read BUILD_ID from bundle-hash.json (same as server does)
// OVERRIDE: Use server's BUILD_ID for testing
let BUILD_ID = '1175e908e202515e8b1a'; // Server's current BUILD_ID
console.log(`📦 Using server's BUILD_ID for testing: ${BUILD_ID}`);

function generateNodeId() {
  return crypto.randomBytes(20).toString('hex');
}

async function testBrowserOnboarding() {
  console.log('🧪 TESTING BROWSER ONBOARDING FLOW');
  console.log('===================================');
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Bootstrap URL: ${BOOTSTRAP_URL}`);
  
  const nodeId = generateNodeId();
  console.log(`\n🆔 Generated Node ID: ${nodeId.substring(0, 16)}...`);
  
  return new Promise((resolve, reject) => {
    console.log('\n📡 Connecting to bootstrap server...');
    
    const ws = new WebSocket(BOOTSTRAP_URL, {
      rejectUnauthorized: false,
      headers: {
        'Origin': 'https://imeyouwe.com'
      }
    });
    
    let requestId = null;
    const timeout = setTimeout(() => {
      console.log('\n⏰ Test timeout after 30 seconds');
      ws.close();
      resolve();
    }, 30000);
    
    ws.on('open', () => {
      console.log('✅ Connected to bootstrap server');
      
      // Step 1: Register with bootstrap server
      console.log('\n📤 Step 1: Sending registration...');
      const registerMsg = {
        type: 'register',
        nodeId: nodeId,
        protocolVersion: PROTOCOL_VERSION,
        buildId: BUILD_ID,
        metadata: {
          nodeType: 'browser',  // Simulate browser client
          capabilities: ['webrtc'],
          tabVisible: true,
          startTime: Date.now()
        }
      };
      ws.send(JSON.stringify(registerMsg));
      console.log('   Sent:', JSON.stringify(registerMsg, null, 2));
      
      // Step 2: Request peers (after short delay)
      setTimeout(() => {
        console.log('\n📤 Step 2: Requesting peers (get_peers_or_genesis)...');
        requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const getPeersMsg = {
          type: 'get_peers_or_genesis',
          nodeId: nodeId,
          requestId: requestId,
          maxPeers: 20,
          metadata: {
            nodeType: 'browser',
            capabilities: ['webrtc'],
            tabVisible: true,
            startTime: Date.now()
          }
        };
        ws.send(JSON.stringify(getPeersMsg));
        console.log('   Sent:', JSON.stringify(getPeersMsg, null, 2));
      }, 1000);
    });
    
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        console.log(`\n📥 Received message type: ${message.type}`);
        console.log('   Full message:', JSON.stringify(message, null, 2));
        
        if (message.type === 'response' && message.requestId === requestId) {
          console.log('\n📊 BOOTSTRAP RESPONSE ANALYSIS:');
          console.log('================================');
          
          if (message.success) {
            const data = message.data || {};
            console.log(`   Success: ${message.success}`);
            console.log(`   Is Genesis: ${data.isGenesis || false}`);
            console.log(`   Status: ${data.status || 'N/A'}`);
            console.log(`   Peers count: ${data.peers?.length || 0}`);
            console.log(`   Emergency Mode: ${data.emergencyMode || false}`);
            console.log(`   Message: ${data.message || 'N/A'}`);
            
            if (data.peers && data.peers.length > 0) {
              console.log('\n   📋 PEERS RECEIVED:');
              for (const peer of data.peers) {
                console.log(`      - ${peer.nodeId?.substring(0, 12)}...`);
                console.log(`        Type: ${peer.metadata?.nodeType || 'unknown'}`);
                console.log(`        Bridge: ${peer.metadata?.isBridgeNode || false}`);
                console.log(`        Address: ${peer.metadata?.listeningAddress || peer.metadata?.websocketAddress || 'N/A'}`);
              }
            } else {
              console.log('\n   ⚠️ NO PEERS RECEIVED!');
              console.log('   This is the problem - browser has no peers to connect to.');
              
              if (data.status === 'helper_coordinating') {
                console.log('\n   💡 Status is "helper_coordinating" - bootstrap is trying async coordination');
                console.log('      This means bridge node findNode returned 0 peers');
                console.log('      But dashboard shows 15 healthy nodes with 8.5 avg connections!');
                console.log('      POSSIBLE CAUSES:');
                console.log('      1. Bridge node is not connected to DHT nodes');
                console.log('      2. Bridge node routing table is empty');
                console.log('      3. Bridge node findNode is filtering out all peers');
              }
            }
          } else {
            console.log(`   ❌ Request failed: ${message.error || 'Unknown error'}`);
          }
          
          // Close after receiving response
          setTimeout(() => {
            clearTimeout(timeout);
            ws.close();
            resolve();
          }, 2000);
        }
      } catch (e) {
        console.log(`   Raw data: ${data.toString().substring(0, 200)}`);
      }
    });
    
    ws.on('error', (error) => {
      console.log(`\n❌ WebSocket error: ${error.message}`);
      clearTimeout(timeout);
      reject(error);
    });
    
    ws.on('close', (code, reason) => {
      console.log(`\n🔌 Connection closed: ${code} - ${reason || 'No reason'}`);
    });
  });
}

testBrowserOnboarding().catch(console.error);
