/**
 * Debug Genesis Token Creation Test
 * 
 * Simple test to isolate and debug the Genesis peer membership token issue
 */

import { NodeDHTClient } from '../../src/node/NodeDHTClient.js';

async function debugGenesisToken() {
  console.log('🔍 Debug Genesis Token Creation');
  console.log('=============================\n');

  let client = null;

  try {
    // Create Genesis client
    console.log('📝 Step 1: Create Node.js DHT client');
    client = new NodeDHTClient({
      bootstrapServers: ['ws://localhost:8080'],
      port: 0
    });

    console.log('📝 Step 2: Start client and check for Genesis status');
    const startInfo = await client.start();
    console.log(`✅ Client started: ${startInfo.nodeId.substring(0, 16)}...`);

    // Wait a moment for bootstrap connection to complete
    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log('📝 Step 3: Check Genesis peer status');
    const stats = client.getStats();
    console.log('Client stats:', {
      nodeId: stats.nodeId.substring(0, 16) + '...',
      isGenesisPeer: client.dht.isGenesisPeer,
      hasMembershipToken: !!client.dht.membershipToken,
      hasKeyPair: !!client.dht.keyPair,
      dhtStarted: client.dht.isStarted,
      bootstrapped: client.dht.isBootstrapped
    });

    if (client.dht.isGenesisPeer) {
      console.log('✅ Genesis status confirmed');
      if (client.dht.membershipToken) {
        console.log('✅ Genesis membership token created');
        console.log('🔍 Token details:', {
          nodeId: client.dht.membershipToken.nodeId?.substring(0, 16) + '...',
          isGenesis: client.dht.membershipToken.isGenesis,
          hasSignature: !!client.dht.membershipToken.signature
        });
      } else {
        console.log('❌ No membership token found');
      }
    } else {
      console.log('❌ Client is not Genesis peer');
    }

    console.log('\n📝 Step 4: Test invitation token creation');
    try {
      const testTargetId = 'test-target-node-id-12345';
      const invitationToken = await client.dht.createInvitationToken(testTargetId);
      console.log('✅ Invitation token created successfully');
      console.log('🔍 Token details:', {
        inviter: invitationToken.inviter.substring(0, 16) + '...',
        invitee: invitationToken.invitee.substring(0, 16) + '...',
        hasSignature: !!invitationToken.signature,
        expires: new Date(invitationToken.expires).toISOString()
      });
    } catch (error) {
      console.log('❌ Failed to create invitation token:', error.message);
    }

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Stack:', error.stack);
  } finally {
    if (client) {
      console.log('\n🧹 Cleaning up...');
      await client.stop();
      console.log('✅ Client stopped');
    }
  }
}

// Run the debug test
debugGenesisToken().catch(error => {
  console.error('💥 Debug test crashed:', error);
  process.exit(1);
});