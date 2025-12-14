import { BrowserDHTClient } from './browser/BrowserDHTClient.js';
import { DHTVisualizer } from './ui/DHTVisualizer.js';
import { DHTNode } from './core/DHTNode.js';
import { PubSubClient } from './pubsub/PubSubClient.js';

/**
 * Main application entry point
 */
class App {
  constructor() {
    // Debug: Track App instance creation with unique ID
    const instanceId = Math.random().toString(36).substr(2, 9);
    console.log(`🏗️ Creating new App instance [${instanceId}]`);
    console.trace('App constructor called from:');
    this.instanceId = instanceId;

    this.dht = null;
    this.pubsub = null;
    this.visualizer = null;
    this.isInitialized = false;
  }

  /**
   * Initialize the application
   */
  async initialize() {
    if (this.isInitialized) return;

    console.log('Initializing YZSocialC DHT Application...');

    try {
      // Check URL parameters for tab-specific identity mode
      const urlParams = new URLSearchParams(window.location.search);
      const useTabIdentity = urlParams.get('tabIdentity') !== 'false'; // Default: true (enables testing multiple tabs)

      // Create BrowserDHTClient with cryptographic identity
      // Bootstrap server URL: production uses /ws proxy, local uses :8080
      const isLocalDev = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
      const bootstrapUrl = isLocalDev
        ? 'ws://localhost:8080'  // Local development
        : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.hostname}/ws`; // Production

      this.dht = new BrowserDHTClient({
        k: 20,
        alpha: 3,
        replicateK: 20,
        useTabIdentity: useTabIdentity, // Enable tab-specific identities for testing multiple clients
        bootstrapServers: [bootstrapUrl],
        webrtc: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' }
          ],
          maxConnections: 50,
          timeout: 30000
        }
      });

      if (useTabIdentity) {
        console.log('🔑 Tab-specific identity mode: ENABLED (testing multiple tabs)');
        console.log('   To disable: Add ?tabIdentity=false to URL');
      } else {
        console.log('🔑 Tab-specific identity mode: DISABLED (shared identity across tabs)');
      }

      // Note: PubSubClient will be initialized after DHT starts (in startDHT())
      // because it requires cryptographic identity which is loaded asynchronously

      // Create UI visualizer (pubsub will be null initially)
      this.visualizer = new DHTVisualizer(this.dht, null);

      // Initialize WebAssembly components
      await this.visualizer.initializeWASM();

      // Setup global error handling
      this.setupErrorHandling();

      // Setup development helpers
      this.setupDevHelpers();

      this.isInitialized = true;
      console.log('Application initialized successfully');
      console.log('Node ID:', this.dht.localNodeId.toString());

    } catch (error) {
      console.error('Failed to initialize application:', error);
      this.displayError('Initialization failed: ' + error.message);
    }
  }

  /**
   * Setup global error handling
   */
  setupErrorHandling() {
    // Handle unhandled promise rejections
    window.addEventListener('unhandledrejection', (event) => {
      console.error('Unhandled promise rejection:', event.reason);
      if (this.visualizer) {
        this.visualizer.log(`Unhandled error: ${event.reason}`, 'error');
      }
      event.preventDefault();
    });

    // Handle general errors
    window.addEventListener('error', (event) => {
      console.error('Global error:', event.error);
      if (this.visualizer) {
        this.visualizer.log(`Global error: ${event.error.message}`, 'error');
      }
    });

    // Handle connection manager errors specifically
    if (this.dht && this.dht.connectionManager) {
      this.dht.connectionManager.on('error', (error) => {
        console.error('Connection manager error:', error);
        if (this.visualizer) {
          this.visualizer.log(`Connection manager error: ${error.message}`, 'error');
        }
      });
    }
  }

  /**
   * Setup development helpers (available in console)
   */
  setupDevHelpers() {
    // Make key objects available globally for debugging
    window.YZSocialC = {
      app: this,
      dht: this.dht,
      visualizer: this.visualizer,

      // Helper functions
      getStats: () => this.dht ? this.dht.getStats() : null,
      getNodes: () => this.dht ? this.dht.routingTable.getAllNodes() : [],
      getPeers: () => this.dht ? this.dht.routingTable.getAllNodes().filter(node => node.isConnected()).map(node => node.id.toString()) : [],

      // Development tools
      async testStore(key = 'test-key', value = 'test-value') {
        if (!this.dht || !this.dht.isStarted) {
          console.warn('DHT not started');
          return false;
        }
        if (!this.dht.routingTable) {
          console.error('DHT routing table not initialized');
          return false;
        }
        try {
          const result = await this.dht.store(key, value);
          console.log(`Store test result: ${result}`);
          return result;
        } catch (error) {
          console.error('Store test failed:', error);
          console.error('DHT state:', {
            isStarted: this.dht.isStarted,
            hasRoutingTable: !!this.dht.routingTable,
            routingTableSize: this.dht.routingTable?.getAllNodes()?.length || 'undefined'
          });
          return false;
        }
      },

      async testGet(key = 'test-key') {
        if (!this.dht || !this.dht.isStarted) {
          console.warn('DHT not started');
          return null;
        }
        if (!this.dht.routingTable) {
          console.error('DHT routing table not initialized');
          return null;
        }
        try {
          const result = await this.dht.get(key);
          console.log(`Get test result: ${result}`);
          return result;
        } catch (error) {
          console.error('Get test failed:', error);
          console.error('DHT state:', {
            isStarted: this.dht.isStarted,
            hasRoutingTable: !!this.dht.routingTable,
            routingTableSize: this.dht.routingTable?.getAllNodes()?.length || 'undefined'
          });
          return null;
        }
      },

      simulateNetwork(peerCount = 5) {
        console.log(`Simulating network with ${peerCount} peers...`);
        // This would create virtual peers for testing
        // Implementation depends on testing requirements
      },

      exportLogs() {
        const logs = Array.from(document.querySelectorAll('.log-entry'))
          .map(entry => entry.textContent)
          .join('\n');

        const blob = new Blob([logs], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `yzsocial-logs-${new Date().toISOString()}.txt`;
        a.click();
        URL.revokeObjectURL(url);
      },

      // Sleep/Wake memory protection debugging
      getSleepWakeStatus() {
        if (!this.dht) {
          console.warn('DHT not started');
          return null;
        }
        return this.dht.getSleepWakeStatus();
      },

      resetEmergencyThrottle() {
        if (!this.dht) {
          console.warn('DHT not started');
          return false;
        }
        this.dht.resetEmergencyThrottle();
        return true;
      },

      // Debug helpers that work without WebRTC
      addFakePeer(nodeIdStr) {
        if (!this.dht) return false;
        const nodeId = this.dht.localNodeId.constructor.fromString(nodeIdStr || 'fake-peer-' + Math.random().toString(36).substr(2, 9));
        this.dht.routingTable.addNode(nodeId, {
          lastSeen: Date.now(),
          status: 'fake'
        });
        console.log(`Added fake peer: ${nodeId.toString()}`);
        return nodeId.toString();
      },

      testStoreLocal(key = 'test', value = 'hello') {
        if (!this.dht) return false;
        // Store locally without network
        this.dht.storage.set(key, {
          value,
          timestamp: Date.now(),
          publisher: this.dht.localNodeId.toString()
        });
        console.log(`Stored locally: ${key} = ${value}`);
        return true;
      },

      getLocalStorage() {
        if (!this.dht) return {};
        const result = {};
        for (const [key, stored] of this.dht.storage.entries()) {
          result[key] = stored.value;
        }
        return result;
      },

      forceAddPeerToRouting(nodeIdStr) {
        if (!this.dht) return false;
        try {
          // Create a proper DHTNode instance
          const node = new DHTNode(nodeIdStr, 'fake-endpoint');
          this.dht.routingTable.addNode(node);

          console.log(`Force added peer to routing table: ${node.id.toString()}`);
          console.log(`Routing table size: ${this.dht.routingTable.getAllNodes().length}`);
          return node.id.toString();
        } catch (error) {
          console.error('Failed to add fake peer:', error);
          return false;
        }
      },

      async testDHTConnection(peerId) {
        if (!this.dht) return false;
        try {
          console.log(`Testing DHT-based connection to: ${peerId}`);
          const result = await this.dht.connectToPeerViaDHT(peerId);
          console.log(`DHT connection result: ${result}`);
          return result;
        } catch (error) {
          console.error('DHT connection test failed:', error);
          return false;
        }
      },

      getBootstrapStatus() {
        if (!this.dht) return null;
        return {
          useBootstrapForSignaling: this.dht.useBootstrapForSignaling,
          routingTableSize: this.dht.routingTable.getAllNodes().length,
          connectedPeers: this.dht.getConnectedPeers().length,
          isStarted: this.dht.isStarted
        };
      },

      async lookupPeer(peerId) {
        if (!this.dht || !this.dht.bootstrap) return null;
        try {
          const result = await this.dht.bootstrap.lookupPeer(peerId);
          console.log(`Peer lookup result for ${peerId}:`, result);
          return result;
        } catch (error) {
          console.error('Peer lookup failed:', error);
          return null;
        }
      },

      // Strategic connection management debug utilities
      debugStrategicConnections() {
        if (!this.dht) {
          console.warn('DHT not started');
          return null;
        }
        return this.dht.debugStrategicConnections();
      },

      async maintainStrategicConnections() {
        if (!this.dht) {
          console.warn('DHT not started');
          return false;
        }
        await this.dht.maintainStrategicConnections();
        return true;
      },

      getPlatformLimits() {
        if (!this.dht) {
          console.warn('DHT not started');
          return null;
        }
        return this.dht.platformLimits;
      },

      async connectToPeer(peerId) {
        if (!this.dht) return false;

        // Auto-start DHT if not started
        if (!this.dht.isStarted) {
          console.log('DHT not started, starting automatically...');
          try {
            await this.dht.start();
            console.log('DHT started successfully for directed connection');
            // Wait a moment for bootstrap connection to stabilize
            await new Promise(resolve => setTimeout(resolve, 2000));
          } catch (error) {
            console.error('Failed to auto-start DHT:', error);
            return false;
          }
        }

        try {
          console.log(`Attempting directed connection to: ${peerId}`);
          const result = await this.dht.connectToPeerDirected(peerId);
          console.log(`Directed connection result: ${result}`);
          return result;
        } catch (error) {
          console.error('Directed connection failed:', error);
          return false;
        }
      },

      async inviteNewClient(clientId) {
        if (!this.dht) {
          console.error('DHT not initialized');
          return false;
        }

        if (!this.dht.isStarted) {
          console.error('DHT not started');
          return false;
        }

        try {
          console.log(`Inviting new client to join DHT: ${clientId}`);
          const result = await this.dht.inviteNewClient(clientId);
          if (result) {
            console.log(`✅ Successfully invited ${clientId} to join DHT`);
          } else {
            console.log(`❌ Failed to invite ${clientId} to join DHT`);
          }
          return result;
        } catch (error) {
          console.error('Invitation failed:', error);
          return false;
        }
      },

      setBootstrapSignaling(enabled) {
        if (!this.dht) return false;
        this.dht.setBootstrapSignaling(enabled);
        return this.getBootstrapStatus();
      },

      copyNodeId() {
        if (!this.dht) return null;
        const nodeId = this.dht.localNodeId.toString();
        if (navigator.clipboard) {
          navigator.clipboard.writeText(nodeId).then(() => {
            console.log(`Node ID copied to clipboard: ${nodeId}`);
          }).catch(err => {
            console.error('Failed to copy to clipboard:', err);
          });
        } else {
          // Fallback for older browsers
          const textArea = document.createElement('textarea');
          textArea.value = nodeId;
          document.body.appendChild(textArea);
          textArea.select();
          document.execCommand('copy');
          document.body.removeChild(textArea);
          console.log(`Node ID copied to clipboard: ${nodeId}`);
        }
        return nodeId;
      },

      // REMOVED: Legacy insecure genesis methods
      initializeGenesisPeer() {
        console.error('🚨 SECURITY: initializeGenesisPeer() disabled for security');
        console.error('🔐 Genesis peer status is now controlled by bootstrap server');
        console.error('💡 Use: node src/bootstrap/server.js -createNewDHT');
        return false;
      },

      forceConnectToPeer() {
        console.error('🚨 SECURITY: forceConnectToPeer() disabled for security');
        console.error('🔐 Use token-based invitations instead: YZSocialC.inviteNewClient(peerId)');
        return false;
      },

      isGenesisPeer() {
        return this.dht ? this.dht.isGenesisPeer : false;
      },

      async startDHT() {
        if (!this.dht) {
          console.error('DHT not initialized');
          return false;
        }
        if (this.dht.isStarted) {
          console.log('DHT already started');
          return true;
        }
        try {
          console.log('Starting DHT...');
          await this.dht.start();
          console.log('DHT started successfully');

          // Create PubSubClient now that identity and Ed25519 keys are loaded
          if (!this.pubsub && this.dht.identity && this.dht.keyInfo) {
            console.log('📬 Initializing PubSub client with loaded identity...');
            this.pubsub = new PubSubClient(
              this.dht,
              this.dht.identity.nodeId,
              this.dht.keyInfo, // Use Ed25519 keys for pub/sub message signing
              {
                enableBatching: true,
                batchSize: 10,
                batchTime: 100
              }
            );
            console.log('📬 PubSub client initialized successfully');

            // Update visualizer with pubsub client
            if (this.visualizer) {
              this.visualizer.pubsub = this.pubsub;
              console.log('📬 PubSub client connected to visualizer');
            }
          }

          // Update identity UI after identity is loaded
          if (this.visualizer && typeof this.visualizer.updateIdentityUI === 'function') {
            this.visualizer.updateIdentityUI();
          }

          // Force stats update to refresh routing table display
          if (this.visualizer && typeof this.visualizer.updateStats === 'function') {
            setTimeout(() => {
              this.visualizer.updateStats();
            }, 2000); // Wait for connections to establish
          }

          return true;
        } catch (error) {
          console.error('Failed to start DHT:', error);
          return false;
        }
      },

      async testConnectivity() {
        console.log('Testing STUN/TURN server connectivity...');
        const iceServers = [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' }
        ];

        try {
          const pc = new RTCPeerConnection({ iceServers });
          const candidates = [];

          pc.onicecandidate = (event) => {
            if (event.candidate) {
              candidates.push(event.candidate);
              console.log('ICE Candidate:', event.candidate.type, event.candidate.candidate);
            } else {
              console.log('ICE gathering complete. Found candidates:', candidates.length);
              pc.close();
            }
          };

          // Create a data channel to trigger ICE gathering
          pc.createDataChannel('test');
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);

          console.log('ICE gathering started...');
          return { success: true, message: 'STUN/TURN server connectivity test passed' };
        } catch (error) {
          console.error('Connectivity test failed:', error);
          return { success: false, message: `Connectivity test failed: ${error.message}` };
        }
      },

      debugRoutingTable() {
        if (!this.dht) return null;
        const routingNodes = this.dht.routingTable.getAllNodes();
        const connectedPeers = this.dht.getConnectedPeers();

        console.log('=== Routing Table Debug ===');
        console.log(`Routing table size: ${routingNodes.length}`);
        console.log(`Connected WebRTC peers: ${connectedPeers.length}`);

        const routingPeerIds = routingNodes.map(node => node.id.toString());
        const missingConnections = routingPeerIds.filter(id => !connectedPeers.includes(id));
        const extraConnections = connectedPeers.filter(id => !routingPeerIds.includes(id));

        if (missingConnections.length > 0) {
          console.log(`⚠️  Peers in routing table but not connected: ${missingConnections.length}`);
          missingConnections.forEach(id => console.log(`  - ${id}`));
        }

        if (extraConnections.length > 0) {
          console.log(`⚠️  Connected peers not in routing table: ${extraConnections.length}`);
          extraConnections.forEach(id => console.log(`  - ${id}`));
        }

        if (missingConnections.length === 0 && extraConnections.length === 0) {
          console.log('✅ Routing table and WebRTC connections are synchronized');
        }

        return {
          routingTableSize: routingNodes.length,
          connectedPeers: connectedPeers.length,
          missingConnections,
          extraConnections,
          synchronized: missingConnections.length === 0 && extraConnections.length === 0
        };
      },

      cleanupRoutingTable() {
        if (!this.dht) return false;
        const cleaned = this.dht.cleanupRoutingTable();
        console.log(`Cleaned up ${cleaned} inconsistent routing table entries`);
        return cleaned;
      },

      debugPeerDiscovery() {
        if (!this.dht) {
          console.error('DHT not available');
          return null;
        }
        
        console.log('🔍 Peer Discovery Debug:');
        console.log(`   Connected peers: ${this.dht.getConnectedPeers().length}`);
        console.log(`   Routing table size: ${this.dht.routingTable.totalNodes}`);
        console.log(`   Pending requests: ${this.dht.pendingRequests.size}`);
        
        // Show pending requests
        if (this.dht.pendingRequests.size > 0) {
          console.log('   Pending requests:');
          for (const [requestId, request] of this.dht.pendingRequests) {
            console.log(`     - ${requestId}`);
          }
        }
        
        // Show connected peers
        const connectedPeers = this.dht.getConnectedPeers();
        if (connectedPeers.length > 0) {
          console.log('   Connected peers:');
          connectedPeers.forEach(peer => console.log(`     - ${peer.substring(0, 8)}...`));
        }
        
        return {
          connectedPeers: this.dht.getConnectedPeers().length,
          routingTableSize: this.dht.routingTable.totalNodes,
          pendingRequests: this.dht.pendingRequests.size
        };
      },

      async testPeerDiscovery() {
        if (!this.dht) {
          console.error('DHT not available');
          return false;
        }
        
        console.log('🔍 Testing peer discovery...');
        
        try {
          // Enable debug logging temporarily
          const originalLogLevel = window.LOG_CONFIG ? window.LOG_CONFIG.DHT_CORE : null;
          if (window.LOG_CONFIG) {
            window.LOG_CONFIG.DHT_CORE = 'DEBUG';
          }
          
          await this.dht.discoverPeersViaDHT();
          console.log('✅ Peer discovery completed');
          
          // Restore original log level
          if (window.LOG_CONFIG && originalLogLevel) {
            window.LOG_CONFIG.DHT_CORE = originalLogLevel;
          }
          
          return true;
        } catch (error) {
          console.error('❌ Peer discovery failed:', error);
          return false;
        }
      },

      refreshUI() {
        if (!this.visualizer) {
          console.warn('Visualizer not available');
          return false;
        }
        this.visualizer.forceRefresh();
        return true;
      },

      debugConnectionState() {
        if (!this.dht) {
          console.log('DHT not available');
          return null;
        }

        const connectionPeers = this.dht ? this.dht.getConnectedPeers() : [];
        const routingNodes = this.dht.routingTable ? this.dht.routingTable.getAllNodes() : [];
        const connectionStats = this.dht ? this.dht.getStats() : {};

        // Also get ALL peers (including filtered ones) for debugging
        const allConnectionPeers = this.dht ? this.dht.getConnectedPeers() : [];

        console.log('=== Connection State Debug ===');
        console.log(`Our Node ID: ${this.dht.localNodeId.toString()}`);
        console.log(`DHT Started: ${this.dht.isStarted}`);
        console.log(`DHT Bootstrapped: ${this.dht.isBootstrapped}`);
        console.log(`Connected Peers (filtered): ${connectionPeers.length}`);
        console.log(`Connected Peers (all): ${allConnectionPeers.length}`);
        console.log(`Routing Table Nodes: ${routingNodes.length}`);
        console.log(`Connection Stats:`, connectionStats);

        if (allConnectionPeers.length > connectionPeers.length) {
          console.log('🔍 Filtered out connections:');
          const filtered = allConnectionPeers.filter(peer => !connectionPeers.includes(peer));
          filtered.forEach(peer => {
            const isValid = this.dht.isValidDHTPeer ? this.dht.isValidDHTPeer(peer) : true;
            console.log(`  - ${peer} (filtered) - Valid DHT peer: ${isValid}`);
          });
        }

        if (connectionPeers.length > 0) {
          console.log('✅ Valid DHT Peers:');
          connectionPeers.forEach(peer => console.log(`  - ${peer}`));
        }

        if (routingNodes.length > 0) {
          console.log('📋 Routing Table Nodes:');
          routingNodes.forEach(node => console.log(`  - ${node.id.toString()}`));
        }

        // Check for mismatches
        const routingPeerIds = routingNodes.map(node => node.id.toString());
        const missingConnections = routingPeerIds.filter(id => !connectionPeers.includes(id));
        const extraConnections = connectionPeers.filter(id => !routingPeerIds.includes(id));

        if (missingConnections.length > 0) {
          console.warn('⚠️  Peers in routing table but missing connections:');
          missingConnections.forEach(id => console.warn(`  - ${id}`));
        }

        if (extraConnections.length > 0) {
          console.warn('⚠️  Connections not in routing table:');
          extraConnections.forEach(id => console.warn(`  - ${id}`));
        }

        return {
          ourNodeId: this.dht.localNodeId.toString(),
          dhtStarted: this.dht.isStarted,
          connections: connectionPeers.length,
          allConnections: allConnectionPeers.length,
          routingTableSize: routingNodes.length,
          connectionStats,
          allPeers: allConnectionPeers,
          validPeers: connectionPeers,
          filteredConnections: allConnectionPeers.filter(peer => !connectionPeers.includes(peer)),
          missingConnections,
          extraConnections
        };
      },

      investigatePhantomPeer(suspiciousPeerId = '215b077e48252e46363cb609d803a5403be6a505') {
        if (!this.dht) {
          console.log('DHT not available');
          return null;
        }

        console.log(`🕵️ Investigating phantom peer: ${suspiciousPeerId}`);
        console.log(`Our Node ID: ${this.dht.localNodeId.toString()}`);

        // Check if it's in connection manager
        const connectionExists = this.dht.isPeerConnected(suspiciousPeerId);
        const isConnected = this.dht.isPeerConnected(suspiciousPeerId);
        const isValidDHTPeer = this.dht.isValidDHTPeer ? this.dht.isValidDHTPeer(suspiciousPeerId) : true;

        // Check if it's in routing table
        const routingNode = this.dht.routingTable.getNode(suspiciousPeerId);

        console.log(`🔍 Connection exists: ${connectionExists}`);
        console.log(`🔍 Is connected: ${isConnected}`);
        console.log(`🔍 Valid DHT peer: ${isValidDHTPeer}`);
        console.log(`🔍 In routing table: ${!!routingNode}`);

        if (connectionExists) {
          // Connection details handled by DHT internally
          console.log(`🔍 Connection state:`, {
            connected: isConnected
          });
        }

        if (routingNode) {
          console.log(`🔍 Routing node details:`, {
            id: routingNode.id.toString(),
            lastSeen: routingNode.lastSeen,
            endpoint: routingNode.endpoint
          });
        }

        // Check bootstrap connection state
        const bootstrapStatus = this.dht.bootstrap.getStatus();
        console.log(`🔍 Bootstrap status:`, bootstrapStatus);

        return {
          suspiciousPeerId,
          ourNodeId: this.dht.localNodeId.toString(),
          connectionExists: connectionExists,
          isConnected: isConnected,
          validDHTPeer: isValidDHTPeer,
          inRoutingTable: !!routingNode,
          connectionState: connectionExists ? {
            connected: isConnected,
            type: 'Connection' // Type handled by connection managers
          } : null,
          routingNodeDetails: routingNode ? {
            id: routingNode.id.toString(),
            lastSeen: routingNode.lastSeen,
            endpoint: routingNode.endpoint
          } : null,
          bootstrapStatus
        };
      },

      forceClearUI() {
        if (!this.visualizer) {
          console.warn('Visualizer not available');
          return false;
        }

        console.log('🧹 Force clearing UI peer display');

        // Get the peer list element
        const peerListElement = document.getElementById('peer-list');
        if (peerListElement) {
          console.log('📋 Current UI content:', peerListElement.innerHTML);
          peerListElement.innerHTML = '<div class="wasm-placeholder">UI cleared - refresh to update</div>';
          console.log('✅ UI peer display cleared');

          // Force immediate refresh
          setTimeout(() => {
            this.visualizer.updatePeerDisplay();
          }, 100);

          return true;
        } else {
          console.warn('Peer list element not found');
          return false;
        }
      },

      /**
       * Trigger manual peer discovery for testing DHT routing
       */
      async triggerPeerDiscovery() {
        if (!this.dht) {
          console.log('DHT not available');
          return false;
        }

        try {
          console.log('🔍 Triggering manual peer discovery...');
          // Access internal KademliaDHT instance (this.dht is BrowserDHTClient, this.dht.dht is KademliaDHT)
          const kademliaDHT = this.dht.dht || this.dht;
          await kademliaDHT.triggerPeerDiscovery();
          console.log('✅ Peer discovery completed');
          return true;
        } catch (error) {
          console.error('❌ Peer discovery failed:', error);
          return false;
        }
      },

      async refreshBuckets() {
        if (!this.dht) {
          console.log('DHT not available');
          return false;
        }

        try {
          console.log('🔄 Triggering manual bucket refresh...');
          // Access internal KademliaDHT instance (this.dht is BrowserDHTClient, this.dht.dht is KademliaDHT)
          const kademliaDHT = this.dht.dht || this.dht;
          await kademliaDHT.refreshBuckets();
          console.log('✅ Bucket refresh completed');
          return true;
        } catch (error) {
          console.error('❌ Bucket refresh failed:', error);
          return false;
        }
      },

      switchToDHTSignaling() {
        if (!this.dht) {
          console.log('DHT not available');
          return false;
        }

        console.log('🌐 Manually forcing switch to DHT-based signaling...');
        this.dht.considerDHTSignaling();
        return true;
      },

      getSignalingMode() {
        if (!this.dht) {
          return null;
        }

        return {
          useBootstrapForSignaling: this.dht.useBootstrapForSignaling,
          bootstrapConnected: this.dht.bootstrap.isBootstrapConnected(),
          connectedPeers: this.dht.getConnectedPeers().length,
          routingTableSize: this.dht.routingTable.getAllNodes().length,
          connectedPeersList: this.dht.getConnectedPeers(),
          routingTablePeers: this.dht.routingTable.getAllNodes().map(n => n.id.toString())
        };
      },

      syncRoutingTable() {
        if (!this.dht) {
          console.log('DHT not available');
          return false;
        }

        const connectedPeers = this.dht.getConnectedPeers();
        const routingTablePeers = this.dht.routingTable.getAllNodes().map(n => n.id.toString());

        console.log('🔄 Syncing routing table with connected peers...');
        console.log(`Connected peers: ${connectedPeers.length}`, connectedPeers);
        console.log(`Routing table peers: ${routingTablePeers.length}`, routingTablePeers);

        let added = 0;
        for (const peerId of connectedPeers) {
          if (!routingTablePeers.includes(peerId) && this.dht.isValidDHTPeer(peerId)) {
            // Force add peer to routing table directly
            const node = new DHTNode(peerId, peerId);
            this.dht.routingTable.addNode(node);
            console.log(`✅ Force added ${peerId} to routing table`);
            added++;
          }
        }

        if (added > 0) {
          console.log(`📊 Added ${added} peers to routing table, checking DHT signaling...`);
          this.dht.considerDHTSignaling();
        } else {
          console.log('📊 Routing table already in sync');
        }

        const newRoutingTableSize = this.dht.routingTable.getAllNodes().length;
        console.log(`📊 Final routing table size: ${newRoutingTableSize}`);

        return added;
      },

      forceAddConnectedPeersToRouting() {
        if (!this.dht) {
          console.log('DHT not available');
          return false;
        }

        const connectedPeers = this.dht.getConnectedPeers();
        console.log(`🔄 Force adding ${connectedPeers.length} connected peers to routing table...`);

        let added = 0;
        for (const peerId of connectedPeers) {
          if (this.dht.isValidDHTPeer(peerId)) {
            try {
              const node = new DHTNode(peerId, peerId);
              this.dht.routingTable.addNode(node);
              console.log(`✅ Force added ${peerId} to routing table`);
              added++;
            } catch (error) {
              console.warn(`Failed to add ${peerId} to routing table:`, error);
            }
          } else {
            console.warn(`Invalid DHT peer: ${peerId}`);
          }
        }

        console.log(`📊 Added ${added} peers to routing table`);
        console.log(`📊 Final routing table size: ${this.dht.routingTable.getAllNodes().length}`);

        // Force DHT signaling check
        this.dht.considerDHTSignaling();

        return added;
      },

      debugEventHandlers() {
        if (!this.dht) {
          console.log('DHT not available');
          return false;
        }

        console.log('🔍 Debugging event handlers...');
        console.log('DHT available:', !!this.dht);
        console.log('Routing table available:', !!this.dht?.routingTable);

        // Test manual peer connected event
        const connectedPeers = this.dht.getConnectedPeers();
        console.log(`Connected peers: ${connectedPeers.length}`, connectedPeers);

        // Test manual event emission
        if (connectedPeers.length > 0) {
          console.log(`🧪 Testing manual event emission for ${connectedPeers[0]}`);
          // Event emission handled by connection managers

          console.log(`🔄 Also manually triggering handlePeerConnected for ${connectedPeers[0]}`);
          this.dht.handlePeerConnected(connectedPeers[0]);
        } else {
          // Test with fake peer ID to check if event handler is working
          console.log('🧪 Testing event handler with fake peer ID...');
          // Event emission handled by connection managers
        }

        return true;
      },

      /**
       * Get keep-alive status for all WebRTC connections
       */
      getKeepAliveStatus() {
        if (!this.dht || !this.dht.connectionManager) {
          console.log('DHT or connection manager not available');
          return null;
        }

        const cm = this.dht.connectionManager;
        console.log('💓 Keep-Alive Status Report');
        console.log(`Connection Manager Type: ${cm.constructor.name}`);

        // Check if connection manager has getKeepAliveStatus method (WebRTCManager)
        if (cm.getKeepAliveStatus) {
          console.log('📱 Using WebRTCManager keep-alive system');
          return cm.getKeepAliveStatus();
        }

        // Fallback for older connection managers
        const connectedPeers = cm.getConnectedPeers();
        const keepAliveStatus = {};

        console.log(`Tab visible: ${cm.isTabVisible}`);

        // SAFETY CHECK: Ensure keep-alive maps exist
        if (!cm.keepAliveIntervals) {
          console.warn('⚠️ keepAliveIntervals not initialized - connection manager missing keep-alive system');
          console.log('Available properties:', Object.keys(cm));
          return null;
        }

        console.log(`Active keep-alive intervals: ${cm.keepAliveIntervals.size}`);
        console.log(`Keep-alive frequency: ${cm.isTabVisible ? cm.keepAliveFrequency : cm.inactiveKeepAliveFrequency}ms`);

        for (const peerId of connectedPeers) {
          const hasKeepAlive = cm.keepAliveIntervals.has(peerId);
          const lastPing = cm.lastPingTimes.get(peerId);
          const pendingPings = cm.pingResponses.get(peerId)?.size || 0;
          const connectionType = cm.connectionTypes.get(peerId);

          keepAliveStatus[peerId] = {
            hasKeepAlive,
            lastPing: lastPing ? new Date(lastPing).toLocaleTimeString() : 'Never',
            pendingPings,
            connectionType,
            timeSinceLastPing: lastPing ? Date.now() - lastPing : null
          };

          console.log(`  ${peerId.substring(0, 8)}... (${connectionType}):`, {
            keepAlive: hasKeepAlive ? '✅' : '❌',
            lastPing: keepAliveStatus[peerId].lastPing,
            pending: pendingPings
          });
        }

        return keepAliveStatus;
      },

      /**
       * Manually trigger keep-alive ping for testing
       */
      testKeepAlivePing(peerId = null) {
        if (!this.dht || !this.dht.connectionManager) {
          console.log('DHT or connection manager not available');
          return false;
        }

        const cm = this.dht.connectionManager;

        // Check if connection manager has testKeepAlivePing method (WebRTCManager)
        if (cm.testKeepAlivePing) {
          console.log('📱 Using WebRTCManager keep-alive test');
          return cm.testKeepAlivePing(peerId);
        }

        // Fallback for older connection managers
        // SAFETY CHECK: Ensure keep-alive system exists
        if (!cm.sendKeepAlivePing) {
          console.warn('⚠️ Connection manager does not support keep-alive pings');
          console.log(`Connection manager type: ${cm.constructor.name}`);
          return false;
        }

        const connectedPeers = cm.getConnectedPeers();

        if (!peerId && connectedPeers.length > 0) {
          peerId = connectedPeers[0];
        }

        if (!peerId) {
          console.log('No peer to test - no connections available');
          return false;
        }

        console.log(`🏓 Manually triggering keep-alive ping to ${peerId.substring(0, 8)}...`);
        cm.sendKeepAlivePing(peerId);
        return true;
      },

      /**
       * Check connection health for all peers
       */
      /**
       * Debug routing table population issue
       */
      debugRoutingTablePopulation() {
        if (!this.dht) {
          console.log('DHT not available');
          return null;
        }

        console.log('🔍 DEBUGGING ROUTING TABLE POPULATION');
        console.log('='.repeat(50));

        const connectedPeers = this.dht.getConnectedPeers();
        const routingNodes = this.dht.routingTable.getAllNodes();

        console.log(`Connected Peers: ${connectedPeers.length}`);
        console.log(`Routing Table Nodes: ${routingNodes.length}`);

        console.log('\n📋 ROUTING TABLE DETAILS:');
        if (routingNodes.length === 0) {
          console.log('  No nodes in routing table!');
        } else {
          routingNodes.forEach((node, i) => {
            const peerId = node.id.toString();
            console.log(`  ${i+1}. ${peerId.substring(0, 8)}... - Connected: ${node.isConnected()}`);
          });
        }

        console.log('\n🔗 CONNECTION MANAGER DETAILS:');
        console.log(`Event handlers setup: ${!!this.dht.routingTable.eventHandlersSetup}`);
        console.log(`RoutingTable onNodeAdded: ${!!this.dht.routingTable.onNodeAdded}`);

        // Check if we can manually trigger adding connected peers to routing table
        console.log('\n🔄 ATTEMPTING MANUAL ROUTING TABLE SYNC:');
        for (const peerId of connectedPeers) {
          const existsInRouting = routingNodes.some(node => node.id.toString() === peerId);
          console.log(`  ${peerId.substring(0, 8)}... - In routing table: ${existsInRouting}`);

          if (!existsInRouting) {
            console.log(`    ⚠️ Missing from routing table!`);
          }
        }

        return {
          connectedPeers: connectedPeers.length,
          routingTableNodes: routingNodes.length,
          missingFromRouting: connectedPeers.filter(peerId =>
            !routingNodes.some(node => node.id.toString() === peerId)
          )
        };
      },

      checkConnectionHealth() {
        if (!this.dht) {
          console.log('DHT not available');
          return null;
        }

        console.log('🩺 Connection Health Check');

        // Use the DHT's connection-agnostic methods
        const connectedPeers = this.dht.getConnectedPeers();
        const routingTableNodes = this.dht.routingTable?.getAllNodes() || [];

        const healthReport = {
          connectedPeers: connectedPeers.length,
          routingTableSize: routingTableNodes.length,
          connectionDetails: {}
        };

        console.log(`Connected Peers: ${connectedPeers.length}, Routing Table: ${routingTableNodes.length}`);

        // Check each node's connection status using the new per-node architecture
        for (const node of routingTableNodes) {
          const peerId = node.id.toString();
          const isConnected = node.isConnected();
          const connectionManager = node.connectionManager;

          let connectionType = 'unknown';
          let connectionState = 'unknown';

          if (connectionManager) {
            connectionType = connectionManager.constructor.name.includes('WebRTC') ? 'webrtc' : 'websocket';

            if (node.connection) {
              if (connectionType === 'webrtc' && node.connection.connectionState) {
                connectionState = node.connection.connectionState;
              } else if (connectionType === 'websocket' && node.connection.readyState !== undefined) {
                connectionState = `readyState=${node.connection.readyState}`;
              }
            }
          }

          healthReport.connectionDetails[peerId] = {
            type: connectionType,
            state: connectionState,
            isConnected,
            hasConnectionManager: !!connectionManager,
            hasConnection: !!node.connection
          };

          console.log(`  ${peerId.substring(0, 8)}... (${connectionType}): ${connectionState} ${isConnected ? '✅' : '❌'}`);
        }

        return healthReport;
      },

      /**
       * Debug WebRTC connection states and transitions
       */
      debugWebRTCStates() {
        if (!this.dht || !this.dht.connectionManager) {
          console.log('DHT or connection manager not available');
          return null;
        }

        const cm = this.dht.connectionManager;
        console.log('🔍 WebRTC Connection State Debug');

        if (!cm.connections) {
          console.log('No connections map available');
          return null;
        }

        const webrtcConnections = Array.from(cm.connections.entries()).filter(([_peerId, _connection]) =>
          cm.connectionTypes?.get(_peerId) === 'webrtc'
        );

        console.log(`Found ${webrtcConnections.length} WebRTC connections`);

        for (const [peerId, connection] of webrtcConnections) {
          const currentState = connection.connectionState;
          const trackedState = cm.connectionStates?.get(peerId);
          const dataChannel = cm.dataChannels?.get(peerId);
          const hasKeepAlive = cm.keepAliveIntervals?.has(peerId);

          console.log(`\n${peerId.substring(0, 8)}...:`);
          console.log(`  Connection state: ${currentState} (tracked: ${trackedState})`);
          console.log(`  ICE connection state: ${connection.iceConnectionState}`);
          console.log(`  ICE gathering state: ${connection.iceGatheringState}`);
          console.log(`  Signaling state: ${connection.signalingState}`);
          console.log(`  Data channel: ${dataChannel ? dataChannel.readyState : 'none'}`);
          console.log(`  Keep-alive active: ${hasKeepAlive ? '✅' : '❌'}`);

          // Check for common WebRTC issues
          if (currentState === 'failed') {
            console.warn(`  ❌ Connection failed - ICE: ${connection.iceConnectionState}`);
          }
          if (currentState === 'disconnected') {
            console.warn(`  ⚠️ Connection disconnected - may recover`);
          }
          if (dataChannel && dataChannel.readyState !== 'open') {
            console.warn(`  ⚠️ Data channel not open: ${dataChannel.readyState}`);
          }
        }

        return {
          webrtcCount: webrtcConnections.length,
          states: webrtcConnections.map(([peerId, connection]) => ({
            peerId: peerId.substring(0, 8),
            connectionState: connection.connectionState,
            iceConnectionState: connection.iceConnectionState,
            dataChannelState: cm.dataChannels?.get(peerId)?.readyState
          }))
        };
      },

      /**
       * Simulate tab visibility change for testing
       */
      simulateTabVisibilityChange(visible = null) {
        if (!this.dht || !this.dht.connectionManager) {
          console.log('DHT or connection manager not available');
          return false;
        }

        const cm = this.dht.connectionManager;

        // Check if connection manager has simulateTabVisibilityChange method (WebRTCManager)
        if (cm.simulateTabVisibilityChange) {
          console.log('📱 Using WebRTCManager tab visibility simulation');
          return cm.simulateTabVisibilityChange();
        }

        // Fallback for older connection managers
        const oldVisible = cm.isTabVisible;

        if (visible === null) {
          visible = !oldVisible; // Toggle
        }

        console.log(`📱 Simulating tab visibility change: ${oldVisible} → ${visible}`);
        cm.isTabVisible = visible;

        if (cm.adjustKeepAliveFrequency) {
          cm.adjustKeepAliveFrequency();
        }

        if (visible && !oldVisible) {
          console.log('🔄 Simulating tab became visible - checking connection health...');
          // Check connection health manually instead of calling non-existent method
          const connectedPeers = cm.getConnectedPeers();
          console.log(`📊 Connection check: ${connectedPeers.length} peers connected`);
        }

        return true;
      },


      /**
       * Get rate limiting and traffic statistics
       */
      getTrafficStats() {
        if (!this.dht) {
          console.log('DHT not available');
          return null;
        }

        const now = Date.now();
        const stats = {
          findNodeRateLimit: this.dht.findNodeRateLimit.size,
          lastBucketRefresh: this.dht.lastBucketRefreshTime ? new Date(this.dht.lastBucketRefreshTime).toLocaleTimeString() : 'Never',
          timeSinceLastRefresh: this.dht.lastBucketRefreshTime ? Math.round((now - this.dht.lastBucketRefreshTime) / 1000) : null,
          refreshInterval: this.dht.options.refreshInterval / 1000,
          findNodeMinInterval: this.dht.findNodeMinInterval / 1000,
          peerFailureBackoff: this.dht.peerFailureBackoff.size,
          processedMessages: this.dht.processedMessages.size
        };

        console.log('📊 DHT Traffic Statistics:');
        console.log(`Rate limited peers: ${stats.findNodeRateLimit}`);
        console.log(`Last bucket refresh: ${stats.lastBucketRefresh}`);
        console.log(`Refresh interval: ${stats.refreshInterval}s`);
        console.log(`Find node min interval: ${stats.findNodeMinInterval}s`);
        console.log(`Failed peers in backoff: ${stats.peerFailureBackoff}`);
        console.log(`Processed messages cache: ${stats.processedMessages}`);

        return stats;
      },

      /**
       * Manually trigger cleanup of tracking maps
       */
      cleanupTrackingMaps() {
        if (!this.dht) {
          console.log('DHT not available');
          return false;
        }

        console.log('🧹 Manually triggering tracking maps cleanup...');
        this.dht.cleanupTrackingMaps();
        return true;
      },

      /**
       * Get adaptive refresh status and bucket staleness info
       */
      getAdaptiveRefreshStatus() {
        if (!this.dht) {
          console.log('DHT not available');
          return null;
        }

        const now = Date.now();
        const connectedPeers = this.dht.getConnectedPeers().length;
        const routingNodes = this.dht.routingTable.getAllNodes().length;

        const status = {
          currentInterval: this.dht.currentRefreshInterval / 1000,
          aggressiveInterval: this.dht.options.aggressiveRefreshInterval / 1000,
          standardInterval: this.dht.options.standardRefreshInterval / 1000,
          connectedPeers,
          routingNodes,
          bucketActivity: this.dht.bucketLastActivity.size,
          staleBuckets: []
        };

        // Check which buckets are stale
        const stalenessThreshold = this.dht.currentRefreshInterval * 2;
        for (const [bucketIndex, lastActivity] of this.dht.bucketLastActivity.entries()) {
          const timeSinceActivity = now - lastActivity;
          if (timeSinceActivity > stalenessThreshold) {
            status.staleBuckets.push({
              bucket: bucketIndex,
              staleFor: Math.round(timeSinceActivity / 1000)
            });
          }
        }

        console.log('🔄 Adaptive Refresh Status:');
        console.log(`Current mode: ${status.currentInterval}s interval`);
        console.log(`Peers: ${connectedPeers} connected, ${routingNodes} routing`);
        console.log(`Bucket activity: ${status.bucketActivity} buckets tracked`);
        console.log(`Stale buckets: ${status.staleBuckets.length}`);

        if (status.staleBuckets.length > 0) {
          console.log('Stale bucket details:', status.staleBuckets);
        }

        return status;
      },

      /**
       * Manually trigger background connection process
       */
      async triggerBackgroundConnections() {
        if (!this.dht) {
          console.log('DHT not available');
          return false;
        }

        console.log('🔗 Manually triggering background connection process...');
        await this.dht.connectToUnconnectedRoutingNodes();

        const allNodes = this.dht.routingTable.getAllNodes().length;
        const connectedPeers = this.dht.getConnectedPeers().length;
        console.log(`📊 Result: ${connectedPeers} connected of ${allNodes} nodes in routing table`);

        return true;
      },

      /**
       * Debug WebRTC message routing
       */
      debugWebRTCRouting() {
        if (!this.dht) {
          console.log('DHT not available');
          return null;
        }

        const allNodes = this.dht.routingTable.getAllNodes();
        const connectedPeers = this.dht.getConnectedPeers();

        console.log('🛣️ WebRTC Message Routing Debug');
        console.log(`Connected peers: ${connectedPeers.length}`);
        console.log(`Routing table nodes: ${allNodes.length}`);

        for (const node of allNodes) {
          const peerId = node.id.toString();
          const isConnected = this.dht.isPeerConnected(peerId);
          const distance = node.id.xorDistance(this.dht.localNodeId);

          console.log(`  ${peerId.substring(0, 8)}... - Connected: ${isConnected ? '✅' : '❌'} - Distance: ${distance.toString().substring(0, 8)}...`);

          if (!isConnected) {
            // Show routing path for unconnected peers
            const closestConnected = allNodes
              .filter(n => this.dht.isPeerConnected(n.id.toString()))
              .sort((a, b) => {
                const distA = a.id.xorDistance(node.id);
                const distB = b.id.xorDistance(node.id);
                return distA.compare(distB);
              });

            if (closestConnected.length > 0) {
              const nextHop = closestConnected[0].id.toString();
              console.log(`    Route to ${peerId.substring(0, 8)}... would go via ${nextHop.substring(0, 8)}...`);
            } else {
              console.log(`    No route available to ${peerId.substring(0, 8)}...`);
            }
          }
        }

        return {
          connectedPeers: connectedPeers.length,
          routingTableNodes: allNodes.length,
          unconnectedNodes: allNodes.filter(n => !this.dht.isPeerConnected(n.id.toString())).length
        };
      },

      /**
       * Force adaptive refresh recalculation
       */
      forceAdaptiveRefresh() {
        if (!this.dht) {
          console.log('DHT not available');
          return false;
        }

        console.log('🔄 Forcing adaptive refresh recalculation...');
        this.dht.scheduleAdaptiveRefresh();
        return true;
      },

      /**
       * Manually trigger stale bucket refresh
       */
      refreshStaleBuckets() {
        if (!this.dht) {
          console.log('DHT not available');
          return false;
        }

        console.log('🔄 Manually refreshing stale buckets...');
        this.dht.refreshStaleBuckets();
        return true;
      },

      // ===== ORGANIZED TEST SUITE =====
      tests: {
        // Network Testing
        network: {
          /**
           * Simulate complete network disconnection
           */
          async simulateDisconnection() {
            if (!window.YZSocialC.dht) {
              console.error('❌ DHT not available');
              return null;
            }

            console.log('🔌 TEST: Simulating network disconnection...');

            const connectedPeers = window.YZSocialC.dht.getConnectedPeers();
            console.log(`📊 Disconnecting from ${connectedPeers.length} connected peers`);

            // Store state for reconnection
            const disconnectionState = {
              timestamp: Date.now(),
              connectedPeers: connectedPeers.slice(),
              routingTableSize: window.YZSocialC.dht.routingTable.getAllNodes().length,
              membershipToken: window.YZSocialC.dht.membershipToken,
              useBootstrapForSignaling: window.YZSocialC.dht.useBootstrapForSignaling
            };

            // Disconnect from all peers
            const allNodes = window.YZSocialC.dht.routingTable.getAllNodes();
            for (const node of allNodes) {
              const peerId = node.id.toString();
              try {
                if (node.connectionManager && typeof node.connectionManager.destroyConnection === 'function') {
                  node.connectionManager.destroyConnection(peerId, 'test_disconnection');
                }
              } catch (error) {
                console.warn(`Failed to disconnect from ${peerId}:`, error);
              }
            }

            // Clear routing table
            const routingNodes = [...allNodes];
            for (const node of routingNodes) {
              window.YZSocialC.dht.routingTable.removeNode(node.id.toString());
            }

            // Disconnect from bootstrap
            if (window.YZSocialC.dht.bootstrap && window.YZSocialC.dht.bootstrap.isBootstrapConnected()) {
              window.YZSocialC.dht.bootstrap.disconnect();
            }

            console.log('💥 TEST: Complete disconnection achieved');
            console.log('State before disconnection:', disconnectionState);

            return disconnectionState;
          },

          /**
           * Test automatic reconnection using bridge system
           */
          async testReconnection() {
            if (!window.YZSocialC.dht) {
              console.error('❌ DHT not available');
              return null;
            }

            console.log('🔄 TEST: Starting reconnection test...');

            // Check if we have membership token
            if (!window.YZSocialC.dht.membershipToken) {
              console.error('❌ No membership token - cannot test reconnection');
              console.log('💡 Run simulateDisconnection() first after joining DHT');
              return null;
            }

            console.log('✅ Found membership token, proceeding with reconnection...');

            // Force reconnection to bootstrap
            window.YZSocialC.dht.useBootstrapForSignaling = true;

            try {
              // Reconnect to bootstrap
              if (window.YZSocialC.dht.bootstrap && typeof window.YZSocialC.dht.bootstrap.connect === 'function') {
                await window.YZSocialC.dht.bootstrap.connect();
                console.log('✅ Reconnected to bootstrap server');
              }

              // Send reconnection request
              const reconnectionRequest = {
                type: 'reconnection_request',
                membershipToken: window.YZSocialC.dht.membershipToken,
                nodeId: window.YZSocialC.dht.localNodeId.toString(),
                timestamp: Date.now()
              };

              if (window.YZSocialC.dht.bootstrap && typeof window.YZSocialC.dht.bootstrap.sendMessage === 'function') {
                await window.YZSocialC.dht.bootstrap.sendMessage(reconnectionRequest);
                console.log('📤 Sent reconnection request with membership token');
              }

              // Wait for connections to establish
              return new Promise((resolve) => {
                let checkCount = 0;
                const maxChecks = 15; // 30 seconds

                const checkInterval = setInterval(() => {
                  checkCount++;
                  const currentConnections = window.YZSocialC.dht.getConnectedPeers().length;

                  console.log(`🔍 Check ${checkCount}/${maxChecks}: ${currentConnections} connections`);

                  if (currentConnections > 0) {
                    clearInterval(checkInterval);
                    console.log(`✅ Reconnection successful! ${currentConnections} connections established`);

                    // Trigger peer discovery to rebuild routing table
                    setTimeout(() => {
                      window.YZSocialC.triggerPeerDiscovery();
                      window.YZSocialC.refreshBuckets();
                    }, 2000);

                    resolve({ success: true, connections: currentConnections });
                  } else if (checkCount >= maxChecks) {
                    clearInterval(checkInterval);
                    console.log('⏰ Reconnection timeout - no connections established');
                    resolve({ success: false, error: 'timeout' });
                  }
                }, 2000);
              });

            } catch (error) {
              console.error('❌ Reconnection test failed:', error);
              return { success: false, error: error.message };
            }
          },

          /**
           * Test bridge node connectivity
           */
          async testBridgeNodes() {
            console.log('🌉 TEST: Testing bridge node connectivity...');

            // This would test if bridge nodes are reachable
            // For now, we'll test via bootstrap server
            try {
              const bootstrapConnected = window.YZSocialC.dht.bootstrap && window.YZSocialC.dht.bootstrap.isBootstrapConnected();
              console.log(`Bootstrap connection: ${bootstrapConnected ? '✅' : '❌'}`);

              if (bootstrapConnected) {
                // Test bridge node communication
                const testMessage = {
                  type: 'bridge_test',
                  nodeId: window.YZSocialC.dht.localNodeId.toString(),
                  timestamp: Date.now()
                };

                await window.YZSocialC.dht.bootstrap.sendMessage(testMessage);
                console.log('📤 Sent bridge test message');
                return { success: true, bootstrapConnected: true };
              } else {
                return { success: false, error: 'Bootstrap not connected' };
              }

            } catch (error) {
              console.error('❌ Bridge test failed:', error);
              return { success: false, error: error.message };
            }
          },

          /**
           * Get reconnection status
           */
          getReconnectionStatus() {
            if (!window.YZSocialC.dht) {
              return { available: false, reason: 'DHT not available' };
            }

            return {
              available: true,
              hasMembershipToken: !!window.YZSocialC.dht.membershipToken,
              connectedPeers: window.YZSocialC.dht.getConnectedPeers().length,
              routingTableSize: window.YZSocialC.dht.routingTable.getAllNodes().length,
              bootstrapConnected: window.YZSocialC.dht.bootstrap ? window.YZSocialC.dht.bootstrap.isBootstrapConnected() : false,
              usingBootstrapSignaling: window.YZSocialC.dht.useBootstrapForSignaling
            };
          },

          /**
           * Test bridge connectivity (idempotent)
           */
          async testBridgeConnectivity() {
            console.log('🌉 TEST: Bridge connectivity test...');

            try {
              if (!window.YZSocialC.dht) {
                return {
                  success: false,
                  message: 'Bridge connectivity test failed: DHT not available',
                  error: 'DHT not available'
                };
              }

              const status = this.getReconnectionStatus();

              // Check if bridge system components are accessible
              const hasMembershipToken = !!window.YZSocialC.dht.membershipToken;
              const bootstrapConnected = window.YZSocialC.dht.bootstrap &&
                typeof window.YZSocialC.dht.bootstrap.isBootstrapConnected === 'function' &&
                window.YZSocialC.dht.bootstrap.isBootstrapConnected();

              const connectedPeers = window.YZSocialC.dht.getConnectedPeers().length;

              let bridgeStatus = 'unknown';

              if (hasMembershipToken && connectedPeers > 0) {
                bridgeStatus = 'active_member';
              } else if (bootstrapConnected && !hasMembershipToken) {
                bridgeStatus = 'genesis_ready';
              } else if (hasMembershipToken && connectedPeers === 0) {
                bridgeStatus = 'reconnection_ready';
              } else {
                bridgeStatus = 'not_connected';
              }

              const success = bridgeStatus !== 'not_connected';
              const message = `Bridge connectivity: ${bridgeStatus} (${connectedPeers} peers, membership: ${hasMembershipToken ? 'yes' : 'no'}, bootstrap: ${bootstrapConnected ? 'yes' : 'no'})`;

              console.log(`🌉 ${success ? '✅' : '❌'} ${message}`);

              return {
                success,
                message,
                bridgeStatus,
                hasMembershipToken,
                bootstrapConnected,
                connectedPeers,
                details: status
              };

            } catch (error) {
              console.error('❌ Bridge connectivity test failed:', error);
              return {
                success: false,
                message: `Bridge connectivity test failed: ${error.message}`,
                error: error.message
              };
            }
          }
        },

        // DHT Protocol Testing
        dht: {
          /**
           * Test store/retrieve operations
           */
          async testStoreRetrieve(testKey = 'test-key', testValue = 'test-value') {
            console.log('📦 TEST: Testing DHT store/retrieve...');

            try {
              const storeResult = await window.YZSocialC.testStore(testKey, testValue);
              console.log('Store result:', storeResult);

              if (!storeResult) {
                return {
                  success: false,
                  message: 'Store operation failed - no result returned',
                  error: 'Store operation failed'
                };
              }

              const retrieveResult = await window.YZSocialC.testGet(testKey);
              console.log('Retrieve result:', retrieveResult);

              // DHT get() returns the raw value directly, not an object with .value property
              const success = retrieveResult === testValue;

              const message = success
                ? `Store/retrieve successful: ${testKey} = ${testValue}`
                : `Store/retrieve failed: stored ${storeResult ? 'success' : 'failed'}, retrieved ${retrieveResult || 'null'}`;

              console.log(`Store/Retrieve test: ${success ? '✅' : '❌'} - ${message}`);

              return {
                success,
                message,
                stored: storeResult,
                retrieved: retrieveResult
              };

            } catch (error) {
              console.error('❌ Store/retrieve test failed:', error);
              return {
                success: false,
                message: `Store/retrieve test failed: ${error.message}`,
                error: error.message
              };
            }
          },

          /**
           * Test peer discovery mechanisms
           */
          async testPeerDiscovery() {
            console.log('🔍 TEST: Testing peer discovery...');

            try {
              if (!window.YZSocialC.dht || !window.YZSocialC.dht.isStarted) {
                return {
                  success: false,
                  message: 'DHT not started',
                  error: 'DHT not available'
                };
              }

              const beforeRouting = window.YZSocialC.dht.routingTable.getAllNodes().length;
              const beforeConnections = window.YZSocialC.dht.getConnectedPeers().length;

              // Trigger discovery
              window.YZSocialC.triggerPeerDiscovery();
              window.YZSocialC.refreshBuckets();

              // Wait and check results
              await new Promise(resolve => setTimeout(resolve, 5000));

              const afterRouting = window.YZSocialC.dht.routingTable.getAllNodes().length;
              const afterConnections = window.YZSocialC.dht.getConnectedPeers().length;

              const result = {
                routingTableGrowth: afterRouting - beforeRouting,
                connectionGrowth: afterConnections - beforeConnections,
                finalRoutingSize: afterRouting,
                finalConnections: afterConnections
              };

              console.log('🔍 Peer discovery results:', result);

              const hasDiscovery = result.routingTableGrowth > 0 || result.connectionGrowth > 0;

              return {
                success: hasDiscovery || result.finalConnections > 0,
                message: hasDiscovery
                  ? `Discovery successful: +${result.routingTableGrowth} routing, +${result.connectionGrowth} connections`
                  : `No new peers discovered (${result.finalConnections} existing connections)`,
                details: result
              };
            } catch (error) {
              console.error('Peer discovery test failed:', error);
              return {
                success: false,
                message: `Peer discovery test failed: ${error.message}`,
                error: error.message
              };
            }
          },

          /**
           * Store/retrieve test that cleans up after itself (idempotent)
           */
          async testStoreRetrieveWithCleanup() {
            console.log('📦 TEST: Store/retrieve with cleanup...');

            try {
              const testKey = 'idempotent-test-key';
              const testValue = `test-${Date.now()}`;

              console.log(`Storing test data: ${testKey} = ${testValue}`);
              const storeResult = await window.YZSocialC.testStore(testKey, testValue);
              console.log('Store result:', storeResult);

              // Wait briefly for storage to propagate
              await new Promise(resolve => setTimeout(resolve, 1000));

              const retrieveResult = await window.YZSocialC.testGet(testKey);
              console.log('Retrieve result:', retrieveResult);

              // Clean up immediately after test
              if (window.YZSocialC.dht && window.YZSocialC.dht.storage && window.YZSocialC.dht.storage.has(testKey)) {
                window.YZSocialC.dht.storage.delete(testKey);
                console.log(`🧹 Cleaned up test key: ${testKey}`);
              }

              // DHT get() returns the raw value directly, not an object with .value property
              const success = retrieveResult === testValue;

              const message = success
                ? `Store/retrieve with cleanup successful: ${testKey} = ${testValue}`
                : `Store/retrieve failed: stored ${storeResult ? 'success' : 'failed'}, retrieved ${retrieveResult || 'null'}`;

              return {
                success,
                message,
                stored: storeResult,
                retrieved: retrieveResult
              };

            } catch (error) {
              console.error('❌ Store/retrieve with cleanup test failed:', error);
              return {
                success: false,
                message: `Store/retrieve test failed: ${error.message}`,
                error: error.message
              };
            }
          },

          /**
           * Limited peer discovery test (less disruptive)
           */
          async testPeerDiscoveryLimited() {
            console.log('🔍 TEST: Limited peer discovery (non-disruptive)...');

            try {
              const beforeRouting = window.YZSocialC.dht.routingTable.getAllNodes().length;
              const beforeConnections = window.YZSocialC.dht.getConnectedPeers().length;

              console.log(`Before: ${beforeConnections} connected, ${beforeRouting} routing`);

              // Only perform passive discovery checks instead of aggressive discovery
              const routingNodes = window.YZSocialC.dht.routingTable.getAllNodes();
              const connectedPeers = window.YZSocialC.dht.getConnectedPeers();

              // Check for discrepancies without triggering new connections
              const routingButNotConnected = routingNodes.filter(node =>
                !connectedPeers.some(peer => peer.id === node.id.toString())
              ).length;

              const connectedButNotRouting = connectedPeers.filter(peer =>
                !routingNodes.some(node => node.id.toString() === peer.id)
              ).length;

              const success = routingButNotConnected === 0;
              const message = success
                ? `Peer discovery: no discrepancies (${beforeConnections} connected, ${beforeRouting} routing)`
                : `Peer discovery: ${routingButNotConnected} routing-only, ${connectedButNotRouting} connection-only discrepancies`;

              console.log(`🔍 ${success ? '✅' : '⚠️'} ${message}`);

              return {
                success,
                message,
                routingButNotConnected,
                connectedButNotRouting,
                finalRoutingSize: beforeRouting,
                finalConnections: beforeConnections
              };

            } catch (error) {
              console.error('❌ Limited peer discovery test failed:', error);
              return {
                success: false,
                message: `Limited peer discovery failed: ${error.message}`,
                error: error.message
              };
            }
          }
        },

        // Connection Testing
        connection: {
          /**
           * Test WebRTC signaling modes
           */
          testSignalingModes() {
            console.log('📡 TEST: Testing WebRTC signaling modes...');

            try {
              const signalingInfo = window.YZSocialC.getSignalingMode();
              const currentMode = signalingInfo.useBootstrapForSignaling ? 'bootstrap' : 'dht';
              console.log(`Current signaling mode: ${currentMode}`);

              const connectedPeers = signalingInfo.connectedPeers;
              const expectedMode = connectedPeers >= 1 ? 'dht' : 'bootstrap';

              const isCorrect = currentMode === expectedMode;
              console.log(`Expected: ${expectedMode}, Actual: ${currentMode} - ${isCorrect ? '✅' : '❌'}`);

              return {
                success: isCorrect,
                message: `Signaling mode ${isCorrect ? 'correct' : 'incorrect'}: expected ${expectedMode}, got ${currentMode}`,
                current: currentMode,
                expected: expectedMode,
                connectedPeers
              };
            } catch (error) {
              console.error('Signaling modes test failed:', error);
              return {
                success: false,
                message: `Signaling test failed: ${error.message}`,
                error: error.message
              };
            }
          },

          /**
           * Test connection health for all peers
           */
          testConnectionHealth() {
            console.log('🏥 TEST: Testing connection health...');

            try {
              const healthReport = window.YZSocialC.checkConnectionHealth();

              if (!healthReport) {
                return {
                  success: false,
                  message: 'Connection health check failed - DHT not available',
                  error: 'DHT not available'
                };
              }

              const hasConnections = healthReport.connectedPeers > 0;
              const allConnected = Object.values(healthReport.connectionDetails || {})
                .every(detail => detail.isConnected);

              const success = hasConnections && allConnected;

              return {
                success,
                message: `Connection health ${success ? 'good' : 'issues detected'}: ${healthReport.connectedPeers} peers connected`,
                healthReport
              };
            } catch (error) {
              console.error('Connection health test failed:', error);
              return {
                success: false,
                message: `Connection health test failed: ${error.message}`,
                error: error.message
              };
            }
          }
        }
      },

      /**
       * Run all tests in sequence
       */
      async runAllTests() {
        console.log('🧪 RUNNING ALL TESTS...');
        console.log('='.repeat(50));

        const results = {};

        // Capture initial state for restoration
        const initialState = this.captureTestState();

        try {
          // Read-only tests (safe to run)
          console.log('\n📡 READ-ONLY TESTS');
          console.log('-'.repeat(20));
          results.signaling = await this.tests.connection.testSignalingModes();
          results.connectionHealth = await this.tests.connection.testConnectionHealth();

          // Bridge status test - normalize result
          const bridgeStatus = this.tests.network.getReconnectionStatus();
          results.bridgeStatus = {
            success: bridgeStatus.available,
            message: `Bridge status: ${bridgeStatus.available ? 'available' : 'not available'}${bridgeStatus.reason ? ` (${bridgeStatus.reason})` : ''}`,
            details: bridgeStatus
          };

          // State-modifying tests (with cleanup)
          console.log('\n📦 STATE-MODIFYING TESTS');
          console.log('-'.repeat(20));

          // Store/retrieve test with cleanup
          results.storeRetrieve = await this.tests.dht.testStoreRetrieveWithCleanup();

          // Bridge connectivity test (NEW)
          results.bridgeConnectivity = await this.tests.network.testBridgeConnectivity();

          // Peer discovery test (modified to be less disruptive)
          results.peerDiscovery = await this.tests.dht.testPeerDiscoveryLimited();

          console.log('\n🔄 RESTORING INITIAL STATE...');
          await this.restoreTestState(initialState);

          console.log('\n✅ ALL TESTS COMPLETED');
          console.log('='.repeat(50));

          return results;

        } catch (error) {
          console.error('❌ Test suite failed:', error);

          // Attempt to restore state even on failure
          try {
            await this.restoreTestState(initialState);
            console.log('🔄 Initial state restored after error');
          } catch (restoreError) {
            console.error('❌ Failed to restore state:', restoreError);
          }

          return { error: error.message, partialResults: results };
        }
      },

      /**
       * Capture current DHT state for test restoration
       */
      captureTestState() {
        if (!this.dht) return null;

        return {
          connectedPeers: this.dht.getConnectedPeers().slice(), // copy array
          routingTableSize: this.dht.routingTable.getAllNodes().length,
          storageKeys: Array.from(this.dht.storage.keys()),
          timestamp: Date.now()
        };
      },

      /**
       * Restore DHT state after tests
       */
      async restoreTestState(initialState) {
        if (!initialState || !this.dht) {
          console.log('No initial state to restore');
          return;
        }

        // Clean up test data from storage
        const testKeys = ['test-key', 'test-data', 'peer-discovery-test'];
        for (const key of testKeys) {
          if (this.dht.storage.has(key)) {
            this.dht.storage.delete(key);
            console.log(`🧹 Cleaned up test key: ${key}`);
          }
        }

        console.log('📊 State restoration complete');
      }
    };

    console.log('Development helpers available at window.YZSocialC');
    console.log('DHT Control: YZSocialC.startDHT(), YZSocialC.getStats(), YZSocialC.getPeers()');
    console.log('Directed connections: YZSocialC.copyNodeId(), YZSocialC.connectToPeer(peerId)');
    console.log('DHT Invitations: YZSocialC.inviteNewClient(clientId) - Help new clients join DHT');
    console.log('🌟 GENESIS PEER: Controlled by bootstrap server with -createNewDHT flag');
    console.log('Network testing: YZSocialC.testConnectivity()');
    console.log('Debug tools: YZSocialC.debugRoutingTable(), YZSocialC.cleanupRoutingTable()');
    console.log('UI/State debug: YZSocialC.refreshUI(), YZSocialC.debugConnectionState(), YZSocialC.forceClearUI()');
    console.log('Phantom peer investigation: YZSocialC.investigatePhantomPeer(peerId)');
    console.log('Manual peer discovery: YZSocialC.triggerPeerDiscovery() - Force DHT to discover missing peers');
    console.log('Bucket maintenance: YZSocialC.refreshBuckets() - Force k-bucket refresh and node discovery');
    console.log('DHT Signaling: YZSocialC.switchToDHTSignaling() - Force switch to DHT-based ICE sharing');
    console.log('Signaling Status: YZSocialC.getSignalingMode() - Check current signaling mode');
    console.log('Routing Table: YZSocialC.syncRoutingTable() - Force sync connected peers to routing table');
    console.log('Force Add Peers: YZSocialC.forceAddConnectedPeersToRouting() - Force add all connected peers to routing table');
    console.log('Debug Events: YZSocialC.debugEventHandlers() - Debug event handler setup and manually trigger peer handling');
    console.log('🔗 Keep-Alive (NEW): YZSocialC.getKeepAliveStatus() - Check WebRTC keep-alive status for inactive tabs');
    console.log('🔗 Test Keep-Alive: YZSocialC.testKeepAlivePing(peerId) - Manually send keep-alive ping');
    console.log('🔗 Tab Simulation: YZSocialC.simulateTabVisibilityChange() - Test inactive tab behavior');
    console.log('🔗 Health Check: YZSocialC.checkConnectionHealth() - Check connection health for all peers');
    console.log('🔗 WebRTC Debug: YZSocialC.debugWebRTCStates() - Debug WebRTC connection states and issues');
    console.log('📊 Traffic Stats (NEW): YZSocialC.getTrafficStats() - Monitor find_node rate limiting and DHT traffic');
    console.log('🧹 Cleanup Maps: YZSocialC.cleanupTrackingMaps() - Manually clean up tracking maps');
    console.log('🔄 Adaptive Refresh (NEW): YZSocialC.getAdaptiveRefreshStatus() - Check Kademlia-compliant refresh status');
    console.log('🔄 Force Adaptive: YZSocialC.forceAdaptiveRefresh() - Recalculate refresh timing');
    console.log('🔄 Refresh Stale: YZSocialC.refreshStaleBuckets() - Manually refresh only stale buckets');
    console.log('🔗 Background Connections (NEW): YZSocialC.triggerBackgroundConnections() - Connect to unconnected routing table nodes');
    console.log('🛣️ WebRTC Routing (NEW): YZSocialC.debugWebRTCRouting() - Debug DHT message routing paths');
    console.log('');
    console.log('🧪 ORGANIZED TEST SUITE:');
    console.log('   YZSocialC.tests.network.simulateDisconnection() - Test complete network disconnection');
    console.log('   YZSocialC.tests.network.testReconnection() - Test bridge-based reconnection');
    console.log('   YZSocialC.tests.network.testBridgeNodes() - Test bridge node connectivity');
    console.log('   YZSocialC.tests.network.getReconnectionStatus() - Check reconnection capability');
    console.log('   YZSocialC.tests.dht.testStoreRetrieve() - Test DHT storage operations');
    console.log('   YZSocialC.tests.dht.testPeerDiscovery() - Test peer discovery mechanisms');
    console.log('   YZSocialC.tests.connection.testSignalingModes() - Test WebRTC signaling modes');
    console.log('   YZSocialC.tests.connection.testConnectionHealth() - Test connection health');
    console.log('   YZSocialC.runAllTests() - Run complete test suite');
  }

  /**
   * Display error message to user
   */
  displayError(message) {
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: #dc3545;
      color: white;
      padding: 15px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      z-index: 10000;
      max-width: 400px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;

    errorDiv.innerHTML = `
      <strong>Error:</strong> ${message}
      <button style="
        background: none;
        border: none;
        color: white;
        float: right;
        cursor: pointer;
        font-size: 18px;
        margin-left: 10px;
      " onclick="this.parentElement.remove()">×</button>
    `;

    document.body.appendChild(errorDiv);

    // Auto-remove after 10 seconds
    setTimeout(() => {
      if (errorDiv.parentElement) {
        errorDiv.remove();
      }
    }, 10000);
  }

  /**
   * Handle application lifecycle
   */
  async destroy() {
    console.log('Destroying application...');

    try {
      if (this.visualizer) {
        this.visualizer.destroy();
        this.visualizer = null;
      }

      if (this.dht && this.dht.isStarted) {
        await this.dht.stop();
      }

      this.dht = null;
      this.isInitialized = false;

      console.log('Application destroyed successfully');
    } catch (error) {
      console.error('Error during application destruction:', error);
    }
  }
}

/**
 * Application startup
 */
async function main() {
  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    await new Promise(resolve => {
      document.addEventListener('DOMContentLoaded', resolve);
    });
  }

  // Enhanced HMR protection - prevent multiple instances
  if (window.YZSocialCInitializing) {
    console.log('Application already initializing, aborting duplicate...');
    return;
  }

  if (window.YZSocialC) {
    if (window.YZSocialC.app) {
      console.log('Application already initialized, skipping...');
      return;
    }
    // If YZSocialC exists but no app, destroy any existing instances
    if (window.YZSocialC.dht) {
      console.log('Cleaning up existing DHT instance...');
      try {
        if (window.YZSocialC.dht.isStarted) {
          await window.YZSocialC.dht.stop();
        }
        window.YZSocialC.dht = null;
      } catch (error) {
        console.warn('Error cleaning up existing DHT:', error);
      }
    }
  }

  // Set initialization flag to prevent concurrent initialization
  window.YZSocialCInitializing = true;

  console.log('Starting YZSocialC DHT Application...');

  // Check for required features
  if (!window.RTCPeerConnection) {
    alert('WebRTC is not supported in this browser. Please use a modern browser.');
    return;
  }

  if (!window.WebSocket) {
    alert('WebSocket is not supported in this browser. Please use a modern browser.');
    return;
  }

  // Create and initialize application
  const app = new App();

  try {
    await app.initialize();

    // Clear initialization flag after successful initialization
    window.YZSocialCInitializing = false;

    // Handle page unload
    window.addEventListener('beforeunload', async (event) => {
      if (app.dht && app.dht.isStarted) {
        // Try to gracefully shutdown
        event.preventDefault();
        event.returnValue = '';

        setTimeout(async () => {
          await app.destroy();
          window.location.reload();
        }, 100);
      }
    });

  } catch (error) {
    console.error('Application startup failed:', error);
    app.displayError('Application startup failed: ' + error.message);

    // Clear initialization flag on error too
    window.YZSocialCInitializing = false;
  }
}

// Start the application
main().catch(console.error);

export { App };