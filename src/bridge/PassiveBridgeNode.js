import { DHTClient } from '../core/DHTClient.js';
import { ConnectionManagerFactory } from '../network/ConnectionManagerFactory.js';

/**
 * Passive Bridge Node - DHT Observer for Reconnection Services
 * 
 * This node connects to the DHT network but does not participate in DHT operations.
 * It only observes network activity and peer announcements to facilitate reconnections.
 */
export class PassiveBridgeNode extends DHTClient {
  constructor(options = {}) {
    super({
      bootstrapServers: ['ws://bridge-placeholder:8080'], // Placeholder to prevent connection
      passiveMode: true,
      disableStorage: true,
      disableRouting: true,
      disableLookups: true,
      enableConnections: true,
      ...options
    });
    
    // Bridge-specific options
    this.bridgeAuth = options.bridgeAuth || 'default-bridge-auth-key';
    this.bridgePort = options.bridgePort || 8083;
    this.bridgeHost = options.bridgeHost || 'localhost';

    // Create connection manager using factory (connection-agnostic)
    this.connectionManager = ConnectionManagerFactory.createForEnvironment({
      maxConnections: this.options.maxConnections,
      port: this.bridgePort,
      host: this.bridgeHost,
      enableServer: true,
      ...options.connectionOptions
    });
    
    
    // Network state monitoring
    this.connectedPeers = new Map();        // peerId -> connectionInfo
    this.peerAnnouncements = new Map();     // peerId -> announcementData
    this.networkFingerprint = null;
    this.lastFingerprintUpdate = 0;
    this.fingerprintUpdateInterval = null;
    
    // Bootstrap communication (now using peer IDs instead of WebSocket objects)
    this.authorizedBootstrap = new Set();
    
    // DHT peer connections
    this.dhtPeerConnections = new Map();    // peerId -> WebSocket
    this.isStarted = false;
    
    // Note: DHT event handlers will be set up after DHT is created in start() method
  }

  getNodeType() {
    return 'bridge';
  }

  getCapabilities() {
    return ['websocket', 'observer'];
  }

  canAcceptConnections() {
    return true;
  }

  canInitiateConnections() {
    return true;
  }

  /**
   * Override bootstrap client creation to return mock bootstrap
   */
  createBootstrapClient() {
    return {
      connect: async () => Promise.resolve(),
      disconnect: async () => Promise.resolve(),
      destroy: () => {},
      isConnected: false,
      isBootstrapConnected: () => false,
      sendInvitation: async () => ({ success: false, error: 'Bridge nodes cannot send invitations' }),
      on: () => {},
      emit: () => {},
      requestPeersOrGenesis: async () => ({ isGenesis: false, peers: [], message: 'Bridge node' }),
      announceIndependent: async () => Promise.resolve()
    };
  }

  /**
   * Override DHT options for passive bridge mode
   */
  getDHTOptions() {
    return {
      ...super.getDHTOptions(),
      passiveMode: true,
      disableStorage: true,
      disableRouting: true,
      disableLookups: true,
      enableConnections: true,
      serverConnectionManager: this.connectionManager // Reuse bridge's connection manager
    };
  }

  /**
   * Setup DHT event handlers for passive observation
   */
  setupDHTEventHandlers() {
    // Monitor peer connections
    this.dht.on('peerConnected', (peerId) => {
      this.handlePeerConnected(peerId);
    });

    this.dht.on('peerDisconnected', (peerId) => {
      this.handlePeerDisconnected(peerId);
    });

    // Listen for peer announcements
    this.dht.on('peerAnnouncement', (data) => {
      this.handlePeerAnnouncement(data.peerId, data.announcement);
    });

    // Monitor all DHT messages passively
    this.dht.on('messageObserved', (data) => {
      this.updatePeerActivity(data.peerId, data.message);
    });
  }

  /**
   * Setup connection manager event handlers
   */
  setupConnectionManagerEventHandlers() {
    // Handle incoming connections through connection manager
    this.connectionManager.on('peerConnected', (data) => {
      this.handleIncomingConnection(data.peerId, data.connection);
    });

    this.connectionManager.on('peerDisconnected', (data) => {
      this.handleConnectionDisconnected(data.peerId, data.reason);
    });
    
    // Handle messages through connection manager
    this.connectionManager.on('message', (data) => {
      this.handleConnectionMessage(data.peerId, data.message);
    });
    
    // Handle DHT messages through connection manager
    this.connectionManager.on('dhtMessage', (data) => {
      // Ensure peer is in routing table with server connection manager before processing message
      const peerNode = this.dht.getOrCreatePeerNode(data.peerId, { connectionType: 'websocket', isBridgeConnected: true });
      this.dht.handlePeerMessage(data.peerId, data.message);
    });
  }

  /**
   * Start the passive bridge node
   */
  async start() {
    console.log('🌉 Starting Passive Bridge Node');

    // Call superclass start to create DHT
    await super.start();
    
    // Now set up event handlers after DHT is created
    this.setupDHTEventHandlers();
    this.setupConnectionManagerEventHandlers();

    // Initialize connection manager with bridge node ID
    this.connectionManager.initialize(this.dht.localNodeId.toString());
    
    // CRITICAL: Wait for WebSocket initialization that was started in constructor
    console.log('⏳ Waiting for WebSocket initialization to complete...');
    await this.connectionManager.waitForWebSocketInitialization();
    console.log('✅ WebSocket initialization completed');
    
    // Now start the WebSocket server
    if (this.connectionManager.startServer) {
      this.connectionManager.startServer();
      console.log(`🌐 Started WebSocket server for bridge node at ${this.connectionManager.getServerAddress()}`);
    }
    
    // Wait a moment for server to fully initialize, then get address
    const serverAddress = this.connectionManager.getServerAddress() || `ws://${this.bridgeHost}:${this.bridgePort}`;
    
    // CRITICAL: Mark this node as a bridge node in metadata
    // This metadata will be shared when other peers discover this node through k-bucket maintenance
    const bridgeAuthToken = 'bridge_auth_' + (this.options.bridgeAuth || 'default-bridge-auth-key');
    const bridgeSignature = await this.generateBridgeSignature(bridgeAuthToken);
    
    this.connectionManager.setPeerMetadata(this.dht.localNodeId.toString(), {
      isBridgeNode: true,
      nodeType: 'bridge',
      listeningAddress: serverAddress,
      capabilities: ['websocket'],
      bridgeNodeType: 'passive',
      maxConnections: this.options.maxConnections,
      bridgeAuthToken,
      bridgeSignature,
      bridgeStartTime: Date.now()
    });
    console.log(`🌉 Bridge node ${this.dht.localNodeId.toString().substring(0, 8)}... marked as bridge node with metadata`);
    
    // Start periodic network fingerprint updates
    this.startFingerprintMonitoring();
    
    this.isStarted = true;
    console.log(`🌉 Passive bridge node started on ${this.options.bridgeHost}:${this.options.bridgePort}`);
    console.log(`📡 DHT Node ID: ${this.dht.localNodeId.toString()}`);
    console.log(`📋 Bridge will connect to DHT network when bootstrap server provides peer information`);
  }

  /**
   * Connect bridge node to DHT network via specific peers
   * Called by bootstrap server when DHT network is available
   */
  async connectToDHTNetwork(peerAddresses) {
    if (!this.isStarted) {
      throw new Error('Bridge node must be started first');
    }

    console.log(`🔗 Bridge node connecting to DHT network via ${peerAddresses.length} peer(s)`);
    
    try {
      // Connect to provided DHT peers directly
      for (const peerAddress of peerAddresses) {
        try {
          await this.connectToPeer(peerAddress);
          console.log(`✅ Bridge connected to DHT peer: ${peerAddress.peerId.substring(0, 8)}...`);
        } catch (error) {
          console.warn(`⚠️ Failed to connect to DHT peer ${peerAddress.peerId.substring(0, 8)}...:`, error.message);
        }
      }
      
      const connectedPeers = this.dht.getConnectedPeers()?.length || 0;
      if (connectedPeers > 0) {
        console.log(`🌐 Bridge node successfully joined DHT network (${connectedPeers} connections)`);
        this.emit('dhtNetworkJoined', { connectedPeers });
      } else {
        console.warn(`⚠️ Bridge node failed to establish any DHT connections`);
      }
      
    } catch (error) {
      console.error('❌ Error connecting bridge to DHT network:', error);
    }
  }

  /**
   * Connect to a specific DHT peer
   */
  async connectToPeer(peerAddress) {
    // Create peer node with metadata and connect through its connection manager
    const peerNode = this.dht.getOrCreatePeerNode(peerAddress.peerId, {
      nodeType: peerAddress.nodeType || 'unknown',
      listeningAddress: peerAddress.websocketAddress
    });
    
    await peerNode.connectionManager.createConnection(peerAddress.peerId, true);
  }

  /**
   * Stop the bridge node
   */
  async stop() {
    if (!this.isStarted) {
      return;
    }

    console.log('🛑 Stopping Passive Bridge Node');

    // Stop fingerprint monitoring
    if (this.fingerprintUpdateInterval) {
      clearInterval(this.fingerprintUpdateInterval);
      this.fingerprintUpdateInterval = null;
    }

    // Destroy connection manager
    if (this.connectionManager) {
      this.connectionManager.destroy();
    }

    // Stop DHT
    if (this.dht) {
      await this.dht.stop();
    }

    // Clear state
    this.connectedPeers.clear();
    this.peerAnnouncements.clear();
    this.authorizedBootstrap.clear();

    this.isStarted = false;
    console.log('🌉 Passive bridge node stopped');
  }

  /**
   * Handle peer connection in passive mode
   */
  handlePeerConnected(peerId) {
    console.log(`🔍 Bridge observing peer connection: ${peerId.substring(0, 8)}...`);
    
    this.connectedPeers.set(peerId, {
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      messageCount: 0,
      isActive: true
    });
    
    // Update network fingerprint when topology changes
    this.scheduleNetworkFingerprintUpdate();
    
    this.emit('peerConnected', peerId);
  }

  /**
   * Handle peer disconnection in passive mode
   */
  handlePeerDisconnected(peerId) {
    console.log(`🔍 Bridge observing peer disconnection: ${peerId.substring(0, 8)}...`);
    
    if (this.connectedPeers.has(peerId)) {
      this.connectedPeers.get(peerId).isActive = false;
    }
    
    this.peerAnnouncements.delete(peerId);
    this.scheduleNetworkFingerprintUpdate();
    
    this.emit('peerDisconnected', peerId);
  }

  /**
   * Update peer activity tracking
   */
  updatePeerActivity(peerId, message) {
    if (this.connectedPeers.has(peerId)) {
      const peerInfo = this.connectedPeers.get(peerId);
      peerInfo.lastSeen = Date.now();
      peerInfo.messageCount++;
      peerInfo.lastMessageType = message.type;
    }
  }

  /**
   * Handle peer announcement
   */
  handlePeerAnnouncement(peerId, announcement) {
    console.log(`📢 Bridge received peer announcement from ${peerId.substring(0, 8)}...`);
    
    this.peerAnnouncements.set(peerId, {
      ...announcement,
      receivedAt: Date.now(),
      validatedAt: null,
      isValid: false
    });
    
    // Validate announcement authenticity
    this.validatePeerAnnouncement(peerId, announcement);
  }

  /**
   * Validate peer announcement authenticity
   */
  async validatePeerAnnouncement(peerId, announcement) {
    try {
      // Basic validation
      if (!announcement.nodeId || !announcement.timestamp) {
        console.warn(`❌ Invalid announcement structure from ${peerId.substring(0, 8)}`);
        return;
      }

      // Verify signature if present
      if (announcement.signature && announcement.membershipToken) {
        const isValid = await this.verifyAnnouncementSignature(announcement);
        
        const announcementRecord = this.peerAnnouncements.get(peerId);
        if (announcementRecord) {
          announcementRecord.validatedAt = Date.now();
          announcementRecord.isValid = isValid;
          
          if (isValid) {
            console.log(`✅ Validated peer announcement from ${peerId.substring(0, 8)}`);
          } else {
            console.warn(`❌ Invalid signature in announcement from ${peerId.substring(0, 8)}`);
          }
        }
      } else {
        console.log(`⚠️ Unsigned announcement from ${peerId.substring(0, 8)} (may be valid peer)`);
        // Mark as potentially valid even without signature
        const announcementRecord = this.peerAnnouncements.get(peerId);
        if (announcementRecord) {
          announcementRecord.isValid = true; // Trust connected peers for now
          announcementRecord.validatedAt = Date.now();
        }
      }
    } catch (error) {
      console.error(`Error validating announcement from ${peerId.substring(0, 8)}:`, error);
    }
  }

  /**
   * Verify announcement signature
   */
  async verifyAnnouncementSignature() {
    // This would use the same crypto verification as membership tokens
    // For now, return true for connected peers
    return true;
  }

  /**
   * Calculate network fingerprint based on observed data
   */
  async calculateNetworkFingerprint() {
    try {
      const activePeers = Array.from(this.connectedPeers.entries())
        .filter(([_, info]) => info.isActive && (Date.now() - info.lastSeen) < 300000) // 5 minutes
        .map(([peerId, _]) => peerId)
        .sort(); // Deterministic ordering

      const validAnnouncements = Array.from(this.peerAnnouncements.entries())
        .filter(([_, announcement]) => announcement.isValid)
        .map(([peerId, announcement]) => ({
          peerId,
          membershipToken: announcement.membershipToken?.nodeId || null,
          timestamp: Math.floor(announcement.receivedAt / (60 * 60 * 1000)) // Hour granularity
        }))
        .sort((a, b) => a.peerId.localeCompare(b.peerId));

      // Create deterministic network fingerprint
      const fingerprintData = {
        activePeers: activePeers.slice(0, 10), // Limit for consistency
        validAnnouncements: validAnnouncements.slice(0, 10),
        observerNodeId: this.dht.localNodeId.toString(),
        timestamp: Math.floor(Date.now() / (60 * 60 * 1000)) // Hour granularity
      };

      const encoder = new TextEncoder();
      const data = encoder.encode(JSON.stringify(fingerprintData));
      
      // Use Node.js crypto for server environment
      const crypto = await import('crypto');
      const hash = crypto.createHash('sha256').update(data).digest('hex');
      
      return hash;
      
    } catch (error) {
      console.error('Error calculating network fingerprint:', error);
      return null;
    }
  }

  /**
   * Start periodic network fingerprint monitoring
   */
  startFingerprintMonitoring() {
    // Initial fingerprint calculation
    setTimeout(async () => {
      this.networkFingerprint = await this.calculateNetworkFingerprint();
      this.lastFingerprintUpdate = Date.now();
      console.log(`🔍 Initial network fingerprint: ${this.networkFingerprint}`);
    }, 30000); // 30 seconds after start

    // Periodic updates
    this.fingerprintUpdateInterval = setInterval(async () => {
      try {
        this.networkFingerprint = await this.calculateNetworkFingerprint();
        this.lastFingerprintUpdate = Date.now();
        console.log(`🔍 Network fingerprint updated: ${this.networkFingerprint}`);
      } catch (error) {
        console.error('Error updating network fingerprint:', error);
      }
    }, 5 * 60 * 1000); // Update every 5 minutes
  }

  /**
   * Schedule network fingerprint update (debounced)
   */
  scheduleNetworkFingerprintUpdate() {
    // Debounced update - only update if no recent update
    if (Date.now() - this.lastFingerprintUpdate > 60000) { // 1 minute minimum
      setTimeout(async () => {
        try {
          this.networkFingerprint = await this.calculateNetworkFingerprint();
          this.lastFingerprintUpdate = Date.now();
        } catch (error) {
          console.error('Error in scheduled fingerprint update:', error);
        }
      }, 5000); // 5 second delay
    }
  }


  /**
   * Handle genesis peer connection request (automatic first DHT connection)
   * This is the critical connection that removes genesis status from first peer
   */
  async handleGenesisConnection(bootstrapPeerId, request) {
    const { nodeId, metadata, requestId } = request;
    
    console.log(`🌟 Processing genesis connection request for ${nodeId.substring(0, 8)}...`);
    
    try {
      // Accept genesis peer as first DHT connection automatically
      // This will be the bridge node's first DHT peer connection
      
      // Create a basic membership token for the genesis peer
      // In a real implementation, this would use proper crypto
      const membershipToken = {
        nodeId,
        issuer: this.dht.localNodeId.toString(), // Bridge node issues the token
        timestamp: Date.now(),
        isGenesis: true,
        signature: 'bridge-issued-genesis-token' // Placeholder signature
      };

      // The bridge node will establish DHT connection with genesis peer
      // This happens through normal DHT connection process, bridge just observes
      
      this.sendGenesisConnectionResult(bootstrapPeerId, nodeId, requestId, true, 'Genesis peer accepted as first DHT connection', {
        bridgeNodeId: this.dht.localNodeId.toString(),
        membershipToken,
        networkFingerprint: this.networkFingerprint,
        message: 'Bridge node ready to observe DHT network starting with genesis peer'
      });

      console.log(`✅ Genesis peer ${nodeId.substring(0, 8)} connection approved - DHT network can now begin`);

    } catch (error) {
      this.sendGenesisConnectionResult(bootstrapPeerId, nodeId, requestId, false, `Genesis connection error: ${error.message}`);
    }
  }

  /**
   * Handle reconnection validation request from bootstrap
   */
  async handleReconnectionValidation(bootstrapPeerId, request) {
    const { nodeId, membershipToken, requestId } = request;
    
    console.log(`🔍 Validating reconnection request for ${nodeId.substring(0, 8)}...`);
    
    try {
      // 1. Validate membership token (passive - no DHT queries)
      const isValidToken = await this.validateMembershipTokenPassive(membershipToken);
      if (!isValidToken) {
        return this.sendReconnectionResult(bootstrapPeerId, nodeId, requestId, false, 'Invalid membership token');
      }

      // 2. Verify network health through observation data
      const networkHealth = this.assessNetworkHealth();
      if (!networkHealth.isHealthy) {
        return this.sendReconnectionResult(bootstrapPeerId, nodeId, requestId, false, `Network unhealthy: ${networkHealth.reason}`);
      }

      // 3. Find active DHT member from observed peers
      const activeDHTMember = this.selectActiveDHTMemberFromObservations();
      if (!activeDHTMember) {
        return this.sendReconnectionResult(bootstrapPeerId, nodeId, requestId, false, 'No active DHT members observed');
      }

      // 4. For now, just return success - actual reconnection facilitation would be implemented here
      this.sendReconnectionResult(bootstrapPeerId, nodeId, requestId, true, 'Reconnection validation passed', {
        networkFingerprint: this.networkFingerprint,
        activePeerCount: this.connectedPeers.size,
        validAnnouncementCount: Array.from(this.peerAnnouncements.values()).filter(a => a.isValid).length,
        selectedActiveMember: activeDHTMember
      });

    } catch (error) {
      this.sendReconnectionResult(bootstrapPeerId, nodeId, requestId, false, `Bridge error: ${error.message}`);
    }
  }

  /**
   * Validate membership token passively
   */
  async validateMembershipTokenPassive(membershipToken) {
    try {
      // Basic token structure validation
      if (!membershipToken || !membershipToken.nodeId || !membershipToken.signature) {
        return false;
      }
      
      // For now, assume valid structure means valid token
      // Real implementation would verify signature against known public keys
      return true;
    } catch (error) {
      console.error('Error validating membership token:', error);
      return false;
    }
  }

  /**
   * Assess network health based on observations
   */
  assessNetworkHealth() {
    const activePeers = Array.from(this.connectedPeers.values()).filter(p => p.isActive).length;
    const recentActivity = Array.from(this.connectedPeers.values())
      .filter(p => (Date.now() - p.lastSeen) < 300000).length; // 5 minutes
    const validAnnouncements = Array.from(this.peerAnnouncements.values()).filter(a => a.isValid).length;

    if (activePeers < 2) {
      return { isHealthy: false, reason: 'Insufficient active peers', activePeers, recentActivity, validAnnouncements };
    }
    
    if (recentActivity < 1) {
      return { isHealthy: false, reason: 'No recent network activity', activePeers, recentActivity, validAnnouncements };
    }

    return { isHealthy: true, activePeers, recentActivity, validAnnouncements };
  }

  /**
   * Select most suitable active DHT member for reconnection
   */
  selectActiveDHTMemberFromObservations() {
    // Find most active, recently seen peer with valid announcement
    const candidates = Array.from(this.connectedPeers.entries())
      .filter(([peerId, info]) => {
        const hasValidAnnouncement = this.peerAnnouncements.has(peerId) && 
                                   this.peerAnnouncements.get(peerId).isValid;
        const isRecentlyActive = (Date.now() - info.lastSeen) < 60000; // 1 minute
        return info.isActive && isRecentlyActive;
      })
      .sort(([_, a], [__, b]) => b.messageCount - a.messageCount); // Most active first

    return candidates.length > 0 ? candidates[0][0] : null;
  }

  /**
   * Send reconnection result to bootstrap server
   */
  async sendReconnectionResult(bootstrapPeerId, nodeId, requestId, success, reason, additionalData = {}) {
    const response = {
      type: 'reconnection_result',
      nodeId,
      requestId,
      success,
      reason,
      timestamp: Date.now(),
      ...additionalData
    };

    await this.connectionManager.sendMessage(bootstrapPeerId, response);
    
    console.log(`📤 Sent reconnection result for ${nodeId.substring(0, 8)}: ${success ? 'SUCCESS' : 'FAILED'} - ${reason}`);
  }

  /**
   * Send genesis connection result to bootstrap server
   */
  async sendGenesisConnectionResult(bootstrapPeerId, nodeId, requestId, success, reason, additionalData = {}) {
    const response = {
      type: 'genesis_connection_result',
      nodeId,
      requestId,
      success,
      reason,
      timestamp: Date.now(),
      ...additionalData
    };

    await this.connectionManager.sendMessage(bootstrapPeerId, response);
    
    console.log(`📤 Sent genesis connection result for ${nodeId.substring(0, 8)}: ${success ? 'SUCCESS' : 'FAILED'} - ${reason}`);
  }

  /**
   * Send error response
   */
  async sendErrorResponse(peerId, error) {
    await this.connectionManager.sendMessage(peerId, {
      type: 'error',
      error,
      timestamp: Date.now()
    });
  }

  /**
   * Handle incoming connection through connection manager
   */
  handleIncomingConnection(peerId, connection) {
    console.log(`🔗 Incoming connection from ${peerId.substring(0, 8)}... via connection manager`);
    
    // Store DHT peer connection
    this.dhtPeerConnections.set(peerId, connection);
    
    // Add to connected peers tracking
    this.connectedPeers.set(peerId, {
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      messageCount: 0,
      isActive: true,
      connectionType: 'websocket',
      source: 'connection_manager'
    });
    
    // Only set up DHT connection for actual DHT peers, not bootstrap servers
    if (!peerId.startsWith('bootstrap_')) {
      try {
        const peerNode = this.dht.getOrCreatePeerNode(peerId, {
          connectionType: 'websocket',
          isBridgeConnected: true
        });
        
        console.log(`🔗 DHT peer ${peerId.substring(0, 8)}... integrated with bridge DHT`);
        
        // Emit peer connected event for DHT
        this.dht.emit('peerConnected', peerId);
        
      } catch (error) {
        console.error(`❌ Failed to set up DHT connection for ${peerId}:`, error);
      }
    } else {
      console.log(`🔗 Bootstrap server connection established: ${peerId}`);
    }
    
    // Update network fingerprint
    this.scheduleNetworkFingerprintUpdate();
    
    console.log(`✅ DHT peer ${peerId.substring(0, 8)}... successfully connected to bridge`);
  }
  
  /**
   * Handle messages from connected peers through connection manager
   */
  handleConnectionMessage(peerId, message) {
    // Check if this is a bootstrap authentication message
    if (message.type === 'bootstrap_auth') {
      this.handleBootstrapAuth(peerId, message);
      return;
    }
    
    // Check if this is a bootstrap server peer
    if (peerId.startsWith('bootstrap_')) {
      this.handleBootstrapMessage(peerId, message);
      return;
    }
    
    // Update peer activity for DHT peers
    this.updatePeerActivity(peerId, message);
    
    // Forward DHT messages to the DHT instance
    if (this.dht && message.type) {
      console.log(`📨 Forwarding DHT message ${message.type} from ${peerId?.substring(0, 8)}... to DHT handler`);
      this.dht.handlePeerMessage(peerId, message);
    }
  }
  
  /**
   * Handle bootstrap authentication through connection manager
   */
  async handleBootstrapAuth(peerId, message) {
    console.log(`🔐 Bootstrap auth attempt: peerId=${peerId}, token=${message.auth_token}, expected=${this.options.bridgeAuth}`);
    if (message.auth_token === this.options.bridgeAuth) {
      this.authorizedBootstrap.add(peerId);
      console.log(`✅ Added ${peerId} to authorized bootstrap servers`);
      
      // Send auth success through connection manager
      await this.connectionManager.sendMessage(peerId, { 
        type: 'auth_success',
        bridgeNodeId: this.dht.localNodeId.toString()
      });
      
      console.log('✅ Bootstrap server authenticated with bridge');
    } else {
      // Close connection through connection manager
      this.connectionManager.destroyConnection(peerId, 'Unauthorized - invalid bridge auth token');
      console.warn('❌ Bootstrap server authentication failed');
    }
  }
  
  /**
   * Handle messages from authenticated bootstrap server
   */
  async handleBootstrapMessage(peerId, message) {
    // Only process requests from authorized bootstrap servers
    console.log(`🔍 Bootstrap message check: peerId=${peerId}, authorized=${this.authorizedBootstrap.has(peerId)}`);
    console.log(`🔍 Authorized bootstrap servers:`, Array.from(this.authorizedBootstrap));
    if (!this.authorizedBootstrap.has(peerId)) {
      console.warn(`❌ Bootstrap server ${peerId} not authorized for message ${message.type}`);
      this.connectionManager.destroyConnection(peerId, 'Not authorized');
      return;
    }
    
    try {
      if (message.type === 'validate_reconnection') {
        await this.handleReconnectionValidation(peerId, message);
      } else if (message.type === 'connect_genesis_peer') {
        await this.handleGenesisConnection(peerId, message);
      } else if (message.type === 'invitation_for_bridge') {
        await this.handleBridgeInvitation(peerId, message);
      } else {
        console.warn('Unknown message type from bootstrap:', message.type);
      }
    } catch (error) {
      console.error('Bridge message error:', error);
      await this.sendErrorResponse(peerId, 'Invalid request format');
    }
  }
  
  
  /**
   * Handle connection disconnection through connection manager
   */
  handleConnectionDisconnected(peerId, reason) {
    console.log(`🔌 Peer ${peerId.substring(0, 8)}... disconnected from bridge: ${reason}`);
    
    // Handle bootstrap disconnection
    if (peerId.startsWith('bootstrap_')) {
      this.authorizedBootstrap.delete(peerId);
      console.log('🔌 Bootstrap server disconnected from bridge');
      return;
    }
    
    // Handle DHT peer disconnection
    this.dhtPeerConnections.delete(peerId);
    
    if (this.connectedPeers.has(peerId)) {
      this.connectedPeers.get(peerId).isActive = false;
    }
    
    // Emit peer disconnected event for DHT
    this.dht.emit('peerDisconnected', peerId);
    
    // Update network fingerprint
    this.scheduleNetworkFingerprintUpdate();
  }

  /**
   * Handle invitation received from genesis peer via bootstrap server
   */
  async handleBridgeInvitation(bootstrapPeerId, invitation) {
    const { targetPeerId, fromPeer, invitationToken, websocketCoordination } = invitation;
    
    console.log(`🎫 Bridge node received invitation from ${fromPeer?.substring(0, 8)}... for ${targetPeerId?.substring(0, 8)}...`);
    
    try {
      // Verify this invitation is for this bridge node
      if (targetPeerId !== this.dht.localNodeId.toString()) {
        console.warn(`⚠️ Invitation is for ${targetPeerId?.substring(0, 8)}..., but we are ${this.dht.localNodeId.toString().substring(0, 8)}...`);
        return;
      }
      
      // Process the invitation using DHT's invitation handler
      const invitationMessage = {
        fromPeer,
        invitationToken,
        websocketCoordination
      };
      
      console.log(`📨 Processing invitation through DHT handler...`);
      const result = await this.dht.handleInvitationReceived(invitationMessage);
      
      if (result) {
        console.log(`✅ Bridge node successfully accepted invitation from ${fromPeer?.substring(0, 8)}...`);
        
        // Notify bootstrap server of successful invitation acceptance with bridge server address
        const bridgeAddress = this.connectionManager.getServerAddress();
        
        console.log(`🔗 Bridge node invitation accepted - genesis peer will connect to our WebSocket server`);
        console.log(`📋 Connection will be established when genesis peer connects to our server at ${bridgeAddress}`);
        
        await this.connectionManager.sendMessage(bootstrapPeerId, {
          type: 'bridge_invitation_accepted',
          bridgeNodeId: this.dht.localNodeId.toString(),
          inviterNodeId: fromPeer,
          bridgeServerAddress: bridgeAddress,
          timestamp: Date.now()
        });
        
        // Start observing the new DHT connection
        this.emit('invitationAccepted', {
          fromPeer,
          bridgeNodeId: this.dht.localNodeId.toString()
        });
        
      } else {
        console.warn(`❌ Bridge node failed to accept invitation from ${fromPeer?.substring(0, 8)}...`);
        
        // Notify bootstrap server of failed invitation
        await this.connectionManager.sendMessage(bootstrapPeerId, {
          type: 'bridge_invitation_failed',
          bridgeNodeId: this.dht.localNodeId.toString(),
          inviterNodeId: fromPeer,
          reason: 'Invitation validation failed',
          timestamp: Date.now()
        });
      }
      
    } catch (error) {
      console.error('Error handling bridge invitation:', error);
      
      // Notify bootstrap server of error
      await this.connectionManager.sendMessage(bootstrapPeerId, {
        type: 'bridge_invitation_failed',
        bridgeNodeId: this.dht.localNodeId.toString(),
        inviterNodeId: fromPeer,
        reason: error.message,
        timestamp: Date.now()
      });
    }
  }

  /**
   * Get bridge node status
   */
  getStatus() {
    return {
      isStarted: this.isStarted,
      nodeId: this.dht.localNodeId.toString(),
      connectedPeers: this.connectedPeers.size,
      dhtPeerConnections: this.dhtPeerConnections.size,
      validAnnouncements: Array.from(this.peerAnnouncements.values()).filter(a => a.isValid).length,
      networkFingerprint: this.networkFingerprint,
      lastFingerprintUpdate: this.lastFingerprintUpdate,
      authorizedBootstrapConnections: this.authorizedBootstrap.size,
      networkHealth: this.assessNetworkHealth()
    };
  }

  /**
   * Generate bridge node authentication signature
   * Uses DHT node's Ed25519 key pair to sign bridge auth token
   */
  async generateBridgeSignature(authToken) {
    try {
      if (this.dht && this.dht.keyPair) {
        // Use the DHT's Ed25519 key pair to sign the auth token
        const message = `bridge_node_auth:${authToken}:${this.dht.localNodeId.toString()}:${Date.now()}`;
        // For now, return a simple hash - TODO: implement proper Ed25519 signature
        const { createHash } = await import('crypto');
        return createHash('sha256').update(message).digest('hex');
      }
      return null;
    } catch (error) {
      console.error('Failed to generate bridge signature:', error);
      return null;
    }
  }
}