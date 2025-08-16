import { EventEmitter } from 'events';
import { DHTNodeId } from '../core/DHTNodeId.js';
import { DHTNode } from '../core/DHTNode.js';
import { RoutingTable } from './RoutingTable.js';
import { WebRTCManager } from '../network/WebRTCManager.js';
import { BootstrapClient } from '../bootstrap/BootstrapClient.js';
import { InvitationToken } from '../core/InvitationToken.js';

/**
 * Main Kademlia DHT implementation with WebRTC transport
 */
export class KademliaDHT extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Track DHT instance creation
    const instanceId = Math.random().toString(36).substr(2, 9);
    this.instanceId = instanceId;

    this.options = {
      k: options.k || 20, // Kademlia k parameter
      alpha: options.alpha || 3, // Parallelism parameter
      replicateK: options.replicateK || 3, // Replication factor
      refreshInterval: options.refreshInterval || 60 * 1000, // Base interval - will be adaptive
      aggressiveRefreshInterval: options.aggressiveRefreshInterval || 15 * 1000, // 15s for new/isolated nodes
      standardRefreshInterval: options.standardRefreshInterval || 600 * 1000, // 10 minutes following IPFS standard
      republishInterval: options.republishInterval || 24 * 60 * 60 * 1000, // 24 hours
      expireInterval: options.expireInterval || 24 * 60 * 60 * 1000, // 24 hours
      pingInterval: options.pingInterval || 60 * 1000, // 1 minute (dev-friendly)
      bootstrapServers: options.bootstrapServers || ['ws://localhost:8080'],
      ...options
    };

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
    
    // Handle connection manager creation properly
    if (options.webrtc && typeof options.webrtc.on === 'function') {
      // Already a connection manager instance (e.g., Node.js WebSocketManager)
      this.connectionManager = options.webrtc;
    } else {
      // Configuration object or undefined - create WebRTC manager
      this.connectionManager = new WebRTCManager(options.webrtc || {});
    }
    
    this.bootstrap = options.bootstrap || new BootstrapClient({ 
      bootstrapServers: this.options.bootstrapServers 
    });

    // Storage
    this.storage = new Map(); // key -> { value, timestamp, publisher }
    this.republishQueue = new Map(); // key -> republish timestamp
    
    // Request tracking
    this.pendingRequests = new Map(); // requestId -> { resolve, reject, timeout }
    this.requestId = 0;

    // Message Queue System for DHT-based WebRTC signaling
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
    
    // Throttling and rate limiting for reducing excessive find_node traffic
    this.lastBucketRefreshTime = 0; // Track last bucket refresh for throttling
    this.findNodeRateLimit = new Map(); // Rate limit find_node requests per peer
    this.findNodeMinInterval = 10000; // Minimum 10 seconds between find_node to same peer
    
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
    console.log('🎫 Membership token set');
    return true;
  }

  /**
   * Setup event handlers for components
   */
  setupEventHandlers() {
    this.setupConnectionManagerEventHandlers();
    this.setupBootstrapEventHandlers();
  }

  /**
   * Setup connection manager event handlers
   */
  setupConnectionManagerEventHandlers() {
    // Remove existing listeners first to prevent duplicates (safely)
    try {
      if (this.connectionManager.removeAllListeners) {
        this.connectionManager.removeAllListeners('peerConnected');
        this.connectionManager.removeAllListeners('peerDisconnected');
        this.connectionManager.removeAllListeners('data');
        this.connectionManager.removeAllListeners('signal');
      }
    } catch (error) {
      // Ignore errors for missing removeAllListeners method
      console.debug('WebRTC manager does not support removeAllListeners per event');
    }
    
    // Store handler references for potential removal
    this.peerConnectedHandler = ({ peerId }) => {
      console.log(`🔗 Peer connected: ${peerId}`);
      this.handlePeerConnected(peerId);
      
      setTimeout(() => {
        this.considerDHTSignaling();
      }, 2000);
    };
    
    this.peerDisconnectedHandler = ({ peerId }) => {
      this.handlePeerDisconnected(peerId);
    };
    
    this.dataHandler = ({ peerId, data }) => {
      // Use message queue for ordered processing
      this.enqueueMessage(peerId, data);
    };
    
    this.signalHandler = ({ peerId, signal }) => {
      this.handleOutgoingSignal(peerId, signal);
    };
    
    this.connectionManager.on('peerConnected', this.peerConnectedHandler);
    this.connectionManager.on('peerDisconnected', this.peerDisconnectedHandler);
    this.connectionManager.on('data', this.dataHandler);
    this.connectionManager.on('signal', this.signalHandler);
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

    // Recreate WebRTC manager if it was destroyed
    if (this.connectionManager.isDestroyed) {
      console.log('Recreating destroyed WebRTCManager');
      this.connectionManager = new WebRTCManager(this.options.webrtc || {});
      this.setupConnectionManagerEventHandlers();
    }

    // Initialize WebRTC manager
    this.connectionManager.initialize(this.localNodeId.toString());
    
    // Re-setup event handlers after initialization
    this.setupConnectionManagerEventHandlers();

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
    const connectedPeers = this.connectionManager.getConnectedPeers().length;
    const isDHTConnected = connectedPeers > 0;
    
    const connectionPromises = [];

    for (const peer of peers.slice(0, this.options.k)) {
      try {
        if (!this.isValidDHTPeer(peer.nodeId)) {
          continue;
        }
        
        // Store peer metadata if available (for WebSocket connections)
        // This must happen REGARDLESS of connection attempts for future use
        if (peer.metadata && this.connectionManager.setPeerMetadata) {
          this.connectionManager.setPeerMetadata(peer.nodeId, peer.metadata);
          console.log(`📋 Stored bootstrap peer metadata for ${peer.nodeId.substring(0, 8)}...:`, peer.metadata);
        }
        
        // Only connect to bootstrap peers if not already DHT-connected
        if (isDHTConnected) {
          continue;
        }
        
        // SECURITY: No automatic connections - all peers must be explicitly invited
        // Both Genesis and non-Genesis peers wait for explicit invitations
        console.log(`⏳ Found peer ${peer.nodeId.substring(0, 8)}... - waiting for explicit invitation`);
        // Do not auto-connect - connections only through invitation system
      } catch (error) {
        console.warn(`Failed to initiate connection to ${peer.nodeId}:`, error);
      }
    }

    // Wait for at least one connection
    if (connectionPromises.length > 0) {
      try {
        await Promise.race(connectionPromises);
        console.log('✅ Connected to initial peers');
        this.isBootstrapped = true;
        
        // Give connections more time to establish before considering DHT signaling
        setTimeout(() => {
          const actualConnections = this.connectionManager.getConnectedPeers().length;
          const routingEntries = this.routingTable.getAllNodes().length;
          
          if (actualConnections < routingEntries) {
            this.cleanupRoutingTable();
          }
          
          this.considerDHTSignaling();
        }, 5000); // 5 seconds delay - check DHT signaling readiness
        
      } catch (error) {
        console.warn('Failed to connect to any bootstrap peers:', error);
      }
    } else {
      console.warn('No connection attempts could be initiated');
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
    const connectedPeers = this.connectionManager.getConnectedPeers().length;
    const isDHTConnected = connectedPeers > 0;
    
    if (isDHTConnected) {
      // We're a DHT-connected node - don't automatically offer connections
      // This would create bootstrap server dependency for all DHT nodes
      console.log(`🌐 DHT-connected node: Ignoring bootstrap peer list (${peers.length} peers)`);
      console.log(`💡 Use inviteNewClient(clientId) for out-of-band invitations`);
      return;
    } else if (this.isGenesisPeer) {
      // Genesis peer doesn't connect to bootstrap peers automatically
      // It waits for explicit invitations to be sent
      console.log(`🌟 Genesis peer: Ignoring bootstrap peer list - use explicit invitations`);
      console.log(`💡 Use inviteNewClient(clientId) to invite specific peers`);
      return;
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
    if (this.connectionManager.isConnected(clientId)) {
      console.log(`🔗 Already connected to ${clientId}`);
      return true;
    }
    
    try {
      // Create invitation token for the client
      const invitationToken = await this.createInvitationToken(clientId, 30 * 60 * 1000); // 30 minute expiry
      
      // Temporarily reconnect to bootstrap if needed for invitation
      await this.ensureBootstrapConnectionForInvitation();
      
      // Send invitation token to bootstrap server to coordinate connection
      const invitationResult = await this.bootstrap.sendInvitation(clientId, invitationToken);
      
      if (!invitationResult.success) {
        console.warn(`Bootstrap server rejected invitation for ${clientId}: ${invitationResult.error}`);
        return false;
      }
      
      // Store target peer metadata from bootstrap response for transport selection
      if (invitationResult.data && invitationResult.data.targetPeerMetadata) {
        const targetMetadata = invitationResult.data.targetPeerMetadata;
        
        // Store metadata in the appropriate manager based on connection type
        if (targetMetadata.nodeType === 'nodejs') {
          // For Node.js clients using WebSocket connections
          if (this.connectionManager.websocketManager && this.connectionManager.websocketManager.setPeerMetadata) {
            this.connectionManager.websocketManager.setPeerMetadata(clientId, targetMetadata);
            console.log(`📋 Stored WebSocket peer metadata for ${clientId.substring(0, 8)}...:`, targetMetadata);
          } else if (this.connectionManager.setPeerMetadata) {
            // Fallback to WebRTC manager if WebSocket manager not available
            this.connectionManager.setPeerMetadata(clientId, targetMetadata);
            console.log(`📋 Stored peer metadata (fallback) for ${clientId.substring(0, 8)}...:`, targetMetadata);
          }
        } else {
          // For browser clients using WebRTC connections
          if (this.connectionManager.setPeerMetadata) {
            this.connectionManager.setPeerMetadata(clientId, targetMetadata);
            console.log(`📋 Stored WebRTC peer metadata for ${clientId.substring(0, 8)}...:`, targetMetadata);
          }
        }
      }
      
      // CRITICAL FIX: Temporarily force bootstrap signaling for invitation process
      const wasUsingBootstrapSignaling = this.useBootstrapForSignaling;
      console.log(`🔄 Forcing bootstrap signaling for invitation (was: ${wasUsingBootstrapSignaling})`);
      this.useBootstrapForSignaling = true;
      
      try {
        // Create connection to the invited peer using the correct transport
        if (invitationResult.data && invitationResult.data.targetPeerMetadata) {
          const targetMetadata = invitationResult.data.targetPeerMetadata;
          console.log(`🔗 Connecting to invited peer using metadata: ${targetMetadata.nodeType}`);
          
          // Use the same transport selection logic as in connectToPeerViaDHT
          if (targetMetadata.nodeType === 'nodejs' && targetMetadata.listeningAddress) {
            console.log(`🌐 Creating WebSocket connection to Node.js peer at ${targetMetadata.listeningAddress}`);
            await this.connectionManager.createWebSocketConnection(clientId, targetMetadata.listeningAddress);
          } else {
            console.log(`📡 Creating WebRTC connection to browser peer`);
            // Check if connection already exists (race condition handling)
            if (this.connectionManager.connections.has(clientId)) {
              console.log(`🔄 Connection to ${clientId} already exists, using existing connection`);
            } else {
              await this.connectionManager.createConnection(clientId, true);
            }
          }
        } else {
          console.log(`📤 Invitation sent - waiting for peer to connect (no metadata available)`);
        }
        
        // Wait a bit for the invitation to be processed and connection to establish
        setTimeout(() => {
          // Restore previous signaling mode
          console.log(`🔄 Restoring signaling mode to: ${wasUsingBootstrapSignaling ? 'bootstrap' : 'DHT'}`);
          this.useBootstrapForSignaling = wasUsingBootstrapSignaling;
          
          // Disconnect from bootstrap again after invitation (if we were using DHT signaling)
          if (!wasUsingBootstrapSignaling) {
            console.log(`🔌 Disconnecting from bootstrap after invitation sent`);
            setTimeout(() => {
              this.bootstrap.disconnect();
            }, 5000); // Wait 5 seconds for any pending operations
          }
        }, 15000); // Wait 15 seconds for connection to fully establish
        
      } catch (error) {
        // Restore signaling mode even if connection failed
        console.log(`🔄 Restoring signaling mode after error: ${wasUsingBootstrapSignaling ? 'bootstrap' : 'DHT'}`);
        this.useBootstrapForSignaling = wasUsingBootstrapSignaling;
        throw error;
      }
      
      console.log(`✅ Successfully invited ${clientId} to join DHT with token-based system`);
      return true;
      
    } catch (error) {
      console.error(`❌ Failed to invite client ${clientId}:`, error);
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
      
      // Handle WebSocket coordination if present
      if (invitationMessage.websocketCoordination) {
        await this.handleWebSocketCoordination(invitationMessage.websocketCoordination, fromPeer);
      }
      
      return true;
      
    } catch (error) {
      console.error('Error processing invitation:', error);
      return false;
    }
  }

  /**
   * Handle WebSocket coordination during invitation
   * IMPORTANT: Browser always connects TO Node.js, regardless of who initiated the invitation
   */
  async handleWebSocketCoordination(coordinationInfo, inviterPeerId) {
    console.log('🔗 Processing WebSocket coordination information');
    console.log('   Coordination:', coordinationInfo);
    
    try {
      // RULE: Browser ALWAYS connects to Node.js WebSocket server
      // regardless of who initiated the invitation
      
      if (coordinationInfo.inviterNodeType === 'nodejs' && coordinationInfo.inviterListeningAddress) {
        // Case 1: Node.js peer invited us (we could be browser or Node.js)
        // If we're a browser, connect to the Node.js peer's WebSocket server
        if (this.bootstrapMetadata?.nodeType === 'browser' || !this.bootstrapMetadata?.nodeType) {
          console.log(`🌐 Browser connecting to Node.js inviter's WebSocket server`);
          
          // Store Node.js peer metadata in HybridConnectionManager
          if (this.connectionManager.setPeerMetadata) {
            this.connectionManager.setPeerMetadata(inviterPeerId, {
              nodeType: 'nodejs',
              listeningAddress: coordinationInfo.inviterListeningAddress,
              capabilities: ['websocket']
            });
          }
          
          const success = await this.connectToWebSocketPeer(inviterPeerId, coordinationInfo.inviterListeningAddress);
          if (success) {
            console.log(`✅ Successfully connected to Node.js inviter via WebSocket`);
          } else {
            console.warn(`⚠️ Failed to connect to Node.js inviter via WebSocket`);
          }
        } else {
          console.log(`ℹ️ Node.js peer invited by Node.js peer - connecting via WebSocket`);
          
          // Store Node.js peer metadata in WebSocketManager
          if (this.connectionManager.setPeerMetadata) {
            this.connectionManager.setPeerMetadata(inviterPeerId, {
              nodeType: 'nodejs',
              listeningAddress: coordinationInfo.inviterListeningAddress,
              capabilities: ['websocket']
            });
          }
          
          const success = await this.connectToWebSocketPeer(inviterPeerId, coordinationInfo.inviterListeningAddress);
          if (success) {
            console.log(`✅ Successfully connected to Node.js inviter via WebSocket`);
          } else {
            console.warn(`⚠️ Failed to connect to Node.js inviter via WebSocket`);
          }
        }
        
      } else if (coordinationInfo.inviterNodeType === 'browser' && coordinationInfo.targetListeningAddress) {
        // Case 2: Browser peer invited us (we must be Node.js since we have a WebSocket server)
        // Browser should connect to OUR WebSocket server
        console.log(`🔄 Browser invited Node.js peer - browser should connect to our WebSocket server`);
        console.log(`   Our WebSocket address: ${coordinationInfo.targetListeningAddress}`);
        console.log(`   Waiting for browser to connect...`);
        
        // Note: We don't need to do anything here - the browser will connect to us
        // Our WebSocket server is already running and will handle the incoming connection
        
      } else {
        console.log(`ℹ️ No specific WebSocket coordination needed for this invitation type`);
      }
      
    } catch (error) {
      console.error(`❌ Error handling WebSocket coordination:`, error);
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
    
    // Double-check connection with a small delay to ensure it's stable
    setTimeout(() => {
      if (!this.connectionManager.isConnected(peerId)) {
        return;
      }
      
      if (this.routingTable.getNode(peerId)) {
        return;
      }
      
      const node = new DHTNode(peerId, peerId);
      
      // Store node type and transport information for connection decisions
      this.storePeerMetadataOnNode(node, peerId);
      
      const addResult = this.routingTable.addNode(node);
      
      if (addResult) {
        console.log(`📋 Added ${peerId} to routing table (${this.routingTable.getAllNodes().length} total)`);
        this.considerDHTSignaling();
      } else {
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
   * Store peer metadata on a DHTNode object from available sources
   */
  storePeerMetadataOnNode(node, peerId) {
    const nodeIdStr = typeof peerId === 'string' ? peerId : peerId.toString();
    
    // Try to get metadata from both WebSocket and WebRTC managers
    let storedMetadata = null;
    
    // First check WebSocket manager (for Node.js clients)
    if (this.connectionManager.websocketManager && this.connectionManager.websocketManager.peerMetadata && this.connectionManager.websocketManager.peerMetadata.get) {
      storedMetadata = this.connectionManager.websocketManager.peerMetadata.get(nodeIdStr);
      if (storedMetadata) {
        console.log(`📋 Found metadata in WebSocket manager for ${nodeIdStr.substring(0, 8)}...:`, storedMetadata);
      }
    }
    
    // If not found, check WebRTC manager (for browser clients)
    if (!storedMetadata && this.connectionManager.peerMetadata && this.connectionManager.peerMetadata.get) {
      storedMetadata = this.connectionManager.peerMetadata.get(nodeIdStr);
      if (storedMetadata) {
        console.log(`📋 Found metadata in WebRTC manager for ${nodeIdStr.substring(0, 8)}...:`, storedMetadata);
      }
    }
    
    if (storedMetadata) {
      // Use stored metadata from bootstrap discovery or invitation response
      node.setMetadata('nodeType', storedMetadata.nodeType || 'browser');
      node.setMetadata('listeningAddress', storedMetadata.listeningAddress);
      node.setMetadata('capabilities', storedMetadata.capabilities || []);
      console.log(`📋 Applied metadata to node ${nodeIdStr.substring(0, 8)}...: ${storedMetadata.nodeType}`);
    } else {
      // Default to browser if no metadata available
      node.setMetadata('nodeType', 'browser');
      node.setMetadata('capabilities', ['webrtc']);
      console.log(`📋 Default node info for ${nodeIdStr.substring(0, 8)}...: browser (no metadata)`);
    }
  }

  /**
   * Validate that a peer ID represents a valid DHT peer
   */
  isValidDHTPeer(peerId) {
    // Filter out bootstrap server connections and invalid peer IDs
    
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
    if (!this.connectionManager.isConnected(peerId) && !this.connectionManager.connections.has(peerId)) {
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
  }

  /**
   * Clean up routing table by removing peers without active WebRTC connections
   */
  cleanupRoutingTable() {
    const allNodes = this.routingTable.getAllNodes();
    let removedCount = 0;
    
    for (const node of allNodes) {
      const peerId = node.id.toString();
      if (!this.connectionManager.isConnected(peerId)) {
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
    console.log(`Message from ${peerId}:`, message.type);

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
        case 'webrtc_offer':
          await this.handleWebRTCOffer(peerId, message);
          break;
        case 'webrtc_answer':
          await this.handleWebRTCAnswer(peerId, message);
          break;
        case 'webrtc_ice':
          await this.handleWebRTCIceCandidate(peerId, message);
          break;
        case 'peer_discovery_request':
          await this.handlePeerDiscoveryRequest(peerId, message);
          break;
        case 'peer_discovery_response':
          await this.handlePeerDiscoveryResponse(peerId, message);
          break;
        case 'websocket_connection_request':
          await this.handleWebSocketConnectionRequest(peerId, message);
          break;
        case 'websocket_connection_response':
          await this.handleWebSocketConnectionResponse(peerId, message);
          break;
        default:
          console.warn(`Unknown message type from ${peerId}: ${message.type}`);
      }
    } catch (error) {
      console.error(`Error handling message from ${peerId}:`, error);
    }
  }

  /**
   * Handle outgoing WebRTC signal
   */
  async handleOutgoingSignal(peerId, signal) {
    // Determine signaling method based on peer status
    const isDHTMember = this.routingTable.getNode(peerId) !== null;
    const isInvitationFlow = signal.invitationFlow || false; // Flag for invitation process
    
    if (this.useBootstrapForSignaling || isInvitationFlow || !isDHTMember) {
      // Use bootstrap server for:
      // 1. New client invitations (invitation flow)
      // 2. Peers not yet in our routing table (not DHT members)
      // 3. When we're still using bootstrap for signaling
      console.log(`🔗 Using bootstrap signaling for ${peerId} (invitation: ${isInvitationFlow}, DHT member: ${isDHTMember})`);
      await this.bootstrap.forwardSignal(peerId, signal);
    } else {
      // Use DHT direct messaging for signaling between existing DHT members
      console.log(`🌐 Using DHT messaging for ${peerId} (existing DHT member)`);
      await this.sendDHTSignal(peerId, signal);
    }
  }

  /**
   * Send WebRTC signal via DHT direct messaging (for existing DHT members only)
   */
  async sendDHTSignal(peerId, signal) {
    console.log(`🚀 DHT Signaling: Sending ${signal.type} to ${peerId} via DHT messaging`);
    
    try {
      if (signal.type === 'offer') {
        await this.sendWebRTCOffer(peerId, signal.sdp);
      } else if (signal.type === 'answer') {
        await this.sendWebRTCAnswer(peerId, signal.sdp);
      } else if (signal.type === 'candidate') {
        await this.sendWebRTCIceCandidate(peerId, {
          candidate: signal.candidate,
          sdpMLineIndex: signal.sdpMLineIndex,
          sdpMid: signal.sdpMid
        });
      } else {
        console.warn(`Unknown signal type for DHT messaging: ${signal.type}`);
      }
    } catch (error) {
      console.error(`Failed to send DHT signal ${signal.type} to ${peerId}:`, error);
      
      // Fallback to bootstrap signaling if DHT messaging fails
      console.log(`🔄 Falling back to bootstrap signaling for ${peerId}`);
      await this.bootstrap.forwardSignal(peerId, signal);
    }
  }

  /**
   * Store WebRTC signal in DHT with appropriate key based on signal type
   */
  async storeDHTSignal(peerId, signal) {
    let key;
    let logMessage;
    
    if (signal.type === 'offer') {
      key = `webrtc_offer:${this.localNodeId.toString()}:${peerId}`;
      logMessage = `📤 Stored WebRTC offer for ${peerId} in DHT`;
    } else if (signal.type === 'answer') {
      key = `webrtc_answer:${this.localNodeId.toString()}:${peerId}`;
      logMessage = `📤 Stored WebRTC answer for ${peerId} in DHT`;
    } else if (signal.candidate) {
      key = `ice_candidate:${this.localNodeId.toString()}:${peerId}:${Date.now()}`;
      logMessage = `📤 Stored ICE candidate for ${peerId} in DHT`;
    } else {
      console.warn(`Unknown signal type for ${peerId}:`, signal);
      return;
    }

    const value = {
      signal,
      timestamp: Date.now(),
      from: this.localNodeId.toString(),
      to: peerId
    };

    try {
      await this.store(key, value);
      console.log(logMessage);
    } catch (error) {
      console.error(`Failed to store signal for ${peerId}:`, error);
    }
  }

  /**
   * Handle incoming signal from bootstrap
   */
  async handleIncomingSignal(fromPeer, signal) {
    await this.connectionManager.handleSignal(fromPeer, signal);
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
        await this.connectionManager.handleSignal(peerId, result.signal);
      }
    } catch (error) {
      console.error(`DHT ICE retrieval failed from ${peerId}:`, error);
    }
  }

  /**
   * Consider switching to DHT-based signaling
   */
  considerDHTSignaling() {
    const connectedPeers = this.connectionManager.getConnectedPeers().length;
    
    if (connectedPeers >= 1 && !this.useBootstrapForSignaling) {
      return;
    }
    
    if (connectedPeers >= 1) {
      console.log('🌐 Switching to DHT-based signaling');
      this.useBootstrapForSignaling = false;
      
      // NOTE: DHT offer polling is obsolete - we now use direct DHT messaging
      // WebRTC offers are sent via 'webrtc_offer' messages and handled immediately
      // No need to poll DHT storage for offers anymore
      
      setTimeout(() => {
        this.bootstrap.disconnect();
      }, 5000);
    }
  }

  /**
   * Force enable/disable bootstrap signaling (for testing)
   */
  setBootstrapSignaling(enabled) {
    this.useBootstrapForSignaling = enabled;
  }

  /**
   * Connect to peer using appropriate transport based on node type
   */
  async connectToPeerViaDHT(peerId) {
    
    // Skip if already connected
    if (this.connectionManager.isConnected(peerId)) {
      console.log(`Already connected to ${peerId}`);
      return true;
    }
    
    // Skip if we already have a pending WebSocket connection request for this peer
    if (this.pendingWebSocketRequests.has(peerId)) {
      console.log(`⏳ WebSocket connection request already pending for ${peerId}`);
      return false;
    }

    try {
      // Determine LOCAL client type and TARGET peer type
      const localType = this.bootstrapMetadata?.nodeType || (typeof window !== 'undefined' ? 'browser' : 'nodejs');
      const node = this.routingTable.getNode(peerId);
      const targetType = node?.getMetadata('nodeType') || 'browser';
      const targetListeningAddress = node?.getMetadata('listeningAddress');
      
      console.log(`🔄 Connection matrix: ${localType} → ${targetType} peer ${peerId.substring(0, 8)}...`);
      
      // Apply connection matrix logic
      if (localType === 'browser' && targetType === 'browser') {
        // WebRTC (Browser) → WebRTC (Browser): Use WebRTC with Perfect Negotiation
        console.log(`🌐 Browser-to-Browser: Using WebRTC connection`);
        
        // Ensure connection manager has correct metadata for transport selection
        if (this.connectionManager.setPeerMetadata) {
          this.connectionManager.setPeerMetadata(peerId, {
            nodeType: 'browser',
            capabilities: ['webrtc']
          });
        }
        
        await this.connectionManager.createConnection(peerId, true);
        
      } else if (localType === 'browser' && targetType === 'nodejs') {
        // WebRTC (Browser) → WebSocket (Node.js): Browser connects as WebSocket client
        console.log(`🌐 Browser-to-Node.js: Browser connecting as WebSocket client to ${targetListeningAddress}`);
        
        if (!targetListeningAddress) {
          throw new Error(`No WebSocket address available for Node.js peer ${peerId}`);
        }
        
        // Ensure connection manager has correct metadata for transport selection
        if (this.connectionManager.setPeerMetadata) {
          this.connectionManager.setPeerMetadata(peerId, {
            nodeType: 'nodejs',
            listeningAddress: targetListeningAddress,
            capabilities: ['websocket']
          });
        }
        
        await this.connectionManager.createWebSocketConnection(peerId, targetListeningAddress);
        
      } else if (localType === 'nodejs' && targetType === 'browser') {
        // WebSocket (Node.js) → WebRTC (Browser): Node.js acts as server, request browser to connect
        console.log(`🌐 Node.js-to-Browser: Requesting browser to connect to our WebSocket server`);
        
        // Get our WebSocket listening address
        const ourListeningAddress = this.connectionManager.websocketManager?.listeningAddress || 
                                    this.bootstrapMetadata?.listeningAddress ||
                                    'ws://localhost:9500'; // fallback
        
        // Track this pending request to prevent duplicates
        this.pendingWebSocketRequests.set(peerId, {
          timestamp: Date.now(),
          nodeType: 'nodejs',
          listeningAddress: ourListeningAddress
        });
        
        // Set up timeout to clean up pending request
        setTimeout(() => {
          if (this.pendingWebSocketRequests.has(peerId)) {
            console.log(`⏰ WebSocket connection request timeout for ${peerId}`);
            this.pendingWebSocketRequests.delete(peerId);
          }
        }, this.webSocketRequestTimeout);
        
        await this.sendWebSocketConnectionRequest(peerId, {
          nodeType: 'nodejs',
          listeningAddress: ourListeningAddress,
          capabilities: ['websocket', 'relay'],
          canRelay: true
        });
        
        console.log(`👂 Waiting for browser to connect to our WebSocket server at ${ourListeningAddress}`);
        
      } else if (localType === 'nodejs' && targetType === 'nodejs') {
        // WebSocket (Node.js) → WebSocket (Node.js): Use Perfect Negotiation Pattern for WebSocket
        console.log(`🌐 Node.js-to-Node.js: Using WebSocket with Perfect Negotiation`);
        
        if (!targetListeningAddress) {
          throw new Error(`No WebSocket address available for Node.js peer ${peerId}`);
        }
        
        // For Node.js-to-Node.js, determine who connects to whom based on node IDs (similar to WebRTC Perfect Negotiation)
        const shouldConnectToTarget = this.localNodeId.toString() < peerId;
        
        if (shouldConnectToTarget) {
          console.log(`🔗 We initiate: Connecting to Node.js peer's WebSocket server at ${targetListeningAddress}`);
          await this.connectionManager.createWebSocketConnection(peerId, targetListeningAddress);
        } else {
          console.log(`👂 We wait: Requesting Node.js peer to connect to our WebSocket server`);
          
          // Get our WebSocket listening address
          const ourListeningAddress = this.connectionManager.websocketManager?.listeningAddress || 
                                      this.bootstrapMetadata?.listeningAddress ||
                                      'ws://localhost:9500'; // fallback
          
          this.pendingWebSocketRequests.set(peerId, {
            timestamp: Date.now(),
            nodeType: 'nodejs',
            listeningAddress: ourListeningAddress
          });
          
          setTimeout(() => {
            if (this.pendingWebSocketRequests.has(peerId)) {
              console.log(`⏰ WebSocket connection request timeout for ${peerId}`);
              this.pendingWebSocketRequests.delete(peerId);
            }
          }, this.webSocketRequestTimeout);
          
          await this.sendWebSocketConnectionRequest(peerId, {
            nodeType: 'nodejs',
            listeningAddress: ourListeningAddress,
            capabilities: ['websocket', 'relay'],
            canRelay: true
          });
        }
      } else {
        throw new Error(`Unknown connection matrix: ${localType} → ${targetType}`);
      }
      
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
          await this.connectionManager.handleSignal(peerId, answerData.signal);
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
    const connectedPeers = this.connectionManager.getConnectedPeers();
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
      const connectedPeers = this.connectionManager.getConnectedPeers();
      
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
    
    const connectedPeers = this.connectionManager.getConnectedPeers();
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
      if (this.connectionManager.connections.has(peerId)) {
        console.log(`🔄 Connection already exists for ${peerId}, using existing connection for offer`);
        // Use existing connection to handle the offer
        await this.connectionManager.handleSignal(peerId, offerSignal);
        return;
      }
      
      // Create incoming connection to handle the offer
      await this.connectionManager.createConnection(peerId, false); // false = not initiator
      
      console.log(`📥 Responding to offer from ${peerId}`);
      await this.connectionManager.handleSignal(peerId, offerSignal);
    } catch (error) {
      // If connection already exists, try to use it for the offer
      if (error.message.includes('already exists')) {
        console.log(`🔄 Race condition detected for ${peerId}, using existing connection`);
        try {
          await this.connectionManager.handleSignal(peerId, offerSignal);
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
    if (this.connectionManager.isConnected(targetPeerId)) {
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
      
      // Create WebRTC connection
      console.log(`Creating directed WebRTC connection to ${targetPeerId} (attempt ${retryCount + 1}/${maxRetries + 1})`);
      await this.connectionManager.createConnection(targetPeerId, true);
      
      // Wait a bit for connection to establish
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Check if connection succeeded
      if (this.connectionManager.isConnected(targetPeerId)) {
        console.log(`Successfully connected to ${targetPeerId}`);
        return true;
      }
      
      // If not connected and we have retries left, try again
      if (retryCount < maxRetries) {
        console.log(`Connection attempt ${retryCount + 1} failed, retrying...`);
        // Clean up failed connection
        if (this.connectionManager.peers.has(targetPeerId)) {
          this.connectionManager.destroyConnection(targetPeerId);
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
      await this.connectionManager.handleSignal(peerId, signal);
      
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

    const closest = this.routingTable.findClosestNodes(target, this.options.k);
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
          const isConnected = this.connectionManager.isConnected(node.id.toString());
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
            results.add(peerNode);
            
            // CRITICAL: Add discovered peers to routing table (this is core Kademlia behavior)
            // findNode MUST populate routing table with discovered nodes for proper DHT function
            const peerId = peerNode.id.toString();
            
            // Skip ourselves
            if (peerId === this.localNodeId.toString()) {
              continue;
            }
            
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
                
                // Update peer metadata for transport selection
                if (peerNode.endpoint && this.connectionManager.setPeerMetadata) {
                  // Try to infer node type from endpoint
                  const metadata = {
                    nodeType: peerNode.endpoint.startsWith('ws://') ? 'nodejs' : 'browser',
                    listeningAddress: peerNode.endpoint
                  };
                  this.connectionManager.setPeerMetadata(peerId, metadata);
                }
                
                // Note: Discovered nodes are added to routing table but not immediately connected
                // Background process will handle connection attempts based on k-bucket priority
              }
            }
          }
        } catch (error) {
          console.warn(`Find node query failed for ${node.id.toString()}:`, error);
          
          // Track failed peer queries to prevent repeated attempts
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
      .slice(0, this.options.k);
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
    if (!this.connectionManager.isConnected(peerId)) {
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
    const targetId = DHTNodeId.fromString(message.target);
    const closestNodes = this.routingTable.findClosestNodes(targetId, this.options.k);

    const response = {
      type: 'find_node_response',
      requestId: message.requestId,
      nodes: closestNodes.map(node => node.toCompact())
    };

    await this.sendMessage(peerId, response);
  }

  /**
   * Store key-value pair in DHT
   */
  async store(key, value) {
    console.log(`Storing key: ${key}`);
    console.log(`Current routing table size: ${this.routingTable.getAllNodes().length}`);
    console.log(`Connected peers: ${this.connectionManager.getConnectedPeers().length}`);
    
    // Clean routing table of disconnected peers before operations
    this.cleanupRoutingTable();
    
    const keyId = DHTNodeId.fromString(key);
    const closestNodes = await this.findNode(keyId);
    
    // Filter to only peers with active WebRTC connections
    const connectedClosestNodes = closestNodes.filter(node => {
      const peerId = node.id.toString();
      const isConnected = this.connectionManager.isConnected(peerId);
      if (!isConnected) {
        // Node not connected, but we still track it as a potential contact
      }
      return isConnected;
    });
    
    
    // Store locally if we're one of the closest
    const localDistance = this.localNodeId.xorDistance(keyId);
    const shouldStoreLocally = connectedClosestNodes.length < this.options.replicateK ||
      connectedClosestNodes.some(node => {
        const nodeDistance = node.id.xorDistance(keyId);
        return localDistance.compare(nodeDistance) <= 0;
      });

    if (shouldStoreLocally) {
      this.storage.set(key, {
        value,
        timestamp: Date.now(),
        publisher: this.localNodeId.toString()
      });
    }

    // Store on closest connected nodes
    const storePromises = connectedClosestNodes
      .slice(0, this.options.replicateK)
      .map(node => this.sendStore(node.id.toString(), key, value));

    const results = await Promise.allSettled(storePromises);
    const successes = results.filter(r => r.status === 'fulfilled').length;
    // const failures = results.filter(r => r.status === 'rejected');
    
    
    // Add to republish queue
    this.republishQueue.set(key, Date.now() + this.options.republishInterval);
    
    return successes > 0;
  }

  /**
   * Send store request
   */
  async sendStore(peerId, key, value) {
    // Verify connection before sending request
    if (!this.connectionManager.isConnected(peerId)) {
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
    // Check local storage first
    if (this.storage.has(key)) {
      const stored = this.storage.get(key);
      return stored.value;
    }

    // Search DHT
    const keyId = DHTNodeId.fromString(key);
    const closestNodes = await this.findNode(keyId);

    // Query nodes for the value
    for (const node of closestNodes) {
      try {
        const response = await this.sendFindValue(node.id.toString(), key);
        if (response.found && response.value !== undefined) {
          return response.value;
        }
      } catch (error) {
        console.warn(`Find value query failed for ${node.id.toString()}:`, error);
      }
    }

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
    if (!this.connectionManager.isConnected(peerId)) {
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
    
    if (this.storage.has(key)) {
      // Return the value
      const stored = this.storage.get(key);
      const response = {
        type: 'find_value_response',
        requestId: message.requestId,
        found: true,
        value: stored.value
      };
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
      await this.sendMessage(peerId, response);
    }
  }

  /**
   * Send message to peer
   */
  async sendMessage(peerId, message) {
    return this.connectionManager.sendMessage(peerId, message);
  }

  /**
   * Send request and wait for response
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
  }

  /**
   * Schedule adaptive refresh based on network connectivity
   */
  scheduleAdaptiveRefresh() {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    
    const connectedPeers = this.connectionManager.getConnectedPeers().length;
    const routingNodes = this.routingTable.getAllNodes().length;
    
    // Determine appropriate refresh interval based on connectivity
    let nextInterval;
    if (connectedPeers < 2 || routingNodes < 3) {
      // New/isolated node - aggressive discovery
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
    const connectedPeers = this.connectionManager.getConnectedPeers().length;
    const routingNodes = this.routingTable.getAllNodes().length;
    const now = Date.now();
    
    console.log(`🔄 Checking stale buckets: ${connectedPeers} connected, ${routingNodes} routing`);
    
    // Track bucket activity during lookups (this should be called from findNode)
    this.updateBucketActivity();
    
    // For new/isolated nodes, be more aggressive
    if (connectedPeers < 2 || routingNodes < 3) {
      console.log(`🆘 Emergency peer discovery - very few peers`);
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
    const connectedPeers = this.connectionManager.getConnectedPeers();
    
    // Mark buckets containing connected peers as active
    for (const peerId of connectedPeers) {
      try {
        const peerNodeId = DHTNodeId.fromString(peerId);
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
    console.log(`🚨 Emergency peer discovery mode`);
    
    // Use direct peer discovery first
    await this.discoverPeersViaDHT();
    
    // Limited targeted searches for emergency only
    const maxSearches = 3;
    const targetDistances = [1, 32, 80, 120, 159]; // Spread across key space
    const searchPromises = [];
    
    for (let i = 0; i < Math.min(maxSearches, targetDistances.length); i++) {
      const distance = targetDistances[i];
      const randomId = DHTNodeId.generateAtDistance(this.localNodeId, distance);
      
      searchPromises.push(
        this.findNode(randomId, { emergencyBypass: true }).catch(error => {
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
    const connectedPeers = this.connectionManager.getConnectedPeers().length;
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
    
    const newConnectedPeers = this.connectionManager.getConnectedPeers().length;
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
    const allNodes = this.routingTable.getAllNodes();
    const unconnectedPeers = allNodes.filter(node => 
      !this.connectionManager.isConnected(node.id.toString())
    );
    
    if (unconnectedPeers.length === 0) {
      console.log(`✅ All discovered peers already connected`);
      return;
    }
    
    console.log(`🤝 Connecting to ${Math.min(3, unconnectedPeers.length)} recently discovered peers`);
    
    // Limit concurrent connection attempts to avoid overwhelming
    const maxConcurrent = 3;
    const toConnect = unconnectedPeers.slice(0, maxConcurrent);
    
    for (const node of toConnect) {
      const peerId = node.id.toString();
      
      // Quick validation only
      if (!this.isValidDHTPeer(peerId)) {
        continue;
      }
      
      // Check connection limits
      if (!(await this.shouldConnectToPeer(peerId))) {
        continue;
      }
      
      try {
        console.log(`🔗 Connecting to discovered peer: ${peerId.substring(0, 8)}...`);
        await this.connectToPeerViaDHT(peerId);
      } catch (error) {
        console.warn(`❌ Failed to connect to ${peerId.substring(0, 8)}...: ${error.message}`);
      }
    }
    
    console.log('✅ Recent peer connection attempts completed');
  }

  /**
   * Dedicated peer discovery for k-bucket maintenance
   * This method discovers and validates actual peer nodes (not storage keys or random IDs)
   */
  async discoverPeers() {
    const allNodes = this.routingTable.getAllNodes();
    const unconnectedPeers = allNodes.filter(node => 
      !this.connectionManager.isConnected(node.id.toString())
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
   * Background process to connect to unconnected nodes in routing table
   * This is called periodically during adaptive refresh
   */
  async connectToUnconnectedRoutingNodes() {
    const allNodes = this.routingTable.getAllNodes();
    const connectedPeers = this.connectionManager.getConnectedPeers();
    const unconnectedNodes = allNodes.filter(node => {
      const peerId = node.id.toString();
      return !this.connectionManager.isConnected(peerId) && 
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
        console.log(`🔗 Background connecting to routing table node: ${peerId.substring(0, 8)}...`);
        await this.connectionManager.createConnection(peerId, true);
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
    if (this.connectionManager.isConnected(peerId) || this.connectionManager.connections.has(peerId)) {
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
    const staleConnections = this.connectionManager.cleanupStaleConnections();

    if (cleaned > 0 || staleRemoved > 0 || routingCleanup > 0 || staleConnections > 0) {
      console.log(`Cleanup: ${cleaned} storage, ${staleRemoved} stale nodes, ${routingCleanup} routing inconsistencies, ${staleConnections} connections`);
    }
  }

  /**
   * Ping nodes that need pinging
   */
  async pingNodes() {
    const nodesToPing = this.routingTable.getNodesToPing(this.options.pingInterval);
    
    for (const node of nodesToPing) {
      if (this.connectionManager.isConnected(node.id.toString())) {
        await this.sendPing(node.id.toString());
      }
    }
  }

  /**
   * Get DHT statistics
   */
  getStats() {
    return {
      nodeId: this.localNodeId.toString(),
      isStarted: this.isStarted,
      isBootstrapped: this.isBootstrapped,
      useBootstrapForSignaling: this.useBootstrapForSignaling,
      storage: {
        keys: this.storage.size,
        republishQueue: this.republishQueue.size
      },
      routing: this.routingTable.getStats(),
      webrtc: this.connectionManager.getStats(),
      bootstrap: this.bootstrap.getStatus()
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
    this.connectionManager.destroy();
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
      
      // Pure response handling - peer discovery is now handled by dedicated discoverPeers() method
      request.resolve(message);
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
    }
  }

  /**
   * Handle find value response
   */
  async handleFindValueResponse(peerId, message) {
    const request = this.pendingRequests.get(message.requestId);
    if (request) {
      this.pendingRequests.delete(message.requestId);
      request.resolve(message);
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
      await this.routeWebRTCMessage(message.targetPeer, message);
      return;
    }

    // This offer is for us - process it
    console.log(`📥 Processing WebRTC offer from ${message.senderPeer}`);
    
    try {
      // Handle the WebRTC offer using our existing WebRTC manager
      await this.connectionManager.handleSignal(message.senderPeer, {
        type: 'offer',
        sdp: message.offer
      });
    } catch (error) {
      console.error(`Failed to process WebRTC offer from ${message.senderPeer}:`, error);
    }
  }

  /**
   * Handle WebRTC answer message via DHT
   */
  async handleWebRTCAnswer(fromPeer, message) {
    console.log(`🔄 DHT WebRTC: Received answer from ${fromPeer} for peer ${message.targetPeer}`);
    
    // Check if this answer is for us
    if (message.targetPeer !== this.localNodeId.toString()) {
      // This is a routed message - forward it to the target peer
      await this.routeWebRTCMessage(message.targetPeer, message);
      return;
    }

    // This answer is for us - process it
    console.log(`📥 Processing WebRTC answer from ${message.senderPeer}`);
    
    try {
      // Handle the WebRTC answer using our existing WebRTC manager
      await this.connectionManager.handleSignal(message.senderPeer, {
        type: 'answer',
        sdp: message.answer
      });
    } catch (error) {
      console.error(`Failed to process WebRTC answer from ${message.senderPeer}:`, error);
    }
  }

  /**
   * Handle WebRTC ICE candidate message via DHT
   */
  async handleWebRTCIceCandidate(fromPeer, message) {
    console.log(`🔄 DHT WebRTC: Received ICE candidate from ${fromPeer} for peer ${message.targetPeer}`);
    
    // Check if this ICE candidate is for us
    if (message.targetPeer !== this.localNodeId.toString()) {
      // This is a routed message - forward it to the target peer
      await this.routeWebRTCMessage(message.targetPeer, message);
      return;
    }

    // This ICE candidate is for us - process it
    console.log(`📥 Processing ICE candidate from ${message.senderPeer}`);
    
    try {
      // Handle the ICE candidate using our existing WebRTC manager
      await this.connectionManager.handleSignal(message.senderPeer, {
        type: 'candidate',
        candidate: message.candidate.candidate,
        sdpMLineIndex: message.candidate.sdpMLineIndex,
        sdpMid: message.candidate.sdpMid
      });
    } catch (error) {
      console.error(`Failed to process ICE candidate from ${message.senderPeer}:`, error);
    }
  }

  /**
   * Route WebRTC message to target peer through DHT
   */
  async routeWebRTCMessage(targetPeer, message) {
    console.log(`🚀 Routing WebRTC message to ${targetPeer}: ${message.type}`);
    
    try {
      // Try to send directly if we have a connection to the target
      if (this.connectionManager.isConnected(targetPeer)) {
        await this.sendMessage(targetPeer, message);
        console.log(`✅ Directly routed WebRTC message to ${targetPeer}`);
        return;
      }

      // Find best next hop using DHT routing - convert hex string to DHTNodeId properly
      const targetNodeId = DHTNodeId.fromString(targetPeer);
      const closestNodes = this.routingTable.findClosestNodes(targetNodeId, this.options.alpha);
      
      if (closestNodes.length === 0) {
        console.warn(`No route found to forward WebRTC message to ${targetPeer}`);
        return;
      }

      // Send to the closest connected peer
      for (const node of closestNodes) {
        const nextHop = node.id.toString();
        if (this.connectionManager.isConnected(nextHop)) {
          await this.sendMessage(nextHop, message);
          console.log(`✅ Routed WebRTC message via ${nextHop} to ${targetPeer}`);
          return;
        }
      }

      console.warn(`No connected route found to forward WebRTC message to ${targetPeer}`);
    } catch (error) {
      console.error(`Failed to route WebRTC message to ${targetPeer}:`, error);
    }
  }

  /**
   * Send WebRTC offer via DHT messaging
   */
  async sendWebRTCOffer(targetPeer, offer) {
    console.log(`📤 Sending WebRTC offer via DHT to ${targetPeer}`);
    
    const message = {
      type: 'webrtc_offer',
      senderPeer: this.localNodeId.toString(),
      targetPeer: targetPeer,
      offer: offer,
      timestamp: Date.now()
    };

    await this.routeWebRTCMessage(targetPeer, message);
  }

  /**
   * Send WebRTC answer via DHT messaging
   */
  async sendWebRTCAnswer(targetPeer, answer) {
    console.log(`📤 Sending WebRTC answer via DHT to ${targetPeer}`);
    
    const message = {
      type: 'webrtc_answer',
      senderPeer: this.localNodeId.toString(),
      targetPeer: targetPeer,
      answer: answer,
      timestamp: Date.now()
    };

    await this.routeWebRTCMessage(targetPeer, message);
  }

  /**
   * Send WebRTC ICE candidate via DHT messaging
   */
  async sendWebRTCIceCandidate(targetPeer, candidate) {
    console.log(`📤 Sending WebRTC ICE candidate via DHT to ${targetPeer}`);
    
    const message = {
      type: 'webrtc_ice',
      senderPeer: this.localNodeId.toString(),
      targetPeer: targetPeer,
      candidate: candidate,
      timestamp: Date.now()
    };

    await this.routeWebRTCMessage(targetPeer, message);
  }

  /**
   * Handle peer discovery request - respond with willingness to connect
   */
  async handlePeerDiscoveryRequest(fromPeer, message) {
    console.log(`🔍 Received peer discovery request from ${fromPeer}`);
    
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

    await this.sendMessage(fromPeer, response);
    
    if (shouldConnect && !this.connectionManager.isConnected(fromPeer)) {
      // Initiate WebRTC connection using DHT signaling
      console.log(`🤝 Initiating WebRTC connection to discovered peer: ${fromPeer}`);
      try {
        await this.connectionManager.createConnection(fromPeer, true);
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
    
    if (message.willing && !this.connectionManager.isConnected(fromPeer)) {
      // Peer is willing to connect - wait for their WebRTC offer or send ours
      console.log(`✅ Peer ${fromPeer} is willing to connect, preparing for WebRTC negotiation`);
      
      // Add to routing table if not already there
      if (!this.routingTable.getNode(fromPeer)) {
        const node = new DHTNode(fromPeer, 'discovered-peer');
        node.lastSeen = Date.now();
        
        // Store peer metadata for connection decisions
        this.storePeerMetadataOnNode(node, fromPeer);
        
        this.routingTable.addNode(node);
        console.log(`📋 Added discovered peer ${fromPeer} to routing table`);
      }
    }
  }

  /**
   * Handle WebSocket connection request from Node.js node
   */
  async handleWebSocketConnectionRequest(fromPeer, message) {
    console.log(`🌐 Received WebSocket connection request from ${fromPeer}`);
    
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
      await this.routeWebRTCMessage(message.targetPeer, message);
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
        if (typeof window !== 'undefined') {
          // We're a browser - connect to the Node.js WebSocket server
          console.log(`🔌 Browser connecting to Node.js WebSocket server: ${message.listeningAddress}`);
          await this.connectToWebSocketPeer(message.senderPeer, message.listeningAddress);
          
          // Send success response
          await this.sendWebSocketConnectionResponse(message.senderPeer, {
            success: true,
            nodeType: 'browser',
            capabilities: ['webrtc']
          });
        } else {
          // We're also a Node.js client - connect to the other Node.js WebSocket server
          console.log(`🔌 Node.js client connecting to another Node.js WebSocket server: ${message.listeningAddress}`);
          await this.connectionManager.createWebSocketConnection(message.senderPeer, message.listeningAddress);
          
          // Send success response
          await this.sendWebSocketConnectionResponse(message.senderPeer, {
            success: true,
            nodeType: 'nodejs',
            capabilities: ['websocket', 'relay'],
            listeningAddress: this.connectionManager.websocketManager?.listeningAddress || this.bootstrapMetadata?.listeningAddress
          });
        }

      } catch (error) {
        console.error(`❌ Failed to connect to WebSocket server: ${error.message}`);
        
        // Send failure response
        await this.sendWebSocketConnectionResponse(message.senderPeer, {
          success: false,
          error: error.message,
          nodeType: typeof window !== 'undefined' ? 'browser' : 'nodejs'
        });
      }
    } else if (message.nodeType === 'browser' && typeof window === 'undefined') {
      // Browser is asking Node.js to connect - this doesn't make sense since browsers can't run servers
      console.log(`ℹ️ Browser client asking Node.js to connect - not applicable (browsers can't run WebSocket servers)`);
      await this.sendWebSocketConnectionResponse(message.senderPeer, {
        success: false,
        error: 'Browser clients cannot run WebSocket servers',
        nodeType: 'nodejs'
      });
    } else {
      console.log(`ℹ️ WebSocket connection request not applicable for this configuration`);
      console.log(`   Our type: ${typeof window !== 'undefined' ? 'browser' : 'nodejs'}, Request from: ${message.nodeType}`);
    }
  }

  /**
   * Handle WebSocket connection response
   */
  async handleWebSocketConnectionResponse(fromPeer, message) {
    console.log(`🌐 Received WebSocket connection response from ${fromPeer}: success=${message.success}`);
    
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
      await this.routeWebRTCMessage(message.targetPeer, message);
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
   * Send WebSocket connection request via DHT messaging
   */
  async sendWebSocketConnectionRequest(targetPeer, connectionInfo) {
    console.log(`📤 Sending WebSocket connection request via DHT to ${targetPeer}`);
    
    const message = {
      type: 'websocket_connection_request',
      senderPeer: this.localNodeId.toString(),
      targetPeer: targetPeer,
      nodeType: connectionInfo.nodeType || 'nodejs',
      listeningAddress: connectionInfo.listeningAddress,
      capabilities: connectionInfo.capabilities || ['websocket'],
      canRelay: connectionInfo.canRelay || false,
      timestamp: Date.now()
    };

    await this.routeWebRTCMessage(targetPeer, message);
  }

  /**
   * Send WebSocket connection response via DHT messaging
   */
  async sendWebSocketConnectionResponse(targetPeer, responseInfo) {
    console.log(`📤 Sending WebSocket connection response via DHT to ${targetPeer}`);
    
    const message = {
      type: 'websocket_connection_response',
      senderPeer: this.localNodeId.toString(),
      targetPeer: targetPeer,
      success: responseInfo.success,
      error: responseInfo.error,
      nodeType: responseInfo.nodeType,
      capabilities: responseInfo.capabilities || [],
      timestamp: Date.now()
    };

    await this.routeWebRTCMessage(targetPeer, message);
  }

  /**
   * Connect to WebSocket peer (Browser → Node.js or Node.js → Node.js connection)
   */
  async connectToWebSocketPeer(peerId, websocketAddress) {
    console.log(`🔌 Establishing WebSocket connection to ${peerId} at ${websocketAddress}`);
    
    try {
      // Use connection manager's WebSocket connection capability
      // Works with both WebSocketManager (Node.js) and HybridConnectionManager (Browser)
      const ws = await this.connectionManager.createWebSocketConnection(peerId, websocketAddress);
      
      console.log(`✅ Successfully connected to WebSocket peer ${peerId}`);
      
      // Clean up any pending WebSocket connection request for this peer
      this.pendingWebSocketRequests.delete(peerId);
      
      // Add to routing table
      const nodeId = DHTNodeId.fromString(peerId);
      const peer = new DHTNode(nodeId);
      
      // Store peer metadata (this is a WebSocket connection, so it's a Node.js peer)
      peer.setMetadata('nodeType', 'nodejs');
      peer.setMetadata('listeningAddress', websocketAddress);
      peer.setMetadata('capabilities', ['websocket']);
      
      this.routingTable.addNode(peer);
      
      // Send welcome message to establish DHT protocol
      await this.connectionManager.sendMessage(peerId, {
        type: 'ping',
        nodeId: this.localNodeId.toString(),
        timestamp: Date.now()
      });
      
      console.log(`📡 DHT handshake sent to WebSocket peer ${peerId}`);
      
      return true;
    } catch (error) {
      console.error(`❌ Failed to connect to WebSocket peer ${peerId}:`, error.message);
      return false;
    }
  }

  /**
   * Check if we should connect to a peer (prevent overconnection)
   */
  async shouldConnectToPeer(peerId) {
    // Don't connect if already connected
    if (this.connectionManager.isConnected(peerId)) {
      return false;
    }

    // Don't connect to ourselves
    if (peerId === this.localNodeId.toString()) {
      return false;
    }

    // Check if we're under the connection limit
    const currentConnections = this.connectionManager.getConnectedPeers().length;
    const maxConnections = this.connectionManager.options.maxConnections || 50;
    
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

    await this.routeWebRTCMessage(targetPeer, message);
    return requestId;
  }

  /**
   * Replace old storage-based peer discovery with direct DHT messaging
   */
  async discoverPeersViaDHT() {
    console.log(`🔍 Discovering peers via direct DHT messaging...`);
    
    try {
      const routingNodes = this.routingTable.getAllNodes();
      const connectedPeers = this.connectionManager.getConnectedPeers();
      
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
          
          await this.sendMessage(connectedPeer, findNodeRequest);
        } catch (error) {
          console.warn(`Failed to request nodes from ${connectedPeer}:`, error);
        }
      }
      
    } catch (error) {
      console.error(`Error during DHT peer discovery:`, error);
    }
  }
}

export default KademliaDHT;