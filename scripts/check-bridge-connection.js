#!/usr/bin/env node

/**
 * Check if bridge nodes are connected to bootstrap server
 */

import WebSocket from 'ws';

const BOOTSTRAP_URL = 'wss://imeyouwe.com/ws';
const BUILD_ID = '4dc3012681af4cde9c5a';

async function checkBridgeConnection() {
  console.log('🔍 CHECKING BRIDGE NODE CONNECTIONS');
  console.log('====================================');
  
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
      console.log('✅ Connected to bootstrap');
      
      // Register as a bridge node to see what happens
      ws.send(JSON.stringify({
        type: 'register',
        nodeId: 'diag_bridge_check_' + Date.now(),
        protocolVersion: '1.0.0',
        buildId: BUILD_ID,
        metadata: {
          nodeType: 'bridge',
          isBridgeNode: true,
          capabilities: ['websocket']
        }
      }));
    });
    
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      console.log(`\n📥 ${msg.type}:`);
      
      if (msg.type === 'registered') {
        console.log('✅ Registered as bridge node');
        
        // Now request peers to see what the server knows about
        ws.send(JSON.stringify({
          type: 'get_peers_or_genesis',
          requestId: 'bridge_check_' + Date.now(),
          nodeId: 'diag_bridge_check_' + Date.now(),
          maxPeers: 100,
          metadata: {
            nodeType: 'bridge',
            isBridgeNode: true
          }
        }));
      }
      
      if (msg.type === 'response') {
        console.log('Response data:', JSON.stringify(msg.data, null, 2));
        
        const peers = msg.data?.peers || [];
        console.log(`\n📊 ANALYSIS:`);
        console.log(`   Total peers: ${peers.length}`);
        
        // Count by type
        const bridgeNodes = peers.filter(p => p.metadata?.isBridgeNode || p.metadata?.nodeType === 'bridge');
        const dhtNodes = peers.filter(p => p.metadata?.nodeType === 'dht' || p.metadata?.nodeType === 'genesis');
        const browserNodes = peers.filter(p => p.metadata?.nodeType === 'browser');
        const otherNodes = peers.filter(p => !bridgeNodes.includes(p) && !dhtNodes.includes(p) && !browserNodes.includes(p));
        
        console.log(`   Bridge nodes: ${bridgeNodes.length}`);
        console.log(`   DHT nodes: ${dhtNodes.length}`);
        console.log(`   Browser nodes: ${browserNodes.length}`);
        console.log(`   Other nodes: ${otherNodes.length}`);
        
        if (bridgeNodes.length === 0) {
          console.log('\n⚠️ NO BRIDGE NODES CONNECTED TO BOOTSTRAP');
          console.log('   This is why the onboarding flow fails!');
          console.log('   Bridge nodes need to be running and connected.');
        }
        
        if (dhtNodes.length === 0) {
          console.log('\n⚠️ NO DHT NODES CONNECTED TO BOOTSTRAP');
          console.log('   Genesis and DHT nodes are not connected.');
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
      console.log('\n🔌 Closed');
    });
  });
}

checkBridgeConnection().catch(console.error);
