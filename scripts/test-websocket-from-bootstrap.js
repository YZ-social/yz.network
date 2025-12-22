#!/usr/bin/env node

/**
 * Test WebSocket connection from bootstrap container to bridge nodes
 * This will help us debug the 502 error
 */

import WebSocket from 'ws';

async function testDirectConnection(address) {
  return new Promise((resolve) => {
    console.log(`🔗 Testing direct connection to ${address}...`);
    
    const ws = new WebSocket(address, {
      timeout: 5000,
      rejectUnauthorized: false
    });

    const timeout = setTimeout(() => {
      ws.terminate();
      resolve({
        address,
        success: false,
        error: 'Timeout (5s)'
      });
    }, 5000);

    ws.on('open', () => {
      clearTimeout(timeout);
      console.log(`✅ Direct connection to ${address} successful`);
      ws.close();
      resolve({
        address,
        success: true,
        error: null
      });
    });

    ws.on('error', (error) => {
      clearTimeout(timeout);
      console.log(`❌ Direct connection to ${address} failed: ${error.message}`);
      resolve({
        address,
        success: false,
        error: error.message
      });
    });
  });
}

async function testProxiedConnection(address) {
  return new Promise((resolve) => {
    console.log(`🔗 Testing proxied connection to ${address}...`);
    
    const ws = new WebSocket(address, {
      timeout: 5000,
      rejectUnauthorized: false
    });

    const timeout = setTimeout(() => {
      ws.terminate();
      resolve({
        address,
        success: false,
        error: 'Timeout (5s)'
      });
    }, 5000);

    ws.on('open', () => {
      clearTimeout(timeout);
      console.log(`✅ Proxied connection to ${address} successful`);
      ws.close();
      resolve({
        address,
        success: true,
        error: null
      });
    });

    ws.on('error', (error) => {
      clearTimeout(timeout);
      console.log(`❌ Proxied connection to ${address} failed: ${error.message}`);
      resolve({
        address,
        success: false,
        error: error.message
      });
    });
  });
}

async function main() {
  console.log('🧪 Testing WebSocket Connections from Bootstrap Container');
  console.log('======================================================');
  
  // Test direct connections to bridge nodes
  console.log('\n📡 Testing Direct Connections:');
  const directTests = [
    'ws://yz-bridge-node-1:8083',
    'ws://yz-bridge-node-2:8084'
  ];
  
  for (const address of directTests) {
    const result = await testDirectConnection(address);
    if (result.success) {
      console.log(`✅ ${result.address}: SUCCESS`);
    } else {
      console.log(`❌ ${result.address}: FAILED - ${result.error}`);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  // Test proxied connections through nginx
  console.log('\n🌐 Testing Proxied Connections:');
  const proxiedTests = [
    'wss://imeyouwe.com/bridge1',
    'wss://imeyouwe.com/bridge2'
  ];
  
  for (const address of proxiedTests) {
    const result = await testProxiedConnection(address);
    if (result.success) {
      console.log(`✅ ${result.address}: SUCCESS`);
    } else {
      console.log(`❌ ${result.address}: FAILED - ${result.error}`);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  console.log('\n🎯 Test Complete');
}

main().catch(error => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});