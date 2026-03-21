#!/usr/bin/env node
/**
 * Debug script to investigate connection count discrepancy
 * Run inside a DHT node container to see actual peer list
 */

import http from 'http';

const METRICS_PORT = process.env.METRICS_PORT || 9090;

async function fetchStatus() {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${METRICS_PORT}/status`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('=== Connection Count Debug ===\n');
  
  try {
    const status = await fetchStatus();
    
    console.log(`Node ID: ${status.nodeId}`);
    console.log(`Connected Peers (reported): ${status.dht.connectedPeers}`);
    console.log(`Routing Table Size: ${status.dht.routingTableSize}`);
    console.log(`Peak Connections: ${status.connectionStability.peakConnections}`);
    console.log(`Connections Established: ${status.connectionStability.connectionsEstablished}`);
    console.log(`Connections Lost: ${status.connectionStability.connectionsLost}`);
    console.log(`Net Connections: ${status.connectionStability.netConnections}`);
    
    console.log('\n=== Analysis ===');
    
    // Expected: 17 peers (18 nodes - self)
    const expected = 17;
    const reported = status.dht.connectedPeers;
    const discrepancy = reported - expected;
    
    console.log(`Expected peers: ${expected}`);
    console.log(`Reported peers: ${reported}`);
    console.log(`Discrepancy: ${discrepancy > 0 ? '+' : ''}${discrepancy}`);
    
    if (discrepancy > 0) {
      console.log('\n⚠️ Connection count is INFLATED');
      console.log('Possible causes:');
      console.log('  1. Duplicate entries in routing table');
      console.log('  2. Stale connections being counted');
      console.log('  3. peerNodes Map has entries not in routing table');
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

main();
