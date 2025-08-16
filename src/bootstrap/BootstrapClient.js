import { EventEmitter } from 'events';

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
    this.reconnectAttempts = 0;
    this.currentServerIndex = 0;
    this.localNodeId = null;
    this.pendingRequests = new Map(); // requestId -> { resolve, reject, timeout }
    this.isDestroyed = false;
    this.deliberateDisconnect = false; // Track if disconnect was intentional
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
        this.ws = new WebSocket(serverUrl);
        
        const timeout = setTimeout(() => {
          this.ws?.close();
          reject(new Error('Connection timeout'));
        }, this.options.timeout);

        this.ws.onopen = () => {
          clearTimeout(timeout);
          console.log('Connected to bootstrap server');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          
          // Register with server (include metadata like public key)
          this.sendMessage({
            type: 'register',
            nodeId: this.localNodeId,
            timestamp: Date.now(),
            metadata: this.metadata || {}
          });

          this.emit('connected', { serverUrl });
          resolve();
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };

        this.ws.onclose = (event) => {
          clearTimeout(timeout);
          this.isConnected = false;
          console.log(`Bootstrap connection closed: ${event.code} ${event.reason}`);
          
          if (!this.isDestroyed) {
            this.emit('disconnected', { code: event.code, reason: event.reason });
            
            // Only auto-reconnect if this wasn't a deliberate disconnect
            if (!this.deliberateDisconnect) {
              this.scheduleReconnect();
            } else {
              console.log('Deliberate disconnect - not auto-reconnecting');
              this.deliberateDisconnect = false; // Reset flag
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

      switch (message.type) {
        case 'registered':
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
          }
          break;

        case 'error':
          console.error('Bootstrap server error:', message.error);
          this.emit('error', new Error(message.error));
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
    const request = this.pendingRequests.get(message.requestId);
    if (request) {
      clearTimeout(request.timeout);
      this.pendingRequests.delete(message.requestId);
      
      if (message.success) {
        request.resolve(message.data);
      } else {
        request.reject(new Error(message.error || 'Request failed'));
      }
    }
  }

  /**
   * Send message to bootstrap server
   */
  sendMessage(message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to bootstrap server');
    }

    this.ws.send(JSON.stringify(message));
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
        timeout: timeoutHandle
      });

      try {
        this.sendMessage(message);
      } catch (error) {
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
    try {
      const response = await this.sendRequest({
        type: 'get_peers_or_genesis',
        maxPeers,
        nodeId: this.localNodeId
      });
      
      return {
        peers: response.peers || [],
        isGenesis: response.isGenesis || false
      };
    } catch (error) {
      console.error('Error requesting peers or genesis status:', error);
      return { peers: [], isGenesis: false };
    }
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
    return this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN;
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
   * Disconnect from bootstrap server
   */
  disconnect() {
    if (this.ws) {
      this.deliberateDisconnect = true; // Mark as intentional disconnect
      this.ws.close(1000, 'Manual disconnect');
      this.ws = null;
    }
    this.isConnected = false;
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