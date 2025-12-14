import { ConnectionManager } from './ConnectionManager.js';
import { ConnectionManagerFactory } from './ConnectionManagerFactory.js';

/**
 * WebSocket-based connection manager for Node.js peers
 * Extends ConnectionManager with WebSocket transport implementation
 *
 * ARCHITECTURE NOTE: Node type detection is performed by ConnectionManagerFactory.
 * This class receives localNodeType and targetNodeType via options and uses them
 * to determine connection behavior without re-detecting the environment.
 */
export class WebSocketConnectionManager extends ConnectionManager {
  constructor(options = {}) {
    super(options);

    // Store node types from factory (if provided)
    // These come from ConnectionManagerFactory.createForConnection()
    this.localNodeType = options.localNodeType || null;
    this.targetNodeType = options.targetNodeType || null;

    // Store routing table reference for event notifications (Node.js servers only)
    this.routingTable = options.routingTable || null;

    // Initialize WebSocket class for this environment
    this.WebSocket = null;
    this.WebSocketServer = null;
    this.webSocketInitialized = false;

    // Determine if we should enable server based on local node type
    // Only Node.js nodes can create WebSocket servers
    const shouldEnableServer = this.localNodeType === 'nodejs' && (options.enableServer !== false);

    this.wsOptions = {
      port: options.port || 8083,
      host: options.host || 'localhost',
      enableServer: shouldEnableServer,
      ...options
    };

    // WebSocket-specific state (REFACTORED: Single connection per manager)
    this.server = null; // WebSocket server for incoming connections
    this.connectionTimeouts = new Map(); // Keep Map for timeout management
    this.reconnectAttempts = new Map(); // Keep Map for reconnect tracking
    this.maxReconnectAttempts = 3;

    // Ping/latency tracking for WebSocket connections
    this.pingInterval = options.pingInterval || 30000; // 30 seconds
    this.pingTimeout = options.pingTimeout || 10000; // 10 seconds
    this.pingIntervalId = null;
    this.pendingPings = new Map(); // pingId -> { timestamp, timeoutId }
    this.lastPingTime = null;
    this.currentRTT = null; // Current round-trip time in milliseconds

    // NOTE: Metadata now passed directly in peerConnected events to RoutingTable
    // No intermediate storage needed - clean architecture!

    // Initialize WebSocket classes (synchronous for browser, async for Node.js)
    if (this.localNodeType === 'browser') {
      // Browser environment - use native WebSocket (synchronous)
      this.WebSocket = window.WebSocket;
      this.WebSocketServer = null; // Browsers cannot create servers
      this.webSocketInitialized = true;
      console.log('🌐 Initialized browser WebSocket support (synchronous)');
    } else {
      // Node.js environment - initialize asynchronously
      this.initializeWebSocketClasses().then(() => {
        if (this.wsOptions.enableServer) {
          this.startServer();
        }
      }).catch(error => {
        console.error('Failed to initialize WebSocket classes:', error);
      });
    }
  }

  /**
   * Initialize WebSocket classes for Node.js environment
   * Browser environment initialization is done synchronously in constructor
   */
  async initializeWebSocketClasses() {
    if (!this.localNodeType) {
      throw new Error('WebSocketConnectionManager requires localNodeType to be set by factory');
    }

    if (this.localNodeType === 'browser') {
      // Already initialized synchronously in constructor
      return;
    }

    console.log(`🔍 Initializing WebSocket classes for ${this.localNodeType} environment`);

    if (this.localNodeType === 'nodejs') {
      // Node.js environment - use ws library
      try {
        const ws = await import('ws');
        console.log(`🔍 Imported ws library:`, { hasDefault: !!ws.default, hasServer: !!ws.default?.Server, hasWebSocketServer: !!ws.WebSocketServer });
        this.WebSocket = ws.default;
        this.WebSocketServer = ws.WebSocketServer || ws.default.Server;
        this.webSocketInitialized = true;
        console.log('🌐 Initialized Node.js WebSocket support');
        console.log(`🔍 Final state: WebSocket=${!!this.WebSocket}, WebSocketServer=${!!this.WebSocketServer}`);
      } catch (error) {
        console.error('Failed to load ws library:', error);
        throw new Error('WebSocket library not available in Node.js environment');
      }
    }
  }

  /**
   * Wait for WebSocket initialization to complete
   */
  async waitForWebSocketInitialization(maxWait = 5000) {
    const startTime = Date.now();

    while (!this.webSocketInitialized && (Date.now() - startTime) < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    if (!this.webSocketInitialized) {
      throw new Error('WebSocket initialization timeout');
    }
  }

  /**
   * Start WebSocket server for incoming connections
   */
  startServer() {
    if (this.server) {
      console.warn('WebSocket server already running');
      return;
    }

    console.log(`🔍 Server start check: webSocketInitialized=${this.webSocketInitialized}, WebSocketServer=${!!this.WebSocketServer}`);

    if (!this.webSocketInitialized || !this.WebSocketServer) {
      console.error('WebSocket classes not initialized yet');
      console.error(`   webSocketInitialized: ${this.webSocketInitialized}`);
      console.error(`   WebSocketServer: ${this.WebSocketServer}`);
      console.error(`   WebSocket: ${this.WebSocket}`);
      return;
    }

    try {
      // Explicitly use IPv4 to avoid dual-stack binding issues
      const host = this.wsOptions.host === 'localhost' ? '127.0.0.1' : this.wsOptions.host;
      this.server = new this.WebSocketServer({
        port: this.wsOptions.port,
        host: host
      });

      this.server.on('connection', (ws, request) => {
        this.handleIncomingConnection(ws, request);
      });

      this.server.on('error', (error) => {
        console.error('WebSocket server error:', error);
        this.emit('error', error);
      });

      // CRITICAL: Wait for 'listening' event before emitting serverStarted
      // This ensures server.address() returns the actual assigned port (important for port: 0)
      this.server.on('listening', () => {
        const actualAddress = this.server.address();
        const actualPort = actualAddress?.port || this.wsOptions.port;
        console.log(`🌐 WebSocket server listening on ${host}:${actualPort}`);
        this.emit('serverStarted', {
          host: host,
          port: actualPort
        });
      });

    } catch (error) {
      console.error('Failed to start WebSocket server:', error);
      throw error;
    }
  }

  /**
   * Handle incoming WebSocket connection
   */
  handleIncomingConnection(ws, request) {
    console.log(`🔗 Incoming WebSocket connection from ${request.socket.remoteAddress}`);

    // Wait for handshake to identify the peer
    const handshakeTimeout = setTimeout(() => {
      console.warn('⏰ WebSocket handshake timeout');
      ws.close(1000, 'Handshake timeout');
    }, 10000);

    const messageHandler = async (data) => {
      try {
        // Handle both Buffer and string data
        const dataString = typeof data === 'string' ? data : data.toString();
        console.log(`🔍 Received handshake data (type: ${typeof data}): ${dataString}`);
        const message = JSON.parse(dataString);

        if (message.type === 'bootstrap_auth') {
          // Bootstrap server connecting - use a special peer ID for bootstrap
          clearTimeout(handshakeTimeout);
          ws.off('message', messageHandler);

          const bootstrapPeerId = 'bootstrap_' + Date.now();
          console.log(`🔗 Bootstrap server connected: ${bootstrapPeerId}`);

          // CRITICAL FIX: Create NEW manager for bootstrap connection (single-connection architecture)
          console.log(`🏭 Creating dedicated connection manager for bootstrap ${bootstrapPeerId.substring(0, 16)}...`);
          const bootstrapManager = new WebSocketConnectionManager({
            localNodeType: this.localNodeType,  // Use server manager's node type
            targetNodeType: 'nodejs',  // Bootstrap servers are always nodejs
            enableServer: false  // Not a server - just handles this one connection
          });

          // Initialize the new manager with our node ID
          bootstrapManager.initialize(this.localNodeId);

          // Set up the connection on the NEW manager (await for async initialization)
          await bootstrapManager.setupConnection(bootstrapPeerId, ws, false);

          // Emit peerConnected with the NEW manager and metadata
          console.log(`📤 Emitting peerConnected event with dedicated manager for bootstrap`);
          this.emit('peerConnected', {
            peerId: bootstrapPeerId,
            connection: ws,
            manager: bootstrapManager,
            initiator: false,
            metadata: null  // Bootstrap connections don't have peer metadata
          });

          // Forward the bootstrap_auth message to the dedicated manager after setup
          // This allows PassiveBridgeNode to handle authentication and add bootstrap to authorized list
          setTimeout(() => {
            console.log(`📤 Forwarding bootstrap_auth message to dedicated manager for processing`);
            bootstrapManager.handleMessage(bootstrapPeerId, message);
          }, 10);

        } else if (message.type === 'dht_peer_hello' && message.peerId) {
          // DHT peer connecting
          clearTimeout(handshakeTimeout);
          ws.off('message', messageHandler);

          const peerId = message.peerId;
          console.log(`✅ DHT peer connected: ${peerId.substring(0, 8)}...`);

          // Extract peer metadata from handshake (will be passed to RoutingTable)
          const peerMetadata = message.metadata || null;
          if (peerMetadata) {
            console.log(`📋 Received peer metadata from ${peerId.substring(0, 8)}:`, peerMetadata);
          }

          // Get this node's metadata (especially isBridgeNode flag and listeningAddress)
          const myMetadata = ConnectionManagerFactory.getPeerMetadata(this.localNodeId);

          // Send confirmation with our metadata
          ws.send(JSON.stringify({
            type: 'dht_peer_connected',
            bridgeNodeId: this.localNodeId,
            success: true,
            timestamp: Date.now(),
            metadata: myMetadata  // Include our node metadata
          }));

          // CRITICAL FIX: Create NEW manager for this peer (single-connection architecture)
          // Server manager is just a listener/factory - each peer gets dedicated manager
          console.log(`🏭 Creating dedicated connection manager for incoming peer ${peerId.substring(0, 8)}...`);
          const peerManager = new WebSocketConnectionManager({
            localNodeType: this.localNodeType,  // Use server manager's node type
            targetNodeType: peerMetadata?.nodeType || 'nodejs',
            enableServer: false  // Not a server - just handles this one connection
          });

          // Initialize the new manager with our node ID
          peerManager.initialize(this.localNodeId);

          // CRITICAL: Wait for WebSocket classes to initialize before setup
          // The constructor starts async initialization but doesn't await it
          if (this.localNodeType === 'nodejs' && !peerManager.webSocketInitialized) {
            console.log(`⏳ Waiting for WebSocket initialization for dedicated manager...`);
            await peerManager.waitForWebSocketInitialization();
            console.log(`✅ WebSocket initialized for dedicated manager`);
          }

          // CRITICAL FIX: Notify routing table BEFORE setupConnection to ensure handlers are attached
          // This prevents race condition where messages arrive before DHT message handlers are ready
          if (this.routingTable) {
            console.log(`📤 Pre-registering connection with RoutingTable for ${peerId.substring(0, 8)}...`);
            this.routingTable.handlePeerConnected(peerId, ws, peerManager, false, peerMetadata);
            console.log(`✅ Routing table handlers configured for ${peerId.substring(0, 8)}`);
          } else {
            console.warn(`⚠️ No routing table reference - cannot handle connection from ${peerId.substring(0, 8)}`);
          }

          // Set up the connection on the NEW manager (await for async initialization)
          // By this point, DHT message handlers should be attached via routing table flow
          await peerManager.setupConnection(peerId, ws, false); // false = not initiator

        } else {
          console.warn('Invalid handshake message:', message.type);
          ws.close(1000, 'Invalid handshake');
        }

      } catch (error) {
        console.error('Error parsing handshake message:', error);
        ws.close(1000, 'Invalid handshake format');
      }
    };

    ws.on('message', messageHandler);
    ws.on('close', () => clearTimeout(handshakeTimeout));
  }

  // ===========================================
  // TRANSPORT IMPLEMENTATION (WebSocket)
  // ===========================================

  /**
   * Handle invitation from peer - WebSocket-specific logic
   * Browsers can only be WebSocket clients, not servers
   * @param {string} peerId - Inviter peer ID
   * @param {Object} peerMetadata - Inviter's connection metadata
   * @returns {Promise<void>}
   */
  async handleInvitation(peerId, peerMetadata) {
    // Determine if we need to initiate connection based on capabilities
    const localIsServer = this.serverMode === 'server';
    const localIsBrowser = this.localNodeType === 'browser';
    const peerIsBrowser = peerMetadata.nodeType === 'browser';
    const peerIsNodejs = peerMetadata.nodeType === 'nodejs' || peerMetadata.nodeType === 'nodejs-active';

    // DEBUG: Log values to understand connection decision
    console.log(`🔍 handleInvitation DEBUG:`);
    console.log(`   localNodeType: ${this.localNodeType}, localIsBrowser: ${localIsBrowser}`);
    console.log(`   peer nodeType: ${peerMetadata.nodeType}, peerIsNodejs: ${peerIsNodejs}, peerIsBrowser: ${peerIsBrowser}`);

    // CRITICAL: Browsers can't be WebSocket servers!
    // Only browsers can initiate connections to Node.js servers
    if (localIsBrowser && peerIsNodejs) {
      // Browser → Node.js: Browser must initiate
      const connectAddress = peerMetadata.publicWssAddress || peerMetadata.listeningAddress;
      console.log(`🔗 Browser initiating WebSocket connection to nodejs at ${connectAddress}`);

      try {
        await this.createConnection(peerId, true, peerMetadata);
        console.log(`✅ Browser successfully connected to inviter ${peerId.substring(0, 8)}...`);
      } catch (error) {
        console.error(`❌ Browser failed to connect to inviter: ${error.message}`);
        throw error;
      }
    } else if (!localIsBrowser && peerIsBrowser) {
      // Node.js → Browser: Node.js CANNOT initiate (browsers can't accept incoming connections)
      // Wait for browser to connect to our WebSocket server
      console.log(`⏳ Peer is browser - waiting for browser to connect to our WebSocket server`);
      console.log(`   Node.js cannot initiate connections to browsers (browsers can only be clients)`);
    } else if (!localIsBrowser && peerIsNodejs) {
      // Node.js → Node.js: Can initiate connection
      const connectAddress = peerMetadata.listeningAddress;
      console.log(`🔗 Node.js initiating WebSocket connection to another Node.js at ${connectAddress}`);

      try {
        await this.createConnection(peerId, true, peerMetadata);
        console.log(`✅ Successfully connected to Node.js peer ${peerId.substring(0, 8)}...`);
      } catch (error) {
        console.error(`❌ Failed to connect to Node.js peer: ${error.message}`);
        throw error;
      }
    } else {
      // Default: wait for peer to connect to us
      console.log(`⏳ Waiting for WebSocket connection from ${peerId.substring(0, 8)}...`);
    }
  }

  /**
   * Create WebSocket connection to peer
   * @param {string} peerId - Target peer ID
   * @param {boolean} initiator - Whether we're initiating the connection
   * @param {Object} metadata - Peer metadata (nodeType, listeningAddress, etc.)
   */
  async createConnection(peerId, initiator = true, metadata = null) {
    if (this.isDestroyed) {
      throw new Error('WebSocketConnectionManager is destroyed');
    }

    // Store peerId for this manager
    if (!this.peerId) {
      this.peerId = peerId;
    } else if (this.peerId !== peerId) {
      throw new Error(`Manager is for ${this.peerId}, cannot create connection to ${peerId}`);
    }

    // Check if we already have a connection
    if (this.connection) {
      throw new Error(`Manager already has connection to ${this.peerId}`);
    }

    // Perfect Negotiation Pattern for WebSocket (similar to WebRTC)
    // When both peers try to connect simultaneously (glare condition), use node ID comparison
    // CRITICAL: Use passed metadata parameter first, fallback to global metadata for backwards compatibility
    const peerMetadata = metadata || ConnectionManagerFactory.getPeerMetadata(peerId);
    const existingConnection = this.connection;
    if (existingConnection) {
      // Glare condition detected - both peers trying to connect
      const localNodeId = this.localNodeId || '';
      const isPolite = localNodeId.localeCompare(peerId) < 0;

      console.log(`🤝 WebSocket glare detected with ${peerId.substring(0, 8)}... - we are ${isPolite ? 'POLITE' : 'IMPOLITE'} peer (${localNodeId.substring(0, 8)}... vs ${peerId.substring(0, 8)}...)`);

      if (isPolite) {
        // Polite peer: close our outgoing attempt and wait for incoming connection
        console.log(`🤝 Polite peer ${localNodeId.substring(0, 8)}... closing outgoing connection to accept incoming from ${peerId.substring(0, 8)}...`);

        // Close existing connection
        if (existingConnection.close) {
          existingConnection.close(1000, 'Perfect Negotiation - polite peer yielding');
        }
        this.connection = null;
        this.connectionState = 'disconnected';

        // Wait a moment for the other side's connection to arrive
        await new Promise(resolve => setTimeout(resolve, 500));

        // Check if incoming connection was established
        if (this.connection) {
          console.log(`✅ Polite peer accepted incoming connection from ${peerId.substring(0, 8)}...`);
          return this.connection;
        }
        // If no incoming connection, continue with our outgoing attempt below
        console.log(`⚠️ No incoming connection received, continuing with outgoing attempt`);
      } else {
        // Impolite peer: ignore this attempt and keep our existing connection
        console.log(`🤝 Impolite peer ${localNodeId.substring(0, 8)}... ignoring new outgoing attempt, keeping existing connection`);
        return existingConnection;
      }
    }

    // Wait for WebSocket initialization
    if (!this.webSocketInitialized) {
      console.log('⏳ Waiting for WebSocket initialization...');
      await this.waitForWebSocketInitialization();
    }

    // Determine node types for connection handling
    const localNodeType = this.localNodeType;
    const targetNodeType = peerMetadata?.nodeType;
    const finalTargetNodeType = targetNodeType || this.targetNodeType || 'browser';

    // Select WebSocket address based on local node type
    // Browser clients MUST use public WSS (can't use ws:// from https://, can't reach internal Docker)
    // Node.js clients prefer internal (faster), fallback to public (for community nodes)
    let wsAddress;
    if (localNodeType === 'browser') {
      // Browser → Node.js: Must use external WSS address
      wsAddress = peerMetadata?.publicWssAddress || peerMetadata?.listeningAddress;
    } else {
      // Node.js → Node.js: Prefer internal, fallback to external
      // Server nodes will connect via internal, community nodes via external
      wsAddress = peerMetadata?.listeningAddress || peerMetadata?.publicWssAddress;
    }

    console.log(`🔗 WebSocket connection: ${localNodeType} → ${finalTargetNodeType}`);
    if (peerMetadata?.publicWssAddress && peerMetadata?.listeningAddress !== peerMetadata?.publicWssAddress) {
      console.log(`📍 Address selected: ${wsAddress} (internal: ${peerMetadata?.listeningAddress}, public: ${peerMetadata?.publicWssAddress})`);
    }

    // Handle different connection scenarios
    if (!wsAddress) {
      if (localNodeType === 'nodejs' && (targetNodeType === 'browser' || !targetNodeType)) {
        // Node.js → Browser OR Node.js → Unknown: Use DHT reverse signaling
        // Browser cannot create WebSocket server, so Node.js asks browser to connect back
        // For unknown peers, use reverse signaling as fallback - peer will connect if they can
        console.log(`🔄 ${localNodeType}→${targetNodeType||'unknown'} connection - requesting peer to connect back via DHT signaling`);
        return this.requestBrowserConnection(peerId, initiator);
      } else {
        throw new Error(`No WebSocket address for peer ${peerId} (${localNodeType}→${targetNodeType})`);
      }
    }

    console.log(`🌐 Creating WebSocket connection to ${peerId.substring(0, 8)}... at ${wsAddress}`);

    return new Promise((resolve, reject) => {
      try {
        const ws = new this.WebSocket(wsAddress);
        const connectionTimeout = setTimeout(() => {
          ws.close();
          reject(new Error('WebSocket connection timeout'));
        }, this.options.timeout);

        ws.onopen = () => {
          clearTimeout(connectionTimeout);
          console.log(`✅ WebSocket connection established to ${peerId.substring(0, 8)}...`);

          // Send handshake to identify ourselves with metadata
          const myMetadata = ConnectionManagerFactory.getPeerMetadata(this.localNodeId);
          const handshakeMessage = {
            type: 'dht_peer_hello',
            peerId: this.localNodeId,
            metadata: myMetadata  // Include client metadata (listeningAddress, nodeType, etc.)
          };

          console.log(`🤝 Sending handshake to peer: localNodeId=${this.localNodeId}, metadata:`, myMetadata);
          ws.send(JSON.stringify(handshakeMessage));

          // Wait for handshake response
          const handshakeTimeout = setTimeout(() => {
            ws.close();
            reject(new Error('WebSocket handshake timeout'));
          }, 5000);

          const handleHandshakeResponse = async (data) => {
            try {
              const dataString = typeof data === 'string' ? data : data.toString();
              const message = JSON.parse(dataString);

              if (message.type === 'dht_peer_connected' && message.bridgeNodeId) {
                clearTimeout(handshakeTimeout);
                ws.onmessage = null;

                // Extract peer metadata from handshake (will be passed in peerConnected event)
                const peerMetadata = message.metadata || null;
                if (peerMetadata) {
                  console.log(`📋 Received peer metadata from ${message.bridgeNodeId.substring(0, 8)}:`, peerMetadata);
                }

                console.log(`✅ Successfully connected to peer ${message.bridgeNodeId.substring(0, 8)}`);

                await this.setupConnection(peerId, ws, initiator, peerMetadata);
                resolve();

              } else {
                console.warn('WebSocket handshake failed - expected dht_peer_connected:', message.type);
                ws.close();
                reject(new Error('WebSocket handshake failed'));
              }
            } catch (error) {
              console.error('Invalid handshake response:', error);
              ws.close();
              reject(new Error('Invalid handshake response'));
            }
          };

          ws.onmessage = (event) => handleHandshakeResponse(event.data);
        };

        ws.onerror = (error) => {
          clearTimeout(connectionTimeout);
          reject(new Error(`WebSocket connection failed: ${error.message}`));
        };

        ws.onclose = (event) => {
          clearTimeout(connectionTimeout);
          if (event.code !== 1000) {
            reject(new Error(`WebSocket closed unexpectedly: ${event.code} ${event.reason}`));
          }
        };

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Request browser to connect back using DHT signaling (Node.js → Browser)
   */
  async requestBrowserConnection(peerId, initiator) {
    console.log(`📤 Requesting browser ${peerId.substring(0, 8)}... to connect back via DHT signaling`);

    try {
      // Get our listening address for the browser to connect to
      const listeningAddress = this.getListeningAddress();
      if (!listeningAddress) {
        throw new Error('No listening address available for reverse connection');
      }

      // Send generic connection request via DHT messaging
      if (this.dhtSignalingCallback) {
        await this.dhtSignalingCallback('sendConnectionRequest', peerId, {
          connectionType: 'websocket',
          nodeType: 'nodejs',
          listeningAddress: listeningAddress,
          capabilities: ['websocket', 'dht'],
          canRelay: true,
          requestId: `conn_req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        });

        console.log(`📤 Sent WebSocket connection request to browser ${peerId.substring(0, 8)}...`);

        // Wait for the browser to connect back (with timeout)
        const connectionWaitTime = 15000; // 15 seconds
        const startTime = Date.now();

        return new Promise((resolve, reject) => {
          const checkConnection = () => {
            if (this.connection && this.peerId === peerId) {
              console.log(`✅ Browser ${peerId.substring(0, 8)}... connected back successfully`);
              resolve();
            } else if ((Date.now() - startTime) >= connectionWaitTime) {
              console.warn(`⏰ Timeout waiting for browser ${peerId.substring(0, 8)}... to connect back`);
              reject(new Error(`Timeout waiting for browser ${peerId} to connect back`));
            } else {
              // Check again in 1 second
              setTimeout(checkConnection, 1000);
            }
          };

          // Start checking
          setTimeout(checkConnection, 1000);
        });

      } else {
        throw new Error('DHT signaling callback not available');
      }

    } catch (error) {
      console.error(`❌ Failed to request browser connection from ${peerId}:`, error);
      throw error;
    }
  }

  /**
   * Set DHT signaling callback for reverse connections (connection-agnostic)
   */
  setDHTSignalingCallback(callback) {
    this.dhtSignalingCallback = callback;
  }

  /**
   * Get our WebSocket listening address
   */
  getListeningAddress() {
    // This should return our WebSocket server address
    // Implementation depends on how the WebSocket server is set up
    return this.listeningAddress || `ws://localhost:${this.serverPort || 8083}`;
  }

  /**
   * Set up WebSocket connection after handshake
   */
  async setupConnection(peerId, ws, initiator, metadata = null) {
    // CRITICAL: Wait for WebSocket classes to be initialized
    // This is especially important for Node.js where initialization is async
    if (!this.webSocketInitialized) {
      console.log(`⏳ Waiting for WebSocket initialization for ${peerId.substring(0, 8)}...`);
      await this.waitForWebSocketInitialization();
      console.log(`✅ WebSocket initialized for ${peerId.substring(0, 8)}`);
    }

    // NOTE: In single-connection architecture, server managers accept first incoming connection
    // Subsequent connections from different peers should get their own managers (handled by routing table)
    if (this.peerId && this.peerId !== peerId) {
      console.warn(`⚠️ Server manager already handling ${this.peerId.substring(0,8)}, ignoring setup for ${peerId.substring(0,8)} (should have own manager)`);
      return; // Skip setup for different peer - routing table should create separate manager
    }

    // Store peerId and connection (first connection for this manager)
    this.peerId = peerId;
    this.connection = ws;
    this.connectionState = 'connected';

    console.log(`📋 WebSocket connection setup complete for ${peerId.substring(0, 8)}...`);

    // Handle messages using correct API for environment
    // Node.js ws library uses .on() events, browser WebSocket uses .onmessage properties
    if (this.localNodeType === 'nodejs') {
      // Node.js WebSocket (ws library) - uses .on() event listeners
      ws.on('message', (data) => {
        try {
          // Handle both Buffer and string data from WebSocket
          const dataString = typeof data === 'string' ? data : data.toString();
          const message = JSON.parse(dataString);
          this.handleMessage(peerId, message);
        } catch (error) {
          console.error(`❌ Error parsing WebSocket message from ${peerId}:`, error);
        }
      });

      ws.on('close', (code, reason) => {
        console.log(`🔌 WebSocket connection closed to ${peerId}: ${code} ${reason}`);
        this.handleConnectionClose(peerId, { code, reason });
      });

      ws.on('error', (error) => {
        console.error(`❌ WebSocket error with ${peerId}:`, error);
      });
    } else {
      // Browser WebSocket - uses onmessage, onclose, onerror properties
      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          this.handleMessage(peerId, message);
        } catch (error) {
          console.error(`❌ Error parsing WebSocket message from ${peerId}:`, error);
        }
      };

      ws.onclose = (event) => {
        console.log(`🔌 WebSocket connection closed to ${peerId}: ${event.code} ${event.reason}`);
        this.handleConnectionClose(peerId, { code: event.code, reason: event.reason });
      };

      ws.onerror = (error) => {
        console.error(`❌ WebSocket error with ${peerId}:`, error);
      };
    }

    // Start periodic ping to measure latency
    this.startPing();

    // Emit connection event with connection details and metadata
    this.emit('peerConnected', { peerId, initiator, connection: ws, manager: this, metadata });
  }

  /**
   * Send raw message via WebSocket
   */
  async sendRawMessage(peerId, message) {
    // NOTE: In single-connection architecture, manager handles one peer
    // If trying to send to different peer, skip (routing table should use correct manager)
    if (this.peerId && this.peerId !== peerId) {
      // Skip silently - caller should use correct manager for the peer
      return; // Wrong manager for this peer
    }

    const ws = this.connection;

    if (!ws || ws.readyState !== this.WebSocket.OPEN) {
      throw new Error(`No open WebSocket connection to peer ${peerId}`);
    }

    return new Promise((resolve, reject) => {
      try {
        ws.send(JSON.stringify(message));
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Check if peer is connected
   */
  isConnected() {
    if (!this.connection) {
      return false;
    }

    if (!this.webSocketInitialized || !this.WebSocket) {
      return false;
    }

    return this.connection.readyState === this.WebSocket.OPEN;
  }

  /**
   * Destroy connection to peer
   */
  destroyConnection(peerId, reason = 'manual') {
    // Validate peerId matches expected peer
    if (this.peerId && this.peerId !== peerId) {
      console.warn(`⚠️ destroyConnection called with unexpected peer ${peerId}, expected ${this.peerId}`);
      return;
    }

    console.log(`🔌 Destroying WebSocket connection to ${peerId} (${reason})`);

    const ws = this.connection;
    if (ws) {
      ws.close(1000, reason);
    }

    // Clear timeout if exists
    const timeout = this.connectionTimeouts.get(peerId);
    if (timeout) {
      clearTimeout(timeout);
      this.connectionTimeouts.delete(peerId);
    }

    this.cleanupConnection();
    this.emit('peerDisconnected', { peerId, reason });
  }

  /**
   * Handle WebSocket connection close
   */
  handleConnectionClose(peerId, event) {
    console.log(`🔌 WebSocket connection closed to ${peerId.substring(0, 8)}...: ${event.code} ${event.reason}`);
    this.connectionState = 'disconnected';
    this.cleanupConnection();
    this.emit('peerDisconnected', { peerId, reason: `close_${event.code}` });
  }

  /**
   * Clean up connection data
   */
  cleanupConnection() {
    this.connection = null;
    this.connectionState = 'disconnected';
    if (this.peerId) {
      this.connectionTimeouts.delete(this.peerId);
      this.reconnectAttempts.delete(this.peerId);
    }
    
    // Clean up ping state
    this.stopPing();
    
    // Note: Don't clear this.peerId here - it identifies which peer this manager was for
  }

  /**
   * Start periodic ping to measure latency
   */
  startPing() {
    if (this.pingIntervalId || !this.isConnected()) {
      return;
    }

    console.log(`🏓 Starting ping for ${this.peerId?.substring(0, 8)}... (interval: ${this.pingInterval}ms)`);

    // Send initial ping immediately
    this.sendPingToConnectedPeer();

    // Set up periodic pings
    this.pingIntervalId = setInterval(() => {
      this.sendPingToConnectedPeer();
    }, this.pingInterval);
  }

  /**
   * Stop periodic ping
   */
  stopPing() {
    if (this.pingIntervalId) {
      clearInterval(this.pingIntervalId);
      this.pingIntervalId = null;
    }
  }

  /**
   * Send ping to connected peer using base class method
   */
  async sendPingToConnectedPeer() {
    if (!this.isConnected() || !this.peerId) {
      return;
    }

    try {
      const result = await this.ping(this.peerId);
      if (result.success) {
        this.currentRTT = result.rtt;
        this.lastPingTime = Date.now();
        
        // Update peer RTT in routing table if available
        if (this.routingTable && this.peerId) {
          const peerNode = this.routingTable.getNode(this.peerId);
          if (peerNode) {
            peerNode.rtt = result.rtt;
            peerNode.lastPing = Date.now();
          }
        }
      }
    } catch (error) {
      console.error(`❌ Failed to ping ${this.peerId}:`, error);
    }
  }

  /**
   * Override handlePong to update routing table and record metrics
   */
  handlePong(peerId, message) {
    // Call base class implementation (calculates RTT and emits pong event)
    super.handlePong(peerId, message);
    
    // Calculate RTT
    const rtt = Date.now() - (message.originalTimestamp || message.timestamp);
    this.currentRTT = rtt;
    this.lastPingTime = Date.now();
    
    console.log(`🏓 Pong received from ${peerId.substring(0, 8)}... RTT: ${rtt}ms`);
    
    // Update routing table with RTT
    if (this.routingTable && peerId) {
      const peerNode = this.routingTable.getNode(peerId);
      if (peerNode) {
        peerNode.rtt = rtt;
        peerNode.lastPing = Date.now();
      }
    }

    // Record ping latency in global metrics if available
    // Use globalThis for cross-environment compatibility (Node.js and browser)
    const globalObj = typeof globalThis !== 'undefined' ? globalThis : (typeof global !== 'undefined' ? global : window);
    if (globalObj && globalObj.activeDHTNodeMetrics) {
      globalObj.activeDHTNodeMetrics.pingLatencies.push(rtt);
      console.log(`📊 Recorded ping latency: ${rtt}ms (total samples: ${globalObj.activeDHTNodeMetrics.pingLatencies.length})`);
      
      // Keep only recent samples (last 100)
      if (globalObj.activeDHTNodeMetrics.pingLatencies.length > 100) {
        globalObj.activeDHTNodeMetrics.pingLatencies.shift();
      }
      
      // Record ping as an operation for throughput calculation
      globalObj.activeDHTNodeMetrics.opsLastMinute.push(Date.now());
      console.log(`📊 Recorded ping operation for throughput (total ops: ${globalObj.activeDHTNodeMetrics.opsLastMinute.length})`);
      
      // Cleanup old operation timestamps
      const oneMinuteAgo = Date.now() - 60000;
      const oldLength = globalObj.activeDHTNodeMetrics.opsLastMinute.length;
      globalObj.activeDHTNodeMetrics.opsLastMinute = globalObj.activeDHTNodeMetrics.opsLastMinute.filter(t => t > oneMinuteAgo);
      if (oldLength !== globalObj.activeDHTNodeMetrics.opsLastMinute.length) {
        console.log(`📊 Cleaned up old operations: ${oldLength} -> ${globalObj.activeDHTNodeMetrics.opsLastMinute.length}`);
      }
    } else {
      console.warn(`⚠️ No global metrics available to record ping latency: ${rtt}ms`);
    }
  }

  /**
   * Get current RTT (round-trip time) in milliseconds
   */
  getRTT() {
    return this.currentRTT;
  }

  /**
   * Get WebSocket server address
   */
  getServerAddress() {
    if (!this.server) return null;

    // Get actual port from server (handles port 0 case where OS assigns random port)
    const actualPort = this.server.address?.()?.port || this.wsOptions.port;
    return `ws://${this.wsOptions.host}:${actualPort}`;
  }

  /**
   * Handle invitation received through standard DHT protocol
   * Implements the connection-agnostic invitation interface
   */
  async handleInvitationReceived(inviterPeerId, invitationMessage) {
    console.log(`🔗 WebSocket manager handling invitation from ${inviterPeerId.substring(0, 8)}...`);

    // For WebSocket connections, ensure our server is ready
    if (!this.server) {
      console.log(`🚀 Starting WebSocket server for invitation`);
      this.startServer();
    }

    console.log(`📡 WebSocket server ready at ${this.getServerAddress()}`);
    console.log(`🔗 Waiting for inviter to connect to our WebSocket server`);

    return {
      success: true,
      listeningAddress: this.getServerAddress()
    };
  }

  /**
   * Destroy all connections and cleanup
   */
  destroy() {
    if (this.isDestroyed) return;

    console.log('🌐 Destroying WebSocketConnectionManager');

    // Close server
    if (this.server) {
      this.server.close();
      this.server = null;
    }

    // Clear all timeouts
    for (const timeout of this.connectionTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.connectionTimeouts.clear();

    // Close the WebSocket connection
    if (this.connection) {
      this.connection.close(1000, 'Manager destroyed');
    }

    this.reconnectAttempts.clear();

    // Call parent destroy
    super.destroy();
  }
}
