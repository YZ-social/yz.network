/**
 * Node.js DHT Client - WebSocket-based DHT node for Node.js environments
 *
 * This client can join the same DHT network as browser clients, using:
 * - WebSocket connections instead of WebRTC
 * - Same DHT protocol and invitation system
 * - Same cryptographic security model
 * - DHT overlay messaging for connection coordination
 */

// Node.js imports
import { randomBytes, createHash, randomUUID } from 'crypto';
import WebSocket from 'ws';

// DHT imports
import { DHTClient } from '../core/DHTClient.js';
import { ConnectionManagerFactory } from '../network/ConnectionManagerFactory.js';
import { DHTNodeId } from '../core/DHTNodeId.js';
import { InvitationToken } from '../core/InvitationToken.js';
import { KademliaDHT } from '../dht/KademliaDHT.js';
import { BootstrapClient } from '../bootstrap/BootstrapClient.js';

// Setup Node.js crypto globals for browser compatibility
global.window = global.window || {};
global.window.crypto = {
  getRandomValues: (array) => {
    const bytes = randomBytes(array.length);
    array.set(bytes);
    return array;
  },
  subtle: null // Force use of @noble/ed25519 library
};

// WebSocket global
global.WebSocket = WebSocket;

// Basic Event and EventTarget implementation for Node.js
global.Event = class Event {
  constructor(type, options = {}) {
    this.type = type;
    this.bubbles = options.bubbles || false;
    this.cancelable = options.cancelable || false;
  }
};

global.EventTarget = class EventTarget {
  constructor() {
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  removeEventListener(type, listener) {
    if (this.listeners.has(type)) {
      const listeners = this.listeners.get(type);
      const index = listeners.indexOf(listener);
      if (index > -1) listeners.splice(index, 1);
    }
  }
  dispatchEvent(event) {
    if (this.listeners.has(event.type)) {
      for (const listener of this.listeners.get(event.type)) {
        listener(event);
      }
    }
  }
};

/**
 * Node.js DHT Client using WebSocket connections
 */
export class NodeDHTClient extends DHTClient {
  constructor(options = {}) {
    super({
      port: options.port || 0, // 0 = random available port
      ...options
    });

    // Node.js specific properties
    this.connectionManager = null;
  }

  /**
   * Override node ID generation to use GUID + SHA1 for Node.js
   */
  generateNodeId() {
    const guid = randomUUID();
    console.log(`🆔 Generated GUID: ${guid}`);

    const guidBytes = new TextEncoder().encode(guid);
    const seedArray = new Uint8Array(20);
    const hash = createHash('sha1').update(guidBytes).digest();
    seedArray.set(hash);

    return new DHTNodeId(seedArray);
  }

  getNodeType() {
    return 'nodejs';
  }

  getCapabilities() {
    return ['websocket', 'relay'];
  }

  canAcceptConnections() {
    return true;
  }

  canInitiateConnections() {
    return true;
  }

  /**
   * Override bootstrap metadata to include WebSocket listening addresses
   */
  getBootstrapMetadata() {
    return {
      nodeType: 'nodejs',
      listeningAddress: this.connectionManager?.getServerAddress?.(),  // Internal Docker address
      publicWssAddress: this.options.publicWssAddress,                 // External browser WSS address
      capabilities: ['websocket', 'relay'],
      canRelay: true,
      canAcceptConnections: true,
      canInitiateConnections: true
    };
  }

  /**
   * Setup cryptography for Node.js environment
   */
  async setupCrypto() {
    try {
      // Verify crypto globals are available
      const testArray = new Uint8Array(32);
      window.crypto.getRandomValues(testArray);
      console.log('✅ Verified crypto.getRandomValues is working');

      const ed25519Module = await import('@noble/ed25519');
      const ed25519 = ed25519Module.ed25519 || ed25519Module;

      // Set up SHA512 hash function for Node.js
      if (ed25519.etc && !ed25519.etc.sha512Sync) {
        ed25519.etc.sha512Sync = (...m) => createHash('sha512').update(Buffer.concat(m)).digest();
      }

      // Configure noble ed25519 utils
      if (ed25519.utils) {
        ed25519.utils.randomBytes = (length) => {
          const array = new Uint8Array(length);
          return global.window.crypto.getRandomValues(array);
        };
      }

      // Set global crypto for the noble library (avoid read-only property)
      if (typeof globalThis !== 'undefined' && !globalThis.crypto) {
        try {
          Object.defineProperty(globalThis, 'crypto', {
            value: global.window.crypto,
            writable: true,
            configurable: true
          });
        } catch (error) {
          // globalThis.crypto might be read-only, that's okay
          console.log('ℹ️ globalThis.crypto is read-only, using global.window.crypto');
        }
      }

      console.log('✅ Configured ed25519 for Node.js');
    } catch (error) {
      console.error('❌ Failed to configure ed25519:', error.message);
      throw error;
    }
  }

  /**
   * Start the DHT client
   */
  async start() {
    if (this.isStarted) {
      throw new Error('DHT client already started');
    }

    console.log('🚀 Starting Node.js DHT client...');

    // Setup crypto first
    await this.setupCrypto();

    // Create WebSocket connection manager using factory
    // NodeDHTClient is a Node.js server that accepts connections from both browsers and other Node.js clients
    this.connectionManager = ConnectionManagerFactory.createForConnection('nodejs', 'browser', {
      port: this.options.port || 0,
      host: '0.0.0.0',  // Bind to all interfaces for Docker/production environments
      maxConnections: this.options.maxConnections || 50,
      timeout: this.options.timeout || 30000,
      enableServer: true,
      localNodeType: 'nodejs',
      targetNodeType: 'browser'
    });

    // Set the local node ID on the connection manager
    this.connectionManager.localNodeId = this.nodeId.toString();

    // Wait for server to start and get actual address
    await new Promise((resolve) => {
      if (this.connectionManager.server) {
        resolve();
      } else {
        this.connectionManager.once('serverStarted', resolve);
      }
    });

    // Small delay to ensure server.address() is available
    await new Promise(resolve => setTimeout(resolve, 100));

    // Create bootstrap client (allows subclasses like PassiveBridgeNode to override with mock)
    this.bootstrap = this.createBootstrapClient();

    // Generate cryptographic keys
    const keyInfo = await InvitationToken.generateKeyPair();
    console.log('🔐 Generated cryptographic key pair for invitation tokens');

    // Create DHT with WebSocket connection manager and bootstrap metadata
    this.dht = new KademliaDHT({
      nodeId: this.nodeId,
      serverConnectionManager: this.connectionManager, // CRITICAL: Node.js servers pass as serverConnectionManager so DHT reuses it for all peers
      bootstrap: this.bootstrap,
      bootstrapMetadata: this.getBootstrapMetadata(), // Include Node.js metadata (nodeType, listeningAddress, etc.)
      k: this.options.k,
      alpha: this.options.alpha,
      replicateK: this.options.replicateK
    });

    // Set up event handlers
    this.setupEventHandlers();

    // CRITICAL: Get actual listening address after server is fully started
    const serverBindAddress = this.connectionManager.getServerAddress();
    if (!serverBindAddress) {
      throw new Error('WebSocket server did not provide listening address');
    }

    // Use configured publicAddress for internal connections (Docker container names),
    // otherwise fall back to bind address (0.0.0.0) - NOT ideal but works for local
    // Internal nodes should use container names like ws://genesis-node:8085, not ws://0.0.0.0:8085
    const actualListeningAddress = this.options.publicAddress || serverBindAddress;

    // Add node capabilities to DHT metadata
    this.dht.nodeType = 'nodejs';
    this.dht.nodeCapabilities = new Set(['websocket', 'relay']);
    this.dht.canRelay = true; // Node.js nodes can relay between protocols
    this.dht.listeningAddress = actualListeningAddress;

    // Prepare bootstrap metadata with WebSocket information
    // Call getBootstrapMetadata() to allow subclasses (like PassiveBridgeNode) to override
    this.dht.bootstrapMetadata = this.getBootstrapMetadata();

    console.log('📡 Prepared WebSocket coordination metadata for bootstrap registration');
    console.log(`   Internal Address: ${actualListeningAddress} (bind: ${serverBindAddress})`);
    if (this.options.publicWssAddress) {
      console.log(`   Public WSS Address: ${this.options.publicWssAddress}`);
    }

    // Start the DHT
    await this.dht.start();

    this.isStarted = true;
    console.log('✅ Node.js DHT client started successfully');
    console.log(`📡 Listening for connections on: ${this.connectionManager.getServerAddress()}`);

    return {
      nodeId: this.nodeId.toString(),
      listeningAddress: this.connectionManager.getServerAddress(),
      nodeType: 'nodejs'
    };
  }

  /**
   * Set up event handlers
   */
  setupEventHandlers() {
    this.dht.on('peerConnected', (peerId) => {
      console.log(`🤝 Connected to peer: ${peerId.substring(0, 8)}...`);
    });

    this.dht.on('peerDisconnected', (peerId) => {
      console.log(`👋 Disconnected from peer: ${peerId.substring(0, 8)}...`);
    });

    // ConnectionManager emits 'data' events with message payload
    this.connectionManager.on('data', ({ peerId, data }) => {
      // Handle DHT overlay connection requests
      if (data.type === 'dht_connection_request') {
        this.handleDHTConnectionRequest(peerId, data);
      } else {
        // Route all other messages to DHT for processing
        console.log(`📨 Routing DHT message from ${peerId.substring(0, 8)}...: ${data.type}`);
        this.dht.enqueueMessage(peerId, data);
      }
    });
  }

  /**
   * Handle DHT overlay connection request from browser
   */
  async handleDHTConnectionRequest(fromPeerId, message) {
    console.log(`📞 DHT connection request from browser: ${fromPeerId.substring(0, 8)}...`);

    try {
      // Browser is requesting to connect to our WebSocket server
      // We don't need to do anything - just acknowledge
      await this.connectionManager.sendMessage(fromPeerId, {
        type: 'dht_connection_response',
        success: true,
        listeningAddress: this.connectionManager.getServerAddress(),
        nodeId: this.nodeId.toString(),
        nodeType: 'nodejs',
        capabilities: ['websocket', 'relay']
      });

      console.log(`✅ DHT connection request acknowledged for ${fromPeerId.substring(0, 8)}...`);
    } catch (error) {
      console.error(`❌ Error handling DHT connection request: ${error.message}`);
    }
  }

  /**
   * Request connection to a browser node via DHT overlay
   */
  async requestConnectionToBrowser(browserNodeId) {
    console.log(`📞 Requesting connection to browser: ${browserNodeId.substring(0, 8)}...`);

    try {
      // Send connection request via DHT overlay using new protocol
      await this.dht.sendWebSocketConnectionRequest(browserNodeId, {
        nodeType: 'nodejs',
        listeningAddress: this.connectionManager.getServerAddress(),
        capabilities: ['websocket', 'relay'],
        canRelay: true
      });

      console.log(`📤 WebSocket connection request sent to ${browserNodeId.substring(0, 8)}...`);
      return true;
    } catch (error) {
      console.error(`❌ Failed to request connection to browser: ${error.message}`);
      return false;
    }
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
      nodeType: 'nodejs',
      listeningAddress: this.connectionManager.getServerAddress(),
      connections: {
        active: this.connectionManager.connections.size,
        maxConnections: this.connectionManager.options.maxConnections
      },
      dht: {
        routingTableSize: this.dht.routingTable?.getAllNodes()?.length || 0,
        connectedPeers: this.getConnectedPeers().length
      },
      capabilities: ['websocket', 'relay'],
      canRelay: true
    };
  }

  /**
   * Stop the DHT client
   */
  async stop() {
    if (!this.isStarted) return;

    console.log('🛑 Stopping Node.js DHT client...');

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
    console.log('✅ Node.js DHT client stopped');
  }
}