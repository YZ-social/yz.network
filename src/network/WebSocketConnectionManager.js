import { ConnectionManager } from './ConnectionManager.js';

// WebSocket will be determined at runtime

/**
 * WebSocket-based connection manager for Node.js peers
 * Extends ConnectionManager with WebSocket transport implementation
 */
export class WebSocketConnectionManager extends ConnectionManager {
  constructor(options = {}) {
    super(options);
    
    // Initialize WebSocket class for this environment
    this.WebSocket = null;
    this.WebSocketServer = null;
    this.webSocketInitialized = false;
    
    // Determine if we should enable server based on environment
    const isNodeJS = typeof window === 'undefined';
    
    this.wsOptions = {
      port: options.port || 8083,
      host: options.host || 'localhost',
      enableServer: isNodeJS && (options.enableServer !== false), // Only enable server in Node.js
      ...options
    };

    // WebSocket-specific state
    this.server = null; // WebSocket server for incoming connections
    this.connectionTimeouts = new Map(); // peerId -> timeout handle
    this.reconnectAttempts = new Map(); // peerId -> attempt count
    this.maxReconnectAttempts = 3;

    // Initialize WebSocket classes asynchronously
    this.initializeWebSocketClasses().then(() => {
      if (this.wsOptions.enableServer) {
        this.startServer();
      }
    }).catch(error => {
      console.error('Failed to initialize WebSocket classes:', error);
    });
  }

  /**
   * Initialize WebSocket classes based on environment
   */
  async initializeWebSocketClasses() {
    const isNodeJS = typeof window === 'undefined';
    console.log(`🔍 Initializing WebSocket classes for ${isNodeJS ? 'Node.js' : 'browser'} environment`);
    
    if (isNodeJS) {
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
    } else {
      // Browser environment - use native WebSocket
      this.WebSocket = window.WebSocket;
      this.WebSocketServer = null; // Browsers cannot create servers
      this.webSocketInitialized = true;
      console.log('🌐 Initialized browser WebSocket support');
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
      this.server = new this.WebSocketServer({
        port: this.wsOptions.port,
        host: this.wsOptions.host
      });

      this.server.on('connection', (ws, request) => {
        this.handleIncomingConnection(ws, request);
      });

      this.server.on('error', (error) => {
        console.error('WebSocket server error:', error);
        this.emit('error', error);
      });

      console.log(`🌐 WebSocket server listening on ${this.wsOptions.host}:${this.wsOptions.port}`);
      this.emit('serverStarted', { 
        host: this.wsOptions.host, 
        port: this.wsOptions.port 
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

    const messageHandler = (data) => {
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
          
          // Set up the connection with bootstrap identifier
          this.setupConnection(bootstrapPeerId, ws, false);
          
          // Forward the auth message to the connection handler after setup
          // Use setTimeout to ensure connection setup is complete
          setTimeout(() => {
            this.handleMessage(bootstrapPeerId, message);
          }, 10);
          
        } else if (message.type === 'dht_peer_hello' && message.peerId) {
          // DHT peer connecting
          clearTimeout(handshakeTimeout);
          ws.off('message', messageHandler);
          
          const peerId = message.peerId;
          console.log(`✅ DHT peer connected: ${peerId.substring(0, 8)}...`);
          
          // Send confirmation
          ws.send(JSON.stringify({
            type: 'dht_peer_connected',
            bridgeNodeId: this.localNodeId,
            success: true,
            timestamp: Date.now()
          }));

          // Set up the connection
          this.setupConnection(peerId, ws, false); // false = not initiator
          
        } else if (message.type === 'handshake' && message.peerId) {
          // Regular handshake
          clearTimeout(handshakeTimeout);
          ws.off('message', messageHandler);
          
          const peerId = message.peerId;
          console.log(`🤝 Peer handshake: ${peerId.substring(0, 8)}...`);
          
          // Send handshake response
          ws.send(JSON.stringify({
            type: 'handshake_response',
            success: true,
            timestamp: Date.now()
          }));

          this.setupConnection(peerId, ws, false);
          
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
   * Create WebSocket connection to peer
   */
  async createConnection(peerId, initiator = true) {
    if (this.isDestroyed) {
      throw new Error('WebSocketConnectionManager is destroyed');
    }

    if (this.connections.has(peerId)) {
      throw new Error(`Connection to ${peerId} already exists`);
    }

    if (this.connections.size >= this.options.maxConnections) {
      throw new Error('Maximum connections reached');
    }

    // Wait for WebSocket initialization
    if (!this.webSocketInitialized) {
      console.log('⏳ Waiting for WebSocket initialization...');
      await this.waitForWebSocketInitialization();
    }

    // Get WebSocket address from peer metadata
    const metadata = this.getPeerMetadata(peerId);
    const wsAddress = metadata?.listeningAddress;
    
    if (!wsAddress) {
      throw new Error(`No WebSocket address for peer ${peerId}`);
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

          // Send handshake to identify ourselves
          const handshakeMessage = {
            type: 'dht_peer_hello',
            peerId: this.localNodeId
          };
          
          console.log(`🤝 Sending handshake to bridge: localNodeId=${this.localNodeId}, message:`, handshakeMessage);
          ws.send(JSON.stringify(handshakeMessage));

          // Wait for handshake response
          const handshakeTimeout = setTimeout(() => {
            ws.close();
            reject(new Error('WebSocket handshake timeout'));
          }, 5000);

          const handleHandshakeResponse = (data) => {
            try {
              const dataString = typeof data === 'string' ? data : data.toString();
              const message = JSON.parse(dataString);
              
              if ((message.type === 'handshake_response' && message.success) ||
                  (message.type === 'dht_peer_connected' && message.bridgeNodeId)) {
                clearTimeout(handshakeTimeout);
                ws.onmessage = null;
                
                if (message.type === 'dht_peer_connected') {
                  console.log(`✅ Successfully connected to bridge node ${message.bridgeNodeId.substring(0, 8)}`);
                  
                  // CRITICAL: Store bridge metadata if provided
                  if (message.metadata) {
                    console.log(`📋 Received bridge metadata:`, message.metadata);
                    this.setPeerMetadata(peerId, message.metadata);
                  }
                }
                
                this.setupConnection(peerId, ws, initiator);
                resolve();
                
              } else {
                console.warn('WebSocket handshake failed:', message);
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
   * Set up WebSocket connection after handshake
   */
  setupConnection(peerId, ws, initiator) {
    // Store connection
    this.connections.set(peerId, ws);
    this.connectionStates.set(peerId, 'connected');

    console.log(`📋 WebSocket connection setup complete for ${peerId.substring(0, 8)}...`);

    // Handle messages using correct API for environment
    const isNodeJS = typeof window === 'undefined';
    
    if (isNodeJS) {
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

    // Emit connection event with connection details
    this.emit('peerConnected', { peerId, initiator, connection: ws, manager: this });
  }

  /**
   * Send raw message via WebSocket
   */
  async sendRawMessage(peerId, message) {
    const ws = this.connections.get(peerId);
    
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
  isConnected(peerId) {
    const ws = this.connections.get(peerId);
    if (!ws) return false;
    
    // Handle case where WebSocket classes aren't initialized yet
    if (!this.webSocketInitialized || !this.WebSocket) {
      return false;
    }
    
    return ws.readyState === this.WebSocket.OPEN;
  }

  /**
   * Destroy connection to peer
   */
  destroyConnection(peerId, reason = 'manual') {
    console.log(`🔌 Destroying WebSocket connection to ${peerId} (${reason})`);
    
    const ws = this.connections.get(peerId);
    if (ws) {
      ws.close(1000, reason);
    }

    // Clear timeout if exists
    const timeout = this.connectionTimeouts.get(peerId);
    if (timeout) {
      clearTimeout(timeout);
      this.connectionTimeouts.delete(peerId);
    }

    this.cleanupConnection(peerId);
    this.emit('peerDisconnected', { peerId, reason });
  }

  /**
   * Handle WebSocket connection close
   */
  handleConnectionClose(peerId, event) {
    console.log(`🔌 WebSocket connection closed to ${peerId.substring(0, 8)}...: ${event.code} ${event.reason}`);
    this.connectionStates.set(peerId, 'disconnected');
    this.cleanupConnection(peerId);
    this.emit('peerDisconnected', { peerId, reason: `close_${event.code}` });
  }

  /**
   * Clean up connection data
   */
  cleanupConnection(peerId) {
    this.connections.delete(peerId);
    this.connectionStates.delete(peerId);
    this.connectionTimeouts.delete(peerId);
    this.reconnectAttempts.delete(peerId);
  }

  /**
   * Get WebSocket server address
   */
  getServerAddress() {
    if (!this.server) return null;
    return `ws://${this.wsOptions.host}:${this.wsOptions.port}`;
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

    // Close all WebSocket connections
    for (const [peerId, ws] of this.connections.entries()) {
      ws.close(1000, 'Manager destroyed');
    }

    this.reconnectAttempts.clear();

    // Call parent destroy
    super.destroy();
  }
}