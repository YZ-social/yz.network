#!/usr/bin/env node

/**
 * Start Single Bridge Node - Docker-friendly launcher
 *
 * Usage: node start-single-bridge-node.js <port>
 * Example: node start-single-bridge-node.js 8083
 */

import { PassiveBridgeNode } from './PassiveBridgeNode.js';

const port = parseInt(process.argv[2]) || parseInt(process.env.BRIDGE_PORT) || 8083;
const host = process.env.BRIDGE_HOST || '0.0.0.0';
const bridgeAuth = process.env.BRIDGE_AUTH || 'default-bridge-auth-key';
const bootstrapUrl = process.env.BOOTSTRAP_URL || 'ws://bootstrap:8080';
const publicAddress = process.env.PUBLIC_ADDRESS || `${host}:${port}`;

console.log(`🌉 Starting Passive Bridge Node on port ${port}...`);
console.log(`📍 Public address: ${publicAddress}`);

const node = new PassiveBridgeNode({
  bridgePort: port,
  bridgeHost: host,
  bridgeAuth,
  bootstrapServers: [bootstrapUrl],
  publicAddress  // NEW: Docker service name for peer connections
});

// Start the bridge node
node.start()
  .then(() => {
    console.log(`✅ Bridge node started successfully on ${host}:${port}`);
    console.log(`🔗 Bootstrap server: ${bootstrapUrl}`);
    console.log(`🔐 Auth: ${bridgeAuth === 'default-bridge-auth-key' ? 'DEFAULT' : 'CUSTOM'}`);
  })
  .catch((error) => {
    console.error('❌ Failed to start bridge node:', error);
    process.exit(1);
  });

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🛑 Received SIGTERM, shutting down gracefully...');
  try {
    await node.shutdown();
    console.log('✅ Bridge node stopped');
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
});

process.on('SIGINT', async () => {
  console.log('🛑 Received SIGINT, shutting down gracefully...');
  try {
    await node.shutdown();
    console.log('✅ Bridge node stopped');
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
});
