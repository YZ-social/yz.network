#!/usr/bin/env node

/**
 * Check Bootstrap Server Connected Clients
 * 
 * Connects to bootstrap server and requests stats to see
 * what clients are actually connected.
 */

import https from 'https';

const BOOTSTRAP_HOST = 'imeyouwe.com';

async function fetchStats() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BOOTSTRAP_HOST,
      port: 443,
      path: '/stats',
      method: 'GET',
      rejectUnauthorized: false
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    });
    
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  console.log('📊 CHECKING BOOTSTRAP SERVER STATE');
  console.log('===================================\n');
  
  try {
    const stats = await fetchStats();
    console.log('📈 Bootstrap Server Stats:');
    console.log(JSON.stringify(stats, null, 2));
    
    if (stats.connectedClients !== undefined) {
      console.log(`\n📋 Connected Clients: ${stats.connectedClients}`);
    }
    
    if (stats.peers !== undefined) {
      console.log(`📋 Peers: ${stats.peers}`);
    }
    
    if (stats.bridgeNodes !== undefined) {
      console.log(`🌉 Bridge Nodes: ${stats.bridgeNodes}`);
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

main();
