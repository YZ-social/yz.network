#!/usr/bin/env node

/**
 * Temporarily disable connection pool to restore working state
 * This creates a modified bootstrap server that uses stateless connections
 * but still uses the correct external nginx addresses
 */

import fs from 'fs';
import path from 'path';

async function createFallbackBootstrapServer() {
  console.log('🔧 Creating fallback bootstrap server without connection pool...');
  
  try {
    // Read the current EnhancedBootstrapServer
    const bootstrapPath = 'src/bridge/EnhancedBootstrapServer.js';
    const originalContent = fs.readFileSync(bootstrapPath, 'utf8');
    
    // Create a backup
    fs.writeFileSync(`${bootstrapPath}.backup`, originalContent);
    console.log('✅ Backed up original EnhancedBootstrapServer.js');
    
    // Create modified version that doesn't use connection pool
    const modifiedContent = originalContent
      // Remove connection pool import
      .replace(/import { BridgeConnectionPool } from '\.\/BridgeConnectionPool\.js';/, '// Connection pool temporarily disabled')
      
      // Remove connection pool initialization in constructor
      .replace(/\/\/ Initialize bridge connection pool[\s\S]*?\);/m, `// Connection pool temporarily disabled
    // this.bridgePool = null;`)
      
      // Remove connection pool initialization in start method
      .replace(/\/\/ Initialize bridge connection pool[\s\S]*?console\.log\('✅ Bridge connection pool initialized'\);/m, `// Connection pool temporarily disabled
    console.log('⚠️ Connection pool disabled - using stateless connections');`)
      
      // Remove connection pool shutdown in stop method
      .replace(/\/\/ Shutdown bridge connection pool[\s\S]*?}/m, `// Connection pool disabled`)
      
      // Restore the old requestOnboardingPeerFromBridge method
      .replace(/\/\*\*[\s]*\* Request onboarding peer from bridge \(using connection pool\)[\s\S]*?}/m, `/**
   * Request onboarding peer from bridge (stateless fallback)
   * TEMPORARY: Using stateless connections until connection pool is fixed
   */
  async requestOnboardingPeerFromBridge(nodeId, metadata) {
    console.log(\`🎲 Requesting onboarding peer for \${nodeId.substring(0, 8)}... from bridge nodes (stateless)\`);

    // Try each bridge node until one responds
    for (const bridgeAddr of this.options.bridgeNodes) {
      try {
        const result = await this.queryBridgeForOnboardingPeer(bridgeAddr, nodeId, metadata);
        if (result) {
          console.log(\`✅ Got onboarding peer from bridge \${bridgeAddr}\`);
          return result;
        }
      } catch (error) {
        console.warn(\`❌ Bridge \${bridgeAddr} failed: \${error.message}\`);
        continue; // Try next bridge
      }
    }

    throw new Error('No bridge nodes available for onboarding coordination');
  }

  /**
   * Query a single bridge for onboarding peer (stateless fallback)
   */
  async queryBridgeForOnboardingPeer(bridgeAddr, nodeId, metadata) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(\`Bridge query timeout: \${bridgeAddr}\`));
      }, 10000);

      try {
        // Use external address (already includes protocol)
        const wsUrl = bridgeAddr.startsWith('wss://') || bridgeAddr.startsWith('ws://') 
          ? bridgeAddr 
          : \`wss://\${bridgeAddr}\`;
          
        const ws = new WebSocket(wsUrl);
        let authenticated = false;

        ws.onopen = () => {
          // Authenticate first
          ws.send(JSON.stringify({
            type: 'bootstrap_auth',
            auth_token: this.options.bridgeAuth,
            bootstrapServer: \`\${this.options.host}:\${this.options.port}\`
          }));
        };

        ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);

            if (message.type === 'auth_success' && !authenticated) {
              authenticated = true;
              // Now request onboarding peer
              ws.send(JSON.stringify({
                type: 'get_onboarding_peer',
                newNodeId: nodeId,
                newNodeMetadata: metadata,
                requestId: \`onboarding_\${Date.now()}_\${Math.random().toString(36).substr(2, 9)}\`
              }));
            } else if (message.type === 'onboarding_peer_response') {
              clearTimeout(timeout);
              ws.close(1000, 'Request complete');
              resolve(message.data);
            } else if (message.type === 'error') {
              clearTimeout(timeout);
              ws.close(1000, 'Request failed');
              reject(new Error(message.message || 'Bridge request failed'));
            }
          } catch (error) {
            clearTimeout(timeout);
            ws.close(1000, 'Parse error');
            reject(error);
          }
        };

        ws.onerror = (error) => {
          clearTimeout(timeout);
          reject(new Error(\`Bridge connection failed: \${bridgeAddr}\`));
        };

        ws.onclose = () => {
          // Connection closed - this is expected after request
        };

      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }`);
    
    // Write the modified content
    fs.writeFileSync(bootstrapPath, modifiedContent);
    console.log('✅ Created fallback bootstrap server without connection pool');
    
    console.log('\n📋 FALLBACK BOOTSTRAP SERVER CREATED');
    console.log('====================================');
    console.log('✅ Connection pool disabled');
    console.log('✅ Stateless connections restored');
    console.log('✅ External nginx addresses maintained');
    console.log('✅ Original file backed up as .backup');
    console.log('');
    console.log('NEXT STEPS:');
    console.log('1. Restart the server: ./RestartServerImproved.sh');
    console.log('2. Test if system is working');
    console.log('3. If working, investigate connection pool issues');
    console.log('4. To restore: mv src/bridge/EnhancedBootstrapServer.js.backup src/bridge/EnhancedBootstrapServer.js');
    
  } catch (error) {
    console.error('❌ Failed to create fallback bootstrap server:', error.message);
  }
}

async function main() {
  console.log('🚨 EMERGENCY FALLBACK: Disabling Connection Pool');
  console.log('================================================');
  console.log('This will temporarily disable the connection pool and restore');
  console.log('stateless connections while maintaining external nginx addresses.');
  console.log('');
  
  await createFallbackBootstrapServer();
}

main().catch(console.error);