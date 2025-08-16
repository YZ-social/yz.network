/**
 * Browser DHT Client - WebRTC DHT node for browser environments
 * 
 * This client connects to other browser peers via WebRTC DataChannels.
 * Uses bootstrap server only for initial peer discovery and invitation exchange.
 * 
 * Architecture:
 * - Browser-to-Browser: WebRTC DataChannels with keep-alive for inactive tabs
 * - Browser-to-Node.js: Use HybridConnectionManager (separate client implementation)
 */

import { KademliaDHT } from '../dht/KademliaDHT.js';
import { BootstrapClient } from '../bootstrap/BootstrapClient.js';
import { WebRTCManager } from '../network/WebRTCManager.js';
import { DHTNodeId } from '../core/DHTNodeId.js';
import { InvitationToken } from '../core/InvitationToken.js';

/**
 * Browser DHT Client with WebRTC connection support
 */
export class BrowserDHTClient {
  constructor(options = {}) {
    this.options = {
      bootstrapServers: options.bootstrapServers || ['ws://localhost:8080'],
      k: options.k || 20,
      alpha: options.alpha || 3,
      replicateK: options.replicateK || 3,
      ...options
    };

    // Generate browser node ID
    const seed = new Uint8Array(20);
    crypto.getRandomValues(seed);
    this.nodeId = new DHTNodeId(seed);
    
    this.dht = null;
    this.connectionManager = null;
    this.bootstrap = null;
    this.isStarted = false;

    console.log('🌐 Browser DHT Client initializing');
    console.log(`   Node ID: ${this.nodeId.toString().substring(0, 16)}...`);
    console.log(`   Node Type: browser (WebRTC DataChannels)`);
  }

  /**
   * Start the DHT client
   */
  async start() {
    if (this.isStarted) {
      throw new Error('DHT client already started');
    }

    console.log('🚀 Starting Browser DHT client...');

    // Create WebRTC connection manager for Browser-to-Browser connections
    this.connectionManager = new WebRTCManager({
      timeout: 30000,
      maxConnections: 50
    });

    this.connectionManager.initialize(this.nodeId.toString());

    // Create bootstrap client
    this.bootstrap = new BootstrapClient({
      bootstrapServers: this.options.bootstrapServers,
      timeout: 15000
    });

    // Create DHT with WebRTC connection manager
    this.dht = new KademliaDHT({
      nodeId: this.nodeId,
      webrtc: this.connectionManager, // WebRTCManager for Browser-to-Browser connections
      bootstrap: this.bootstrap,
      k: this.options.k,
      alpha: this.options.alpha,
      replicateK: this.options.replicateK
    });

    // Set up browser metadata for bootstrap registration
    this.dht.bootstrapMetadata = {
      nodeType: 'browser',
      capabilities: ['webrtc'],
      canAcceptConnections: false, // Browsers can't accept incoming connections
      canInitiateConnections: true // Browsers can initiate WebRTC connections to other browsers
    };

    console.log('📡 Prepared browser metadata for bootstrap registration');

    // Start the DHT
    await this.dht.start();

    this.isStarted = true;
    console.log('✅ Browser DHT client started successfully');

    return {
      nodeId: this.nodeId.toString(),
      nodeType: 'browser',
      capabilities: ['webrtc', 'websocket-client']
    };
  }

  /**
   * Store data in DHT
   */
  async store(key, value) {
    if (!this.dht) {
      throw new Error('DHT not started');
    }
    return this.dht.store(key, value);
  }

  /**
   * Get data from DHT
   */
  async get(key) {
    if (!this.dht) {
      throw new Error('DHT not started');
    }
    return this.dht.get(key);
  }

  /**
   * Invite new client to join DHT
   */
  async inviteNewClient(targetNodeId) {
    if (!this.dht) {
      throw new Error('DHT not started');
    }
    return this.dht.inviteNewClient(targetNodeId);
  }

  /**
   * Get connected peers
   */
  getConnectedPeers() {
    if (!this.connectionManager) return [];
    return this.connectionManager.getConnectedPeers();
  }

  /**
   * Get DHT statistics
   */
  getStats() {
    if (!this.dht || !this.connectionManager) return null;

    return {
      nodeId: this.nodeId.toString(),
      nodeType: 'browser',
      connections: this.connectionManager.getStats(),
      dht: {
        routingTableSize: this.dht.routingTable?.getAllNodes()?.length || 0,
        connectedPeers: this.getConnectedPeers().length
      },
      capabilities: ['webrtc'],
      canAcceptConnections: false,
      canInitiateConnections: true
    };
  }

  /**
   * Stop the DHT client
   */
  async stop() {
    if (!this.isStarted) return;

    console.log('🛑 Stopping Browser DHT client...');

    if (this.dht) {
      await this.dht.stop();
    }

    if (this.connectionManager) {
      this.connectionManager.destroy();
    }

    if (this.bootstrap) {
      this.bootstrap.destroy();
    }

    this.isStarted = false;
    console.log('✅ Browser DHT client stopped');
  }
}