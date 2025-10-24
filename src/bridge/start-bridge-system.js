#!/usr/bin/env node

import { PassiveBridgeNode } from './PassiveBridgeNode.js';
import { EnhancedBootstrapServer } from './EnhancedBootstrapServer.js';

/**
 * Bridge System Startup Script
 * 
 * Starts both the passive bridge node(s) and enhanced bootstrap server
 * with proper configuration and error handling.
 */

const DEFAULT_CONFIG = {
  // Bridge configuration
  bridgeAuth: process.env.BRIDGE_AUTH || 'your-secure-bridge-auth-key-here',
  
  // Bootstrap server configuration
  bootstrap: {
    port: parseInt(process.env.BOOTSTRAP_PORT) || 8080,
    host: process.env.BOOTSTRAP_HOST || '0.0.0.0',
    maxPeers: parseInt(process.env.MAX_PEERS) || 1000,
    createNewDHT: process.argv.includes('-createNewDHT') || process.argv.includes('--create-new-dht'),
    openNetwork: process.argv.includes('-openNetwork') || process.argv.includes('--open-network')
  },
  
  // Bridge node configuration
  bridges: [
    {
      port: parseInt(process.env.BRIDGE_PORT_1) || 8083,
      host: 'localhost',
      maxConnections: 20,
      bootstrapServers: ['ws://localhost:8080']
    },
    {
      port: parseInt(process.env.BRIDGE_PORT_2) || 8084,
      host: 'localhost', 
      maxConnections: 20,
      bootstrapServers: ['ws://localhost:8080']
    }
  ]
};

class BridgeSystemManager {
  constructor(config = DEFAULT_CONFIG) {
    this.config = config;
    this.bridges = [];
    this.bootstrapServer = null;
    this.isRunning = false;
  }

  async start() {
    if (this.isRunning) {
      throw new Error('Bridge system already running');
    }

    console.log('🌉 Starting YZSocialC Bridge System');
    console.log('=====================================');
    
    try {
      // Start bridge nodes first
      await this.startBridgeNodes();
      
      // Wait a moment for bridges to initialize
      await this.delay(2000);
      
      // Start bootstrap server
      await this.startBootstrapServer();
      
      this.isRunning = true;
      
      console.log('=====================================');
      console.log('✅ Bridge System Started Successfully');
      console.log(`🔗 Public Bootstrap: ${this.config.bootstrap.host}:${this.config.bootstrap.port}`);
      console.log(`🌉 Bridge Nodes: ${this.bridges.length} running`);
      console.log(`🆕 Create New DHT: ${this.config.bootstrap.createNewDHT ? 'ENABLED' : 'DISABLED'}`);
      console.log(`🔓 Open Network: ${this.config.bootstrap.openNetwork ? 'ENABLED (no invitations)' : 'DISABLED (invitations required)'}`);
      console.log('=====================================');
      
      // Setup graceful shutdown
      this.setupGracefulShutdown();
      
    } catch (error) {
      console.error('❌ Failed to start bridge system:', error);
      await this.stop();
      process.exit(1);
    }
  }

  async startBridgeNodes() {
    console.log(`🌉 Starting ${this.config.bridges.length} bridge nodes...`);
    
    for (let i = 0; i < this.config.bridges.length; i++) {
      const bridgeConfig = this.config.bridges[i];
      
      try {
        console.log(`🌉 Starting bridge node ${i + 1} on port ${bridgeConfig.port}...`);

        // PassiveBridgeNode creates its own connection manager via factory
        const bridge = new PassiveBridgeNode({
          bridgePort: bridgeConfig.port,
          bridgeHost: bridgeConfig.host,
          bridgeAuth: this.config.bridgeAuth,
          maxConnections: bridgeConfig.maxConnections,
          dhtOptions: {
            bootstrapServers: bridgeConfig.bootstrapServers
          },
          connectionOptions: {
            maxConnections: bridgeConfig.maxConnections
          }
        });
        
        await bridge.start();
        this.bridges.push(bridge);
        
        console.log(`✅ Bridge node ${i + 1} started successfully`);
        
      } catch (error) {
        console.error(`❌ Failed to start bridge node ${i + 1}:`, error);
        throw error;
      }
    }
  }

  async startBootstrapServer() {
    console.log('🚀 Starting enhanced bootstrap server...');
    
    const bridgeAddresses = this.config.bridges.map(b => `${b.host}:${b.port}`);
    
    this.bootstrapServer = new EnhancedBootstrapServer({
      ...this.config.bootstrap,
      bridgeNodes: bridgeAddresses,
      bridgeAuth: this.config.bridgeAuth
    });
    
    await this.bootstrapServer.start();
    console.log('✅ Enhanced bootstrap server started successfully');
  }

  async stop() {
    if (!this.isRunning) {
      return;
    }

    console.log('🛑 Stopping Bridge System...');
    
    // Stop bootstrap server
    if (this.bootstrapServer) {
      try {
        await this.bootstrapServer.stop();
        console.log('🚀 Bootstrap server stopped');
      } catch (error) {
        console.error('Error stopping bootstrap server:', error);
      }
      this.bootstrapServer = null;
    }
    
    // Stop bridge nodes
    for (let i = 0; i < this.bridges.length; i++) {
      try {
        await this.bridges[i].stop();
        console.log(`🌉 Bridge node ${i + 1} stopped`);
      } catch (error) {
        console.error(`Error stopping bridge node ${i + 1}:`, error);
      }
    }
    this.bridges = [];
    
    this.isRunning = false;
    console.log('🌉 Bridge System stopped');
  }

  setupGracefulShutdown() {
    const shutdown = async (signal) => {
      console.log(`\n🔄 Received ${signal}, shutting down gracefully...`);
      try {
        await this.stop();
        console.log('👋 Goodbye!');
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

  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      bridges: this.bridges.map((bridge, i) => ({
        id: i + 1,
        port: this.config.bridges[i].port,
        status: bridge.getStatus()
      })),
      bootstrap: this.bootstrapServer ? this.bootstrapServer.getStats() : null
    };
  }
}

// CLI handling
function showUsage() {
  console.log(`
YZSocialC Bridge System

Usage:
  node start-bridge-system.js [options]

Options:
  -createNewDHT, --create-new-dht    Enable genesis peer creation mode
  -openNetwork, --open-network       Enable open network mode (no invitations required)
  --help                             Show this help message

Environment Variables:
  BOOTSTRAP_PORT=8080               Bootstrap server port
  BOOTSTRAP_HOST=0.0.0.0           Bootstrap server host
  BRIDGE_PORT_1=8083               First bridge node port  
  BRIDGE_PORT_2=8084               Second bridge node port
  MAX_PEERS=1000                   Maximum connected peers
  BRIDGE_AUTH=your-key             Bridge authentication key

Examples:
  # Start regular bootstrap server (invitations required)
  node start-bridge-system.js

  # Start with genesis mode (first network setup)
  node start-bridge-system.js -createNewDHT

  # Start with open network mode (no invitations required)
  node start-bridge-system.js -createNewDHT -openNetwork

  # Custom configuration
  BOOTSTRAP_PORT=9000 BRIDGE_PORT_1=9083 node start-bridge-system.js -openNetwork
`);
}

// Main execution
async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    showUsage();
    process.exit(0);
  }

  // Validate bridge auth key
  if (DEFAULT_CONFIG.bridgeAuth === 'your-secure-bridge-auth-key-here') {
    console.warn('⚠️  WARNING: Using default bridge auth key!');
    console.warn('⚠️  Set BRIDGE_AUTH environment variable for production use');
  }

  const manager = new BridgeSystemManager(DEFAULT_CONFIG);
  
  // Status monitoring endpoint (optional)
  if (process.argv.includes('--status')) {
    setInterval(() => {
      console.log('📊 System Status:', JSON.stringify(manager.getStatus(), null, 2));
    }, 30000); // Every 30 seconds
  }
  
  await manager.start();
  
  // Keep the process alive
  setInterval(() => {
    // Heartbeat - could add health checks here
  }, 10000);
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('🚨 Fatal error:', error);
    process.exit(1);
  });
}

export { BridgeSystemManager, DEFAULT_CONFIG };