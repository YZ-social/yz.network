import { EventEmitter } from 'events';
import { DHTNodeId } from '../core/DHTNodeId.js';
import { DHTNode } from '../core/DHTNode.js';
import { RoutingTable } from './RoutingTable.js';
import { BootstrapClient } from '../bootstrap/BootstrapClient.js';
import { InvitationToken } from '../core/InvitationToken.js';
import { ConnectionManagerFactory } from '../network/ConnectionManagerFactory.js';
import { OverlayNetwork } from '../network/OverlayNetwork.js';
import Logger from '../utils/Logger.js';

/**
 * Main Kademlia DHT implementation with connection-agnostic transport
 */
export class KademliaDHT extends EventEmitter {
  constructor(options = {}) {
    super();

    // Track DHT instance creation
    const instanceId = Math.random().toString(36).substr(2, 9);
    this.instanceId = instanceId;

    // Create logger instance
    this.logger = new Logger('DHT');

    this.options = {
      k: options.k || 20, // Kademlia k parameter
      alpha: options.alpha || 3, // Parallelism parameter
      replicateK: options.replicateK || 20, // Replication factor (Kademlia-compliant: replicate to k closest nodes)
      refreshInterval: options.refreshInterval || 60 * 1000, // Base interval - will be adaptive
      aggressiveRefreshInterval: options.aggressiveRefreshInterval || 15 * 1000, // 15s for new/isolated nodes
      standardRefreshInterval: options.standardRefreshInterval || 600 * 1000, // 10 minutes following IPFS standard
      republishInterval: options.republishInterval || 24 * 60 * 60 * 1000, // 24 hours
      expireInterval: options.expireInterval || 24 * 60 * 60 * 1000, // 24 hours
      pingInterval: options.pingInterval || 60 * 1000, // 1 minute (dev-friendly)
      bootstrapServers: options.bootstrapServers || ['ws://localhost:8080'],
      ...options
    };

    // Server connection manager for bridge/server nodes (reuse existing server)
    this.serverConnectionManager = options.serverConnectionManager || null;

    // Generate or use provided node ID
    if (options.nodeId instanceof DHTNodeId) {
      this.localNodeId = options.nodeId;
    } else if (options.nodeId) {
      this.localNodeId = DHTNodeId.fromString(options.nodeId);
    } else {
      this.localNodeId = new DHTNodeId();
    }

    // Core components
    this.routingTable = new RoutingTable(this.localNodeId, this.options.k);

    // Track network formation start time for anti-spam logic
    this.startTime = Date.now();

    // Overlay network will be initialized in start() method after DHT is fully ready
    this.overlayNetwork = null;
    this.overlayOptions = options.overlayOptions || {};

    // Detect platform limits for connection management
    this.platformLimits = this.detectPlatformLimits();

    // Store transport options for ConnectionManagerFactory
    this.transportOptions = {
      maxConnections: options.maxConnections || this.platformLimits.maxConnections,
      timeout: options.timeout || 30000,
      ...options.connectionOptions
    };

    // Strategic connection management
    this.maxBucketConnections = options.maxBucketConnections || this.platformLimits.maxBucketConnections;
    this.priorityBuckets = options.priorityBuckets || this.platformLimits.priorityBuckets;

    this.bootstrap = options.bootstrap || new BootstrapClient({
      bootstrapServers: this.options.bootstrapServers
    });

    // Storage
    this.storage = new Map(); // key -> { value, timestamp, publisher }
    this.republishQueue = new Map(); // key -> republish timestamp

    // Request tracking
    this.pendingRequests = new Map(); // requestId -> { resolve, reject, timeout }
    this.requestId = 0;

    // Invitation tracking to prevent duplicates
    this.pendingInvitations = new Set();

    // Message Queue System for DHT-based peer signaling
    this.messageQueue = new Map(); // peerId -> Array<{ message, timestamp }>
    this.messageProcessingFlags = new Map(); // peerId -> boolean (to prevent concurrent processing)
    this.maxQueueSize = 100; // Prevent memory leaks
    this.messageTimeout = 30000; // 30 seconds timeout for queued messages

    // State
    this.isStarted = false;
    this.isBootstrapped = false;
    this.useBootstrapForSignaling = true;

    // WebSocket connection request tracking to prevent message loops
    this.pendingWebSocketRequests = new Map(); // Track pending WebSocket connection requests
    this.webSocketRequestTimeout = 30000; // 30 seconds timeout

    // Message deduplication to prevent processing the same message multiple times
    this.processedMessages = new Map(); // Track processed messages by messageId
    this.messageDeduplicationTimeout = 60000; // 60 seconds

    // Failed peer tracking to prevent repeatedly querying disconnected peers
    this.failedPeerQueries = new Map(); // Track peers that consistently fail queries
    this.peerFailureBackoff = new Map(); // Track backoff timers for failed peers

    // Discovery Grace Period - prevent connecting to newly discovered nodes before they're ready
    this.discoveryGracePeriod = 10000; // 10 seconds delay before attempting connections (uses node.lastSeen)

    // Peer connection queue for non-blocking connection attempts
    this.peerConnectionQueue = new Set();
    this.processingConnectionQueue = false;

    // Throttling and rate limiting for reducing excessive find_node traffic
    this.lastBucketRefreshTime = 0; // Track last bucket refresh for throttling
    this.findNodeRateLimit = new Map(); // Rate limit find_node requests per peer
    this.findNodeMinInterval = 10000; // Minimum 10 seconds between find_node to same peer

    // Sleep/Wake memory protection - global message processing limiter
    this.globalMessageCount = 0;
    this.globalMessageLimit = 10000; // Maximum messages per session before emergency throttling
    this.emergencyThrottleActive = false;
    this.lastSystemTime = Date.now(); // Track for sleep/wake detection
    this.sleepWakeThreshold = 60000; // If system time jumps >60s, assume sleep/wake

    // Proper Kademlia bucket staleness tracking
    this.bucketLastActivity = new Map(); // bucketIndex -> last lookup timestamp
    this.refreshTimer = null; // Dynamic refresh timer
    this.currentRefreshInterval = this.options.aggressiveRefreshInterval; // Start aggressive

    // Invitation Token System - Chain of Trust
    this.keyPair = null; // Will be generated on start
    this._membershipToken = null; // Proves this node is part of DHT (private)
    this._isGenesisPeer = false; // Will be set by bootstrap server for first node (private)

    // Remove all legacy insecure genesis methods
    if (options.isGenesisPeer || options.genesisSecret) {
      console.warn('⚠️ Legacy genesis options ignored - use bootstrap server -createNewDHT flag');
    }

    this.setupEventHandlers();
  }

  /**
   * Detect platform-specific connection limits
   * Mobile browsers: ~20-30 WebRTC connections stable
   * Desktop browsers: ~50-100 WebRTC connections stable
   * Node.js servers: ~200+ WebSocket connections stable
   */
  detectPlatformLimits() {
    // Check if we're in Node.js environment
    const isNodeJS = typeof window === 'undefined' && typeof process !== 'undefined' && process.versions?.node;

    if (isNodeJS) {
      // Node.js server - can handle many connections
      return {
        maxConnections: 200,
        maxBucketConnections: 5,  // 5 peers per bucket for redundancy
        priorityBuckets: 20       // Maintain ~20 diverse buckets
      };
    }

    // Browser environment - check if mobile
    const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent);

    if (isMobile) {
      // Mobile browser - conservative limits
      console.log('📱 Mobile platform detected - using conservative connection limits');
      return {
        maxConnections: 20,
        maxBucketConnections: 2,  // 2 peers per bucket
        priorityBuckets: 8        // Maintain ~8-10 diverse buckets
      };
    }

    // Desktop browser - standard limits
    console.log('💻 Desktop platform detected - using standard connection limits');
    return {
      maxConnections: 50,
      maxBucketConnections: 3,  // 3 peers per bucket
      priorityBuckets: 12       // Maintain ~12-15 diverse buckets
    };
  }

  /**
   * Secure getter for genesis peer status (read-only)
   */
  get isGenesisPeer() {
    return this._isGenesisPeer;
  }

  /**
   * Secure getter for membership token (read-only)
   */
  get membershipToken() {
    return this._membershipToken;
  }

  /**
   * INTERNAL: Set genesis peer status (only called by bootstrap server response)
   */
  _setGenesisPeer(isGenesis) {
    if (this.isStarted) {
      console.error('🚨 SECURITY: Cannot change genesis status after DHT started');
      return false;
    }

    this._isGenesisPeer = isGenesis;
    console.log(`🔐 Genesis peer status set to: ${isGenesis}`);
    return true;
  }

  /**
   * INTERNAL: Set membership token (only called during legitimate token creation)
   */
  _setMembershipToken(token) {
    if (this._membershipToken && !this._isGenesisPeer) {
      console.error('🚨 SECURITY: Cannot overwrite existing membership token');
      return false;
    }

    this._membershipToken = token;

    // CRITICAL FIX: Store membership token in connection manager metadata
    // so it's included in WebRTC handshakes and find_node responses
    ConnectionManagerFactory.setPeerMetadata(this.localNodeId.toString(), {
      membershipToken: token
    });

    console.log('🎫 Membership token set and added to connection manager metadata');
    return true;
  }

  /**
   * PUBLIC: Set membership token (wrapper for bridge connections and legitimate token updates)
   */
  setMembershipToken(token) {
    if (!token) {
      console.warn('⚠️ Cannot set empty membership token');
      return false;
    }

    console.log('🎫 Setting membership token from external source (bridge/bootstrap)');
    return this._setMembershipToken(token);
  }

  /**
   * Setup event handlers for components
   */
  setupEventHandlers() {
    this.setupBootstrapEventHandlers();
  }

  /**
   * Set up routing table to receive connection manager events
   */
  setupRoutingTableEventHandlers() {
    console.log('🔗 Setting up routing table connection event handlers...');

    // Set up callback for routing table to notify DHT
    this.routingTable.onNodeAdded = (eventType, data) => {
      if (eventType === 'nodeAdded') {
        console.log(`📋 RoutingTable notified DHT: node ${data.peerId.substring(0, 8)} added`);
        this.handlePeerConnected(data.peerId);
      } else if (eventType === 'disconnect') {
        console.log(`📋 RoutingTable notified DHT: node ${data.peerId.substring(0, 8)} disconnected`);
        this.handlePeerDisconnected(data.peerId);
      }
    };

    // CRITICAL FIX: Set up WebRTC signal routing callback for RoutingTable
    // This will be attached to each WebRTCConnectionManager when nodes are created
    this.routingTable.webrtcSignalHandler = ({ peerId, signal }) => {
      console.log(`📡 Routing WebRTC ${signal.type} signal for ${peerId.substring(0, 8)}... through OverlayNetwork`);

      if (this.overlayNetwork) {
        this.overlayNetwork.handleOutgoingSignal(peerId, signal);
      } else {
        console.error(`❌ Cannot route signal - OverlayNetwork not initialized`);
      }
    };

    // Set up event handler that will be used for all connection managers
    this.connectionManagerEventHandler = ({ peerId, connection, manager, initiator }) => {
      console.log(`🔗 DHT received peerConnected: ${peerId.substring(0, 8)}... (via ${manager?.constructor.name})`);

      // Skip DHT operations for bootstrap server connections
      // Bootstrap connections have IDs like "bootstrap_1234567890" which aren't valid DHT node IDs
      if (peerId.startsWith('bootstrap_')) {
        console.log(`🔗 Bootstrap server connection detected - skipping DHT operations for ${peerId.substring(0, 16)}...`);
        return;
      }

      // Validate that peerId is a valid 40-character hex DHT node ID
      if (!peerId || peerId.length !== 40 || !/^[0-9a-f]{40}$/i.test(peerId)) {
        console.warn(`⚠️ Invalid DHT node ID format: ${peerId} - skipping DHT operations`);
        return;
      }

      // CRITICAL: Update lastSeen timestamp to prevent stale node removal during reconnection
      const peerNode = this.routingTable.getNode(peerId);
      if (peerNode) {
        peerNode.updateLastSeen();
        console.log(`🕐 Updated lastSeen for reconnected peer ${peerId.substring(0, 8)}...`);
      }

      // Clean up pending invitations when connection succeeds
      if (this.pendingInvitations.has(peerId)) {
        this.pendingInvitations.delete(peerId);
        console.log(`📝 Removed ${peerId.substring(0, 8)}... from pending invitations (connection established)`);
      }

      // Delegate to routing table to create and manage the node
      this.routingTable.handlePeerConnected(peerId, connection, manager);
    };

    // CRITICAL: Attach event handler to server connection manager immediately
    // This ensures incoming connections trigger the handler BEFORE any messages arrive
    if (this.serverConnectionManager && !this.serverEventHandlerAttached) {
      console.log('🔗 Attaching peerConnected event handler to server connection manager');
      this.serverConnectionManager.on('peerConnected', this.connectionManagerEventHandler);
      this.serverEventHandlerAttached = true;
    }

    console.log('✅ Routing table event handlers configured');
  }


  /**
   * Setup bootstrap client event handlers
   */
  setupBootstrapEventHandlers() {
    // Bootstrap events
    this.bootstrap.on('signal', ({ fromPeer, signal }) => {
      this.handleIncomingSignal(fromPeer, signal);
    });

    this.bootstrap.on('peerList', (peers) => {
      this.handleBootstrapPeers(peers);
    });

    this.bootstrap.on('invitationReceived', (invitationMessage) => {
      this.handleInvitationReceived(invitationMessage);
    });

    this.bootstrap.on('webrtcStartOffer', (message) => {
      this.handleWebRTCStartOffer(message);
    });

    this.bootstrap.on('webrtcExpectOffer', (message) => {
      this.handleWebRTCExpectOffer(message);
    });

    this.bootstrap.on('websocketPeerMetadata', (message) => {
      this.handleWebSocketPeerMetadata(message);
    });

    this.bootstrap.on('bridgeInvitationRequest', (requestMessage) => {
      this.handleBridgeInvitationRequest(requestMessage);
    });

    // CRITICAL: Handle bridge nodes received from bootstrap response (consolidated approach)
    this.bootstrap.on('bridgeNodesReceived', (data) => {
      this.handleBridgeNodesReceived(data);
    });
  }


  /**
   * Start the DHT
   */
  async start() {
    if (this.isStarted) {
      throw new Error('DHT already started');
    }

    console.log(`Starting Kademlia DHT with node ID: ${this.localNodeId.toString()}`);

    // Generate cryptographic key pair for token system
    if (!this.keyPair) {
      console.log('🔐 Generating cryptographic key pair for invitation tokens');
      this.keyPair = await InvitationToken.generateKeyPair();
      console.log('🔑 Key pair generated successfully:', {
        hasPublicKey: !!this.keyPair.publicKey,
        hasPrivateKey: !!this.keyPair.privateKey,
        hasCryptoKeys: !!this.keyPair.cryptoKeys,
        isNative: this.keyPair.isNative
      });
    }

    // Reset state variables
    this.isBootstrapped = false;
    this.useBootstrapForSignaling = true;

    // Stop any legacy DHT offer polling that might be running
    this.stopDHTOfferPolling();

    // Initialize transport managers through Factory
    console.log('🏗️ Initializing transport managers...');

    // Include bootstrap client reference for WebRTC signaling
    const transportOptionsWithBootstrap = {
      ...this.transportOptions,
      bootstrapClient: this.bootstrap,
      dht: this // Pass DHT reference so connection managers can check signaling mode
    };

    ConnectionManagerFactory.initializeTransports(transportOptionsWithBootstrap);

    // Initialize local node metadata (use bootstrapMetadata if available, fallback to defaults)
    const localMetadata = {
      isBridgeNode: false,
      nodeType: typeof process === 'undefined' ? 'browser' : 'nodejs',
      capabilities: typeof process === 'undefined' ? ['webrtc'] : ['websocket'],
      startTime: Date.now(),
      ...this.bootstrapMetadata  // Override with actual metadata from NodeDHTClient.getBootstrapMetadata()
    };

    console.log(`📋 Registering local node metadata:`, localMetadata);
    ConnectionManagerFactory.setPeerMetadata(this.localNodeId.toString(), localMetadata);

    // Set up routing table to listen to connection manager events
    this.setupRoutingTableEventHandlers();

    // Recreate bootstrap client if it was destroyed
    if (this.bootstrap.isDestroyed) {
      console.log('Recreating destroyed BootstrapClient');
      this.bootstrap = new BootstrapClient({
        bootstrapServers: this.options.bootstrapServers
      });
      this.setupBootstrapEventHandlers();
    }

    // Connect to bootstrap server and register with public key
    await this.bootstrap.connect(this.localNodeId.toString(), {
      publicKey: this.keyPair.publicKey,
      ...this.bootstrapMetadata
    });

    // Check if we're designated as genesis peer by bootstrap server
    // (This will be determined by bootstrap server based on -createNewDHT flag)

    // Request initial peers or genesis status
    const bootstrapResponse = await this.bootstrap.requestPeersOrGenesis(this.options.k);

    if (bootstrapResponse.isGenesis) {
      console.log('🌟 Bootstrap server designated this node as Genesis Peer');
      this._setGenesisPeer(true);
      const genesisToken = await InvitationToken.createGenesisMembershipToken(
        this.localNodeId.toString(),
        this.keyPair
      );
      this._setMembershipToken(genesisToken);
      console.log('🎫 Created genesis membership token');

      // Store our public key in DHT for others to verify our tokens
      await this.storePublicKey();
    }

    const initialPeers = bootstrapResponse.peers || [];
    console.log(`Received ${initialPeers.length} bootstrap peers`);

    // Connect to initial peers (but genesis nodes skip this if no peers available)
    if (initialPeers.length > 0 || !this.isGenesisPeer) {
      await this.connectToInitialPeers(initialPeers);
    } else {
      console.log('🌟 Genesis peer starting with no initial peers - DHT ready for token-based invitations');
      this.isBootstrapped = true; // Genesis peer is considered bootstrapped even without connections
    }

    // Initialize overlay network after DHT is fully ready
    if (!this.overlayNetwork) {
      console.log('🌐 Initializing overlay network for WebRTC signaling...');
      this.overlayNetwork = new OverlayNetwork(this, this.overlayOptions);
      // Note: WebRTC signal routing is set up in setupRoutingTableEventHandlers()
    }

    // Start maintenance tasks
    this.startMaintenanceTasks();

    this.isStarted = true;
    this.emit('started');

    return this;
  }

  /**
   * Connect to initial peers from bootstrap
   */
  async connectToInitialPeers(peers) {
    console.log(`🔍 Connecting to ${peers.length} bootstrap peers`);

    // CRITICAL: Check if we're already connected to DHT
    const connectedPeers = this.getConnectedPeers().length;
    const isDHTConnected = connectedPeers > 0;

    const connectionPromises = [];

    for (const peer of peers.slice(0, this.options.k)) {
      try {
        if (!this.isValidDHTPeer(peer.nodeId)) {
          continue;
        }

        // Store peer metadata if available (for WebSocket connections)
        // This must happen REGARDLESS of connection attempts for future use
        // Store peer information in routing table for future use
        if (peer.metadata) {
          // CRITICAL: Use getOrCreatePeerNode to ensure proper ID handling (no double-hashing)
          const peerNode = this.getOrCreatePeerNode(peer.nodeId, peer.metadata);
          console.log(`📋 Stored bootstrap peer metadata for ${peer.nodeId.substring(0, 8)}...:`, peer.metadata);
        }

        // Only connect to bootstrap peers if not already DHT-connected
        if (isDHTConnected) {
          continue;
        }

        // Check if this is a bridge node - they connect via dedicated bridgeNodesReceived handler
        if (peer.metadata?.isBridgeNode) {
          console.log(`🌉 Bridge node ${peer.nodeId.substring(0, 8)}... - will connect via bridgeNodesReceived handler`);
          // Skip connecting here - bridge nodes use dedicated connection path
        } else {
          // Regular peers: Just add to routing table, k-bucket maintenance will connect later
          console.log(`📋 Added peer ${peer.nodeId.substring(0, 8)}... to routing table (k-bucket maintenance will connect)`);
          // Peer metadata already stored above via getOrCreatePeerNode
        }
      } catch (error) {
        console.warn(`Failed to initiate connection to ${peer.nodeId}:`, error);
      }
    }

    // Check if we have peers in routing table (even if not connected yet)
    const routingTableSize = this.routingTable.getAllNodes().length;

    if (connectionPromises.length > 0) {
      // We have connection attempts (e.g., to bridge nodes)
      try {
        await Promise.race(connectionPromises);
        console.log('✅ Connected to initial peers');
        this.isBootstrapped = true;

        // Give connections more time to establish before considering DHT signaling
        setTimeout(() => {
          const actualConnections = this.getConnectedPeers().length;
          const routingEntries = this.routingTable.getAllNodes().length;

          if (actualConnections < routingEntries) {
            this.cleanupRoutingTable();
          }

          this.considerDHTSignaling();
        }, 5000); // 5 seconds delay - check DHT signaling readiness

      } catch (error) {
        console.warn('Failed to connect to any bootstrap peers:', error);
      }
    } else if (routingTableSize > 0) {
      // No immediate connections, but we have peers in routing table for k-bucket maintenance
      console.log(`📋 ${routingTableSize} peers added to routing table (k-bucket maintenance will establish connections)`);
      this.isBootstrapped = true;

      // Trigger k-bucket maintenance to connect to peers
      setTimeout(async () => {
        console.log('🔧 Triggering k-bucket maintenance for peer connections...');
        await this.refreshStaleBuckets();
        // CRITICAL: Also connect to discovered peers (refreshStaleBuckets only does discovery)
        await this.connectToRecentlyDiscoveredPeers();
      }, 1000); // Short delay to let routing table settle
    } else {
      console.warn('No peers available for bootstrap');
    }
  }

  /**
   * Handle peers received from bootstrap server
   */
  handleBootstrapPeers(peers) {
    console.log(`Received ${peers.length} peers from bootstrap server`);

    if (peers.length === 0) {
      console.log('No peers available from bootstrap server');
      return;
    }

    // Check if we're already connected to DHT
    const connectedPeers = this.getConnectedPeers().length;
    const isDHTConnected = connectedPeers > 0;

    if (isDHTConnected) {
      // We're a DHT-connected node - don't automatically offer connections
      // This would create bootstrap server dependency for all DHT nodes
      console.log(`🌐 DHT-connected node: Ignoring bootstrap peer list (${peers.length} peers)`);
      console.log(`💡 Use inviteNewClient(clientId) for out-of-band invitations`);
      return;
    } else if (this.isGenesisPeer) {
      // Genesis peer should connect to bridge nodes but not regular peers
      const bridgeNodes = peers.filter(peer => peer.metadata?.isBridgeNode);
      if (bridgeNodes.length > 0) {
        console.log(`🌟 Genesis peer: Connecting to ${bridgeNodes.length} bridge nodes to remove genesis status`);
        this.connectToInitialPeers(bridgeNodes).catch(error => {
          console.error('Failed to connect genesis to bridge nodes:', error);
        });
        return;
      } else {
        console.log(`🌟 Genesis peer: No bridge nodes available - use explicit invitations`);
        console.log(`💡 Use inviteNewClient(clientId) to invite specific peers`);
        return;
      }
    } else {
      // We're still bootstrap-only - store peer information but do not auto-connect
      console.log(`📋 Bootstrap-only node: Found ${peers.length} peers - waiting for explicit invitations`);
      console.log(`💡 Use inviteNewClient(clientId) to explicitly invite peers`);

      // Store peer metadata for future invitations, but do not auto-connect
      this.connectToInitialPeers(peers).catch(error => {
        console.debug('Peer metadata storage completed:', error);
      });
    }
  }

  /**
   * REMOVED: Legacy insecure genesis methods
   * Genesis peer status is now controlled by bootstrap server only
   */
  initializeAsGenesisPeer() {
    console.error('🚨 SECURITY: initializeAsGenesisPeer() removed');
    console.error('🔐 Use bootstrap server with -createNewDHT flag instead');
    throw new Error('Legacy genesis initialization disabled for security');
  }

  verifyGenesisPeer() {
    console.error('🚨 SECURITY: verifyGenesisPeer() removed');
    throw new Error('Legacy genesis verification disabled for security');
  }

  async forceConnectToPeer() {
    console.error('🚨 SECURITY: forceConnectToPeer() removed');
    throw new Error('Legacy force connection disabled for security');
  }

  /**
   * Store our public key in the DHT for token verification
   */
  async storePublicKey() {
    if (!this.keyPair) {
      throw new Error('No key pair available');
    }

    const publicKeyStorageKey = InvitationToken.getPublicKeyStorageKey(this.localNodeId.toString());
    console.log(`🔑 Storing public key in DHT: ${publicKeyStorageKey}`);

    try {
      await this.store(publicKeyStorageKey, {
        nodeId: this.localNodeId.toString(),
        publicKey: this.keyPair.publicKey,
        timestamp: Date.now()
      });
      console.log('✅ Public key stored in DHT');
    } catch (error) {
      console.error('❌ Failed to store public key in DHT:', error);
    }
  }

  /**
   * Retrieve a node's public key from the DHT
   */
  async getPublicKey(nodeId) {
    const publicKeyStorageKey = InvitationToken.getPublicKeyStorageKey(nodeId);
    try {
      const keyData = await this.get(publicKeyStorageKey);
      return keyData ? keyData.publicKey : null;
    } catch (error) {
      console.error(`Failed to retrieve public key for ${nodeId}:`, error);
      return null;
    }
  }

  /**
   * Create an invitation token for a new client
   */
  async createInvitationToken(inviteeNodeId, expiresInMs = 24 * 60 * 60 * 1000) {
    if (!this._membershipToken) {
      throw new Error('Cannot create invitation token - no membership token available');
    }

    if (!this.keyPair) {
      throw new Error('Cannot create invitation token - no key pair available');
    }

    console.log(`🎫 Creating invitation token for: ${inviteeNodeId}`);

    const token = await InvitationToken.createInvitationToken(
      this.localNodeId.toString(),
      this.keyPair,
      inviteeNodeId,
      expiresInMs
    );

    console.log(`✅ Created invitation token (expires: ${new Date(token.expires).toISOString()})`);
    return token;
  }

  /**
   * Validate an invitation token (called by bootstrap server)
   */
  async validateInvitationToken(token) {
    console.log(`🔍 Validating invitation token from ${token.inviter} for ${token.invitee}`);

    try {
      // Verify we are the claimed inviter
      if (token.inviter !== this.localNodeId.toString()) {
        return { valid: false, error: 'Token inviter does not match this node' };
      }

      // Verify token signature with our key pair
      const verification = await InvitationToken.verifyToken(token, this.keyPair.publicKey);
      if (!verification.valid) {
        return verification;
      }

      // Check if token was already consumed
      const consumedKey = InvitationToken.getConsumedTokenKey(token.nonce);
      const isConsumed = await this.get(consumedKey);

      if (isConsumed) {
        return { valid: false, error: 'Token already consumed' };
      }

      // Mark token as consumed in DHT
      await this.store(consumedKey, {
        inviter: token.inviter,
        invitee: token.invitee,
        consumedAt: Date.now()
      });

      console.log(`✅ Token validated and marked as consumed`);
      return { valid: true };

    } catch (error) {
      console.error('❌ Token validation failed:', error);
      return { valid: false, error: `Validation error: ${error.message}` };
    }
  }

  /**
   * Validate a membership token from a peer
   * @param {Object} membershipToken - The membership token to validate
   * @returns {Object} - {valid: boolean, reason?: string}
   */
  async validateMembershipToken(membershipToken) {
    try {
      // Basic structure validation
      if (!membershipToken || typeof membershipToken !== 'object') {
        return { valid: false, reason: 'Invalid token structure' };
      }

      if (!membershipToken.holder || !membershipToken.issuer || !membershipToken.signature) {
        return { valid: false, reason: 'Missing required token fields' };
      }

      // Get issuer's public key from DHT
      const issuerPublicKeyData = await this.get(`pubkey:${membershipToken.issuer}`);

      if (!issuerPublicKeyData) {
        // If we can't find the public key yet, it might still be propagating
        // Allow the token but log a warning
        console.warn(`⚠️ Could not verify membership token - issuer public key not yet available in DHT`);
        return { valid: true }; // Lenient: allow if key not yet propagated
      }

      // Verify the token signature
      const verification = await InvitationToken.verifyMembershipToken(
        membershipToken,
        issuerPublicKeyData
      );

      if (!verification.valid) {
        return { valid: false, reason: verification.error || 'Signature verification failed' };
      }

      return { valid: true };

    } catch (error) {
      console.error(`❌ Membership token validation error:`, error);
      return { valid: false, reason: `Validation error: ${error.message}` };
    }
  }

  /**
   * Grant membership token to a newly joined peer
   */
  async grantMembershipToken(newPeerNodeId) {
    if (!this._membershipToken) {
      throw new Error('Cannot grant membership - no membership token available');
    }

    if (!this.keyPair) {
      throw new Error('Cannot grant membership - no key pair available');
    }

    console.log(`🎫 Granting membership token to: ${newPeerNodeId}`);

    const membershipToken = await InvitationToken.createMembershipToken(
      newPeerNodeId,
      this.localNodeId.toString(),
      this.keyPair,
      false // Not genesis
    );

    console.log(`✅ Created membership token for ${newPeerNodeId}`);
    return membershipToken;
  }

  /**
   * Invite a specific new client to join the DHT using token-based system
   * This method creates an invitation token and coordinates with bootstrap server
   */
  async inviteNewClient(clientId) {
    console.log(`🎯 Inviting new client to join DHT using token system: ${clientId}`);

    // Check if we have membership token (proves we're part of DHT)
    if (!this._membershipToken) {
      console.warn(`⚠️ Cannot invite ${clientId} - no membership token available`);
      return false;
    }

    // Validate client ID
    if (!this.isValidDHTPeer(clientId)) {
      console.warn(`⚠️ Cannot invite invalid client: ${clientId}`);
      return false;
    }

    // Don't connect to peers we're already connected to
    if (this.isPeerConnected(clientId)) {
      console.log(`🔗 Already connected to ${clientId}`);
      return true;
    }

    // Check if invitation is already in progress to prevent duplicates
    if (this.pendingInvitations.has(clientId)) {
      console.log(`🔄 Invitation to ${clientId} already in progress, skipping duplicate`);
      return false;
    }

    // Mark invitation as in progress
    this.pendingInvitations.add(clientId);
    console.log(`📝 Added ${clientId} to pending invitations`);

    // Set up timeout to clean up pending invitation if connection never succeeds
    setTimeout(() => {
      if (this.pendingInvitations.has(clientId)) {
        this.pendingInvitations.delete(clientId);
        console.log(`📝 Removed ${clientId} from pending invitations (timeout - connection never established)`);
      }
    }, 120000); // 2 minute timeout

    try {
      // Create invitation token for the client
      const invitationToken = await this.createInvitationToken(clientId, 30 * 60 * 1000); // 30 minute expiry

      // Temporarily reconnect to bootstrap if needed for invitation
      await this.ensureBootstrapConnectionForInvitation();

      // Send invitation token to bootstrap server to coordinate connection
      const invitationResult = await this.bootstrap.sendInvitation(clientId, invitationToken);

      if (!invitationResult.success) {
        console.warn(`Bootstrap server rejected invitation for ${clientId}: ${invitationResult.error}`);

        // Remove from pending invitations
        this.pendingInvitations.delete(clientId);
        console.log(`📝 Removed ${clientId} from pending invitations (bootstrap rejected)`);

        return false;
      }

      // Store target peer metadata from bootstrap response for transport selection
      if (invitationResult.data && invitationResult.data.targetPeerMetadata) {
        const targetMetadata = invitationResult.data.targetPeerMetadata;

        // Store metadata in peer node for connection-agnostic access
        const peerNode = this.getOrCreatePeerNode(clientId, targetMetadata);
        console.log(`📋 Stored peer metadata for ${clientId.substring(0, 8)}...:`, targetMetadata);
      }

      // CRITICAL FIX: Temporarily force bootstrap signaling for invitation process
      const wasUsingBootstrapSignaling = this.useBootstrapForSignaling;
      console.log(`🔄 Forcing bootstrap signaling for invitation (was: ${wasUsingBootstrapSignaling})`);
      this.useBootstrapForSignaling = true;

      try {
        // Declare peerNode outside conditional block for scope access
        let peerNode = null;

        // Create connection to the invited peer using the correct transport
        if (invitationResult.data && invitationResult.data.targetPeerMetadata) {
          const targetMetadata = invitationResult.data.targetPeerMetadata;
          console.log(`🔗 Connecting to invited peer using metadata: ${targetMetadata.nodeType}`);

          // Create connection using per-node connection manager
          peerNode = this.getOrCreatePeerNode(clientId, targetMetadata);
          console.log(`🔗 Creating connection to invited peer using ${targetMetadata.nodeType || 'browser'} transport`);

          // Check if connection already exists (race condition handling)
          if (this.isPeerConnected(clientId)) {
            console.log(`🔄 Connection to ${clientId} already exists, using existing connection`);
          } else {
            await peerNode.connectionManager.createConnection(clientId, true, peerNode.metadata);
          }
        } else {
          console.log(`📤 Invitation sent - waiting for peer to connect (no metadata available)`);
        }

        // Wait for WebRTC connection to complete before disconnecting
        // CRITICAL FIX: Don't disconnect until WebRTC connection succeeds or fails
        const waitForConnection = () => {
          const checkInterval = setInterval(() => {
            const isConnected = this.isPeerConnected(clientId);
            const connectionState = peerNode?.connectionManager?.connectionStates?.get(clientId);

            if (isConnected && connectionState === 'connected') {
              console.log(`✅ WebRTC connection established to ${clientId.substring(0, 8)}... - safe to disconnect bootstrap`);
              clearInterval(checkInterval);

              // Restore previous signaling mode
              console.log(`🔄 Restoring signaling mode to: ${wasUsingBootstrapSignaling ? 'bootstrap' : 'DHT'}`);
              this.useBootstrapForSignaling = wasUsingBootstrapSignaling;

              // Disconnect from bootstrap after successful connection
              if (!wasUsingBootstrapSignaling) {
                console.log(`🔌 Disconnecting from bootstrap after successful WebRTC connection`);
                setTimeout(() => {
                  this.bootstrap.disableAutoReconnect();
                  this.bootstrap.disconnect();
                }, 5000); // Short delay to ensure connection is stable
              }
            } else if (connectionState === 'failed' || connectionState === 'disconnected') {
              console.log(`❌ WebRTC connection failed to ${clientId.substring(0, 8)}... - restoring signaling mode`);
              clearInterval(checkInterval);

              // Restore previous signaling mode
              console.log(`🔄 Restoring signaling mode to: ${wasUsingBootstrapSignaling ? 'bootstrap' : 'DHT'}`);
              this.useBootstrapForSignaling = wasUsingBootstrapSignaling;

              // Keep bootstrap connection for potential retry
              if (!wasUsingBootstrapSignaling) {
                console.log(`🔌 Keeping bootstrap connection for potential retry after failed WebRTC`);
                setTimeout(() => {
                  this.bootstrap.disableAutoReconnect();
                  this.bootstrap.disconnect();
                }, 30000); // Wait longer before disconnecting after failure
              }
            }
          }, 2000); // Check every 2 seconds

          // Fallback timeout to prevent infinite waiting
          setTimeout(() => {
            clearInterval(checkInterval);
            console.log(`⏰ WebRTC connection timeout reached - restoring signaling mode`);

            // Restore previous signaling mode
            console.log(`🔄 Restoring signaling mode to: ${wasUsingBootstrapSignaling ? 'bootstrap' : 'DHT'}`);
            this.useBootstrapForSignaling = wasUsingBootstrapSignaling;

            // Disconnect from bootstrap after timeout
            if (!wasUsingBootstrapSignaling) {
              console.log(`🔌 Disconnecting from bootstrap after WebRTC timeout`);
              setTimeout(() => {
                this.bootstrap.disableAutoReconnect();
                this.bootstrap.disconnect();
              }, 10000);
            }
          }, 60000); // 60 second fallback timeout
        };

        waitForConnection();

      } catch (error) {
        // Restore signaling mode even if connection failed
        console.log(`🔄 Restoring signaling mode after error: ${wasUsingBootstrapSignaling ? 'bootstrap' : 'DHT'}`);
        this.useBootstrapForSignaling = wasUsingBootstrapSignaling;
        throw error;
      }

      console.log(`✅ Successfully invited ${clientId} to join DHT with token-based system`);

      // NOTE: Don't remove from pendingInvitations here - cleanup happens when connection succeeds
      // this.pendingInvitations.delete(clientId);
      // console.log(`📝 Removed ${clientId} from pending invitations (success)`);

      return true;

    } catch (error) {
      console.error(`❌ Failed to invite client ${clientId}:`, error);

      // Remove from pending invitations
      this.pendingInvitations.delete(clientId);
      console.log(`📝 Removed ${clientId} from pending invitations (failure)`);

      return false;
    }
  }

  /**
   * Ensure bootstrap connection is available for sending invitations
   */
  async ensureBootstrapConnectionForInvitation() {
    if (this.bootstrap.isBootstrapConnected()) {
      console.log(`📡 Bootstrap already connected for invitation`);
      return;
    }

    console.log(`🔄 Temporarily reconnecting to bootstrap for invitation`);

    // Temporarily enable auto-reconnect for invitation coordination
    this.bootstrap.enableAutoReconnect();

    try {
      await this.bootstrap.connect(this.localNodeId.toString(), {
        publicKey: this.keyPair?.publicKey,
        isNative: this.keyPair?.isNative,
        ...this.bootstrapMetadata
      });

      // CRITICAL FIX: Wait for registration to complete before sending invitation
      console.log(`⏳ Waiting for registration confirmation from bootstrap server...`);
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.bootstrap.removeListener('registered', onRegistered);
          reject(new Error('Registration timeout - bootstrap server did not confirm registration'));
        }, 5000); // 5 second timeout for registration

        const onRegistered = (message) => {
          console.log(`✅ Registration confirmed by bootstrap server`);
          clearTimeout(timeout);
          this.bootstrap.removeListener('registered', onRegistered);
          resolve();
        };

        this.bootstrap.once('registered', onRegistered);
      });

      console.log(`✅ Temporarily reconnected to bootstrap for invitation with registration confirmed`);
    } catch (error) {
      console.error(`❌ Failed to reconnect to bootstrap for invitation:`, error);
      // Disable auto-reconnect again on error
      this.bootstrap.disableAutoReconnect();
      throw error;
    }
  }

  /**
   * Handle received invitation token from bootstrap server
   */
  async handleInvitationReceived(invitationMessage) {
    console.log(`📨 Processing received invitation from ${invitationMessage.fromPeer}`);

    try {
      const { fromPeer, invitationToken } = invitationMessage;

      // First, we need to get the inviter's public key to verify the token
      // In a real implementation, we'd look up the public key from DHT storage
      // For now, we'll trust the invitation if it's structurally valid

      // Basic validation of invitation token structure
      if (!invitationToken || !invitationToken.inviter || !invitationToken.invitee || !invitationToken.signature) {
        console.warn(`⚠️ Invalid invitation token structure from ${fromPeer}`);
        return false;
      }

      // Verify this invitation is actually for us
      if (invitationToken.invitee !== this.localNodeId.toString()) {
        console.warn(`⚠️ Invitation token is for ${invitationToken.invitee}, but we are ${this.localNodeId.toString()}`);
        return false;
      }

      // Check if invitation has expired
      if (Date.now() > invitationToken.expires) {
        console.warn(`⚠️ Invitation token from ${fromPeer} has expired`);
        return false;
      }

      console.log(`✅ Invitation token from ${fromPeer} appears valid`);

      // Mark the invitation token as consumed in DHT storage
      const consumedKey = InvitationToken.getConsumedTokenKey(invitationToken.nonce);
      this.storage.set(consumedKey, {
        consumedAt: Date.now(),
        consumedBy: this.localNodeId.toString(),
        originalInviter: fromPeer
      });

      // Create our membership token (this proves we're now part of the DHT)
      console.log(`🔑 Creating membership token granted by ${fromPeer}`);
      this._membershipToken = await InvitationToken.createMembershipToken(
        this.localNodeId.toString(), // holder
        fromPeer,                    // issuer
        this.keyPair,               // our key for signing future invitations
        false                       // not genesis
      );

      console.log(`✅ Membership token created - we can now invite others to join DHT`);

      // Store our public key in DHT for future verification
      const publicKeyStorageKey = InvitationToken.getPublicKeyStorageKey(this.localNodeId.toString());
      this.storage.set(publicKeyStorageKey, {
        publicKey: this.keyPair.publicKey,
        isNative: this.keyPair.isNative,
        timestamp: Date.now()
      });

      // CRITICAL FIX: Signal back to bootstrap server that we've accepted the invitation
      // Bootstrap server needs to coordinate WebRTC connection between inviter and invitee
      console.log(`📡 Notifying bootstrap server that invitation was accepted`);

      try {
        // Send acceptance notification to bootstrap server
        await this.bootstrap.sendMessage({
          type: 'invitation_accepted',
          fromPeer: this.localNodeId.toString(),
          toPeer: fromPeer,
          timestamp: Date.now()
        });

        console.log(`✅ Bootstrap server notified of invitation acceptance - WebRTC coordination should begin`);
      } catch (error) {
        console.error(`❌ Failed to notify bootstrap server of invitation acceptance:`, error);
        // Don't fail the invitation processing if notification fails
      }

      return true;

    } catch (error) {
      console.error('Error processing invitation:', error);
      return false;
    }
  }

  /**
   * Handle bridge invitation request from bootstrap server
   * Genesis peer should automatically invite the specified bridge node
   */
  async handleBridgeInvitationRequest(requestMessage) {
    console.log(`🌉 Received bridge invitation request for ${requestMessage.targetPeerId?.substring(0, 8)}...`);

    try {
      // Only genesis peers should handle bridge invitations
      if (!this.isGenesisPeer) {
        console.warn(`⚠️ Non-genesis peer received bridge invitation request - ignoring`);
        return false;
      }

      const bridgeNodeId = requestMessage.targetPeerId;
      const bridgeNodeInfo = requestMessage.bridgeNodeInfo;

      if (!bridgeNodeId || !bridgeNodeInfo) {
        console.warn(`⚠️ Invalid bridge invitation request - missing node ID or info`);
        return false;
      }

      console.log(`🎫 Genesis peer inviting bridge node ${bridgeNodeId.substring(0, 8)}...`);

      // Create invitation for bridge node
      const success = await this.inviteNewClient(bridgeNodeId);

      if (success) {
        console.log(`✅ Successfully invited bridge node ${bridgeNodeId.substring(0, 8)}...`);
        return true;
      } else {
        console.error(`❌ Failed to invite bridge node ${bridgeNodeId.substring(0, 8)}...`);
        return false;
      }

    } catch (error) {
      console.error('Error handling bridge invitation request:', error);
      return false;
    }
  }

  /**
   * Handle WebRTC start offer message from bootstrap server
   */
  async handleWebRTCStartOffer(message) {
    const { targetPeer, invitationId } = message;
    console.log(`🚀 Bootstrap server requesting WebRTC offer to ${targetPeer.substring(0, 8)}... (invitation: ${invitationId})`);

    try {
      // Get the peer connection manager
      const peerNode = this.getOrCreatePeerNode(targetPeer, { nodeType: 'browser' });

      if (peerNode && peerNode.connectionManager) {
        // Create WebRTC offer through the connection manager
        console.log(`📤 Creating WebRTC offer for ${targetPeer.substring(0, 8)}...`);
        await peerNode.connectionManager.createConnection(targetPeer, true, peerNode.metadata); // true = initiator
        console.log(`✅ WebRTC offer creation initiated for ${targetPeer.substring(0, 8)}...`);
      } else {
        console.error(`❌ No connection manager available for ${targetPeer.substring(0, 8)}...`);
      }

    } catch (error) {
      console.error(`❌ Failed to create WebRTC offer for ${targetPeer}:`, error);
    }
  }

  /**
   * Handle WebRTC expect offer message from bootstrap server
   */
  async handleWebRTCExpectOffer(message) {
    const { fromPeer, invitationId } = message;
    console.log(`📥 Bootstrap server says to expect WebRTC offer from ${fromPeer.substring(0, 8)}... (invitation: ${invitationId})`);

    try {
      // CRITICAL: Track this peer as having pending WebRTC coordination to prevent interference
      if (!this.pendingWebRTCOffers) {
        this.pendingWebRTCOffers = new Set();
      }
      this.pendingWebRTCOffers.add(fromPeer);
      console.log(`🚫 Blocking emergency discovery for ${fromPeer.substring(0, 8)}... - expecting WebRTC offer`);

      // Auto-cleanup after 60 seconds to prevent permanent blocking
      setTimeout(() => {
        if (this.pendingWebRTCOffers && this.pendingWebRTCOffers.has(fromPeer)) {
          this.pendingWebRTCOffers.delete(fromPeer);
          console.log(`🧹 Cleaned up pending WebRTC offer block for ${fromPeer.substring(0, 8)}...`);
        }
      }, 60000);

      // Prepare to receive WebRTC offer
      const peerNode = this.getOrCreatePeerNode(fromPeer, { nodeType: 'browser' });

      if (peerNode && peerNode.connectionManager) {
        console.log(`⏳ Ready to receive WebRTC offer from ${fromPeer.substring(0, 8)}...`);
        // The connection manager should handle incoming offers automatically
        // No additional setup needed here - just ensuring the peer node exists
      } else {
        console.error(`❌ No connection manager available to receive offer from ${fromPeer.substring(0, 8)}...`);
      }

    } catch (error) {
      console.error(`❌ Failed to prepare for WebRTC offer from ${fromPeer}:`, error);
    }
  }

  /**
   * Handle WebSocket peer metadata from bootstrap server
   * Used for Node.js ↔ Node.js connections where metadata exchange is needed
   */
  async handleWebSocketPeerMetadata(message) {
    const { targetPeer, targetPeerMetadata, fromPeer, fromPeerMetadata, invitationId } = message;

    // This node is the inviter - connect to invitee using WebSocket
    if (targetPeer && targetPeerMetadata) {
      console.log(`🌐 Received WebSocket metadata for ${targetPeer.substring(0, 8)}... - initiating connection`);
      console.log(`   Listening address: ${targetPeerMetadata.listeningAddress}`);
      console.log(`   Node type: ${targetPeerMetadata.nodeType}`);

      try {
        // Create peer node with the received metadata
        const peerNode = this.getOrCreatePeerNode(targetPeer, targetPeerMetadata);

        // Initiate WebSocket connection using Perfect Negotiation
        if (peerNode && peerNode.connectionManager) {
          console.log(`🔗 Creating WebSocket connection to ${targetPeer.substring(0, 8)}...`);
          // CRITICAL: Pass metadata so connection manager can use publicWssAddress for browsers
          await peerNode.connectionManager.createConnection(targetPeer, true, peerNode.metadata);
          console.log(`✅ WebSocket connection initiated to ${targetPeer.substring(0, 8)}...`);
        } else {
          console.error(`❌ No connection manager available for ${targetPeer.substring(0, 8)}...`);
        }

      } catch (error) {
        console.error(`❌ Failed to connect to ${targetPeer}:`, error);
      }
    }

    // This node is the invitee - store inviter metadata and handle connection
    if (fromPeer && fromPeerMetadata) {
      console.log(`📋 Received inviter metadata from ${fromPeer.substring(0, 8)}...`);
      console.log(`   Listening address: ${fromPeerMetadata.listeningAddress}`);
      console.log(`   Public WSS address: ${fromPeerMetadata.publicWssAddress || 'not set'}`);
      console.log(`   Node type: ${fromPeerMetadata.nodeType}`);

      // Create peer node and let connection manager handle invitation logic
      const peerNode = this.getOrCreatePeerNode(fromPeer, fromPeerMetadata);

      // Connection-agnostic: delegate to connection manager
      if (peerNode.connectionManager) {
        await peerNode.connectionManager.handleInvitation(fromPeer, fromPeerMetadata);
      } else {
        console.warn(`⚠️ No connection manager for peer ${fromPeer.substring(0, 8)}...`);
      }
    }
  }

  /**
   * CRITICAL: Handle bridge nodes received from bootstrap response
   * This is the missing piece that connects genesis peer to bridge nodes
   */
  async handleBridgeNodesReceived(data) {
    const { bridgeNodes, isGenesis, membershipToken } = data;

    console.log(`🌉 Received ${bridgeNodes.length} bridge nodes from bootstrap server (Genesis: ${isGenesis})`);

    try {
      // Connect to all bridge nodes for redundancy
      const connectionPromises = [];

      for (const bridgeNode of bridgeNodes) {
        // Internal Node.js nodes use listeningAddress, browsers use publicWssAddress
        const connectAddress = this.nodeType === 'browser'
          ? (bridgeNode.metadata.publicWssAddress || bridgeNode.metadata.listeningAddress)
          : (bridgeNode.metadata.listeningAddress || bridgeNode.metadata.publicWssAddress);
        console.log(`🔗 Connecting to bridge node ${bridgeNode.nodeId.substring(0, 8)}... at ${connectAddress} (node type: ${this.nodeType})`);

        // Create peer node with bridge metadata
        // CRITICAL: Include publicWssAddress for browser connections
        const peerNode = this.getOrCreatePeerNode(bridgeNode.nodeId, {
          nodeType: 'nodejs',
          isBridgeNode: true,
          listeningAddress: bridgeNode.metadata.listeningAddress,
          publicWssAddress: bridgeNode.metadata.publicWssAddress,  // For browser WSS connections
          capabilities: bridgeNode.metadata.capabilities,
          bridgeAuthToken: bridgeNode.metadata.bridgeAuthToken
        });

        // Create WebSocket connection to bridge node
        // CRITICAL: Pass metadata so connection manager has access to listeningAddress
        const connectionPromise = peerNode.connectionManager.createConnection(bridgeNode.nodeId, true, peerNode.metadata)
          .then(() => {
            console.log(`✅ Connected to bridge node ${bridgeNode.nodeId.substring(0, 8)}...`);
            return bridgeNode.nodeId;
          })
          .catch(error => {
            console.error(`❌ Failed to connect to bridge node ${bridgeNode.nodeId.substring(0, 8)}...:`, error);
            return null;
          });

        connectionPromises.push(connectionPromise);
      }

      // Wait for at least one connection to succeed
      const results = await Promise.allSettled(connectionPromises);
      const successful = results.filter(r => r.status === 'fulfilled' && r.value !== null);

      if (successful.length > 0) {
        console.log(`🎉 Successfully connected to ${successful.length}/${bridgeNodes.length} bridge nodes`);

        // CRITICAL: Bridge nodes already added to routing table by getOrCreatePeerNode() with full metadata
        // No need to create new DHTNode instances - they were created at line 1312 with proper metadata
        // Just verify they're in the routing table and update lastSeen
        for (const result of results) {
          if (result.status === 'fulfilled' && result.value !== null) {
            const bridgeNodeId = result.value;
            try {
              // Get the node that was already created with metadata
              const node = this.routingTable.getNode(bridgeNodeId);
              if (node) {
                // Update lastSeen to mark as recently connected
                node.lastSeen = Date.now();
                console.log(`✅ Bridge node ${bridgeNodeId.substring(0, 8)}... already in routing table with metadata`);
              } else {
                console.warn(`⚠️ Bridge node ${bridgeNodeId.substring(0, 8)}... not found in routing table - this should not happen`);
              }
            } catch (error) {
              console.warn(`Failed to update bridge node ${bridgeNodeId}:`, error);
            }
          }
        }

        // Update genesis status - we're no longer isolated
        if (isGenesis) {
          console.log(`🌟 Genesis peer successfully connected to bridge nodes - ready for DHT operations`);
        }

        // Store membership token if provided
        if (membershipToken) {
          this.setMembershipToken(membershipToken);
        }

      } else {
        console.error(`❌ Failed to connect to any bridge nodes`);
      }

    } catch (error) {
      console.error(`❌ Error processing bridge nodes:`, error);
    }
  }

  /**
   * Handle new peer connection
   */
  handlePeerConnected(peerId) {
    // Validate that this is a proper DHT peer
    if (!this.isValidDHTPeer(peerId)) {
      console.warn(`❌ Invalid DHT peer: ${peerId}`);
      return;
    }

    // Clean up pending WebRTC offer tracking if connection succeeded
    if (this.pendingWebRTCOffers && this.pendingWebRTCOffers.has(peerId)) {
      this.pendingWebRTCOffers.delete(peerId);
      console.log(`✅ WebRTC coordination completed for ${peerId.substring(0, 8)}... - connection established`);
    }

    // Double-check connection with a small delay to ensure it's stable
    setTimeout(() => {
      if (!this.isPeerConnected(peerId)) {
        return;
      }

      if (this.routingTable.getNode(peerId)) {
        // Node already exists - still consider DHT signaling switch
        console.log(`📋 Node ${peerId} already in routing table - checking signaling mode`);
        this.considerDHTSignaling();
        return;
      }

      const node = new DHTNode(peerId, peerId);

      // Peer metadata will be set when connection manager is created

      const addResult = this.routingTable.addNode(node);

      if (addResult) {
        console.log(`📋 Added ${peerId} to routing table (${this.routingTable.getAllNodes().length} total)`);

        // CRITICAL FIX: Attach DHT message handlers immediately after adding to routing table
        // This ensures the peer can respond to DHT queries (find_node, find_value, etc.)
        // The getOrCreatePeerNode method has guards to prevent duplicate handler attachment
        try {
          this.getOrCreatePeerNode(peerId);
          console.log(`✅ DHT handlers initialized for newly connected peer ${peerId.substring(0, 8)}`);
        } catch (error) {
          console.error(`❌ Failed to initialize DHT handlers for ${peerId.substring(0, 8)}:`, error);
        }

        this.considerDHTSignaling();
      } else {
        // Even if adding failed, still check signaling mode
        this.considerDHTSignaling();
        return;
      }

      // Send ping to establish RTT
      this.sendPing(peerId).catch(error => {
        console.warn(`Failed to ping newly connected peer ${peerId}:`, error);
      });

      this.emit('peerConnected', peerId);
    }, 1000); // 1 second delay to ensure connection stability
  }

  /**
   * Consider switching to DHT-based signaling if we have sufficient peers
   */
  considerDHTSignaling() {
    // Only consider switching if we're currently using bootstrap signaling
    if (!this.useBootstrapForSignaling) {
      return; // Already using DHT signaling
    }

    const connectedPeers = this.getConnectedPeers().length;
    const routingTableSize = this.routingTable.getAllNodes().length;

    console.log(`🔍 considerDHTSignaling: ${connectedPeers} connected, ${routingTableSize} in routing table, useBootstrap=${this.useBootstrapForSignaling}`);

    // Switch to DHT signaling if we have at least 1 stable connection
    // This aligns with the documentation expectation: ≥1 DHT connection
    if (connectedPeers >= 1 && routingTableSize >= 1) {
      console.log(`🌐 SWITCHING TO DHT SIGNALING: ${connectedPeers} connected peers, ${routingTableSize} routing table entries`);

      this.useBootstrapForSignaling = false;

      // Disable bootstrap auto-reconnect to prevent reconnection every ~6 minutes
      // It will be re-enabled temporarily when sending invitations
      if (this.bootstrap) {
        this.bootstrap.disableAutoReconnect();
      }

      // Emit event for UI updates
      this.emit('signalingModeChanged', {
        mode: 'dht',
        connectedPeers,
        routingTableSize
      });

      console.log('✅ DHT signaling mode activated - minimal server dependency achieved');
    } else {
      console.log(`📡 Staying in bootstrap signaling mode: ${connectedPeers} peers connected, ${routingTableSize} routing entries (need ≥1 for DHT signaling)`);
    }
  }

  /**
   * Validate that a peer ID represents a valid DHT peer
   */
  isValidDHTPeer(peerId) {
    // Filter out bootstrap server connections and invalid peer IDs

    // Silently reject our own node ID (find_node handler checks this explicitly too)
    if (peerId === this.localNodeId.toString()) {
      return false;
    }

    if (peerId.includes('bootstrap') || peerId.includes('server')) {
      return false;
    }

    if (peerId.startsWith('ws://') || peerId.startsWith('wss://')) {
      return false;
    }

    const hexPattern = /^[a-f0-9]{40,}$/i;
    if (!hexPattern.test(peerId)) {
      return false;
    }

    // Additional validation: peer must be either connected or have been discovered through invitation
    // This helps prevent random search target IDs from being treated as real peers
    if (!this.isPeerConnected(peerId) && !this.isPeerConnected(peerId)) {
      // Allow peer if it was discovered through invitation system or routing table
      if (!this.routingTable.getNode(peerId)) {
        console.debug(`🔍 Validating disconnected peer ${peerId.substring(0,8)}: not in routing table yet`);
      }
    }

    return true;
  }

  /**
   * Handle peer disconnection
   */
  handlePeerDisconnected(peerId) {
    console.log(`Peer disconnected: ${peerId}`);

    // Remove from routing table
    this.routingTable.removeNode(peerId);

    this.emit('peerDisconnected', peerId);

    // CRITICAL: If we've lost all connections, re-enable bootstrap auto-reconnect
    // This allows reconnection after sleep/wake or network issues
    const connectedPeers = this.getConnectedPeers().length;
    const routingTableSize = this.routingTable.getAllNodes().length;

    if (connectedPeers === 0 && routingTableSize === 0) {
      console.log('⚠️ Lost all connections - re-enabling bootstrap auto-reconnect for recovery');
      if (this.bootstrap) {
        this.bootstrap.enableAutoReconnect();

        // If not already connected to bootstrap, reconnect now to facilitate recovery
        if (!this.bootstrap.isBootstrapConnected()) {
          console.log('🔄 Reconnecting to bootstrap for network recovery...');
          this.bootstrap.connect(this.localNodeId.toString(), {
            publicKey: this.keyPair?.publicKey,
            isNative: this.keyPair?.isNative,
            ...this.bootstrapMetadata
          }).catch(error => {
            console.error('❌ Failed to reconnect to bootstrap for recovery:', error);
          });
        }
      }
      // Switch back to bootstrap signaling mode
      this.useBootstrapForSignaling = true;
    }
  }

  /**
   * Clean up routing table by removing peers without active WebRTC connections
   */
  cleanupRoutingTable() {
    const allNodes = this.routingTable.getAllNodes();
    let removedCount = 0;

    for (const node of allNodes) {
      const peerId = node.id.toString();
      if (!this.isPeerConnected(peerId)) {
        console.log(`Removing disconnected peer from routing table: ${peerId}`);
        this.routingTable.removeNode(peerId);
        removedCount++;
      }
    }

    if (removedCount > 0) {
      console.log(`Cleaned up ${removedCount} disconnected peers from routing table`);
    }

    return removedCount;
  }

  /**
   * Handle incoming message from peer
   */
  async handlePeerMessage(peerId, message) {
    // EMERGENCY: Sleep/Wake memory protection
    const currentTime = Date.now();
    const timeDiff = currentTime - this.lastSystemTime;

    // Detect sleep/wake cycle (system time jump > 60 seconds)
    if (timeDiff > this.sleepWakeThreshold) {
      console.warn(`🛌 Sleep/wake detected: ${Math.round(timeDiff/1000)}s gap - resetting message counters`);
      this.globalMessageCount = 0; // Reset counter after sleep/wake
      this.emergencyThrottleActive = false; // Reset throttle
    }
    this.lastSystemTime = currentTime;

    // Global message rate limiting to prevent memory exhaustion
    this.globalMessageCount++;
    if (this.globalMessageCount > this.globalMessageLimit) {
      if (!this.emergencyThrottleActive) {
        console.error(`🚨 EMERGENCY: Message flood detected (${this.globalMessageCount} messages) - activating emergency throttle`);
        this.emergencyThrottleActive = true;
      }

      // Drop messages during emergency throttle (except critical ones)
      if (message.type !== 'ping' && message.type !== 'pong') {
        return; // Silently drop non-critical messages
      }
    }

    console.log(`Message from ${peerId}:`, message.type);

    // CRITICAL: Update lastSeen timestamp for any message received to prevent stale node removal
    const peerNode = this.routingTable.getNode(peerId);
    if (peerNode) {
      peerNode.updateLastSeen();
    }

    try {
      switch (message.type) {
        case 'ping':
          await this.handlePing(peerId, message);
          break;
        case 'pong':
          await this.handlePong(peerId, message);
          break;
        case 'find_node':
          await this.handleFindNode(peerId, message);
          break;
        case 'find_value':
          await this.handleFindValue(peerId, message);
          break;
        case 'store':
          await this.handleStore(peerId, message);
          break;
        case 'ice_candidate':
          await this.handleICECandidate(peerId, message);
          break;
        case 'ice_request':
          await this.handleICERequest(peerId, message);
          break;
        case 'find_node_response':
          await this.handleFindNodeResponse(peerId, message);
          break;
        case 'store_response':
          await this.handleStoreResponse(peerId, message);
          break;
        case 'find_value_response':
          await this.handleFindValueResponse(peerId, message);
          break;
        case 'ice_response':
          await this.handleICEResponse(peerId, message);
          break;
        case 'connection_offer':
          if (this.overlayNetwork) {
            await this.overlayNetwork.handleConnectionOffer(peerId, message);
          }
          break;
        case 'connection_answer':
          if (this.overlayNetwork) {
            await this.overlayNetwork.handleConnectionAnswer(peerId, message);
          }
          break;
        case 'connection_candidate':
          if (this.overlayNetwork) {
            await this.overlayNetwork.handleConnectionCandidate(peerId, message);
          }
          break;
        case 'peer_discovery_request':
          await this.handlePeerDiscoveryRequest(peerId, message);
          break;
        case 'peer_discovery_response':
          await this.handlePeerDiscoveryResponse(peerId, message);
          break;
        case 'connection_request':
          await this.handleConnectionRequest(peerId, message);
          break;
        case 'connection_response':
          await this.handleConnectionResponse(peerId, message);
          break;
        case 'forward_invitation':
          await this.handleForwardInvitation(peerId, message);
          break;
        case 'create_invitation_for_peer':
          await this.handleCreateInvitationForPeer(peerId, message);
          break;
        default:
          console.warn(`Unknown message type from ${peerId}: ${message.type}`);
      }
    } catch (error) {
      console.error(`Error handling message from ${peerId}:`, error);
    }
  }



  /**
   * Handle incoming signal from bootstrap
   */
  async handleIncomingSignal(fromPeer, signal) {
    // Use getOrCreatePeerNode to ensure connection manager exists
    const peerNode = this.getOrCreatePeerNode(fromPeer);
    await peerNode.connectionManager.handleSignal(fromPeer, signal);
  }

  /**
   * Store ICE candidate in DHT for peer
   */
  async storeICECandidate(peerId, signal) {
    const key = `ice:${peerId}:${this.localNodeId.toString()}`;
    const value = {
      signal,
      timestamp: Date.now(),
      from: this.localNodeId.toString()
    };

    try {
      await this.store(key, value);
      console.log(`Stored ICE candidate for ${peerId} in DHT`);
    } catch (error) {
      console.error(`Failed to store ICE candidate for ${peerId}:`, error);
    }
  }

  /**
   * Request ICE candidates from DHT
   */
  async requestICECandidates(peerId) {
    const key = `ice:${this.localNodeId.toString()}:${peerId}`;

    try {
      const result = await this.get(key);
      if (result) {
        // Use getOrCreatePeerNode to ensure connection manager exists
        const peerNode = this.getOrCreatePeerNode(peerId);
        await peerNode.connectionManager.handleSignal(peerId, result.signal);
      }
    } catch (error) {
      console.error(`DHT ICE retrieval failed from ${peerId}:`, error);
    }
  }


  /**
   * Connect to peer using appropriate transport based on node type
   */
  async connectToPeerViaDHT(peerId) {

    // Skip if already connected
    if (this.isPeerConnected(peerId)) {
      console.log(`Already connected to ${peerId}`);
      return true;
    }

    // Skip if we already have a pending WebSocket connection request for this peer
    if (this.pendingWebSocketRequests.has(peerId)) {
      console.log(`⏳ WebSocket connection request already pending for ${peerId}`);
      return false;
    }

    try {
      // Use connection-agnostic approach: let connection manager handle transport selection
      console.log(`🔗 Connecting to peer ${peerId.substring(0, 8)}...`);

      const peerNode = this.getOrCreatePeerNode(peerId);
      // CRITICAL: Pass metadata from routing table node so connection manager has listeningAddress
      await peerNode.connectionManager.createConnection(peerId, true, peerNode.metadata);


      return true;
    } catch (error) {
      console.error(`Failed to connect to ${peerId} via DHT:`, error);

      // Clean up pending request on error
      this.pendingWebSocketRequests.delete(peerId);
      return false;
    }
  }

  /**
   * Poll DHT for answer from target peer
   */
  async pollForDHTAnswer(peerId, maxAttempts = 10, interval = 2000) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const answerKey = `webrtc_answer:${peerId}:${this.localNodeId.toString()}`;
        const answerData = await this.get(answerKey);

        if (answerData) {
          console.log(`📥 Found answer from ${peerId} in DHT, applying...`);
          // Use getOrCreatePeerNode to ensure connection manager exists
          const peerNode = this.getOrCreatePeerNode(peerId);
          await peerNode.connectionManager.handleSignal(peerId, answerData.signal);
          return true;
        }

        console.log(`⏳ Waiting for answer from ${peerId} (attempt ${attempt + 1}/${maxAttempts})`);
        await new Promise(resolve => setTimeout(resolve, interval));
      } catch (error) {
        console.warn(`Error polling for answer from ${peerId}:`, error);
      }
    }

    console.warn(`⏰ Timeout waiting for answer from ${peerId}`);
    return false;
  }

  /**
   * Start periodic polling for incoming WebRTC offers from other peers
   */
  startDHTOfferPolling() {
    if (this.dhtOfferPollingInterval) {
      return; // Already started
    }

    this.dhtOfferPollingInterval = setInterval(async () => {
      try {
        await this.checkForIncomingOffers();
      } catch (error) {
        // Suppress polling errors unless critical
      }
    }, 5000); // Check every 5 seconds
  }

  /**
   * Stop DHT offer polling
   */
  stopDHTOfferPolling() {
    if (this.dhtOfferPollingInterval) {
      clearInterval(this.dhtOfferPollingInterval);
      this.dhtOfferPollingInterval = null;
      console.log('⏹️ Stopped DHT offer polling');
    }
  }

  /**
   * Check DHT for incoming WebRTC offers and respond to them
   */
  async checkForIncomingOffers() {
    const connectedPeers = this.getConnectedPeers();
    let routingNodes = this.routingTable.getAllNodes();

    // CRITICAL FIX: Clean up routing table first to avoid phantom peers
    this.cleanupRoutingTable();
    routingNodes = this.routingTable.getAllNodes(); // Refresh after cleanup

    // CHICKEN-AND-EGG FIX: Also scan DHT for offers from unknown peers
    // This allows peers to discover each other without being in routing tables first
    await this.discoverIncomingOffers();

    // Only check recently seen or valid peers to avoid phantom peer loops
    const validNodes = routingNodes.filter(node => {
      const peerId = node.id.toString();

      // Skip if already connected
      if (connectedPeers.includes(peerId)) {
        return false;
      }

      // Skip if it's our own node ID
      if (peerId === this.localNodeId.toString()) {
        return false;
      }

      // Skip if node hasn't been seen recently (avoid stale entries)
      const recentThreshold = Date.now() - (10 * 60 * 1000); // 10 minutes
      if (node.lastSeen && node.lastSeen < recentThreshold) {
        console.log(`Skipping stale node ${peerId} (last seen ${new Date(node.lastSeen).toISOString()})`);
        return false;
      }

      return true;
    });

    // Check for offers from valid peers
    for (const node of validNodes) {
      const peerId = node.id.toString();

      try {
        const offerKey = `webrtc_offer:${peerId}:${this.localNodeId.toString()}`;
        const offerData = await this.get(offerKey);

        if (offerData) {
          console.log(`📨 Found offer from ${peerId}, responding`);
          await this.respondToOffer(peerId, offerData.signal);
        }
      } catch (error) {
        // CRITICAL FIX: If we repeatedly fail to contact a peer, remove it from routing table
        // Track failed attempts
        if (!this.failedOfferChecks) {
          this.failedOfferChecks = new Map();
        }

        const failures = this.failedOfferChecks.get(peerId) || 0;
        this.failedOfferChecks.set(peerId, failures + 1);

        if (failures >= 3) {
          console.log(`🗑️ Removing stale peer ${peerId}`);
          this.routingTable.removeNode(peerId);
          this.failedOfferChecks.delete(peerId);
        }
      }
    }
  }

  /**
   * CHICKEN-AND-EGG FIX: Discover incoming offers from unknown peers
   * This method scans DHT storage for offers directed at us from any peer,
   * temporarily adds those peers to routing table, then removes them if connection fails
   */
  async discoverIncomingOffers() {
    try {
      const myNodeId = this.localNodeId.toString();
      const connectedPeers = this.getConnectedPeers();

      // Track peers we temporarily add for signaling
      if (!this.tempSignalingPeers) {
        this.tempSignalingPeers = new Set();
      }

      // Look through our local DHT storage for any offers directed at us
      // Format: webrtc_offer:senderNodeId:ourNodeId
      const offerPattern = `webrtc_offer:`;

      // Get all keys from local storage that might be offers
      const possibleOffers = [];
      for (const [key, value] of this.storage.entries()) {
        if (key.startsWith(offerPattern) && key.endsWith(`:${myNodeId}`)) {
          const parts = key.split(':');
          if (parts.length === 3) {
            const senderNodeId = parts[1];
            const receiverNodeId = parts[2];

            // Make sure it's really for us and not from us
            if (receiverNodeId === myNodeId && senderNodeId !== myNodeId) {
              possibleOffers.push({
                key,
                senderNodeId,
                offerData: value
              });
            }
          }
        }
      }

      // Process discovered offers
      for (const offer of possibleOffers) {
        const { senderNodeId, offerData } = offer;

        // Skip if already connected
        if (connectedPeers.includes(senderNodeId)) {
          continue;
        }

        // Skip if already in routing table
        if (this.routingTable.getNode(senderNodeId)) {
          continue;
        }

        // Validate sender is a proper DHT peer
        if (!this.isValidDHTPeer(senderNodeId)) {
          console.log(`🚫 Invalid sender for DHT signaling: ${senderNodeId}`);
          continue;
        }

        console.log(`🔍 Discovered incoming offer from unknown peer: ${senderNodeId}`);

        // TEMPORARILY add peer to routing table for signaling purposes
        const tempNode = new DHTNode(senderNodeId, 'temp-signaling');
        tempNode.lastSeen = Date.now();
        tempNode.isTemporaryForSignaling = true;

        const addResult = this.routingTable.addNode(tempNode);
        if (addResult) {
          this.tempSignalingPeers.add(senderNodeId);
          console.log(`📋 Temporarily added ${senderNodeId} to routing table for DHT signaling`);

          // Respond to the offer
          try {
            await this.respondToOffer(senderNodeId, offerData.signal);
          } catch (error) {
            console.error(`Failed to respond to offer from ${senderNodeId}:`, error);
            // Remove the temporary peer if response failed
            this.routingTable.removeNode(senderNodeId);
            this.tempSignalingPeers.delete(senderNodeId);
          }
        }
      }

      // Clean up temporary signaling peers that failed to connect after reasonable time
      this.cleanupFailedSignalingPeers();

    } catch (error) {
      console.error('Error discovering incoming offers:', error);
    }
  }

  /**
   * Clean up temporary signaling peers that haven't successfully connected
   */
  cleanupFailedSignalingPeers() {
    if (!this.tempSignalingPeers) return;

    const connectedPeers = this.getConnectedPeers();
    const failedPeers = [];

    for (const peerId of this.tempSignalingPeers) {
      if (!connectedPeers.includes(peerId)) {
        // Check how long it's been since we added this peer
        const node = this.routingTable.getNode(peerId);
        if (node && node.isTemporaryForSignaling) {
          const timeSinceAdded = Date.now() - (node.lastSeen || 0);
          // If it's been more than 2 minutes without connecting, remove it
          if (timeSinceAdded > 120000) {
            console.log(`🧹 Removing failed temporary signaling peer: ${peerId}`);
            this.routingTable.removeNode(peerId);
            failedPeers.push(peerId);
          }
        }
      } else {
        // Peer successfully connected, remove the temporary flag
        const node = this.routingTable.getNode(peerId);
        if (node && node.isTemporaryForSignaling) {
          delete node.isTemporaryForSignaling;
          console.log(`✅ Peer ${peerId} successfully connected, removing temporary signaling flag`);
        }
      }
    }

    // Remove failed peers from our tracking set
    for (const peerId of failedPeers) {
      this.tempSignalingPeers.delete(peerId);
    }
  }

  /**
   * Respond to an incoming WebRTC offer with an answer
   */
  async respondToOffer(peerId, offerSignal) {
    try {
      // Check if connection already exists (race condition handling)
      if (this.isPeerConnected(peerId)) {
        console.log(`🔄 Connection already exists for ${peerId}, using existing connection for offer`);
        // Use existing connection to handle the offer
        const existingPeerNode = this.getOrCreatePeerNode(peerId);
        await existingPeerNode.connectionManager.handleSignal(peerId, offerSignal);
        return;
      }

      // Create incoming connection to handle the offer
      const peerNode = this.getOrCreatePeerNode(peerId);
      // CRITICAL: Pass metadata from routing table node so connection manager has connection info
      await peerNode.connectionManager.createConnection(peerId, false, peerNode.metadata); // false = not initiator

      console.log(`📥 Responding to offer from ${peerId}`);
      await peerNode.connectionManager.handleSignal(peerId, offerSignal);
    } catch (error) {
      // If connection already exists, try to use it for the offer
      if (error.message.includes('already exists')) {
        console.log(`🔄 Race condition detected for ${peerId}, using existing connection`);
        try {
          const peerNode = this.getOrCreatePeerNode(peerId);
          await peerNode.connectionManager.handleSignal(peerId, offerSignal);
        } catch (signalError) {
          console.error(`❌ Failed to handle offer signal for existing connection ${peerId}:`, signalError);
        }
      } else {
        console.error(`❌ Failed to respond to offer from ${peerId}:`, error);
      }
    }
  }

  /**
   * Connect to a specific peer using directed bootstrap workflow
   */
  async connectToPeerDirected(targetPeerId) {
    console.log(`Attempting directed connection to peer: ${targetPeerId}`);

    // Skip if already connected
    if (this.isPeerConnected(targetPeerId)) {
      console.log(`Already connected to ${targetPeerId}`);
      return true;
    }

    try {
      // First check if peer is online
      const peerLookupResult = await this.bootstrap.lookupPeer(targetPeerId);
      console.log(`Peer lookup result:`, peerLookupResult);

      if (!peerLookupResult || !peerLookupResult.online) {
        console.log(`Peer ${targetPeerId} is not online, waiting...`);

        // Wait for peer to come online
        await this.bootstrap.waitForPeer(targetPeerId);

        // Set up listener for when peer becomes available
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            this.bootstrap.off('peerAvailable', handler);
            reject(new Error(`Timeout waiting for peer ${targetPeerId}`));
          }, 30000);

          const handler = (message) => {
            if (message.targetPeerId === targetPeerId) {
              clearTimeout(timeout);
              this.bootstrap.off('peerAvailable', handler);
              this.initiateDirectedConnection(targetPeerId).then(resolve).catch(reject);
            }
          };

          this.bootstrap.on('peerAvailable', handler);
        });
      } else {
        // Peer is online, initiate connection immediately
        return await this.initiateDirectedConnection(targetPeerId);
      }
    } catch (error) {
      console.error(`Failed to connect to ${targetPeerId}:`, error);
      return false;
    }
  }

  /**
   * Initiate the actual WebRTC connection to a peer
   */
  async initiateDirectedConnection(targetPeerId, retryCount = 0) {
    const maxRetries = 2;

    try {
      // Send join request through bootstrap
      await this.bootstrap.joinPeer(targetPeerId);

      // Create connection using appropriate transport
      console.log(`Creating directed connection to ${targetPeerId} (attempt ${retryCount + 1}/${maxRetries + 1})`);
      const peerNode = this.getOrCreatePeerNode(targetPeerId);
      // CRITICAL: Pass metadata from routing table node so connection manager has connection info
      await peerNode.connectionManager.createConnection(targetPeerId, true, peerNode.metadata);

      // Wait a bit for connection to establish
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Check if connection succeeded
      if (this.isPeerConnected(targetPeerId)) {
        console.log(`Successfully connected to ${targetPeerId}`);
        return true;
      }

      // If not connected and we have retries left, try again
      if (retryCount < maxRetries) {
        console.log(`Connection attempt ${retryCount + 1} failed, retrying...`);
        // Clean up failed connection
        const peerNode = this.routingTable.getNode(targetPeerId);
        // REFACTORED: isConnected() no longer takes peerId parameter (single-connection architecture)
        if (peerNode && peerNode.connectionManager && peerNode.connectionManager.isConnected && peerNode.connectionManager.isConnected()) {
          peerNode.connectionManager.destroyConnection(targetPeerId);
        }
        return this.initiateDirectedConnection(targetPeerId, retryCount + 1);
      }

      return false;
    } catch (error) {
      console.error(`Failed to initiate connection to ${targetPeerId} (attempt ${retryCount + 1}):`, error);

      // Retry on certain errors
      if (retryCount < maxRetries &&
          (error.message.includes('timeout') || error.message.includes('failed'))) {
        console.log(`Retrying connection due to error: ${error.message}`);
        return this.initiateDirectedConnection(targetPeerId, retryCount + 1);
      }

      return false;
    }
  }

  /**
   * Handle ICE candidate message
   */
  async handleICECandidate(peerId, message) {
    const { signal, requestId } = message;

    try {
      // Use getOrCreatePeerNode to ensure connection manager exists
      const peerNode = this.getOrCreatePeerNode(peerId);
      await peerNode.connectionManager.handleSignal(peerId, signal);

      if (requestId) {
        this.sendMessage(peerId, {
          type: 'ice_response',
          requestId,
          success: true
        });
      }
    } catch (error) {
      console.error(`Error handling ICE candidate from ${peerId}:`, error);

      if (requestId) {
        this.sendMessage(peerId, {
          type: 'ice_response',
          requestId,
          success: false,
          error: error.message
        });
      }
    }
  }

  /**
   * Handle ICE request message
   */
  async handleICERequest(peerId, message) {
    const { targetPeer, requestId } = message;

    try {
      // Look up ICE candidates for target peer
      await this.requestICECandidates(targetPeer);

      this.sendMessage(peerId, {
        type: 'ice_response',
        requestId,
        success: true
      });
    } catch (error) {
      this.sendMessage(peerId, {
        type: 'ice_response',
        requestId,
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Send ping to peer
   */
  async sendPing(peerId) {
    const message = {
      type: 'ping',
      requestId: this.generateRequestId(),
      timestamp: Date.now(),
      nodeId: this.localNodeId.toString()
    };

    try {
      await this.sendMessage(peerId, message);
    } catch (error) {
      console.error(`Failed to ping ${peerId}:`, error);

      // Mark peer as failed
      const node = this.routingTable.getNode(peerId);
      if (node) {
        node.recordFailure();
      }
    }
  }

  /**
   * Handle ping message
   */
  async handlePing(peerId, message) {
    const response = {
      type: 'pong',
      requestId: message.requestId,
      timestamp: Date.now(),
      nodeId: this.localNodeId.toString()
    };

    await this.sendMessage(peerId, response);
  }

  /**
   * Handle pong message
   */
  async handlePong(peerId, message) {
    const rtt = Date.now() - message.timestamp;

    const node = this.routingTable.getNode(peerId);
    if (node) {
      node.recordPing(rtt);
    }

    console.log(`Pong from ${peerId}, RTT: ${rtt}ms`);
  }

  /**
   * Find node operation
   */
  async findNode(targetId, options = {}) {
    const target = typeof targetId === 'string' ?
      DHTNodeId.fromString(targetId) : targetId;

    // Track bucket activity for proper Kademlia staleness tracking
    const targetBucketIndex = this.routingTable.getBucketIndex(target);
    this.bucketLastActivity.set(targetBucketIndex, Date.now());

    // Allow caller to request more than k nodes (for bridge node filtering)
    const limit = options.limit || this.options.k;
    const closest = this.routingTable.findClosestNodes(target, limit);
    const contacted = new Set();
    const results = new Set();

    // Add initial closest nodes
    for (const node of closest) {
      results.add(node);
    }

    // Iteratively query closer nodes
    let activeQueries = 0;
    const maxConcurrent = this.options.alpha;

    while (true) {
      const candidates = Array.from(results)
        .filter(node => !contacted.has(node.id.toString()))
        .filter(node => !node.id.equals(this.localNodeId)) // Don't try to connect to ourselves
        .filter(node => {
          // CRITICAL FIX: Only query nodes that have active connections
          const isConnected = this.isPeerConnected(node.id.toString());
          if (!isConnected) {
            console.log(`🔗 Skipping find_node query to non-connected node: ${node.id.toString().substring(0, 8)}...`);
          }
          return isConnected;
        })
        .sort((a, b) => {
          const distA = a.id.xorDistance(target);
          const distB = b.id.xorDistance(target);
          return distA.compare(distB);
        })
        .slice(0, maxConcurrent);

      if (candidates.length === 0 || activeQueries >= maxConcurrent) {
        break;
      }

      // Query candidates in parallel
      const queryPromises = candidates.map(async (node) => {
        contacted.add(node.id.toString());
        activeQueries++;

        try {
          const response = await this.sendFindNode(node.id.toString(), target, options);
          for (const peer of response.nodes || []) {
            const peerNode = DHTNode.fromCompact(peer);

            // CRITICAL: Add discovered peers to routing table (this is core Kademlia behavior)
            // findNode MUST populate routing table with discovered nodes for proper DHT function
            const peerId = peerNode.id.toString();

            // Skip ourselves
            if (peerId === this.localNodeId.toString()) {
              continue;
            }

            // TODO: make more efficient at some point
            if ([...results].some(peer => peer.id.toString() === peerId)) {
              continue;
            }

            results.add(peerNode);

            // Only add valid DHT peers that aren't already known
            if (this.isValidDHTPeer(peerId) && !this.routingTable.getNode(peerId)) {
              // Check if peer is in failure backoff
              const backoffUntil = this.peerFailureBackoff.get(peerId);
              if (backoffUntil && Date.now() < backoffUntil) {
                console.log(`⏳ Skipping peer ${peerId.substring(0, 8)}... in failure backoff`);
                continue;
              }

              const addResult = this.routingTable.addNode(peerNode);
              if (addResult) {
                console.log(`📋 findNode discovered new peer: ${peerId.substring(0, 8)}...`);

                // Store endpoint information in peer node metadata
                if (peerNode.endpoint) {
                  peerNode.setMetadata('endpoint', peerNode.endpoint);
                }

                // Queue for immediate connection attempt (non-blocking)
                this.queuePeerForConnection(peerId);
              }
            }
          }
        } catch (error) {
          console.warn(`Find node query failed for ${node.id.toString()}:`, error);

          // CRITICAL: Don't count rate limiting as a peer failure
          // Rate limiting is a temporary spam prevention mechanism, not a peer issue
          const isRateLimited = error.message && error.message.includes('Rate limited');

          if (!isRateLimited) {
            // Track failed peer queries to prevent repeated attempts (real failures only)
            const peerId = node.id.toString();
            const currentFailures = this.failedPeerQueries.get(peerId) || 0;
            this.failedPeerQueries.set(peerId, currentFailures + 1);

            // If peer has failed multiple times, remove from routing table and add backoff
            if (currentFailures >= 2) { // 3rd failure
            // Check if peer is still in routing table before removing
            if (this.routingTable.getNode(peerId)) {
              console.log(`🗑️ Removing repeatedly failing peer ${peerId} from routing table (${currentFailures + 1} failures)`);
              this.routingTable.removeNode(peerId);
            } else {
              console.log(`⚠️ Peer ${peerId} already removed from routing table (${currentFailures + 1} failures)`);
            }

            // Add backoff to prevent re-adding this peer for a while
            this.peerFailureBackoff.set(peerId, Date.now() + (5 * 60 * 1000)); // 5 minute backoff
          }
          } // Close if (!isRateLimited)
        } finally {
          activeQueries--;
        }
      });

      await Promise.allSettled(queryPromises);
    }

    return Array.from(results)
      .sort((a, b) => {
        const distA = a.id.xorDistance(target);
        const distB = b.id.xorDistance(target);
        return distA.compare(distB);
      })
      .slice(0, limit);
  }

  /**
   * Send find node request
   */
  async sendFindNode(peerId, targetId, options = {}) {
    // CRITICAL: Never try to query ourselves
    if (peerId === this.localNodeId.toString()) {
      throw new Error(`Cannot send find_node query to self: ${peerId}`);
    }

    // Check if peer is in failure backoff
    // Emergency bypass: Allow backoff bypass in emergency discovery mode
    const backoffUntil = this.peerFailureBackoff.get(peerId);
    const isEmergencyBypass = options.emergencyBypass === true;

    if (backoffUntil && Date.now() < backoffUntil && !isEmergencyBypass) {
      throw new Error(`Peer ${peerId} is in failure backoff until ${new Date(backoffUntil).toISOString()}`);
    }

    if (isEmergencyBypass && backoffUntil) {
      console.log(`🚨 Emergency bypass: allowing find_node to ${peerId.substring(0, 8)}... despite backoff until ${new Date(backoffUntil).toISOString()}`);
    }

    // RATE LIMIT: Check if we've sent find_node to this peer recently
    // Emergency bypass: Allow rate limit bypass in emergency discovery mode
    const lastFindNode = this.findNodeRateLimit.get(peerId);

    if (lastFindNode && Date.now() - lastFindNode < this.findNodeMinInterval && !isEmergencyBypass) {
      const waitTime = this.findNodeMinInterval - (Date.now() - lastFindNode);
      console.log(`🚫 Rate limiting find_node to ${peerId.substring(0, 8)}... (wait ${Math.round(waitTime/1000)}s)`);
      throw new Error(`Rate limited: must wait ${Math.round(waitTime/1000)}s before sending another find_node to ${peerId}`);
    }

    if (isEmergencyBypass && lastFindNode) {
      console.log(`🚨 Emergency bypass: allowing find_node to ${peerId.substring(0, 8)}... despite rate limit`);
    }

    // Record this find_node request
    this.findNodeRateLimit.set(peerId, Date.now());

    // Verify connection before sending request
    if (!this.isPeerConnected(peerId)) {
      throw new Error(`No connection to peer ${peerId}`);
    }

    const message = {
      type: 'find_node',
      requestId: this.generateRequestId(),
      target: targetId.toString(),
      nodeId: this.localNodeId.toString()
    };

    return this.sendRequestWithResponse(peerId, message);
  }

  /**
   * Handle find node request
   */
  async handleFindNode(peerId, message) {
    console.log(`📥 FIND_NODE: Request received from ${peerId.substring(0, 8)}... (requestId: ${message.requestId})`);

    const targetId = DHTNodeId.fromString(message.target);
    const closestNodes = this.routingTable.findClosestNodes(targetId, this.options.k);
    console.log(`🔍 FIND_NODE: Found ${closestNodes.length} closest nodes for target ${targetId.toString().substring(0, 8)}...`);

    // NOTE: Bridge nodes ARE included in find_node responses for two reasons:
    // 1. They need to be discoverable for messaging (reconnection services, onboarding)
    // 2. They need to be in routing tables for DHT message routing
    //
    // Bridge nodes are filtered out from STORAGE operations in two places:
    // - Client-side: store() operation filters bridge nodes when selecting replication targets
    // - Server-side: handleStore() rejects storage requests on bridge nodes
    //
    // This architecture maintains:
    // ✅ Bridge node discoverability for messaging
    // ✅ Kademlia replication guarantees (k=20 active storage nodes)

    const response = {
      type: 'find_node_response',
      requestId: message.requestId,
      nodes: closestNodes.map(node => node.toCompact())
    };

    console.log(`📤 FIND_NODE: Sending response to ${peerId.substring(0, 8)}... with ${response.nodes.length} nodes`);
    await this.sendMessage(peerId, response);
    console.log(`✅ FIND_NODE: Response sent successfully to ${peerId.substring(0, 8)}...`);
  }

  /**
   * Store key-value pair in DHT
   */
  async store(key, value) {
    this.logger.info(`📝 Storing key: ${key}`);
    this.logger.debug(`Current routing table size: ${this.routingTable.getAllNodes().length}`);
    this.logger.debug(`Connected peers: ${this.getConnectedPeers().length}`);

    // DISABLED: Cleanup is too aggressive for sparse DHTs where background connections are still in progress
    // Don't remove discovered nodes before they have a chance to connect
    // this.cleanupRoutingTable();

    const keyId = DHTNodeId.fromString(key);

    // CRITICAL: Request more nodes than replicateK to account for bridge nodes
    // Bridge nodes will be filtered out, so we need a buffer to ensure we have k=20 active nodes
    // Request k + 10 to provide reasonable buffer (handles up to 10 bridge nodes in closest set)
    const nodesToRequest = this.options.replicateK + 10;
    const closestNodes = await this.findNode(keyId, { limit: nodesToRequest });

    // Filter to only peers with active connections
    const connectedClosestNodes = closestNodes.filter(node => {
      const peerId = node.id.toString();
      if (peerId === this.localNodeId.toString()) return false; // ignore self
      const isConnected = this.isPeerConnected(peerId);
      if (!isConnected) {
        this.logger.debug(`   Node ${peerId.substring(0, 8)}... not connected, skipping replication`);
      }
      return isConnected;
    });

    // CRITICAL: Filter out passive/bridge nodes from replication targets
    // Bridge nodes should never count toward replicateK=20 quota
    // This maintains Kademlia replication guarantees
    const activeConnectedNodes = connectedClosestNodes.filter(node => {
      const peerId = node.id.toString();
      const peerNode = this.routingTable.getNode(peerId) || this.peerNodes?.get(peerId);
      const isBridgeNode = peerNode?.getMetadata?.('isBridgeNode') || peerNode?.metadata?.isBridgeNode;

      if (isBridgeNode) {
        this.logger.debug(`   Node ${peerId.substring(0, 8)}... is bridge node, excluding from replication`);
        return false;
      }
      return true;
    });

    this.logger.info(`   Found ${closestNodes.length} closest nodes, ${connectedClosestNodes.length} connected, ${activeConnectedNodes.length} active (non-bridge)`);

    // CRITICAL: Warn if we don't have enough active nodes after filtering bridge nodes
    if (activeConnectedNodes.length < this.options.replicateK) {
      const bridgeCount = connectedClosestNodes.length - activeConnectedNodes.length;
      this.logger.warn(`   ⚠️ Only ${activeConnectedNodes.length}/${this.options.replicateK} active nodes available after filtering ${bridgeCount} bridge nodes`);
      this.logger.warn(`   ⚠️ Replication guarantee degraded - storing on fewer than k=${this.options.replicateK} nodes`);
    }

    this.logger.info(`   Will replicate to ${Math.min(activeConnectedNodes.length, this.options.replicateK)} nodes (replicateK=${this.options.replicateK})`);


    // Store locally if we're one of the closest
    const localDistance = this.localNodeId.xorDistance(keyId);
    const shouldStoreLocally = activeConnectedNodes.length < this.options.replicateK ||
      activeConnectedNodes.some(node => {
        const nodeDistance = node.id.xorDistance(keyId);
        return localDistance.compare(nodeDistance) <= 0;
      });

    if (shouldStoreLocally) {
      this.storage.set(key, {
        value,
        timestamp: Date.now(),
        publisher: this.localNodeId.toString()
      });
      this.logger.info(`   ✅ Stored locally (we are one of the ${this.options.replicateK} closest nodes)`);
    } else {
      this.logger.debug(`   Skipping local storage (not one of the ${this.options.replicateK} closest nodes)`);
    }

    // Store on closest active (non-bridge) connected nodes
    const targetNodes = activeConnectedNodes.slice(0, this.options.replicateK);
    this.logger.info(`   Replicating to ${targetNodes.length} active peers...`);

    const storePromises = targetNodes.map(node => {
      const peerId = node.id.toString();
      this.logger.debug(`   → Sending store to ${peerId.substring(0, 8)}...`);
      return this.sendStore(peerId, key, value);
    });

    const results = await Promise.allSettled(storePromises);
    const successes = results.filter(r => r.status === 'fulfilled').length;
    const failures = results.filter(r => r.status === 'rejected');

    this.logger.info(`   ✅ Replication complete: ${successes}/${targetNodes.length} successful`);
    if (failures.length > 0) {
      this.logger.warn(`   ⚠️ ${failures.length} replication failures`);
      failures.forEach((f, i) => {
        this.logger.debug(`      Failed to ${targetNodes[i].id.toString().substring(0, 8)}...: ${f.reason}`);
      });
    }

    // Add to republish queue
    this.republishQueue.set(key, Date.now() + this.options.republishInterval);

    return successes > 0 || shouldStoreLocally;
  }

  /**
   * Send store request
   */
  async sendStore(peerId, key, value) {
    // Verify connection before sending request
    if (!this.isPeerConnected(peerId)) {
      throw new Error(`No connection to peer ${peerId}`);
    }

    const message = {
      type: 'store',
      requestId: this.generateRequestId(),
      key,
      value,
      nodeId: this.localNodeId.toString()
    };

    return this.sendRequestWithResponse(peerId, message);
  }

  /**
   * Handle store request
   */
  async handleStore(peerId, message) {
    const { key, value } = message;

    // CRITICAL: Passive nodes (bridge nodes) must reject store requests
    // to maintain Kademlia replication guarantees
    if (this.options.disableStorage || this.options.passiveMode) {
      console.log(`⚠️ Rejecting store request for ${key} - node is in passive/observer mode`);

      const response = {
        type: 'store_response',
        requestId: message.requestId,
        success: false,
        error: 'Node is in passive mode and does not accept storage'
      };

      await this.sendMessage(peerId, response);
      return;
    }

    // Store the value
    this.storage.set(key, {
      value,
      timestamp: Date.now(),
      publisher: peerId
    });

    console.log(`Stored key ${key} from ${peerId}`);

    const response = {
      type: 'store_response',
      requestId: message.requestId,
      success: true
    };

    await this.sendMessage(peerId, response);
  }

  /**
   * Get value from DHT
   */
  async get(key) {
    console.log(`🔍 GET started for key: "${key}"`);

    // Check local storage first
    if (this.storage.has(key)) {
      const stored = this.storage.get(key);
      console.log(`✅ GET: Found "${key}" in local storage`);
      return stored.value;
    }
    console.log(`❌ GET: "${key}" not in local storage, searching DHT...`);

    // Search DHT
    const keyId = DHTNodeId.fromString(key);
    console.log(`🔍 GET: Calling findNode for key ID: ${keyId.toString().substring(0, 8)}...`);
    const closestNodes = await this.findNode(keyId);
    console.log(`✅ GET: findNode returned ${closestNodes.length} closest nodes`);

    // Query nodes for the value (connect on-demand with intelligent pruning if needed)
    let queriesAttempted = 0;
    for (const node of closestNodes) {
      try {
        const peerId = node.id.toString();

        // Connect to node if not already connected (Kademlia-compliant: routing table nodes should be queryable)
        if (!this.isPeerConnected(peerId)) {
          console.log(`🔗 GET: Node ${peerId.substring(0, 8)}... not connected, attempting connection...`);
          try {
            // First check if we can connect without pruning
            const shouldConnect = await this.shouldConnectToPeer(peerId);

            if (!shouldConnect) {
              // At connection limit - use intelligent pruning to make room
              console.log(`🔄 GET: At connection limit, evaluating pruning for query node ${peerId.substring(0, 8)}...`);
              const slotFreed = await this.pruneConnectionForQuery(keyId, peerId);

              if (!slotFreed) {
                console.warn(`⚠️ GET: Cannot free a connection slot for ${peerId.substring(0, 8)}... (current connections more valuable)`);
                continue; // Try next node
              }
            }

            // Now connect to the query node
            const peerNode = this.getOrCreatePeerNode(peerId);
            // CRITICAL: Pass metadata from routing table node so connection manager has connection info
            await peerNode.connectionManager.createConnection(peerId, true, peerNode.metadata);

            // Give connection a moment to establish
            await new Promise(resolve => setTimeout(resolve, 100));
          } catch (connError) {
            console.warn(`⚠️ GET: Failed to connect to ${peerId.substring(0, 8)}...: ${connError.message}`);
            continue; // Skip to next node
          }
        }

        queriesAttempted++;
        console.log(`📤 GET: Querying node ${peerId.substring(0, 8)}... (${queriesAttempted}/${closestNodes.length})`);
        const response = await this.sendFindValue(peerId, key);
        console.log(`📥 GET: Response from ${peerId.substring(0, 8)}...: found=${response.found}`);
        if (response.found && response.value !== undefined) {
          console.log(`✅ GET: Successfully retrieved "${key}" from ${peerId.substring(0, 8)}...`);
          return response.value;
        }
      } catch (error) {
        console.warn(`⚠️ GET: Find value query failed for ${node.id.toString().substring(0, 8)}...:`, error.message);
      }
    }

    console.log(`❌ GET: Failed to find "${key}" after querying ${queriesAttempted} nodes`);
    return null;
  }

  /**
   * Send find value request
   */
  async sendFindValue(peerId, key) {
    // Check if peer is in failure backoff
    const backoffUntil = this.peerFailureBackoff.get(peerId);
    if (backoffUntil && Date.now() < backoffUntil) {
      throw new Error(`Peer ${peerId} is in failure backoff until ${new Date(backoffUntil).toISOString()}`);
    }

    // Verify connection before sending request
    if (!this.isPeerConnected(peerId)) {
      throw new Error(`No connection to peer ${peerId}`);
    }

    const message = {
      type: 'find_value',
      requestId: this.generateRequestId(),
      key,
      nodeId: this.localNodeId.toString()
    };

    return this.sendRequestWithResponse(peerId, message);
  }

  /**
   * Handle find value request
   */
  async handleFindValue(peerId, message) {
    const { key } = message;
    console.log(`🔍 [${this.localNodeId.toString().substring(0, 8)}] Handling find_value for "${key}" from ${peerId.substring(0, 8)}... (requestId: ${message.requestId})`);

    if (this.storage.has(key)) {
      // Return the value
      const stored = this.storage.get(key);
      const response = {
        type: 'find_value_response',
        requestId: message.requestId,
        found: true,
        value: stored.value
      };
      console.log(`📤 [${this.localNodeId.toString().substring(0, 8)}] Sending find_value_response (FOUND) to ${peerId.substring(0, 8)}... (requestId: ${message.requestId})`);
      await this.sendMessage(peerId, response);
    } else {
      // Return closest nodes
      const keyId = DHTNodeId.fromString(key);
      const closestNodes = this.routingTable.findClosestNodes(keyId, this.options.k);

      const response = {
        type: 'find_value_response',
        requestId: message.requestId,
        found: false,
        nodes: closestNodes.map(node => node.toCompact())
      };
      console.log(`📤 [${this.localNodeId.toString().substring(0, 8)}] Sending find_value_response (NOT FOUND, ${closestNodes.length} nodes) to ${peerId.substring(0, 8)}... (requestId: ${message.requestId})`);
      await this.sendMessage(peerId, response);
    }
  }

  /**
   * Send message to peer using per-node connection manager
   */
  async sendMessage(peerId, message) {
    try {
      // Use getOrCreatePeerNode to ensure connection manager exists
      const peerNode = this.getOrCreatePeerNode(peerId);
      return await peerNode.connectionManager.sendMessage(peerId, message);
    } catch (error) {
      console.error(`❌ Failed to send ${message.type} to ${peerId.substring(0, 8)}...: ${error.message}`);

      // Add debugging info for connection state
      const peerNode = this.routingTable.getNode(peerId);
      if (peerNode && peerNode.connectionManager) {
        // REFACTORED: isConnected() no longer takes peerId parameter (single-connection architecture)
        const isConnected = peerNode.connectionManager.isConnected();
        console.error(`   Connection state: isConnected=${isConnected}`);
        console.error(`   Connection manager type: ${peerNode.connectionManager.constructor.name}`);
      } else {
        console.error(`   No connection manager found for peer`);
      }

      throw error;
    }
  }

  /**
   * Check if peer is connected using per-node connection manager
   * REFACTORED: Uses routing table to check node's connectionManager (single-connection architecture)
   */
  isPeerConnected(peerId) {
    // CRITICAL FIX: Add null check to prevent TypeError
    if (!peerId) {
      console.warn('⚠️ isPeerConnected called with undefined/null peerId');
      return false;
    }

    const peerNode = this.routingTable.getNode(peerId);
    if (peerNode && peerNode.connectionManager) {
      // REFACTORED: isConnected() no longer takes peerId parameter (single-connection architecture)
      const isConnected = peerNode.connectionManager.isConnected();
      if (!isConnected) {
        console.log(`🔍 isPeerConnected(${peerId.substring(0,8)}): routing table node exists, connectionManager.isConnected() = false`);
      }
      return isConnected;
    }

    // CRITICAL FIX: Also check for WebSocket connections that might not be in routing table yet
    // This prevents premature cleanup of successfully connected WebSocket peers
    if (this.peerNodes && this.peerNodes.has(peerId)) {
      const directPeerNode = this.peerNodes.get(peerId);
      if (directPeerNode && directPeerNode.connectionManager) {
        // REFACTORED: isConnected() no longer takes peerId parameter (single-connection architecture)
        return directPeerNode.connectionManager.isConnected();
      }
    }

    console.log(`🔍 isPeerConnected(${peerId.substring(0,8)}): not in routing table or peerNodes`);
    return false;
  }

  /**
   * Get all connected peers from all connection managers
   * REFACTORED: Uses routing table to check each node's connectionManager (single-connection architecture)
   */
  getConnectedPeers() {
    const connectedPeers = [];
    const allNodes = this.routingTable.getAllNodes();

    // Check nodes in routing table with connection managers
    for (const node of allNodes) {
      // REFACTORED: isConnected() no longer takes peerId parameter (single-connection architecture)
      if (node.connectionManager && node.connectionManager.isConnected && node.connectionManager.isConnected()) {
        connectedPeers.push(node.id.toString());
      }
    }

    // CRITICAL FIX: Also check direct peerNodes for WebSocket connections not yet in routing table
    if (this.peerNodes) {
      for (const [peerId, peerNode] of this.peerNodes.entries()) {
        // REFACTORED: isConnected() no longer takes peerId parameter (single-connection architecture)
        if (peerNode && peerNode.connectionManager && peerNode.connectionManager.isConnected()) {
          // Only add if not already in connectedPeers
          if (!connectedPeers.includes(peerId)) {
            connectedPeers.push(peerId);
          }
        }
      }
    }

    return connectedPeers;
  }

  /**
   * Analyze bucket coverage to identify undercovered buckets
   * Returns array of bucket stats sorted by priority
   */
  analyzeBucketCoverage() {
    const allNodes = this.routingTable.getAllNodes();
    const connectedPeers = this.getConnectedPeers();

    // Initialize bucket stats (160 buckets for 160-bit address space)
    const buckets = new Map();
    for (let i = 0; i < 160; i++) {
      buckets.set(i, {
        index: i,
        connections: 0,
        totalNodes: 0,
        availablePeers: []
      });
    }

    // Populate bucket stats
    for (const node of allNodes) {
      try {
        const peerId = node.id.toString();

        // Skip our own node ID before calling getBucketIndex
        if (peerId === this.localNodeId.toString()) {
          continue;
        }

        const bucketIndex = this.routingTable.getBucketIndex(node.id);
        const bucket = buckets.get(bucketIndex);

        bucket.totalNodes++;

        if (connectedPeers.includes(peerId)) {
          bucket.connections++;
        } else {
          bucket.availablePeers.push(node);
        }
      } catch (error) {
        // Ignore invalid nodes
      }
    }

    // Convert to array and sort by priority
    // Priority: buckets with fewer connections, especially higher-index (closer) buckets
    return Array.from(buckets.values())
      .filter(b => b.totalNodes > 0) // Only buckets with nodes
      .sort((a, b) => {
        // First sort by connection count (fewer connections = higher priority)
        const connDiff = a.connections - b.connections;
        if (connDiff !== 0) return connDiff;

        // If connection count equal, prefer higher bucket index (closer peers)
        return b.index - a.index;
      });
  }

  /**
   * Select strategic peers for connection to maximize bucket diversity
   * @param {Array} discoveredNodes - Nodes discovered via DHT lookups
   * @param {number} maxToSelect - Maximum number of peers to select
   * @returns {Array} Strategic peers prioritized for connection
   */
  selectStrategicPeers(discoveredNodes, maxToSelect = null) {
    const currentConnections = this.getConnectedPeers().length;
    const maxConnections = this.transportOptions.maxConnections;
    const availableSlots = maxConnections - currentConnections;

    if (availableSlots <= 0) {
      console.log(`⚠️ No available connection slots (${currentConnections}/${maxConnections})`);
      return [];
    }

    const slotsToFill = maxToSelect ? Math.min(maxToSelect, availableSlots) : availableSlots;

    // Group nodes by bucket index
    const bucketMap = new Map();
    for (const node of discoveredNodes) {
      try {
        const peerId = node.id.toString();

        // Skip if already connected
        if (this.isPeerConnected(peerId)) continue;

        // Skip our own node
        if (peerId === this.localNodeId.toString()) continue;

        const bucketIndex = this.routingTable.getBucketIndex(node.id);
        if (!bucketMap.has(bucketIndex)) {
          bucketMap.set(bucketIndex, []);
        }
        bucketMap.get(bucketIndex).push(node);
      } catch (error) {
        // Ignore invalid nodes
      }
    }

    // Sort buckets by priority (furthest buckets first for diversity)
    const priorityBuckets = Array.from(bucketMap.entries())
      .sort((a, b) => b[0] - a[0]); // Higher bucket index = closer peers = higher priority

    // Select peers with bucket diversity
    const selectedPeers = [];
    const maxPerBucket = this.maxBucketConnections || 3;

    for (const [bucketIndex, nodes] of priorityBuckets) {
      // Take up to maxPerBucket peers from this bucket
      const peersFromBucket = nodes.slice(0, maxPerBucket);
      selectedPeers.push(...peersFromBucket);

      if (selectedPeers.length >= slotsToFill) {
        break;
      }
    }

    const result = selectedPeers.slice(0, slotsToFill);

    if (result.length > 0) {
      console.log(`🎯 Selected ${result.length} strategic peers across ${new Set(result.map(n => this.routingTable.getBucketIndex(n.id))).size} buckets`);
    }

    return result;
  }

  /**
   * Prune least valuable connection to make room for a better peer
   * @param {DHTNode} newPeer - New peer to potentially connect
   * @param {number} newPeerBucket - Bucket index of new peer
   * @returns {boolean} True if a slot was freed, false if current connections are better
   */
  async pruneConnectionForBetterPeer(newPeer, newPeerBucket) {
    const currentConnections = this.getConnectedPeers();
    const maxConnections = this.transportOptions.maxConnections;

    // No pruning needed if we're under the limit
    if (currentConnections.length < maxConnections) {
      return true;
    }

    // Calculate value for each current connection
    const connectionValues = currentConnections.map(peerId => {
      const node = this.routingTable.getNode(peerId);
      if (!node) return null;

      try {
        const bucketIndex = this.routingTable.getBucketIndex(node.id);
        const lastSeen = node.lastSeen || 0;
        const messageCount = node.messageCount || 0;

        // Value calculation:
        // - Higher bucket index (closer peers) = more valuable
        // - More recent activity = more valuable
        // - More messages exchanged = more valuable
        const recencyScore = Math.max(0, 100000 - (Date.now() - lastSeen) / 1000);
        const activityScore = messageCount * 100;
        const proximityScore = bucketIndex * 1000;

        return {
          peerId,
          bucketIndex,
          lastSeen,
          messageCount,
          value: proximityScore + recencyScore + activityScore
        };
      } catch (error) {
        return null;
      }
    }).filter(v => v !== null)
      .sort((a, b) => a.value - b.value); // Lowest value first

    if (connectionValues.length === 0) {
      return false;
    }

    // Calculate value of new peer
    const newPeerRecencyScore = 100000; // New peer gets full recency score
    const newPeerProximityScore = newPeerBucket * 1000;
    const newPeerValue = newPeerProximityScore + newPeerRecencyScore;

    // Find least valuable existing connection
    const leastValuable = connectionValues[0];

    // Only prune if new peer is significantly more valuable (1.5x threshold)
    if (newPeerValue > leastValuable.value * 1.5) {
      console.log(`🔄 Pruning connection to ${leastValuable.peerId.substring(0, 8)}... (value: ${leastValuable.value.toFixed(0)}) for better peer in bucket ${newPeerBucket} (value: ${newPeerValue.toFixed(0)})`);

      // Gracefully close old connection
      const node = this.routingTable.getNode(leastValuable.peerId);
      if (node?.connectionManager) {
        try {
          await node.connectionManager.disconnect(leastValuable.peerId);
          // Remove from routing table
          this.routingTable.removeNode(leastValuable.peerId);
          return true;
        } catch (error) {
          console.error(`Failed to prune connection to ${leastValuable.peerId}:`, error);
          return false;
        }
      }
    }

    console.log(`✅ Keeping current connections - new peer (value: ${newPeerValue.toFixed(0)}) not valuable enough vs ${leastValuable.peerId.substring(0, 8)}... (value: ${leastValuable.value.toFixed(0)})`);
    return false;
  }

  /**
   * Prune a low-value connection to make room for a critical query node
   *
   * This method is used by get() to ensure nodes closest to a search key can always be queried,
   * even when at max connections. It implements Kademlia-compliant behavior where routing table
   * nodes closest to a key should be reachable for queries.
   *
   * VALUE CALCULATION FOR QUERY OPERATIONS:
   * - Proximity to KEY (not to us): Nodes closest to the search key are highest priority
   * - Long-lived + ACTIVE: Stable servers that respond regularly are MOST valuable
   * - Long-lived + INACTIVE: Connected but idle - safe to temporarily disconnect
   * - Bucket diversity: Avoid pruning connections that provide unique routing table coverage
   *
   * PRUNING STRATEGY:
   * 1. Calculate XOR distance from each connected peer to the search KEY
   * 2. Evaluate activity: recent messages/pings indicate healthy, valuable connections
   * 3. Identify low-value candidates: far from key + inactive (no recent pings)
   * 4. DISCONNECT but KEEP in routing table: healthy peers not needed for this query
   * 5. DISCONNECT and REMOVE from routing table: truly stale/broken peers only
   *
   * This ensures get() operations succeed in large networks by temporarily prioritizing
   * connections needed for the active query, while preserving stable long-lived connections
   * in the routing table for future reconnection.
   *
   * @param {DHTNodeId} keyId - The key we're searching for (as DHTNodeId)
   * @param {string} queryNodePeerId - Peer ID of the node we need to connect to for the query
   * @returns {Promise<boolean>} True if a slot was freed, false if current connections are better
   */
  async pruneConnectionForQuery(keyId, queryNodePeerId) {
    const currentConnections = this.getConnectedPeers();
    const maxConnections = this.transportOptions.maxConnections;

    // No pruning needed if we're under the limit
    if (currentConnections.length < maxConnections) {
      return true;
    }

    console.log(`🔍 Query pruning: At connection limit (${currentConnections.length}/${maxConnections}), evaluating if we should prune for query node ${queryNodePeerId.substring(0, 8)}...`);

    const now = Date.now();
    const ACTIVITY_THRESHOLD = 5 * 60 * 1000; // 5 minutes - recent activity
    const STALE_THRESHOLD = 30 * 60 * 1000; // 30 minutes - truly stale

    // Calculate value for each current connection relative to the search KEY
    const connectionValues = currentConnections.map(peerId => {
      const node = this.routingTable.getNode(peerId);
      if (!node) return null;

      try {
        // CRITICAL: Value based on proximity to KEY (not to us)
        const distanceToKey = node.id.xorDistance(keyId);
        const bucketIndex = this.routingTable.getBucketIndex(node.id);
        const lastSeen = node.lastSeen || 0;
        const messageCount = node.messageCount || 0;
        const connectionAge = now - (node.connectedAt || now);
        const timeSinceActivity = now - lastSeen;

        // Activity classification
        const isActive = timeSinceActivity < ACTIVITY_THRESHOLD;
        const isStale = timeSinceActivity > STALE_THRESHOLD;
        const isLongLived = connectionAge > 10 * 60 * 1000; // 10+ minutes

        // Value calculation for query operations:
        // 1. Proximity to KEY (inverted distance = closer is higher value)
        const proximityToKeyScore = 1000000 / (distanceToKey.toNumber() + 1);

        // 2. Activity value (CORRECTED: long-lived + active = MOST valuable)
        let activityValue;
        if (isLongLived && isActive) {
          // Stable server: long-lived with recent activity = HIGHEST value
          activityValue = 50000 + messageCount * 100;
        } else if (isActive) {
          // Recently active but not long-lived yet = good value
          activityValue = 20000 + messageCount * 50;
        } else if (isStale) {
          // Truly stale = negative value (should be removed)
          activityValue = -10000;
        } else {
          // Connected but idle = neutral/low value (safe to temporarily disconnect)
          activityValue = 1000;
        }

        // 3. Bucket diversity bonus
        const diversityBonus = bucketIndex > 0 ? bucketIndex * 500 : 0;

        return {
          peerId,
          distanceToKey: distanceToKey.toNumber(),
          bucketIndex,
          lastSeen,
          messageCount,
          connectionAge,
          timeSinceActivity,
          isActive,
          isStale,
          isLongLived,
          value: proximityToKeyScore + activityValue + diversityBonus
        };
      } catch (error) {
        return null;
      }
    }).filter(v => v !== null)
      .sort((a, b) => a.value - b.value); // Lowest value first (far from key + inactive)

    if (connectionValues.length === 0) {
      return false;
    }

    // Calculate value of the query node (node we need to connect to)
    const queryNode = this.routingTable.getNode(queryNodePeerId);
    if (!queryNode) {
      console.warn(`⚠️ Query node ${queryNodePeerId.substring(0, 8)}... not in routing table, cannot evaluate for pruning`);
      return false;
    }

    const queryDistanceToKey = queryNode.id.xorDistance(keyId);
    const queryProximityScore = 1000000 / (queryDistanceToKey.toNumber() + 1);
    const queryValue = queryProximityScore + 20000; // New query connection gets good activity score

    // Find least valuable existing connection
    const leastValuable = connectionValues[0];

    // Only prune if query node is significantly more valuable (2x threshold)
    // This protects stable long-lived connections from being pruned unnecessarily
    if (queryValue > leastValuable.value * 2.0) {
      const shouldRemoveFromRoutingTable = leastValuable.isStale;

      console.log(`🔄 Query pruning: Dropping ${leastValuable.peerId.substring(0, 8)}... (value: ${leastValuable.value.toFixed(0)}, ${leastValuable.isActive ? 'active' : 'inactive'}, ${leastValuable.isLongLived ? 'long-lived' : 'recent'}) for query node ${queryNodePeerId.substring(0, 8)}... (value: ${queryValue.toFixed(0)}, close to key)`);

      // Gracefully close old connection
      const node = this.routingTable.getNode(leastValuable.peerId);
      if (node?.connectionManager) {
        try {
          await node.connectionManager.disconnect(leastValuable.peerId);

          // IMPORTANT: Only remove from routing table if truly stale/broken
          // Healthy peers that are just not needed for this query should stay in routing table
          if (shouldRemoveFromRoutingTable) {
            console.log(`📋 Removing ${leastValuable.peerId.substring(0, 8)}... from routing table (truly stale: ${(leastValuable.timeSinceActivity / 60000).toFixed(1)}min since activity)`);
            this.routingTable.removeNode(leastValuable.peerId);
          } else {
            console.log(`📋 Keeping ${leastValuable.peerId.substring(0, 8)}... in routing table (healthy but idle, can reconnect later)`);
          }

          return true;
        } catch (error) {
          console.error(`Failed to prune connection to ${leastValuable.peerId}:`, error);
          return false;
        }
      }
    }

    console.log(`✅ Query pruning: Keeping current connections - query node (value: ${queryValue.toFixed(0)}) not critical enough vs ${leastValuable.peerId.substring(0, 8)}... (value: ${leastValuable.value.toFixed(0)})`);
    return false;
  }

  /**
   * Maintain strategic connections across diverse buckets
   * Replaces random connection attempts with strategic diversity-focused approach
   */
  async maintainStrategicConnections() {
    const currentConnections = this.getConnectedPeers().length;
    const maxConnections = this.transportOptions.maxConnections;

    console.log(`🎯 Maintaining strategic connections (${currentConnections}/${maxConnections})`);

    // If we're at limit, check if we should upgrade any connections
    if (currentConnections >= maxConnections) {
      console.log(`✅ Connection budget full (${currentConnections}/${maxConnections})`);

      // Analyze if we have poor bucket coverage that justifies pruning
      const bucketCoverage = this.analyzeBucketCoverage();
      const undercovered = bucketCoverage.filter(b => b.connections < 1 && b.availablePeers.length > 0);

      if (undercovered.length > 0) {
        console.log(`📊 Found ${undercovered.length} buckets with no connections - considering strategic upgrades`);

        // Try to upgrade connections for first few undercovered buckets
        for (const bucket of undercovered.slice(0, 3)) {
          if (bucket.availablePeers.length > 0) {
            const newPeer = bucket.availablePeers[0];
            const slotFreed = await this.pruneConnectionForBetterPeer(newPeer, bucket.index);

            if (slotFreed) {
              // Connect to the new peer
              try {
                await this.connectToPeer(newPeer.id.toString());
                console.log(`✅ Upgraded connection for bucket ${bucket.index}`);
              } catch (error) {
                console.error(`Failed to connect to upgraded peer:`, error);
              }
            }
          }
        }
      }

      return;
    }

    // Find buckets with poor coverage
    const bucketCoverage = this.analyzeBucketCoverage();
    const undercovered = bucketCoverage.filter(b => {
      const targetConnections = this.maxBucketConnections || 2;
      return b.connections < targetConnections && b.availablePeers.length > 0;
    });

    if (undercovered.length === 0) {
      console.log(`✅ All buckets have good coverage`);
      return;
    }

    console.log(`📊 Found ${undercovered.length} undercovered buckets`);

    // Connect to strategic peers from undercovered buckets
    const peersToConnect = [];
    for (const bucket of undercovered) {
      const needed = Math.min(
        (this.maxBucketConnections || 2) - bucket.connections,
        bucket.availablePeers.length
      );
      peersToConnect.push(...bucket.availablePeers.slice(0, needed));

      // Don't exceed available connection slots
      if (peersToConnect.length >= maxConnections - currentConnections) {
        break;
      }
    }

    const toConnect = peersToConnect.slice(0, maxConnections - currentConnections);

    if (toConnect.length > 0) {
      console.log(`🎯 Connecting to ${toConnect.length} strategic peers for bucket diversity`);

      for (const peer of toConnect) {
        try {
          await this.connectToPeer(peer.id.toString());
        } catch (error) {
          console.error(`Failed to connect to strategic peer ${peer.id.toString().substring(0, 8)}:`, error);
        }
      }
    }
  }

  /**
   * Connect to a specific peer (wrapper for connectToPeerViaDHT)
   * @param {string} peerId - Peer ID to connect to
   */
  async connectToPeer(peerId) {
    // Check connection limits
    if (!(await this.shouldConnectToPeer(peerId))) {
      return false;
    }

    // Use existing connection method
    return await this.connectToPeerViaDHT(peerId);
  }

  /**
   * Get or create DHTNode with connection manager for peer
   * @param {string} peerId - Peer ID
   * @param {object} metadata - Optional peer metadata
   * @returns {DHTNode} Node with connection manager
   */
  getOrCreatePeerNode(peerId, metadata = {}) {
    // Initialize peerNodes Map if needed
    if (!this.peerNodes) {
      this.peerNodes = new Map();
    }

    let peerNode = this.routingTable.getNode(peerId);
    if (!peerNode) {
      peerNode = new DHTNode(peerId);
      // Store metadata on the node
      for (const [key, value] of Object.entries(metadata)) {
        peerNode.setMetadata(key, value);
      }

      // CRITICAL: Add to routing table if we have metadata (discovered peer)
      // Node will have connection = null until k-bucket maintenance connects
      if (Object.keys(metadata).length > 0) {
        console.log(`📋 Adding discovered peer ${peerId.substring(0, 8)}... to routing table with metadata (not yet connected)`);
        this.routingTable.addNode(peerNode);
      }
      // If no metadata, wait for actual connection via peerConnected event
    }

    // CRITICAL FIX: Always store in peerNodes Map for connection management
    this.peerNodes.set(peerId, peerNode);

    // Create connection manager if not exists
    if (!peerNode.connectionManager) {
      // CRITICAL: Only reuse serverConnectionManager if peer already connected via server
      // For new outgoing connections, create a dedicated client connection manager
      // REFACTORED: With single-connection architecture, check both isConnected() and peerId match
      const isAlreadyConnectedViaServer = this.serverConnectionManager &&
                                           this.serverConnectionManager.isConnected() &&
                                           this.serverConnectionManager.peerId === peerId;

      if (isAlreadyConnectedViaServer) {
        // Peer already connected via our WebSocket server - reuse server manager
        console.log(`🔗 Reusing server connection manager for already-connected peer ${peerId.substring(0, 8)}...`);
        peerNode.connectionManager = this.serverConnectionManager;

        // CRITICAL: Set up event handler for server connection manager too
        if (this.connectionManagerEventHandler && !this.serverEventHandlerAttached) {
          this.serverConnectionManager.on('peerConnected', this.connectionManagerEventHandler);
          this.serverEventHandlerAttached = true;
          console.log(`🔗 Event handler attached to server connection manager`);
        }
      } else {
        // Create new CLIENT connection manager for outgoing connections
        // CRITICAL: Pass DHTNode's metadata directly - routing table is single source of truth
        console.log(`🔗 Creating CLIENT connection manager for outgoing connection to ${peerId.substring(0, 8)}...`);
        peerNode.connectionManager = ConnectionManagerFactory.getManagerForPeer(peerId, peerNode.metadata);

        // CRITICAL: Initialize connection manager with local node ID
        peerNode.connectionManager.initialize(this.localNodeId.toString());

        // CRITICAL: Set up event handler for peerConnected events (only once)
        if (this.connectionManagerEventHandler && !peerNode.connectionManager._dhtEventHandlersAttached) {
          peerNode.connectionManager.on('peerConnected', this.connectionManagerEventHandler);
          console.log(`🔗 Event handler attached to ${peerNode.connectionManager.constructor.name} for ${peerId.substring(0, 8)}`);

          // CRITICAL: Set up event handler for metadata updates (WebRTC handshakes)
          peerNode.connectionManager.on('metadataUpdated', (event) => {
            console.log(`📋 Updating routing table metadata for ${event.peerId.substring(0, 8)}`);
            const node = this.routingTable.getNode(event.peerId);
            if (node) {
              // Update the routing table node with the new metadata
              for (const [key, value] of Object.entries(event.metadata)) {
                node.setMetadata(key, value);
                console.log(`📋 Updated routing table: ${key}=${value} for ${event.peerId.substring(0, 8)}`);
              }
            }
          });

          // Mark that event handlers are attached to prevent duplicates
          peerNode.connectionManager._dhtEventHandlersAttached = true;

          // CRITICAL: Let RoutingTable set up WebRTC signal handler (proper separation of concerns)
          // RoutingTable owns connection management, not DHT
          this.routingTable.setupConnectionManagerHandlers(peerNode.connectionManager, peerId);
        } else if (peerNode.connectionManager._dhtEventHandlersAttached) {
          console.log(`🔄 Reusing existing event handlers for ${peerId.substring(0, 8)} (already attached)`);
        }
      }

      // CRITICAL: Set up DHT signaling callback for connection requests (connection-agnostic)
      if (typeof peerNode.connectionManager.setDHTSignalingCallback === 'function') {
        peerNode.connectionManager.setDHTSignalingCallback(async (method, targetPeer, connectionInfo) => {
          if (method === 'sendConnectionRequest') {
            return await this.sendConnectionRequest(targetPeer, connectionInfo);
          } else {
            console.warn(`Unknown DHT signaling method: ${method}`);
          }
        });
      }

      // CRITICAL: Set up DHT message event listener for ALL connection managers (only if not already attached)
      if (!peerNode.connectionManager._dhtMessageHandlerAttached) {
        peerNode.connectionManager.on('dhtMessage', ({ peerId: msgPeerId, message }) => {
          this.handlePeerMessage(msgPeerId, message);
        });
        peerNode.connectionManager._dhtMessageHandlerAttached = true;
        console.log(`📨 DHT message handler attached for ${peerId.substring(0, 8)}`);
      }

      // NOTE: Signal handling removed - WebRTC signaling should be handled by WebRTCConnectionManager itself,
      // not by DHT. WebSocketConnectionManager doesn't emit signals anyway.
      // TODO: Move WebRTC signaling logic into WebRTCConnectionManager where it belongs.

      // CRITICAL: Transfer metadata to connection manager's local store
      // This ensures metadata is available during handshakes
      if (peerNode.metadata && Object.keys(peerNode.metadata).length > 0 && peerNode.connectionManager.localMetadataStore) {
        peerNode.connectionManager.localMetadataStore.set(peerId, peerNode.metadata);
      }
    }

    return peerNode;
  }

  /**
   * Send request and wait for response
   * NOTE: Reduced timeout to 10s for faster failure detection on localhost
   * (30s was causing test script to hang during node setup)
   */
  async sendRequestWithResponse(peerId, message, timeout = 10000) {
    // CRITICAL: Never send requests to ourselves
    if (peerId === this.localNodeId.toString()) {
      throw new Error(`Cannot send ${message.type} request to self: ${peerId}`);
    }

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(message.requestId);
        reject(new Error(`Request timeout for ${message.type}`));
      }, timeout);

      this.pendingRequests.set(message.requestId, {
        resolve: (response) => {
          clearTimeout(timeoutHandle);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timeoutHandle);
          reject(error);
        }
      });

      // Send the message
      this.sendMessage(peerId, message).catch(error => {
        clearTimeout(timeoutHandle);
        this.pendingRequests.delete(message.requestId);
        reject(error);
      });
    });
  }

  /**
   * Generate unique request ID
   */
  generateRequestId() {
    return `${this.localNodeId.toString().substr(0, 8)}_${++this.requestId}`;
  }

  /**
   * Start maintenance tasks
   */
  startMaintenanceTasks() {
    // Start with aggressive refresh for new nodes, then adapt
    this.scheduleAdaptiveRefresh();

    // Periodic republish
    setInterval(() => {
      this.republishData();
    }, this.options.republishInterval / 10); // Check 10x more frequently than republish

    // Periodic cleanup of rate limiting and tracking maps
    setInterval(() => {
      this.cleanupTrackingMaps();
    }, 5 * 60 * 1000); // Every 5 minutes

    // Periodic cleanup
    setInterval(() => {
      this.cleanup();
    }, this.options.expireInterval / 10);

    // Periodic ping
    setInterval(() => {
      this.pingNodes();
    }, this.options.pingInterval);

    // Background maintenance: Connect to routing table entries (every 30 seconds)
    // This ensures routing_table_size == active_connections (Kademlia compliance)
    setInterval(() => {
      this.maintainRoutingTableConnections();
    }, 30 * 1000); // 30 seconds
  }

  /**
   * Schedule adaptive refresh based on network connectivity
   */
  scheduleAdaptiveRefresh() {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    const connectedPeers = this.getConnectedPeers().length;
    const routingNodes = this.routingTable.getAllNodes().length;

    // Determine appropriate refresh interval based on connectivity
    let nextInterval;
    if (connectedPeers < 3 || routingNodes < 4) {
      // New/isolated node - aggressive discovery for mesh formation
      nextInterval = this.options.aggressiveRefreshInterval;
      console.log(`🚀 Aggressive refresh mode: ${nextInterval/1000}s (${connectedPeers} peers, ${routingNodes} routing)`);
    } else if (connectedPeers < 5 || routingNodes < 8) {
      // Moderately connected - medium interval
      nextInterval = this.options.refreshInterval;
      console.log(`⚡ Medium refresh mode: ${nextInterval/1000}s (${connectedPeers} peers, ${routingNodes} routing)`);
    } else {
      // Well connected - standard Kademlia timing
      nextInterval = this.options.standardRefreshInterval;
      console.log(`🐌 Standard refresh mode: ${nextInterval/1000}s (${connectedPeers} peers, ${routingNodes} routing)`);
    }

    this.currentRefreshInterval = nextInterval;

    this.refreshTimer = setTimeout(() => {
      this.performAdaptiveRefresh();
    }, nextInterval);
  }

  /**
   * Perform Kademlia-compliant bucket refresh with staleness tracking
   */
  async performAdaptiveRefresh() {
    await this.refreshStaleBuckets();

    // Background process: Connect to unconnected nodes in routing table
    await this.connectToUnconnectedRoutingNodes();

    // Schedule next refresh
    this.scheduleAdaptiveRefresh();
  }

  /**
   * Refresh buckets following proper Kademlia staleness rules
   */
  async refreshStaleBuckets() {
    const connectedPeers = this.getConnectedPeers().length;
    const routingNodes = this.routingTable.getAllNodes().length;
    const now = Date.now();

    console.log(`🔄 Checking stale buckets: ${connectedPeers} connected, ${routingNodes} routing`);

    // Track bucket activity during lookups (this should be called from findNode)
    this.updateBucketActivity();

    // For new/isolated nodes, be more aggressive to enable mesh formation
    // CRITICAL: Nodes with only 1-2 connections need to actively discover more peers
    if (connectedPeers < 3 && routingNodes < 4) {
      console.log(`🆘 Emergency peer discovery - insufficient peers for mesh (${connectedPeers} connected, ${routingNodes} routing)`);
      await this.emergencyPeerDiscovery();
      return;
    }

    // Standard Kademlia: only refresh buckets that haven't been active
    const staleBuckets = this.findStaleBuckets(now);

    if (staleBuckets.length === 0) {
      console.log(`✅ All buckets fresh - no refresh needed`);
      return;
    }

    console.log(`🔍 Refreshing ${staleBuckets.length} stale buckets`);

    // Refresh stale buckets by doing lookups in their ranges
    const refreshPromises = staleBuckets.map(async (bucketIndex) => {
      const randomId = this.generateRandomIdForBucket(bucketIndex);
      console.log(`🎲 Refreshing bucket ${bucketIndex} with random lookup`);

      try {
        const discoveredNodes = await this.findNode(randomId);
        console.log(`📋 Bucket ${bucketIndex} refresh discovered ${discoveredNodes.length} nodes`);
        // Mark bucket as refreshed
        this.bucketLastActivity.set(bucketIndex, now);
      } catch (error) {
        console.warn(`Failed to refresh bucket ${bucketIndex}:`, error);
      }
    });

    await Promise.allSettled(refreshPromises);

    // CRITICAL: After refreshing buckets, attempt connections to newly discovered peers
    // This ensures findNode discoveries translate into actual DHT connections
    await this.connectToRecentlyDiscoveredPeers();
  }

  /**
   * Find buckets that haven't been active within the staleness threshold
   */
  findStaleBuckets(now) {
    const staleBuckets = [];
    const stalenessThreshold = this.currentRefreshInterval * 2; // 2x current interval

    // Check each bucket for staleness
    for (let i = 0; i < this.routingTable.buckets.length; i++) {
      const bucket = this.routingTable.buckets[i];

      // Skip empty buckets
      if (bucket.size() === 0) continue;

      const lastActivity = this.bucketLastActivity.get(i) || 0;
      const timeSinceActivity = now - lastActivity;

      if (timeSinceActivity > stalenessThreshold) {
        staleBuckets.push(i);
        console.log(`🕰️ Bucket ${i} stale: ${Math.round(timeSinceActivity/1000)}s since activity`);
      }
    }

    return staleBuckets;
  }

  /**
   * Generate random ID that would fall into specific bucket
   */
  generateRandomIdForBucket(bucketIndex) {
    // Generate ID at appropriate distance for this bucket
    return DHTNodeId.generateAtDistance(this.localNodeId, bucketIndex);
  }

  /**
   * Update bucket activity tracking when lookups occur
   */
  updateBucketActivity() {
    // This should be called from findNode to track which buckets are being used
    const now = Date.now();
    const connectedPeers = this.getConnectedPeers();

    // Mark buckets containing connected peers as active
    for (const peerId of connectedPeers) {
      try {
        // CRITICAL: peerId is already a hex string from node.id.toString(), use fromHex() not fromString()
        const peerNodeId = DHTNodeId.fromHex(peerId);
        const bucketIndex = this.routingTable.getBucketIndex(peerNodeId);
        this.bucketLastActivity.set(bucketIndex, now);
      } catch (error) {
        // Ignore invalid peer IDs
      }
    }
  }

  /**
   * Emergency discovery for new/isolated nodes
   */
  async emergencyPeerDiscovery() {
    const connectedPeers = this.getConnectedPeers().length;
    const routingNodes = this.routingTable.getAllNodes().length;

    // CRITICAL: If we have ZERO connections, attempt bootstrap reconnection immediately
    // This handles sleep/wake scenarios where all connections were lost
    if (connectedPeers === 0 && routingNodes === 0) {
      console.log('🆘 ZERO connections detected - attempting bootstrap reconnection');

      if (this.bootstrap) {
        // Re-enable bootstrap auto-reconnect for recovery
        this.bootstrap.enableAutoReconnect();

        // Reconnect to bootstrap if not already connected
        if (!this.bootstrap.isBootstrapConnected()) {
          console.log('🔄 Reconnecting to bootstrap server for network recovery...');
          try {
            await this.bootstrap.connect(this.localNodeId.toString(), {
              publicKey: this.keyPair?.publicKey,
              isNative: this.keyPair?.isNative,
              membershipToken: this._membershipToken, // Include membership token for reconnection
              ...this.bootstrapMetadata
            });
            console.log('✅ Bootstrap reconnection successful - waiting for peer discovery');

            // Give bootstrap time to coordinate reconnection
            await new Promise(resolve => setTimeout(resolve, 2000));

            // After bootstrap reconnection, request peers
            if (this._membershipToken) {
              console.log('🔍 Requesting peer list from bootstrap with membership token');
              // Bootstrap should now help us reconnect to the DHT network
            }
          } catch (error) {
            console.error('❌ Failed to reconnect to bootstrap:', error);
          }
        } else {
          console.log('✅ Already connected to bootstrap - requesting peer coordination');
        }
      } else {
        console.warn('⚠️ No bootstrap client available for reconnection');
      }

      // Don't throttle when we have zero connections - we need to recover ASAP
      // Skip the normal throttling logic and continue with discovery
    }

    // Throttle emergency discovery to prevent excessive find_node requests
    // BUT: Allow more frequent attempts when we have very few connections
    if (!this.lastEmergencyDiscovery) {
      this.lastEmergencyDiscovery = 0;
    }

    const now = Date.now();
    const timeSinceLastEmergency = now - this.lastEmergencyDiscovery;

    // Adaptive throttling: shorter interval for fewer peers
    let emergencyInterval;
    if (connectedPeers === 0) {
      emergencyInterval = 30 * 1000; // 30 seconds when completely disconnected
    } else if (connectedPeers < 2) {
      emergencyInterval = 2 * 60 * 1000; // 2 minutes with 1 peer
    } else {
      emergencyInterval = 10 * 60 * 1000; // 10 minutes with 2+ peers
    }

    if (timeSinceLastEmergency < emergencyInterval && connectedPeers > 0) {
      console.log(`🚫 Throttling emergency discovery (${Math.round((emergencyInterval - timeSinceLastEmergency) / 1000)}s remaining)`);
      return;
    }

    this.lastEmergencyDiscovery = now;
    console.log(`🚨 Emergency peer discovery mode (${connectedPeers} connected, ${routingNodes} routing)`);

    // Use direct peer discovery first (more efficient)
    await this.discoverPeersViaDHT();

    // REDUCED: Only 1 targeted search for emergency to prevent find_node spam
    const maxSearches = 1;
    const targetDistances = [80]; // Single search in middle of key space
    const searchPromises = [];

    for (let i = 0; i < Math.min(maxSearches, targetDistances.length); i++) {
      const distance = targetDistances[i];
      const randomId = DHTNodeId.generateAtDistance(this.localNodeId, distance);

      // CRITICAL: Don't use emergency bypass to prevent rate limit violations
      searchPromises.push(
        this.findNode(randomId, { emergencyBypass: false }).catch(error => {
          console.warn(`Emergency search failed for distance ${distance}:`, error);
        })
      );
    }

    if (searchPromises.length > 0) {
      console.log(`🔍 Running ${searchPromises.length} emergency searches...`);
      await Promise.allSettled(searchPromises);

      // CRITICAL: After emergency discovery, attempt connections to newly found peers
      await this.connectToRecentlyDiscoveredPeers();
    }
  }

  /**
   * Legacy method - now uses adaptive refresh
   * @deprecated Use scheduleAdaptiveRefresh() instead
   */
  async refreshBuckets() {
    const connectedPeers = this.getConnectedPeers().length;
    const routingNodes = this.routingTable.getAllNodes().length;

    console.log(`🔄 Refreshing k-buckets: ${connectedPeers} connected, ${routingNodes} in routing table`);

    // THROTTLE: Skip refresh if we have enough connections and recent activity
    const lastBucketRefresh = this.lastBucketRefreshTime || 0;
    const timeSinceLastRefresh = Date.now() - lastBucketRefresh;
    const hasRecentActivity = timeSinceLastRefresh < 120000; // 2 minutes

    if (connectedPeers >= 3 && routingNodes >= 5 && hasRecentActivity) {
      console.log(`⏸️ Skipping bucket refresh - sufficient peers (${connectedPeers} connected, ${routingNodes} routing) and recent activity`);
      return;
    }

    this.lastBucketRefreshTime = Date.now();

    // REDUCED: Only use direct peer discovery, no random searches unless emergency
    await this.discoverPeersViaDHT();

    // EMERGENCY ONLY: Random searches only if we have very few peers
    if (connectedPeers < 2 || routingNodes < 3) {
      console.log(`🆘 Emergency peer discovery - very few peers (${connectedPeers} connected, ${routingNodes} routing)`);

      // REDUCED: Only 3-5 targeted searches instead of up to 48
      const maxSearches = 3;
      const searchPromises = [];

      // Target specific distance ranges instead of random
      const targetDistances = [1, 32, 80, 120, 159]; // Spread across key space

      for (let i = 0; i < Math.min(maxSearches, targetDistances.length); i++) {
        const distance = targetDistances[i];
        const randomId = DHTNodeId.generateAtDistance(this.localNodeId, distance);

        searchPromises.push(
          this.findNode(randomId).then(discoveredNodes => {
            // Add discovered peer nodes to routing table during k-bucket maintenance
            for (const node of discoveredNodes) {
              const peerId = node.id.toString();

              // CRITICAL: Never add our own node ID to routing table
              if (peerId === this.localNodeId.toString()) {
                continue;
              }

              // CRITICAL: Never add the random search target ID as a real peer
              if (peerId === randomId.toString()) {
                console.warn(`🚫 Skipping random target ID that was mistakenly returned as discovered peer: ${peerId}`);
                continue;
              }

              // Only add valid DHT peers that aren't already in routing table and not in backoff
              if (this.isValidDHTPeer(peerId) && !this.routingTable.getNode(peerId)) {
                // Check if peer is in failure backoff
                const backoffUntil = this.peerFailureBackoff.get(peerId);
                if (backoffUntil && Date.now() < backoffUntil) {
                  console.log(`⏳ Skipping peer ${peerId} in failure backoff until ${new Date(backoffUntil).toISOString()}`);
                  continue;
                }

                const addResult = this.routingTable.addNode(node);
                if (addResult) {
                  console.log(`📋 Emergency discovery found peer: ${peerId}`);
                }
              }
            }
            return discoveredNodes;
          }).catch(_error => {
            // Suppress individual bucket refresh errors
          })
        );
      }

      // Wait for all searches to complete
      if (searchPromises.length > 0) {
        console.log(`🔍 Running ${searchPromises.length} emergency DHT searches...`);
        await Promise.allSettled(searchPromises);
      }
    } else {
      console.log(`✅ Sufficient peers - skipping random searches`);
    }

    // Perform dedicated peer discovery for k-bucket maintenance
    if (!this.useBootstrapForSignaling) {
      await this.discoverPeers();
    }

    const newConnectedPeers = this.getConnectedPeers().length;
    const newRoutingNodes = this.routingTable.getAllNodes().length;

    // Only log if there were changes
    if (newConnectedPeers !== connectedPeers || newRoutingNodes !== routingNodes) {
      console.log(`🔄 Bucket refresh: ${newConnectedPeers} peers (+${newConnectedPeers - connectedPeers}), ${newRoutingNodes} routing (+${newRoutingNodes - routingNodes})`);
    }
  }

  /**
   * DEVELOPER/TESTING: Manually trigger aggressive bucket refresh for immediate peer discovery
   */
  async triggerPeerDiscovery() {
    console.log('🔍 Manual peer discovery started - using DHT messaging');

    // Use new DHT messaging for peer discovery
    await this.discoverPeersViaDHT();

    // Also do traditional node searches for broader discovery
    const searchPromises = [];
    for (let i = 0; i < 160; i += 5) { // Search every 5th bit distance
      const randomId = DHTNodeId.generateAtDistance(this.localNodeId, i);
      searchPromises.push(
        this.findNode(randomId).then(discoveredNodes => {
          // Add discovered peer nodes to routing table during manual discovery
          for (const node of discoveredNodes) {
            const peerId = node.id.toString();

            // CRITICAL: Never add our own node ID to routing table
            if (peerId === this.localNodeId.toString()) {
              continue;
            }

            // CRITICAL: Never add the random search target ID as a real peer
            if (peerId === randomId.toString()) {
              console.warn(`🚫 Skipping random target ID that was mistakenly returned as discovered peer (manual discovery): ${peerId}`);
              continue;
            }

            // Only add valid DHT peers that aren't already in routing table and not in backoff
            if (this.isValidDHTPeer(peerId) && !this.routingTable.getNode(peerId)) {
              // Check if peer is in failure backoff
              const backoffUntil = this.peerFailureBackoff.get(peerId);
              if (backoffUntil && Date.now() < backoffUntil) {
                console.log(`⏳ Skipping peer ${peerId} in failure backoff (manual discovery)`);
                continue;
              }

              const addResult = this.routingTable.addNode(node);
              if (addResult) {
                console.log(`🔍 Manual discovery found peer: ${peerId}`);
              }
            }
          }
          return discoveredNodes;
        }).catch(_error => {
        })
      );

      // Limit concurrent searches
      if (searchPromises.length >= 10) {
        await Promise.allSettled(searchPromises);
        searchPromises.length = 0;
      }
    }

    // Wait for remaining searches
    if (searchPromises.length > 0) {
      await Promise.allSettled(searchPromises);
    }

    console.log('🔍 Manual peer discovery completed');

    // Force connection attempts to discovered peers
    await this.discoverPeers();
  }

  /**
   * Lightweight method to connect to recently discovered peers
   * Does NOT do additional discovery - just connects to existing routing table entries
   */
  async connectToRecentlyDiscoveredPeers() {
    // Use strategic connection maintenance instead of random selection
    await this.maintainStrategicConnections();
  }

  /**
   * Dedicated peer discovery for k-bucket maintenance
   * This method discovers and validates actual peer nodes (not storage keys or random IDs)
   */
  async discoverPeers() {
    const allNodes = this.routingTable.getAllNodes();
    const unconnectedPeers = allNodes.filter(node =>
      !this.isPeerConnected(node.id.toString())
    );

    if (unconnectedPeers.length > 0) {
      console.log(`🔍 Discovering ${unconnectedPeers.length} unconnected peers`);
    }

    // Limit concurrent connection attempts
    const maxConcurrent = 3;
    const toConnect = unconnectedPeers.slice(0, maxConcurrent);

    for (const node of toConnect) {
      const peerId = node.id.toString();

      // CRITICAL: Validate this is actually a peer node, not a storage key or random ID
      if (!this.isValidDHTPeer(peerId)) {
        console.warn(`🚫 Skipping invalid DHT peer during discovery: ${peerId}`);
        // Remove invalid peer from routing table
        this.routingTable.removeNode(peerId);
        continue;
      }

      // Additional validation: Check if this peer has recent activity
      if (node.lastSeen && (Date.now() - node.lastSeen) > (60 * 60 * 1000)) { // 1 hour old
        console.warn(`🕐 Skipping stale peer during discovery: ${peerId} (last seen ${new Date(node.lastSeen).toISOString()})`);
        continue;
      }

      try {
        console.log(`🤝 Attempting to connect to discovered peer: ${peerId}`);
        await this.connectToPeerViaDHT(peerId);
      } catch (error) {
        console.warn(`❌ Failed to connect to discovered peer ${peerId}:`, error.message);
      }
    }

    console.log('✅ Peer discovery completed');
  }

  /**
   * Queue peer for immediate connection attempt (non-blocking)
   */
  queuePeerForConnection(peerId) {
    this.peerConnectionQueue.add(peerId);
    console.log(`🚀 Queued peer ${peerId.substring(0, 8)}... for connection (queue: ${this.peerConnectionQueue.size})`);

    // Process queue asynchronously without blocking
    this.processConnectionQueue();
  }

  /**
   * Process peer connection queue asynchronously
   */
  async processConnectionQueue() {
    // Prevent multiple queue processors running simultaneously
    if (this.processingConnectionQueue || this.peerConnectionQueue.size === 0) {
      return;
    }

    this.processingConnectionQueue = true;

    // Use setTimeout to make this truly non-blocking
    setTimeout(async () => {
      try {
        const peers = Array.from(this.peerConnectionQueue);
        this.peerConnectionQueue.clear();

        console.log(`🔗 Processing ${peers.length} queued peer connections...`);

        // Process connections with concurrency limit
        const maxConcurrent = 3;
        for (let i = 0; i < peers.length; i += maxConcurrent) {
          const batch = peers.slice(i, i + maxConcurrent);

          await Promise.allSettled(
            batch.map(async (peerId) => {
              try {
                if (!this.isPeerConnected(peerId)) {
                  console.log(`🔗 Connecting to queued peer: ${peerId.substring(0, 8)}...`);
                  await this.connectToPeerViaDHT(peerId);
                }
              } catch (error) {
                console.warn(`⚠️ Queued connection failed for ${peerId.substring(0, 8)}...: ${error.message}`);
              }
            })
          );
        }
      } catch (error) {
        console.error('Error processing connection queue:', error);
      } finally {
        this.processingConnectionQueue = false;
      }
    }, 10); // Small delay to avoid blocking find_node processing
  }

  /**
   * Maintain connections to routing table entries (Kademlia compliance)
   * Ensures routing_table_size == active_connections
   * Called every 30 seconds from startMaintenanceTasks()
   */
  async maintainRoutingTableConnections() {
    try {
      const allNodes = this.routingTable.getAllNodes();
      const connectedPeers = this.getConnectedPeers();
      const unconnectedNodes = allNodes.filter(node => {
        const peerId = node.id.toString();
        return !connectedPeers.includes(peerId);
      });

      console.log(`🔧 Routing table maintenance: ${connectedPeers.length} connected, ${allNodes.length} in table, ${unconnectedNodes.length} unconnected`);

      // Try to connect to unconnected nodes
      for (const node of unconnectedNodes.slice(0, 5)) { // Limit to 5 per cycle
        const peerId = node.id.toString();

        // Initialize failure tracking
        if (!this.connectionFailureCount) {
          this.connectionFailureCount = new Map();
        }

        // Skip if already has too many failures
        const failures = this.connectionFailureCount.get(peerId) || 0;
        if (failures >= 3) {
          console.log(`🗑️ Removing ${peerId.substring(0, 8)}... from routing table after ${failures} failed connection attempts`);
          this.routingTable.removeNode(node.id);
          this.connectionFailureCount.delete(peerId);
          continue;
        }

        try {
          // Check if we should connect (respects connection limits)
          if (!this.isPeerConnected(peerId) && await this.shouldConnectToPeer(peerId)) {
            console.log(`🔗 Attempting connection to routing table entry: ${peerId.substring(0, 8)}... (${failures} previous failures)`);
            await this.connectToPeerViaDHT(peerId);
            // Success - reset failure count
            this.connectionFailureCount.delete(peerId);
          }
        } catch (error) {
          // Track failure
          this.connectionFailureCount.set(peerId, failures + 1);
          console.warn(`⚠️ Connection attempt ${failures + 1}/3 failed for ${peerId.substring(0, 8)}...: ${error.message}`);
        }
      }
    } catch (error) {
      console.error('Error in routing table connection maintenance:', error);
    }
  }

  /**
   * Background process to connect to unconnected nodes in routing table
   * This is called periodically during adaptive refresh
   */
  async connectToUnconnectedRoutingNodes() {
    // Adaptive throttling based on network size
    if (!this.lastBackgroundConnectionAttempt) {
      this.lastBackgroundConnectionAttempt = 0;
    }

    const now = Date.now();
    const timeSinceLastAttempt = now - this.lastBackgroundConnectionAttempt;

    // Adaptive interval: smaller networks = faster connection attempts
    // Small networks (<10 peers): 10 seconds - fast mesh formation
    // Medium networks (10-50 peers): 30 seconds - balanced
    // Large networks (>50 peers): 2 minutes - conservative to avoid overhead
    const routingTableSize = this.routingTable.getAllNodes().length;
    let minInterval;
    if (routingTableSize < 10) {
      minInterval = 10 * 1000; // 10 seconds for small networks
    } else if (routingTableSize < 50) {
      minInterval = 30 * 1000; // 30 seconds for medium networks
    } else {
      minInterval = 2 * 60 * 1000; // 2 minutes for large networks
    }

    if (timeSinceLastAttempt < minInterval) {
      console.log(`🚫 Throttling background connection attempts (${Math.round((minInterval - timeSinceLastAttempt) / 1000)}s remaining, network size: ${routingTableSize})`);
      return;
    }

    this.lastBackgroundConnectionAttempt = now;

    const allNodes = this.routingTable.getAllNodes();
    const connectedPeers = this.getConnectedPeers();
    const unconnectedNodes = allNodes.filter(node => {
      const peerId = node.id.toString();
      return !this.isPeerConnected(peerId) &&
             !this.peerFailureBackoff.has(peerId); // Skip nodes in backoff
    });

    if (unconnectedNodes.length === 0) {
      return; // Nothing to do
    }

    console.log(`🔗 Background process: Found ${unconnectedNodes.length} unconnected nodes in routing table`);

    // Prioritize connection attempts:
    // 1. Nodes closest to us (for better routing table coverage)
    // 2. Limit concurrent attempts to avoid overwhelming the network
    const sortedNodes = unconnectedNodes
      .map(node => ({
        node,
        distance: node.id.xorDistance(this.localNodeId)
      }))
      .sort((a, b) => a.distance.compare(b.distance))
      .slice(0, 3); // Limit to 3 concurrent attempts

    const connectionPromises = sortedNodes.map(async ({ node }) => {
      const peerId = node.id.toString();

      try {
        // CRITICAL: Don't interfere with pending WebRTC coordination
        if (this.pendingWebRTCOffers && this.pendingWebRTCOffers.has(peerId)) {
          console.log(`🚫 Skipping background connection for ${peerId.substring(0, 8)}... - WebRTC coordination in progress`);
          return;
        }

        // Check discovery grace period - give newly discovered nodes time to initialize
        const timeSinceDiscovery = Date.now() - node.lastSeen;
        if (timeSinceDiscovery < this.discoveryGracePeriod) {
          const timeLeft = Math.ceil((this.discoveryGracePeriod - timeSinceDiscovery) / 1000);
          console.log(`⏳ Skipping connection to ${peerId.substring(0, 8)}... - in discovery grace period (${timeLeft}s remaining)`);
          return;
        }

        // Check if node has connection metadata before attempting connection
        const metadata = node.metadata;
        if (!metadata || (!metadata.listeningAddress && !metadata.endpoint)) {
          console.log(`⚠️ Skipping background connection to ${peerId.substring(0, 8)}... - no connection metadata available`);
          return;
        }

        console.log(`🔗 Background connecting to routing table node: ${peerId.substring(0, 8)}...`);
        const peerNode = this.getOrCreatePeerNode(peerId, metadata);
        // CRITICAL: Pass metadata from routing table node so connection manager has connection info
        await peerNode.connectionManager.createConnection(peerId, true, peerNode.metadata);
        console.log(`✅ Background connection successful: ${peerId.substring(0, 8)}...`);
      } catch (error) {
        console.log(`⚠️ Background connection failed for ${peerId.substring(0, 8)}...: ${error.message}`);

        // Add to failure backoff to prevent repeated attempts
        this.peerFailureBackoff.set(peerId, Date.now() + (2 * 60 * 1000)); // 2 minute backoff
      }
    });

    await Promise.allSettled(connectionPromises);
  }

  /**
   * Attempt DHT-based connections to peers in routing table (legacy method)
   * @deprecated Use discoverPeers() instead
   */
  async connectToDiscoveredPeers() {
    console.warn('⚠️ connectToDiscoveredPeers() is deprecated, use discoverPeers() instead');
    return this.discoverPeers();
  }

  /**
   * Attempt to connect to a newly discovered peer through findNode operations
   */
  async attemptConnectionToDiscoveredPeer(peerId) {
    // Skip if already connected or connecting
    if (this.isPeerConnected(peerId) || this.isPeerConnected(peerId)) {
      return;
    }

    console.log(`🔄 Attempting connection to newly discovered peer: ${peerId}`);

    try {
      // Use DHT-based connections when available, fallback to invitation system
      if (this.useBootstrapForSignaling) {
        console.log(`📞 Using bootstrap-based invitation system to connect to discovered peer: ${peerId}`);
        const success = await this.inviteNewClient(peerId);
        if (success) {
          console.log(`✅ Successfully connected to discovered peer ${peerId} via invitation`);
        } else {
          console.log(`❌ Failed to connect to discovered peer ${peerId} via invitation`);
        }
      } else {
        console.log(`🌐 Using DHT-based ICE candidate sharing to connect to discovered peer: ${peerId}`);
        // For DHT-based connections, use stored ICE candidates from DHT
        await this.connectToPeerViaDHT(peerId);
      }
    } catch (error) {
      console.warn(`Failed to connect to discovered peer ${peerId}:`, error);
    }
  }

  /**
   * Republish stored data
   */
  async republishData() {
    const now = Date.now();

    for (const [key, republishTime] of this.republishQueue.entries()) {
      if (now >= republishTime && this.storage.has(key)) {
        const stored = this.storage.get(key);
        try {
          await this.store(key, stored.value);
          this.republishQueue.set(key, now + this.options.republishInterval);
        } catch (error) {
          console.warn(`Failed to republish key ${key}:`, error);
        }
      }
    }
  }

  /**
   * Reset emergency throttling (for manual recovery)
   */
  resetEmergencyThrottle() {
    console.log('🔄 Manually resetting emergency throttle');
    this.globalMessageCount = 0;
    this.emergencyThrottleActive = false;
    this.lastSystemTime = Date.now();
  }

  /**
   * Get sleep/wake protection status
   */
  getSleepWakeStatus() {
    return {
      globalMessageCount: this.globalMessageCount,
      globalMessageLimit: this.globalMessageLimit,
      emergencyThrottleActive: this.emergencyThrottleActive,
      lastSystemTime: new Date(this.lastSystemTime).toISOString(),
      uptimeHours: Math.round((Date.now() - this.lastSystemTime) / 3600000 * 100) / 100
    };
  }

  /**
   * Clean up tracking maps to prevent memory leaks
   */
  cleanupTrackingMaps() {
    const now = Date.now();
    const fiveMinutesAgo = now - (5 * 60 * 1000);
    const tenMinutesAgo = now - (10 * 60 * 1000);

    // Clean up old find_node rate limit entries (older than 10 minutes)
    let cleaned = 0;
    for (const [peerId, timestamp] of this.findNodeRateLimit.entries()) {
      if (timestamp < tenMinutesAgo) {
        this.findNodeRateLimit.delete(peerId);
        cleaned++;
      }
    }

    // Clean up old processed messages (older than deduplication timeout)
    const deduplicationCutoff = now - this.messageDeduplicationTimeout;
    for (const [messageId, timestamp] of this.processedMessages.entries()) {
      if (timestamp < deduplicationCutoff) {
        this.processedMessages.delete(messageId);
        cleaned++;
      }
    }

    // Clean up expired peer failure backoffs
    for (const [peerId, backoffUntil] of this.peerFailureBackoff.entries()) {
      if (now > backoffUntil) {
        this.peerFailureBackoff.delete(peerId);
        cleaned++;
      }
    }

    // Clean up unsolicited response tracking for disconnected peers (MEMORY LEAK FIX)
    if (this.unsolicitedResponseCounts) {
      const connectedPeers = new Set(this.getConnectedPeers());
      for (const peerId of this.unsolicitedResponseCounts.keys()) {
        if (!connectedPeers.has(peerId)) {
          this.unsolicitedResponseCounts.delete(peerId);
          cleaned++;
        }
      }
    }

    if (cleaned > 0) {
      console.log(`🧹 Cleaned up ${cleaned} stale tracking entries`);
    }
  }

  /**
   * Clean up expired data
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;

    // Clean expired storage
    for (const [key, stored] of this.storage.entries()) {
      if (now - stored.timestamp > this.options.expireInterval) {
        this.storage.delete(key);
        this.republishQueue.delete(key);
        cleaned++;
      }
    }

    // Clean stale nodes and verify routing table consistency
    const staleRemoved = this.routingTable.removeStaleNodes();
    const routingCleanup = this.cleanupRoutingTable();
    // Note: Stale connections are cleaned up by individual connection managers

    if (cleaned > 0 || staleRemoved > 0 || routingCleanup > 0) {
      console.log(`Cleanup: ${cleaned} storage, ${staleRemoved} stale nodes, ${routingCleanup} routing inconsistencies`);
    }
  }

  /**
   * Ping nodes that need pinging
   */
  async pingNodes() {
    const nodesToPing = this.routingTable.getNodesToPing(this.options.pingInterval);

    for (const node of nodesToPing) {
      if (this.isPeerConnected(node.id.toString())) {
        await this.sendPing(node.id.toString());
      }
    }
  }

  /**
   * Get DHT statistics
   */
  getStats() {
    const connectedPeers = this.getConnectedPeers();
    const bucketCoverage = this.analyzeBucketCoverage();
    const activeBuckets = bucketCoverage.filter(b => b.connections > 0);

    return {
      nodeId: this.localNodeId.toString(),
      platform: {
        maxConnections: this.platformLimits.maxConnections,
        maxBucketConnections: this.platformLimits.maxBucketConnections,
        priorityBuckets: this.platformLimits.priorityBuckets
      },
      isStarted: this.isStarted,
      isBootstrapped: this.isBootstrapped,
      useBootstrapForSignaling: this.useBootstrapForSignaling,
      storage: {
        keys: this.storage.size,
        republishQueue: this.republishQueue.size
      },
      routing: this.routingTable.getStats(),
      connections: {
        total: connectedPeers.length,
        limit: this.transportOptions.maxConnections,
        utilization: `${(connectedPeers.length / this.transportOptions.maxConnections * 100).toFixed(1)}%`,
        bucketDiversity: activeBuckets.length,
        avgConnectionsPerBucket: activeBuckets.length > 0 ?
          (connectedPeers.length / activeBuckets.length).toFixed(1) : 0
      },
      bootstrap: this.bootstrap.getStatus()
    };
  }

  /**
   * Debug utility: Show strategic connection management status
   */
  debugStrategicConnections() {
    const bucketCoverage = this.analyzeBucketCoverage();
    const activeBuckets = bucketCoverage.filter(b => b.connections > 0);
    const undercovered = bucketCoverage.filter(b => {
      const target = this.maxBucketConnections || 2;
      return b.connections < target && b.totalNodes > 0;
    });

    console.log('\n=== Strategic Connection Management ===');
    console.log(`Platform: ${this.platformLimits.maxConnections} max connections, ${this.platformLimits.maxBucketConnections} per bucket`);
    console.log(`Connections: ${this.getConnectedPeers().length}/${this.transportOptions.maxConnections} (${(this.getConnectedPeers().length / this.transportOptions.maxConnections * 100).toFixed(1)}%)`);
    console.log(`Bucket diversity: ${activeBuckets.length}/160 buckets have connections`);
    console.log(`Undercovered buckets: ${undercovered.length}`);

    if (activeBuckets.length > 0) {
      console.log('\n--- Active Buckets ---');
      for (const bucket of activeBuckets.slice(0, 10)) {
        console.log(`  Bucket ${bucket.index}: ${bucket.connections}/${bucket.totalNodes} connected`);
      }
      if (activeBuckets.length > 10) {
        console.log(`  ... and ${activeBuckets.length - 10} more buckets`);
      }
    }

    if (undercovered.length > 0) {
      console.log('\n--- Undercovered Buckets (Growth Opportunities) ---');
      for (const bucket of undercovered.slice(0, 5)) {
        console.log(`  Bucket ${bucket.index}: ${bucket.connections}/${bucket.totalNodes} connected, ${bucket.availablePeers.length} available`);
      }
      if (undercovered.length > 5) {
        console.log(`  ... and ${undercovered.length - 5} more undercovered buckets`);
      }
    }

    console.log('=====================================\n');

    return {
      connections: this.getConnectedPeers().length,
      limit: this.transportOptions.maxConnections,
      bucketDiversity: activeBuckets.length,
      undercoveredBuckets: undercovered.length,
      activeBuckets: activeBuckets.length
    };
  }

  /**
   * Stop the DHT
   */
  async stop() {
    if (!this.isStarted) return;

    console.log('Stopping Kademlia DHT');

    // Announce independence if still using bootstrap
    if (this.useBootstrapForSignaling) {
      try {
        await this.bootstrap.announceIndependent();
      } catch (error) {
        console.warn('Failed to announce independence:', error);
      }
    }

    // Clean up components
    // Note: Individual connection managers are cleaned up with their DHTNodes
    this.bootstrap.destroy();

    // Clear data
    this.storage.clear();
    this.republishQueue.clear();
    this.pendingRequests.clear();

    // Clear phantom peer tracking
    if (this.failedOfferChecks) {
      this.failedOfferChecks.clear();
    }

    this.isStarted = false;
    this.emit('stopped');
  }

  /**
   * Handle find node response
   */
  async handleFindNodeResponse(peerId, message) {
    const request = this.pendingRequests.get(message.requestId);
    if (request) {
      this.pendingRequests.delete(message.requestId);

      // CRITICAL: Process discovered peers and add them to routing table with DHT token validation
      // This is essential for k-bucket maintenance and mesh formation
      if (message.nodes && Array.isArray(message.nodes)) {
        console.log(`📋 Processing ${message.nodes.length} discovered peers from ${peerId.substring(0, 8)}...`);

        for (const nodeInfo of message.nodes) {
          try {
            // Validate node info structure
            if (!nodeInfo.id) {
              console.error(`❌ Skipping peer with missing ID:`, nodeInfo);
              continue;
            }

            // Don't add ourselves to routing table (normal behavior, skip silently)
            if (nodeInfo.id === this.localNodeId.toString()) {
              continue;
            }

            if (!this.isValidDHTPeer(nodeInfo.id)) {
              console.error(`❌ Skipping invalid peer ID: ${nodeInfo.id}`);
              console.error(`❌   Why: hasBootstrap=${nodeInfo.id.includes('bootstrap') || nodeInfo.id.includes('server')}, hasWs=${nodeInfo.id.startsWith('ws://') || nodeInfo.id.startsWith('wss://')}, hexOk=${/^[a-f0-9]{40,}$/i.test(nodeInfo.id)}`);
              continue;
            }

            // SECURITY: Token validation moved to connection establishment
            // Validating tokens here causes message queue deadlock:
            // - find_node_response processing blocks while calling this.get() for each peer's token
            // - this.get() sends find_value requests that need the message queue
            // - Result: queue blocks waiting for itself = 30s+ delays on localhost
            //
            // Instead, tokens are validated during WebRTC handshake (see below)
            if (nodeInfo.metadata && nodeInfo.metadata.membershipToken) {
              console.log(`📋 Peer ${nodeInfo.id.substring(0, 8)}... has membership token - will validate during handshake`);
            } else {
              // Check if this is a bridge node (has bridgeAuthToken or isBridgeNode metadata)
              const isBridgeNode = nodeInfo.metadata?.isBridgeNode || nodeInfo.metadata?.bridgeAuthToken;

              // LENIENT: If this peer is already connected, trust the connection managers
              // Connection managers are responsible for validating bridge nodes during connection
              const isAlreadyConnected = this.getConnectedPeers().includes(nodeInfo.id);

              if (!isBridgeNode && !isAlreadyConnected) {
                // LENIENT: Allow peers discovered from trusted connected peers
                // Membership tokens will be validated during WebRTC handshake
                // This prevents chicken-and-egg problem where peers can't discover each other
                // because they haven't exchanged tokens yet
                console.log(`⚠️ Peer ${nodeInfo.id.substring(0, 8)}... discovered without membership token - will validate during handshake`);
                // Don't reject - allow connection attempt
              }

              if (isBridgeNode) {
                console.log(`🌉 Allowing bridge node ${nodeInfo.id.substring(0, 8)}... without membership token`);
              } else if (isAlreadyConnected) {
                console.log(`🌉 Allowing already connected peer ${nodeInfo.id.substring(0, 8)}... (connection manager validated)`);
              }
            }

            // Create DHTNode and add to routing table
            const nodeId = DHTNodeId.fromHex(nodeInfo.id);
            const existingNode = this.routingTable.getNode(nodeInfo.id);

            if (!existingNode) {
              const dhtNode = new DHTNode(nodeId, nodeInfo.endpoint);
              if (nodeInfo.metadata) {
                dhtNode.metadata = nodeInfo.metadata;
              }

              // Add to routing table
              const added = this.routingTable.addNode(dhtNode);
              if (added) {
                console.log(`✅ Added validated peer ${nodeInfo.id.substring(0, 8)}... to routing table`);
              }
            } else {
              // Update existing node metadata and refresh timestamp
              if (nodeInfo.metadata) {
                existingNode.metadata = { ...existingNode.metadata, ...nodeInfo.metadata };
              }
              existingNode.updateLastSeen();
              console.log(`🔄 Updated existing peer ${nodeInfo.id.substring(0, 8)}... in routing table`);
            }

          } catch (error) {
            console.warn(`Failed to process discovered peer ${nodeInfo.id}:`, error);
          }
        }

        console.log(`📊 Routing table now has ${this.routingTable.totalNodes} entries after processing find_node_response`);
      }

      request.resolve(message);
    } else {
      // EMERGENCY: Rate limit unsolicited response logging to prevent memory crashes
      if (!this._unsolicitedLogCache) {
        this._unsolicitedLogCache = new Set();
      }

      const peerPrefix = peerId.substring(0, 8);
      const shouldLog = !this._unsolicitedLogCache.has(peerPrefix);

      if (shouldLog) {
        console.warn(`⚠️ Ignoring unsolicited find_node_response from ${peerPrefix}... (requestId: ${message.requestId})`);
        this._unsolicitedLogCache.add(peerPrefix);

        // Clear cache periodically to prevent infinite growth
        if (this._unsolicitedLogCache.size > 50) {
          this._unsolicitedLogCache.clear();
        }
      }

      await this.trackUnsolicitedResponse(peerId);
    }
  }

  /**
   * Handle store response
   */
  async handleStoreResponse(peerId, message) {
    const request = this.pendingRequests.get(message.requestId);
    if (request) {
      this.pendingRequests.delete(message.requestId);
      request.resolve(message);
    } else {
      // MEMORY LEAK FIX: Log and ignore unsolicited responses
      console.warn(`⚠️ Ignoring unsolicited store_response from ${peerId.substring(0, 8)}... (requestId: ${message.requestId})`);
      this.trackUnsolicitedResponse(peerId);
    }
  }

  /**
   * Handle find value response
   */
  async handleFindValueResponse(peerId, message) {
    console.log(`📥 [${this.localNodeId.toString().substring(0, 8)}] Received find_value_response from ${peerId.substring(0, 8)}... (requestId: ${message.requestId}, found: ${message.found})`);
    const request = this.pendingRequests.get(message.requestId);
    if (request) {
      console.log(`✅ [${this.localNodeId.toString().substring(0, 8)}] Matched pending request (requestId: ${message.requestId})`);
      this.pendingRequests.delete(message.requestId);
      request.resolve(message);
    } else {
      // MEMORY LEAK FIX: Log and ignore unsolicited responses
      console.warn(`⚠️ [${this.localNodeId.toString().substring(0, 8)}] Ignoring unsolicited find_value_response from ${peerId.substring(0, 8)}... (requestId: ${message.requestId})`);
      console.warn(`   Pending requests: [${Array.from(this.pendingRequests.keys()).join(', ')}]`);
      this.trackUnsolicitedResponse(peerId);
    }
  }

  /**
   * Handle ICE response
   */
  async handleICEResponse(peerId, message) {
    const request = this.pendingRequests.get(message.requestId);
    if (request) {
      this.pendingRequests.delete(message.requestId);
      request.resolve(message);
    } else {
      // MEMORY LEAK FIX: Log and ignore unsolicited responses
      console.warn(`⚠️ Ignoring unsolicited ice_response from ${peerId.substring(0, 8)}... (requestId: ${message.requestId})`);
      await this.trackUnsolicitedResponse(peerId);
    }
  }

  /**
   * Track unsolicited responses and disconnect spamming peers
   * MEMORY LEAK FIX: Prevents memory exhaustion from spam responses
   */
  async trackUnsolicitedResponse(peerId) {
    // Rate limiting for unsolicited responses to prevent spam
    if (!this.unsolicitedResponseCounts) {
      this.unsolicitedResponseCounts = new Map();
    }

    const count = (this.unsolicitedResponseCounts.get(peerId) || 0) + 1;
    this.unsolicitedResponseCounts.set(peerId, count);

    // BRIDGE NODE PROTECTION: Don't disconnect bridge nodes for legitimate DHT responses
    // Check both routing table AND peerNodes map (bridge nodes may not be in routing table yet)
    let peerNode = this.routingTable.getNode(peerId);
    if (!peerNode && this.peerNodes) {
      peerNode = this.peerNodes.get(peerId);
    }
    const isBridgeNode = peerNode && peerNode.metadata && peerNode.metadata.isBridgeNode;

    // Debug bridge node detection
    if (count > 50) {
      console.log(`🔍 Spam check for ${peerId.substring(0, 8)}...: count=${count}, isBridgeNode=${isBridgeNode}, hasMetadata=${!!peerNode?.metadata}, metadata:`, peerNode?.metadata);
    }

    if (isBridgeNode) {
      // Bridge nodes can send many legitimate responses during emergency discovery
      // Use higher threshold and log more details
      if (count > 200) { // Much higher threshold for bridge nodes
        console.warn(`🌉 Bridge node ${peerId.substring(0, 8)}... sending many responses (${count}) - this may be normal during network startup`);
        // Reset counter but don't disconnect bridge nodes
        this.unsolicitedResponseCounts.set(peerId, 0);
      }
      return; // Never disconnect bridge nodes
    }

    // EMERGENCY DISCOVERY PROTECTION: Be more lenient during network formation and emergency periods
    const now = Date.now();
    const recentEmergencyDiscovery = this.lastEmergencyDiscovery && (now - this.lastEmergencyDiscovery) < 300000; // 5 minutes (extended)
    const isSmallNetwork = this.getConnectedPeers().length < 8; // Extended threshold for small networks
    const isNetworkFormation = (now - this.startTime) < 600000; // First 10 minutes of network formation

    let threshold = 50; // Default threshold
    if (recentEmergencyDiscovery || isSmallNetwork || isNetworkFormation) {
      threshold = 200; // Quadruple threshold during emergency periods
      if (count === 51) { // Log once when reaching normal threshold
        console.log(`⚠️ Using relaxed spam threshold (${threshold}) for ${peerId.substring(0, 8)}... during emergency/formation period (${this.getConnectedPeers().length} peers)`);
      }
    }

    // Disconnect regular peers sending excessive unsolicited responses
    if (count > threshold) {
      console.error(`🚫 Disconnecting ${peerId.substring(0, 8)}... for sending ${count} unsolicited responses (potential spam/attack, threshold: ${threshold})`);

      // Remove from routing table and disconnect
      this.routingTable.removeNode(peerId);
      if (peerNode && peerNode.connectionManager) {
        await peerNode.connectionManager.disconnect(peerId);
      }

      // Clean up tracking
      this.unsolicitedResponseCounts.delete(peerId);
    }
  }

  /**
   * Message Queue System for ordered processing of multiple DHT messages
   */
  async enqueueMessage(peerId, message) {
    // Initialize queue for peer if it doesn't exist
    if (!this.messageQueue.has(peerId)) {
      this.messageQueue.set(peerId, []);
    }

    const queue = this.messageQueue.get(peerId);

    // Prevent memory leaks - remove old messages first
    const now = Date.now();
    const filteredQueue = queue.filter(item => (now - item.timestamp) < this.messageTimeout);

    // Add new message with timestamp
    filteredQueue.push({
      message,
      timestamp: now
    });

    // Trim queue if too large
    if (filteredQueue.length > this.maxQueueSize) {
      filteredQueue.splice(0, filteredQueue.length - this.maxQueueSize);
      console.warn(`Message queue for ${peerId} trimmed to prevent memory leak`);
    }

    this.messageQueue.set(peerId, filteredQueue);

    // Process queue if not already processing
    await this.processMessageQueue(peerId);
  }

  async processMessageQueue(peerId) {
    // Prevent concurrent processing for same peer
    if (this.messageProcessingFlags.get(peerId)) {
      return;
    }

    this.messageProcessingFlags.set(peerId, true);

    try {
      const queue = this.messageQueue.get(peerId);
      if (!queue || queue.length === 0) {
        return;
      }

      // Process messages in order (FIFO)
      while (queue.length > 0) {
        const { message, timestamp } = queue.shift();

        // Skip expired messages
        if ((Date.now() - timestamp) > this.messageTimeout) {
          console.warn(`Skipping expired message from ${peerId}: ${message.type}`);
          continue;
        }

        // Process the message
        await this.handlePeerMessage(peerId, message);
      }

      // Clean up empty queue
      if (queue.length === 0) {
        this.messageQueue.delete(peerId);
      }
    } catch (error) {
      console.error(`Error processing message queue for ${peerId}:`, error);
    } finally {
      this.messageProcessingFlags.set(peerId, false);
    }
  }

  /**
   * Handle WebRTC offer message via DHT
   */
  async handleWebRTCOffer(fromPeer, message) {
    console.log(`🔄 DHT WebRTC: Received offer from ${fromPeer} for peer ${message.targetPeer}`);

    // Check if this offer is for us
    if (message.targetPeer !== this.localNodeId.toString()) {
      // This is a routed message - forward it to the target peer
      await this.routeSignalingMessage(message.targetPeer, message);
      return;
    }

    // This offer is for us - delegate to connection manager
    console.log(`📥 Received signaling offer from ${message.senderPeer} - delegating to connection manager`);

    // Connection managers should handle their own signaling processing
    // The DHT layer only routes messages, it doesn't process connection-specific signaling
  }

  /**
   * Handle WebRTC answer message via DHT
   */
  async handleWebRTCAnswer(fromPeer, message) {
    console.log(`🔄 DHT WebRTC: Received answer from ${fromPeer} for peer ${message.targetPeer}`);

    // Check if this answer is for us
    if (message.targetPeer !== this.localNodeId.toString()) {
      // This is a routed message - forward it to the target peer
      await this.routeSignalingMessage(message.targetPeer, message);
      return;
    }

    // This answer is for us - delegate to connection manager
    console.log(`📥 Received signaling answer from ${message.senderPeer} - delegating to connection manager`);

    // Connection managers should handle their own signaling processing
    // The DHT layer only routes messages, it doesn't process connection-specific signaling
  }

  /**
   * Handle WebRTC ICE candidate message via DHT
   */
  async handleWebRTCIceCandidate(fromPeer, message) {
    console.log(`🔄 DHT WebRTC: Received ICE candidate from ${fromPeer} for peer ${message.targetPeer}`);

    // Check if this ICE candidate is for us
    if (message.targetPeer !== this.localNodeId.toString()) {
      // This is a routed message - forward it to the target peer
      await this.routeSignalingMessage(message.targetPeer, message);
      return;
    }

    // This ICE candidate is for us - delegate to connection manager
    console.log(`📥 Received ICE candidate from ${message.senderPeer} - delegating to connection manager`);

    // Connection managers should handle their own signaling processing
    // The DHT layer only routes messages, it doesn't process connection-specific signaling
  }

  /**
   * Route WebRTC message to target peer through DHT
   */
  async routeSignalingMessage(targetPeer, message) {
    console.log(`🚀 Routing WebRTC message to ${targetPeer}: ${message.type}`);

    try {
      // Try to send directly if we have a connection to the target
      if (this.isPeerConnected(targetPeer)) {
        await this.sendMessage(targetPeer, message);
        console.log(`✅ Directly routed WebRTC message to ${targetPeer}`);
        return;
      }

      // Find best next hop using DHT routing - convert hex string to DHTNodeId properly
      const targetNodeId = DHTNodeId.fromString(targetPeer);

      // First try: Use closest nodes (optimal routing)
      const closestNodes = this.routingTable.findClosestNodes(targetNodeId, this.options.alpha);

      for (const node of closestNodes) {
        const nextHop = node.id.toString();
        if (this.isPeerConnected(nextHop)) {
          await this.sendMessage(nextHop, message);
          console.log(`✅ Routed WebRTC message via ${nextHop} (closest) to ${targetPeer}`);
          return;
        }
      }

      // Second try (small network fallback): Try ALL routing table nodes
      // In small networks, any connected peer might be able to reach the target
      console.log(`🔍 No route via closest nodes - trying all routing table entries (small network mode)`);
      const allNodes = this.routingTable.getAllNodes();

      for (const node of allNodes) {
        const nextHop = node.id.toString();
        if (this.isPeerConnected(nextHop) && nextHop !== targetPeer) {
          await this.sendMessage(nextHop, message);
          console.log(`✅ Routed signaling message via ${nextHop} (fallback) to ${targetPeer}`);
          return;
        }
      }

      console.warn(`❌ No connected route found to forward signaling message to ${targetPeer}`);
      console.warn(`   Routing table size: ${allNodes.length}, Connected peers: ${this.getConnectedPeers().length}`);
    } catch (error) {
      console.error(`Failed to route signaling message to ${targetPeer}:`, error);
    }
  }

  /**
   * Handle peer discovery request - respond with willingness to connect
   */
  async handlePeerDiscoveryRequest(fromPeer, message) {
    console.log(`🔍 Received peer discovery request from ${fromPeer.substring(0, 8)}...`);

    // Check if we want to connect to this peer
    const shouldConnect = await this.shouldConnectToPeer(fromPeer);

    const response = {
      type: 'peer_discovery_response',
      requestId: message.requestId,
      senderPeer: this.localNodeId.toString(),
      targetPeer: fromPeer,
      willing: shouldConnect,
      timestamp: Date.now()
    };

    // Gracefully handle case where peer disconnected while processing
    try {
      await this.sendMessage(fromPeer, response);
    } catch (error) {
      if (error.message.includes('No connection to peer')) {
        console.log(`⚠️ Could not send peer_discovery_response to ${fromPeer.substring(0, 8)}... - peer disconnected`);
      } else {
        throw error; // Re-throw unexpected errors
      }
    }

    if (shouldConnect && !this.isPeerConnected(fromPeer)) {
      // Initiate connection using connection-agnostic approach
      console.log(`🤝 Initiating connection to discovered peer: ${fromPeer}`);
      try {
        const peerNode = this.getOrCreatePeerNode(fromPeer);
        // CRITICAL: Pass metadata from routing table node so connection manager has connection info
        await peerNode.connectionManager.createConnection(fromPeer, true, peerNode.metadata);
      } catch (error) {
        console.warn(`Failed to initiate connection to ${fromPeer}:`, error);
      }
    }
  }

  /**
   * Handle peer discovery response
   */
  async handlePeerDiscoveryResponse(fromPeer, message) {
    console.log(`🔍 Received peer discovery response from ${fromPeer}: willing=${message.willing}`);

    if (message.willing && !this.isPeerConnected(fromPeer)) {
      // Peer is willing to connect - wait for their WebRTC offer or send ours
      console.log(`✅ Peer ${fromPeer} is willing to connect, preparing for WebRTC negotiation`);

      // Add to routing table if not already there
      if (!this.routingTable.getNode(fromPeer)) {
        const node = new DHTNode(fromPeer, 'discovered-peer');
        node.lastSeen = Date.now();

        // Peer metadata will be handled by connection manager

        this.routingTable.addNode(node);
        console.log(`📋 Added discovered peer ${fromPeer} to routing table`);
      }
    }
  }

  /**
   * Handle generic connection request (connection-agnostic)
   */
  async handleConnectionRequest(fromPeer, message) {
    console.log(`🔗 Received connection request from ${fromPeer}`);

    // Message deduplication - prevent processing the same request multiple times (BEFORE routing check)
    const messageId = `${fromPeer}:${message.targetPeer}:${message.type}:${message.nodeType}:${message.listeningAddress}:${message.timestamp || Date.now()}`;
    if (this.processedMessages.has(messageId)) {
      console.log(`⚠️ Ignoring duplicate WebSocket connection request from ${fromPeer}`);
      return;
    }

    // Mark this message as processed
    this.processedMessages.set(messageId, Date.now());

    // Clean up old processed messages to prevent memory leaks
    setTimeout(() => {
      this.processedMessages.delete(messageId);
    }, this.messageDeduplicationTimeout);

    // Check if this request is for us
    if (message.targetPeer !== this.localNodeId.toString()) {
      // This is a routed message - forward it to the target peer
      await this.routeSignalingMessage(message.targetPeer, message);
      return;
    }

    console.log(`📞 Processing WebSocket connection request from ${message.senderPeer}`);
    console.log(`   Node Type: ${message.nodeType || 'unknown'}`);
    console.log(`   Listening Address: ${message.listeningAddress}`);
    console.log(`   Capabilities: ${message.capabilities?.join(', ') || 'unknown'}`);

    // Handle WebSocket connection requests based on our node type and the request type
    if (message.nodeType === 'nodejs' && message.listeningAddress) {
      // Another Node.js client is asking us to connect to their WebSocket server
      try {
        if (typeof process === 'undefined') {
          // Use connection-agnostic approach to connect to peer
          console.log(`🔗 Connecting to peer server: ${message.listeningAddress}`);
          const peerNode = this.getOrCreatePeerNode(message.senderPeer, {
            listeningAddress: message.listeningAddress
          });
          // CRITICAL: Pass metadata from routing table node so connection manager has connection info
          await peerNode.connectionManager.createConnection(message.senderPeer, true, peerNode.metadata);

          // Send success response
          await this.sendWebSocketConnectionResponse(message.senderPeer, {
            success: true
          });
        } else {
          // Use connection-agnostic approach to connect to peer
          console.log(`🔗 Connecting to peer server: ${message.listeningAddress}`);
          const peerNode = this.getOrCreatePeerNode(message.senderPeer, {
            listeningAddress: message.listeningAddress
          });
          // CRITICAL: Pass metadata from routing table node so connection manager has connection info
          await peerNode.connectionManager.createConnection(message.senderPeer, true, peerNode.metadata);

          // Send success response
          await this.sendWebSocketConnectionResponse(message.senderPeer, {
            success: true
          });
        }

      } catch (error) {
        console.error(`❌ Failed to connect to WebSocket server: ${error.message}`);

        // Send failure response
        await this.sendWebSocketConnectionResponse(message.senderPeer, {
          success: false,
          error: error.message,
          nodeType: typeof process === 'undefined' ? 'browser' : 'nodejs'
        });
      }
    } else if (message.nodeType === 'browser' && typeof process !== 'undefined') {
      // Browser is asking Node.js to connect - this doesn't make sense since browsers can't run servers
      console.log(`ℹ️ Browser client asking Node.js to connect - not applicable (browsers can't run WebSocket servers)`);
      await this.sendWebSocketConnectionResponse(message.senderPeer, {
        success: false,
        error: 'Browser clients cannot run WebSocket servers',
        nodeType: 'nodejs'
      });
    } else {
      console.log(`ℹ️ WebSocket connection request not applicable for this configuration`);
      console.log(`   Our type: ${typeof process === 'undefined' ? 'browser' : 'nodejs'}, Request from: ${message.nodeType}`);
    }
  }

  /**
   * Handle generic connection response (connection-agnostic)
   */
  async handleConnectionResponse(fromPeer, message) {
    console.log(`🔗 Received connection response from ${fromPeer}: success=${message.success}`);

    // Message deduplication - prevent processing the same response multiple times (BEFORE routing check)
    const messageId = `${fromPeer}:${message.targetPeer}:${message.type}:${message.success}:${message.timestamp || Date.now()}`;
    if (this.processedMessages.has(messageId)) {
      console.log(`⚠️ Ignoring duplicate WebSocket connection response from ${fromPeer}`);
      return;
    }

    // Mark this message as processed
    this.processedMessages.set(messageId, Date.now());

    // Clean up old processed messages to prevent memory leaks
    setTimeout(() => {
      this.processedMessages.delete(messageId);
    }, this.messageDeduplicationTimeout);

    // Check if this response is for us
    if (message.targetPeer && message.targetPeer !== this.localNodeId.toString()) {
      // This is a routed message - forward it to the target peer
      await this.routeSignalingMessage(message.targetPeer, message);
      return;
    }

    // Clean up pending request tracking
    this.pendingWebSocketRequests.delete(fromPeer);

    if (message.success) {
      console.log(`✅ WebSocket connection established with ${fromPeer}`);
      console.log(`   Peer Type: ${message.nodeType || 'unknown'}`);
      console.log(`   Capabilities: ${message.capabilities?.join(', ') || 'unknown'}`);
    } else {
      console.error(`❌ WebSocket connection failed with ${fromPeer}: ${message.error}`);
    }
  }

  /**
   * Handle forwarded invitation from bridge node
   * This method allows a DHT peer to act as a helper for onboarding new peers
   * Connection-agnostic implementation reuses existing invitation system
   */
  async handleForwardInvitation(peerId, message) {
    const { targetPeerId, invitationToken, fromBridge } = message;

    console.log(`📨 Received forwarded invitation from ${fromBridge ? 'bridge' : peerId.substring(0,8)}`);
    console.log(`   Target: ${targetPeerId.substring(0, 8)}`);
    console.log(`   Inviter: ${invitationToken.inviter.substring(0, 8)} (bridge node)`);

    try {
      // Ensure we're connected to bootstrap (temporary reconnect if needed)
      // This reuses the existing invitation coordination infrastructure
      await this.ensureBootstrapConnectionForInvitation();

      // Send invitation using EXISTING method (connection-agnostic!)
      // bootstrap.sendInvitation() handles all connection types through ConnectionManager
      const result = await this.bootstrap.sendInvitation(
        targetPeerId,
        invitationToken,
        30000  // 30 second timeout
      );

      if (result.success) {
        console.log(`✅ Successfully forwarded invitation to ${targetPeerId.substring(0, 8)}`);
        console.log(`   New peer will coordinate connection through bootstrap server`);
        console.log(`   Using existing invitation system (connection-agnostic)`);
      } else {
        console.warn(`❌ Failed to forward invitation: ${result.error}`);
        console.warn(`   This may be due to target peer being offline or bootstrap coordination issues`);
      }

    } catch (error) {
      console.error(`❌ Error forwarding invitation:`, error);
      console.error(`   Target peer: ${targetPeerId.substring(0, 8)}`);
      console.error(`   This peer will retry bootstrap connection temporarily`);
    }
  }

  /**
   * Handle request from bridge to create invitation for new peer
   * Bridge delegates invitation creation to this full DHT member
   */
  async handleCreateInvitationForPeer(peerId, message) {
    const { targetPeer, targetNodeId, targetNodeMetadata, fromBridge, requestId } = message;

    // Check if this message is intended for us to process
    // If targetPeer is specified and it's not us, this is just a routed message - don't process
    if (targetPeer && targetPeer !== this.localNodeId.toString()) {
      console.log(`📨 Forwarding create_invitation_for_peer (intended for ${targetPeer.substring(0,8)}, not us)`);
      return; // Let DHT routing handle forwarding
    }

    console.log(`📨 Received create_invitation_for_peer from bridge ${fromBridge.substring(0,8)}`);
    console.log(`   Target new peer: ${targetNodeId.substring(0, 8)}`);
    console.log(`   Request ID: ${requestId}`);
    console.log(`   This node will process the invitation creation`);

    try {
      // Track this peer as pending invitation to ensure bootstrap signaling is used
      if (!this.pendingInvitations) {
        this.pendingInvitations = new Set();
      }
      this.pendingInvitations.add(targetNodeId);
      console.log(`📋 Added ${targetNodeId.substring(0, 8)} to pending invitations for bootstrap signaling`);

      // Create invitation token for the target node
      // Note: The invitation token will have THIS node as inviter, but that's for crypto signature
      // The actual "responsible party" is the bridge node (fromBridge)
      const expiryMs = 30 * 60 * 1000; // 30 minutes
      const invitationToken = await this.createInvitationToken(targetNodeId, expiryMs);

      console.log(`✅ Created invitation token for ${targetNodeId.substring(0, 8)}`);
      console.log(`   Token inviter (crypto): ${invitationToken.inviter.substring(0, 8)} (this node)`);
      console.log(`   Responsible bridge: ${fromBridge.substring(0, 8)}`);

      // Ensure we're connected to bootstrap (temporary reconnect if needed)
      await this.ensureBootstrapConnectionForInvitation();

      // Send invitation using EXISTING method (connection-agnostic!)
      // bootstrap.sendInvitation() handles all connection types through ConnectionManager
      const result = await this.bootstrap.sendInvitation(
        targetNodeId,
        invitationToken,
        30000  // 30 second timeout
      );

      if (result.success) {
        console.log(`✅ Successfully sent invitation to ${targetNodeId.substring(0, 8)}`);
        console.log(`   New peer will coordinate connection through bootstrap server`);
        console.log(`   Using existing invitation system (connection-agnostic)`);
      } else {
        console.warn(`❌ Failed to send invitation: ${result.error}`);
        console.warn(`   This may be due to target peer being offline or bootstrap coordination issues`);
      }

    } catch (error) {
      console.error(`❌ Error creating/sending invitation:`, error);
      console.error(`   Target peer: ${targetNodeId.substring(0, 8)}`);
      console.error(`   Request ID: ${requestId}`);
    }
  }

  /**
   * Send generic connection request via DHT messaging (connection-agnostic)
   */
  async sendConnectionRequest(targetPeer, connectionInfo) {
    console.log(`📤 Sending connection request via DHT to ${targetPeer.substring(0, 8)}...`);

    const message = {
      type: 'connection_request',
      senderPeer: this.localNodeId.toString(),
      targetPeer: targetPeer,
      connectionInfo: connectionInfo, // Let connection managers handle the specifics
      timestamp: Date.now()
    };

    await this.routeSignalingMessage(targetPeer, message);
  }

  /**
   * Send generic connection response via DHT messaging (connection-agnostic)
   */
  async sendConnectionResponse(targetPeer, responseInfo) {
    console.log(`📤 Sending connection response via DHT to ${targetPeer.substring(0, 8)}...`);

    const message = {
      type: 'connection_response',
      senderPeer: this.localNodeId.toString(),
      targetPeer: targetPeer,
      success: responseInfo.success,
      error: responseInfo.error,
      nodeType: responseInfo.nodeType,
      capabilities: responseInfo.capabilities || [],
      timestamp: Date.now()
    };

    await this.routeSignalingMessage(targetPeer, message);
  }


  /**
   * Check if we should connect to a peer (prevent overconnection)
   */
  async shouldConnectToPeer(peerId) {
    // Don't connect if already connected
    if (this.isPeerConnected(peerId)) {
      return false;
    }

    // Don't connect to ourselves
    if (peerId === this.localNodeId.toString()) {
      return false;
    }

    // Check if we're under the connection limit
    const currentConnections = this.getConnectedPeers().length;
    const maxConnections = this.transportOptions.maxConnections || 50;

    if (currentConnections >= maxConnections) {
      console.log(`Connection limit reached (${currentConnections}/${maxConnections})`);
      return false;
    }

    // Check if peer is valid
    if (!this.isValidDHTPeer(peerId)) {
      return false;
    }

    return true;
  }

  /**
   * Send peer discovery request to find peers willing to connect
   */
  async sendPeerDiscoveryRequest(targetPeer) {
    console.log(`🔍 Sending peer discovery request to ${targetPeer}`);

    const requestId = `discovery_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const message = {
      type: 'peer_discovery_request',
      requestId,
      senderPeer: this.localNodeId.toString(),
      targetPeer: targetPeer,
      timestamp: Date.now()
    };

    await this.routeSignalingMessage(targetPeer, message);
    return requestId;
  }

  /**
   * Replace old storage-based peer discovery with direct DHT messaging
   */
  async discoverPeersViaDHT() {
    console.log(`🔍 Discovering peers via direct DHT messaging...`);

    try {
      const routingNodes = this.routingTable.getAllNodes();
      const connectedPeers = this.getConnectedPeers();

      // Find peers in routing table that we're not connected to
      for (const node of routingNodes) {
        const peerId = node.id.toString();

        // CRITICAL: Never try to contact ourselves
        if (peerId === this.localNodeId.toString()) {
          console.warn(`🚨 Found self-reference in routing table during peer discovery: ${peerId}`);
          continue;
        }

        if (connectedPeers.includes(peerId)) {
          continue; // Already connected
        }

        if (!this.isValidDHTPeer(peerId)) {
          continue; // Not a valid DHT peer
        }

        // Send discovery request through DHT routing
        try {
          await this.sendPeerDiscoveryRequest(peerId);
          console.log(`📤 Sent discovery request to ${peerId}`);
        } catch (error) {
          console.warn(`Failed to send discovery request to ${peerId}:`, error);
        }
      }

      // THROTTLED: Only ask a few connected peers for routing table info, not all
      const maxPeersToQuery = Math.min(3, connectedPeers.length); // Limit to 3 peers max
      const peersToQuery = connectedPeers.slice(0, maxPeersToQuery);

      console.log(`📋 Querying ${peersToQuery.length} of ${connectedPeers.length} connected peers for routing info`);

      for (const connectedPeer of peersToQuery) {
        try {
          // Ask connected peers for their routing table
          const findNodeRequest = {
            type: 'find_node',
            requestId: `findnode_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            target: this.localNodeId.toString(), // Ask for nodes close to us
            timestamp: Date.now()
          };

          // CRITICAL FIX: Register request in pendingRequests to prevent "unsolicited" response detection
          // Using timeout of 30 seconds for discovery requests
          const timeoutHandle = setTimeout(() => {
            this.pendingRequests.delete(findNodeRequest.requestId);
            console.log(`⏰ Discovery request timeout for peer ${connectedPeer.substring(0, 8)}...`);
          }, 30000);

          this.pendingRequests.set(findNodeRequest.requestId, {
            resolve: () => {
              clearTimeout(timeoutHandle);
              // Response will be handled by handleFindNodeResponse()
            },
            reject: () => {
              clearTimeout(timeoutHandle);
              // Errors will be handled by handleFindNodeResponse()
            }
          });

          await this.sendMessage(connectedPeer, findNodeRequest);
        } catch (error) {
          console.warn(`Failed to request nodes from ${connectedPeer}:`, error);
        }
      }

    } catch (error) {
      console.error(`Error during DHT peer discovery:`, error);
    }
  }

  /**
   * Verify bridge node authentication
   * Bridge nodes must have valid cryptographic proof of authorization
   */
  async verifyBridgeNodeAuth(peer) {
    try {
      // Check for bridge authentication token in metadata
      const bridgeAuth = peer.metadata?.bridgeAuthToken;
      const bridgeSignature = peer.metadata?.bridgeSignature;

      if (!bridgeAuth || !bridgeSignature) {
        console.warn(`🚨 Bridge node ${peer.nodeId.substring(0, 8)}... missing auth credentials`);
        return false;
      }

      // For now, implement basic shared secret authentication
      // TODO: Replace with proper cryptographic verification using Ed25519 signatures
      const expectedAuthHash = 'bridge_auth_' + (this.options.bridgeAuth || 'default-bridge-auth-key');

      if (bridgeAuth === expectedAuthHash) {
        console.log(`✅ Bridge node ${peer.nodeId.substring(0, 8)}... authenticated`);
        return true;
      } else {
        console.warn(`🚨 Bridge node ${peer.nodeId.substring(0, 8)}... authentication failed`);
        return false;
      }

    } catch (error) {
      console.error(`❌ Error verifying bridge node auth:`, error);
      return false;
    }
  }
}

export default KademliaDHT;
