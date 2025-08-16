/**
 * Test proper DHT invitation flow:
 * 1. Stop bootstrap server, restart with genesis flag
 * 2. Create Client A (Node.js), start DHT -> becomes Genesis
 * 3. Create Client B (Node.js), start DHT -> connects to bootstrap only
 * 4. Client A invites Client B to join DHT via bootstrap server
 * 5. Bootstrap server coordinates immediate WebSocket connection
 * 6. Verify connection and metadata
 */

import { NodeDHTClient } from '../../src/node/NodeDHTClient.js';

async function testProperInvitationFlow() {
  console.log('🧪 Testing Proper DHT Invitation Flow with Bootstrap Coordination');
  console.log('===============================================================');

  let clientA, clientB;

  try {
    console.log('\n📝 Step 1: Assume bootstrap server is running with genesis flag');
    console.log('   (Bootstrap server should be started with: npm run bootstrap:genesis)');

    // Step 2: Create Client A and start DHT (becomes Genesis)
    console.log('\n📝 Step 2: Create Client A (Node.js) and start DHT');
    clientA = new NodeDHTClient({ port: 9600 });
    const infoA = await clientA.start();
    console.log(`✅ Client A started: ${infoA.nodeId.substring(0, 16)}...`);
    console.log(`   Listening: ${infoA.listeningAddress}`);

    // Wait for Genesis assignment
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const isGenesisA = clientA.dht?.isGenesisPeer;
    const hasMembershipA = !!clientA.dht?.membershipToken;
    console.log(`   Genesis status: ${isGenesisA}`);
    console.log(`   Has membership token: ${hasMembershipA}`);

    if (!isGenesisA) {
      throw new Error('❌ Client A did not become Genesis peer');
    }

    console.log('✅ Client A is now the Genesis peer');

    // Step 3: Create Client B and start DHT (connects to bootstrap only)
    console.log('\n📝 Step 3: Create Client B (Node.js) and start DHT');
    clientB = new NodeDHTClient({ port: 9601 });
    const infoB = await clientB.start();
    console.log(`✅ Client B started: ${infoB.nodeId.substring(0, 16)}...`);
    console.log(`   Listening: ${infoB.listeningAddress}`);

    // Wait for bootstrap connection
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const isGenesisB = clientB.dht?.isGenesisPeer;
    const hasMembershipB = !!clientB.dht?.membershipToken;
    console.log(`   Genesis status: ${isGenesisB} (should be false)`);
    console.log(`   Has membership token: ${hasMembershipB} (should be false)`);
    console.log(`   Bootstrap connected: ${clientB.dht?.bootstrap?.isBootstrapConnected()}`);

    if (isGenesisB) {
      throw new Error('❌ Client B should not be Genesis peer');
    }

    console.log('✅ Client B is connected to bootstrap server only');

    // Step 4: Client A invites Client B - bootstrap should coordinate connection
    console.log('\n📝 Step 4: Client A (Genesis) invites Client B');
    console.log('   Bootstrap server should coordinate the WebSocket connection immediately');
    console.log(`   Client A inviting: ${infoB.nodeId}`);
    
    const invitationResult = await clientA.inviteNewClient(infoB.nodeId);
    console.log(`   Invitation result: ${invitationResult}`);

    if (!invitationResult) {
      throw new Error('❌ Invitation failed');
    }

    console.log('✅ Invitation sent - bootstrap should coordinate connection');

    // Step 5: Wait for bootstrap-coordinated connection
    console.log('\n📝 Step 5: Wait for bootstrap-coordinated connection');
    console.log('   Connection should be established immediately by bootstrap server');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Step 6: Verify immediate connection (not through k-bucket discovery)
    console.log('\n📝 Step 6: Verify bootstrap-coordinated connection');

    const connectionsA = clientA.getConnectedPeers();
    const connectionsB = clientB.getConnectedPeers();
    
    console.log(`Client A connected peers: ${connectionsA.length}`);
    for (const peerId of connectionsA) {
      console.log(`  - ${peerId.substring(0, 8)}...`);
    }
    
    console.log(`Client B connected peers: ${connectionsB.length}`);
    for (const peerId of connectionsB) {
      console.log(`  - ${peerId.substring(0, 8)}...`);
    }

    // Check if they're connected to each other
    const aConnectedToB = connectionsA.includes(infoB.nodeId);
    const bConnectedToA = connectionsB.includes(infoA.nodeId);
    
    console.log(`Client A connected to B: ${aConnectedToB}`);
    console.log(`Client B connected to A: ${bConnectedToA}`);

    if (aConnectedToB && bConnectedToA) {
      console.log('🎉 Bootstrap-coordinated connection successful!');
    } else {
      console.log('❌ Bootstrap coordination failed - no direct connection');
    }

    // Step 7: Test DHT functionality immediately
    console.log('\n📝 Step 7: Test immediate DHT functionality');
    
    if (aConnectedToB && bConnectedToA) {
      try {
        console.log('Testing store from Client B...');
        await clientB.store('bootstrap-coordinated-key', 'bootstrap-coordinated-value');
        console.log('✅ Client B stored data');
        
        console.log('Testing retrieve from Client A...');
        const retrievedValue = await clientA.get('bootstrap-coordinated-key');
        console.log(`Client A retrieved: "${retrievedValue}"`);
        
        if (retrievedValue === 'bootstrap-coordinated-value') {
          console.log('🎉 DHT communication working via bootstrap-coordinated WebSocket!');
        } else {
          console.log('❌ DHT communication failed - wrong value');
        }
      } catch (error) {
        console.log('❌ DHT operation failed:', error.message);
      }
    } else {
      console.log('⚠️ Skipping DHT test - bootstrap coordination failed');
    }

    // Summary
    console.log('\n📝 Summary:');
    console.log(`Genesis assignment: ${isGenesisA ? '✅' : '❌'}`);
    console.log(`Invitation sent: ${invitationResult ? '✅' : '❌'}`);
    console.log(`Bootstrap coordination: ${aConnectedToB && bConnectedToA ? '✅' : '❌'}`);
    
    if (aConnectedToB && bConnectedToA) {
      console.log('🎉 SUCCESS: Bootstrap server properly coordinated WebSocket connection!');
    } else {
      console.log('❌ FAILED: Bootstrap server did not coordinate connection properly');
    }

  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    // Cleanup
    console.log('\n🧹 Cleaning up...');
    if (clientA) {
      console.log('Stopping Client A...');
      await clientA.stop();
    }
    if (clientB) {
      console.log('Stopping Client B...');
      await clientB.stop();
    }
    console.log('✅ Cleanup complete');
  }
}

// Run the test
console.log('🚀 Starting bootstrap coordination test...');
console.log('📋 Prerequisites: Bootstrap server must be running with genesis flag');
console.log('   Run: npm run bootstrap:genesis');
console.log('');

testProperInvitationFlow().catch(console.error);