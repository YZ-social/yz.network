import { EventEmitter } from 'events';
import { DHTNodeId } from '../core/DHTNodeId.js';

/**
 * Overlay network for direct peer-to-peer connections
 * Built on top of the Kademlia DHT for advanced routing and communication
 */
export class OverlayNetwork extends EventEmitter {
  constructor(dht, options = {}) {
    super();

    this.dht = dht;
    this.options = {
      maxDirectConnections: options.maxDirectConnections || 100,
      connectionTimeout: options.connectionTimeout || 30000,
      keepAliveInterval: options.keepAliveInterval || 60000,
      routingTableSize: options.routingTableSize || 50,
      ...options
    };

    // Direct connections outside of DHT routing
    this.directConnections = new Map(); // peerId -> connection info
    this.connectionRequests = new Map(); // requestId -> request info
    this.routingCache = new Map(); // destination -> route info
    this.messageQueue = new Map(); // peerId -> [messages...]

    // Connection pools for different purposes
    this.connectionPools = {
      messaging: new Set(), // For direct messaging
      fileTransfer: new Set(), // For file transfers
      streaming: new Set(), // For media streaming
      generic: new Set() // For general purpose
    };

    this.requestId = 0;
    this.isStarted = false;

    this.setupEventHandlers();
  }

  /**
   * Setup event handlers for DHT events
   */
  setupEventHandlers() {
    if (this.dht) {
      this.dht.on('peerConnected', (peerId) => {
        this.handleDHTConnection(peerId);
      });

      this.dht.on('peerDisconnected', (peerId) => {
        this.handleDHTDisconnection(peerId);
      });

      // Note: Individual connection managers handle their own data events
      // OverlayNetwork will receive overlay messages via DHT message routing
      // No need to listen to a single connectionManager since we have per-node managers
    }
  }

  /**
   * Start the overlay network
   */
  async start() {
    if (this.isStarted) return;

    console.log('Starting overlay network...');

    if (!this.dht || !this.dht.isStarted) {
      throw new Error('DHT must be started before overlay network');
    }

    // Start maintenance tasks
    this.startMaintenanceTasks();

    this.isStarted = true;
    this.emit('started');

    console.log('Overlay network started');
  }

  /**
   * Create a direct connection to a peer for a specific purpose
   */
  async createDirectConnection(peerId, purpose = 'generic', options = {}) {
    if (this.directConnections.has(peerId)) {
      const existing = this.directConnections.get(peerId);
      if (existing.purposes.has(purpose)) {
        return existing.connection;
      }
      existing.purposes.add(purpose);
      return existing.connection;
    }

    console.log(`Creating direct connection to ${peerId} for ${purpose}`);

    // First, establish connection through DHT if not already connected
    if (!this.dht.isPeerConnected(peerId)) {
      try {
        await this.dht.connectToPeerViaDHT(peerId);
      } catch (error) {
        throw new Error(`Failed to establish DHT connection: ${error.message}`);
      }
    }

    // Create overlay connection metadata
    const connectionInfo = {
      peerId,
      connection: null, // Will be set by DHT connection management
      purposes: new Set([purpose]),
      createdAt: Date.now(),
      lastActivity: Date.now(),
      options: { ...options }
    };

    this.directConnections.set(peerId, connectionInfo);
    this.connectionPools[purpose].add(peerId);

    // Send overlay connection establishment message
    await this.sendOverlayMessage(peerId, {
      type: 'overlay_connection_request',
      purpose,
      options
    });

    this.emit('directConnectionEstablished', { peerId, purpose });
    return connectionInfo.connection;
  }

  /**
   * Send a direct message to a peer
   */
  async sendDirectMessage(peerId, message, options = {}) {
    const {
      priority = 'normal',
      reliable = true,
      timeout = 10000,
      route = true
    } = options;

    // Try direct connection first
    if (this.directConnections.has(peerId)) {
      return this.sendViaDirectConnection(peerId, message, { priority, reliable });
    }

    // Try DHT connection
    if (this.dht.isPeerConnected(peerId)) {
      return this.sendViaDHT(peerId, message, { priority, reliable });
    }

    // Use routing if enabled
    if (route) {
      return this.sendViaRouting(peerId, message, { priority, reliable, timeout });
    }

    throw new Error(`No connection available to ${peerId}`);
  }

  /**
   * Send message via direct connection
   */
  async sendViaDirectConnection(peerId, message, options = {}) {
    const connectionInfo = this.directConnections.get(peerId);
    if (!connectionInfo) {
      throw new Error('No direct connection to peer');
    }

    const overlayMessage = {
      type: 'overlay_direct_message',
      messageId: this.generateMessageId(),
      payload: message,
      priority: options.priority || 'normal',
      timestamp: Date.now()
    };

    connectionInfo.lastActivity = Date.now();
    return this.dht.sendMessage(peerId, overlayMessage);
  }

  /**
   * Send message via DHT connection
   */
  async sendViaDHT(peerId, message, options = {}) {
    const overlayMessage = {
      type: 'overlay_dht_message',
      messageId: this.generateMessageId(),
      payload: message,
      priority: options.priority || 'normal',
      timestamp: Date.now()
    };

    return this.dht.sendMessage(peerId, overlayMessage);
  }

  /**
   * Send message via routing through intermediate peers
   */
  async sendViaRouting(targetPeerId, message, options = {}) {
    const route = await this.findRoute(targetPeerId);
    if (!route || route.length === 0) {
      throw new Error('No route found to target peer');
    }

    const routedMessage = {
      type: 'overlay_routed_message',
      messageId: this.generateMessageId(),
      source: this.dht.localNodeId.toString(),
      destination: targetPeerId,
      route: route.slice(1), // Remove first hop
      payload: message,
      ttl: route.length + 2,
      timestamp: Date.now()
    };

    // Send to first hop
    const nextHop = route[0];
    console.log(`Routing message to ${targetPeerId} via ${nextHop}`);

    return this.dht.sendMessage(nextHop, routedMessage);
  }

  /**
   * Find route to a target peer
   */
  async findRoute(targetPeerId) {
    // Check cache first
    const cached = this.routingCache.get(targetPeerId);
    if (cached && (Date.now() - cached.timestamp) < 60000) { // 1 minute cache
      return cached.route;
    }

    console.log(`Finding route to ${targetPeerId}`);

    // Try direct DHT lookup first
    // CRITICAL: targetPeerId is a peer ID (hex string), use fromHex() not fromString()
    const targetId = DHTNodeId.fromHex(targetPeerId);
    const closestNodes = this.dht.routingTable.findClosestNodes(targetId, 5);

    // Filter to only connected nodes
    const connectedNodes = closestNodes.filter(node =>
      this.dht.isPeerConnected(node.id.toString())
    );

    if (connectedNodes.length === 0) {
      return [];
    }

    // Simple routing: use closest connected peer as first hop
    const route = [connectedNodes[0].id.toString()];

    // Cache the route
    this.routingCache.set(targetPeerId, {
      route,
      timestamp: Date.now()
    });

    return route;
  }

  /**
   * Handle overlay network messages
   */
  async handleOverlayMessage(peerId, message) {
    console.log(`Overlay message from ${peerId}: ${message.type}`);

    try {
      switch (message.type) {
        case 'overlay_connection_request':
          await this.handleConnectionRequest(peerId, message);
          break;

        case 'overlay_connection_response':
          await this.handleConnectionResponse(peerId, message);
          break;

        case 'overlay_direct_message':
          await this.handleDirectMessage(peerId, message);
          break;

        case 'overlay_dht_message':
          await this.handleDHTMessage(peerId, message);
          break;

        case 'overlay_routed_message':
          await this.handleRoutedMessage(peerId, message);
          break;

        case 'overlay_route_request':
          await this.handleRouteRequest(peerId, message);
          break;

        case 'overlay_route_response':
          await this.handleRouteResponse(peerId, message);
          break;

        default:
          console.warn(`Unknown overlay message type: ${message.type}`);
      }
    } catch (error) {
      console.error(`Error handling overlay message: ${error.message}`);
    }
  }

  /**
   * Handle connection request
   */
  async handleConnectionRequest(peerId, message) {
    const { purpose, options } = message;

    console.log(`Connection request from ${peerId} for ${purpose}`);

    // Check if we can accept the connection
    if (this.directConnections.size >= this.options.maxDirectConnections) {
      await this.sendOverlayMessage(peerId, {
        type: 'overlay_connection_response',
        success: false,
        error: 'Maximum connections reached'
      });
      return;
    }

    // Accept the connection
    const connectionInfo = {
      peerId,
      connection: null, // Will be set by DHT connection management
      purposes: new Set([purpose]),
      createdAt: Date.now(),
      lastActivity: Date.now(),
      options: { ...options }
    };

    this.directConnections.set(peerId, connectionInfo);
    this.connectionPools[purpose].add(peerId);

    await this.sendOverlayMessage(peerId, {
      type: 'overlay_connection_response',
      success: true,
      purpose
    });

    this.emit('directConnectionEstablished', { peerId, purpose });
  }

  /**
   * Handle direct message
   */
  async handleDirectMessage(peerId, message) {
    const { messageId, payload, priority } = message;

    console.log(`Direct message from ${peerId}: ${messageId}`);

    // Update activity
    const connectionInfo = this.directConnections.get(peerId);
    if (connectionInfo) {
      connectionInfo.lastActivity = Date.now();
    }

    this.emit('directMessage', {
      peerId,
      messageId,
      payload,
      priority,
      timestamp: message.timestamp
    });
  }

  /**
   * Handle routed message
   */
  async handleRoutedMessage(peerId, message) {
    const { destination, route, payload, ttl, source } = message;

    console.log(`Routed message from ${source} to ${destination}, TTL: ${ttl}`);

    // Check if we're the destination
    if (destination === this.dht.localNodeId.toString()) {
      this.emit('routedMessage', {
        source,
        payload,
        messageId: message.messageId,
        timestamp: message.timestamp
      });
      return;
    }

    // Check TTL
    if (ttl <= 0) {
      console.warn('Message TTL expired, dropping');
      return;
    }

    // Forward the message
    if (route.length > 0) {
      const nextHop = route[0];
      const forwardedMessage = {
        ...message,
        route: route.slice(1),
        ttl: ttl - 1
      };

      if (this.dht.isPeerConnected(nextHop)) {
        await this.dht.sendMessage(nextHop, forwardedMessage);
        console.log(`Forwarded message to ${nextHop}`);
      } else {
        console.warn(`Next hop ${nextHop} not connected, dropping message`);
      }
    }
  }

  /**
   * Send overlay message
   */
  async sendOverlayMessage(peerId, message) {
    return this.dht.sendMessage(peerId, message);
  }

  /**
   * Handle DHT connection established
   */
  handleDHTConnection(peerId) {
    console.log(`DHT connection established with ${peerId}`);
    // DHT connections can be used for overlay routing
  }

  /**
   * Handle DHT connection lost
   */
  handleDHTDisconnection(peerId) {
    console.log(`DHT connection lost with ${peerId}`);

    // Clean up direct connections
    if (this.directConnections.has(peerId)) {
      const connectionInfo = this.directConnections.get(peerId);

      // Remove from pools
      for (const purpose of connectionInfo.purposes) {
        this.connectionPools[purpose].delete(peerId);
      }

      this.directConnections.delete(peerId);
      this.emit('directConnectionLost', { peerId });
    }

    // Invalidate routing cache entries
    this.routingCache.delete(peerId);
  }

  /**
   * Start maintenance tasks
   */
  startMaintenanceTasks() {
    // Keep-alive for direct connections
    setInterval(() => {
      this.sendKeepAlives();
    }, this.options.keepAliveInterval);

    // Clean up stale routes
    setInterval(() => {
      this.cleanupRoutingCache();
    }, 5 * 60 * 1000); // 5 minutes

    // Connection health check
    setInterval(() => {
      this.checkConnectionHealth();
    }, 30 * 1000); // 30 seconds
  }

  /**
   * Send keep-alive messages to direct connections
   */
  async sendKeepAlives() {
    const now = Date.now();

    for (const [peerId, connectionInfo] of this.directConnections.entries()) {
      if (now - connectionInfo.lastActivity > this.options.keepAliveInterval) {
        try {
          await this.sendOverlayMessage(peerId, {
            type: 'overlay_keep_alive',
            timestamp: now
          });
          connectionInfo.lastActivity = now;
        } catch (error) {
          console.warn(`Failed to send keep-alive to ${peerId}:`, error);
        }
      }
    }
  }

  /**
   * Clean up routing cache
   */
  cleanupRoutingCache() {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // 5 minutes

    for (const [peerId, routeInfo] of this.routingCache.entries()) {
      if (now - routeInfo.timestamp > maxAge) {
        this.routingCache.delete(peerId);
      }
    }
  }

  /**
   * Check connection health
   */
  checkConnectionHealth() {
    const now = Date.now();
    const timeout = 2 * this.options.keepAliveInterval;

    for (const [peerId, connectionInfo] of this.directConnections.entries()) {
      if (now - connectionInfo.lastActivity > timeout) {
        console.warn(`Connection to ${peerId} appears stale, removing`);
        this.handleDHTDisconnection(peerId);
      }
    }
  }

  /**
   * Generate unique message ID
   */
  generateMessageId() {
    return `overlay_${this.dht.localNodeId.toString().substr(0, 8)}_${Date.now()}_${++this.requestId}`;
  }

  /**
   * Get overlay network statistics
   */
  getStats() {
    return {
      isStarted: this.isStarted,
      directConnections: this.directConnections.size,
      connectionPools: Object.fromEntries(
        Object.entries(this.connectionPools).map(([purpose, peers]) =>
          [purpose, peers.size]
        )
      ),
      routingCacheSize: this.routingCache.size,
      messageQueueSize: Array.from(this.messageQueue.values())
        .reduce((total, queue) => total + queue.length, 0),
      connectionsByPurpose: this.getConnectionsByPurpose()
    };
  }

  /**
   * Get connections grouped by purpose
   */
  getConnectionsByPurpose() {
    const byPurpose = {};

    for (const [peerId, connectionInfo] of this.directConnections.entries()) {
      for (const purpose of connectionInfo.purposes) {
        if (!byPurpose[purpose]) {
          byPurpose[purpose] = [];
        }
        byPurpose[purpose].push({
          peerId,
          createdAt: connectionInfo.createdAt,
          lastActivity: connectionInfo.lastActivity
        });
      }
    }

    return byPurpose;
  }

  /**
   * Stop the overlay network
   */
  async stop() {
    if (!this.isStarted) return;

    console.log('Stopping overlay network...');

    // Close all direct connections
    for (const [peerId, connectionInfo] of this.directConnections.entries()) {
      try {
        await this.sendOverlayMessage(peerId, {
          type: 'overlay_connection_close',
          timestamp: Date.now()
        });
      } catch (error) {
        console.warn(`Failed to send close message to ${peerId}:`, error);
      }
    }

    // Clear data structures
    this.directConnections.clear();
    this.connectionRequests.clear();
    this.routingCache.clear();
    this.messageQueue.clear();

    for (const pool of Object.values(this.connectionPools)) {
      pool.clear();
    }

    this.isStarted = false;
    this.emit('stopped');

    console.log('Overlay network stopped');
  }

  // ============================================================================
  // WebRTC Signaling Methods (moved from KademliaDHT)
  // ============================================================================

  /**
   * Handle outgoing WebRTC signal
   */
  async handleOutgoingSignal(peerId, signal) {
    // Determine signaling method based on peer status
    const isDHTMember = this.dht.routingTable.getNode(peerId) !== null;
    // Check if this peer is currently being invited
    const isInvitationFlow = signal.invitationFlow || this.dht.pendingInvitations.has(peerId);

    // Priority: DHT members always use DHT signaling (browser-to-browser WebRTC)
    // Only use bootstrap for invitations or non-DHT members
    if (isInvitationFlow || !isDHTMember) {
      // Use bootstrap server for:
      // 1. New client invitations (invitation flow)
      // 2. Peers not yet in our routing table (not DHT members)
      console.log(`🔗 Using bootstrap signaling for ${peerId.substring(0, 8)}... (invitation: ${isInvitationFlow}, DHT member: ${isDHTMember})`);
      await this.dht.bootstrap.forwardSignal(peerId, signal);
    } else {
      // Use DHT direct messaging for signaling between existing DHT members
      console.log(`🌐 Using DHT messaging for ${peerId.substring(0, 8)}... (existing DHT member)`);
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
        await this.sendConnectionOffer(peerId, signal.sdp);
      } else if (signal.type === 'answer') {
        await this.sendConnectionAnswer(peerId, signal.sdp);
      } else if (signal.type === 'candidate') {
        await this.sendConnectionCandidate(peerId, {
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
      await this.dht.bootstrap.forwardSignal(peerId, signal);
    }
  }

  /**
   * Route WebRTC message to target peer through DHT
   */
  async routeSignalingMessage(targetPeer, message) {
    console.log(`🚀 Routing WebRTC message to ${targetPeer}: ${message.type}`);

    try {
      // Try to send directly if we have a connection to the target
      if (this.dht.isPeerConnected(targetPeer)) {
        await this.dht.sendMessage(targetPeer, message);
        console.log(`✅ Directly routed WebRTC message to ${targetPeer}`);
        return;
      }

      // In small networks, any connected peer can potentially route to the target
      // Try XOR-closest nodes first, then fall back to any connected peer
      const targetNodeId = this.dht.localNodeId.constructor.fromHex(targetPeer);
      const closestNodes = this.dht.routingTable.findClosestNodes(targetNodeId, this.dht.options.alpha);

      // Try closest nodes first if they're connected
      for (const node of closestNodes) {
        const nextHop = node.id.toString();
        if (this.dht.isPeerConnected(nextHop)) {
          await this.dht.sendMessage(nextHop, message);
          console.log(`✅ Routed WebRTC message via closest peer ${nextHop.substring(0, 8)}... to ${targetPeer.substring(0, 8)}...`);
          return;
        }
      }

      // Fall back to any connected peer for small networks where XOR-closest might not be connected
      const connectedPeers = this.dht.getConnectedPeers();
      if (connectedPeers.length === 0) {
        console.warn(`No connected peers available to route WebRTC message to ${targetPeer.substring(0, 8)}...`);
        return;
      }

      // Try any connected peer as a potential route
      for (const nextHop of connectedPeers) {
        try {
          await this.dht.sendMessage(nextHop, message);
          console.log(`✅ Routed WebRTC message via connected peer ${nextHop.substring(0, 8)}... to ${targetPeer.substring(0, 8)}...`);
          return;
        } catch (error) {
          console.warn(`Failed to route via ${nextHop.substring(0, 8)}...: ${error.message}`);
        }
      }

      console.warn(`No connected route found to forward signaling message to ${targetPeer.substring(0, 8)}... (tried ${connectedPeers.length} peers)`);
    } catch (error) {
      console.error(`Failed to route signaling message to ${targetPeer}:`, error);
    }
  }

  /**
   * Send connection offer via DHT messaging
   */
  async sendConnectionOffer(targetPeer, offer) {
    console.log(`📤 Sending connection offer via DHT to ${targetPeer}`);

    const message = {
      type: 'connection_offer',
      senderPeer: this.dht.localNodeId.toString(),
      targetPeer: targetPeer,
      offer: offer,
      timestamp: Date.now()
    };
    await this.routeSignalingMessage(targetPeer, message);
  }

  /**
   * Send connection answer via DHT messaging
   */
  async sendConnectionAnswer(targetPeer, answer) {
    console.log(`📤 Sending connection answer via DHT to ${targetPeer}`);

    const message = {
      type: 'connection_answer',
      senderPeer: this.dht.localNodeId.toString(),
      targetPeer: targetPeer,
      answer: answer,
      timestamp: Date.now()
    };
    await this.routeSignalingMessage(targetPeer, message);
  }

  /**
   * Send connection ICE candidate via DHT messaging
   */
  async sendConnectionCandidate(targetPeer, candidate) {
    console.log(`📤 Sending connection ICE candidate via DHT to ${targetPeer}`);

    const message = {
      type: 'connection_candidate',
      senderPeer: this.dht.localNodeId.toString(),
      targetPeer: targetPeer,
      candidate: candidate,
      timestamp: Date.now()
    };
    await this.routeSignalingMessage(targetPeer, message);
  }

  /**
   * Handle connection offer message via DHT
   */
  async handleConnectionOffer(fromPeer, message) {
    console.log(`🔄 DHT: Received connection offer from ${fromPeer} for peer ${message.targetPeer}`);

    // Check if this offer is for us
    if (message.targetPeer !== this.dht.localNodeId.toString()) {
      // Add routing hop tracking to prevent loops
      if (!message.hops) {
        message.hops = [];
      }

      // Check for actual routing loops - only block if we appear multiple times in the path
      const localNodeId = this.dht.localNodeId.toString();
      const hopOccurrences = message.hops.filter(id => id === localNodeId).length;

      if (hopOccurrences > 0) {
        console.warn(`🔄 Dropping WebRTC offer - actual routing loop detected (node appears ${hopOccurrences + 1} times in path)`);
        return;
      }

      // Allow reasonable hop counts for small networks
      if (message.hops.length >= 4) {
        console.warn(`🔄 Dropping WebRTC offer - maximum hop count exceeded (${message.hops.length})`);
        return;
      }

      // Add ourselves to the hop list
      message.hops.push(this.dht.localNodeId.toString());

      // This is a routed message - forward it to the target peer
      await this.routeSignalingMessage(message.targetPeer, message);
      return;
    }
    // This offer is for us - delegate to connection manager
    console.log(`📥 Received signaling offer from ${message.senderPeer} - delegating to connection manager`);

    // Get or create the connection manager for the sender peer
    const senderPeer = message.senderPeer;
    let peerNode = this.dht.routingTable.getNode(senderPeer);

    if (!peerNode || !peerNode.connectionManager) {
      console.log(`🔧 Creating connection manager for new peer ${senderPeer} during WebRTC signaling`);

      // Use DHT helper to create peer node with connection manager
      peerNode = this.dht.getOrCreatePeerNode(senderPeer, { nodeType: 'browser' });

      if (!peerNode.connectionManager) {
        console.error(`❌ Failed to create connection manager for sender ${senderPeer}`);
        return;
      }
    }

    // Delegate WebRTC offer processing to the connection manager
    await peerNode.connectionManager.handleSignal(senderPeer, {
      type: 'offer',
      sdp: message.offer
    });
  }

  /**
   * Handle connection answer message via DHT
   */
  async handleConnectionAnswer(fromPeer, message) {
    console.log(`🔄 DHT: Received connection answer from ${fromPeer} for peer ${message.targetPeer}`);

    // Check if this answer is for us
    if (message.targetPeer !== this.dht.localNodeId.toString()) {
      // Add routing hop tracking to prevent loops
      if (!message.hops) {
        message.hops = [];
      }

      // Check for actual routing loops - only block if we appear multiple times in the path
      const localNodeId = this.dht.localNodeId.toString();
      const hopOccurrences = message.hops.filter(id => id === localNodeId).length;

      if (hopOccurrences > 0) {
        console.warn(`🔄 Dropping WebRTC answer - actual routing loop detected (node appears ${hopOccurrences + 1} times in path)`);
        return;
      }

      // Allow reasonable hop counts for small networks
      if (message.hops.length >= 4) {
        console.warn(`🔄 Dropping WebRTC answer - maximum hop count exceeded (${message.hops.length})`);
        return;
      }

      // Add ourselves to the hop list
      message.hops.push(this.dht.localNodeId.toString());

      // This is a routed message - forward it to the target peer
      await this.routeSignalingMessage(message.targetPeer, message);
      return;
    }
    // This answer is for us - delegate to connection manager
    console.log(`📥 Received signaling answer from ${message.senderPeer} - delegating to connection manager`);

    // Get or create the connection manager for the sender peer
    const senderPeer = message.senderPeer;
    let peerNode = this.dht.routingTable.getNode(senderPeer);

    if (!peerNode || !peerNode.connectionManager) {
      console.log(`🔧 Creating connection manager for new peer ${senderPeer} during WebRTC signaling`);

      // Use DHT helper to create peer node with connection manager
      peerNode = this.dht.getOrCreatePeerNode(senderPeer, { nodeType: 'browser' });

      if (!peerNode.connectionManager) {
        console.error(`❌ Failed to create connection manager for sender ${senderPeer}`);
        return;
      }
    }

    // Delegate WebRTC answer processing to the connection manager
    await peerNode.connectionManager.handleSignal(senderPeer, {
      type: 'answer',
      sdp: message.answer
    });
  }

  /**
   * Handle connection ICE candidate message via DHT
   */
  async handleConnectionCandidate(fromPeer, message) {
    console.log(`🔄 DHT: Received connection ICE candidate from ${fromPeer} for peer ${message.targetPeer}`);

    // Check if this ICE candidate is for us
    if (message.targetPeer !== this.dht.localNodeId.toString()) {
      // Add routing hop tracking to prevent loops
      if (!message.hops) {
        message.hops = [];
      }

      // Check for actual routing loops - only block if we appear multiple times in the path
      const localNodeId = this.dht.localNodeId.toString();
      const hopOccurrences = message.hops.filter(id => id === localNodeId).length;

      if (hopOccurrences > 0) {
        console.warn(`🔄 Dropping WebRTC ICE candidate - actual routing loop detected (node appears ${hopOccurrences + 1} times in path)`);
        return;
      }

      // Allow reasonable hop counts for small networks
      if (message.hops.length >= 4) {
        console.warn(`🔄 Dropping WebRTC ICE candidate - maximum hop count exceeded (${message.hops.length})`);
        return;
      }

      // Add ourselves to the hop list
      message.hops.push(this.dht.localNodeId.toString());

      // This is a routed message - forward it to the target peer
      await this.routeSignalingMessage(message.targetPeer, message);
      return;
    }
    // This ICE candidate is for us - delegate to connection manager
    console.log(`📥 Received ICE candidate from ${message.senderPeer} - delegating to connection manager`);

    // Get or create the connection manager for the sender peer
    const senderPeer = message.senderPeer;
    let peerNode = this.dht.routingTable.getNode(senderPeer);

    if (!peerNode || !peerNode.connectionManager) {
      console.log(`🔧 Creating connection manager for new peer ${senderPeer} during WebRTC signaling`);

      // Use DHT helper to create peer node with connection manager
      peerNode = this.dht.getOrCreatePeerNode(senderPeer, { nodeType: 'browser' });

      if (!peerNode.connectionManager) {
        console.error(`❌ Failed to create connection manager for sender ${senderPeer}`);
        return;
      }
    }

    // Delegate WebRTC ICE candidate processing to the connection manager
    // Extract fields from the candidate object (message.candidate contains {candidate, sdpMLineIndex, sdpMid})
    await peerNode.connectionManager.handleSignal(senderPeer, {
      type: 'candidate',
      candidate: message.candidate.candidate,
      sdpMLineIndex: message.candidate.sdpMLineIndex,
      sdpMid: message.candidate.sdpMid
    });
  }
}