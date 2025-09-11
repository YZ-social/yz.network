/**
 * Base DHT Client - Superclass for all DHT node implementations
 * 
 * Provides common DHT initialization logic for:
 * - BrowserDHTClient (browser environments)
 * - NodeDHTClient (Node.js environments) 
 * - PassiveBridgeNode (bridge/observer nodes)
 * 
 * Uses connection-agnostic architecture where DHT handles connection management internally.
 */

import { EventEmitter } from 'events';
import { KademliaDHT } from '../dht/KademliaDHT.js';
import { BootstrapClient } from '../bootstrap/BootstrapClient.js';
import { DHTNodeId } from './DHTNodeId.js';
import { InvitationToken } from './InvitationToken.js';

/**
 * Abstract base class for DHT clients
 */
export class DHTClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      bootstrapServers: options.bootstrapServers || ['ws://localhost:8080'],
      k: options.k || 20,
      alpha: options.alpha || 3,
      replicateK: options.replicateK || 3,
      timeout: options.timeout || 30000,
      maxConnections: options.maxConnections || 50,
      ...options
    };

    // Generate node ID (subclasses can override this)
    this.nodeId = this.generateNodeId();
    
    this.dht = null;
    this.bootstrap = null;
    this.isStarted = false;

    console.log(`🌐 ${this.constructor.name} initializing`);
    console.log(`   Node ID: ${this.nodeId.toString().substring(0, 16)}...`);
    console.log(`   Node Type: ${this.getNodeType()}`);
  }

  /**
   * Generate node ID - can be overridden by subclasses
   */
  generateNodeId() {
    const seed = new Uint8Array(20);
    crypto.getRandomValues(seed);
    return new DHTNodeId(seed);
  }

  /**
   * Get node type - must be implemented by subclasses
   */
  getNodeType() {
    throw new Error('getNodeType() must be implemented by subclass');
  }

  /**
   * Get DHT options - can be overridden by subclasses for special configurations
   */
  getDHTOptions() {
    return {
      nodeId: this.nodeId,
      bootstrap: this.bootstrap,
      k: this.options.k,
      alpha: this.options.alpha,
      replicateK: this.options.replicateK,
      timeout: this.options.timeout,
      maxConnections: this.options.maxConnections
    };
  }

  /**
   * Get bootstrap metadata - can be overridden by subclasses
   */
  getBootstrapMetadata() {
    return {
      nodeType: this.getNodeType(),
      capabilities: this.getCapabilities(),
      canAcceptConnections: this.canAcceptConnections(),
      canInitiateConnections: this.canInitiateConnections()
    };
  }

  /**
   * Get node capabilities - must be implemented by subclasses
   */
  getCapabilities() {
    throw new Error('getCapabilities() must be implemented by subclass');
  }

  /**
   * Can this node accept incoming connections - must be implemented by subclasses
   */
  canAcceptConnections() {
    throw new Error('canAcceptConnections() must be implemented by subclass');
  }

  /**
   * Can this node initiate connections - must be implemented by subclasses
   */
  canInitiateConnections() {
    throw new Error('canInitiateConnections() must be implemented by subclass');
  }

  /**
   * Create bootstrap client - can be overridden by subclasses (e.g., PassiveBridgeNode)
   */
  createBootstrapClient() {
    return new BootstrapClient({
      bootstrapServers: this.options.bootstrapServers,
      timeout: 15000
    });
  }

  /**
   * Start the DHT client
   */
  async start() {
    if (this.isStarted) {
      throw new Error('DHT client already started');
    }

    console.log(`🚀 Starting ${this.constructor.name}...`);

    // Create bootstrap client (subclasses can override)
    this.bootstrap = this.createBootstrapClient();

    // Create DHT with connection-agnostic configuration
    // DHT will create its own connection managers using the factory
    this.dht = new KademliaDHT(this.getDHTOptions());

    // Set up bootstrap metadata for registration
    if (this.bootstrap) {
      this.dht.bootstrapMetadata = this.getBootstrapMetadata();
      console.log('📡 Prepared bootstrap metadata for registration');
    }

    // Start the DHT
    await this.dht.start();

    this.isStarted = true;
    console.log(`✅ ${this.constructor.name} started successfully`);

    return {
      nodeId: this.nodeId.toString(),
      nodeType: this.getNodeType(),
      capabilities: this.getCapabilities()
    };
  }

  /**
   * Stop the DHT client
   */
  async stop() {
    if (!this.isStarted) {
      return;
    }

    console.log(`🛑 Stopping ${this.constructor.name}...`);

    if (this.dht) {
      await this.dht.stop();
      this.dht = null;
    }

    if (this.bootstrap) {
      await this.bootstrap.destroy();
      this.bootstrap = null;
    }

    this.isStarted = false;
    console.log(`✅ ${this.constructor.name} stopped`);
  }

  /**
   * Get connection statistics
   */
  getStats() {
    if (!this.dht) {
      return { error: 'DHT not started' };
    }

    return {
      nodeId: this.nodeId.toString(),
      nodeType: this.getNodeType(),
      isStarted: this.isStarted,
      dhtStats: this.dht.getStats()
    };
  }

  /**
   * Create invitation token for new peer
   */
  async createInvitationToken(targetNodeId, expiration = 30 * 60 * 1000) {
    if (!this.dht) {
      throw new Error('DHT not started');
    }

    return await this.dht.createInvitationToken(targetNodeId, expiration);
  }

  /**
   * Send invitation to new peer
   */
  async inviteNewClient(clientId) {
    if (!this.dht) {
      throw new Error('DHT not started');
    }

    return await this.dht.inviteNewClient(clientId);
  }

  /**
   * Get connected peers
   */
  getConnectedPeers() {
    if (!this.dht) {
      return [];
    }

    return this.dht.getConnectedPeers();
  }

  /**
   * Store data in DHT
   */
  async store(key, value) {
    if (!this.dht) {
      throw new Error('DHT not started');
    }

    return await this.dht.store(key, value);
  }

  /**
   * Retrieve data from DHT
   */
  async get(key) {
    if (!this.dht) {
      throw new Error('DHT not started');
    }

    return await this.dht.get(key);
  }
}