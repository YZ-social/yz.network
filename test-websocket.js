#!/usr/bin/env node

import WebSocket from 'ws';

const testAddress = process.argv[2] || 'wss://imeyouwe.com/node1';

console.log(`🔍 Testing WebSocket connection to: ${testAddress}`);

const ws = new WebSocket(testAddress);

const timeout = setTimeout(() => {
  console.log('❌ Connection timeout');
  ws.close();
  process.exit(1);
}, 10000);

ws.on('open', () => {
  clearTimeout(timeout);
  console.log('✅ WebSocket connection established');
  
  // Send a test message
  ws.send(JSON.stringify({
    type: 'dht_peer_hello',
    peerId: 'test-client-' + Date.now(),
    metadata: { nodeType: 'test' }
  }));
  
  console.log('📤 Sent handshake message');
});

ws.on('message', (data) => {
  console.log('📥 Received message:', data.toString());
  ws.close();
  process.exit(0);
});

ws.on('error', (error) => {
  clearTimeout(timeout);
  console.log('❌ WebSocket error:', error.message);
  process.exit(1);
});

ws.on('close', (code, reason) => {
  clearTimeout(timeout);
  console.log(`🔌 Connection closed: ${code} ${reason}`);
  process.exit(code === 1000 ? 0 : 1);
});