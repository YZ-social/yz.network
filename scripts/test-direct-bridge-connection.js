#!/usr/bin/env node

/**
 * Test direct WebSocket connection to bridge nodes (bypassing nginx)
 */

import WebSocket from 'ws';

const BRIDGE_NODES = [
  { name: 'bridge-node-1', url: 'ws://yz-bridge-node-1:8083' },
  { name: 'bridge-node-2', url: 'ws://yz-bridge-node-2:8084' }
];

async function testDirectConnection(node) {
  return new Promise((resolve) => {
    console.log(`🔍 Testing direct connection to ${node.name} at ${node.url}...`);
    
    const ws = new WebSocket(node.url);
    
    const timeout = setTimeout(() => {
      console.log(`❌ ${node.name}: Connection timeout`);
      ws.terminate();
      resolve({ success: false, error: 'timeout' });
    }, 10000);
    
    ws.on('open', () => {
      clearTimeout(timeout);
      console.log(`✅ ${node.name}: Direct WebSocket connection established`);
      
      // Send a test message
      ws.send(JSON.stringify({
        type: 'ping',
        timestamp: Date.now()
      }));
      
      setTimeout(() => {
        ws.close();
        resolve({ success: true });
      }, 1000);
    });
    
    ws.on('message', (data) => {
      console.log(`📥 ${node.name}: Received:`, data.toString());
    });
    
    ws.on('error', (error) => {
      clearTimeout(timeout);
      console.log(`❌ ${node.name}: WebSocket error:`, error.message);
      resolve({ success: false, error: error.message });
    });
    
    ws.on('close', (code, reason) => {
      clearTimeout(timeout);
      console.log(`🔌 ${node.name}: Connection closed (${code}): ${reason}`);
    });
  });
}

async function main() {
  console.log('🧪 Testing direct bridge node connections...\n');
  
  for (const node of BRIDGE_NODES) {
    const result = await testDirectConnection(node);
    console.log(`Result for ${node.name}:`, result);
    console.log('');
  }
  
  console.log('✅ Direct connection test completed');
}

main().catch(console.error);