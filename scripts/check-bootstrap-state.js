#!/usr/bin/env node

/**
 * Check Bootstrap Server State
 * 
 * Connects to bootstrap and checks what clients/bridges are connected
 */

import WebSocket from 'ws';

const BOOTSTRAP_URL = 'wss://imeyouwe.com/ws';
const BUILD_ID = '4dc3012681af4cde9c5a'; // Server's current build ID

async function checkBootstrapState() {
  console.log('🔍 CHECKING BOOTSTRAP SERVER STATE');
  console.log('===================================');
  
  // First check the stats endpoint
  console.log('\n📊 Checking /stats endpoint...');
  try {
    const response = await fetch('https://imeyouwe.com/ws/stats');
    const stats = await response.json();
    console.log('Stats:', JSON.stringify(stats, null, 2));
  } catch (e) {
    console.log('Stats endpoint error:', e.message);
  }
  
  // Check health endpoint
  console.log('\n📊 Checking /health endpoint...');
  try {
    const response = await fetch('https://imeyouwe.com/ws/health');
    const health = await response.json();
    console.log('Health:', JSON.stringify(health, null, 2));
  } catch (e) {
    console.log('Health endpoint error:', e.message);
  }
  
  // Connect via WebSocket and check
  console.log('\n📡 Connecting via WebSocket...');
  
  return new Promise((resolve) => {
    const ws = new WebSocket(BOOTSTRAP_URL, {
      rejectUnauthorized: false
    });
    
    const timeout = setTimeout(() => {
      console.log('\n⏰ Timeout');
      ws.close();
      resolve();
    }, 15000);
    
    ws.on('open', () => {
      console.log('✅ Connected');
      
      // Register as a diagnostic client
      ws.send(JSON.stringify({
        type: 'register',
        nodeId: 'diagnostic_' + Date.now(),
        protocolVersion: '1.0.0',
        buildId: BUILD_ID,
        metadata: {
          nodeType: 'diagnostic',
          capabilities: []
        }
      }));
    });
    
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      console.log(`📥 ${msg.type}:`, JSON.stringify(msg, null, 2));
      
      if (msg.type === 'registered') {
        // Request peer list using get_peers_or_genesis (what browser uses)
        console.log('📤 Sending get_peers_or_genesis request...');
        ws.send(JSON.stringify({
          type: 'get_peers_or_genesis',
          requestId: 'diag_' + Date.now(),
          nodeId: 'diagnostic_' + Date.now(),
          maxPeers: 100,
          metadata: {
            nodeType: 'browser',
            capabilities: ['websocket']
          }
        }));
      }
      
      if (msg.type === 'peer_list' || msg.type === 'response') {
        console.log('\n📊 PEER LIST RECEIVED:');
        if (msg.data?.peers) {
          console.log(`   Total peers: ${msg.data.peers.length}`);
          for (const peer of msg.data.peers) {
            console.log(`   - ${peer.nodeId?.substring(0, 12)}... (${peer.metadata?.nodeType || 'unknown'})`);
          }
        } else if (msg.peers) {
          console.log(`   Total peers: ${msg.peers.length}`);
          for (const peer of msg.peers) {
            console.log(`   - ${peer.nodeId?.substring(0, 12)}... (${peer.metadata?.nodeType || 'unknown'})`);
          }
        }
        clearTimeout(timeout);
        setTimeout(() => {
          ws.close();
          resolve();
        }, 1000);
      }
    });
    
    ws.on('error', (e) => {
      console.log('❌ Error:', e.message);
      clearTimeout(timeout);
      resolve();
    });
    
    ws.on('close', () => {
      console.log('🔌 Closed');
    });
  });
}

checkBootstrapState().catch(console.error);
