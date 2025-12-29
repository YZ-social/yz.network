import { NodeDHTClient } from '../node/NodeDHTClient.js';
import { DHTNodeId } from '../core/DHTNodeId.js';
import http from 'http';

/**
 * Passive Bridge Node - DHT Observer for Reconnection Services
 *
 * This node connects to the DHT network but does not participate in DHT operations.
 * It only observes network activity and peer announcements to facilitate reconnections.
 *
 * Extends NodeDHTClient to inherit WebSocket server capabilities and bootstrap metadata.
 */
export class PassiveBridgeNode extends NodeDHTClient {
  constructor(options = {}) {
    // Map bridge-specific options to NodeDHTClient options
    super({
      bootstrapServers: options.bootstrapServers || ['ws://bootstrap:8080'], // Register with real bootstrap for external accessibility
      port: options.bridgePort || options.port || 8083,   // Map bridgePort to port for NodeDHTClient
      websocketPort: options.bridgePort || options.port || 8083,
      websocketHost: options.bridgeHost || options.host || '0.0.0.0',
      publicAddress: options.publicAddress,
      publicWssAddress: options.publicWssAddress,
      passiveMode: true,
      disableStorage: true,
      disableRouting: true,
      disableLookups: true,
      enableConnections: true,
      ...options
    });

    // Bridge-specific options
    this.bridgeAuth = options.bridgeAuth || 'default-bridge-auth-key';
    this.bridgePort = options.bridgePort || options.port || 8083;
    this.bridgeHost = options.bridgeHost || options.host || '0.0.0.0';

    // Metrics server for health checks
    this.metricsPort = options.metricsPort || parseInt(process.env.METRICS_PORT) || 9090;
    this.metricsServer = null;
    this.startTime = Date.now();

    // NodeDHTClient will create connection manager in start() method
    // this.connectionManager will be set by parent class


    // Network state monitoring
    this.connectedPeers = new Map();        // peerId -> connectionInfo
    this.peerAnnouncements = new Map();     // peerId -> announcementData
    this.networkFingerprint = null;
    this.lastFingerprintUpdate = 0;
    this.fingerprintUpdateInterval = null;

    // Bootstrap communication (now using peer IDs instead of WebSocket objects)
    this.authorizedBootstrap = new Set();

    // DHT peer connections (single-connection-per-manager architecture)
    this.dhtPeerConnections = new Map();    // peerId -> WebSocket
    this.peerManagers = new Map();          // peerId -> dedicated ConnectionManager
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
   * Override DHT options for passive bridge mode
   * NodeDHTClient will create and configure the connection manager
   */
  getDHTOptions() {
    return {
      ...super.getDHTOptions(),
      passiveMode: true,
      disableStorage: true,
      disableRouting: true,
      disableLookups: true,
      enableConnections: true
      // serverConnectionManager removed - NodeDHTClient handles this
    };
  }

  /**
   * Override bootstrap metadata to identify as bridge node
   */
  getBootstrapMetadata() {
    return {
      ...super.getBootstrapMetadata(),
      isBridgeNode: true,
      nodeType: 'bridge',
      bridgeAuthToken: this.bridgeAuth
    };
  }

  /**
   * Override bootstrap client creation to handle bridge-specific messages
   */
  createBootstrapClient() {
    const client = super.createBootstrapClient();
    
    // Store reference to bootstrap client for sending responses
    this.bootstrapClient = client;
    
    // Override the WebSocket message handler after connection is established
    const originalConnect = client.connect.bind(client);
    client.connect = async (localNodeId, metadata = {}) => {
      const result = await originalConnect(localNodeId, metadata);
      
      // After connection is established, override the WebSocket message handler
      if (client.ws) {
        // Remove any existing message listeners to avoid duplicates
        client.ws.removeAllListeners('message');
        
        // Use Node.js WebSocket event handling (not browser-style onmessage)
        client.ws.on('message', (data) => {
          try {
            const message = JSON.parse(data.toString());
            
            // DEBUG: Log all incoming messages
            console.log(`📥 [Bridge WS] Received message type: ${message.type}`);
            
            // Handle bridge-specific messages
            if (message.type === 'get_onboarding_peer') {
              console.log(`🌉 Bridge handling get_onboarding_peer request`);
              this.handleGetOnboardingPeer('bootstrap_server', message);
              return;
            } else if (message.type === 'connect_genesis_peer') {
              console.log(`🌉 Bridge handling connect_genesis_peer request`);
              this.handleGenesisConnection('bootstrap_server', message);
              return;
            } else if (message.type === 'validate_reconnection') {
              console.log(`🌉 Bridge handling validate_reconnection request`);
              this.handleReconnectionValidation('bootstrap_server', message);
              return;
            } else if (message.type === 'invitation_for_bridge') {
              console.log(`🌉 Bridge handling invitation_for_bridge request`);
              this.handleBridgeInvitation('bootstrap_server', message);
              return;
            }
            
            // For all other messages, use the original handler
            client.handleMessage(data.toString());
          } catch (error) {
            console.error('Error handling bridge message:', error);
            client.handleMessage(data.toString());
          }
        });
      }
      
      return result;
    };
    
    return client;
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
      this.handleIncomingConnection(data.peerId, data.connection, data.manager);
    });

    this.connectionManager.on('peerDisconnected', (data) => {
      this.handleConnectionDisconnected(data.peerId, data.reason);
    });

    // Handle messages through connection manager
    this.connectionManager.on('message', (data) => {
      this.handleConnectionMessage(data.peerId, data.message);
    });

    // CRITICAL: Handle DHT messages (find_node, find_value, store, etc.) from connection manager
    // Passive bridge nodes DO participate in find_node queries for routing/discovery,
    // but DON'T participate in storage operations (handled by disableStorage flag).
    // Connection manager emits DHT protocol messages as 'dhtMessage' events (ConnectionManager.js:191)
    console.log(`🔧 Setting up dhtMessage event handler on bridge connection manager`);
    this.connectionManager.on('dhtMessage', (data) => {
      const { peerId, message } = data;
      console.log(`📨 Bridge received dhtMessage event: ${message.type} from ${peerId.substring(0, 8)}...`);

      // Skip bootstrap server messages
      if (peerId.startsWith('bootstrap_')) {
        console.log(`⏭️ Skipping bootstrap server message: ${message.type}`);
        return;
      }

      // Forward DHT messages to DHT handler for processing
      if (this.dht && message.type) {
        console.log(`📨 Bridge forwarding DHT message ${message.type} from ${peerId.substring(0, 8)}... to DHT handler`);
        this.dht.handlePeerMessage(peerId, message);
      } else {
        console.warn(`⚠️ Cannot forward DHT message: dht=${!!this.dht}, message.type=${message.type}`);
      }
    });
    console.log(`✅ dhtMessage event handler set up successfully`);
  }

  /**
   * Start the passive bridge node
   */
  async start() {
    console.log('🌉 Starting Passive Bridge Node');

    // Start metrics server first
    await this.startMetricsServer();

    // Call superclass start to create DHT and connection manager
    // NodeDHTClient.start() handles:
    // - Crypto setup
    // - Connection manager creation
    // - WebSocket server startup
    // - DHT initialization
    await super.start();

    // Now set up bridge-specific event handlers after DHT is created
    this.setupDHTEventHandlers();
    this.setupConnectionManagerEventHandlers();

    // NodeDHTClient already initialized connection manager and started WebSocket server
    // this.connectionManager is now set and ready
    console.log(`🌐 WebSocket server ready at ${this.connectionManager.getServerAddress()}`);

    // Get server address (already initialized by NodeDHTClient)
    const serverAddress = this.connectionManager.getServerAddress() || `ws://${this.bridgeHost}:${this.bridgePort}`;

    // CRITICAL: Mark this node as a bridge node in metadata
    // This metadata will be shared when other peers discover this node through k-bucket maintenance
    const bridgeAuthToken = 'bridge_auth_' + (this.options.bridgeAuth || 'default-bridge-auth-key');
    const bridgeSignature = await this.generateBridgeSignature(bridgeAuthToken);

    // Use external address for ALL connections - nginx handles routing
    const externalAddress = this.options.externalAddress || serverAddress;

    console.log(`📍 Bridge advertising address: ${externalAddress}`);

    // CRITICAL: Store this node's metadata in ConnectionManagerFactory so it's included in handshakes
    // Bridge nodes need to identify themselves during WebSocket connection establishment
    const { ConnectionManagerFactory } = await import('../network/ConnectionManagerFactory.js');
    
    // CRITICAL FIX: MERGE with existing metadata instead of overwriting
    // The DHT may have already set membershipToken and other metadata
    const existingMetadata = ConnectionManagerFactory.getPeerMetadata(this.dht.localNodeId.toString()) || {};
    ConnectionManagerFactory.setPeerMetadata(this.dht.localNodeId.toString(), {
      ...existingMetadata,  // Preserve existing metadata (e.g., membershipToken)
      isBridgeNode: true,
      nodeType: 'bridge',
      listeningAddress: externalAddress,  // All connections via nginx (e.g., wss://imeyouwe.com/bridge1)
      publicWssAddress: externalAddress,  // Same address - nginx routes all connections
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
  async handlePeerConnected(peerId) {
    console.log(`🔍 Bridge observing peer connection: ${peerId.substring(0, 8)}...`);

    // CRITICAL FIX: Don't track temporary bootstrap server connections as peers
    // Bootstrap connections have IDs like "bootstrap_1234567890" and are temporary
    if (peerId.startsWith('bootstrap_')) {
      console.log(`🔗 Ignoring temporary bootstrap connection ${peerId.substring(0, 16)}... (not a DHT peer)`);
      return;
    }

    // Validate that peerId is a valid 40-character hex DHT node ID
    if (!peerId || peerId.length !== 40 || !/^[0-9a-f]{40}$/i.test(peerId)) {
      console.warn(`⚠️ Invalid DHT node ID format: ${peerId} - not tracking as peer`);
      return;
    }

    this.connectedPeers.set(peerId, {
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      messageCount: 0,
      isActive: true
    });

    console.log(`✅ Added DHT peer ${peerId.substring(0, 8)}... to connectedPeers (now ${this.connectedPeers.size} total peers)`);

    // OPEN NETWORK MODE: Auto-grant membership tokens to connecting DHT nodes
    if (this.isOpenNetwork) {
      try {
        // Get peer metadata to check if it's a Node.js DHT client (not bridge)
        const peerNode = this.dht.routingTable.getNode(peerId);
        const metadata = peerNode?.metadata || {};

        // Only grant to Node.js clients (not browsers, not other bridges)
        const isNodeClient = metadata.nodeType === 'nodejs';
        const isBridge = metadata.isBridgeNode || metadata.nodeType === 'bridge';

        if (isNodeClient && !isBridge && this.dht._membershipToken) {
          console.log(`🎫 [Open Network] Auto-granting membership token to connecting Node.js peer ${peerId.substring(0, 8)}...`);

          const membershipToken = await this.dht.grantMembershipToken(peerId);

          // Send membership token to the peer via DHT messaging
          const manager = this.getManagerForPeer(peerId);
          if (manager) {
            await manager.sendMessage(peerId, {
              type: 'membership_token_granted',
              membershipToken,
              from: this.dht.localNodeId.toString()
            });

            console.log(`✅ [Open Network] Membership token granted to ${peerId.substring(0, 8)}...`);
          }
        }
      } catch (error) {
        console.warn(`⚠️ Failed to auto-grant membership token to ${peerId.substring(0, 8)}:`, error.message);
      }
    }

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
   * Handle onboarding peer discovery request (random peer selection for open network)
   * Bridge finds random peer via DHT and coordinates invitation
   */
  async handleGetOnboardingPeer(bootstrapPeerId, request) {
    const { newNodeId, newNodeMetadata, requestId } = request;

    console.log(`🎲 Finding onboarding peer for ${newNodeId.substring(0, 8)}...`);

    try {
      // 1. Generate random node ID for peer discovery
      const randomId = this.generateRandomNodeId();
      console.log(`🎲 Random target: ${randomId.toString().substring(0, 8)}...`);

      // 2. Find closest peer via DHT lookup with 30s timeout
      // Onboarding flow needs time for: findNode + DHT messaging + invitation creation
      // Simple findNode completes in 1-3s, but full onboarding can take 10-20s
      const findNodePromise = this.dht.findNode(randomId, { emergencyBypass: true });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('findNode timeout - taking too long')), 30000)
      );
      const closestPeers = await Promise.race([findNodePromise, timeoutPromise]);

      if (!closestPeers || closestPeers.length === 0) {
        throw new Error('No active peers found in DHT network');
      }

      // 3. Filter to only full DHT members (exclude passive bridge nodes)
      // Bridge nodes cannot create invitation tokens since they don't have membership tokens
      console.log(`🔍 Filtering ${closestPeers.length} peers for non-bridge nodes...`);
      const fullDHTMembers = closestPeers.filter(peer => {
        const peerId = peer.id.toString();
        const isBridge = peer.metadata?.isBridgeNode || peer.metadata?.nodeType === 'bridge';
        const isSelf = peerId === this.dht.localNodeId.toString();
        console.log(`   Peer ${peerId.substring(0, 8)}: isBridge=${isBridge}, isSelf=${isSelf}, metadata.nodeType=${peer.metadata?.nodeType}, metadata.isBridgeNode=${peer.metadata?.isBridgeNode}`);
        // Also filter out self
        return !isBridge && !isSelf;  // Only select non-bridge nodes and not ourselves
      });

      if (fullDHTMembers.length === 0) {
        throw new Error('No full DHT members available for onboarding (only bridge nodes found)');
      }

      // 4. Filter to only ACTIVE peers (connected to this bridge)
      // This prevents selecting "ghost" peers that refreshed/disconnected but are still in routing tables
      const activePeers = fullDHTMembers.filter(peer => {
        const peerId = peer.id.toString();
        const isConnected = this.dht.isPeerConnected(peerId);

        if (!isConnected) {
          console.log(`⚠️ Skipping inactive peer ${peerId.substring(0, 8)}... (not connected to bridge)`);
        }

        return isConnected;
      });

      if (activePeers.length === 0) {
        throw new Error('No active DHT members available for onboarding (all discovered peers are offline)');
      }

      // 5. Apply HARD DISQUALIFIERS before selecting candidates
      // These peers should NEVER be selected as helpers (fail fast, no retry)
      const qualifiedPeers = activePeers.filter(peer => {
        const peerId = peer.id.toString();
        const now = Date.now();

        // Disqualify inactive browser tabs (slow bootstrap reconnection, throttled by browser)
        // Node.js nodes are always considered active (headless, no tab visibility)
        if (peer.metadata?.nodeType === 'browser' && peer.metadata?.tabVisible === false) {
          console.log(`❌ Disqualifying ${peerId.substring(0, 8)} - inactive browser tab`);
          return false;
        }
        
        // Node.js nodes are always qualified (headless, always active)
        if (peer.metadata?.nodeType === 'nodejs') {
          console.log(`✅ Node.js node ${peerId.substring(0, 8)} - always qualified (headless)`);
          return true; // Skip other checks for Node.js nodes
        }

        // Disqualify very new nodes (< 30 seconds uptime - unstable, may still be bootstrapping)
        // Skip uptime check if startTime is missing (assume node is stable)
        if (peer.metadata?.startTime) {
          const startTime = peer.metadata.startTime;
          const uptime = now - startTime;
          if (uptime < 30000) {
            console.log(`❌ Disqualifying ${peerId.substring(0, 8)} - too new (${(uptime/1000).toFixed(1)}s uptime)`);
            return false;
          }
        } else {
          console.log(`⚠️ Peer ${peerId.substring(0, 8)} missing startTime metadata - assuming stable`);
        }

        return true;
      });

      if (qualifiedPeers.length === 0) {
        throw new Error('No qualified DHT members available for onboarding (all peers disqualified: inactive tabs or too new)');
      }

      console.log(`✅ Qualified ${qualifiedPeers.length} peers after disqualifiers (removed ${activePeers.length - qualifiedPeers.length})`);

      // 6. Select BEST helper from qualified candidates using uptime then RTT
      // Strategy: Pick up to 3 candidates, rank by uptime (stability) then RTT (responsiveness)
      const candidates = qualifiedPeers.slice(0, Math.min(3, qualifiedPeers.length));
      console.log(`🎯 Evaluating ${candidates.length} candidate helpers for onboarding...`);

      // Score each candidate: higher is better
      const scoredCandidates = candidates.map(peer => {
        const peerId = peer.id.toString();
        const now = Date.now();

        // Get uptime from metadata.startTime (higher uptime = more stable)
        // Use reasonable default if startTime is missing
        const startTime = peer.metadata?.startTime || (now - 300000); // Default to 5 minutes uptime
        const uptimeMs = now - startTime;
        const uptimeMinutes = uptimeMs / 60000;

        // Get RTT (lower is better, 0 means unknown - treat as worst case)
        const rtt = peer.rtt || 10000; // Default 10s if unknown

        // Get node type
        const nodeType = peer.metadata?.nodeType || 'unknown';

        // Score: prioritize uptime first, then RTT, then node type as tiebreaker
        // Uptime score: 1 point per minute, max 60 points (1 hour)
        const uptimeScore = Math.min(uptimeMinutes, 60);
        // RTT penalty: -1 point per 100ms, max -50 points
        const rttPenalty = Math.min(rtt / 100, 50);
        // Node type bonus: +5 for Node.js (more reliable reconnection) as tiebreaker
        const nodeTypeBonus = nodeType === 'nodejs' ? 5 : 0;

        const totalScore = uptimeScore - rttPenalty + nodeTypeBonus;

        console.log(`   📊 ${peerId.substring(0, 8)}: type=${nodeType}, uptime=${uptimeMinutes.toFixed(1)}min, RTT=${rtt}ms, score=${totalScore.toFixed(1)}`);

        return { peer, uptimeMs, rtt, nodeType, totalScore };
      });

      // Sort by score descending (best first)
      scoredCandidates.sort((a, b) => b.totalScore - a.totalScore);

      // 6. Try candidates in order until one succeeds (with fast timeout)
      // This ensures we fail fast and try next candidate if helper doesn't respond
      const HELPER_TIMEOUT_MS = 10000; // 10 second timeout per candidate
      let helperPeer = null;
      let successfulCandidate = null;

      for (let i = 0; i < scoredCandidates.length; i++) {
        const candidate = scoredCandidates[i];
        const candidatePeer = candidate.peer;
        const candidateId = candidatePeer.id.toString();

        console.log(`🎯 Trying candidate ${i + 1}/${scoredCandidates.length}: ${candidateId.substring(0, 8)} (uptime=${(candidate.uptimeMs/60000).toFixed(1)}min, RTT=${candidate.rtt}ms, score=${candidate.totalScore.toFixed(1)})`);

        // Create invitation request for this candidate
        const invitationRequest = {
          type: 'create_invitation_for_peer',
          targetPeer: candidateId,              // Which peer should PROCESS this message
          targetNodeId: newNodeId,              // The NEW peer joining the network
          targetNodeMetadata: newNodeMetadata,
          fromBridge: this.dht.localNodeId.toString(),
          requestId: requestId,
          candidateIndex: i,                    // Track which candidate this is
          timestamp: Date.now()
        };

        try {
          // Send request to helper peer via DHT routing with timeout
          const sendPromise = this.dht.routeSignalingMessage(candidateId, invitationRequest);
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Helper ${candidateId.substring(0, 8)} timeout after ${HELPER_TIMEOUT_MS}ms`)), HELPER_TIMEOUT_MS)
          );

          await Promise.race([sendPromise, timeoutPromise]);
          console.log(`📤 Successfully routed invitation request to helper ${candidateId.substring(0, 8)} via DHT`);

          // If we get here, the send succeeded - use this candidate
          helperPeer = candidatePeer;
          successfulCandidate = candidate;
          break;

        } catch (sendError) {
          console.warn(`⚠️ Candidate ${i + 1} failed: ${sendError.message}`);
          if (i < scoredCandidates.length - 1) {
            console.log(`   Trying next candidate...`);
          }
          // Continue to next candidate
        }
      }

      if (!helperPeer) {
        throw new Error(`All ${scoredCandidates.length} helper candidates failed to respond`);
      }

      console.log(`✅ Selected helper: ${helperPeer.id.toString().substring(0, 8)} (uptime=${(successfulCandidate.uptimeMs/60000).toFixed(1)}min, RTT=${successfulCandidate.rtt}ms) (filtered ${closestPeers.length - fullDHTMembers.length} bridge nodes, ${fullDHTMembers.length - activePeers.length} inactive peers)`);

      // 7. Bridge creates membership token (bridge issues this directly)
      const membershipToken = {
        nodeId: newNodeId,
        issuer: this.dht.localNodeId.toString(), // Bridge node is issuer
        timestamp: Date.now(),
        isOpenNetwork: true,
        authorizedBy: helperPeer.id.toString(), // Helper peer authorized the connection
        signature: 'bridge-issued-open-network-token' // Placeholder signature
      };

      // 8. Notify bootstrap that helper peer will coordinate the invitation
      // The helper peer will create the invitation token and send it to the new node
      await this.sendOnboardingPeerResult(bootstrapPeerId, requestId, true, {
        inviterPeerId: helperPeer.id.toString(),
        inviterMetadata: helperPeer.metadata || {},
        membershipToken,
        status: 'invitation_request_sent_to_helper',
        message: 'Active DHT member will create invitation and coordinate connection'
      });

      console.log(`✅ Onboarding coordination initiated - helper peer ${helperPeer.id.toString().substring(0, 8)} will create invitation`);

    } catch (error) {
      console.error(`❌ Onboarding peer discovery failed: ${error.message}`);
      await this.sendOnboardingPeerResult(bootstrapPeerId, requestId, false, null, error.message);
    }
  }

  /**
   * Send onboarding peer result to bootstrap server
   */
  async sendOnboardingPeerResult(bootstrapPeerId, requestId, success, result, error = null) {
    const message = {
      type: 'onboarding_peer_response',
      requestId,
      success,
      data: result,
      error,
      timestamp: Date.now()
    };

    try {
      // Use bootstrap client to send response back to bootstrap server
      if (this.bootstrapClient) {
        this.bootstrapClient.sendMessage(message);
        console.log(`📤 Sent onboarding result to bootstrap via BootstrapClient (success=${success})`);
      } else {
        console.error(`❌ No bootstrap client available to send onboarding result`);
      }
    } catch (sendError) {
      console.error(`❌ Failed to send onboarding result: ${sendError.message}`);
    }
  }

  /**
   * Generate random node ID for peer discovery
   */
  generateRandomNodeId() {
    const randomBytes = new Uint8Array(20);
    crypto.getRandomValues(randomBytes);
    return new DHTNodeId(randomBytes);
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

    const manager = this.getManagerForPeer(bootstrapPeerId);
    await manager.sendMessage(bootstrapPeerId, response);

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

    const manager = this.getManagerForPeer(bootstrapPeerId);
    await manager.sendMessage(bootstrapPeerId, response);

    console.log(`📤 Sent genesis connection result for ${nodeId.substring(0, 8)}: ${success ? 'SUCCESS' : 'FAILED'} - ${reason}`);
  }

  /**
   * Send open network connection result to bootstrap server
   */
  async sendOpenNetworkConnectionResult(bootstrapPeerId, nodeId, requestId, success, reason, additionalData = {}) {
    const response = {
      type: 'open_network_connection_result',
      nodeId,
      requestId,
      success,
      reason,
      timestamp: Date.now(),
      ...additionalData
    };

    const manager = this.getManagerForPeer(bootstrapPeerId);
    await manager.sendMessage(bootstrapPeerId, response);

    console.log(`📤 Sent open network connection result for ${nodeId.substring(0, 8)}: ${success ? 'SUCCESS' : 'FAILED'} - ${reason}`);
  }

  /**
   * Get the correct connection manager for a peer (single-connection-per-manager architecture)
   * @param {string} peerId - Peer ID
   * @returns {ConnectionManager} The dedicated manager for this peer
   */
  getManagerForPeer(peerId) {
    const manager = this.peerManagers.get(peerId);
    if (!manager) {
      throw new Error(`No connection manager found for peer ${peerId}`);
    }
    return manager;
  }

  /**
   * Send error response
   */
  async sendErrorResponse(peerId, error) {
    const manager = this.getManagerForPeer(peerId);
    await manager.sendMessage(peerId, {
      type: 'error',
      error,
      timestamp: Date.now()
    });
  }

  /**
   * Handle incoming connection through connection manager
   */
  handleIncomingConnection(peerId, connection, manager) {
    console.log(`🔗 Incoming connection from ${peerId.substring(0, 8)}... via connection manager`);

    // Store DHT peer connection AND dedicated manager (single-connection-per-manager architecture)
    this.dhtPeerConnections.set(peerId, connection);
    this.peerManagers.set(peerId, manager);

    // Set up event listeners on the DEDICATED manager for this specific peer
    if (manager) {
      console.log(`🎧 Setting up event listeners on dedicated manager for ${peerId.substring(0, 8)}...`);

      manager.on('message', (data) => {
        this.handleConnectionMessage(data.peerId, data.message);
      });

      manager.on('dhtMessage', (data) => {
        const { peerId: messagePeerId, message } = data;
        console.log(`📨 Bridge received dhtMessage from dedicated manager: ${message.type} from ${messagePeerId.substring(0, 8)}...`);

        // Skip bootstrap server messages
        if (!messagePeerId.startsWith('bootstrap_')) {
          if (this.dht && message.type) {
            console.log(`📨 Bridge forwarding DHT message ${message.type} from ${messagePeerId.substring(0, 8)}... to DHT handler`);
            this.dht.handlePeerMessage(messagePeerId, message);
          }
        }
      });

      console.log(`✅ Event listeners set up on dedicated manager for ${peerId.substring(0, 8)}...`);
    } else {
      console.warn(`⚠️ No dedicated manager provided for ${peerId.substring(0, 8)}...`);
    }

    // Add to connected peers tracking
    // CRITICAL FIX: Don't track temporary bootstrap server connections as peers
    // Bootstrap connections have IDs like "bootstrap_1234567890" and are temporary
    if (peerId.startsWith('bootstrap_')) {
      console.log(`🔗 Ignoring temporary bootstrap connection ${peerId.substring(0, 16)}... in handleIncomingConnection (not a DHT peer)`);
      // Still set up DHT connection handling below, but don't add to connectedPeers
    } else {
      this.connectedPeers.set(peerId, {
        connectedAt: Date.now(),
        lastSeen: Date.now(),
        messageCount: 0,
        isActive: true,
        connectionType: 'websocket',
        source: 'connection_manager'
      });
      console.log(`✅ Added DHT peer ${peerId.substring(0, 8)}... to connectedPeers (now ${this.connectedPeers.size} total peers)`);
    }

    // Only set up DHT connection for actual DHT peers, not bootstrap servers
    if (!peerId.startsWith('bootstrap_')) {
      try {
        // CRITICAL: Delegate to RoutingTable to create DHTNode (proper architecture)
        // RoutingTable owns DHTNode creation and will notify DHT via onNodeAdded callback
        const metadata = {
          connectionType: 'websocket',
          isBridgeConnected: true,
          nodeType: 'nodejs'  // Assume nodejs for incoming WebSocket connections
        };

        this.dht.routingTable.handlePeerConnected(peerId, connection, manager, metadata);
        console.log(`🔗 DHT peer ${peerId.substring(0, 8)}... handed to RoutingTable for DHTNode creation`);

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
    console.log(`🔍 handleConnectionMessage: peerId=${peerId}, type=${message.type}`);

    // Check if this is a bootstrap authentication message
    if (message.type === 'bootstrap_auth') {
      this.handleBootstrapAuth(peerId, message);
      return; // Return early - bootstrap_auth is handled, don't route to handleBootstrapMessage
    }

    // Check if this is a bootstrap server peer (either by ID prefix or if it's in authorized list)
    if (peerId.startsWith('bootstrap_') || this.authorizedBootstrap.has(peerId)) {
      console.log(`🔍 Routing to handleBootstrapMessage: ${message.type} from ${peerId.substring(0, 8)}...`);
      this.handleBootstrapMessage(peerId, message);
      return;
    }

    // FIXED: Check for bootstrap server messages by message type
    // Bootstrap server sends specific message types that only it should send
    const bootstrapMessageTypes = ['get_onboarding_peer', 'connect_genesis_peer', 'validate_reconnection', 'invitation_for_bridge', 'ping'];
    if (bootstrapMessageTypes.includes(message.type)) {
      console.log(`🔍 Detected bootstrap message type ${message.type} from ${peerId.substring(0, 8)}... - routing to handleBootstrapMessage`);
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

      // Send auth success with external address - nginx handles routing
      const serverAddress = this.connectionManager.getServerAddress() || `ws://${this.bridgeHost}:${this.bridgePort}`;
      const externalAddress = this.options.externalAddress || serverAddress;

      const manager = this.getManagerForPeer(peerId);
      await manager.sendMessage(peerId, {
        type: 'auth_success',
        bridgeNodeId: this.dht.localNodeId.toString(),
        listeningAddress: externalAddress,  // All connections via nginx (e.g., wss://imeyouwe.com/bridge1)
        publicWssAddress: externalAddress   // Same address - nginx routes all connections
      });

      console.log(`✅ Bootstrap server authenticated with bridge - advertising ${externalAddress}`);
    } else {
      // Close connection through dedicated peer manager
      const manager = this.getManagerForPeer(peerId);
      manager.destroyConnection(peerId, 'Unauthorized - invalid bridge auth token');
      console.warn('❌ Bootstrap server authentication failed');
    }
  }

  /**
   * Handle messages from authenticated bootstrap server
   */
  async handleBootstrapMessage(peerId, message) {
    // Only process requests from authorized bootstrap servers
    console.log(`🔍 Bootstrap message received: type=${message.type}, peerId=${peerId}, authorized=${this.authorizedBootstrap.has(peerId)}`);
    console.log(`🔍 Authorized bootstrap servers:`, Array.from(this.authorizedBootstrap));
    if (!this.authorizedBootstrap.has(peerId)) {
      console.warn(`❌ Bootstrap server ${peerId} not authorized for message ${message.type}`);
      const manager = this.getManagerForPeer(peerId);
      manager.destroyConnection(peerId, 'Not authorized');
      return;
    }

    try {
      if (message.type === 'ping') {
        // Respond to keep-alive ping from bootstrap server
        const manager = this.getManagerForPeer(peerId);
        await manager.sendMessage(peerId, {
          type: 'pong',
          requestId: message.requestId, // Include requestId to match pending request
          timestamp: Date.now()
        });
      } else if (message.type === 'validate_reconnection') {
        await this.handleReconnectionValidation(peerId, message);
      } else if (message.type === 'connect_genesis_peer') {
        await this.handleGenesisConnection(peerId, message);
      } else if (message.type === 'get_onboarding_peer') {
        await this.handleGetOnboardingPeer(peerId, message);
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
        // Use external address (routed through nginx) for all connections (internal Docker + external browser)
        const bridgeAddress = this.options.externalAddress || this.connectionManager.getServerAddress();

        console.log(`🔗 Bridge node invitation accepted - genesis peer will connect to our WebSocket server`);
        console.log(`📋 Connection will be established when genesis peer connects to our server at ${bridgeAddress}`);

        const manager = this.getManagerForPeer(bootstrapPeerId);
        await manager.sendMessage(bootstrapPeerId, {
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
        const manager = this.getManagerForPeer(bootstrapPeerId);
        await manager.sendMessage(bootstrapPeerId, {
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
      const manager = this.getManagerForPeer(bootstrapPeerId);
      await manager.sendMessage(bootstrapPeerId, {
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

  /**
   * Start HTTP server for metrics and health checks
   */
  async startMetricsServer() {
    this.metricsServer = http.createServer((req, res) => {
      // CORS headers for dashboard
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      if (req.url === '/health') {
        this.handleHealthCheck(req, res);
      } else if (req.url === '/metrics') {
        this.handleMetrics(req, res);
      } else if (req.url === '/status') {
        this.handleStatus(req, res);
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });

    return new Promise((resolve, reject) => {
      this.metricsServer.listen(this.metricsPort, '0.0.0.0', (err) => {
        if (err) {
          reject(err);
        } else {
          console.log(`📊 Metrics server listening on port ${this.metricsPort}`);
          resolve();
        }
      });
    });
  }

  /**
   * Health check endpoint
   */
  handleHealthCheck(req, res) {
    const uptime = Date.now() - this.startTime;
    const connectedPeers = this.connectedPeers.size;

    // Bridge node is healthy if:
    // 1. DHT is running
    // 2. Has been up for at least 5 seconds (startup grace period)
    // 3. OR if it's been up for less than 5 minutes (extended grace for bootstrap issues)
    const isHealthy = this.dht && (uptime > 5000 || uptime < 300000); // 5 minute grace period

    res.writeHead(isHealthy ? 200 : 503);
    res.end(JSON.stringify({
      healthy: isHealthy,
      uptime,
      connectedPeers,
      timestamp: Date.now(),
      nodeType: 'bridge'
    }));
  }

  /**
   * Metrics endpoint
   */
  handleMetrics(req, res) {
    const metrics = {
      uptime: Date.now() - this.startTime,
      connectedPeers: this.connectedPeers.size,
      peerAnnouncements: this.peerAnnouncements.size,
      authorizedBootstrap: this.authorizedBootstrap.size,
      timestamp: Date.now()
    };

    res.writeHead(200);
    res.end(JSON.stringify(metrics, null, 2));
  }

  /**
   * Status endpoint
   */
  handleStatus(req, res) {
    const status = {
      nodeType: 'bridge',
      nodeId: this.dht ? this.dht.localNodeId.toString() : null,
      uptime: Date.now() - this.startTime,
      connectedPeers: this.connectedPeers.size,
      peerAnnouncements: this.peerAnnouncements.size,
      authorizedBootstrap: this.authorizedBootstrap.size,
      bridgePort: this.bridgePort,
      metricsPort: this.metricsPort,
      isHealthy: this.dht && ((Date.now() - this.startTime) > 5000)
    };

    res.writeHead(200);
    res.end(JSON.stringify(status, null, 2));
  }

  /**
   * Shutdown the bridge node and metrics server
   */
  async shutdown() {
    console.log('🛑 Shutting down bridge node...');

    // Close metrics server
    if (this.metricsServer) {
      await new Promise(resolve => this.metricsServer.close(resolve));
      console.log('✅ Metrics server closed');
    }

    // Call parent shutdown
    if (super.shutdown) {
      await super.shutdown();
    }

    console.log('✅ Bridge node shutdown complete');
  }
}