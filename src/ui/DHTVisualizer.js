/**
 * DHT Network Visualizer and UI Controller
 */
export class DHTVisualizer {
  constructor(dht) {
    this.dht = dht;
    this.logContainer = null;
    this.isLogging = true;
    this.maxLogEntries = 1000;
    this.updateInterval = null;
    
    this.setupUI();
    this.setupEventHandlers();
    this.startPeriodicUpdates();
  }

  /**
   * Setup UI elements and event handlers
   */
  setupUI() {
    // Get UI elements
    this.elements = {
      // Status elements
      dhtStatus: document.getElementById('dht-status'),
      nodeId: document.getElementById('node-id'),
      peerCount: document.getElementById('peer-count'),
      storageCount: document.getElementById('storage-count'),
      
      // Control buttons
      startBtn: document.getElementById('start-dht'),
      stopBtn: document.getElementById('stop-dht'),
      storeBtn: document.getElementById('store-btn'),
      getBtn: document.getElementById('get-btn'),
      inviteBtn: document.getElementById('invite-btn'),
      clearLogBtn: document.getElementById('clear-log'),
      debugConnectionBtn: document.getElementById('debug-connection-btn'),
      debugPhantomBtn: document.getElementById('debug-phantom-btn'),
      
      // Input fields
      storeKey: document.getElementById('store-key'),
      storeValue: document.getElementById('store-value'),
      getKey: document.getElementById('get-key'),
      inviteNodeId: document.getElementById('invite-node-id'),
      
      // Stats
      statTotalPeers: document.getElementById('stat-total-peers'),
      statConnectedPeers: document.getElementById('stat-connected-peers'),
      statRoutingTable: document.getElementById('stat-routing-table'),
      statStorageItems: document.getElementById('stat-storage-items'),
      
      // Other
      peerList: document.getElementById('peer-list'),
      logOutput: document.getElementById('log-output'),
      startLoading: document.getElementById('start-loading'),
      wasmContainer: document.getElementById('wasm-container')
    };

    this.logContainer = this.elements.logOutput;
    
    // Set initial node ID
    if (this.dht && this.dht.localNodeId) {
      this.elements.nodeId.textContent = this.dht.localNodeId.toString();
    }
  }

  /**
   * Setup event handlers
   */
  setupEventHandlers() {
    // DHT control buttons
    this.elements.startBtn.addEventListener('click', () => this.startDHT());
    this.elements.stopBtn.addEventListener('click', () => this.stopDHT());
    
    // DHT operations
    this.elements.storeBtn.addEventListener('click', () => this.storeValue());
    this.elements.getBtn.addEventListener('click', () => this.getValue());
    this.elements.inviteBtn.addEventListener('click', () => this.inviteClient());
    
    // Log controls
    this.elements.clearLogBtn.addEventListener('click', () => this.clearLog());
    
    // Debug controls
    this.elements.debugConnectionBtn.addEventListener('click', () => this.debugConnectionState());
    this.elements.debugPhantomBtn.addEventListener('click', () => this.debugPhantomPeers());
    
    // Enter key handlers
    this.elements.storeKey.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.storeValue();
    });
    this.elements.storeValue.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.storeValue();
    });
    this.elements.getKey.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.getValue();
    });
    this.elements.inviteNodeId.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.inviteClient();
    });

    // Setup DHT event handlers
    this.setupDHTEventHandlers();
  }

  /**
   * Setup DHT-specific event handlers
   */
  setupDHTEventHandlers() {
    if (!this.dht) return;

    // Remove any existing handlers to prevent duplicates
    this.dht.removeAllListeners('started');
    this.dht.removeAllListeners('stopped');
    this.dht.removeAllListeners('peerConnected');
    this.dht.removeAllListeners('peerDisconnected');

    // DHT lifecycle events
    this.dht.on('started', () => {
      this.log('DHT started successfully', 'success');
      this.updateStatus('Running');
      this.elements.startBtn.disabled = true;
      this.elements.stopBtn.disabled = false;
      this.hideLoading();
      
      // Re-setup component event handlers after restart
      this.setupComponentEventHandlers();
      
      // Force immediate update of peer display
      setTimeout(() => {
        this.updatePeerDisplay();
        this.updateStats();
      }, 1000);
    });

    this.dht.on('stopped', () => {
      this.log('DHT stopped', 'warn');
      this.updateStatus('Stopped');
      this.elements.startBtn.disabled = false;
      this.elements.stopBtn.disabled = true;
      
      // Clear peer display when stopped
      this.updatePeerDisplay();
      this.updateStats();
    });

    this.dht.on('peerConnected', (peerId) => {
      this.log(`Peer connected: ${peerId}`, 'info');
      this.updatePeerDisplay();
      this.updateStats();
    });

    this.dht.on('peerDisconnected', (peerId) => {
      this.log(`Peer disconnected: ${peerId}`, 'warn');
      this.updatePeerDisplay();
      this.updateStats();
    });

    // Setup initial component handlers
    this.setupComponentEventHandlers();
  }

  /**
   * Setup event handlers for DHT components (WebRTC, Bootstrap)
   */
  setupComponentEventHandlers() {
    if (!this.dht) return;

    // Remove existing component listeners
    if (this.dht.bootstrap) {
      this.dht.bootstrap.removeAllListeners('connected');
      this.dht.bootstrap.removeAllListeners('disconnected');
      
      // Bootstrap events
      this.dht.bootstrap.on('connected', ({ serverUrl }) => {
        this.log(`Connected to bootstrap server: ${serverUrl}`, 'success');
      });

      this.dht.bootstrap.on('disconnected', () => {
        this.log('Disconnected from bootstrap server', 'warn');
      });
    }

    if (this.dht.connectionManager) {
      // CRITICAL FIX: Do NOT remove all listeners - this would remove the DHT's essential event handlers!
      // Instead, just check if our UI handlers are already added to avoid duplicates
      console.log('🎨 UI: Setting up connection event listeners (preserving DHT handlers)');
      
      // Store references to our handlers so we can remove them specifically if needed
      if (!this.webrtcHandlers) {
        this.webrtcHandlers = {
          peerError: ({ peerId, error }) => {
            this.log(`WebRTC error with ${peerId}: ${error.message}`, 'error');
          },
          peerConnected: ({ peerId }) => {
            this.log(`WebRTC peer connected: ${peerId}`, 'info');
            this.updatePeerDisplay();
            this.updateStats();
          },
          peerDisconnected: ({ peerId }) => {
            this.log(`WebRTC peer disconnected: ${peerId}`, 'warn');
            this.updatePeerDisplay();
            this.updateStats();
          }
        };
      }
      
      // Remove only our specific handlers before re-adding (avoid duplicates)
      this.dht.connectionManager.removeListener('peerError', this.webrtcHandlers.peerError);
      this.dht.connectionManager.removeListener('peerConnected', this.webrtcHandlers.peerConnected);
      this.dht.connectionManager.removeListener('peerDisconnected', this.webrtcHandlers.peerDisconnected);
      
      // Add our UI handlers
      this.dht.connectionManager.on('peerError', this.webrtcHandlers.peerError);
      this.dht.connectionManager.on('peerConnected', this.webrtcHandlers.peerConnected);
      this.dht.connectionManager.on('peerDisconnected', this.webrtcHandlers.peerDisconnected);
      
      console.log(`🎨 UI: Connection handlers added, total peerConnected listeners: ${this.dht.connectionManager.listenerCount('peerConnected')}`);
    }
  }

  /**
   * Start the DHT
   */
  async startDHT() {
    if (!this.dht) {
      this.log('DHT not initialized', 'error');
      return;
    }

    this.showLoading();
    this.updateStatus('Starting...');
    this.elements.startBtn.disabled = true;

    try {
      await this.dht.start();
    } catch (error) {
      this.log(`Failed to start DHT: ${error.message}`, 'error');
      this.updateStatus('Failed');
      this.elements.startBtn.disabled = false;
      this.hideLoading();
    }
  }

  /**
   * Stop the DHT
   */
  async stopDHT() {
    if (!this.dht) {
      this.log('DHT not initialized', 'error');
      return;
    }

    this.updateStatus('Stopping...');
    this.elements.stopBtn.disabled = true;

    try {
      await this.dht.stop();
    } catch (error) {
      this.log(`Failed to stop DHT: ${error.message}`, 'error');
    }
  }

  /**
   * Store a key-value pair
   */
  async storeValue() {
    const key = this.elements.storeKey.value.trim();
    const value = this.elements.storeValue.value.trim();

    if (!key || !value) {
      this.log('Please provide both key and value', 'warn');
      return;
    }

    if (!this.dht || !this.dht.isStarted) {
      this.log('DHT not started', 'error');
      return;
    }

    try {
      this.log(`Storing: ${key} = ${value}`, 'info');
      const success = await this.dht.store(key, value);
      
      if (success) {
        this.log(`Successfully stored: ${key}`, 'success');
        this.elements.storeKey.value = '';
        this.elements.storeValue.value = '';
      } else {
        this.log(`Failed to store: ${key}`, 'error');
      }
    } catch (error) {
      this.log(`Store operation failed: ${error.message}`, 'error');
    }
  }

  /**
   * Retrieve a value by key
   */
  async getValue() {
    const key = this.elements.getKey.value.trim();

    if (!key) {
      this.log('Please provide a key to retrieve', 'warn');
      return;
    }

    if (!this.dht || !this.dht.isStarted) {
      this.log('DHT not started', 'error');
      return;
    }

    try {
      this.log(`Retrieving: ${key}`, 'info');
      const value = await this.dht.get(key);
      
      if (value !== null) {
        this.log(`Retrieved: ${key} = ${value}`, 'success');
      } else {
        this.log(`Key not found: ${key}`, 'warn');
      }
    } catch (error) {
      this.log(`Get operation failed: ${error.message}`, 'error');
    }
  }

  /**
   * Invite a new client to join the DHT
   */
  async inviteClient() {
    const clientId = this.elements.inviteNodeId.value.trim();

    if (!clientId) {
      this.log('Please provide a client node ID to invite', 'warn');
      return;
    }

    if (!this.dht || !this.dht.isStarted) {
      this.log('DHT not started', 'error');
      return;
    }

    try {
      this.log(`Inviting client to join DHT: ${clientId}`, 'info');
      const result = await this.dht.inviteNewClient(clientId);
      
      if (result) {
        this.log(`Successfully invited ${clientId} to join DHT`, 'success');
        this.elements.inviteNodeId.value = '';
      } else {
        this.log(`Failed to invite ${clientId} to join DHT`, 'error');
      }
    } catch (error) {
      this.log(`Invitation failed: ${error.message}`, 'error');
    }
  }

  /**
   * Update DHT status display
   */
  updateStatus(status) {
    if (this.elements.dhtStatus) {
      this.elements.dhtStatus.textContent = status;
    }
  }

  /**
   * Show loading indicator
   */
  showLoading() {
    if (this.elements.startLoading) {
      this.elements.startLoading.style.display = 'inline-block';
    }
  }

  /**
   * Hide loading indicator
   */
  hideLoading() {
    if (this.elements.startLoading) {
      this.elements.startLoading.style.display = 'none';
    }
  }

  /**
   * Start periodic UI updates
   */
  startPeriodicUpdates() {
    this.updateInterval = setInterval(() => {
      this.updateStats();
      this.updatePeerDisplay();
    }, 1000); // Update every 1 second for more responsive UI
  }

  /**
   * Update statistics display
   */
  updateStats() {
    if (!this.dht) return;

    try {
      const stats = this.dht.getStats();
      
      // Get current counts
      const directConnectedPeers = this.dht.connectionManager ? this.dht.connectionManager.getConnectedPeers() : [];
      const routingTableNodes = this.dht.routingTable ? this.dht.routingTable.getAllNodes() : [];
      
      // Update counters - use direct WebRTC count for accuracy
      this.elements.peerCount.textContent = directConnectedPeers.length;
      this.elements.storageCount.textContent = stats.storage.keys;
      
      // Update detailed stats - use direct counts
      this.elements.statTotalPeers.textContent = stats.webrtc.total;
      this.elements.statConnectedPeers.textContent = directConnectedPeers.length;
      this.elements.statRoutingTable.textContent = routingTableNodes.length;
      this.elements.statStorageItems.textContent = stats.storage.keys;
      
      
    } catch (error) {
      console.warn('Error updating stats:', error);
    }
  }

  /**
   * Update peer list display
   */
  updatePeerDisplay() {
    if (!this.dht || !this.elements.peerList) return;

    try {
      const connectedPeers = this.dht.connectionManager ? this.dht.connectionManager.getConnectedPeers() : [];
      const dhtStarted = this.dht.isStarted;
      const routingTableNodes = this.dht.routingTable ? this.dht.routingTable.getAllNodes() : [];
      
      // Get ALL connected peers for debugging (including filtered ones)
      const allConnectedPeers = this.dht.connectionManager ? Array.from(this.dht.connectionManager.connections.keys()).filter(peerId => {
        const conn = this.dht.connectionManager.connections.get(peerId);
        return conn && conn.open;
      }) : [];
      
      
      if (!dhtStarted) {
        this.elements.peerList.innerHTML = '<div class="wasm-placeholder">DHT not started</div>';
        return;
      }
      
      if (connectedPeers.length === 0) {
        // Show more detailed info when no connections but routing table has entries
        if (routingTableNodes.length > 0) {
          this.elements.peerList.innerHTML = `<div class="wasm-placeholder">No WebRTC connections (${routingTableNodes.length} in routing table)</div>`;
        } else if (allConnectedPeers.length > 0) {
          this.elements.peerList.innerHTML = `<div class="wasm-placeholder">No valid DHT peers (${allConnectedPeers.length} filtered connections)</div>`;
        } else {
          this.elements.peerList.innerHTML = '<div class="wasm-placeholder">No peers connected</div>';
        }
        return;
      }

      const peerElements = connectedPeers.map(peerId => {
        const isConnected = this.dht.connectionManager.isConnected(peerId);
        const statusClass = isConnected ? 'connected' : 'disconnected';
        const statusText = isConnected ? 'connected' : 'disconnected';
        
        
        return `
          <div class="peer-item">
            <span class="peer-id">${peerId}</span>
            <span class="peer-status ${statusClass}">${statusText}</span>
          </div>
        `;
      }).join('');

      this.elements.peerList.innerHTML = peerElements;
      
    } catch (error) {
      console.warn('Error updating peer display:', error);
      this.elements.peerList.innerHTML = '<div class="wasm-placeholder">Error loading peers</div>';
    }
  }

  /**
   * Log a message to the UI
   */
  log(message, level = 'info') {
    if (!this.isLogging || !this.logContainer) return;

    const timestamp = new Date().toLocaleTimeString();
    const logEntry = document.createElement('div');
    logEntry.className = 'log-entry';
    
    logEntry.innerHTML = `
      <span class="log-timestamp">[${timestamp}]</span>
      <span class="log-level-${level}">${message}</span>
    `;

    this.logContainer.appendChild(logEntry);
    
    // Limit log entries
    while (this.logContainer.children.length > this.maxLogEntries) {
      this.logContainer.removeChild(this.logContainer.firstChild);
    }
    
    // Auto-scroll to bottom
    this.logContainer.scrollTop = this.logContainer.scrollHeight;
    
    // Also log to console
    console.log(`[DHT UI] ${message}`);
  }

  /**
   * Clear the log
   */
  clearLog() {
    if (this.logContainer) {
      this.logContainer.innerHTML = '';
    }
  }

  /**
   * Initialize WebAssembly UI components
   */
  async initializeWASM() {
    try {
      // This is a placeholder for WebAssembly initialization
      // In a real implementation, you would load and initialize the WASM module here
      
      this.log('Initializing WebAssembly UI components...', 'info');
      
      // Simulate WASM loading
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Update WASM container
      if (this.elements.wasmContainer) {
        this.elements.wasmContainer.innerHTML = `
          <div style="text-align: center; color: #28a745;">
            <strong>✓ WebAssembly UI Loaded</strong><br>
            <small>Advanced DHT visualization ready</small>
          </div>
        `;
      }
      
      this.log('WebAssembly UI components loaded successfully', 'success');
    } catch (error) {
      this.log(`Failed to load WebAssembly UI: ${error.message}`, 'error');
    }
  }

  /**
   * Get current UI state
   */
  getUIState() {
    return {
      dhtStarted: this.dht ? this.dht.isStarted : false,
      peerCount: this.dht ? this.dht.connectionManager.getConnectedPeers().length : 0,
      storageCount: this.dht ? this.dht.storage.size : 0,
      isLogging: this.isLogging
    };
  }

  /**
   * Toggle logging
   */
  toggleLogging() {
    this.isLogging = !this.isLogging;
    this.log(`Logging ${this.isLogging ? 'enabled' : 'disabled'}`, 'info');
  }

  /**
   * Force refresh all UI elements (useful for debugging)
   */
  forceRefresh() {
    this.updateStats();
    this.updatePeerDisplay();
    
    // Re-setup event handlers in case they got disconnected
    this.setupComponentEventHandlers();
    
    // Update node ID display
    if (this.dht && this.dht.localNodeId) {
      this.elements.nodeId.textContent = this.dht.localNodeId.toString();
    }
    
    this.log('UI force refreshed', 'info');
  }

  /**
   * Cleanup and destroy
   */
  destroy() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    
    this.isLogging = false;
    this.log('UI visualizer destroyed', 'warn');
  }

  /**
   * Debug DHT WebRTC signaling status
   */
  async debugConnectionState() {
    this.log('🔍 Debugging DHT WebRTC Signaling...', 'info');
    try {
      if (!window.YZSocialC || !window.YZSocialC.dht) {
        this.log('DHT not available', 'error');
        return;
      }
      
      const dht = window.YZSocialC.dht;
      const nodeId = dht.localNodeId.toString();
      
      this.log(`🆔 Local Node ID: ${nodeId.substring(0, 8)}...`, 'info');
      this.log(`🌐 Signaling Mode: ${dht.useBootstrapForSignaling ? 'Bootstrap' : 'DHT'}`, 'info');
      this.log(`🔗 Connected Peers: ${dht.connectionManager.getConnectedPeers().length}`, 'info');
      this.log(`📋 Routing Table Size: ${dht.routingTable.getAllNodes().length}`, 'info');
      
      // Check for stored WebRTC signaling data in DHT
      const allNodes = dht.routingTable.getAllNodes();
      this.log('📨 Checking DHT for WebRTC signaling data:', 'info');
      
      let signalingFound = 0;
      for (const node of allNodes) {
        const peerId = node.id.toString();
        if (peerId === nodeId) continue;
        
        try {
          // Check for offers
          const offerKey = `webrtc_offer:${nodeId}:${peerId}`;
          const offerData = await dht.get(offerKey).catch(() => null);
          
          const incomingOfferKey = `webrtc_offer:${peerId}:${nodeId}`;
          const incomingOffer = await dht.get(incomingOfferKey).catch(() => null);
          
          // Check for answers
          const answerKey = `webrtc_answer:${peerId}:${nodeId}`;
          const answerData = await dht.get(answerKey).catch(() => null);
          
          const connected = dht.connectionManager.isConnected(peerId);
          
          this.log(`👤 Peer ${peerId.substring(0, 8)}: Offer=${!!offerData} InOffer=${!!incomingOffer} Answer=${!!answerData} Connected=${connected}`, 
                   connected ? 'success' : 'warn');
          
          if (offerData || incomingOffer || answerData) signalingFound++;
        } catch (error) {
          this.log(`Error checking peer ${peerId.substring(0, 8)}: ${error.message}`, 'error');
        }
      }
      
      this.log(`🔍 DHT signaling active: ${dht.isDHTSignaling}`, 'info');
      this.log(`📡 Bootstrap connected: ${dht.bootstrap && dht.bootstrap.isConnected()}`, 'info');
      this.log(`✅ Found ${signalingFound} peers with DHT signaling data`, 'success');
      
    } catch (error) {
      this.log(`DHT signaling debug failed: ${error.message}`, 'error');
    }
  }

  /**
   * Force peer discovery and connection attempts
   */
  async debugPhantomPeers() {
    this.log('🔄 Forcing peer discovery and connections...', 'info');
    try {
      if (!window.YZSocialC || !window.YZSocialC.dht) {
        this.log('DHT not available', 'error');
        return;
      }
      
      const initialConnections = window.YZSocialC.dht.connectionManager.getConnectedPeers().length;
      const initialRouting = window.YZSocialC.dht.routingTable.getAllNodes().length;
      
      this.log(`📊 Initial: ${initialConnections} connected, ${initialRouting} in routing table`, 'info');
      
      // Trigger bucket refresh to discover peers
      this.log('🔄 Running bucket refresh...', 'info');
      if (window.YZSocialC.refreshBuckets) {
        await window.YZSocialC.refreshBuckets();
      }
      
      // Wait for discovery
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Trigger peer discovery to attempt connections
      this.log('🔍 Running peer discovery...', 'info');
      if (window.YZSocialC.triggerPeerDiscovery) {
        await window.YZSocialC.triggerPeerDiscovery();
      }
      
      const finalConnections = window.YZSocialC.dht.connectionManager.getConnectedPeers().length;
      const finalRouting = window.YZSocialC.dht.routingTable.getAllNodes().length;
      
      this.log(`📊 Final: ${finalConnections} connected (+${finalConnections - initialConnections}), ${finalRouting} in routing table (+${finalRouting - initialRouting})`, 
               (finalConnections > initialConnections) ? 'success' : 'warn');
      
      this.log('✅ Forced discovery completed', 'success');
      
    } catch (error) {
      this.log(`Forced discovery failed: ${error.message}`, 'error');
    }
  }
}