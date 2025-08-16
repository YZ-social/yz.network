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
import { KademliaDHT } from '../dht/KademliaDHT.js';
import { BootstrapClient } from '../bootstrap/BootstrapClient.js';
import { WebSocketManager } from '../network/WebSocketManager.js';
import { DHTNodeId } from '../core/DHTNodeId.js';
import { InvitationToken } from '../core/InvitationToken.js';

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
export class NodeDHTClient {
  constructor(options = {}) {
    this.options = {
      bootstrapServers: options.bootstrapServers || ['ws://localhost:8080'],
      port: options.port || 0, // 0 = random available port
      k: options.k || 20,
      alpha: options.alpha || 3,
      replicateK: options.replicateK || 3,
      ...options
    };

    // Generate unique node ID using GUID + SHA1
    const guid = randomUUID();
    console.log(`🆔 Generated GUID: ${guid}`);
    
    const guidBytes = new TextEncoder().encode(guid);
    const seedArray = new Uint8Array(20);
    const hash = createHash('sha1').update(guidBytes).digest();
    seedArray.set(hash);
    
    this.nodeId = new DHTNodeId(seedArray);
    this.dht = null;
    this.websocketManager = null;
    this.bootstrap = null;
    this.isStarted = false;

    console.log(`🌐 Node.js DHT Client initializing`);
    console.log(`   Node ID: ${this.nodeId.toString().substring(0, 16)}...`);
    console.log(`   Node Type: websocket`);
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

    // Create WebSocket manager
    this.websocketManager = new WebSocketManager({
      port: this.options.port,
      maxConnections: 50,
      timeout: 30000
    });

    await this.websocketManager.initialize(this.nodeId.toString());

    // Create bootstrap client
    this.bootstrap = new BootstrapClient({
      bootstrapServers: this.options.bootstrapServers,
      timeout: 15000
    });

    // Generate cryptographic keys
    const keyInfo = await InvitationToken.generateKeyPair();
    console.log('🔐 Generated cryptographic key pair for invitation tokens');

    // Create DHT with WebSocket manager
    this.dht = new KademliaDHT({
      nodeId: this.nodeId,
      webrtc: this.websocketManager, // WebSocketManager implements same interface
      bootstrap: this.bootstrap,
      k: this.options.k,
      alpha: this.options.alpha,
      replicateK: this.options.replicateK
    });

    // Set up event handlers
    this.setupEventHandlers();

    // Add node capabilities to DHT metadata
    this.dht.nodeType = 'nodejs';
    this.dht.nodeCapabilities = new Set(['websocket', 'relay']);
    this.dht.canRelay = true; // Node.js nodes can relay between protocols
    this.dht.listeningAddress = this.websocketManager.listeningAddress;

    // Prepare bootstrap metadata with WebSocket information
    this.dht.bootstrapMetadata = {
      nodeType: 'nodejs',
      listeningAddress: this.websocketManager.listeningAddress,
      capabilities: ['websocket', 'relay'],
      canRelay: true
    };
    
    console.log('📡 Prepared WebSocket coordination metadata for bootstrap registration');
    console.log(`   Listening Address: ${this.websocketManager.listeningAddress}`);

    // Start the DHT
    await this.dht.start();

    this.isStarted = true;
    console.log('✅ Node.js DHT client started successfully');
    console.log(`📡 Listening for connections on: ${this.websocketManager.listeningAddress}`);

    return {
      nodeId: this.nodeId.toString(),
      listeningAddress: this.websocketManager.listeningAddress,
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

    this.websocketManager.on('message', ({ peerId, message }) => {
      // Handle DHT overlay connection requests
      if (message.type === 'dht_connection_request') {
        this.handleDHTConnectionRequest(peerId, message);
      } else {
        // Route all other messages to DHT for processing
        console.log(`📨 Routing DHT message from ${peerId.substring(0, 8)}...: ${message.type}`);
        this.dht.enqueueMessage(peerId, message);
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
      await this.websocketManager.sendMessage(fromPeerId, {
        type: 'dht_connection_response',
        success: true,
        listeningAddress: this.websocketManager.listeningAddress,
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
        listeningAddress: this.websocketManager.listeningAddress,
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
    if (!this.websocketManager) return [];
    return this.websocketManager.getConnectedPeers();
  }

  /**
   * Get DHT statistics
   */
  getStats() {
    if (!this.dht || !this.websocketManager) return null;

    return {
      nodeId: this.nodeId.toString(),
      nodeType: 'nodejs',
      listeningAddress: this.websocketManager.listeningAddress,
      connections: this.websocketManager.getStats(),
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

    if (this.websocketManager) {
      this.websocketManager.destroy();
    }

    if (this.bootstrap) {
      this.bootstrap.destroy();
    }

    this.isStarted = false;
    console.log('✅ Node.js DHT client stopped');
  }
}