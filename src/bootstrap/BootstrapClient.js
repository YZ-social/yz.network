import { EventEmitter } from 'events';
import { PROTOCOL_VERSION, BUILD_ID } from '../version.js';

// Polyfill WebSocket for Node.js environment
let WebSocketImpl;
if (typeof WebSocket === 'undefined') {
  // Node.js environment - dynamically import 'ws' package
  const wsModule = await import('ws');
  WebSocketImpl = wsModule.default || wsModule.WebSocket || wsModule;
  console.log('🔧 Using ws package for WebSocket in Node.js');
} else {
  // Browser environment - use native WebSocket
  WebSocketImpl = WebSocket;
}

/**
 * Bootstrap client for initial peer discovery
 * Connects to bootstrap server only for initial signaling
 */
export class BootstrapClient extends EventEmitter {
  constructor(options = {}) {
    super();

    this.options = {
      bootstrapServers: options.bootstrapServers || ['ws://localhost:8080'],
      reconnectInterval: options.reconnectInterval || 5000,
      maxReconnectAttempts: options.maxReconnectAttempts || 10,
      timeout: options.timeout || 30000,
      ...options
    };

    this.ws = null;
    this.isConnected = false;
    this.isRegistered = false; // Track registration state separately from connection
    this.reconnectAttempts = 0;
    this.currentServerIndex = 0;
    this.localNodeId = null;
    this.pendingRequests = new Map(); // requestId -> { resolve, reject, timeout }
    this.isDestroyed = false;
    this.deliberateDisconnect = false; // Track if disconnect was intentional
    this.autoReconnectEnabled = true; // NEW: Control auto-reconnect behavior
  }

  /**
   * Connect to bootstrap server
   */
  async connect(localNodeId, metadata = {}) {
    this.localNodeId = localNodeId;

    if (this.isDestroyed) {
      throw new Error('BootstrapClient is destroyed');
    }

    this.metadata = metadata; // Store metadata (e.g., public key) to send during registration
    return this.attemptConnection();
  }

  /**
   * Attempt connection to next available server
   */
  async attemptConnection() {
    const serverUrl = this.options.bootstrapServers[this.currentServerIndex];
    console.log(`Connecting to bootstrap server: ${serverUrl}`);

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocketImpl(serverUrl);

        const timeout = setTimeout(() => {
          this.ws?.close();
          reject(new Error('Connection timeout'));
        }, this.options.timeout);

        this.ws.onopen = () => {
          clearTimeout(timeout);
          console.log('Connected to bootstrap server');
          this.isConnected = true;
          this.reconnectAttempts = 0;

          // Small delay to ensure WebSocket is fully ready
          setTimeout(() => {
            try {
              // Register with server (include metadata like public key, protocol version, and build ID)
              this.sendMessage({
                type: 'register',
                nodeId: this.localNodeId,
                protocolVersion: PROTOCOL_VERSION,
                buildId: BUILD_ID,
                timestamp: Date.now(),
                metadata: this.metadata || {}
              });
            } catch (error) {
              console.error('Failed to send registration message:', error);
              this.ws.close();
              reject(error);
              return;
            }
          }, 10); // 10ms delay to ensure WebSocket is fully ready

          this.emit('connected', { serverUrl });
          resolve();
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };

        this.ws.onclose = (event) => {
          clearTimeout(timeout);
          this.isConnected = false;
          this.isRegistered = false; // Reset registration state on disconnect
          console.log(`Bootstrap connection closed: ${event.code} ${event.reason}`);

          if (!this.isDestroyed) {
            this.emit('disconnected', { code: event.code, reason: event.reason });

            // Only auto-reconnect if enabled and this wasn't a deliberate disconnect
            if (!this.deliberateDisconnect && this.autoReconnectEnabled) {
              this.scheduleReconnect();
            } else {
              if (this.deliberateDisconnect) {
                console.log('Deliberate disconnect - not auto-reconnecting');
                this.deliberateDisconnect = false; // Reset flag
              }
              if (!this.autoReconnectEnabled) {
                console.log('Auto-reconnect disabled - staying disconnected');
              }
            }
          }
        };

        this.ws.onerror = (error) => {
          clearTimeout(timeout);
          console.error('Bootstrap connection error:', error);

          if (!this.isConnected) {
            reject(error);
          } else {
            // Safely emit error with proper error object
            try {
              this.emit('error', error instanceof Error ? error : new Error('WebSocket connection error'));
            } catch (emitError) {
              console.error('Error emitting bootstrap error:', emitError);
            }
          }
        };

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Handle incoming message from bootstrap server
   */
  handleMessage(data) {
    try {
      const message = JSON.parse(data);

      // Handle messages without type (likely connection/registration confirmations)
      if (!message.type) {
        return;
      }

      // Debug: Log all incoming message types
      console.log(`📥 [Bootstrap] Received message type: ${message.type}`);

      switch (message.type) {
        case 'registered':
          this.isRegistered = true; // Mark as registered when confirmation received
          this.emit('registered', message);
          break;

        case 'peer_list':
          this.emit('peerList', message.peers || []);
          break;

        case 'peers':
          // Handle alternative peers message format
          this.emit('peerList', message.peers || message.data?.peers || []);
          break;

        case 'signal':
          this.emit('signal', {
            fromPeer: message.fromPeer,
            toPeer: message.toPeer,
            signal: message.signal
          });
          break;

        case 'response':
          this.handleResponse(message);
          // Also check if this is a peer list response
          if (message.data && message.data.peers) {
            this.emit('peerList', message.data.peers);

            // CRITICAL: Check if peers contain bridge nodes that need connection
            const bridgeNodes = message.data.peers.filter(peer =>
              peer.metadata && peer.metadata.isBridgeNode && peer.metadata.listeningAddress
            );

            if (bridgeNodes.length > 0) {
              console.log(`🌉 Bootstrap response contains ${bridgeNodes.length} bridge nodes - emitting bridge connection event`);
              this.emit('bridgeNodesReceived', {
                bridgeNodes,
                isGenesis: message.data.isGenesis,
                membershipToken: message.data.membershipToken
              });
            }
          }
          break;

        case 'error':
          console.error('Bootstrap server error:', message.error);
          this.emit('error', new Error(message.error));
          break;

        case 'version_mismatch':
          console.error(`❌ Protocol version mismatch: ${message.message}`);
          console.error(`   Your version: ${message.clientVersion}, Server version: ${message.serverVersion}`);
          console.error(`   Please refresh your browser to get the latest version.`);
          this.emit('versionMismatch', {
            clientVersion: message.clientVersion,
            serverVersion: message.serverVersion,
            message: message.message
          });
          // Close connection - we can't continue with mismatched versions
          this.ws?.close(4001, 'Version mismatch');
          break;

        case 'peer_available':
          this.emit('peerAvailable', message);
          break;

        case 'peer_joining':
          this.emit('peerJoining', message);
          break;

        case 'invitation_received':
          this.emit('invitationReceived', message);
          break;

        case 'webrtc_start_offer':
          this.emit('webrtcStartOffer', message);
          break;

        case 'webrtc_expect_offer':
          this.emit('webrtcExpectOffer', message);
          break;

        case 'websocket_peer_metadata':
          this.emit('websocketPeerMetadata', message);
          break;

        case 'bridge_invitation_request':
          this.emit('bridgeInvitationRequest', message);
          break;

        case 'bridge_connection_status':
          this.emit('bridgeConnectionStatus', message);
          break;

        case 'connect_to_bridge':
          this.emit('connectToBridge', message);
          break;

        case 'genesis_response':
          // Temporary response from bootstrap while setting up genesis connection
          console.log('🌟 Received genesis response from bootstrap server');
          console.log(`   Status: ${message.message || 'Genesis peer registered'}`);
          // Don't emit event - wait for final 'response' message with bridge details
          break;

        case 'auth_challenge':
          console.log('🔐 Received authentication challenge from bootstrap server');
          this.emit('authChallenge', message);
          break;

        case 'auth_success':
          console.log('✅ Bootstrap authentication successful');
          this.emit('authSuccess', message);
          break;

        case 'auth_failure':
          console.error('❌ Bootstrap authentication failed:', message.reason);
          this.emit('authFailure', message);
          break;

        default:
          console.warn('Unknown bootstrap message type:', message.type);
      }
    } catch (error) {
      console.error('Error parsing bootstrap message:', error);
    }
  }

  /**
   * Handle response to pending request
   */
  handleResponse(message) {
    console.log(`📥 Processing response for request ${message.requestId}:`, {
      success: message.success,
      hasData: !!message.data,
      error: message.error
    });
    
    const request = this.pendingRequests.get(message.requestId);
    if (request) {
      clearTimeout(request.timeout);
      this.pendingRequests.delete(message.requestId);

      if (message.success) {
        console.log(`✅ Request ${message.requestId} succeeded`);
        request.resolve(message.data);
      } else {
        console.error(`❌ Request ${message.requestId} failed:`, message.error);
        request.reject(new Error(message.error || 'Request failed'));
      }
    } else {
      console.warn(`⚠️ Received response for unknown request ${message.requestId}`);
    }
  }

  /**
   * Send message to bootstrap server
   */
  sendMessage(message) {
    // WebSocket.OPEN = 1 (use constant to avoid WebSocket reference)
    if (!this.ws || this.ws.readyState !== 1) {
      throw new Error(`Not connected to bootstrap server (readyState: ${this.ws ? this.ws.readyState : 'null'})`);
    }

    try {
      this.ws.send(JSON.stringify(message));
    } catch (error) {
      console.error('Failed to send message to bootstrap server:', error);
      throw new Error(`Failed to send message: ${error.message}`);
    }
  }

  /**
   * Send request with response handling
   */
  async sendRequest(message, timeout = 10000) {
    const requestId = this.generateRequestId();
    message.requestId = requestId;

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error('Request timeout'));
      }, timeout);

      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeout: timeoutHandle,
        messageType: message.type,
        timestamp: Date.now()
      });
      
      console.log(`📋 Tracking request ${requestId} (${message.type}), ${this.pendingRequests.size} pending`);
      
      // Debug: Log pending requests after 5 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          console.warn(`⏰ Request ${requestId} (${message.type}) still pending after 5s...`);
        }
      }, 5000);

      try {
        console.log(`📤 Sending request ${message.type} (ID: ${requestId}) with ${timeout}ms timeout`);
        this.sendMessage(message);
      } catch (error) {
        console.error(`❌ Failed to send request ${message.type}:`, error);
        clearTimeout(timeoutHandle);
        this.pendingRequests.delete(requestId);
        reject(error);
      }
    });
  }

  /**
   * Request list of available peers or genesis status
   */
  async requestPeersOrGenesis(maxPeers = 20) {
    const maxRetries = 3;
    const retryDelay = 5000; // 5 seconds between retries

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🔄 Requesting peers/genesis (attempt ${attempt}/${maxRetries})...`);
        
        // Use longer timeout for genesis setup (bridge connection takes time)
        const response = await this.sendRequest({
          type: 'get_peers_or_genesis',
          maxPeers,
          nodeId: this.localNodeId,
          metadata: this.metadata || {}
        }, 30000); // 30 second timeout for genesis/bridge setup

        console.log(`✅ Bootstrap request successful on attempt ${attempt}`);
        return {
          peers: response.peers || [],
          isGenesis: response.isGenesis || false,
          membershipToken: response.membershipToken || null,
          onboardingHelper: response.onboardingHelper || null,
          status: response.status || null
        };
      } catch (error) {
        console.warn(`⚠️ Bootstrap request attempt ${attempt}/${maxRetries} failed:`, error.message);
        
        if (attempt < maxRetries) {
          console.log(`⏳ Waiting ${retryDelay/1000}s before retry...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        } else {
          console.error('❌ All bootstrap request attempts failed:', error);
        }
      }
    }

    // All retries failed
    return { peers: [], isGenesis: false, membershipToken: null, onboardingHelper: null };
  }

  /**
   * Request list of available peers (legacy method)
   */
  async requestPeers(maxPeers = 20) {
    try {
      const response = await this.sendRequest({
        type: 'get_peers',
        maxPeers,
        nodeId: this.localNodeId
      });

      return response.peers || [];
    } catch (error) {
      console.error('Error requesting peers:', error);
      return [];
    }
  }

  /**
   * Send invitation token via bootstrap server
   */
  async sendInvitation(inviteeNodeId, invitationToken, timeout = 30000) {
    try {
      const response = await this.sendRequest({
        type: 'send_invitation',
        targetPeerId: inviteeNodeId,  // Changed from inviteeNodeId to match server expectation
        invitationToken,
        inviterNodeId: this.localNodeId
      }, timeout);

      return { success: true, data: response };
    } catch (error) {
      console.error('Error sending invitation:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Forward signaling data through bootstrap server
   */
  async forwardSignal(toPeer, signal) {
    try {
      await this.sendRequest({
        type: 'forward_signal',
        fromPeer: this.localNodeId,
        toPeer,
        signal
      });
      return true;
    } catch (error) {
      console.error('Error forwarding signal:', error);
      return false;
    }
  }

  /**
   * Announce that we no longer need bootstrap server
   */
  async announceIndependent() {
    try {
      await this.sendRequest({
        type: 'announce_independent',
        nodeId: this.localNodeId
      });
      console.log('Announced independence from bootstrap server');
    } catch (error) {
      console.warn('Error announcing independence:', error);
    }
  }

  /**
   * Look up if a specific peer is online
   */
  async lookupPeer(targetPeerId) {
    try {
      const response = await this.sendRequest({
        type: 'lookup_peer',
        targetPeerId
      });
      return response;
    } catch (error) {
      console.error('Error looking up peer:', error);
      return { online: false };
    }
  }

  /**
   * Wait for a specific peer to come online
   */
  async waitForPeer(targetPeerId) {
    try {
      const response = await this.sendRequest({
        type: 'wait_for_peer',
        targetPeerId
      });
      return response;
    } catch (error) {
      console.error('Error waiting for peer:', error);
      return { status: 'error' };
    }
  }

  /**
   * Attempt to join a specific peer
   */
  async joinPeer(targetPeerId) {
    try {
      const response = await this.sendRequest({
        type: 'join_peer',
        targetPeerId
      });
      return response;
    } catch (error) {
      console.error('Error joining peer:', error);
      return { status: 'error' };
    }
  }

  /**
   * Schedule reconnection attempt
   */
  scheduleReconnect() {
    if (this.isDestroyed || this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      console.log('Max reconnection attempts reached');
      this.emit('maxReconnectAttemptsReached');
      return;
    }

    this.reconnectAttempts++;

    // Try next server
    this.currentServerIndex = (this.currentServerIndex + 1) % this.options.bootstrapServers.length;


    setTimeout(() => {
      if (!this.isDestroyed && !this.isConnected) {
        this.attemptConnection().catch(error => {
          console.error('Reconnection failed:', error);
        });
      }
    }, this.options.reconnectInterval);
  }

  /**
   * Generate unique request ID
   */
  generateRequestId() {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Check if connected to bootstrap server
   */
  isBootstrapConnected() {
    // WebSocket.OPEN = 1 (use constant to avoid WebSocket reference)
    return this.isConnected && this.ws && this.ws.readyState === 1;
  }

  /**
   * Check if registered with bootstrap server (connection + registration complete)
   */
  isBootstrapRegistered() {
    return this.isRegistered && this.isBootstrapConnected();
  }

  /**
   * Get connection status
   */
  getStatus() {
    return {
      connected: this.isConnected,
      currentServer: this.options.bootstrapServers[this.currentServerIndex],
      reconnectAttempts: this.reconnectAttempts,
      pendingRequests: this.pendingRequests.size,
      destroyed: this.isDestroyed
    };
  }

  /**
   * Disable automatic reconnection (used when switching to DHT signaling)
   */
  disableAutoReconnect() {
    console.log('🔒 Bootstrap auto-reconnect disabled');
    this.autoReconnectEnabled = false;
  }

  /**
   * Enable automatic reconnection (used when explicitly needing bootstrap)
   */
  enableAutoReconnect() {
    console.log('🔓 Bootstrap auto-reconnect enabled');
    this.autoReconnectEnabled = true;
  }

  /**
   * Disconnect from bootstrap server
   */
  disconnect() {
    if (this.ws) {
      this.deliberateDisconnect = true; // Mark as intentional disconnect
      this.ws.close(1000, 'Manual disconnect');
      this.ws = null;
    }
    this.isConnected = false;
    this.isRegistered = false; // Reset registration state on manual disconnect
  }

  /**
   * Destroy the bootstrap client
   */
  destroy() {
    if (this.isDestroyed) return;

    console.log('Destroying BootstrapClient');
    this.isDestroyed = true;

    // Clear pending requests
    for (const [_requestId, request] of this.pendingRequests.entries()) {
      clearTimeout(request.timeout);
      request.reject(new Error('BootstrapClient destroyed'));
    }
    this.pendingRequests.clear();

    // Close connection
    this.disconnect();

    // Remove all listeners
    this.removeAllListeners();

    this.emit('destroyed');
  }
}