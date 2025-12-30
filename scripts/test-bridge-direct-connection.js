#!/usr/bin/env node

/**
 * Test direct connection to bridge nodes
 * 
 * This tests if the bridge nodes are reachable at all
 */

import WebSocket from 'ws';

const BRIDGE_NODES = [
  'wss://imeyouwe.com/bridge1',
  'wss://imeyouwe.com/bridge2',
  'ws://localhost:8083',
  'ws://localhost:8084'
];

const BRIDGE_AUTH = process.env.BRIDGE_AUTH || 'default-bridge-auth-key';

async function testBridgeConnection(bridgeUrl) {
  console.log(`\n🔗 Testing connection to ${bridgeUrl}...`);
  
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.log(`   ⏰ Timeout after 10 seconds`);
      resolve({ url: bridgeUrl, success: false, error: 'timeout' });
    }, 10000);
    
    try {
      const ws = new WebSocket(bridgeUrl, {
        rejectUnauthorized: false,
        headers: {
          'X-Bridge-Auth': BRIDGE_AUTH
        }
      });
      
      ws.on('open', () => {
        console.log(`   ✅ Connected!`);
        
        // Send a test message
        ws.send(JSON.stringify({
          type: 'ping',
          timestamp: Date.now()
        }));
        
        // Wait for response
        setTimeout(() => {
          clearTimeout(timeout);
          ws.close();
          resolve({ url: bridgeUrl, success: true });
        }, 2000);
      });
      
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          console.log(`   📥 Received: ${msg.type}`);
        } catch (e) {
          console.log(`   📥 Received: ${data.toString().substring(0, 100)}`);
        }
      });
      
      ws.on('error', (e) => {
        console.log(`   ❌ Error: ${e.message}`);
        clearTimeout(timeout);
        resolve({ url: bridgeUrl, success: false, error: e.message });
      });
      
      ws.on('close', (code, reason) => {
        console.log(`   🔌 Closed: ${code} ${reason || ''}`);
      });
      
    } catch (e) {
      console.log(`   ❌ Exception: ${e.message}`);
      clearTimeout(timeout);
      resolve({ url: bridgeUrl, success: false, error: e.message });
    }
  });
}

async function main() {
  console.log('🧪 TESTING DIRECT BRIDGE NODE CONNECTIONS');
  console.log('==========================================');
  console.log(`Auth token: ${BRIDGE_AUTH === 'default-bridge-auth-key' ? 'DEFAULT' : 'CUSTOM'}`);
  
  const results = [];
  
  for (const bridgeUrl of BRIDGE_NODES) {
    const result = await testBridgeConnection(bridgeUrl);
    results.push(result);
  }
  
  console.log('\n📊 SUMMARY');
  console.log('==========');
  
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  
  console.log(`Successful: ${successful.length}/${results.length}`);
  
  if (successful.length > 0) {
    console.log('\n✅ REACHABLE BRIDGES:');
    for (const r of successful) {
      console.log(`   ${r.url}`);
    }
  }
  
  if (failed.length > 0) {
    console.log('\n❌ UNREACHABLE BRIDGES:');
    for (const r of failed) {
      console.log(`   ${r.url}: ${r.error}`);
    }
  }
  
  if (successful.length === 0) {
    console.log('\n🚨 NO BRIDGE NODES ARE REACHABLE!');
    console.log('   This is why browsers cannot get peers.');
    console.log('   The bridge nodes need to be running and accessible.');
  }
}

main().catch(console.error);
