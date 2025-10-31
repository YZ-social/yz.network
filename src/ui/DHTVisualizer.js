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
      runAllTestsBtn: document.getElementById('run-all-tests-btn'),

      // Test buttons
      testBootstrapBtn: document.getElementById('test-bootstrap-btn'),
      testInvitationBtn: document.getElementById('test-invitation-btn'),
      testConnectionBtn: document.getElementById('test-connection-btn'),
      testStorageBtn: document.getElementById('test-storage-btn'),
      testRoutingBtn: document.getElementById('test-routing-btn'),
      testDiscoveryBtn: document.getElementById('test-discovery-btn'),
      testMaintenanceBtn: document.getElementById('test-maintenance-btn'),
      testReconnectionBtn: document.getElementById('test-reconnection-btn'),

      // Test status indicators
      testBootstrapStatus: document.getElementById('test-bootstrap-status'),
      testInvitationStatus: document.getElementById('test-invitation-status'),
      testConnectionStatus: document.getElementById('test-connection-status'),
      testStorageStatus: document.getElementById('test-storage-status'),
      testRoutingStatus: document.getElementById('test-routing-status'),
      testDiscoveryStatus: document.getElementById('test-discovery-status'),
      testMaintenanceStatus: document.getElementById('test-maintenance-status'),
      testReconnectionStatus: document.getElementById('test-reconnection-status'),

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

    // Test controls
    if (this.elements.runAllTestsBtn) {
      this.elements.runAllTestsBtn.addEventListener('click', () => this.runAllTests());
    }
    if (this.elements.testBootstrapBtn) {
      this.elements.testBootstrapBtn.addEventListener('click', () => this.runBootstrapTest());
    }
    if (this.elements.testInvitationBtn) {
      this.elements.testInvitationBtn.addEventListener('click', () => this.runInvitationTest());
    }
    if (this.elements.testConnectionBtn) {
      this.elements.testConnectionBtn.addEventListener('click', () => this.runConnectionTest());
    }
    if (this.elements.testStorageBtn) {
      this.elements.testStorageBtn.addEventListener('click', () => this.runStorageTest());
    }
    if (this.elements.testRoutingBtn) {
      this.elements.testRoutingBtn.addEventListener('click', () => this.runRoutingTest());
    }
    if (this.elements.testDiscoveryBtn) {
      this.elements.testDiscoveryBtn.addEventListener('click', () => this.runDiscoveryTest());
    }
    if (this.elements.testMaintenanceBtn) {
      this.elements.testMaintenanceBtn.addEventListener('click', () => this.runMaintenanceTest());
    }
    if (this.elements.testReconnectionBtn) {
      this.elements.testReconnectionBtn.addEventListener('click', () => this.runReconnectionTest());
    }

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

      // Get current counts using DHT's connection-agnostic method
      const routingTableNodes = this.dht.routingTable ? this.dht.routingTable.getAllNodes() : [];
      let connectedPeersCount = 0;
      try {
        connectedPeersCount = this.dht.getConnectedPeers().length;
      } catch (error) {
        console.warn('Error getting connected peers count in updateStats:', error);
        connectedPeersCount = 0;
      }

      // Update counters - show connected peers in status for consistency
      this.elements.peerCount.textContent = connectedPeersCount;
      this.elements.storageCount.textContent = stats.storage.keys;

      // Update detailed stats - fix inconsistency by using connected peers for both
      // This addresses the issue where Status showed 4 peers but Network Statistics showed 3
      this.elements.statTotalPeers.textContent = connectedPeersCount; // FIXED: was routingTableNodes.length
      this.elements.statConnectedPeers.textContent = connectedPeersCount;
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
      const dhtStarted = this.dht.isStarted;
      const routingTableNodes = this.dht.routingTable ? this.dht.routingTable.getAllNodes() : [];

      // Get connected nodes using per-node connection status (NEW ARCHITECTURE)
      const connectedNodes = routingTableNodes.filter(node => node.isConnected());
      const connectedPeers = connectedNodes.map(node => node.id.toString());


      if (!dhtStarted) {
        this.elements.peerList.innerHTML = '<div class="wasm-placeholder">DHT not started</div>';
        return;
      }

      if (connectedPeers.length === 0) {
        // Show more detailed info when no connections but routing table has entries
        if (routingTableNodes.length > 0) {
          const disconnectedNodes = routingTableNodes.length - connectedPeers.length;
          this.elements.peerList.innerHTML = `<div class="wasm-placeholder">No connections (${routingTableNodes.length} in routing table, ${disconnectedNodes} disconnected)</div>`;
        } else {
          this.elements.peerList.innerHTML = '<div class="wasm-placeholder">No peers connected</div>';
        }
        return;
      }

      const peerElements = connectedPeers.map(peerId => {
        // Find the corresponding node to get connection details
        const node = routingTableNodes.find(n => n.id.toString() === peerId);
        const isConnected = node ? node.isConnected() : false;
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
    let peerCount = 0;
    if (this.dht) {
      try {
        peerCount = this.dht.getConnectedPeers().length;
      } catch (error) {
        console.warn('Error getting connected peers count:', error);
        peerCount = 0;
      }
    }

    return {
      dhtStarted: this.dht ? this.dht.isStarted : false,
      peerCount,
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
   * Helper method to update test status indicator
   */
  updateTestStatus(testName, status) {
    const statusElement = this.elements[`test${testName}Status`];
    if (statusElement) {
      statusElement.textContent = status;
      statusElement.className = `status-indicator ${status.toLowerCase()}`;
    }
  }

  /**
   * Run all tests
   */
  async runAllTests() {
    this.log('🧪 Running All Tests...', 'info');

    try {
      if (!window.YZSocialC) {
        this.log('YZSocialC not available', 'error');
        return;
      }

      const results = await window.YZSocialC.runAllTests();

      // Update status indicators based on results
      for (const [testName, result] of Object.entries(results)) {
        const formattedName = testName.charAt(0).toUpperCase() + testName.slice(1);
        this.updateTestStatus(formattedName, result.success ? 'passed' : 'failed');

        this.log(`${formattedName} Test: ${result.success ? 'PASSED' : 'FAILED'} - ${result.message}`,
                 result.success ? 'success' : 'error');
      }

    } catch (error) {
      this.log(`All tests failed: ${error.message}`, 'error');
    }
  }

  /**
   * Run Bootstrap Test
   */
  async runBootstrapTest() {
    this.log('🔗 Testing Bootstrap Connection...', 'info');
    this.updateTestStatus('Bootstrap', 'running');

    try {
      if (!window.YZSocialC || !window.YZSocialC.tests) {
        this.log('Test functions not available', 'error');
        this.updateTestStatus('Bootstrap', 'failed');
        return;
      }

      const result = await window.YZSocialC.testConnectivity();
      this.updateTestStatus('Bootstrap', result.success ? 'passed' : 'failed');
      this.log(`Bootstrap Test: ${result.success ? 'PASSED' : 'FAILED'} - ${result.message}`,
               result.success ? 'success' : 'error');

    } catch (error) {
      this.updateTestStatus('Bootstrap', 'failed');
      this.log(`Bootstrap test failed: ${error.message}`, 'error');
    }
  }

  /**
   * Run Invitation Test
   */
  async runInvitationTest() {
    this.log('📧 Testing Invitation System...', 'info');
    this.updateTestStatus('Invitation', 'running');

    try {
      if (!this.dht || !this.dht.isStarted) {
        this.log('DHT not started', 'error');
        this.updateTestStatus('Invitation', 'failed');
        return;
      }

      // Create a test invitation token
      const testClientId = 'test-client-' + Date.now();
      const token = await this.dht.createInvitationToken(testClientId);

      if (token) {
        this.updateTestStatus('Invitation', 'passed');
        this.log('Invitation Test: PASSED - Token created successfully', 'success');
      } else {
        this.updateTestStatus('Invitation', 'failed');
        this.log('Invitation Test: FAILED - Could not create token', 'error');
      }

    } catch (error) {
      this.updateTestStatus('Invitation', 'failed');
      this.log(`Invitation test failed: ${error.message}`, 'error');
    }
  }

  /**
   * Run Connection Test
   */
  async runConnectionTest() {
    this.log('🔌 Testing Connection Health...', 'info');
    this.updateTestStatus('Connection', 'running');

    try {
      if (!window.YZSocialC || !window.YZSocialC.tests) {
        this.log('Test functions not available', 'error');
        this.updateTestStatus('Connection', 'failed');
        return;
      }

      const result = await window.YZSocialC.tests.connection.testConnectionHealth();
      this.updateTestStatus('Connection', result.success ? 'passed' : 'failed');
      this.log(`Connection Test: ${result.success ? 'PASSED' : 'FAILED'} - ${result.message}`,
               result.success ? 'success' : 'error');

    } catch (error) {
      this.updateTestStatus('Connection', 'failed');
      this.log(`Connection test failed: ${error.message}`, 'error');
    }
  }

  /**
   * Run Storage Test
   */
  async runStorageTest() {
    this.log('💾 Testing DHT Storage...', 'info');
    this.updateTestStatus('Storage', 'running');

    try {
      if (!window.YZSocialC || !window.YZSocialC.tests) {
        this.log('Test functions not available', 'error');
        this.updateTestStatus('Storage', 'failed');
        return;
      }

      const result = await window.YZSocialC.tests.dht.testStoreRetrieve();
      this.updateTestStatus('Storage', result.success ? 'passed' : 'failed');
      this.log(`Storage Test: ${result.success ? 'PASSED' : 'FAILED'} - ${result.message}`,
               result.success ? 'success' : 'error');

    } catch (error) {
      this.updateTestStatus('Storage', 'failed');
      this.log(`Storage test failed: ${error.message}`, 'error');
    }
  }

  /**
   * Run Routing Test
   */
  async runRoutingTest() {
    this.log('🛤️ Testing Routing Table...', 'info');
    this.updateTestStatus('Routing', 'running');

    try {
      if (!this.dht) {
        this.log('DHT not available', 'error');
        this.updateTestStatus('Routing', 'failed');
        return;
      }

      const routingNodes = this.dht.routingTable.getAllNodes().length;
      const connectedPeers = this.dht.getConnectedPeers().length;

      if (routingNodes > 0 && connectedPeers > 0) {
        this.updateTestStatus('Routing', 'passed');
        this.log(`Routing Test: PASSED - ${routingNodes} routing entries, ${connectedPeers} connected`, 'success');
      } else {
        this.updateTestStatus('Routing', 'failed');
        this.log(`Routing Test: FAILED - ${routingNodes} routing entries, ${connectedPeers} connected`, 'error');
      }

    } catch (error) {
      this.updateTestStatus('Routing', 'failed');
      this.log(`Routing test failed: ${error.message}`, 'error');
    }
  }

  /**
   * Run Discovery Test
   */
  async runDiscoveryTest() {
    this.log('🔍 Testing Peer Discovery...', 'info');
    this.updateTestStatus('Discovery', 'running');

    try {
      if (!window.YZSocialC || !window.YZSocialC.tests) {
        this.log('Test functions not available', 'error');
        this.updateTestStatus('Discovery', 'failed');
        return;
      }

      const result = await window.YZSocialC.tests.dht.testPeerDiscovery();
      this.updateTestStatus('Discovery', result.success ? 'passed' : 'failed');
      this.log(`Discovery Test: ${result.success ? 'PASSED' : 'FAILED'} - ${result.message}`,
               result.success ? 'success' : 'error');

    } catch (error) {
      this.updateTestStatus('Discovery', 'failed');
      this.log(`Discovery test failed: ${error.message}`, 'error');
    }
  }

  /**
   * Run Maintenance Test
   */
  async runMaintenanceTest() {
    this.log('⚙️ Testing Background Maintenance...', 'info');
    this.updateTestStatus('Maintenance', 'running');

    try {
      if (!this.dht) {
        this.log('DHT not available', 'error');
        this.updateTestStatus('Maintenance', 'failed');
        return;
      }

      // Check if background maintenance processes are running
      const hasRefreshTimer = this.dht.refreshTimer !== null && this.dht.refreshTimer !== undefined;
      const hasOfferPolling = this.dht.dhtOfferPollingInterval !== null && this.dht.dhtOfferPollingInterval !== undefined;

      if (hasRefreshTimer || hasOfferPolling) {
        this.updateTestStatus('Maintenance', 'passed');
        this.log(`Maintenance Test: PASSED - Background processes active (refresh: ${hasRefreshTimer}, polling: ${hasOfferPolling})`, 'success');
      } else {
        this.updateTestStatus('Maintenance', 'failed');
        this.log('Maintenance Test: FAILED - No background maintenance processes detected', 'error');
      }

    } catch (error) {
      this.updateTestStatus('Maintenance', 'failed');
      this.log(`Maintenance test failed: ${error.message}`, 'error');
    }
  }

  /**
   * Run Reconnection Test
   * Tests bridge node reconnection flow:
   * 1. Disconnect from all peers
   * 2. Validate membership token exists
   * 3. Connect to bootstrap server
   * 4. Bootstrap should route to bridge nodes
   * 5. Verify k-bucket maintenance rebuilds routing table
   */
  async runReconnectionTest() {
    this.log('🔄 Testing Bridge Node Reconnection...', 'info');
    this.updateTestStatus('Reconnection', 'running');

    try {
      if (!this.dht) {
        this.log('DHT not available', 'error');
        this.updateTestStatus('Reconnection', 'failed');
        return;
      }

      // Step 1: Check if we have a membership token
      const membershipToken = this.dht.membershipToken;
      if (!membershipToken) {
        this.log('Reconnection Test: FAILED - No membership token available', 'error');
        this.updateTestStatus('Reconnection', 'failed');
        return;
      }

      // Display token info safely
      const tokenInfo = typeof membershipToken === 'object'
        ? `${membershipToken.type || 'token'} (holder: ${membershipToken.holder?.substring(0, 8) || 'unknown'}...)`
        : `${membershipToken.toString().substring(0, 20)}...`;
      this.log(`✓ Membership token available: ${tokenInfo}`, 'success');

      // Step 2: Record initial state
      const initialPeers = this.dht.getConnectedPeers().length;
      const initialRoutingSize = this.dht.routingTable.getAllNodes().length;
      this.log(`Initial state: ${initialPeers} connected peers, ${initialRoutingSize} routing table entries`, 'info');

      // Step 3: Disconnect from all peers
      this.log('Disconnecting from all peers...', 'info');
      const connectedPeers = this.dht.getConnectedPeers();
      for (const peerId of connectedPeers) {
        try {
          const node = this.dht.routingTable.getNode(peerId);
          if (node && node.connectionManager) {
            await node.connectionManager.disconnectFromPeer(peerId);
          }
        } catch (error) {
          this.log(`Warning: Failed to disconnect from ${peerId}: ${error.message}`, 'warn');
        }
      }

      // Wait for disconnections to complete
      await new Promise(resolve => setTimeout(resolve, 2000));
      const peersAfterDisconnect = this.dht.getConnectedPeers().length;
      this.log(`After disconnect: ${peersAfterDisconnect} connected peers`, 'info');

      // Step 4: Test bootstrap reconnection with membership token
      this.log('Connecting to bootstrap server for reconnection...', 'info');
      if (this.dht.bootstrap && !this.dht.bootstrap.isBootstrapConnected()) {
        try {
          await this.dht.bootstrap.connect();
          this.log('✓ Bootstrap connection established', 'success');
        } catch (error) {
          this.log(`Failed to connect to bootstrap: ${error.message}`, 'error');
          this.updateTestStatus('Reconnection', 'failed');
          return;
        }
      }

      // Step 5: Wait for automatic peer discovery via bootstrap/bridge routing
      this.log('Waiting for automatic peer discovery via bootstrap...', 'info');
      // Note: With membership token, bootstrap server should automatically route to bridge nodes
      // This happens through the DHT's existing peer discovery mechanisms

      // Step 6: Wait for automatic reconnection via bridge nodes
      this.log('Waiting for automatic bridge node connections...', 'info');
      let reconnectionSuccess = false;
      let attempts = 0;
      const maxAttempts = 10;

      while (attempts < maxAttempts && !reconnectionSuccess) {
        await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 seconds
        attempts++;

        const currentPeers = this.dht.getConnectedPeers().length;
        const currentRouting = this.dht.routingTable.getAllNodes().length;

        this.log(`Attempt ${attempts}: ${currentPeers} connected peers, ${currentRouting} routing table entries`, 'info');

        if (currentPeers > 0) {
          reconnectionSuccess = true;
          this.log(`✓ Reconnection successful after ${attempts} attempts`, 'success');
          this.log(`Final state: ${currentPeers} connected peers, ${currentRouting} routing table entries`, 'success');
        }
      }

      // Step 7: Test k-bucket maintenance for peer discovery
      if (reconnectionSuccess) {
        this.log('Testing k-bucket maintenance for peer discovery...', 'info');
        try {
          await this.dht.refreshBuckets();
          await new Promise(resolve => setTimeout(resolve, 5000)); // Wait for discovery

          const finalPeers = this.dht.getConnectedPeers().length;
          const finalRouting = this.dht.routingTable.getAllNodes().length;

          this.log(`After k-bucket refresh: ${finalPeers} connected peers, ${finalRouting} routing table entries`, 'success');

          if (finalPeers >= initialPeers * 0.5) { // At least 50% of original peers reconnected
            this.updateTestStatus('Reconnection', 'passed');
            this.log('Reconnection Test: PASSED - Successfully reconnected to DHT network via bridge nodes', 'success');
          } else {
            this.updateTestStatus('Reconnection', 'failed');
            this.log('Reconnection Test: PARTIAL - Connected but peer count low', 'warn');
          }
        } catch (error) {
          this.log(`K-bucket maintenance failed: ${error.message}`, 'error');
          this.updateTestStatus('Reconnection', 'failed');
        }
      } else {
        this.updateTestStatus('Reconnection', 'failed');
        this.log('Reconnection Test: FAILED - Could not reconnect to any peers', 'error');
      }

    } catch (error) {
      this.updateTestStatus('Reconnection', 'failed');
      this.log(`Reconnection test failed: ${error.message}`, 'error');
    }
  }
}