#!/usr/bin/env node

/**
 * Test Bootstrap Server Coordination
 * 
 * Tests the full bootstrap coordination flow:
 * 1. Registration (without buildId to bypass version check)
 * 2. Peer discovery (get_peers_or_genesis)
 * 3. Peer introduction coordination
 * 
 * Requirements: 2.4, 2.5
 */

const WebSocket = (await import('ws')).default;
import { PROTOCOL_VERSION } from '../src/version.js';

console.log('🔍 TEST: Bootstrap Server Coordination');
console.log('======================================\n');

const BOOTSTRAP_URL = 'wss://imeyouwe.com/ws';

async function testBootstrapCoordination() {
  return new Promise((resolve) => {
    const testNodeId = 'coord_test_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
    let resolved = false;
    let registrationComplete = false;
    let peerRequestSent = false;
    
    console.log(`🔌 Connecting to: ${BOOTSTRAP_URL}`);
    console.log(`📋 Test Node ID: ${testNodeId.substring(0, 20)}...\n`);
    
    const ws = new WebSocket(BOOTSTRAP_URL, {
      rejectUnauthorized: false
    });

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ws.close();
        console.log('\n⏰ Test timeout after 30 seconds');
        resolve({ error: 'Timeout', registrationComplete, peerRequestSent });
      }
    }, 30000);

    ws.on('open', () => {
      console.log('✅ Connected to bootstrap server');
      
      // Step 1: Register WITHOUT buildId (to bypass version mismatch)
      console.log('\n📤 Step 1: Sending registration (without buildId)...');
      ws.send(JSON.stringify({
        type: 'register',
        nodeId: testNodeId,
        protocolVersion: PROTOCOL_VERSION,
        // No buildId - use fallback behavior
        timestamp: Date.now(),
        metadata: {
          nodeType: 'nodejs',
          testMode: true,
          listeningAddress: 'ws://test-node:9999',
          publicWssAddress: 'wss://test.example.com/node'
        }
      }));
    });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        console.log(`📥 Received: ${message.type}`);
        
        if (message.type === 'registered') {
          registrationComplete = true;
          console.log('   ✅ Registration successful!');
          console.log(`   Node ID confirmed: ${message.nodeId?.substring(0, 20)}...`);
          
          // Step 2: Request peers or genesis status
          console.log('\n📤 Step 2: Requesting peers/genesis...');
          peerRequestSent = true;
          ws.send(JSON.stringify({
            type: 'get_peers_or_genesis',
            nodeId: testNodeId,
            maxPeers: 20,
            requestId: 'test_req_' + Date.now(),
            metadata: {
              nodeType: 'nodejs',
              testMode: true
            }
          }));
        } else if (message.type === 'response') {
          console.log('   ✅ Got peer response!');
          console.log(`   Success: ${message.success}`);
          
          if (message.data) {
            console.log(`   Is Genesis: ${message.data.isGenesis || false}`);
            console.log(`   Peer Count: ${message.data.peers?.length || 0}`);
            console.log(`   Status: ${message.data.status || 'N/A'}`);
            console.log(`   Message: ${message.data.message || 'N/A'}`);
            
            if (message.data.peers && message.data.peers.length > 0) {
              console.log('\n   📋 Available Peers:');
              message.data.peers.forEach((peer, i) => {
                const nodeId = peer.nodeId?.substring(0, 16) || 'unknown';
                const nodeType = peer.metadata?.nodeType || 'unknown';
                const isBridge = peer.metadata?.isBridgeNode ? ' [BRIDGE]' : '';
                const address = peer.metadata?.listeningAddress || peer.metadata?.publicWssAddress || 'no address';
                console.log(`      ${i + 1}. ${nodeId}... (${nodeType}${isBridge})`);
                console.log(`         Address: ${address}`);
              });
            }
            
            if (message.data.membershipToken) {
              console.log('\n   🎫 Membership Token received!');
              console.log(`      Issuer: ${message.data.membershipToken.issuer?.substring(0, 16)}...`);
              console.log(`      Is Genesis: ${message.data.membershipToken.isGenesis || false}`);
            }
            
            if (message.data.onboardingHelper) {
              console.log('\n   🤝 Onboarding Helper assigned!');
              console.log(`      Helper ID: ${message.data.onboardingHelper.nodeId?.substring(0, 16)}...`);
            }
          }
          
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            ws.close();
            resolve({ 
              success: true, 
              registrationComplete,
              peerRequestSent,
              data: message.data
            });
          }
        } else if (message.type === 'version_mismatch') {
          console.log('   ❌ Version mismatch (should not happen without buildId)');
          console.log(`   Message: ${message.message}`);
          
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            ws.close();
            resolve({ versionMismatch: true });
          }
        } else if (message.type === 'error') {
          console.log(`   ❌ Server error: ${message.error || message.message}`);
          
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            ws.close();
            resolve({ error: message.error || message.message });
          }
        } else if (message.type === 'auth_challenge') {
          console.log('   🔐 Auth challenge received (skipping for test)');
          // Don't respond to auth challenge - just wait for peer response
        }
      } catch (error) {
        console.log(`⚠️ Parse error: ${error.message}`);
      }
    });

    ws.on('error', (error) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        console.log(`❌ WebSocket error: ${error.message}`);
        resolve({ error: error.message });
      }
    });

    ws.on('close', (code, reason) => {
      const reasonStr = reason ? reason.toString() : '';
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        console.log(`\n🔌 Connection closed: ${code} ${reasonStr}`);
        resolve({ closeCode: code, closeReason: reasonStr, registrationComplete, peerRequestSent });
      }
    });
  });
}

// Run the test
console.log('Starting bootstrap coordination test...\n');
const result = await testBootstrapCoordination();

console.log('\n' + '='.repeat(50));
console.log('TEST RESULTS');
console.log('='.repeat(50));

if (result.success) {
  console.log('\n✅ Bootstrap coordination is WORKING!');
  console.log(`   Registration: ${result.registrationComplete ? 'OK' : 'FAILED'}`);
  console.log(`   Peer Request: ${result.peerRequestSent ? 'OK' : 'FAILED'}`);
  
  if (result.data?.isGenesis) {
    console.log('\n   📌 This node would be designated as GENESIS');
    console.log('   (First non-bridge node to connect in createNewDHT mode)');
  }
  
  if (result.data?.peers?.length > 0) {
    console.log(`\n   📊 ${result.data.peers.length} peer(s) available for connection`);
    
    const bridgeNodes = result.data.peers.filter(p => p.metadata?.isBridgeNode);
    const dhtNodes = result.data.peers.filter(p => !p.metadata?.isBridgeNode);
    
    console.log(`      Bridge nodes: ${bridgeNodes.length}`);
    console.log(`      DHT nodes: ${dhtNodes.length}`);
  } else {
    console.log('\n   ⚠️ No peers available');
    console.log('   This could mean:');
    console.log('   1. Network is empty (genesis mode)');
    console.log('   2. Bridge nodes are not connected');
    console.log('   3. DHT network has no active peers');
  }
} else if (result.versionMismatch) {
  console.log('\n❌ Version mismatch occurred');
  console.log('   This should not happen when buildId is omitted');
} else if (result.error) {
  console.log(`\n❌ Test failed: ${result.error}`);
} else {
  console.log('\n❓ Unexpected result');
  console.log(`   Registration: ${result.registrationComplete ? 'OK' : 'FAILED'}`);
  console.log(`   Peer Request: ${result.peerRequestSent ? 'OK' : 'FAILED'}`);
  console.log(`   Close Code: ${result.closeCode}`);
  console.log(`   Close Reason: ${result.closeReason}`);
}

process.exit(result.success ? 0 : 1);
