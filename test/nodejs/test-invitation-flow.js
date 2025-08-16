/**
 * Test proper invitation flow between Node.js clients
 */

import { NodeDHTClient } from '../../src/node/NodeDHTClient.js';

async function testInvitationFlow() {
  console.log('🧪 Testing Node.js invitation flow with metadata');
  console.log('=============================================');

  let genesisClient, inviteeClient;

  try {
    // Step 1: Start genesis client
    console.log('\n📝 Step 1: Start genesis Node.js client');
    genesisClient = new NodeDHTClient({ port: 65500 });
    const genesisInfo = await genesisClient.start();
    console.log(`✅ Genesis client started: ${genesisInfo.nodeId.substring(0, 16)}...`);
    console.log(`   Listening: ${genesisInfo.listeningAddress}`);

    // Wait for genesis assignment
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const genesisStatus = genesisClient.dht?.isGenesisPeer;
    console.log(`   Genesis status: ${genesisStatus}`);
    console.log(`   Has membership token: ${!!genesisClient.dht?.membershipToken}`);

    if (!genesisStatus) {
      throw new Error('Genesis client did not receive genesis status');
    }

    // Step 2: Start invitee client
    console.log('\n📝 Step 2: Start invitee Node.js client');
    inviteeClient = new NodeDHTClient({ port: 65501 });
    const inviteeInfo = await inviteeClient.start();
    console.log(`✅ Invitee client started: ${inviteeInfo.nodeId.substring(0, 16)}...`);
    console.log(`   Listening: ${inviteeInfo.listeningAddress}`);

    // Step 3: Genesis client invites the second client
    console.log('\n📝 Step 3: Genesis client invites second client');
    console.log(`Inviting ${inviteeInfo.nodeId} to join DHT...`);
    
    const invitationResult = await genesisClient.inviteNewClient(inviteeInfo.nodeId);
    console.log(`Invitation result:`, invitationResult);

    // Step 4: Wait for invitation processing and connection
    console.log('\n📝 Step 4: Wait for invitation processing');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Step 5: Check if connection was established
    console.log('\n📝 Step 5: Check DHT connections');
    
    const genesisConnectedPeers = genesisClient.getConnectedPeers();
    const inviteeConnectedPeers = inviteeClient.getConnectedPeers();
    
    console.log(`Genesis client connected peers: ${genesisConnectedPeers.length}`);
    console.log(`Invitee client connected peers: ${inviteeConnectedPeers.length}`);

    if (genesisConnectedPeers.length > 0) {
      console.log('✅ Genesis client has connections!');
    }
    
    if (inviteeConnectedPeers.length > 0) {
      console.log('✅ Invitee client has connections!');
    }

    // Step 6: Check metadata storage and node types
    console.log('\n📝 Step 6: Check metadata and node types');
    
    // Check if genesis client stored invitee metadata
    if (genesisClient.websocketManager?.peerMetadata) {
      console.log('Genesis client stored metadata:');
      for (const [peerId, metadata] of genesisClient.websocketManager.peerMetadata.entries()) {
        console.log(`  ${peerId.substring(0, 8)}...: nodeType=${metadata.nodeType}, address=${metadata.listeningAddress}`);
      }
    }

    // Check DHTNode objects in routing tables
    if (genesisClient.dht?.routingTable) {
      const genesisNodes = genesisClient.dht.routingTable.getAllNodes();
      console.log(`Genesis routing table: ${genesisNodes.length} nodes`);
      
      for (const node of genesisNodes) {
        const nodeType = node.getMetadata('nodeType');
        const address = node.getMetadata('listeningAddress');
        console.log(`  ${node.id.toString().substring(0, 8)}...: type=${nodeType}, address=${address}`);
        
        if (nodeType === 'nodejs') {
          console.log(`  ✅ Correct nodejs type found!`);
        } else {
          console.log(`  ❌ Wrong type: ${nodeType} (should be nodejs)`);
        }
      }
    }

    // Step 7: Test if they can communicate via WebSocket
    console.log('\n📝 Step 7: Test DHT communication');
    
    if (genesisConnectedPeers.length > 0 && inviteeConnectedPeers.length > 0) {
      try {
        // Try storing data from invitee
        await inviteeClient.store('test-key', 'test-value');
        console.log('✅ Invitee stored data in DHT');
        
        // Try retrieving from genesis
        const retrievedValue = await genesisClient.get('test-key');
        console.log(`Genesis retrieved: ${retrievedValue}`);
        
        if (retrievedValue === 'test-value') {
          console.log('✅ DHT communication working!');
        } else {
          console.log('❌ DHT communication failed');
        }
      } catch (error) {
        console.log('❌ DHT operation failed:', error.message);
      }
    }

  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    // Cleanup
    console.log('\n🧹 Cleaning up...');
    if (genesisClient) await genesisClient.stop();
    if (inviteeClient) await inviteeClient.stop();
  }
}

// Run the test
testInvitationFlow().catch(console.error);