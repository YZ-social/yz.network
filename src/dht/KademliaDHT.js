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
      refreshInterval: options.refreshInterval || 30 * 1000, // 30 seconds (dev-friendly)
      republishInterval: options.republishInterval || 24 * 60 * 60 * 1000, // 24 hours
      expireInterval: options.expireInterval || 24 * 60 * 60 * 1000, // 24 hours
      pingInterval: options.pingInterval || 60 * 1000, // 1 minute (dev-friendly)
      bootstrapServers: options.bootstrapServers || ['ws://localhost:8080'],
      ...options
    };

    // Generate or use provided node ID
    this.localNodeId = options.nodeId ? 
      DHTNodeId.fromString(options.nodeId) : 
      new DHTNodeId();

    // Core components
    this.routingTable = new RoutingTable(this.localNodeId, this.options.k);
    this.webrtc = new WebRTCManager(options.webrtc || {});
    this.bootstrap = new BootstrapClient({ 
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
    this.setupWebRTCEventHandlers();
    this.setupBootstrapEventHandlers();
  }

  /**
   * Setup WebRTC manager event handlers
   */
  setupWebRTCEventHandlers() {
    // Remove existing listeners first to prevent duplicates
    this.webrtc.removeAllListeners('peerConnected');
    this.webrtc.removeAllListeners('peerDisconnected');
    this.webrtc.removeAllListeners('data');
    this.webrtc.removeAllListeners('signal');
    
    const peerConnectedHandler = ({ peerId }) => {
      console.log(`🔗 Peer connected: ${peerId}`);
      this.handlePeerConnected(peerId);
      
      setTimeout(() => {
        this.considerDHTSignaling();
      }, 2000);
    };
    
    this.webrtc.on('peerConnected', peerConnectedHandler);
    this.webrtc.on('peerDisconnected', ({ peerId }) => {
      this.handlePeerDisconnected(peerId);
    });
    this.webrtc.on('data', ({ peerId, data }) => {
      // Use message queue for ordered processing
      this.enqueueMessage(peerId, data);
    });
    this.webrtc.on('signal', ({ peerId, signal }) => {
      this.handleOutgoingSignal(peerId, signal);
    });
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

    // Recreate WebRTC manager if it was destroyed
    if (this.webrtc.isDestroyed) {
      console.log('Recreating destroyed WebRTCManager');
      this.webrtc = new WebRTCManager(this.options.webrtc || {});
      this.setupWebRTCEventHandlers();
    }

    // Initialize WebRTC manager
    this.webrtc.initialize(this.localNodeId.toString());
    
    // Re-setup event handlers after initialization
    this.setupWebRTCEventHandlers();

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
      publicKey: this.keyPair.publicKey
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
    const connectedPeers = this.webrtc.getConnectedPeers().length;
    const isDHTConnected = connectedPeers > 0;
    
    const connectionPromises = [];

    for (const peer of peers.slice(0, this.options.k)) {
      try {
        if (!this.isValidDHTPeer(peer.nodeId)) {
          continue;
        }
        
        // Only connect to bootstrap peers if not already DHT-connected
        if (isDHTConnected) {
          continue;
        }
        
        // Genesis peers can initiate connections
        const shouldInitiate = this.isGenesisPeer;
        
        if (shouldInitiate) {
          console.log(`🔗 Connecting to ${peer.nodeId}`);
          const promise = this.webrtc.createConnection(peer.nodeId, true);
          connectionPromises.push(promise);
        }
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
          const actualConnections = this.webrtc.getConnectedPeers().length;
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
    const connectedPeers = this.webrtc.getConnectedPeers().length;
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
      // We're still bootstrap-only - try to connect to initial peers (first two nodes only)
      console.log(`🔗 Bootstrap-only node: Attempting to connect to initial peers`);
      this.connectToInitialPeers(peers).catch(error => {
        console.error('Failed to connect to bootstrap peers:', error);
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
    if (this.webrtc.isConnected(clientId)) {
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
      
      
      // CRITICAL FIX: Temporarily force bootstrap signaling for invitation process
      const wasUsingBootstrapSignaling = this.useBootstrapForSignaling;
      console.log(`🔄 Forcing bootstrap signaling for invitation (was: ${wasUsingBootstrapSignaling})`);
      this.useBootstrapForSignaling = true;
      
      try {
        // Create WebRTC connection (DHT nodes always initiate connections to new clients)
        console.log(`📤 DHT node creating connection to invited client: ${clientId} (using bootstrap signaling)`);
        await this.webrtc.createConnection(clientId, true);
        
        console.log(`✅ WebRTC connection initiated to ${clientId} using bootstrap signaling`);
        
        // Wait a bit for the connection to establish before potentially switching back
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
        isNative: this.keyPair?.isNative
      });
      console.log(`✅ Temporarily reconnected to bootstrap for invitation`);
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
      
      
      return true;
      
    } catch (error) {
      console.error('Error processing invitation:', error);
      return false;
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
      if (!this.webrtc.isConnected(peerId)) {
        return;
      }
      
      if (this.routingTable.getNode(peerId)) {
        return;
      }
      
      const node = new DHTNode(peerId, peerId);
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
      if (!this.webrtc.isConnected(peerId)) {
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
    await this.webrtc.handleSignal(fromPeer, signal);
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
        await this.webrtc.handleSignal(peerId, result.signal);
      }
    } catch (error) {
      console.error(`DHT ICE retrieval failed from ${peerId}:`, error);
    }
  }

  /**
   * Consider switching to DHT-based signaling
   */
  considerDHTSignaling() {
    const connectedPeers = this.webrtc.getConnectedPeers().length;
    
    if (connectedPeers >= 1 && !this.useBootstrapForSignaling) {
      return;
    }
    
    if (connectedPeers >= 1) {
      console.log('🌐 Switching to DHT-based signaling');
      this.useBootstrapForSignaling = false;
      this.startDHTOfferPolling();
      
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
   * Connect to peer using DHT-based signaling (offers/answers/ICE candidates)
   */
  async connectToPeerViaDHT(peerId) {
    
    // Skip if already connected
    if (this.webrtc.isConnected(peerId)) {
      console.log(`Already connected to ${peerId}`);
      return true;
    }

    try {
      // Create the WebRTC connection as initiator
      console.log(`🔄 Creating WebRTC connection to ${peerId} via DHT (initiator mode)`);
      await this.webrtc.createConnection(peerId, true);
      
      // The WebRTC connection will automatically generate and send offer through our signaling
      // Since useBootstrapForSignaling = false, signals will be stored in DHT via handleOutgoingSignal
      
      // Start polling for answer from the target peer
      console.log(`👂 Polling DHT for answer from ${peerId}`);
      await this.pollForDHTAnswer(peerId);
      
      return true;
    } catch (error) {
      console.error(`Failed to connect to ${peerId} via DHT:`, error);
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
          await this.webrtc.handleSignal(peerId, answerData.signal);
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
    const connectedPeers = this.webrtc.getConnectedPeers();
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
      const connectedPeers = this.webrtc.getConnectedPeers();
      
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
    
    const connectedPeers = this.webrtc.getConnectedPeers();
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
      if (this.webrtc.connections.has(peerId)) {
        console.log(`🔄 Connection already exists for ${peerId}, using existing connection for offer`);
        // Use existing connection to handle the offer
        await this.webrtc.handleSignal(peerId, offerSignal);
        return;
      }
      
      // Create incoming connection to handle the offer
      await this.webrtc.createConnection(peerId, false); // false = not initiator
      
      console.log(`📥 Responding to offer from ${peerId}`);
      await this.webrtc.handleSignal(peerId, offerSignal);
    } catch (error) {
      // If connection already exists, try to use it for the offer
      if (error.message.includes('already exists')) {
        console.log(`🔄 Race condition detected for ${peerId}, using existing connection`);
        try {
          await this.webrtc.handleSignal(peerId, offerSignal);
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
    if (this.webrtc.isConnected(targetPeerId)) {
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
      await this.webrtc.createConnection(targetPeerId, true);
      
      // Wait a bit for connection to establish
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Check if connection succeeded
      if (this.webrtc.isConnected(targetPeerId)) {
        console.log(`Successfully connected to ${targetPeerId}`);
        return true;
      }
      
      // If not connected and we have retries left, try again
      if (retryCount < maxRetries) {
        console.log(`Connection attempt ${retryCount + 1} failed, retrying...`);
        // Clean up failed connection
        if (this.webrtc.peers.has(targetPeerId)) {
          this.webrtc.destroyConnection(targetPeerId);
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
      await this.webrtc.handleSignal(peerId, signal);
      
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
  async findNode(targetId) {
    const target = typeof targetId === 'string' ? 
      DHTNodeId.fromString(targetId) : targetId;

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
          const response = await this.sendFindNode(node.id.toString(), target);
          for (const peer of response.nodes || []) {
            const peerNode = DHTNode.fromCompact(peer);
            results.add(peerNode);
            // Note: Peer discovery logic removed from findNode - now handled by dedicated discoverPeers() method
          }
        } catch (error) {
          console.warn(`Find node query failed for ${node.id.toString()}:`, error);
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
  async sendFindNode(peerId, targetId) {
    // Verify connection before sending request
    if (!this.webrtc.isConnected(peerId)) {
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
    console.log(`Connected peers: ${this.webrtc.getConnectedPeers().length}`);
    
    // Clean routing table of disconnected peers before operations
    this.cleanupRoutingTable();
    
    const keyId = DHTNodeId.fromString(key);
    const closestNodes = await this.findNode(keyId);
    
    // Filter to only peers with active WebRTC connections
    const connectedClosestNodes = closestNodes.filter(node => {
      const peerId = node.id.toString();
      const isConnected = this.webrtc.isConnected(peerId);
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
    if (!this.webrtc.isConnected(peerId)) {
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
    // Verify connection before sending request
    if (!this.webrtc.isConnected(peerId)) {
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
    return this.webrtc.sendData(peerId, message);
  }

  /**
   * Send request and wait for response
   */
  async sendRequestWithResponse(peerId, message, timeout = 10000) {
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
    // Periodic bucket refresh
    setInterval(() => {
      this.refreshBuckets();
    }, this.options.refreshInterval);

    // Periodic republish
    setInterval(() => {
      this.republishData();
    }, this.options.republishInterval / 10); // Check 10x more frequently than republish

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
   * Refresh buckets by searching for random nodes and discovering peers via DHT messaging
   */
  async refreshBuckets() {
    const connectedPeers = this.webrtc.getConnectedPeers().length;
    const routingNodes = this.routingTable.getAllNodes().length;
    
    console.log(`🔄 Refreshing k-buckets: ${connectedPeers} connected, ${routingNodes} in routing table`);
    
    // Use new DHT messaging for peer discovery
    await this.discoverPeersViaDHT();
    
    // For small networks (< 10 peers), be more aggressive with discovery
    const searchProbability = connectedPeers < 10 ? 0.3 : 0.1;
    const searchPromises = [];
    
    // Find random node IDs and search for them
    for (let i = 0; i < 160; i++) {
      if (Math.random() < searchProbability) {
        const randomId = DHTNodeId.generateAtDistance(this.localNodeId, i);
        
        searchPromises.push(
          this.findNode(randomId).then(discoveredNodes => {
            // Add discovered peer nodes to routing table during k-bucket maintenance
            for (const node of discoveredNodes) {
              const peerId = node.id.toString();
              
              // CRITICAL: Never add our own node ID to routing table
              if (peerId === this.localNodeId.toString()) {
                continue;
              }
              
              // Only add valid DHT peers that aren't already in routing table
              if (this.isValidDHTPeer(peerId) && !this.routingTable.getNode(peerId)) {
                const addResult = this.routingTable.addNode(node);
                if (addResult) {
                  console.log(`📋 K-bucket maintenance discovered peer: ${peerId}`);
                }
              }
            }
            return discoveredNodes;
          }).catch(_error => {
            // Suppress individual bucket refresh errors
          })
        );
      }
    }
    
    // Wait for all searches to complete
    if (searchPromises.length > 0) {
      await Promise.allSettled(searchPromises);
    }
    
    // Perform dedicated peer discovery for k-bucket maintenance
    if (!this.useBootstrapForSignaling) {
      await this.discoverPeers();
    }
    
    const newConnectedPeers = this.webrtc.getConnectedPeers().length;
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
            
            // Only add valid DHT peers that aren't already in routing table
            if (this.isValidDHTPeer(peerId) && !this.routingTable.getNode(peerId)) {
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
   * Dedicated peer discovery for k-bucket maintenance
   * This method discovers and validates actual peer nodes (not storage keys or random IDs)
   */
  async discoverPeers() {
    const allNodes = this.routingTable.getAllNodes();
    const unconnectedPeers = allNodes.filter(node => 
      !this.webrtc.isConnected(node.id.toString())
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
    if (this.webrtc.isConnected(peerId) || this.webrtc.connections.has(peerId)) {
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
    const staleConnections = this.webrtc.cleanupStaleConnections();

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
      if (this.webrtc.isConnected(node.id.toString())) {
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
      webrtc: this.webrtc.getStats(),
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
    this.webrtc.destroy();
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
      await this.webrtc.handleSignal(message.senderPeer, {
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
      await this.webrtc.handleSignal(message.senderPeer, {
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
      await this.webrtc.handleSignal(message.senderPeer, {
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
      if (this.webrtc.isConnected(targetPeer)) {
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
        if (this.webrtc.isConnected(nextHop)) {
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
    
    if (shouldConnect && !this.webrtc.isConnected(fromPeer)) {
      // Initiate WebRTC connection using DHT signaling
      console.log(`🤝 Initiating WebRTC connection to discovered peer: ${fromPeer}`);
      try {
        await this.webrtc.createConnection(fromPeer, true);
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
    
    if (message.willing && !this.webrtc.isConnected(fromPeer)) {
      // Peer is willing to connect - wait for their WebRTC offer or send ours
      console.log(`✅ Peer ${fromPeer} is willing to connect, preparing for WebRTC negotiation`);
      
      // Add to routing table if not already there
      if (!this.routingTable.getNode(fromPeer)) {
        const node = new DHTNode(fromPeer, 'discovered-peer');
        node.lastSeen = Date.now();
        this.routingTable.addNode(node);
        console.log(`📋 Added discovered peer ${fromPeer} to routing table`);
      }
    }
  }

  /**
   * Check if we should connect to a peer (prevent overconnection)
   */
  async shouldConnectToPeer(peerId) {
    // Don't connect if already connected
    if (this.webrtc.isConnected(peerId)) {
      return false;
    }

    // Don't connect to ourselves
    if (peerId === this.localNodeId.toString()) {
      return false;
    }

    // Check if we're under the connection limit
    const currentConnections = this.webrtc.getConnectedPeers().length;
    const maxConnections = this.webrtc.options.maxConnections || 50;
    
    if (currentConnections >= maxConnections) {
      console.log(`Connection limit reached (${currentConnections}/${maxConnections})`);
      return false;
    }

    // Check if peer is valid
    if (!this.webrtc.isValidDHTPeer(peerId)) {
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
      const connectedPeers = this.webrtc.getConnectedPeers();
      
      // Find peers in routing table that we're not connected to
      for (const node of routingNodes) {
        const peerId = node.id.toString();
        
        if (connectedPeers.includes(peerId)) {
          continue; // Already connected
        }

        if (!this.webrtc.isValidDHTPeer(peerId)) {
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
      
      // Also try to discover new peers through connected peers
      for (const connectedPeer of connectedPeers) {
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