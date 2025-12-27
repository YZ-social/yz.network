#!/usr/bin/env node

/**
 * Debug BUILD_ID Mismatch
 * 
 * This script specifically diagnoses the BUILD_ID mismatch issue
 * by connecting to the bootstrap server and extracting the exact
 * version information it expects.
 */

const WebSocket = (await import('ws')).default;
import { PROTOCOL_VERSION, BUILD_ID } from '../src/version.js';

console.log('🔍 DEBUG: BUILD_ID Mismatch Analysis');
console.log('====================================\n');

console.log(`📦 Local PROTOCOL_VERSION: ${PROTOCOL_VERSION}`);
console.log(`📦 Local BUILD_ID: ${BUILD_ID}\n`);

const BOOTSTRAP_URL = 'wss://imeyouwe.com/ws';

async function analyzeVersionMismatch() {
  return new Promise((resolve) => {
    const testNodeId = 'build_id_test_' + Date.now();
    let resolved = false;
    
    console.log(`🔌 Connecting to bootstrap server: ${BOOTSTRAP_URL}`);
    
    const ws = new WebSocket(BOOTSTRAP_URL, {
      rejectUnauthorized: false
    });

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ws.close();
        console.log('⏰ Connection timeout');
        resolve({ error: 'Timeout' });
      }
    }, 15000);

    ws.on('open', () => {
      console.log('✅ Connected to bootstrap server\n');
      
      // Send registration with our local BUILD_ID
      console.log('📤 Sending registration with:');
      console.log(`   protocolVersion: ${PROTOCOL_VERSION}`);
      console.log(`   buildId: ${BUILD_ID}\n`);
      
      ws.send(JSON.stringify({
        type: 'register',
        nodeId: testNodeId,
        protocolVersion: PROTOCOL_VERSION,
        buildId: BUILD_ID,
        timestamp: Date.now(),
        metadata: {
          nodeType: 'debug',
          testMode: true
        }
      }));
    });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        console.log(`📥 Received message type: ${message.type}`);
        
        if (message.type === 'version_mismatch') {
          console.log('\n❌ VERSION MISMATCH DETECTED!');
          console.log('================================');
          console.log(`   Client Protocol Version: ${message.clientVersion}`);
          console.log(`   Server Protocol Version: ${message.serverVersion}`);
          console.log(`   Client Build ID: ${message.clientBuildId || BUILD_ID}`);
          console.log(`   Server Build ID: ${message.serverBuildId || 'NOT PROVIDED'}`);
          console.log(`   Message: ${message.message}`);
          
          console.log('\n🔍 ROOT CAUSE ANALYSIS:');
          
          if (message.clientVersion === message.serverVersion) {
            console.log('   ✅ Protocol versions MATCH (both 1.0.0)');
            console.log('   ❌ BUILD_ID mismatch is the issue!');
            console.log('\n   The server was deployed with a different bundle hash than');
            console.log('   what you have locally. This happens when:');
            console.log('   1. Server was deployed from a different commit');
            console.log('   2. Server bundle was built at a different time');
            console.log('   3. Server hasn\'t been redeployed after local changes');
          } else {
            console.log('   ❌ Protocol versions DO NOT match');
            console.log(`   Client: ${message.clientVersion}, Server: ${message.serverVersion}`);
          }
          
          console.log('\n🔧 RECOMMENDED FIXES:');
          console.log('   1. Rebuild the server with: npm run build');
          console.log('   2. Redeploy the Docker containers');
          console.log('   3. Verify the deployed bundle-hash.json matches local');
          console.log('   4. Check if server is reading bundle-hash.json correctly');
          
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            ws.close();
            resolve({ 
              versionMismatch: true,
              clientVersion: message.clientVersion,
              serverVersion: message.serverVersion,
              clientBuildId: BUILD_ID,
              serverBuildId: message.serverBuildId
            });
          }
        } else if (message.type === 'registered') {
          console.log('\n✅ REGISTRATION SUCCESSFUL!');
          console.log('   No version mismatch - BUILD_ID matches server');
          
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            ws.close();
            resolve({ success: true });
          }
        } else if (message.type === 'error') {
          console.log(`\n❌ Server error: ${message.error || message.message}`);
          
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            ws.close();
            resolve({ error: message.error || message.message });
          }
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
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        console.log(`🔌 Connection closed: ${code} ${reason}`);
        resolve({ closeCode: code });
      }
    });
  });
}

// Also test what happens when we send NO buildId (fallback behavior)
async function testFallbackBehavior() {
  console.log('\n' + '='.repeat(50));
  console.log('TEST 2: Fallback Behavior (no buildId)');
  console.log('='.repeat(50) + '\n');
  
  return new Promise((resolve) => {
    const testNodeId = 'fallback_test_' + Date.now();
    let resolved = false;
    
    const ws = new WebSocket(BOOTSTRAP_URL, {
      rejectUnauthorized: false
    });

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ws.close();
        resolve({ error: 'Timeout' });
      }
    }, 15000);

    ws.on('open', () => {
      console.log('📤 Sending registration WITHOUT buildId...');
      
      ws.send(JSON.stringify({
        type: 'register',
        nodeId: testNodeId,
        protocolVersion: PROTOCOL_VERSION,
        // No buildId - should trigger fallback behavior
        timestamp: Date.now(),
        metadata: {
          nodeType: 'debug',
          testMode: true
        }
      }));
    });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        console.log(`📥 Received: ${message.type}`);
        
        if (message.type === 'registered') {
          console.log('✅ Registration successful WITHOUT buildId!');
          console.log('   Server accepts connections when buildId is missing');
          console.log('   (fallback behavior for backwards compatibility)');
          
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            ws.close();
            resolve({ success: true, fallbackWorks: true });
          }
        } else if (message.type === 'version_mismatch') {
          console.log('❌ Version mismatch even without buildId');
          console.log(`   Message: ${message.message}`);
          
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            ws.close();
            resolve({ versionMismatch: true });
          }
        }
      } catch (error) {
        console.log(`⚠️ Parse error: ${error.message}`);
      }
    });

    ws.on('error', (error) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ error: error.message });
      }
    });

    ws.on('close', () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({});
      }
    });
  });
}

// Run analysis
console.log('='.repeat(50));
console.log('TEST 1: Version Mismatch Analysis');
console.log('='.repeat(50) + '\n');

const result1 = await analyzeVersionMismatch();
const result2 = await testFallbackBehavior();

console.log('\n' + '='.repeat(50));
console.log('SUMMARY');
console.log('='.repeat(50));

if (result1.success) {
  console.log('\n✅ Bootstrap server accepts our BUILD_ID');
  console.log('   No action needed - version compatibility is OK');
} else if (result1.versionMismatch) {
  console.log('\n❌ BUILD_ID mismatch confirmed');
  console.log('   Server and client have different bundle hashes');
  
  if (result2.fallbackWorks) {
    console.log('\n💡 WORKAROUND: Server accepts connections without buildId');
    console.log('   Nodes can connect by not sending buildId in registration');
    console.log('   This is a temporary workaround - proper fix is to redeploy');
  }
} else {
  console.log('\n❓ Unexpected result:', result1);
}

process.exit(0);
