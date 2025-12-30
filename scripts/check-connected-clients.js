#!/usr/bin/env node

/**
 * Check what clients are connected to the bootstrap server
 */

import WebSocket from 'ws';

const BOOTSTRAP_URL = 'wss://imeyouwe.com/ws';
const BUILD_ID = '4dc3012681af4cde9c5a';

async function checkConnectedClients() {
  console.log('🔍 CHECKING CONNECTED CLIENTS');
  console.log('==============================');
  
  return new Promise((resolve) => {
    const ws = new WebSocket(BOOTSTRAP_URL, {
      rejectUnauthorized: false
    });
    
    const timeout = setTimeout(() => {
      console.log('\n⏰ Timeout');
      ws.close();
      resolve();
    }, 20000);
    
    ws.on('open', () => {
      console.log('✅ Connected to bootstrap server');
      
      // Register as a diagnostic client
      ws.send(JSON.stringify({
        type: 'register',
        nodeId: 'diag_checker_' + Date.now(),
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
      
      if (msg.type === 'registered') {
        console.log('✅ Registered with bootstrap');
        
        // Request peers using get_peers_or_genesis
        ws.send(JSON.stringify({
          type: 'get_peers_or_genesis',
          requestId: 'check_' + Date.now(),
          nodeId: 'diag_checker_' + Date.now(),
          maxPeers: 100,
          metadata: {
            nodeType: 'diagnostic',
            capabilities: []
          }
        }));
      }
      
      if (msg.type === 'response') {
        console.log('\n📊 BOOTSTRAP SERVER RESPONSE:');
        console.log(`   Success: ${msg.success}`);
        console.log(`   Status: ${msg.data?.status || 'N/A'}`);
        console.log(`   Emergency Mode: ${msg.data?.emergencyMode || false}`);
        console.log(`   Is Genesis: ${msg.data?.isGenesis || false}`);
        console.log(`   Message: ${msg.data?.message || 'N/A'}`);
        
        const peers = msg.data?.peers || [];
        console.log(`\n📋 CONNECTED PEERS (${peers.length}):`);
        
        // Categorize peers
        const bridgeNodes = [];
        const dhtNodes = [];
        const browserNodes = [];
        const otherNodes = [];
        
        for (const peer of peers) {
          const nodeType = peer.metadata?.nodeType || 'unknown';
          const isBridge = peer.metadata?.isBridgeNode || nodeType === 'bridge';
          
          if (isBridge) {
            bridgeNodes.push(peer);
          } else if (nodeType === 'browser') {
            browserNodes.push(peer);
          } else if (nodeType === 'dht' || nodeType === 'genesis') {
            dhtNodes.push(peer);
          } else {
            otherNodes.push(peer);
          }
        }
        
        console.log(`\n🌉 BRIDGE NODES (${bridgeNodes.length}):`);
        for (const peer of bridgeNodes) {
          console.log(`   - ${peer.nodeId?.substring(0, 16)}...`);
          console.log(`     Address: ${peer.metadata?.websocketAddress || peer.metadata?.listeningAddress || 'N/A'}`);
        }
        
        console.log(`\n🔗 DHT NODES (${dhtNodes.length}):`);
        for (const peer of dhtNodes) {
          console.log(`   - ${peer.nodeId?.substring(0, 16)}... (${peer.metadata?.nodeType || 'dht'})`);
        }
        
        console.log(`\n🌐 BROWSER NODES (${browserNodes.length}):`);
        for (const peer of browserNodes) {
          console.log(`   - ${peer.nodeId?.substring(0, 16)}...`);
          console.log(`     Can accept: ${peer.metadata?.canAcceptConnections}`);
          console.log(`     Can initiate: ${peer.metadata?.canInitiateConnections}`);
        }
        
        console.log(`\n❓ OTHER NODES (${otherNodes.length}):`);
        for (const peer of otherNodes) {
          console.log(`   - ${peer.nodeId?.substring(0, 16)}... (${peer.metadata?.nodeType || 'unknown'})`);
        }
        
        // Analysis
        console.log('\n💡 ANALYSIS:');
        if (bridgeNodes.length === 0) {
          console.log('   ⚠️ NO BRIDGE NODES CONNECTED');
          console.log('      - Bridge nodes are required for browser onboarding');
          console.log('      - Check if bridge containers are running');
        }
        if (dhtNodes.length === 0) {
          console.log('   ⚠️ NO DHT NODES CONNECTED');
          console.log('      - Genesis and DHT nodes are not connected to bootstrap');
          console.log('      - Check if genesis/node containers are running');
        }
        if (browserNodes.length > 0 && bridgeNodes.length === 0 && dhtNodes.length === 0) {
          console.log('   🚨 BROWSERS CONNECTED BUT NO INFRASTRUCTURE');
          console.log('      - Browsers cannot connect to each other without bridge/DHT nodes');
          console.log('      - Need to restart infrastructure containers');
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
      console.log('\n🔌 Connection closed');
    });
  });
}

checkConnectedClients().catch(console.error);
