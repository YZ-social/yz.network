import { KademliaDHT } from './dht/KademliaDHT.js';
import { DHTVisualizer } from './ui/DHTVisualizer.js';
import { DHTNode } from './core/DHTNode.js';

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
      // Create DHT instance with configuration
      this.dht = new KademliaDHT({
        k: 20,
        alpha: 3,
        replicateK: 3,
        bootstrapServers: [
          'ws://localhost:8080',
          'ws://localhost:8081' // Fallback server
        ],
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

      // Create UI visualizer
      this.visualizer = new DHTVisualizer(this.dht);

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
      getPeers: () => this.dht ? this.dht.connectionManager.getConnectedPeers() : [],
      
      // Development tools
      async testStore(key = 'test-key', value = 'test-value') {
        if (!this.dht || !this.dht.isStarted) {
          console.warn('DHT not started');
          return false;
        }
        try {
          const result = await this.dht.store(key, value);
          console.log(`Store test result: ${result}`);
          return result;
        } catch (error) {
          console.error('Store test failed:', error);
          return false;
        }
      },
      
      async testGet(key = 'test-key') {
        if (!this.dht || !this.dht.isStarted) {
          console.warn('DHT not started');
          return null;
        }
        try {
          const result = await this.dht.get(key);
          console.log(`Get test result: ${result}`);
          return result;
        } catch (error) {
          console.error('Get test failed:', error);
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
          connectedPeers: this.dht.connectionManager.getConnectedPeers().length,
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
          return true;
        } catch (error) {
          console.error('Connectivity test failed:', error);
          return false;
        }
      },
      
      debugRoutingTable() {
        if (!this.dht) return null;
        const routingNodes = this.dht.routingTable.getAllNodes();
        const connectedPeers = this.dht.connectionManager.getConnectedPeers();
        
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
        
        const connectionPeers = this.dht.connectionManager ? this.dht.connectionManager.getConnectedPeers() : [];
        const routingNodes = this.dht.routingTable ? this.dht.routingTable.getAllNodes() : [];
        const connectionStats = this.dht.connectionManager ? this.dht.connectionManager.getStats() : {};
        
        // Also get ALL peers (including filtered ones) for debugging
        const allConnectionPeers = this.dht.connectionManager ? Array.from(this.dht.connectionManager.connections.keys()).filter(peerId => {
          return this.dht.connectionManager.isConnected(peerId);
        }) : [];
        
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
        const connectionExists = this.dht.connectionManager.connections.has(suspiciousPeerId);
        const isConnected = this.dht.connectionManager.isConnected(suspiciousPeerId);
        const isValidDHTPeer = this.dht.isValidDHTPeer ? this.dht.isValidDHTPeer(suspiciousPeerId) : true;
        
        // Check if it's in routing table
        const routingNode = this.dht.routingTable.getNode(suspiciousPeerId);
        
        console.log(`🔍 Connection exists: ${connectionExists}`);
        console.log(`🔍 Is connected: ${isConnected}`);
        console.log(`🔍 Valid DHT peer: ${isValidDHTPeer}`);
        console.log(`🔍 In routing table: ${!!routingNode}`);
        
        if (connectionExists) {
          const connection = this.dht.connectionManager.connections.get(suspiciousPeerId);
          console.log(`🔍 Connection state:`, {
            connected: isConnected,
            type: connection instanceof WebSocket ? 'WebSocket' : 'WebRTC'
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
            type: this.dht.connectionManager.connections.get(suspiciousPeerId) instanceof WebSocket ? 'WebSocket' : 'WebRTC'
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
          await this.dht.triggerPeerDiscovery();
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
          await this.dht.refreshBuckets();
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
          connectedPeers: this.dht.connectionManager.getConnectedPeers().length,
          routingTableSize: this.dht.routingTable.getAllNodes().length,
          connectedPeersList: this.dht.connectionManager.getConnectedPeers(),
          routingTablePeers: this.dht.routingTable.getAllNodes().map(n => n.id.toString())
        };
      },
      
      syncRoutingTable() {
        if (!this.dht) {
          console.log('DHT not available');
          return false;
        }

        const connectedPeers = this.dht.connectionManager.getConnectedPeers();
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
        
        const connectedPeers = this.dht.connectionManager.getConnectedPeers();
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
        console.log('Connection manager:', !!this.dht.connectionManager);
        console.log('Connection listeners:', this.dht.connectionManager.listenerCount('peerConnected'));
        
        // Test manual peer connected event
        const connectedPeers = this.dht.connectionManager.getConnectedPeers();
        console.log(`Connected peers: ${connectedPeers.length}`, connectedPeers);
        
        // Test manual event emission
        if (connectedPeers.length > 0) {
          console.log(`🧪 Testing manual event emission for ${connectedPeers[0]}`);
          this.dht.connectionManager.emit('peerConnected', { peerId: connectedPeers[0] });
          
          console.log(`🔄 Also manually triggering handlePeerConnected for ${connectedPeers[0]}`);
          this.dht.handlePeerConnected(connectedPeers[0]);
        } else {
          // Test with fake peer ID to check if event handler is working
          console.log('🧪 Testing event handler with fake peer ID...');
          this.dht.connectionManager.emit('peerConnected', { peerId: 'test-peer-id-12345' });
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
        
        // Fallback for HybridConnectionManager (legacy)
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
        
        // Fallback for HybridConnectionManager (legacy)
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
      checkConnectionHealth() {
        if (!this.dht || !this.dht.connectionManager) {
          console.log('DHT or connection manager not available');
          return null;
        }
        
        const cm = this.dht.connectionManager;
        console.log('🩺 Connection Health Check');
        console.log(`Connection Manager: ${cm.constructor.name}`);
        
        const connectedPeers = cm.getConnectedPeers();
        const healthReport = {
          totalConnections: cm.connections?.size || 0,
          connectedPeers: connectedPeers.length,
          connectionDetails: {}
        };
        
        for (const peerId of connectedPeers) {
          const connection = cm.connections?.get(peerId);
          const connectionType = cm.connectionTypes?.get(peerId);
          const connectionState = cm.connectionStates?.get(peerId);
          
          let actualState = 'unknown';
          if (connectionType === 'webrtc' && connection) {
            actualState = connection.connectionState;
          } else if (connectionType === 'websocket' && connection) {
            actualState = connection.readyState;
          }
          
          healthReport.connectionDetails[peerId] = {
            type: connectionType,
            state: connectionState,
            actualState,
            isConnected: cm.isConnected(peerId)
          };
          
          console.log(`  ${peerId.substring(0, 8)}... (${connectionType}): ${actualState} ${cm.isConnected(peerId) ? '✅' : '❌'}`);
        }
        
        // Check for failed connections
        if (cm.connections) {
          for (const [peerId, connection] of cm.connections) {
            const isConnected = cm.isConnected(peerId);
            if (!isConnected) {
              console.warn(`  ⚠️ ${peerId.substring(0, 8)}... appears disconnected but still in connections map`);
            }
          }
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
        
        // Fallback for HybridConnectionManager (legacy)
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
       * Force check connection health for all peers
       */
      checkConnectionHealth() {
        if (!this.dht || !this.dht.connectionManager) {
          console.log('DHT or connection manager not available');
          return false;
        }
        
        const cm = this.dht.connectionManager;
        console.log('🩺 Connection Health Check');
        console.log(`Connection Manager: ${cm.constructor.name}`);
        
        const connectedPeers = cm.getConnectedPeers();
        const healthReport = {
          totalConnections: cm.connections?.size || 0,
          connectedPeers: connectedPeers.length,
          connectionDetails: {}
        };
        
        for (const peerId of connectedPeers) {
          const connection = cm.connections?.get(peerId);
          const connectionType = cm.connectionTypes?.get(peerId);
          const connectionState = cm.connectionStates?.get(peerId);
          
          let actualState = 'unknown';
          if (connectionType === 'webrtc' && connection) {
            actualState = connection.connectionState;
          } else if (connectionType === 'websocket' && connection) {
            actualState = connection.readyState;
          }
          
          healthReport.connectionDetails[peerId] = {
            type: connectionType,
            state: connectionState,
            actualState,
            isConnected: cm.isConnected(peerId)
          };
          
          console.log(`  ${peerId.substring(0, 8)}... (${connectionType}): ${actualState} ${cm.isConnected(peerId) ? '✅' : '❌'}`);
        }
        
        return healthReport;
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
        const connectedPeers = this.dht.connectionManager.getConnectedPeers().length;
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
        const connectedPeers = this.dht.connectionManager.getConnectedPeers().length;
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
        const connectedPeers = this.dht.connectionManager.getConnectedPeers();
        
        console.log('🛣️ WebRTC Message Routing Debug');
        console.log(`Connected peers: ${connectedPeers.length}`);
        console.log(`Routing table nodes: ${allNodes.length}`);
        
        for (const node of allNodes) {
          const peerId = node.id.toString();
          const isConnected = this.dht.connectionManager.isConnected(peerId);
          const distance = node.id.xorDistance(this.dht.localNodeId);
          
          console.log(`  ${peerId.substring(0, 8)}... - Connected: ${isConnected ? '✅' : '❌'} - Distance: ${distance.toString().substring(0, 8)}...`);
          
          if (!isConnected) {
            // Show routing path for unconnected peers
            const closestConnected = allNodes
              .filter(n => this.dht.connectionManager.isConnected(n.id.toString()))
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
          unconnectedNodes: allNodes.filter(n => !this.dht.connectionManager.isConnected(n.id.toString())).length
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