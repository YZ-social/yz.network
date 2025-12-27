#!/usr/bin/env node

/**
 * Debug Version Mismatch Issue
 * Specifically investigate the BUILD_ID comparison problem
 */

import { PROTOCOL_VERSION, BUILD_ID, checkVersionCompatibility } from '../src/version.js';

console.log('🔍 VERSION MISMATCH DEBUG');
console.log('=========================\n');

console.log('📋 LOCAL VERSION INFO:');
console.log(`   PROTOCOL_VERSION: ${PROTOCOL_VERSION}`);
console.log(`   BUILD_ID: ${BUILD_ID}`);
console.log(`   BUILD_ID type: ${typeof BUILD_ID}`);
console.log(`   BUILD_ID length: ${BUILD_ID.length}`);
console.log(`   Is fallback BUILD_ID: ${BUILD_ID.startsWith('node_') || BUILD_ID.startsWith('unknown_') || BUILD_ID === 'initializing'}`);

console.log('\n🔌 TESTING BOOTSTRAP CONNECTION WITH DEBUG INFO...');

const WebSocket = (await import('ws')).default;

const testConnection = () => {
  return new Promise((resolve) => {
    const ws = new WebSocket('wss://imeyouwe.com/ws');
    let resolved = false;
    
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ws.close();
        resolve({ success: false, error: 'Connection timeout' });
      }
    }, 10000);
    
    ws.onopen = () => {
      console.log('✅ Connected to bootstrap server');
      
      // Send registration message with debug info
      const registrationMessage = {
        type: 'register_peer',
        nodeId: 'debug_test_node_12345678',
        metadata: {
          nodeType: 'nodejs',
          capabilities: ['websocket']
        },
        protocolVersion: PROTOCOL_VERSION,
        buildId: BUILD_ID
      };
      
      console.log('\n📤 SENDING REGISTRATION MESSAGE:');
      console.log(`   type: ${registrationMessage.type}`);
      console.log(`   protocolVersion: ${registrationMessage.protocolVersion}`);
      console.log(`   buildId: ${registrationMessage.buildId}`);
      console.log(`   buildId type: ${typeof registrationMessage.buildId}`);
      console.log(`   buildId length: ${registrationMessage.buildId.length}`);
      
      ws.send(JSON.stringify(registrationMessage));
    };
    
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        console.log(`\n📥 RECEIVED MESSAGE:`);
        console.log(`   type: ${message.type}`);
        
        if (message.type === 'version_mismatch') {
          console.log('\n🚨 VERSION MISMATCH DETAILS:');
          console.log(`   clientVersion: ${message.clientVersion}`);
          console.log(`   clientBuildId: ${message.clientBuildId}`);
          console.log(`   serverVersion: ${message.serverVersion}`);
          console.log(`   serverBuildId: ${message.serverBuildId}`);
          console.log(`   message: ${message.message}`);
          
          console.log('\n🔍 BUILD_ID COMPARISON:');
          console.log(`   Client BUILD_ID: "${message.clientBuildId}" (length: ${message.clientBuildId?.length})`);
          console.log(`   Server BUILD_ID: "${message.serverBuildId}" (length: ${message.serverBuildId?.length})`);
          console.log(`   Are equal: ${message.clientBuildId === message.serverBuildId}`);
          console.log(`   Client is fallback: ${!message.clientBuildId || message.clientBuildId.startsWith('node_') || message.clientBuildId.startsWith('unknown_') || message.clientBuildId === 'initializing'}`);
          console.log(`   Server is fallback: ${!message.serverBuildId || message.serverBuildId.startsWith('node_') || message.serverBuildId.startsWith('unknown_') || message.serverBuildId === 'initializing'}`);
          
          // Test the compatibility function locally
          console.log('\n🧪 LOCAL COMPATIBILITY CHECK:');
          const localCheck = checkVersionCompatibility(
            message.clientVersion,
            message.clientBuildId,
            message.serverBuildId
          );
          console.log(`   Local result: ${JSON.stringify(localCheck, null, 2)}`);
          
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            ws.close();
            resolve({ 
              success: false, 
              versionMismatch: true,
              details: message
            });
          }
        } else {
          console.log(`✅ Registration successful: ${message.type}`);
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            ws.close();
            resolve({ success: true });
          }
        }
      } catch (error) {
        console.log(`❌ Error parsing message: ${error.message}`);
        console.log(`   Raw message: ${event.data}`);
      }
    };
    
    ws.onerror = (error) => {
      console.log(`❌ WebSocket error: ${error.message || 'Connection failed'}`);
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ success: false, error: error.message || 'Connection failed' });
      }
    };
    
    ws.onclose = (event) => {
      console.log(`🔌 Connection closed: ${event.code} ${event.reason}`);
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ 
          success: false, 
          error: `Connection closed: ${event.code} ${event.reason}`
        });
      }
    };
  });
};

try {
  const result = await testConnection();
  
  console.log('\n🎯 DIAGNOSIS SUMMARY:');
  console.log('====================');
  
  if (result.versionMismatch) {
    console.log('❌ Version mismatch confirmed');
    console.log('🔍 The issue appears to be in the BUILD_ID comparison logic');
    console.log('💡 Both protocol versions are 1.0.0 but BUILD_IDs differ');
    console.log('🔧 Check if server and client are reading different bundle hashes');
  } else if (result.success) {
    console.log('✅ Connection successful - version mismatch may be resolved');
  } else {
    console.log(`❌ Connection failed: ${result.error}`);
  }
  
} catch (error) {
  console.error('❌ Debug test failed:', error);
}