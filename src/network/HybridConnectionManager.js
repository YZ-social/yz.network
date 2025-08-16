/**
 * Hybrid Connection Manager for Browser DHT Clients
 * 
 * Manages both WebRTC and WebSocket connections:
 * - WebRTC DataChannels for Browser ↔ Browser connections
 * - WebSocket client connections for Browser ↔ Node.js connections
 * 
 * Transport Selection:
 * - If target is Browser → Use WebRTC
 * - If target is Node.js → Use WebSocket client (connect to Node.js WebSocket server)
 */

import { EventEmitter } from 'events';

export class HybridConnectionManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      timeout: options.timeout || 30000,
      maxConnections: options.maxConnections || 50,
      iceServers: options.iceServers || [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ],
      ...options
    };

    this.connections = new Map(); // peerId -> connection (RTCPeerConnection or WebSocket)
    this.connectionTypes = new Map(); // peerId -> 'webrtc' or 'websocket'
    this.connectionStates = new Map(); // peerId -> connection state
    this.dataChannels = new Map(); // peerId -> RTCDataChannel (WebRTC only)
    this.pendingConnections = new Map(); // peerId -> connection attempt info
    this.peerMetadata = new Map(); // peerId -> { nodeType, listeningAddress, capabilities }
    
    // Keep-alive mechanisms for inactive tabs
    this.keepAliveIntervals = new Map(); // peerId -> interval ID
    this.lastPingTimes = new Map(); // peerId -> timestamp
    this.pingResponses = new Map(); // peerId -> Set of pending ping IDs
    this.isTabVisible = true;
    this.keepAliveFrequency = 30000; // 30 seconds for active tabs
    this.inactiveKeepAliveFrequency = 10000; // 10 seconds for inactive tabs
    
    this.localNodeId = null;
    this.isDestroyed = false;
    this.isInitialized = false;
  }

  /**
   * Initialize the connection manager
   */
  async initialize(localNodeId) {
    if (this.isInitialized) {
      console.warn('HybridConnectionManager already initialized');
      return;
    }

    this.localNodeId = localNodeId;
    this.isInitialized = true;
    
    // Setup Page Visibility API for tab activity detection
    this.setupVisibilityHandling();
    
    console.log(`🔗 HybridConnectionManager initialized for browser node: ${localNodeId}`);
    console.log(`   WebRTC support: ${this.hasWebRTCSupport()}`);
    console.log(`   WebSocket support: ${this.hasWebSocketSupport()}`);
    
    this.emit('initialized', { localNodeId });
  }

  /**
   * Setup Page Visibility API to handle tab becoming inactive/active
   */
  setupVisibilityHandling() {
    if (typeof document !== 'undefined') {
      // Handle visibility change events
      document.addEventListener('visibilitychange', () => {
        const wasVisible = this.isTabVisible;
        this.isTabVisible = !document.hidden;
        
        console.log(`📱 Tab visibility changed: ${this.isTabVisible ? 'visible' : 'hidden'}`);
        console.log(`📊 Current connections: ${this.connections?.size || 0}, Keep-alive intervals: ${this.keepAliveIntervals?.size || 0}`);
        
        if (wasVisible !== this.isTabVisible) {
          // Adjust keep-alive frequency for all WebRTC connections
          this.adjustKeepAliveFrequency();
          
          if (this.isTabVisible) {
            // Tab became visible - check all connections
            console.log('🔄 Tab became visible, checking connection health...');
            this.checkAllConnectionHealth();
          } else {
            // Tab became hidden - increase keep-alive frequency
            console.log('🔄 Tab became hidden, increasing keep-alive frequency for background operation...');
          }
        }
      });
      
      // Initial state
      this.isTabVisible = !document.hidden;
    }
  }

  /**
   * Adjust keep-alive frequency based on tab visibility
   */
  adjustKeepAliveFrequency() {
    for (const [peerId, _intervalId] of this.keepAliveIntervals) {
      this.stopKeepAlive(peerId);
      this.startKeepAlive(peerId);
    }
  }

  /**
   * Start keep-alive mechanism for a WebRTC connection
   */
  startKeepAlive(peerId) {
    const connectionType = this.connectionTypes.get(peerId);
    if (connectionType !== 'webrtc') return; // Only for WebRTC connections
    
    const frequency = this.isTabVisible ? this.keepAliveFrequency : this.inactiveKeepAliveFrequency;
    
    const intervalId = setInterval(() => {
      this.sendKeepAlivePing(peerId);
    }, frequency);
    
    this.keepAliveIntervals.set(peerId, intervalId);
    console.log(`💓 Started keep-alive for ${peerId.substring(0, 8)}... (${frequency}ms interval, tab ${this.isTabVisible ? 'visible' : 'hidden'})`);
  }

  /**
   * Stop keep-alive mechanism for a connection
   */
  stopKeepAlive(peerId) {
    const intervalId = this.keepAliveIntervals.get(peerId);
    if (intervalId) {
      clearInterval(intervalId);
      this.keepAliveIntervals.delete(peerId);
      this.lastPingTimes.delete(peerId);
      this.pingResponses.delete(peerId);
      console.log(`💔 Stopped keep-alive for ${peerId.substring(0, 8)}...`);
    }
  }

  /**
   * Send keep-alive ping to maintain WebRTC connection
   */
  async sendKeepAlivePing(peerId) {
    const dataChannel = this.dataChannels.get(peerId);
    if (!dataChannel || dataChannel.readyState !== 'open') {
      console.warn(`⚠️ Cannot send keep-alive ping to ${peerId.substring(0, 8)}... - channel not open`);
      this.handleConnectionIssue(peerId);
      return;
    }

    const pingId = `ping_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const pingMessage = {
      type: 'keep_alive_ping',
      pingId,
      timestamp: Date.now(),
      tabVisible: this.isTabVisible
    };

    try {
      // Track this ping
      if (!this.pingResponses.has(peerId)) {
        this.pingResponses.set(peerId, new Set());
      }
      this.pingResponses.get(peerId).add(pingId);
      this.lastPingTimes.set(peerId, Date.now());

      // Send the ping
      dataChannel.send(JSON.stringify(pingMessage));
      
      // Set timeout to detect if ping response doesn't arrive
      setTimeout(() => {
        if (this.pingResponses.has(peerId) && this.pingResponses.get(peerId).has(pingId)) {
          console.warn(`⏰ Keep-alive ping timeout for ${peerId.substring(0, 8)}... (ping: ${pingId})`);
          this.pingResponses.get(peerId).delete(pingId);
          this.handleConnectionIssue(peerId);
        }
      }, 15000); // 15 second timeout
      
    } catch (error) {
      console.error(`❌ Error sending keep-alive ping to ${peerId.substring(0, 8)}...:`, error);
      this.handleConnectionIssue(peerId);
    }
  }

  /**
   * Handle incoming keep-alive ping and send pong response
   */
  handleKeepAlivePing(peerId, pingMessage) {
    const { pingId, timestamp } = pingMessage;
    const dataChannel = this.dataChannels.get(peerId);
    
    if (!dataChannel || dataChannel.readyState !== 'open') {
      console.warn(`⚠️ Cannot respond to keep-alive ping from ${peerId.substring(0, 8)}... - channel not open`);
      return;
    }

    const now = Date.now();
    const roundTripTime = now - timestamp;
    
    const pongMessage = {
      type: 'keep_alive_pong',
      pingId,
      timestamp: now,
      roundTripTime,
      tabVisible: this.isTabVisible
    };

    try {
      dataChannel.send(JSON.stringify(pongMessage));
      console.log(`🏓 Sent keep-alive pong to ${peerId.substring(0, 8)}... (ping: ${pingId})`);
    } catch (error) {
      console.error(`❌ Error sending keep-alive pong to ${peerId.substring(0, 8)}...:`, error);
    }
  }

  /**
   * Handle keep-alive pong response
   */
  handleKeepAlivePong(peerId, pongMessage) {
    const { pingId, roundTripTime } = pongMessage;
    
    if (this.pingResponses.has(peerId)) {
      const pingSet = this.pingResponses.get(peerId);
      if (pingSet.has(pingId)) {
        pingSet.delete(pingId);
        console.log(`💚 Keep-alive pong received from ${peerId.substring(0, 8)}... (RTT: ${roundTripTime}ms)`);
        
        // Connection is healthy
        this.updateConnectionHealth(peerId, true);
        return;
      }
    }
    
    console.warn(`❓ Unexpected keep-alive pong from ${peerId.substring(0, 8)}... (ping: ${pingId})`);
  }

  /**
   * Handle connection health issues
   */
  handleConnectionIssue(peerId) {
    const connection = this.connections.get(peerId);
    if (!connection) return;

    console.warn(`🩺 Connection health issue detected for ${peerId.substring(0, 8)}...`);
    
    // Check actual connection state
    const connectionType = this.connectionTypes.get(peerId);
    if (connectionType === 'webrtc') {
      const actualState = connection.connectionState;
      console.log(`🔍 Actual WebRTC state: ${actualState}`);
      
      if (actualState === 'failed' || actualState === 'disconnected') {
        this.handleConnectionClose(peerId);
      }
    } else if (connectionType === 'websocket') {
      const actualState = connection.readyState;
      console.log(`🔍 Actual WebSocket state: ${actualState}`);
      
      if (actualState === WebSocket.CLOSED || actualState === WebSocket.CLOSING) {
        this.handleConnectionClose(peerId);
      }
    }
  }

  /**
   * Update connection health status
   */
  updateConnectionHealth(peerId, isHealthy) {
    // Could track connection health metrics here
    // For now, just log the health status
    const statusEmoji = isHealthy ? '💚' : '❤️‍🩹';
    console.log(`${statusEmoji} Connection health for ${peerId.substring(0, 8)}...: ${isHealthy ? 'healthy' : 'unhealthy'}`);
  }

  /**
   * Check health of all connections
   */
  checkAllConnectionHealth() {
    console.log(`🩺 Checking health of ${this.connections?.size || 0} connections...`);
    
    if (!this.connections) {
      console.warn('⚠️ No connections map available');
      return;
    }
    
    for (const [peerId, _connection] of this.connections) {
      const connectionType = this.connectionTypes?.get(peerId);
      const isConnected = this.isConnected(peerId);
      const hasKeepAlive = this.keepAliveIntervals?.has(peerId);
      
      console.log(`  ${peerId.substring(0, 8)}... (${connectionType}): Connected=${isConnected ? '✅' : '❌'}, KeepAlive=${hasKeepAlive ? '✅' : '❌'}`);
      
      if (connectionType === 'webrtc' && isConnected) {
        // Send immediate ping to check health
        this.sendKeepAlivePing(peerId);
      }
    }
  }

  /**
   * Create connection to peer (automatically selects transport)
   */
  async createConnection(peerId, initiator = true) {
    if (this.isDestroyed) {
      throw new Error('HybridConnectionManager is destroyed');
    }

    // WEBSOCKET COLLISION HANDLING: Check if connection already exists or is being established
    if (this.connections.has(peerId)) {
      const existing = this.connections.get(peerId);
      
      // Handle WebSocket connections
      if (existing instanceof WebSocket) {
        if (existing.readyState === WebSocket.OPEN) {
          console.log(`🔄 WebSocket connection to ${peerId.substring(0, 8)}... already exists and is open`);
          return existing; // Return existing connection
        } else if (existing.readyState === WebSocket.CONNECTING) {
          console.log(`⏳ WebSocket connection to ${peerId.substring(0, 8)}... is already being established, waiting...`);
          return this.waitForWebSocketConnectionToComplete(peerId);
        }
      } 
      // Handle WebRTC connections
      else if (existing.connectionState === 'connected') {
        console.log(`🔄 WebRTC connection to ${peerId.substring(0, 8)}... already exists and is connected`);
        return existing;
      } else if (existing.connectionState === 'connecting') {
        console.log(`⏳ WebRTC connection to ${peerId.substring(0, 8)}... is already being established, waiting...`);
        return this.waitForWebRTCConnectionToComplete(peerId);
      }
      
      // Clean up failed connection
      console.log(`🧹 Cleaning up failed connection to ${peerId.substring(0, 8)}... before creating new one`);
      this.handleConnectionClose(peerId);
    }

    if (this.connections.size >= this.options.maxConnections) {
      throw new Error('Maximum connections reached');
    }

    // Determine transport based on peer metadata
    const transport = await this.selectTransport(peerId);
    console.log(`🚀 Creating ${transport} connection to ${peerId.substring(0, 8)}... (initiator: ${initiator})`);

    if (transport === 'webrtc') {
      return this.createWebRTCConnection(peerId, initiator);
    } else if (transport === 'websocket') {
      return this.createWebSocketConnection(peerId);
    } else {
      throw new Error(`Unknown transport: ${transport}`);
    }
  }

  /**
   * Create WebSocket connection to Node.js peer
   */
  async createWebSocketConnection(peerId, websocketAddress = null) {
    console.log(`🌐 Creating WebSocket connection to Node.js peer: ${peerId.substring(0, 8)}...`);

    // Get WebSocket address from peer metadata or parameter
    const address = websocketAddress || this.getWebSocketAddress(peerId);
    
    if (!address) {
      throw new Error(`No WebSocket address found for Node.js peer ${peerId}`);
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(address);
      const connectionTimeout = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket connection timeout'));
      }, this.options.timeout);

      ws.onopen = () => {
        clearTimeout(connectionTimeout);
        console.log(`✅ WebSocket connection established to Node.js peer ${peerId.substring(0, 8)}...`);

        // Send handshake to identify ourselves
        ws.send(JSON.stringify({
          type: 'handshake',
          peerId: this.localNodeId
        }));

        // Wait for handshake response
        const handshakeTimeout = setTimeout(() => {
          ws.close();
          reject(new Error('WebSocket handshake timeout'));
        }, 5000);

        const handleHandshakeResponse = (event) => {
          try {
            const message = JSON.parse(event.data);
            if (message.type === 'handshake_response' && message.success) {
              clearTimeout(handshakeTimeout);
              ws.removeEventListener('message', handleHandshakeResponse);
              
              // Set up the WebSocket connection for DHT messaging
              this.setupWebSocketConnection(peerId, ws);
              resolve(ws);
            } else {
              ws.close();
              reject(new Error('WebSocket handshake failed'));
            }
          } catch (error) {
            ws.close();
            reject(new Error('Invalid handshake response'));
          }
        };

        ws.addEventListener('message', handleHandshakeResponse);
      };

      ws.onerror = (error) => {
        clearTimeout(connectionTimeout);
        reject(new Error(`WebSocket connection failed: ${error.message || 'Unknown error'}`));
      };

      ws.onclose = (event) => {
        clearTimeout(connectionTimeout);
        if (event.code !== 1000) {
          reject(new Error(`WebSocket closed unexpectedly: ${event.code} ${event.reason}`));
        }
      };
    });
  }

  /**
   * Create WebRTC connection to browser peer
   */
  async createWebRTCConnection(peerId, initiator = true) {
    console.log(`📡 Creating WebRTC connection to browser peer: ${peerId.substring(0, 8)}... (initiator: ${initiator})`);

    // Create RTCPeerConnection
    const pc = new RTCPeerConnection({
      iceServers: this.options.iceServers,
      iceTransportPolicy: 'all'
    });

    this.connections.set(peerId, pc);
    this.connectionTypes.set(peerId, 'webrtc');
    this.connectionStates.set(peerId, 'connecting');

    // Setup WebRTC events
    this.setupWebRTCConnection(peerId, pc, initiator);

    this.pendingConnections.set(peerId, {
      startTime: Date.now(),
      initiator,
      pc
    });

    // Set connection timeout
    const timeout = setTimeout(() => {
      if (this.connectionStates.get(peerId) === 'connecting') {
        console.warn(`⏰ WebRTC connection timeout for peer ${peerId}`);
        this.destroyConnection(peerId, 'timeout');
      }
    }, this.options.timeout);

    pc.timeout = timeout;

    if (initiator) {
      // Create data channel for outgoing connections
      const dataChannel = pc.createDataChannel('dht-data', { ordered: true });
      this.setupDataChannelEvents(peerId, dataChannel);
      this.dataChannels.set(peerId, dataChannel);

      // Create offer
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        console.log(`📤 Created WebRTC offer for ${peerId.substring(0, 8)}...`);
        
        // Send offer through bootstrap server
        this.emit('signal', {
          peerId,
          signal: {
            type: 'offer',
            sdp: offer.sdp
          }
        });
      } catch (error) {
        console.error(`❌ Failed to create WebRTC offer for ${peerId}:`, error);
        this.destroyConnection(peerId, 'offer_failed');
        throw error;
      }
    }

    return new Promise((resolve, reject) => {
      const checkConnection = () => {
        const state = this.connectionStates.get(peerId);
        if (state === 'connected') {
          clearTimeout(timeout);
          resolve(pc);
        } else if (state === 'failed' || state === 'disconnected') {
          clearTimeout(timeout);
          reject(new Error(`WebRTC connection failed: ${state}`));
        } else {
          setTimeout(checkConnection, 100);
        }
      };
      checkConnection();
    });
  }

  /**
   * Wait for an existing WebSocket connection attempt to complete (for collision handling)
   */
  async waitForWebSocketConnectionToComplete(peerId, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const checkInterval = setInterval(() => {
        const connection = this.connections.get(peerId);
        
        if (!connection || !(connection instanceof WebSocket)) {
          clearInterval(checkInterval);
          reject(new Error(`WebSocket connection to ${peerId} was removed while waiting`));
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
          reject(new Error(`WebSocket connection to ${peerId} failed while waiting`));
          return;
        }
        
        if (Date.now() - startTime > timeout) {
          clearInterval(checkInterval);
          reject(new Error(`Timeout waiting for WebSocket connection to ${peerId} to complete`));
          return;
        }
      }, 100); // Check every 100ms
    });
  }

  /**
   * Wait for an existing WebRTC connection attempt to complete (for collision handling)
   */
  async waitForWebRTCConnectionToComplete(peerId, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const checkInterval = setInterval(() => {
        const connection = this.connections.get(peerId);
        const state = this.connectionStates.get(peerId);
        
        if (!connection) {
          clearInterval(checkInterval);
          reject(new Error(`WebRTC connection to ${peerId} was removed while waiting`));
          return;
        }
        
        if (state === 'connected') {
          clearInterval(checkInterval);
          console.log(`✅ WebRTC connection to ${peerId.substring(0, 8)}... completed successfully`);
          resolve(connection);
          return;
        }
        
        if (state === 'failed' || state === 'disconnected') {
          clearInterval(checkInterval);
          reject(new Error(`WebRTC connection to ${peerId} failed while waiting`));
          return;
        }
        
        if (Date.now() - startTime > timeout) {
          clearInterval(checkInterval);
          reject(new Error(`Timeout waiting for WebRTC connection to ${peerId} to complete`));
          return;
        }
      }, 100); // Check every 100ms
    });
  }

  /**
   * Set up WebSocket connection with DHT message handling
   */
  setupWebSocketConnection(peerId, ws) {
    this.connections.set(peerId, ws);
    this.connectionTypes.set(peerId, 'websocket');
    this.connectionStates.set(peerId, 'connected');

    console.log(`📋 WebSocket connection setup complete for ${peerId.substring(0, 8)}...`);

    // Handle incoming messages
    ws.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(event.data);
        
        // Skip handshake messages
        if (message.type === 'handshake' || message.type === 'handshake_response') {
          return;
        }

        // Emit DHT message event
        this.emit('message', { peerId, message });
      } catch (error) {
        console.error(`❌ Error parsing WebSocket message from ${peerId}:`, error);
      }
    });

    // Handle connection close
    ws.addEventListener('close', (event) => {
      console.log(`🔌 WebSocket connection closed to ${peerId.substring(0, 8)}...: ${event.code} ${event.reason}`);
      this.handleConnectionClose(peerId);
    });

    // Handle connection error
    ws.addEventListener('error', (error) => {
      console.error(`❌ WebSocket error with ${peerId.substring(0, 8)}...:`, error);
    });

    // Emit connection event
    this.emit('peerConnected', { peerId });
  }

  /**
   * Set up WebRTC connection with DHT message handling
   */
  setupWebRTCConnection(peerId, pc, initiator) {
    // Handle incoming data channels (for non-initiator)
    pc.ondatachannel = (event) => {
      const dataChannel = event.channel;
      this.setupDataChannelEvents(peerId, dataChannel);
      this.dataChannels.set(peerId, dataChannel);
    };

    // Handle connection state changes
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log(`🔄 WebRTC connection state for ${peerId.substring(0, 8)}...: ${state}`);
      
      this.connectionStates.set(peerId, state);
      
      if (state === 'connected') {
        clearTimeout(pc.timeout);
        // Start keep-alive mechanism for WebRTC connections
        this.startKeepAlive(peerId);
        this.emit('peerConnected', { peerId });
      } else if (state === 'failed' || state === 'disconnected') {
        this.stopKeepAlive(peerId);
        this.handleConnectionClose(peerId);
      }
    };

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.emit('signal', {
          peerId,
          signal: {
            type: 'ice-candidate',
            candidate: event.candidate
          }
        });
      }
    };
  }

  /**
   * Set up data channel events for WebRTC
   */
  setupDataChannelEvents(peerId, dataChannel) {
    dataChannel.onopen = () => {
      console.log(`📡 WebRTC data channel opened for ${peerId.substring(0, 8)}...`);
    };

    dataChannel.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        
        // Handle keep-alive messages
        if (message.type === 'keep_alive_ping') {
          this.handleKeepAlivePing(peerId, message);
          return; // Don't emit as regular DHT message
        } else if (message.type === 'keep_alive_pong') {
          this.handleKeepAlivePong(peerId, message);
          return; // Don't emit as regular DHT message
        }
        
        // Regular DHT message
        this.emit('message', { peerId, message });
      } catch (error) {
        console.error(`❌ Error parsing WebRTC message from ${peerId}:`, error);
      }
    };

    dataChannel.onclose = () => {
      console.log(`📡 WebRTC data channel closed for ${peerId.substring(0, 8)}...`);
    };

    dataChannel.onerror = (error) => {
      console.error(`❌ WebRTC data channel error for ${peerId}:`, error);
    };
  }

  /**
   * Select transport based on peer type
   */
  async selectTransport(peerId) {
    const metadata = this.peerMetadata.get(peerId);
    
    if (metadata) {
      if (metadata.nodeType === 'nodejs') {
        return 'websocket';
      } else if (metadata.nodeType === 'browser') {
        return 'webrtc';
      }
    }

    // Default assumption: if we don't know, try WebRTC first (browser-to-browser)
    // This can be refined with better peer discovery
    console.warn(`⚠️ Unknown peer type for ${peerId}, defaulting to WebRTC`);
    return 'webrtc';
  }

  /**
   * Get WebSocket address for Node.js peer
   */
  getWebSocketAddress(peerId) {
    const metadata = this.peerMetadata.get(peerId);
    return metadata?.listeningAddress || null;
  }

  /**
   * Set peer metadata (from invitation coordination or peer discovery)
   */
  setPeerMetadata(peerId, metadata) {
    this.peerMetadata.set(peerId, metadata);
    console.log(`📋 Updated peer metadata for ${peerId.substring(0, 8)}...:`, metadata);
  }

  /**
   * Handle incoming WebRTC signals (offers, answers, ICE candidates)
   */
  async handleSignal(peerId, signal) {
    console.log(`🔄 HybridConnectionManager handling signal from ${peerId}:`, signal.type);
    
    const connectionType = this.connectionTypes.get(peerId);
    
    // Only handle WebRTC signals for WebRTC connections
    if (connectionType === 'websocket') {
      console.log(`⚠️ Ignoring WebRTC signal for WebSocket connection: ${peerId}`);
      return;
    }
    
    // For WebRTC connections, handle the signal
    if (signal.type === 'offer') {
      await this.handleWebRTCOffer(peerId, signal);
    } else if (signal.type === 'answer') {
      await this.handleWebRTCAnswer(peerId, signal);
    } else if (signal.type === 'ice-candidate' || signal.type === 'candidate') {
      await this.handleWebRTCIceCandidate(peerId, signal);
    } else {
      console.warn(`🤔 Unknown signal type from ${peerId}:`, signal.type);
    }
  }
  
  /**
   * Handle incoming WebRTC offer
   */
  async handleWebRTCOffer(peerId, signal) {
    console.log(`📥 Handling WebRTC offer from ${peerId}`);
    
    let pc = this.connections.get(peerId);
    
    // Perfect Negotiation Pattern: Determine who is polite/impolite based on node IDs
    const isPolite = this.localNodeId && this.localNodeId < peerId;
    const makingOffer = pc && pc.signalingState === 'have-local-offer';
    const ignoreOffer = !isPolite && makingOffer;
    
    console.log(`🤝 Perfect Negotiation - Role: ${isPolite ? 'POLITE' : 'IMPOLITE'} (${this.localNodeId} vs ${peerId})`);
    
    // Perfect Negotiation: Handle collision resolution
    if (ignoreOffer) {
      console.log(`💪 Perfect Negotiation - Being impolite, ignoring offer from ${peerId} (we have precedence)`);
      return;
    }
    
    if (!pc) {
      // Create new connection for incoming offer
      console.log(`📡 Creating new WebRTC connection for incoming offer from ${peerId}`);
      pc = await this.createWebRTCConnection(peerId, false); // false = not initiator
    }
    
    try {
      // Perfect Negotiation: Handle offer collision by being polite
      if (isPolite && makingOffer) {
        console.log(`🤝 Perfect Negotiation - Being polite, rolling back local offer for collision with ${peerId}`);
        await pc.setLocalDescription({ type: 'rollback' });
      }
      
      await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      
      console.log(`📤 Sending WebRTC answer to ${peerId}`);
      this.emit('signal', {
        peerId,
        signal: {
          type: 'answer',
          sdp: answer.sdp
        }
      });
      
    } catch (error) {
      console.error(`❌ Error handling WebRTC offer from ${peerId}:`, error);
      this.destroyConnection(peerId, 'offer_error');
    }
  }
  
  /**
   * Handle incoming WebRTC answer
   */
  async handleWebRTCAnswer(peerId, signal) {
    console.log(`📥 Handling WebRTC answer from ${peerId}`);
    
    const pc = this.connections.get(peerId);
    if (!pc) {
      console.warn(`⚠️ No WebRTC connection found for answer from ${peerId}`);
      return;
    }
    
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
      console.log(`✅ WebRTC answer processed from ${peerId}`);
    } catch (error) {
      console.error(`❌ Error handling WebRTC answer from ${peerId}:`, error);
      this.destroyConnection(peerId, 'answer_error');
    }
  }
  
  /**
   * Handle incoming WebRTC ICE candidate
   */
  async handleWebRTCIceCandidate(peerId, signal) {
    const pc = this.connections.get(peerId);
    if (!pc) {
      console.warn(`⚠️ No WebRTC connection found for ICE candidate from ${peerId}`);
      return;
    }
    
    try {
      await pc.addIceCandidate(signal.candidate);
      console.log(`🧊 Added ICE candidate from ${peerId}`);
    } catch (error) {
      console.error(`❌ Error adding ICE candidate from ${peerId}:`, error);
    }
  }

  /**
   * Send message to peer (supports both WebRTC and WebSocket)
   */
  async sendMessage(peerId, message) {
    const connection = this.connections.get(peerId);
    const connectionType = this.connectionTypes.get(peerId);
    
    if (!connection) {
      throw new Error(`No connection to peer ${peerId}`);
    }

    if (connectionType === 'websocket') {
      // WebSocket connection
      if (connection.readyState !== WebSocket.OPEN) {
        throw new Error(`WebSocket connection to ${peerId} is not open`);
      }
      
      connection.send(JSON.stringify(message));
      
    } else if (connectionType === 'webrtc') {
      // WebRTC connection
      const dataChannel = this.dataChannels.get(peerId);
      if (!dataChannel || dataChannel.readyState !== 'open') {
        throw new Error(`WebRTC data channel to ${peerId} is not open`);
      }
      
      dataChannel.send(JSON.stringify(message));
      
    } else {
      throw new Error(`Unknown connection type for peer ${peerId}: ${connectionType}`);
    }
  }

  /**
   * Check if peer is connected
   */
  isConnected(peerId) {
    const connection = this.connections.get(peerId);
    const connectionType = this.connectionTypes.get(peerId);
    
    if (!connection) return false;
    
    if (connectionType === 'websocket') {
      return connection.readyState === WebSocket.OPEN;
    } else if (connectionType === 'webrtc') {
      return connection.connectionState === 'connected';
    }
    
    return false;
  }

  /**
   * Get connected peer IDs
   */
  getConnectedPeers() {
    const connected = [];
    for (const [peerId, connection] of this.connections) {
      if (this.isConnected(peerId)) {
        connected.push(peerId);
      }
    }
    return connected;
  }

  /**
   * Handle connection close
   */
  handleConnectionClose(peerId) {
    // Stop keep-alive mechanism
    this.stopKeepAlive(peerId);
    
    this.connections.delete(peerId);
    this.connectionTypes.delete(peerId);
    this.connectionStates.delete(peerId);
    this.dataChannels.delete(peerId);
    this.pendingConnections.delete(peerId);

    this.emit('peerDisconnected', { peerId });
  }

  /**
   * Destroy connection
   */
  destroyConnection(peerId, reason = 'manual') {
    console.log(`Destroying connection to ${peerId} (${reason})`);
    
    const connection = this.connections.get(peerId);
    const connectionType = this.connectionTypes.get(peerId);
    
    if (connection) {
      if (connectionType === 'websocket') {
        connection.close();
      } else if (connectionType === 'webrtc') {
        clearTimeout(connection.timeout);
        connection.close();
      }
    }

    this.handleConnectionClose(peerId);
  }

  /**
   * Get connection statistics
   */
  getStats() {
    const connected = this.getConnectedPeers();
    const webrtcCount = connected.filter(peerId => this.connectionTypes.get(peerId) === 'webrtc').length;
    const websocketCount = connected.filter(peerId => this.connectionTypes.get(peerId) === 'websocket').length;
    
    return {
      type: 'hybrid',
      localNodeId: this.localNodeId,
      totalConnections: this.connections.size,
      connectedPeers: connected.length,
      connectedPeerIds: connected,
      webrtcConnections: webrtcCount,
      websocketConnections: websocketCount,
      maxConnections: this.options.maxConnections
    };
  }

  /**
   * Check WebRTC support
   */
  hasWebRTCSupport() {
    return typeof RTCPeerConnection !== 'undefined';
  }

  /**
   * Check WebSocket support
   */
  hasWebSocketSupport() {
    return typeof WebSocket !== 'undefined';
  }

  /**
   * Destroy the connection manager
   */
  destroy() {
    if (this.isDestroyed) return;

    console.log('🔥 Destroying HybridConnectionManager');
    this.isDestroyed = true;

    // Destroy all connections
    for (const [peerId, connection] of this.connections) {
      try {
        const connectionType = this.connectionTypes.get(peerId);
        if (connectionType === 'websocket') {
          connection.close();
        } else if (connectionType === 'webrtc') {
          clearTimeout(connection.timeout);
          connection.close();
        }
      } catch (error) {
        console.error(`Error closing connection to ${peerId}:`, error);
      }
    }

    // Stop all keep-alive mechanisms
    for (const [peerId, _intervalId] of this.keepAliveIntervals) {
      this.stopKeepAlive(peerId);
    }

    // Clear all data structures
    this.connections.clear();
    this.connectionTypes.clear();
    this.connectionStates.clear();
    this.dataChannels.clear();
    this.pendingConnections.clear();
    this.peerMetadata.clear();
    this.keepAliveIntervals.clear();
    this.lastPingTimes.clear();
    this.pingResponses.clear();

    // Remove all listeners
    this.removeAllListeners();

    this.emit('destroyed');
  }
}