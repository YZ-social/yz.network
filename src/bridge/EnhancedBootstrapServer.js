import { EventEmitter } from 'events';
import { WebSocket, WebSocketServer } from 'ws';

/**
 * Enhanced Bootstrap Server with Bridge Integration
 *
 * Provides WebRTC signaling for new peers and reconnection services through bridge nodes.
 * Public-facing server that routes reconnection requests to internal bridge nodes.
 */
export class EnhancedBootstrapServer extends EventEmitter {
  constructor(options = {}) {
    super();

    this.options = {
      port: options.port || 8080,
      host: options.host || '0.0.0.0',
      maxPeers: options.maxPeers || 1000,
      peerTimeout: options.peerTimeout || 5 * 60 * 1000, // 5 minutes
      createNewDHT: options.createNewDHT || false,
      openNetwork: options.openNetwork || false, // Open network mode - no invitations required
      bridgeNodes: options.bridgeNodes || [
        'localhost:8083',  // Primary bridge node
        'localhost:8084',  // Backup bridge node
      ],
      bridgeAuth: options.bridgeAuth || 'default-bridge-auth-key',
      bridgeTimeout: options.bridgeTimeout || 30000, // 30 seconds
      ...options
    };

    // Client management
    this.peers = new Map(); // nodeId -> { ws, lastSeen, metadata, isGenesisPeer, type }
    this.connectedClients = new Map(); // nodeId -> { ws, nodeId, metadata, timestamp }
    this.server = null;

    // Bridge node management
    this.bridgeConnections = new Map(); // bridgeAddr -> WebSocket
    this.bridgeReconnectTimers = new Map(); // bridgeAddr -> timer
    this.pendingReconnections = new Map(); // requestId -> { ws, resolve, reject, timeout }
    this.pendingGenesisRequests = new Map(); // nodeId -> { ws, message, timestamp }
    this.pendingInvitations = new Map(); // invitationId -> { inviterNodeId, inviteeNodeId, inviterWs, inviteeWs, status, timestamp }
    this.pendingBridgeQueries = new Map(); // requestId -> { ws, nodeId, metadata, clientMessage, resolve, reject, timeout }

    // Server state
    this.isStarted = false;
    this.totalConnections = 0;
  }

  /**
   * Start the enhanced bootstrap server
   */
  async start() {
    if (this.isStarted) {
      throw new Error('Bootstrap server already started');
    }

    console.log('🚀 Starting Enhanced Bootstrap Server');

    // Bridge connections will use raw WebSocket for bootstrap authentication

    // Start public bootstrap server
    this.server = new WebSocketServer({
      port: this.options.port,
      host: this.options.host
    });

    this.server.on('connection', (ws, req) => {
      this.handleClientConnection(ws, req);
    });

    // Bridge nodes will be connected on-demand when genesis peer arrives

    // Start maintenance tasks
    this.startMaintenanceTasks();

    this.isStarted = true;

    console.log(`🌟 Enhanced Bootstrap Server started`);
    console.log(`🔗 Public server: ${this.options.host}:${this.options.port}`);
    console.log(`🌉 Bridge nodes: ${this.options.bridgeNodes.length} configured`);
    console.log(`🆕 Create new DHT mode: ${this.options.createNewDHT ? 'ENABLED' : 'DISABLED'}`);
    console.log(`🌐 Open network mode: ${this.options.openNetwork ? 'ENABLED (no invitations required)' : 'DISABLED (invitations required)'}`);
    console.log(`👥 Max peers: ${this.options.maxPeers}`);
  }

  /**
   * Stop the bootstrap server
   */
  async stop() {
    if (!this.isStarted) {
      return;
    }

    console.log('🛑 Stopping Enhanced Bootstrap Server');

    // Close all client connections
    for (const [nodeId, peer] of this.peers) {
      if (peer.ws && peer.ws.readyState === WebSocket.OPEN) {
        peer.ws.close(1000, 'Server shutdown');
      }
    }
    this.peers.clear();

    // Close bridge connections
    for (const [addr, ws] of this.bridgeConnections) {
      ws.close(1000, 'Server shutdown');
    }
    this.bridgeConnections.clear();

    // Clear timers
    for (const timer of this.bridgeReconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.bridgeReconnectTimers.clear();

    // Close server
    if (this.server) {
      this.server.close();
      this.server = null;
    }

    this.isStarted = false;
    console.log('🚀 Enhanced Bootstrap Server stopped');
  }

  /**
   * Connect to internal bridge nodes
   */
  async connectToBridgeNodes() {
    console.log(`🌉 Connecting to ${this.options.bridgeNodes.length} bridge nodes`);

    const connectionPromises = this.options.bridgeNodes.map(bridgeAddr =>
      this.connectToBridgeNode(bridgeAddr)
    );

    // Wait for at least one bridge connection
    const results = await Promise.allSettled(connectionPromises);
    const successfulConnections = results.filter(r => r.status === 'fulfilled').length;

    if (successfulConnections === 0) {
      console.warn('⚠️ No bridge nodes connected - reconnection services unavailable');
    } else {
      console.log(`✅ Connected to ${successfulConnections}/${this.options.bridgeNodes.length} bridge nodes`);
    }
  }

  /**
   * Connect to a single bridge node
   */
  async connectToBridgeNode(bridgeAddr) {
    try {
      console.log(`🔗 Connecting to bridge node: ${bridgeAddr}`);

      // Use raw WebSocket connection for bootstrap authentication (not DHT protocol)
      const ws = new WebSocket(`ws://${bridgeAddr}`);

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Bridge connection timeout: ${bridgeAddr}`));
        }, 10000);

        ws.onopen = () => {
          // Send bootstrap authentication immediately
          ws.send(JSON.stringify({
            type: 'bootstrap_auth',
            auth_token: this.options.bridgeAuth,
            bootstrapServer: `${this.options.host}:${this.options.port}`
          }));
        };

        ws.onmessage = (event) => {
          const message = JSON.parse(event.data);

          if (message.type === 'auth_success') {
            clearTimeout(timeout);

            // CRITICAL: Store bridge node ID from auth response
            ws.bridgeNodeId = message.bridgeNodeId;
            console.log(`🔍 Stored bridge node ID: ${message.bridgeNodeId?.substring(0, 8)}...`);

            // Set up ongoing message handler for bridge communication
            ws.onmessage = (event) => {
              try {
                const bridgeMessage = JSON.parse(event.data);
                this.handleBridgeResponse(bridgeAddr, bridgeMessage);
              } catch (error) {
                console.error(`Error parsing bridge message from ${bridgeAddr}:`, error);
              }
            };
            resolve(ws);
          } else {
            this.handleBridgeResponse(bridgeAddr, message);
          }
        };

        ws.onerror = (error) => {
          clearTimeout(timeout);
          reject(error);
        };

        ws.onclose = () => {
          console.warn(`🔌 Bridge node disconnected: ${bridgeAddr}`);
          this.bridgeConnections.delete(bridgeAddr);
          this.scheduleBridgeReconnect(bridgeAddr);
        };

        // Store the connection after successful authentication
        this.bridgeConnections.set(bridgeAddr, ws);
        console.log(`✅ Bridge node connected and authenticated: ${bridgeAddr}`);
      });

    } catch (error) {
      console.error(`❌ Failed to connect to bridge node ${bridgeAddr}:`, error);
      this.scheduleBridgeReconnect(bridgeAddr);
      throw error;
    }
  }

  /**
   * Schedule bridge node reconnection
   */
  scheduleBridgeReconnect(bridgeAddr) {
    if (this.bridgeReconnectTimers.has(bridgeAddr)) {
      return; // Already scheduled
    }

    const timer = setTimeout(async () => {
      this.bridgeReconnectTimers.delete(bridgeAddr);
      try {
        await this.connectToBridgeNode(bridgeAddr);
      } catch (error) {
        console.warn(`Bridge reconnection failed: ${bridgeAddr}`);
        this.scheduleBridgeReconnect(bridgeAddr); // Try again
      }
    }, 30000); // 30 second delay

    this.bridgeReconnectTimers.set(bridgeAddr, timer);
  }

  /**
   * Handle new client connection
   */
  handleClientConnection(ws) {
    this.totalConnections++;

    console.log(`🔗 New client connection (total: ${this.totalConnections})`);

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        this.handleClientMessage(ws, message);
      } catch (error) {
        console.error('Error parsing client message:', error);
        ws.close(1002, 'Invalid JSON');
      }
    });

    ws.on('close', () => {
      this.handleClientDisconnection(ws);
    });

    ws.on('error', (error) => {
      console.error('Client WebSocket error:', error);
    });
  }

  /**
   * Handle message from client
   */
  async handleClientMessage(ws, message) {
    try {
      if (message.type === 'register') {
        await this.handleClientRegistration(ws, message);
      } else if (message.type === 'get_peers_or_genesis') {
        await this.handleGetPeersOrGenesis(ws, message);
      } else if (message.type === 'send_invitation') {
        await this.handleSendInvitation(ws, message);
      } else if (message.type === 'signal') {
        this.handleSignaling(ws, message);
      } else if (message.type === 'join_peer') {
        this.handleJoinPeer(ws, message);
      } else if (message.type === 'forward_signal') {
        this.handleForwardSignal(ws, message);
      } else if (message.type === 'invitation_accepted') {
        this.handleInvitationAccepted(ws, message);
      } else if (message.type === 'announce_independent') {
        this.handleAnnounceIndependent(ws, message);
      } else {
        console.warn('Unknown message type from client:', message.type);
      }
    } catch (error) {
      console.error('Error handling client message:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Internal server error'
      }));
    }
  }

  /**
   * Handle get_peers_or_genesis request (BootstrapClient compatibility)
   */
  async handleGetPeersOrGenesis(ws, message) {
    const { nodeId, maxPeers } = message;

    console.log(`📋 Received get_peers_or_genesis request from ${nodeId?.substring(0, 8) || 'unknown'}...`);

    try {
      // Add client to connected clients if not already present
      if (nodeId && !this.connectedClients.has(nodeId)) {
        this.connectedClients.set(nodeId, {
          ws,
          nodeId,
          metadata: message.metadata || {},
          timestamp: Date.now()
        });
        console.log(`➕ Added client ${nodeId.substring(0, 8)}... to connected clients (total: ${this.connectedClients.size})`);
      }

      // In genesis mode, first connecting peer becomes genesis
      if (this.options.createNewDHT && this.connectedClients.size === 1) {
        console.log(`🌟 Genesis mode: Designating ${nodeId?.substring(0, 8)}... as genesis peer`);

        // Update peer record to mark as genesis
        const peer = this.peers.get(nodeId);
        if (peer) {
          peer.isGenesisPeer = true;
        }

        // DON'T send immediate response - wait for bridge connection to complete
        // The response will be sent in handleGenesisConnectionResult()

        // After genesis peer is set up, connect to bridge nodes and establish genesis-bridge connection
        setTimeout(async () => {
          try {
            console.log(`🌉 Genesis peer designated, now connecting to bridge nodes...`);

            // Connect to bridge nodes first
            await this.connectToBridgeNodes();

            console.log(`🔍 Bridge connections status: ${this.bridgeConnections.size} connected`);
            for (const [addr, ws] of this.bridgeConnections) {
              console.log(`   ${addr}: ${ws.readyState === 1 ? 'OPEN' : 'NOT_OPEN'}`);
            }

            // Then connect genesis to bridge
            await this.connectGenesisToBridge(ws, nodeId, message.metadata || {}, message);
          } catch (error) {
            console.error(`❌ Failed to connect genesis to bridge: ${error.message}`);
            // Continue without bridge connection - genesis can still invite peers manually
          }
        }, 2000); // Give genesis peer time to complete setup

        return;
      }

      // Open network mode - use random peer onboarding for scalability
      if (this.options.openNetwork && this.connectedClients.size > 1) {
        console.log(`🌐 Open network mode: Finding random onboarding peer for ${nodeId?.substring(0, 8)}...`);

        // DON'T send immediate response - wait for bridge to find helper peer
        // The response will be sent in handleOnboardingPeerResult()

        // Query bridge for random peer selection
        setTimeout(async () => {
          try {
            console.log(`🎲 Querying bridge for random onboarding peer (connection-agnostic)...`);

            // Ensure bridge nodes are connected
            if (this.bridgeConnections.size === 0) {
              await this.connectToBridgeNodes();
            }

            console.log(`🔍 Bridge connections status: ${this.bridgeConnections.size} connected`);

            // Get random peer from bridge (bridge finds peer via DHT, sends invitation via DHT)
            await this.getOnboardingPeerFromBridge(ws, nodeId, message.metadata || {}, message);
          } catch (error) {
            console.error(`❌ Failed to get onboarding peer from bridge: ${error.message}`);
            // Send error response
            ws.send(JSON.stringify({
              type: 'response',
              requestId: message.requestId,
              success: false,
              error: `Random peer onboarding failed: ${error.message}`
            }));
          }
        }, 500); // Small delay to ensure peer registration is complete

        return;
      }

      // Standard mode - return existing peers or empty list
      const availablePeers = Array.from(this.connectedClients.values())
        .filter(client => client.nodeId !== nodeId)
        .slice(0, maxPeers || 20)
        .map(client => ({
          nodeId: client.nodeId,
          metadata: client.metadata || {}
        }));

      console.log(`📤 Sending ${availablePeers.length} available peers to ${nodeId?.substring(0, 8)}...`);

      // Send standard BootstrapClient-compatible response
      ws.send(JSON.stringify({
        type: 'response',
        requestId: message.requestId,
        success: true,
        data: {
          peers: availablePeers,
          isGenesis: false
        }
      }));

    } catch (error) {
      console.error('Error handling get_peers_or_genesis request:', error);

      // Send error response in BootstrapClient format
      ws.send(JSON.stringify({
        type: 'response',
        requestId: message.requestId,
        success: false,
        error: error.message
      }));
    }
  }

  /**
   * Handle send_invitation request from DHT clients
   */
  async handleSendInvitation(ws, message) {
    const { targetPeerId, invitationToken, inviterNodeId, websocketCoordination } = message;

    console.log(`🎫 Invitation request: ${inviterNodeId?.substring(0, 8)}... → ${targetPeerId?.substring(0, 8)}...`);

    try {
      // Check if target is a bridge node first
      let targetIsBridge = false;
      let bridgeConnection = null;

      // Check if target is a connected bridge node
      for (const [, bridgeWs] of this.bridgeConnections) {
        if (bridgeWs.readyState === WebSocket.OPEN && bridgeWs.bridgeNodeId === targetPeerId) {
          targetIsBridge = true;
          bridgeConnection = bridgeWs;
          console.log(`🔍 Target ${targetPeerId.substring(0, 8)}... is connected bridge node`);
          break;
        }
      }

      if (targetIsBridge && bridgeConnection) {
        // Forward invitation to bridge node
        console.log(`🌉 Forwarding invitation to bridge node ${targetPeerId.substring(0, 8)}...`);

        bridgeConnection.send(JSON.stringify({
          type: 'invitation_for_bridge',
          targetPeerId: targetPeerId,
          fromPeer: inviterNodeId,
          invitationToken,
          websocketCoordination,
          message: 'You have been invited to join the DHT network'
        }));

        // Send success response to inviter
        ws.send(JSON.stringify({
          type: 'response',
          requestId: message.requestId,
          success: true,
          data: {
            message: 'Invitation sent to bridge node successfully',
            targetPeer: targetPeerId
          }
        }));

        console.log(`✅ Invitation forwarded to bridge node ${targetPeerId.substring(0, 8)}...`);
        return;
      }

      // Find target peer connection (regular client)
      const targetClient = this.connectedClients.get(targetPeerId);
      if (!targetClient) {
        // Target peer not connected - send failure response
        ws.send(JSON.stringify({
          type: 'response',
          requestId: message.requestId,
          success: false,
          error: 'Target peer not connected'
        }));
        return;
      }

      console.log(`📤 Forwarding invitation token to ${targetPeerId.substring(0, 8)}...`);

      // Get inviter peer information
      const inviterClient = this.connectedClients.get(inviterNodeId);

      // Check if this is a browser-to-browser invitation requiring WebRTC coordination
      const inviterIsBrowser = inviterClient?.metadata?.nodeType === 'browser';
      const targetIsBrowser = targetClient?.metadata?.nodeType === 'browser';

      // Create pending invitation for ALL connection types (WebRTC and WebSocket)
      // This enables handleInvitationAccepted to coordinate connections properly
      const invitationId = `${inviterNodeId}_${targetPeerId}_${Date.now()}`;
      this.pendingInvitations.set(invitationId, {
        inviterNodeId: inviterNodeId,
        inviteeNodeId: targetPeerId,
        inviterWs: ws,
        inviteeWs: targetClient.ws,
        status: 'invitation_sent',
        timestamp: Date.now()
      });

      const coordinationType = (inviterIsBrowser && targetIsBrowser) ? 'WebRTC' : 'WebSocket';
      console.log(`📋 Created pending invitation tracking: ${invitationId} (${coordinationType})`);

      if (inviterIsBrowser && targetIsBrowser) {
        console.log(`🚀 Browser-to-browser invitation detected - will use WebRTC coordination`);
      } else {
        console.log(`🌐 Node.js connection detected - will use WebSocket metadata exchange`);
      }

      // Forward invitation to target peer
      targetClient.ws.send(JSON.stringify({
        type: 'invitation_received',
        fromPeer: inviterNodeId,
        invitationToken,
        websocketCoordination,
        message: 'You have been invited to join the DHT network'
      }));

      // Send success response to inviter
      ws.send(JSON.stringify({
        type: 'response',
        requestId: message.requestId,
        success: true,
        data: {
          message: 'Invitation sent successfully',
          targetPeer: targetPeerId
        }
      }));

      console.log(`✅ Invitation forwarded successfully from ${inviterNodeId?.substring(0, 8)}... to ${targetPeerId.substring(0, 8)}...`);

    } catch (error) {
      console.error('Error handling send_invitation:', error);

      // Send error response
      ws.send(JSON.stringify({
        type: 'response',
        requestId: message.requestId,
        success: false,
        error: error.message
      }));
    }
  }

  /**
   * Request genesis connection from bridge nodes (DEPRECATED - using direct invitation flow)
   */
  async requestGenesisConnectionFromBridge(nodeId, metadata) {
    console.log(`🌟 Requesting genesis connection for ${nodeId.substring(0, 8)}... from bridge nodes`);

    try {
      // Select first available bridge node
      const bridgeConnections = Array.from(this.bridgeConnections.values());
      if (bridgeConnections.length === 0) {
        throw new Error('No bridge nodes available for genesis connection');
      }

      const bridgeWs = bridgeConnections[0]; // Use first bridge node
      const requestId = Date.now().toString() + Math.random().toString(36).substr(2, 9);

      // Send genesis connection request to bridge
      const request = {
        type: 'connect_genesis_peer',
        nodeId,
        metadata: metadata || {},
        requestId
      };

      console.log(`📤 Sent genesis connection request to bridge for ${nodeId.substring(0, 8)}...`);
      bridgeWs.send(JSON.stringify(request));

      // Set timeout for genesis connection
      const timeout = setTimeout(() => {
        const pending = this.pendingGenesisRequests.get(nodeId);
        if (pending) {
          this.pendingGenesisRequests.delete(nodeId);

          // Send timeout response to client
          pending.ws.send(JSON.stringify({
            type: 'response',
            requestId: pending.clientMessage.requestId,
            success: false,
            error: 'Genesis connection timeout'
          }));

          console.warn(`⏰ Genesis connection timeout for ${nodeId.substring(0, 8)}`);
        }
      }, 30000); // 30 second timeout

      // Update pending request with timeout
      const pending = this.pendingGenesisRequests.get(nodeId);
      if (pending) {
        pending.timeout = timeout;
      }

    } catch (error) {
      console.error('Error requesting genesis connection from bridge:', error);

      // Send error response to client
      const pending = this.pendingGenesisRequests.get(nodeId);
      if (pending) {
        this.pendingGenesisRequests.delete(nodeId);

        pending.ws.send(JSON.stringify({
          type: 'response',
          requestId: pending.clientMessage.requestId,
          success: false,
          error: `Genesis connection failed: ${error.message}`
        }));
      }
    }
  }

  /**
   * Handle client registration (new peers or reconnecting peers)
   */
  async handleClientRegistration(ws, message) {
    const { nodeId, metadata, membershipToken } = message;

    if (!nodeId) {
      ws.close(1002, 'Missing nodeId');
      return;
    }

    // Check if this is a reconnecting peer (has membership token)
    if (membershipToken) {
      console.log(`🔄 Reconnecting peer detected: ${nodeId.substring(0, 8)}...`);
      await this.handleReconnectingPeer(ws, { nodeId, membershipToken, metadata });
    } else {
      console.log(`🆕 New peer registering: ${nodeId.substring(0, 8)}...`);
      await this.handleNewPeer(ws, { nodeId, metadata });
    }
  }

  /**
   * Handle new peer registration
   */
  async handleNewPeer(ws, { nodeId, metadata }) {
    // Check peer limit
    if (this.peers.size >= this.options.maxPeers) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Server at capacity'
      }));
      ws.close(1000, 'Server full');
      return;
    }

    // Store peer (genesis determination happens in get_peers_or_genesis)
    this.peers.set(nodeId, {
      ws,
      lastSeen: Date.now(),
      metadata: metadata || {},
      isGenesisPeer: false, // Will be updated during get_peers_or_genesis if needed
      type: 'new'
    });

    // Add/update client in connectedClients with metadata
    if (this.connectedClients.has(nodeId)) {
      // Client already exists - update metadata
      const client = this.connectedClients.get(nodeId);
      client.metadata = metadata || {};
      console.log(`📋 Updated metadata for connected client ${nodeId.substring(0, 8)}...:`, metadata);
    } else {
      // Client doesn't exist yet - add them with metadata
      this.connectedClients.set(nodeId, {
        ws,
        nodeId,
        metadata: metadata || {},
        timestamp: Date.now()
      });
      console.log(`📋 Added new client ${nodeId.substring(0, 8)}... to connected clients with metadata:`, metadata);
    }

    console.log(`📋 Registered new peer: ${nodeId.substring(0, 8)}...`);

    // Send registration confirmation (genesis handling moved to get_peers_or_genesis)
    ws.send(JSON.stringify({
      type: 'registered',
      nodeId,
      timestamp: Date.now()
    }));
  }

  /**
   * Connect genesis peer directly to bridge node (automatic first connection)
   * This removes genesis status and gives the first client a valid DHT token
   */
  async connectGenesisToBridge(ws, nodeId, metadata, clientMessage) {
    try {
      console.log(`🌟 Connecting genesis peer ${nodeId.substring(0, 8)} to bridge node...`);

      // Get ALL available bridge nodes for redundancy
      const bridgeNodes = this.getAllAvailableBridgeNodes();
      if (bridgeNodes.length === 0) {
        throw new Error('No bridge nodes available for genesis connection');
      }

      console.log(`🌉 Connecting genesis peer to ${bridgeNodes.length} bridge nodes for redundancy`);

      // Create connection promises for ALL bridge nodes
      const connectionPromises = [];

      for (let i = 0; i < bridgeNodes.length; i++) {
        const bridgeNode = bridgeNodes[i];
        const requestId = `genesis_${Date.now()}_${Math.random().toString(36).substr(2, 9)}_${i}`;

        // Create individual connection promise for this bridge node
        const connectionPromise = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            this.pendingGenesisRequests.delete(`${nodeId}_${i}`);
            reject(new Error(`Genesis-to-bridge connection timeout (bridge ${i})`));
          }, this.options.bridgeTimeout);

          this.pendingGenesisRequests.set(`${nodeId}_${i}`, {
            ws,
            nodeId,
            requestId,
            clientMessage,
            resolve,
            reject,
            timeout,
            isGenesis: true,
            bridgeIndex: i
          });

          console.log(`🔍 Stored pending genesis request for ${nodeId.substring(0, 8)} to bridge ${i}, requestId=${requestId}`);
        });

        connectionPromises.push(connectionPromise);

        // Send genesis connection request to this bridge node
        bridgeNode.send(JSON.stringify({
          type: 'connect_genesis_peer',
          nodeId,
          metadata,
          requestId,
          timestamp: Date.now()
        }));

        console.log(`📤 Sent genesis connection request to bridge ${i} for ${nodeId.substring(0, 8)}...`);
      }

      // Wait for at least one bridge connection to succeed (race condition)
      try {
        await Promise.race(connectionPromises);
        console.log(`✅ Genesis peer ${nodeId.substring(0, 8)} successfully connected to at least one bridge node`);
      } catch (error) {
        // If race fails, try waiting for any to succeed
        const results = await Promise.allSettled(connectionPromises);
        const successful = results.filter(r => r.status === 'fulfilled');
        if (successful.length === 0) {
          throw new Error('Failed to connect to any bridge nodes');
        }
        console.log(`✅ Genesis peer ${nodeId.substring(0, 8)} connected to ${successful.length}/${bridgeNodes.length} bridge nodes`);
      }

    } catch (error) {
      console.error(`❌ Failed to connect genesis to bridge:`, error);

      // Send error response to genesis peer
      ws.send(JSON.stringify({
        type: 'genesis_connection_failed',
        reason: error.message
      }));

      // Close connection
      ws.close(1000, 'Genesis connection failed');
      this.peers.delete(nodeId);
    }
  }

  /**
   * Get onboarding peer from bridge (random peer selection for scalability)
   * Connection-agnostic approach - reuses existing invitation system
   */
  async getOnboardingPeerFromBridge(ws, nodeId, metadata, clientMessage) {
    try {
      console.log(`🎲 Requesting random onboarding peer from bridge for ${nodeId.substring(0, 8)}...`);

      // Get available bridge node
      const bridgeNode = this.getAvailableBridgeNode();
      if (!bridgeNode) {
        throw new Error('No bridge nodes available for onboarding peer query');
      }

      const requestId = `onboarding_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Create promise for bridge response
      const queryPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pendingBridgeQueries.delete(requestId);
          reject(new Error('Onboarding peer query timeout'));
        }, this.options.bridgeTimeout);

        this.pendingBridgeQueries.set(requestId, {
          ws,
          nodeId,
          metadata,
          clientMessage,
          resolve,
          reject,
          timeout
        });
      });

      // Send query to bridge
      bridgeNode.send(JSON.stringify({
        type: 'get_onboarding_peer',
        newNodeId: nodeId,
        newNodeMetadata: metadata,
        requestId,
        timestamp: Date.now()
      }));

      console.log(`📤 Sent onboarding peer query to bridge for ${nodeId.substring(0, 8)}, requestId=${requestId}`);

      // Wait for bridge response
      await queryPromise;

    } catch (error) {
      console.error(`❌ Failed to get onboarding peer from bridge:`, error);
      throw error;
    }
  }

  /**
   * Handle onboarding peer result from bridge
   * Bridge found random peer and sent invitation via DHT
   */
  async handleOnboardingPeerResult(response) {
    const { requestId, success, result, error } = response;

    const pending = this.pendingBridgeQueries.get(requestId);
    if (!pending) {
      console.warn(`Received onboarding result for unknown request: ${requestId}`);
      return;
    }

    // Clear timeout and remove from pending
    clearTimeout(pending.timeout);
    this.pendingBridgeQueries.delete(requestId);

    if (success && result) {
      console.log(`✅ Bridge found onboarding peer ${result.helperPeerId.substring(0, 8)} for ${pending.nodeId.substring(0, 8)}`);
      console.log(`   Status: ${result.status}`);
      console.log(`   Bridge sent invitation to helper peer via DHT (connection-agnostic)`);

      // Update peer status
      const peer = this.peers.get(pending.nodeId);
      if (peer) {
        peer.hasDHTMembership = true;
      }

      // Send membership token to new peer
      // Helper peer will coordinate connection through existing invitation system
      pending.ws.send(JSON.stringify({
        type: 'response',
        requestId: pending.clientMessage.requestId,
        success: true,
        data: {
          peers: [], // No direct peers - helper will coordinate through bootstrap
          isGenesis: false,
          membershipToken: result.membershipToken,
          onboardingHelper: result.helperPeerId,
          status: 'helper_coordinating',
          message: 'Random DHT peer will help you join the network (invitation sent via DHT)'
        }
      }));

      pending.resolve();
    } else {
      console.warn(`❌ Bridge failed to find onboarding peer for ${pending.nodeId.substring(0, 8)}: ${error}`);

      // Send failure response
      pending.ws.send(JSON.stringify({
        type: 'response',
        requestId: pending.clientMessage.requestId,
        success: false,
        error: `Onboarding failed: ${error}`
      }));

      // Close connection
      pending.ws.close(1000, 'Onboarding failed');
      this.peers.delete(pending.nodeId);

      pending.reject(new Error(error));
    }
  }

  /**
   * Handle reconnecting peer
   */
  async handleReconnectingPeer(ws, { nodeId, membershipToken, metadata }) {
    // Get available bridge node
    const bridgeNode = this.getAvailableBridgeNode();
    if (!bridgeNode) {
      ws.send(JSON.stringify({
        type: 'reconnection_result',
        success: false,
        reason: 'No bridge nodes available'
      }));
      ws.close(1000, 'Service unavailable');
      return;
    }

    // Store reconnecting peer
    this.peers.set(nodeId, {
      ws,
      lastSeen: Date.now(),
      metadata: metadata || {},
      isGenesisPeer: false,
      type: 'reconnecting',
      membershipToken
    });

    // Generate unique request ID
    const requestId = `reconnect_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Store pending reconnection
    const reconnectionPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingReconnections.delete(requestId);
        reject(new Error('Bridge validation timeout'));
      }, this.options.bridgeTimeout);

      this.pendingReconnections.set(requestId, {
        ws,
        nodeId,
        resolve,
        reject,
        timeout
      });
    });

    // Send validation request to bridge
    bridgeNode.send(JSON.stringify({
      type: 'validate_reconnection',
      nodeId,
      membershipToken,
      requestId,
      timestamp: Date.now()
    }));

    console.log(`📤 Sent reconnection validation to bridge for ${nodeId.substring(0, 8)}...`);

    // Wait for bridge response
    try {
      await reconnectionPromise;
    } catch (error) {
      console.warn(`Bridge validation failed for ${nodeId.substring(0, 8)}: ${error.message}`);
      ws.send(JSON.stringify({
        type: 'reconnection_result',
        success: false,
        reason: error.message
      }));
      ws.close(1000, 'Validation failed');
      this.peers.delete(nodeId);
    }
  }

  /**
   * Get available bridge node
   */
  getAvailableBridgeNode() {
    for (const [, ws] of this.bridgeConnections) {
      if (ws.readyState === WebSocket.OPEN) {
        return ws;
      }
    }
    return null;
  }

  /**
   * Get ALL available bridge nodes for redundancy
   */
  getAllAvailableBridgeNodes() {
    const bridgeNodes = [];
    for (const [, ws] of this.bridgeConnections) {
      if (ws.readyState === WebSocket.OPEN) {
        bridgeNodes.push(ws);
      }
    }
    return bridgeNodes;
  }

  /**
   * Get metadata for all connected bridge nodes
   */
  async getAllBridgeNodeMetadata() {
    const bridgeMetadata = [];
    for (const [addr, ws] of this.bridgeConnections) {
      if (ws.readyState === WebSocket.OPEN && ws.bridgeNodeId) {
        // Extract port from address for bridge connection
        const port = addr.includes(':8083') ? '8083' : '8084';
        bridgeMetadata.push({
          nodeId: ws.bridgeNodeId,
          metadata: {
            nodeType: 'bridge',
            listeningAddress: `ws://localhost:${port}`,
            capabilities: ['websocket'],
            isBridgeNode: true,
            bridgeAuthToken: 'bridge_auth_' + (this.options.bridgeAuth || 'default-bridge-auth-key'),
            bridgeSignature: await this.generateBridgeAuthSignature(ws.bridgeNodeId),
            bridgeStartTime: Date.now()
          }
        });
      }
    }
    return bridgeMetadata;
  }

  /**
   * Generate authentication signature for bridge node
   */
  async generateBridgeAuthSignature(bridgeNodeId) {
    const authToken = 'bridge_auth_' + (this.options.bridgeAuth || 'default-bridge-auth-key');
    const message = `bridge_auth:${authToken}:${bridgeNodeId}:bootstrap_verified`;
    // Simple hash for now - TODO: implement proper cryptographic signature
    const { createHash } = await import('crypto');
    return createHash('sha256').update(message).digest('hex');
  }

  /**
   * Handle response from bridge node
   */
  handleBridgeResponse(bridgeAddr, response) {
    if (response.type === 'reconnection_result') {
      this.handleReconnectionResult(response);
    } else if (response.type === 'genesis_connection_result') {
      this.handleGenesisConnectionResult(response);
    } else if (response.type === 'onboarding_peer_result') {
      this.handleOnboardingPeerResult(response);
    } else if (response.type === 'bridge_invitation_accepted') {
      this.handleBridgeInvitationAccepted(response);
    } else if (response.type === 'bridge_invitation_failed') {
      this.handleBridgeInvitationFailed(response);
    } else {
      console.warn(`Unknown bridge response type: ${response.type}`);
    }
  }

  /**
   * Handle reconnection validation result from bridge
   */
  handleReconnectionResult(response) {
    const { nodeId, requestId, success, reason } = response;

    const pending = this.pendingReconnections.get(requestId);
    if (!pending) {
      console.warn(`Received result for unknown reconnection request: ${requestId}`);
      return;
    }

    // Clear timeout and remove from pending
    clearTimeout(pending.timeout);
    this.pendingReconnections.delete(requestId);

    if (success) {
      console.log(`✅ Bridge validated reconnection for ${nodeId.substring(0, 8)}`);

      // Send success response to client
      pending.ws.send(JSON.stringify({
        type: 'reconnection_result',
        success: true,
        reason: 'Reconnection validated',
        networkFingerprint: response.networkFingerprint,
        additionalData: response.additionalData
      }));

      // Send current peer list for reconnection
      this.sendPeerList(pending.ws, nodeId);

      pending.resolve();
    } else {
      console.warn(`❌ Bridge rejected reconnection for ${nodeId.substring(0, 8)}: ${reason}`);

      // Send failure response to client
      pending.ws.send(JSON.stringify({
        type: 'reconnection_result',
        success: false,
        reason
      }));

      // Close connection and remove peer
      pending.ws.close(1000, 'Reconnection denied');
      this.peers.delete(nodeId);

      pending.reject(new Error(reason));
    }
  }

  /**
   * Handle genesis connection result from bridge node
   */
  async handleGenesisConnectionResult(response) {
    const { nodeId, requestId, success, reason } = response;

    console.log(`🔍 Looking for pending genesis request: nodeId=${nodeId?.substring(0, 8)}, requestId=${requestId}`);
    console.log(`🔍 Pending genesis requests:`, Array.from(this.pendingGenesisRequests.keys()));

    // Find pending request by iterating through all entries since we need to match the correct one
    let pending = null;
    let pendingKey = null;

    for (const [key, pendingRequest] of this.pendingGenesisRequests.entries()) {
      if (pendingRequest.nodeId === nodeId && pendingRequest.requestId === requestId) {
        pending = pendingRequest;
        pendingKey = key;
        console.log(`🔍 Found matching pending request with key: ${key}`);
        break;
      }
    }

    if (!pending) {
      console.warn(`Received genesis result for unknown request: nodeId=${nodeId?.substring(0, 8)}, requestId=${requestId}`);
      return;
    }

    // Clear timeout and remove from pending
    clearTimeout(pending.timeout);
    this.pendingGenesisRequests.delete(pendingKey);

    if (success) {
      console.log(`✅ Genesis peer ${nodeId.substring(0, 8)} connected to bridge - genesis status removed`);

      // Update peer status - no longer genesis, now has valid DHT membership
      const peer = this.peers.get(nodeId);
      if (peer) {
        peer.isGenesisPeer = false; // Genesis status removed by bridge connection
        peer.hasDHTMembership = true;
      }

      // Send BootstrapClient-compatible response for get_peers_or_genesis request
      let bridgeMetadata;
      try {
        bridgeMetadata = await this.getAllBridgeNodeMetadata();
        console.log(`🔍 Generated bridge metadata for ${bridgeMetadata.length} bridge nodes`);
      } catch (error) {
        console.error(`❌ Failed to generate bridge metadata:`, error);
        bridgeMetadata = [];
      }

      const responseData = {
        type: 'response',
        requestId: pending.clientMessage.requestId,
        success: true,
        data: {
          peers: bridgeMetadata, // Include ALL bridge nodes
          isGenesis: true, // This peer was genesis until bridge connection
          membershipToken: response.membershipToken, // Bridge provides membership token
          bridgeNodeId: response.bridgeNodeId,
          bridgeConnectionInfo: {
            nodeId: response.bridgeNodeId,
            websocketAddress: 'ws://localhost:8083',
            nodeType: 'bridge',
            capabilities: ['websocket']
          },
          // Request to invite bridge node after genesis setup is complete
          bridgeInvitationRequest: {
            targetPeerId: response.bridgeNodeId,
            bridgeNodeInfo: {
              nodeId: response.bridgeNodeId,
              nodeType: 'bridge',
              listeningAddress: 'ws://localhost:8083',
              capabilities: ['websocket'],
              isBridgeNode: true
            }
          },
          message: 'Connected to bridge node - you now have DHT membership and should invite the bridge node'
        }
      };

      console.log(`📤 Sending genesis response to ${nodeId.substring(0, 8)} with ${bridgeMetadata.length} bridge nodes`);
      console.log(`🔍 WebSocket state: ${pending.ws.readyState} (1=OPEN)`);

      try {
        pending.ws.send(JSON.stringify(responseData));
        console.log(`✅ Genesis response sent successfully to ${nodeId.substring(0, 8)}`);
      } catch (error) {
        console.error(`❌ Failed to send genesis response to ${nodeId.substring(0, 8)}:`, error);
      }

      // Resolve the connection promise
      pending.resolve();
    } else {
      console.warn(`❌ Bridge rejected genesis connection for ${nodeId.substring(0, 8)}: ${reason}`);

      // Send BootstrapClient-compatible error response
      pending.ws.send(JSON.stringify({
        type: 'response',
        requestId: pending.clientMessage.requestId,
        success: false,
        error: reason
      }));

      // Close connection and remove peer
      pending.ws.close(1000, 'Genesis connection failed');
      this.peers.delete(nodeId);

      // Reject the connection promise
      pending.reject(new Error(reason));
    }
  }

  /**
   * Handle bridge invitation accepted response
   */
  handleBridgeInvitationAccepted(response) {
    const { bridgeNodeId, inviterNodeId, bridgeServerAddress, timestamp } = response;

    console.log(`✅ Bridge node ${bridgeNodeId?.substring(0, 8)}... accepted invitation from ${inviterNodeId?.substring(0, 8)}...`);
    console.log(`🔗 Bridge server address: ${bridgeServerAddress}`);

    // Update bridge node status if tracking
    const bridgeWs = this.getBridgeNodeByNodeId(bridgeNodeId);
    if (bridgeWs) {
      // Bridge node is now part of DHT network
      console.log(`🌉 Bridge node ${bridgeNodeId?.substring(0, 8)}... is now connected to DHT network`);
    }

    // Instruct genesis peer to connect to bridge node's WebSocket server
    const genesisPeer = this.peers.get(inviterNodeId);
    if (genesisPeer && genesisPeer.ws && genesisPeer.ws.readyState === 1 && bridgeServerAddress) {
      console.log(`🔗 Instructing genesis peer ${inviterNodeId?.substring(0, 8)}... to connect to bridge at ${bridgeServerAddress}`);

      genesisPeer.ws.send(JSON.stringify({
        type: 'connect_to_bridge',
        bridgeNodeId: bridgeNodeId,
        bridgeServerAddress: bridgeServerAddress,
        timestamp: Date.now()
      }));
    } else {
      console.warn(`⚠️ Could not find genesis peer ${inviterNodeId?.substring(0, 8)}... to send bridge connection instruction`);
    }

    // Optionally notify the inviter that bridge connection was successful
    const inviterPeer = this.peers.get(inviterNodeId);
    if (inviterPeer && inviterPeer.ws.readyState === WebSocket.OPEN) {
      inviterPeer.ws.send(JSON.stringify({
        type: 'bridge_connection_status',
        bridgeNodeId,
        status: 'connected',
        timestamp
      }));
    }
  }

  /**
   * Handle bridge invitation failed response
   */
  handleBridgeInvitationFailed(response) {
    const { bridgeNodeId, inviterNodeId, reason, timestamp } = response;

    console.warn(`❌ Bridge node ${bridgeNodeId?.substring(0, 8)}... failed to accept invitation from ${inviterNodeId?.substring(0, 8)}...: ${reason}`);

    // Optionally notify the inviter that bridge connection failed
    const inviterPeer = this.peers.get(inviterNodeId);
    if (inviterPeer && inviterPeer.ws.readyState === WebSocket.OPEN) {
      inviterPeer.ws.send(JSON.stringify({
        type: 'bridge_connection_status',
        bridgeNodeId,
        status: 'failed',
        reason,
        timestamp
      }));
    }
  }

  /**
   * Get bridge node WebSocket by node ID
   */
  getBridgeNodeByNodeId(nodeId) {
    for (const [, ws] of this.bridgeConnections) {
      if (ws.bridgeNodeId === nodeId) {
        return ws;
      }
    }
    return null;
  }

  /**
   * Send peer list to client for bootstrapping
   */
  sendPeerList(ws, requestingNodeId) {
    const peers = Array.from(this.peers.entries())
      .filter(([nodeId, peer]) => {
        return nodeId !== requestingNodeId &&
               peer.ws.readyState === WebSocket.OPEN &&
               (Date.now() - peer.lastSeen) < this.options.peerTimeout;
      })
      .map(([nodeId, peer]) => ({
        nodeId,
        metadata: peer.metadata,
        lastSeen: peer.lastSeen
      }));

    ws.send(JSON.stringify({
      type: 'peers',
      peers,
      count: peers.length,
      timestamp: Date.now()
    }));

    console.log(`📋 Sent peer list (${peers.length} peers) to ${requestingNodeId.substring(0, 8)}...`);
  }

  /**
   * Handle WebRTC signaling between peers
   */
  handleSignaling(ws, message) {
    const { fromPeer, toPeer, signal } = message;

    const targetPeer = this.peers.get(toPeer);
    if (!targetPeer || targetPeer.ws.readyState !== WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'signal_error',
        message: 'Target peer not available'
      }));
      return;
    }

    // Forward signal to target peer
    targetPeer.ws.send(JSON.stringify({
      type: 'signal',
      fromPeer,
      signal,
      timestamp: Date.now()
    }));

    console.log(`📡 Forwarded signal: ${fromPeer.substring(0, 8)} → ${toPeer.substring(0, 8)}`);
  }

  /**
   * Handle join peer request
   */
  handleJoinPeer(ws, message) {
    const { fromPeer, targetPeer } = message;

    const target = this.peers.get(targetPeer);
    if (!target || target.ws.readyState !== WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'join_error',
        message: 'Target peer not available'
      }));
      return;
    }

    // Notify target peer of join request
    target.ws.send(JSON.stringify({
      type: 'peer_join_request',
      fromPeer,
      timestamp: Date.now()
    }));

    console.log(`🤝 Join request: ${fromPeer.substring(0, 8)} → ${targetPeer.substring(0, 8)}`);
  }

  /**
   * Handle WebRTC signal forwarding between peers
   */
  handleForwardSignal(ws, message) {
    const { fromPeer, toPeer, signal } = message;

    if (!fromPeer || !toPeer || !signal) {
      console.warn('Invalid forward_signal message - missing required fields');
      ws.send(JSON.stringify({
        type: 'error',
        error: 'Invalid signal forwarding request'
      }));
      return;
    }

    const targetPeer = this.peers.get(toPeer);
    if (!targetPeer || targetPeer.ws.readyState !== WebSocket.OPEN) {
      console.warn(`Cannot forward signal - target peer ${toPeer.substring(0, 8)} not available`);
      ws.send(JSON.stringify({
        type: 'error',
        error: 'Target peer not available'
      }));
      return;
    }

    // Forward the signal to the target peer
    targetPeer.ws.send(JSON.stringify({
      type: 'signal',
      fromPeer,
      toPeer,
      signal
    }));

    console.log(`📡 WebRTC signal forwarded: ${fromPeer.substring(0, 8)} → ${toPeer.substring(0, 8)} (${signal.type || 'unknown'})`);

    // Send success response back to requesting client
    if (message.requestId) {
      ws.send(JSON.stringify({
        type: 'response',
        requestId: message.requestId,
        success: true
      }));
    }
  }

  /**
   * Handle client disconnection
   */
  handleClientDisconnection(ws) {
    // Find and remove the peer
    for (const [nodeId, peer] of this.peers) {
      if (peer.ws === ws) {
        console.log(`🔌 Peer disconnected: ${nodeId.substring(0, 8)}...`);
        this.peers.delete(nodeId);
        break;
      }
    }
  }

  /**
   * Start maintenance tasks
   */
  startMaintenanceTasks() {
    // Clean up stale peers every minute
    setInterval(() => {
      this.cleanupStalePeers();
    }, 60000);

    // Log status every 5 minutes
    setInterval(() => {
      this.logStatus();
    }, 5 * 60000);
  }

  /**
   * Clean up stale peer connections
   */
  cleanupStalePeers() {
    const now = Date.now();
    const stalePeers = [];

    for (const [nodeId, peer] of this.peers) {
      if (peer.ws.readyState !== WebSocket.OPEN ||
          (now - peer.lastSeen) > this.options.peerTimeout) {
        stalePeers.push(nodeId);
      }
    }

    for (const nodeId of stalePeers) {
      const peer = this.peers.get(nodeId);
      if (peer && peer.ws.readyState === WebSocket.OPEN) {
        peer.ws.close(1000, 'Peer timeout');
      }
      this.peers.delete(nodeId);
    }

    if (stalePeers.length > 0) {
      console.log(`🧹 Cleaned up ${stalePeers.length} stale peers`);
    }
  }

  /**
   * Log server status
   */
  logStatus() {
    const bridgeCount = Array.from(this.bridgeConnections.values())
      .filter(ws => ws.readyState === WebSocket.OPEN).length;

    const peerTypes = {
      new: 0,
      reconnecting: 0,
      genesis: 0
    };

    for (const peer of this.peers.values()) {
      if (peer.isGenesisPeer) peerTypes.genesis++;
      else if (peer.type === 'reconnecting') peerTypes.reconnecting++;
      else peerTypes.new++;
    }

    console.log(`📊 Server Status - Peers: ${this.peers.size}/${this.options.maxPeers} | Bridge: ${bridgeCount}/${this.options.bridgeNodes.length} | New: ${peerTypes.new} | Reconnecting: ${peerTypes.reconnecting} | Genesis: ${peerTypes.genesis}`);
  }

  /**
   * Ask genesis peer to invite all available bridge nodes
   */
  async askGenesisToInviteBridgeNodes(genesisNodeId) {
    console.log(`🌉 Asking genesis peer ${genesisNodeId.substring(0, 8)}... to invite bridge nodes`);

    // Get all connected bridge nodes with their actual IDs
    const bridgeNodeIds = [];
    for (const [, ws] of this.bridgeConnections) {
      if (ws.readyState === WebSocket.OPEN && ws.bridgeNodeId) {
        bridgeNodeIds.push(ws.bridgeNodeId);
        console.log(`🔍 Found connected bridge node: ${ws.bridgeNodeId.substring(0, 8)}...`);
      }
    }

    if (bridgeNodeIds.length === 0) {
      console.warn(`⚠️ No bridge node IDs available - bridges may not be authenticated yet`);
      return;
    }

    // Ask genesis to invite each bridge node
    for (const bridgeNodeId of bridgeNodeIds) { // Invite ALL bridge nodes for redundancy
      await this.askGenesisToInviteBridge(genesisNodeId, bridgeNodeId);
    }
  }

  /**
   * Ask genesis peer to invite bridge node (correct invitation flow)
   */
  async askGenesisToInviteBridge(genesisNodeId, bridgeNodeId) {
    try {
      console.log(`🎫 Asking genesis peer ${genesisNodeId.substring(0, 8)}... to invite bridge node ${bridgeNodeId.substring(0, 8)}...`);

      // Find the genesis peer connection
      const genesisClient = this.connectedClients.get(genesisNodeId);
      if (!genesisClient) {
        console.warn(`⚠️ Genesis peer ${genesisNodeId.substring(0, 8)}... not found for bridge invitation request`);
        return;
      }

      // Send bridge node information to genesis peer with invitation request
      genesisClient.ws.send(JSON.stringify({
        type: 'bridge_invitation_request',
        targetPeerId: bridgeNodeId,
        bridgeNodeInfo: {
          nodeId: bridgeNodeId,
          nodeType: 'bridge',
          listeningAddress: 'ws://localhost:8083',
          capabilities: ['websocket'],
          isBridgeNode: true
        },
        message: 'Please invite this bridge node to join the DHT network'
      }));

      console.log(`✅ Bridge invitation request sent to genesis peer ${genesisNodeId.substring(0, 8)}...`);

    } catch (error) {
      console.error('Error asking genesis to invite bridge:', error);
    }
  }

  /**
   * Get server statistics
   */
  getStats() {
    const bridgeStats = Array.from(this.bridgeConnections.entries()).map(([addr, ws]) => ({
      address: addr,
      connected: ws.readyState === WebSocket.OPEN,
      readyState: ws.readyState
    }));

    return {
      isStarted: this.isStarted,
      totalPeers: this.peers.size,
      maxPeers: this.options.maxPeers,
      totalConnections: this.totalConnections,
      bridgeNodes: bridgeStats,
      createNewDHT: this.options.createNewDHT,
      pendingReconnections: this.pendingReconnections.size
    };
  }

  /**
   * Handle invitation acceptance for WebRTC coordination
   */
  handleInvitationAccepted(ws, message) {
    const { fromPeer, toPeer } = message;

    // Find the accepting peer's node ID from the WebSocket connection
    let acceptingNodeId = null;
    for (const [nodeId, client] of this.connectedClients.entries()) {
      if (client.ws === ws) {
        acceptingNodeId = nodeId;
        break;
      }
    }

    if (!acceptingNodeId) {
      console.warn(`⚠️ Invitation acceptance from unregistered peer: ${fromPeer?.substring(0, 8)}...`);
      return;
    }

    if (acceptingNodeId !== fromPeer) {
      console.warn(`⚠️ Invitation acceptance from wrong peer - expected ${fromPeer?.substring(0, 8)}..., got ${acceptingNodeId?.substring(0, 8)}...`);
      return;
    }

    console.log(`📨 Invitation acceptance received from ${fromPeer?.substring(0, 8)}... for invitation to ${toPeer?.substring(0, 8)}...`);

    // Find the pending invitation
    let matchingInvitation = null;
    let invitationId = null;

    for (const [id, invitation] of this.pendingInvitations.entries()) {
      if (invitation.inviterNodeId === toPeer && invitation.inviteeNodeId === fromPeer) {
        matchingInvitation = invitation;
        invitationId = id;
        break;
      }
    }

    if (!matchingInvitation) {
      console.warn(`⚠️ No pending invitation found for ${toPeer?.substring(0, 8)}... → ${fromPeer?.substring(0, 8)}...`);
      return;
    }

    console.log(`🤝 Found matching invitation: ${invitationId} - initiating connection coordination`);

    // Update invitation status
    matchingInvitation.status = 'invitation_accepted';
    matchingInvitation.acceptedAt = Date.now();

    // Get both peer connections
    const inviterClient = this.connectedClients.get(matchingInvitation.inviterNodeId);
    const inviteeClient = this.connectedClients.get(matchingInvitation.inviteeNodeId);

    if (!inviterClient || !inviteeClient ||
        inviterClient.ws.readyState !== 1 || inviteeClient.ws.readyState !== 1) {
      console.error(`❌ Cannot coordinate connection - one or both peers are offline`);
      this.pendingInvitations.delete(invitationId);
      return;
    }

    // Determine connection type based on node types
    const inviterNodeType = inviterClient.metadata?.nodeType || 'browser';
    const inviteeNodeType = inviteeClient.metadata?.nodeType || 'browser';

    console.log(`🔍 Connection coordination: ${inviterNodeType} → ${inviteeNodeType}`);

    if (inviterNodeType === 'browser' && inviteeNodeType === 'browser') {
      // Browser-to-browser: Use WebRTC coordination
      console.log(`🚀 Using WebRTC coordination for browser-to-browser connection`);

      inviterClient.ws.send(JSON.stringify({
        type: 'webrtc_start_offer',
        targetPeer: matchingInvitation.inviteeNodeId,
        invitationId: invitationId,
        message: 'Send WebRTC offer to establish connection with invited peer'
      }));

      inviteeClient.ws.send(JSON.stringify({
        type: 'webrtc_expect_offer',
        fromPeer: matchingInvitation.inviterNodeId,
        invitationId: invitationId,
        message: 'Expect WebRTC offer from inviting peer'
      }));

    } else {
      // Node.js involved: Send metadata for WebSocket connection
      console.log(`🌐 Using WebSocket coordination for Node.js connection`);

      // Debug: Log metadata being sent
      console.log(`🔍 Invitee metadata being sent:`, JSON.stringify(inviteeClient.metadata, null, 2));
      console.log(`🔍 Inviter metadata being sent:`, JSON.stringify(inviterClient.metadata, null, 2));

      // Send invitee's metadata to inviter so inviter can connect via WebSocket
      inviterClient.ws.send(JSON.stringify({
        type: 'websocket_peer_metadata',
        targetPeer: matchingInvitation.inviteeNodeId,
        targetPeerMetadata: inviteeClient.metadata,
        invitationId: invitationId,
        message: 'Connect to invited peer using WebSocket (metadata provided)'
      }));

      // Send inviter's metadata to invitee (for bidirectional awareness)
      inviteeClient.ws.send(JSON.stringify({
        type: 'websocket_peer_metadata',
        fromPeer: matchingInvitation.inviterNodeId,
        fromPeerMetadata: inviterClient.metadata,
        invitationId: invitationId,
        message: 'Inviter peer metadata (connection will be initiated by inviter)'
      }));
    }

    console.log(`🚀 Connection coordination initiated between ${matchingInvitation.inviterNodeId.substring(0,8)}... and ${matchingInvitation.inviteeNodeId.substring(0,8)}...`);

    // Clean up the pending invitation after a delay
    setTimeout(() => {
      this.pendingInvitations.delete(invitationId);
      console.log(`🧹 Cleaned up pending invitation: ${invitationId}`);
    }, 60000); // 1 minute cleanup delay
  }

  /**
   * Handle announce_independent message from client
   * Client is announcing they no longer need bootstrap server for DHT operations
   */
  handleAnnounceIndependent(ws, message) {
    const { nodeId } = message;
    console.log(`🔓 Node ${nodeId.substring(0, 8)}... announced independence from bootstrap server`);

    // Optional: Could track this state if needed for monitoring
    // For now, just acknowledge the message silently (no warning)
  }
}