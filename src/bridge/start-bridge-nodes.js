#!/usr/bin/env node

console.log('🔄 Loading bridge nodes script...');

import { PassiveBridgeNode } from './PassiveBridgeNode.js';
import { WebSocketManager } from '../network/WebSocketManager.js';

console.log('✅ Imports loaded successfully');

/**
 * Standalone Bridge Nodes Startup
 * 
 * These are INTERNAL servers that provide reconnection validation services.
 * They observe DHT network traffic but don't participate in DHT operations.
 * Must be started BEFORE the enhanced bootstrap server.
 */

const DEFAULT_CONFIG = {
  bridgeAuth: process.env.BRIDGE_AUTH || 'default-bridge-auth-key',
  bootstrapServers: ['ws://localhost:8080'],
  
  nodes: [
    {
      port: parseInt(process.env.BRIDGE_PORT_1) || 8083,
      host: 'localhost',
      dhtPort: parseInt(process.env.BRIDGE_DHT_PORT_1) || 9083,
      maxConnections: 20
    },
    {
      port: parseInt(process.env.BRIDGE_PORT_2) || 8084,
      host: 'localhost', 
      dhtPort: parseInt(process.env.BRIDGE_DHT_PORT_2) || 9084,
      maxConnections: 20
    }
  ]
};

class BridgeNodesManager {
  constructor(config = DEFAULT_CONFIG) {
    this.config = config;
    this.bridges = [];
    this.isRunning = false;
  }

  async start() {
    if (this.isRunning) {
      throw new Error('Bridge nodes already running');
    }

    console.log('🌉 Starting Passive Bridge Nodes');
    console.log('=================================');
    console.log(`🔐 Bridge Auth: ${this.config.bridgeAuth === 'default-bridge-auth-key' ? 'DEFAULT (change for production)' : 'CUSTOM'}`);
    console.log(`🏗️  Nodes to start: ${this.config.nodes.length}`);
    
    if (this.config.bridgeAuth === 'default-bridge-auth-key') {
      console.warn('⚠️  WARNING: Using default bridge auth key!');
      console.warn('⚠️  Set BRIDGE_AUTH environment variable for production');
    }
    
    console.log('=================================');

    try {
      // Start all bridge nodes
      for (let i = 0; i < this.config.nodes.length; i++) {
        const nodeConfig = this.config.nodes[i];
        await this.startBridgeNode(i + 1, nodeConfig);
      }
      
      this.isRunning = true;
      
      console.log('=================================');
      console.log('✅ All Bridge Nodes Started Successfully');
      console.log(`🌉 ${this.bridges.length} bridge nodes running`);
      console.log('📋 Bridge Node Capabilities:');
      console.log('   - Passive DHT network observation');
      console.log('   - Reconnection validation services');
      console.log('   - Network health monitoring');
      console.log('   - Cryptographic network fingerprinting');
      console.log('');
      console.log('🎯 Next Step: Start Enhanced Bootstrap Server');
      console.log('   npm run bridge-bootstrap        # Standard mode');
      console.log('   npm run bridge-bootstrap:genesis # Genesis mode (new DHT)');
      console.log('=================================');
      
      // Setup graceful shutdown
      this.setupGracefulShutdown();
      
    } catch (error) {
      console.error('❌ Failed to start bridge nodes:', error.message);
      await this.stop();
      process.exit(1);
    }
  }

  async startBridgeNode(nodeNumber, nodeConfig) {
    console.log(`🌉 Starting bridge node ${nodeNumber}...`);
    console.log(`   Bridge Service: ${nodeConfig.host}:${nodeConfig.port} (internal only)`);
    console.log(`   DHT Connection: ${nodeConfig.host}:${nodeConfig.dhtPort}`);
    
    try {
      // Create WebSocket connection manager for DHT connections
      const connectionManager = new WebSocketManager({
        port: nodeConfig.dhtPort,
        host: nodeConfig.host,
        maxConnections: nodeConfig.maxConnections,
        enableWebRTC: false // Bridge nodes use WebSocket only for now
      });
      
      const bridge = new PassiveBridgeNode({
        bridgePort: nodeConfig.port,
        bridgeHost: nodeConfig.host,
        bridgeAuth: this.config.bridgeAuth,
        maxConnections: nodeConfig.maxConnections,
        dhtOptions: {
          bootstrapServers: this.config.bootstrapServers,
          webrtc: connectionManager
        },
        connectionOptions: {
          maxConnections: nodeConfig.maxConnections
        }
      });
      
      await bridge.start();
      this.bridges.push({
        bridge,
        nodeNumber,
        config: nodeConfig
      });
      
      console.log(`✅ Bridge node ${nodeNumber} started successfully`);
      console.log(`   Status: ${bridge.getStatus().isStarted ? 'RUNNING' : 'ERROR'}`);
      console.log(`   Node ID: ${bridge.dht.localNodeId.toString().substring(0, 16)}...`);
      
    } catch (error) {
      console.error(`❌ Failed to start bridge node ${nodeNumber}:`, error.message);
      throw error;
    }
  }

  async stop() {
    if (!this.isRunning) {
      return;
    }

    console.log('🛑 Stopping Bridge Nodes...');
    
    // Stop all bridge nodes
    for (let i = 0; i < this.bridges.length; i++) {
      const { bridge, nodeNumber } = this.bridges[i];
      try {
        await bridge.stop();
        console.log(`🌉 Bridge node ${nodeNumber} stopped`);
      } catch (error) {
        console.error(`Error stopping bridge node ${nodeNumber}:`, error);
      }
    }
    
    this.bridges = [];
    this.isRunning = false;
    console.log('🌉 All bridge nodes stopped');
  }

  setupGracefulShutdown() {
    const shutdown = async (signal) => {
      console.log(`\n🔄 Received ${signal}, shutting down bridge nodes gracefully...`);
      try {
        await this.stop();
        console.log('👋 Bridge nodes shutdown complete!');
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
      nodeCount: this.bridges.length,
      nodes: this.bridges.map(({ bridge, nodeNumber, config }) => ({
        nodeNumber,
        port: config.port,
        dhtPort: config.dhtPort,
        status: bridge.getStatus()
      }))
    };
  }
}

// CLI handling
function showUsage() {
  console.log(`
Bridge Nodes - YZSocialC Bridge System

These are INTERNAL servers that provide reconnection services.
Must be started BEFORE the enhanced bootstrap server.

Usage:
  node start-bridge-nodes.js [options]

Options:
  --help                             Show this help message
  --status                          Show periodic status updates

Environment Variables:
  BRIDGE_AUTH=your-key              Bridge authentication key
  BRIDGE_PORT_1=8083               First bridge node port (internal)
  BRIDGE_PORT_2=8084               Second bridge node port (internal)  
  BRIDGE_DHT_PORT_1=9083           First bridge DHT connection port
  BRIDGE_DHT_PORT_2=9084           Second bridge DHT connection port

Network Architecture:
  Bridge Nodes (Internal) ←→ Enhanced Bootstrap (Public) ←→ Internet
       ↕                           ↕
   DHT Network              Client Connections

Startup Order:
  1. First:  npm run bridge-nodes     # Start these FIRST
  2. Second: npm run bridge-bootstrap # Start public server

Examples:
  # Start bridge nodes with default configuration
  node start-bridge-nodes.js
  
  # Custom configuration
  BRIDGE_AUTH=secret BRIDGE_PORT_1=9083 node start-bridge-nodes.js
  
  # With status monitoring
  node start-bridge-nodes.js --status
`);
}

// Main execution
async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    showUsage();
    process.exit(0);
  }

  const manager = new BridgeNodesManager(DEFAULT_CONFIG);
  
  // Status monitoring (optional)
  if (process.argv.includes('--status')) {
    setInterval(() => {
      const status = manager.getStatus();
      console.log(`📊 Bridge Status: ${status.nodeCount} nodes running`);
      status.nodes.forEach(node => {
        console.log(`   Node ${node.nodeNumber}: ${node.status.connectedPeers} peers, ${node.status.validAnnouncements} announcements`);
      });
    }, 30000);
  }
  
  await manager.start();
  
  // Keep process alive
  setInterval(() => {
    // Heartbeat - could add health checks here
  }, 10000);
}

// Always run main function (simplified for debugging)
console.log('🌉 Bridge Nodes Startup Script Starting...');
main().catch(error => {
  console.error('🚨 Fatal error:', error);
  console.error('Stack trace:', error.stack);
  process.exit(1);
});

export { BridgeNodesManager, DEFAULT_CONFIG };