#!/usr/bin/env node

/**
 * Test Docker Bridge Connectivity
 * 
 * Tests if the bootstrap server can connect to bridge nodes via nginx proxy
 * from inside the Docker network after the networking changes.
 */

import WebSocket from 'ws';

const bridgeAddresses = [
  'wss://imeyouwe.com/bridge1',
  'wss://imeyouwe.com/bridge2'
];

async function testBridgeConnection(address) {
  return new Promise((resolve) => {
    console.log(`🔗 Testing connection to ${address}...`);
    
    const ws = new WebSocket(address, {
      timeout: 10000,
      rejectUnauthorized: false // Allow self-signed certificates for testing
    });

    const timeout = setTimeout(() => {
      ws.terminate();
      resolve({
        address,
        success: false,
        error: 'Connection timeout (10s)'
      });
    }, 10000);

    ws.on('open', () => {
      clearTimeout(timeout);
      console.log(`✅ Connected to ${address}`);
      ws.close();
      resolve({
        address,
        success: true,
        error: null
      });
    });

    ws.on('error', (error) => {
      clearTimeout(timeout);
      console.log(`❌ Failed to connect to ${address}: ${error.message}`);
      resolve({
        address,
        success: false,
        error: error.message
      });
    });

    ws.on('close', (code, reason) => {
      clearTimeout(timeout);
      if (code !== 1000) {
        console.log(`⚠️ Connection to ${address} closed with code ${code}: ${reason}`);
      }
    });
  });
}

async function main() {
  console.log('🧪 Testing Docker Bridge Connectivity');
  console.log('=====================================');
  
  const results = [];
  
  for (const address of bridgeAddresses) {
    const result = await testBridgeConnection(address);
    results.push(result);
    
    // Wait between tests
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  console.log('\n📊 Test Results:');
  console.log('================');
  
  let successCount = 0;
  for (const result of results) {
    if (result.success) {
      console.log(`✅ ${result.address}: SUCCESS`);
      successCount++;
    } else {
      console.log(`❌ ${result.address}: FAILED - ${result.error}`);
    }
  }
  
  console.log(`\n🎯 Summary: ${successCount}/${results.length} connections successful`);
  
  if (successCount === 0) {
    console.log('\n🔧 Possible Issues:');
    console.log('- Docker network aliases not working');
    console.log('- Nginx not accepting connections from Docker network');
    console.log('- SSL certificate issues for internal connections');
    console.log('- Bridge nodes not running or not accessible');
    process.exit(1);
  } else if (successCount < results.length) {
    console.log('\n⚠️ Partial connectivity - some bridge nodes unreachable');
    process.exit(1);
  } else {
    console.log('\n🎉 All bridge connections working!');
    process.exit(0);
  }
}

main().catch(error => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});