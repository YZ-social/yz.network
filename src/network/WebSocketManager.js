import { EventEmitter } from 'events';
import WebSocket, { WebSocketServer } from 'ws';

/**
 * WebSocket-based connection manager for Node.js DHT environments
 * Provides same interface as WebRTCManager but uses WebSocket connections
 */
export class WebSocketManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      port: options.port || 0, // 0 = random available port
      maxConnections: options.maxConnections || 50,
      timeout: options.timeout || 30000,
      ...options
    };

    this.connections = new Map(); // peerId -> WebSocket
    this.connectionStates = new Map(); // peerId -> connection state
    this.pendingConnections = new Map(); // peerId -> connection attempt info
    this.messageQueues = new Map(); // peerId -> array of queued messages
    this.peerMetadata = new Map(); // peerId -> { nodeType, listeningAddress, capabilities }
    this.localNodeId = null;
    this.server = null;
    this.isDestroyed = false;
    this.isInitialized = false;
    this.listeningAddress = null;
  }

  /**
   * Initialize the WebSocket manager
   */
  async initialize(localNodeId) {
    if (this.isInitialized) {
      console.warn('WebSocketManager already initialized');
      return;
    }

    this.localNodeId = localNodeId;
    
    // Start WebSocket server for incoming connections
    await this.startServer();
    
    this.isInitialized = true;
    console.log(`🌐 WebSocketManager initialized with node ID: ${localNodeId}`);
    console.log(`📡 Listening on: ${this.listeningAddress}`);
    
    this.emit('initialized', { 
      localNodeId, 
      listeningAddress: this.listeningAddress 
    });
  }

  /**
   * Start WebSocket server for incoming connections
   */
  async startServer() {
    return new Promise((resolve, reject) => {
      this.server = new WebSocketServer({ 
        port: this.options.port,
        perMessageDeflate: false // Disable compression for lower latency
      });

      this.server.on('connection', (ws, request) => {
        this.handleIncomingConnection(ws, request);
      });

      this.server.on('listening', () => {
        const address = this.server.address();
        this.listeningAddress = `ws://localhost:${address.port}`;
        console.log(`🚀 WebSocket server listening on port ${address.port}`);
        resolve();
      });

      this.server.on('error', (error) => {
        console.error('❌ WebSocket server error:', error);
        reject(error);
      });
    });
  }

  /**
   * Handle incoming WebSocket connection
   */
  handleIncomingConnection(ws, request) {
    console.log('📥 Incoming WebSocket connection from:', request.socket.remoteAddress);

    // Wait for handshake message with peer ID
    const handshakeTimeout = setTimeout(() => {
      console.warn('⚠️ Handshake timeout for incoming connection');
      ws.close();
    }, 5000);

    ws.once('message', (data) => {
      clearTimeout(handshakeTimeout);
      
      try {
        const message = JSON.parse(data.toString());
        
        if (message.type === 'handshake') {
          const peerId = message.peerId;
          
          if (!peerId) {
            console.error('❌ Invalid handshake - no peer ID');
            ws.close();
            return;
          }

          console.log(`🤝 WebSocket handshake from peer: ${peerId.substring(0, 8)}...`);
          
          // Check if we already have a connection to this peer
          if (this.connections.has(peerId)) {
            console.warn(`⚠️ Already connected to peer ${peerId.substring(0, 8)}...`);
            ws.close();
            return;
          }

          // Set up the connection
          this.setupWebSocketConnection(peerId, ws, false); // false = incoming connection
          
          // Send handshake response
          ws.send(JSON.stringify({
            type: 'handshake_response',
            peerId: this.localNodeId,
            success: true
          }));

        } else {
          console.error('❌ Expected handshake message, got:', message.type);
          ws.close();
        }
      } catch (error) {
        console.error('❌ Error parsing handshake message:', error);
        ws.close();
      }
    });
  }

  /**
   * Create outgoing connection to peer
   */
  async createConnection(peerId, initiator = true) {
    if (this.isDestroyed) {
      throw new Error('WebSocketManager is destroyed');
    }

    if (this.connections.has(peerId)) {
      throw new Error(`Connection to ${peerId} already exists`);
    }

    if (this.connections.size >= this.options.maxConnections) {
      throw new Error('Maximum connections reached');
    }

    console.log(`🚀 Creating outgoing WebSocket connection to ${peerId.substring(0, 8)}...`);

    // For outgoing connections, we need the target's WebSocket server address
    // This should be provided through DHT peer discovery or connection requests
    const targetAddress = await this.getTargetAddress(peerId);
    
    if (!targetAddress) {
      throw new Error(`No WebSocket address found for peer ${peerId}`);
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(targetAddress);
      const connectionTimeout = setTimeout(() => {
        ws.close();
        reject(new Error('Connection timeout'));
      }, this.options.timeout);

      ws.on('open', () => {
        clearTimeout(connectionTimeout);
        
        // Send handshake
        ws.send(JSON.stringify({
          type: 'handshake',
          peerId: this.localNodeId
        }));

        // Wait for handshake response
        const handshakeTimeout = setTimeout(() => {
          ws.close();
          reject(new Error('Handshake timeout'));
        }, 5000);

        ws.once('message', (data) => {
          clearTimeout(handshakeTimeout);
          
          try {
            const message = JSON.parse(data.toString());
            
            if (message.type === 'handshake_response' && message.success) {
              console.log(`✅ WebSocket connection established to ${peerId.substring(0, 8)}...`);
              
              this.setupWebSocketConnection(peerId, ws, true); // true = outgoing connection
              resolve(ws);
            } else {
              ws.close();
              reject(new Error('Handshake failed'));
            }
          } catch (error) {
            ws.close();
            reject(error);
          }
        });
      });

      ws.on('error', (error) => {
        clearTimeout(connectionTimeout);
        reject(error);
      });
    });
  }

  /**
   * Wait for an existing connection attempt to complete (for collision handling)
   */
  async waitForConnectionToComplete(peerId, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const checkInterval = setInterval(() => {
        const connection = this.connections.get(peerId);
        
        if (!connection) {
          clearInterval(checkInterval);
          reject(new Error(`Connection to ${peerId} was removed while waiting`));
          return;
        }
        
        if (connection.readyState === WebSocket.OPEN) {
          clearInterval(checkInterval);
          console.log(`✅ WebSocket connection to ${peerId.substring(0, 8)}... completed successfully`);
          resolve(connection);
          return;
        }
        
        if (connection.readyState === WebSocket.CLOSED || connection.readyState === WebSocket.CLOSING) {
          clearInterval(checkInterval);
          reject(new Error(`Connection to ${peerId} failed while waiting`));
          return;
        }
        
        if (Date.now() - startTime > timeout) {
          clearInterval(checkInterval);
          reject(new Error(`Timeout waiting for connection to ${peerId} to complete`));
          return;
        }
      }, 100); // Check every 100ms
    });
  }

  /**
   * Set up WebSocket connection with DHT message handling
   */
  setupWebSocketConnection(peerId, ws, isOutgoing) {
    this.connections.set(peerId, ws);
    this.connectionStates.set(peerId, 'connected');
    this.messageQueues.set(peerId, []);

    console.log(`📋 WebSocket connection setup complete for ${peerId.substring(0, 8)}...`);

    // Handle incoming messages
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleDHTMessage(peerId, message);
      } catch (error) {
        console.error(`❌ Error parsing message from ${peerId.substring(0, 8)}...:`, error);
      }
    });

    // Handle connection close
    ws.on('close', (code, reason) => {
      console.log(`🔌 WebSocket connection closed to ${peerId.substring(0, 8)}...: ${code} ${reason}`);
      this.handleConnectionClose(peerId);
    });

    // Handle connection error
    ws.on('error', (error) => {
      console.error(`❌ WebSocket error with ${peerId.substring(0, 8)}...:`, error);
    });

    // Emit connection event
    this.emit('peerConnected', { peerId });
  }

  /**
   * Handle DHT message from peer
   */
  handleDHTMessage(peerId, message) {
    // Queue message for processing
    const queue = this.messageQueues.get(peerId) || [];
    queue.push(message);
    this.messageQueues.set(peerId, queue);

    // Process message queue
    this.processMessageQueue(peerId);
  }

  /**
   * Process queued messages from a peer
   */
  processMessageQueue(peerId) {
    const queue = this.messageQueues.get(peerId);
    if (!queue || queue.length === 0) return;

    const message = queue.shift();
    this.messageQueues.set(peerId, queue);

    // Emit DHT message event
    this.emit('message', { peerId, message });

    // Process next message in queue
    if (queue.length > 0) {
      setImmediate(() => this.processMessageQueue(peerId));
    }
  }

  /**
   * Send message to peer
   */
  async sendMessage(peerId, message) {
    const connection = this.connections.get(peerId);
    
    if (!connection || connection.readyState !== WebSocket.OPEN) {
      throw new Error(`No open connection to peer ${peerId}`);
    }

    return new Promise((resolve, reject) => {
      connection.send(JSON.stringify(message), (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Handle connection close
   */
  handleConnectionClose(peerId) {
    this.connections.delete(peerId);
    this.connectionStates.delete(peerId);
    this.messageQueues.delete(peerId);
    this.pendingConnections.delete(peerId);

    this.emit('peerDisconnected', { peerId });
  }

  /**
   * Create WebSocket connection with explicit address (for invitation coordination)
   */
  async createWebSocketConnection(peerId, websocketAddress) {
    console.log(`🌐 Creating explicit WebSocket connection to ${peerId.substring(0, 8)}... at ${websocketAddress}`);
    
    if (!websocketAddress) {
      throw new Error(`WebSocket address required for explicit connection to ${peerId}`);
    }

    if (this.isDestroyed) {
      throw new Error('WebSocketManager is destroyed');
    }

    if (this.connections.has(peerId)) {
      throw new Error(`Connection to ${peerId} already exists`);
    }

    if (this.connections.size >= this.options.maxConnections) {
      throw new Error('Maximum connections reached');
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(websocketAddress);
      const connectionTimeout = setTimeout(() => {
        ws.close();
        reject(new Error('Connection timeout'));
      }, this.options.timeout);

      ws.on('open', () => {
        clearTimeout(connectionTimeout);
        
        // Send handshake
        ws.send(JSON.stringify({
          type: 'handshake',
          peerId: this.localNodeId
        }));

        // Wait for handshake response
        const handshakeTimeout = setTimeout(() => {
          ws.close();
          reject(new Error('Handshake timeout'));
        }, 5000);

        ws.once('message', (data) => {
          clearTimeout(handshakeTimeout);
          
          try {
            const message = JSON.parse(data.toString());
            
            if (message.type === 'handshake_response' && message.success) {
              console.log(`✅ WebSocket connection established to ${peerId.substring(0, 8)}...`);
              
              this.setupWebSocketConnection(peerId, ws, true); // true = outgoing connection
              resolve(ws);
            } else {
              ws.close();
              reject(new Error('Handshake failed'));
            }
          } catch (error) {
            ws.close();
            reject(error);
          }
        });
      });

      ws.on('error', (error) => {
        clearTimeout(connectionTimeout);
        reject(error);
      });
    });
  }

  /**
   * Store peer metadata (from invitation coordination or peer discovery)
   */
  setPeerMetadata(peerId, metadata) {
    this.peerMetadata.set(peerId, metadata);
    console.log(`📋 Stored peer metadata for ${peerId.substring(0, 8)}...:`, metadata);
  }

  /**
   * Get target WebSocket address for peer
   */
  async getTargetAddress(peerId) {
    const metadata = this.peerMetadata.get(peerId);
    if (metadata && metadata.listeningAddress) {
      console.log(`📍 Found WebSocket address for ${peerId.substring(0, 8)}...: ${metadata.listeningAddress}`);
      return metadata.listeningAddress;
    }
    
    console.warn(`⚠️ No WebSocket address found for peer ${peerId.substring(0, 8)}...`);
    return null;
  }

  /**
   * Get connected peer IDs
   */
  getConnectedPeers() {
    return Array.from(this.connections.keys()).filter(peerId => 
      this.connections.get(peerId)?.readyState === WebSocket.OPEN
    );
  }

  /**
   * Check if connected to specific peer
   */
  isConnected(peerId) {
    const connection = this.connections.get(peerId);
    return connection && connection.readyState === WebSocket.OPEN;
  }

  /**
   * Get connection statistics
   */
  getStats() {
    const connected = this.getConnectedPeers();
    
    return {
      type: 'websocket',
      localNodeId: this.localNodeId,
      listeningAddress: this.listeningAddress,
      totalConnections: this.connections.size,
      connectedPeers: connected.length,
      connectedPeerIds: connected,
      maxConnections: this.options.maxConnections,
      isListening: !!(this.server?.listening)
    };
  }

  /**
   * Destroy the WebSocket manager
   */
  destroy() {
    if (this.isDestroyed) return;

    console.log('🔥 Destroying WebSocketManager');
    this.isDestroyed = true;

    // Close all connections
    for (const [peerId, connection] of this.connections) {
      try {
        connection.close();
      } catch (error) {
        console.error(`Error closing connection to ${peerId}:`, error);
      }
    }

    // Close server
    if (this.server) {
      this.server.close(() => {
        console.log('📡 WebSocket server closed');
      });
    }

    // Clear maps
    this.connections.clear();
    this.connectionStates.clear();
    this.messageQueues.clear();
    this.pendingConnections.clear();
    this.peerMetadata.clear();

    // Remove all listeners
    this.removeAllListeners();

    this.emit('destroyed');
  }
}