/**
 * Test the metadata fix for Node.js DHT clients
 */

import { NodeDHTClient } from '../../src/node/NodeDHTClient.js';

async function testMetadataFix() {
  console.log('🧪 Testing Node.js metadata fix');
  console.log('===============================');

  let client1, client2;

  try {
    // Start first client
    console.log('\n📝 Step 1: Start first Node.js client');
    client1 = new NodeDHTClient({ port: 65300 });
    const info1 = await client1.start();
    console.log(`✅ Client 1 started: ${info1.nodeId.substring(0, 16)}...`);
    
    // Wait a moment for it to register with bootstrap
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Start second client  
    console.log('\n📝 Step 2: Start second Node.js client');
    client2 = new NodeDHTClient({ port: 65301 });
    const info2 = await client2.start();
    console.log(`✅ Client 2 started: ${info2.nodeId.substring(0, 16)}...`);

    // Wait for peer discovery and metadata storage
    await new Promise(resolve => setTimeout(resolve, 3000));

    console.log('\n📝 Step 3: Check metadata storage');
    
    // Check if client2 has client1's metadata stored
    if (client2.websocketManager && client2.websocketManager.peerMetadata) {
      console.log('Client 2 stored metadata:');
      for (const [peerId, metadata] of client2.websocketManager.peerMetadata.entries()) {
        console.log(`  ${peerId.substring(0, 8)}...: nodeType=${metadata.nodeType}, address=${metadata.listeningAddress}`);
        
        if (metadata.nodeType === 'nodejs') {
          console.log(`  ✅ Found correct Node.js metadata!`);
        }
      }
    }
    
    // Check routing table for proper node types
    if (client2.dht && client2.dht.routingTable) {
      const nodes = client2.dht.routingTable.getAllNodes();
      console.log(`\nClient 2 routing table: ${nodes.length} nodes`);
      
      for (const node of nodes) {
        const nodeType = node.getMetadata('nodeType');
        const address = node.getMetadata('listeningAddress');
        console.log(`  ${node.id.toString().substring(0, 8)}...: type=${nodeType}, address=${address}`);
        
        if (nodeType === 'nodejs') {
          console.log(`  ✅ DHTNode has correct nodejs type!`);
        } else {
          console.log(`  ❌ DHTNode has incorrect type: ${nodeType}`);
        }
      }
    }

    // Test connection attempt with correct transport selection
    console.log('\n📝 Step 4: Test transport selection');
    
    // Trigger peer discovery to see if it now selects WebSocket
    if (client2.dht) {
      console.log('Triggering peer discovery...');
      try {
        await client2.dht.discoverPeersViaDHT();
      } catch (error) {
        console.log('Peer discovery attempt completed');
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
testMetadataFix().catch(console.error);