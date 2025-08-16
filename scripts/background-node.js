/**
 * Background Node.js DHT client for testing with browsers
 * Usage: node scripts/background-node.js [port] [genesis]
 */

import { NodeDHTClient } from '../src/node/NodeDHTClient.js';

import { createServer } from 'net';

// Parse command line arguments
const args = process.argv.slice(2);
const requestedPort = parseInt(args[0]) || 9500;

let client;

/**
 * Find next available port starting from the requested port
 */
async function findAvailablePort(startPort) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    
    server.listen(startPort, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        // Try next port
        findAvailablePort(startPort + 1).then(resolve).catch(reject);
      } else {
        reject(err);
      }
    });
  });
}

async function startBackgroundNode() {
  console.log('🌐 Starting background Node.js DHT client...');
  console.log(`   Requested port: ${requestedPort}`);
  
  try {
    // Find available port
    const availablePort = await findAvailablePort(requestedPort);
    if (availablePort !== requestedPort) {
      console.log(`   ⚠️ Port ${requestedPort} busy, using port ${availablePort}`);
    }
    
    console.log('   Note: Genesis status is only assigned by bootstrap server');
    
    client = new NodeDHTClient({ port: availablePort });
    const info = await client.start();
    
    console.log('\n✅ Background Node.js client started successfully!');
    console.log(`   Listening: ${info.listeningAddress}`);
    console.log(`   Node Type: ${info.nodeType}`);
    
    // Check if bootstrap server assigned genesis status
    await new Promise(resolve => setTimeout(resolve, 2000));
    const isGenesisPeer = client.dht?.isGenesisPeer;
    const hasMembership = !!client.dht?.membershipToken;
    
    console.log(`\n🌟 Genesis Status: ${isGenesisPeer} (assigned by bootstrap server)`);
    console.log(`   Has membership token: ${hasMembership}`);
    
    // Display Node ID prominently for browser invitations
    console.log('\n' + '='.repeat(60));
    console.log('📋 NODE ID FOR BROWSER INVITATIONS:');
    console.log(`    ${info.nodeId}`);
    console.log('='.repeat(60));
    
    if (isGenesisPeer) {
      console.log('\n💡 This node was assigned Genesis status by the bootstrap server');
      console.log('   Use client.inviteNewClient(nodeId) to invite peers');
      console.log('   Or use YZSocialC.inviteNewClient("nodeId") from browser console');
    } else {
      console.log('\n💡 This node is connected to bootstrap server');
      console.log('   Waiting for invitation from Genesis or DHT members');
      console.log('   To invite from browser: YZSocialC.inviteNewClient("' + info.nodeId + '")');
    }
    
    // Show connection stats periodically
    setInterval(() => {
      const stats = client.getStats();
      const connections = client.getConnectedPeers();
      
      console.log(`\n📊 Stats: ${connections.length} connections, DHT size: ${stats.dht?.routingTableSize || 0}`);
      if (connections.length > 0) {
        console.log(`   Connected to: ${connections.map(id => id.substring(0, 8) + '...').join(', ')}`);
      }
    }, 30000); // Every 30 seconds
    
    console.log('\n🔄 Background client running... Press Ctrl+C to stop');
    
  } catch (error) {
    console.error('❌ Failed to start background client:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down background client...');
  if (client) {
    await client.stop();
  }
  console.log('✅ Background client stopped');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Received SIGTERM, shutting down...');
  if (client) {
    await client.stop();
  }
  process.exit(0);
});

// Export client for programmatic access
global.backgroundClient = client;

// Start the client
startBackgroundNode().catch(error => {
  console.error('❌ Background client failed:', error);
  process.exit(1);
});