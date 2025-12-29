#!/usr/bin/env node

/**
 * Check Real Bridge Nodes
 * 
 * This script checks if the actual bridge nodes on the Oracle server
 * are connected to the bootstrap server by checking the bridge health endpoints.
 */

import https from 'https';

const BRIDGE_ENDPOINTS = [
  'https://imeyouwe.com/bridge1/health',
  'https://imeyouwe.com/bridge2/health',
];

async function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { rejectUnauthorized: false }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve({ status: 0, error: 'Timeout' });
    });
  });
}

async function main() {
  console.log('🔍 CHECKING REAL BRIDGE NODES');
  console.log('=============================\n');
  
  // Check bridge health endpoints
  console.log('📡 Checking bridge node health endpoints...\n');
  
  for (const endpoint of BRIDGE_ENDPOINTS) {
    console.log(`Checking: ${endpoint}`);
    const result = await fetchUrl(endpoint);
    
    if (result.status === 200) {
      console.log(`   ✅ Status: ${result.status}`);
      try {
        const data = JSON.parse(result.data);
        console.log(`   📊 Data:`, JSON.stringify(data, null, 2).split('\n').map(l => '      ' + l).join('\n'));
      } catch (e) {
        console.log(`   📊 Data: ${result.data.substring(0, 200)}...`);
      }
    } else {
      console.log(`   ❌ Status: ${result.status || 'Error'}`);
      console.log(`   Error: ${result.error || result.data?.substring(0, 100)}`);
    }
    console.log();
  }
  
  // Check bootstrap server bridge-health endpoint
  console.log('📡 Checking bootstrap server bridge-health endpoint...');
  const bridgeHealthResult = await fetchUrl('https://imeyouwe.com/bridge-health');
  
  if (bridgeHealthResult.status === 200) {
    console.log(`   ✅ Status: ${bridgeHealthResult.status}`);
    try {
      const data = JSON.parse(bridgeHealthResult.data);
      console.log(`   📊 Data:`, JSON.stringify(data, null, 2).split('\n').map(l => '      ' + l).join('\n'));
    } catch (e) {
      console.log(`   📊 Data: ${bridgeHealthResult.data.substring(0, 500)}...`);
    }
  } else {
    console.log(`   ❌ Status: ${bridgeHealthResult.status || 'Error'}`);
    console.log(`   Error: ${bridgeHealthResult.error || bridgeHealthResult.data?.substring(0, 100)}`);
  }
  
  console.log('\n✅ Check complete');
}

main().catch(console.error);
