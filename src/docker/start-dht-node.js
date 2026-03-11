#!/usr/bin/env node

/**
 * Start DHT Node - Entry point for Docker containers
 *
 * Configurable via environment variables:
 * - BOOTSTRAP_URL: Bootstrap server URL (default: ws://bootstrap:8080)
 * - METRICS_PORT: Port for metrics/health API (default: 9090)
 * - NODE_NAME: Optional node name for logging
 * - OPEN_NETWORK: Enable open network mode (default: true)
 * - LOG_LEVEL: Logging verbosity (error, warn, info, debug, trace)
 */

// Apply log level filtering BEFORE any imports
// This reduces memory usage by preventing string allocations for suppressed logs
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const currentLevel = LOG_LEVELS[LOG_LEVEL] ?? LOG_LEVELS.info;

if (currentLevel < LOG_LEVELS.info) {
  // Suppress ALL console.log when LOG_LEVEL is error or warn
  // Only console.warn and console.error will pass through
  console.log = () => {};
  console.info = () => {};
}

import { ActiveDHTNode } from './ActiveDHTNode.js';

// Parse environment variables
const config = {
  bootstrapServers: [process.env.BOOTSTRAP_URL || 'ws://bootstrap:8080'],
  metricsPort: parseInt(process.env.METRICS_PORT) || 9090,
  nodeName: process.env.NODE_NAME || `node-${Date.now()}`,
  openNetwork: process.env.OPEN_NETWORK !== 'false',
  websocketPort: process.env.WEBSOCKET_PORT ? parseInt(process.env.WEBSOCKET_PORT) : undefined,
  websocketHost: process.env.WEBSOCKET_HOST || '0.0.0.0',
  externalAddress: process.env.EXTERNAL_ADDRESS,       // All connections via nginx (e.g., wss://imeyouwe.com/node1)
  upnpEnabled: process.env.UPNP_ENABLED !== 'false'
};

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('🌐 YZ Network - Active DHT Node');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`📝 Node Name: ${config.nodeName}`);
console.log(`🔗 Bootstrap: ${config.bootstrapServers[0]}`);
console.log(`📊 Metrics Port: ${config.metricsPort}`);
console.log(`📢 Log Level: ${LOG_LEVEL.toUpperCase()}`);
console.log(`🌍 Open Network: ${config.openNetwork ? 'ENABLED' : 'DISABLED'}`);
if (config.websocketPort) {
  console.log(`🔌 WebSocket Port: ${config.websocketPort}`);
}
if (config.externalAddress) {
  console.log(`📍 Address: ${config.externalAddress}`);
}
console.log(`🔓 UPnP: ${config.upnpEnabled ? 'ENABLED' : 'DISABLED'}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// Create and start node
let node = null;

async function start() {
  try {
    // Map externalAddress to publicWssAddress for ActiveDHTNode
    const nodeConfig = {
      ...config,
      publicWssAddress: config.externalAddress  // Map external address to the expected property
    };
    
    node = new ActiveDHTNode(nodeConfig);
    await node.start();

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ Node started successfully');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📡 Status: http://localhost:${config.metricsPort}/status`);
    console.log(`📊 Metrics: http://localhost:${config.metricsPort}/metrics`);
    console.log(`❤️  Health: http://localhost:${config.metricsPort}/health`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  } catch (error) {
    console.error('❌ Failed to start node:', error);
    process.exit(1);
  }
}

// Graceful shutdown
async function shutdown(signal) {
  console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);

  if (node) {
    try {
      await node.shutdown();
      console.log('✅ Shutdown complete');
      process.exit(0);
    } catch (error) {
      console.error('❌ Shutdown error:', error);
      process.exit(1);
    }
  } else {
    process.exit(0);
  }
}

// Signal handlers
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Uncaught error handlers
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error);
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled rejection:', reason);
  shutdown('unhandledRejection');
});

// Start the node
start();
