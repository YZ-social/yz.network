/**
 * Debug metadata storage during bootstrap peer discovery
 */

import { NodeDHTClient } from '../../src/node/NodeDHTClient.js';

async function debugMetadataStorage() {
  console.log('🔍 Debugging metadata storage during bootstrap discovery');
  console.log('==================================================');

  let client1, client2;

  try {
    // Start first client (genesis)
    console.log('\n📝 Step 1: Start first Node.js client');
    client1 = new NodeDHTClient({ port: 65200 });
    const info1 = await client1.start();
    console.log(`✅ Client 1 started: ${info1.nodeId.substring(0, 16)}...`);
    console.log(`   Listening: ${info1.listeningAddress}`);

    // Wait a moment, then start second client 
    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log('\n📝 Step 2: Start second Node.js client');
    client2 = new NodeDHTClient({ port: 65201 });
    const info2 = await client2.start();
    console.log(`✅ Client 2 started: ${info2.nodeId.substring(0, 16)}...`);
    console.log(`   Listening: ${info2.listeningAddress}`);

    // Wait for discovery and check if metadata was stored
    await new Promise(resolve => setTimeout(resolve, 3000));

    console.log('\n📝 Step 3: Check if metadata was stored in ConnectionManager');

    // Check client1's knowledge of client2
    if (client1.connectionManager && client1.connectionManager.peerMetadata) {
      console.log('Client 1 peer metadata storage:');
      for (const [peerId, metadata] of client1.connectionManager.peerMetadata.entries()) {
        console.log(`  ${peerId.substring(0, 8)}...: ${JSON.stringify(metadata)}`);
      }
    } else {
      console.log('❌ Client 1 has no peerMetadata map in ConnectionManager');
    }

    // Check client2's knowledge of client1
    if (client2.connectionManager && client2.connectionManager.peerMetadata) {
      console.log('Client 2 peer metadata storage:');
      for (const [peerId, metadata] of client2.connectionManager.peerMetadata.entries()) {
        console.log(`  ${peerId.substring(0, 8)}...: ${JSON.stringify(metadata)}`);
      }
    } else {
      console.log('❌ Client 2 has no peerMetadata map in ConnectionManager');
    }

    // Check DHT nodes in routing table
    console.log('\n📝 Step 4: Check DHTNode metadata in routing tables');
    
    if (client1.dht && client1.dht.routingTable) {
      const nodes1 = client1.dht.routingTable.getAllNodes();
      console.log(`Client 1 routing table: ${nodes1.length} nodes`);
      for (const node of nodes1) {
        const nodeType = node.getMetadata('nodeType');
        const listeningAddress = node.getMetadata('listeningAddress');
        console.log(`  ${node.id.toString().substring(0, 8)}...: type=${nodeType}, address=${listeningAddress}`);
      }
    }

    if (client2.dht && client2.dht.routingTable) {
      const nodes2 = client2.dht.routingTable.getAllNodes();
      console.log(`Client 2 routing table: ${nodes2.length} nodes`);
      for (const node of nodes2) {
        const nodeType = node.getMetadata('nodeType');
        const listeningAddress = node.getMetadata('listeningAddress');
        console.log(`  ${node.id.toString().substring(0, 8)}...: type=${nodeType}, address=${listeningAddress}`);
      }
    }

    // Manually request peers from bootstrap to see raw response
    console.log('\n📝 Step 5: Check bootstrap server response directly');
    
    if (client2.dht && client2.dht.bootstrap && client2.dht.bootstrap.isBootstrapConnected()) {
      console.log('Requesting peers directly from bootstrap...');
      const directPeers = await client2.dht.bootstrap.requestPeers(10);
      console.log(`Bootstrap returned ${directPeers.length} peers:`);
      
      for (const peer of directPeers) {
        console.log(`  Peer ${peer.nodeId.substring(0, 8)}...: metadata = ${JSON.stringify(peer.metadata)}`);
        
        // Check if this peer has the nodejs metadata we expect
        if (peer.metadata && peer.metadata.nodeType === 'nodejs') {
          console.log(`    ✅ Correct Node.js metadata found!`);
        } else {
          console.log(`    ❌ Missing or incorrect metadata`);
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
debugMetadataStorage().catch(console.error);