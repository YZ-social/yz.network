/**
 * Test metadata flow between two Node.js DHT clients
 */

import { NodeDHTClient } from '../../src/node/NodeDHTClient.js';

async function testMetadataFlow() {
  console.log('🧪 Testing metadata flow between Node.js peers');
  console.log('==============================================');

  let client1, client2;

  try {
    // Start first client (genesis)
    console.log('\n📝 Step 1: Start first Node.js client (genesis)');
    client1 = new NodeDHTClient({ port: 65100 });
    const info1 = await client1.start();
    console.log(`✅ Client 1 started: ${info1.nodeId.substring(0, 16)}...`);
    console.log(`   Listening: ${info1.listeningAddress}`);

    // Check if client1 got genesis status
    await new Promise(resolve => setTimeout(resolve, 2000));
    const stats1 = client1.getStats();
    console.log(`   Genesis status: ${client1.dht?.isGenesisPeer || false}`);
    console.log(`   Has membership token: ${!!client1.dht?.membershipToken}`);

    if (!client1.dht?.isGenesisPeer) {
      console.log('❌ Client 1 is not genesis - this is expected with fresh bootstrap');
    }

    // Start second client 
    console.log('\n📝 Step 2: Start second Node.js client');
    client2 = new NodeDHTClient({ port: 65101 });
    const info2 = await client2.start();
    console.log(`✅ Client 2 started: ${info2.nodeId.substring(0, 16)}...`);
    console.log(`   Listening: ${info2.listeningAddress}`);

    // Wait for discovery
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Check peer discovery
    console.log('\n📝 Step 3: Check peer discovery and metadata');
    const peers1 = client1.getConnectedPeers();
    const peers2 = client2.getConnectedPeers();
    
    console.log(`Client 1 connected peers: ${peers1.length}`);
    console.log(`Client 2 connected peers: ${peers2.length}`);

    // Check if they discovered each other via bootstrap
    if (peers1.length === 0 && peers2.length === 0) {
      console.log('\n📍 No direct connections - checking routing table for discovered peers');
      
      if (client1.dht?.routingTable) {
        const allNodes1 = client1.dht.routingTable.getAllNodes();
        console.log(`Client 1 routing table: ${allNodes1.length} nodes`);
        
        for (const node of allNodes1) {
          const nodeType = node.getMetadata('nodeType');
          const listeningAddress = node.getMetadata('listeningAddress');
          console.log(`  Node ${node.id.toString().substring(0, 8)}...: type=${nodeType}, address=${listeningAddress}`);
        }
      }

      if (client2.dht?.routingTable) {
        const allNodes2 = client2.dht.routingTable.getAllNodes();
        console.log(`Client 2 routing table: ${allNodes2.length} nodes`);
        
        for (const node of allNodes2) {
          const nodeType = node.getMetadata('nodeType');
          const listeningAddress = node.getMetadata('listeningAddress');
          console.log(`  Node ${node.id.toString().substring(0, 8)}...: type=${nodeType}, address=${listeningAddress}`);
        }
      }
    }

    // Test if they can find each other via bootstrap peer discovery
    console.log('\n📝 Step 4: Test bootstrap peer discovery');
    
    if (client1.dht?.bootstrap?.isBootstrapConnected()) {
      console.log('Client 1 requesting peers from bootstrap...');
      const bootstrapPeers1 = await client1.dht.bootstrap.requestPeers(10);
      console.log(`Client 1 got ${bootstrapPeers1.length} peers from bootstrap:`);
      
      for (const peer of bootstrapPeers1) {
        console.log(`  Peer ${peer.nodeId.substring(0, 8)}...: ${JSON.stringify(peer.metadata)}`);
        
        // Check if this peer has proper metadata
        if (peer.metadata.nodeType === 'nodejs') {
          console.log(`✅ Found Node.js peer with proper metadata!`);
        } else {
          console.log(`⚠️ Peer has incorrect metadata: ${peer.metadata.nodeType}`);
        }
      }
    }

  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    // Cleanup
    console.log('\n🧹 Cleaning up...');
    if (client1) await client1.stop();
    if (client2) await client2.stop();
  }
}

// Run the test
testMetadataFlow().catch(console.error);