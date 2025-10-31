#!/usr/bin/env node

import { EnhancedBootstrapServer } from './EnhancedBootstrapServer.js';

/**
 * Standalone Enhanced Bootstrap Server Startup
 *
 * This is the PUBLIC-FACING server that handles:
 * - New peer registrations and invitations
 * - Reconnection requests from disconnected peers
 * - WebRTC signaling between peers
 *
 * Must be started AFTER bridge nodes are running.
 */

const DEFAULT_CONFIG = {
  port: parseInt(process.env.BOOTSTRAP_PORT) || 8080,
  host: process.env.BOOTSTRAP_HOST || '0.0.0.0',
  maxPeers: parseInt(process.env.MAX_PEERS) || 1000,
  createNewDHT: process.argv.includes('-createNewDHT') || process.argv.includes('--create-new-dht'),
  openNetwork: process.argv.includes('-openNetwork') || process.argv.includes('--open-network'),
  bridgeAuth: process.env.BRIDGE_AUTH || 'default-bridge-auth-key',
  bridgeNodes: [
    'localhost:8083',  // Primary bridge node
    'localhost:8084',  // Secondary bridge node
  ]
};

class EnhancedBootstrapManager {
  constructor(config = DEFAULT_CONFIG) {
    this.config = config;
    this.server = null;
    this.isRunning = false;
  }

  async start() {
    if (this.isRunning) {
      throw new Error('Enhanced Bootstrap Server already running');
    }

    console.log('🚀 Starting Enhanced Bootstrap Server');
    console.log('====================================');
    console.log(`🌐 Public Address: ${this.config.host}:${this.config.port}`);
    console.log(`🌉 Bridge Nodes: ${this.config.bridgeNodes.join(', ')}`);
    console.log(`🆕 Create New DHT: ${this.config.createNewDHT ? 'YES (Genesis Mode)' : 'NO (Standard Mode)'}`);
    console.log(`🔓 Open Network: ${this.config.openNetwork ? 'YES (No invitations required)' : 'NO (Invitations required)'}`);
    console.log(`👥 Max Peers: ${this.config.maxPeers}`);

    if (this.config.bridgeAuth === 'default-bridge-auth-key') {
      console.warn('⚠️  WARNING: Using default bridge auth key!');
      console.warn('⚠️  Set BRIDGE_AUTH environment variable for production');
    }

    console.log('====================================');

    try {
      // Create and start enhanced bootstrap server
      this.server = new EnhancedBootstrapServer(this.config);
      await this.server.start();

      this.isRunning = true;

      console.log('✅ Enhanced Bootstrap Server Started Successfully');
      console.log(`🔗 Clients can connect to: ws://${this.config.host}:${this.config.port}`);
      console.log('📋 Server Capabilities:');
      console.log('   - New peer registration and invitation');
      console.log('   - Reconnection services for disconnected peers');
      console.log('   - WebRTC signaling between peers');
      console.log('   - Token-based routing to bridge nodes');

      if (this.config.createNewDHT) {
        console.log('🌟 GENESIS MODE: First connecting peer will become genesis');
        console.log('   - Genesis peer automatically connects to bridge node');
        console.log('   - Genesis status removed, peer gets DHT membership');
        if (this.config.openNetwork) {
          console.log('   - Open network: All new peers auto-connect to bridge');
          console.log('   - No invitations required - open access for all');
        } else {
          console.log('   - Genesis peer can invite others to join');
          console.log('   - Invitation tokens required for new peers');
        }
      } else {
        if (this.config.openNetwork) {
          console.log('🔓 OPEN NETWORK MODE: No invitations required');
          console.log('   - All new peers auto-connect to bridge nodes');
          console.log('   - Bridge nodes auto-generate membership tokens');
          console.log('   - Full DHT participation without invitation step');
        } else {
          console.log('🔄 STANDARD MODE: All peers need invitation tokens');
          console.log('   - Disconnected peers can reconnect with membership tokens');
          console.log('   - New peers need invitations from existing DHT members');
        }
      }

      console.log('====================================');

      // Setup graceful shutdown
      this.setupGracefulShutdown();

    } catch (error) {
      console.error('❌ Failed to start Enhanced Bootstrap Server:', error.message);

      if (error.message.includes('bridge')) {
        console.error('');
        console.error('💡 Troubleshooting:');
        console.error('   1. Make sure bridge nodes are running first:');
        console.error('      npm run bridge-nodes');
        console.error('   2. Check bridge node ports are accessible:');
        console.error('      telnet localhost 8083');
        console.error('      telnet localhost 8084');
        console.error('   3. Verify BRIDGE_AUTH matches between servers');
      }

      await this.stop();
      process.exit(1);
    }
  }

  async stop() {
    if (!this.isRunning) {
      return;
    }

    console.log('🛑 Stopping Enhanced Bootstrap Server...');

    if (this.server) {
      try {
        await this.server.stop();
        console.log('🚀 Enhanced Bootstrap Server stopped');
      } catch (error) {
        console.error('Error stopping server:', error);
      }
      this.server = null;
    }

    this.isRunning = false;
  }

  setupGracefulShutdown() {
    const shutdown = async (signal) => {
      console.log(`\n🔄 Received ${signal}, shutting down gracefully...`);
      try {
        await this.stop();
        console.log('👋 Enhanced Bootstrap Server shutdown complete!');
        process.exit(0);
      } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    process.on('uncaughtException', (error) => {
      console.error('🚨 Uncaught Exception:', error);
      shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
      shutdown('unhandledRejection');
    });
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      config: this.config,
      server: this.server ? this.server.getStats() : null
    };
  }
}

// CLI handling
function showUsage() {
  console.log(`
Enhanced Bootstrap Server - YZSocialC Bridge System

This is the PUBLIC-FACING server that clients connect to.
Must be started AFTER bridge nodes are running.

Usage:
  node start-enhanced-bootstrap.js [options]

Options:
  -createNewDHT, --create-new-dht    Enable genesis peer mode (create new DHT)
  -openNetwork, --open-network       Enable open network mode (no invitations required)
  --help                             Show this help message

Environment Variables:
  BOOTSTRAP_PORT=8080               Bootstrap server port (public-facing)
  BOOTSTRAP_HOST=0.0.0.0           Bootstrap server host
  MAX_PEERS=1000                   Maximum connected peers
  BRIDGE_AUTH=your-key             Bridge authentication key (must match bridge nodes)

Startup Order:
  1. First:  npm run bridge-nodes     # Start internal bridge nodes
  2. Second: npm run bridge-bootstrap # Start public bootstrap server

Examples:
  # Create new DHT network (genesis mode, invitation required)
  node start-enhanced-bootstrap.js -createNewDHT

  # Create new open DHT network (genesis mode, no invitations)
  node start-enhanced-bootstrap.js -createNewDHT -openNetwork

  # Connect to existing DHT network (invitation required)
  node start-enhanced-bootstrap.js

  # Connect to existing open DHT network (no invitations)
  node start-enhanced-bootstrap.js -openNetwork

  # Custom configuration
  BOOTSTRAP_PORT=9000 BRIDGE_AUTH=secret node start-enhanced-bootstrap.js -openNetwork
`);
}

// Main execution
async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    showUsage();
    process.exit(0);
  }

  const manager = new EnhancedBootstrapManager(DEFAULT_CONFIG);

  // Status monitoring (optional)
  if (process.argv.includes('--status')) {
    setInterval(() => {
      console.log('📊 Bootstrap Status:', JSON.stringify(manager.getStatus(), null, 2));
    }, 30000);
  }

  await manager.start();

  // Keep process alive
  setInterval(() => {
    // Heartbeat - could add health checks here
  }, 10000);
}

// Always run main function (simplified for debugging)
console.log('🚀 Enhanced Bootstrap Server Startup Script Starting...');
main().catch(error => {
  console.error('🚨 Fatal error:', error);
  console.error('Stack trace:', error.stack);
  process.exit(1);
});

export { EnhancedBootstrapManager, DEFAULT_CONFIG };