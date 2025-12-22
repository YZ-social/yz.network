#!/usr/bin/env node

/**
 * Test nginx WebSocket proxy functionality
 * Tests if bootstrap server can connect to bridge nodes through nginx proxy
 */

import WebSocket from 'ws';

const BRIDGE_URLS = [
  'wss://imeyouwe.com/bridge1',
  'wss://imeyouwe.com/bridge2'
];

async function testWebSocketConnection(url) {
  return new Promise((resolve) => {
    console.log(`🔍 Testing WebSocket connection to ${url}...`);
    
    const ws = new WebSocket(url, {
      rejectUnauthorized: false, // Allow self-signed certificates
      timeout: 10000
    });
    
    const timeout = setTimeout(() => {
      console.log(`❌ ${url}: Connection timeout`);
      ws.terminate();
      resolve({ success: false, error: 'timeout' });
    }, 10000);
    
    ws.on('open', () => {
      clearTimeout(timeout);
      console.log(`✅ ${url}: WebSocket connection established`);
      
      // Send a test message
      ws.send(JSON.stringify({
        type: 'ping',
        timestamp: Date.now()
      }));
    });
    
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        console.log(`📥 ${url}: Received message:`, message);
        ws.close();
        resolve({ success: true, message });
      } catch (error) {
        console.log(`📥 ${url}: Received raw data:`, data.toString());
        ws.close();
        resolve({ success: true, data: data.toString() });
      }
    });
    
    ws.on('error', (error) => {
      clearTimeout(timeout);
      console.log(`❌ ${url}: WebSocket error:`, error.message);
      resolve({ success: false, error: error.message });
    });
    
    ws.on('close', (code, reason) => {
      clearTimeout(timeout);
      console.log(`🔌 ${url}: Connection closed (${code}): ${reason}`);
      if (!resolve.called) {
        resolve({ success: false, error: `Connection closed: ${code} ${reason}` });
      }
    });
  });
}

async function main() {
  console.log('🧪 Testing nginx WebSocket proxy functionality...\n');
  
  for (const url of BRIDGE_URLS) {
    const result = await testWebSocketConnection(url);
    console.log(`Result for ${url}:`, result);
    console.log('');
  }
  
  console.log('✅ WebSocket proxy test completed');
}

main().catch(console.error);