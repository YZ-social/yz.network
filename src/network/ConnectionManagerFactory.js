import { WebRTCConnectionManager } from './WebRTCConnectionManager.js';
import { WebSocketConnectionManager } from './WebSocketConnectionManager.js';
import { HybridConnectionManager } from './HybridConnectionManager.js';
import { RelayManager } from './RelayManager.js';

/**
 * Factory for creating appropriate connection managers based on environment and peer types
 */
export class ConnectionManagerFactory {
  static localNodeType = null;
  static defaultOptions = {};
  static managerCache = new Map(); // Cache connection managers by peer ID
  static globalMetadata = new Map(); // Global metadata store for all managers
  
  // Shared RelayManager instance for browser-to-browser relay connections
  static relayManager = null;
  
  // Bridge node ID for relay connections (set by BootstrapClient)
  static bridgeNodeId = null;
  
  // Flag to enable/disable hybrid relay-first strategy
  static useHybridStrategy = true;

  /**
   * Detect the current node type from environment
   * @returns {string} Node type ('nodejs', 'browser', 'webworker', etc.)
   */
  static detectNodeType() {
    // PRIORITY 1: Check for Web Workers first (most specific)
    if (typeof self !== 'undefined' && typeof importScripts === 'function') {
      return 'webworker';
    }

    // PRIORITY 2: Belt-and-suspenders Node.js detection
    // Check both window absence AND process presence to avoid bundler polyfill issues
    // This approach proven to work in WebSocketConnectionManager despite bundler quirks
    if (typeof window === 'undefined' && typeof process !== 'undefined') {
      // Additional verification: check for Node.js-specific process properties
      if (process.versions && process.versions.node) {
        return 'nodejs';
      }
      // Even without versions.node, if we have no window but have process, likely Node.js
      return 'nodejs';
    }

    // PRIORITY 3: Browser detection (if not Node.js from above)
    // Use process absence as primary check (more reliable per Howard's findings)
    if (typeof process === 'undefined' && typeof document !== 'undefined') {
      return 'browser';
    }

    // Future: Add other environment detection (Deno, Bun, etc.)

    // Fallback - if we have document but unclear environment, assume browser
    if (typeof document !== 'undefined') {
      return 'browser';
    }

    // Last resort - assume Node.js
    console.warn('⚠️ Unable to confidently detect environment, defaulting to nodejs');
    return 'nodejs';
  }

  /**
   * Initialize transport factory
   * @param {object} options - Configuration options
   */
  static initializeTransports(options = {}) {
    ConnectionManagerFactory.localNodeType = ConnectionManagerFactory.detectNodeType();
    ConnectionManagerFactory.defaultOptions = options;
    
    // Initialize shared RelayManager for browser-to-browser relay connections
    if (ConnectionManagerFactory.localNodeType === 'browser' && !ConnectionManagerFactory.relayManager) {
      ConnectionManagerFactory.relayManager = new RelayManager({
        maxRelaySessions: 50, // Browser can handle fewer relay sessions
        sessionTimeout: 5 * 60 * 1000 // 5 minutes
      });
      console.log('🔄 Initialized shared RelayManager for browser relay connections');
    }

    console.log(`🏗️ ConnectionManagerFactory initialized for ${ConnectionManagerFactory.localNodeType} environment`);
  }
  
  /**
   * Set the bridge node ID for relay connections
   * Called by BootstrapClient when connected to a bridge node
   * @param {string} bridgeNodeId - Bridge node ID
   */
  static setBridgeNode(bridgeNodeId) {
    ConnectionManagerFactory.bridgeNodeId = bridgeNodeId;
    console.log(`🌉 ConnectionManagerFactory: Bridge node set to ${bridgeNodeId?.substring(0, 8) || 'null'}...`);
  }
  
  /**
   * Get the shared RelayManager instance
   * @returns {RelayManager|null}
   */
  static getRelayManager() {
    return ConnectionManagerFactory.relayManager;
  }
  
  /**
   * Enable or disable hybrid relay-first strategy
   * @param {boolean} enabled - Whether to use hybrid strategy
   */
  static setHybridStrategy(enabled) {
    ConnectionManagerFactory.useHybridStrategy = enabled;
    console.log(`🔄 Hybrid relay-first strategy ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Get appropriate manager for a peer connection
   * @param {string} peerId - Target peer ID
   * @param {object} peerMetadata - Peer metadata (optional)
   * @returns {ConnectionManager} Appropriate connection manager
   */
  static getManagerForPeer(peerId, peerMetadata = null) {
    // BUGFIX: Disabled manager caching to fix routing bug when multiple DHT nodes
    // run in same process. Each DHT instance needs its own isolated managers.
    // TODO: Implement per-instance caching using localNodeId in cache key
    // OLD CODE (BROKEN):
    // if (ConnectionManagerFactory.managerCache.has(peerId)) {
    //   console.log(`🔄 Reusing cached connection manager for ${peerId.substring(0, 8)}...`);
    //   return ConnectionManagerFactory.managerCache.get(peerId);
    // }

    // Determine target node type from metadata
    let targetNodeType = 'browser'; // default assumption for peers without explicit nodeType
    if (peerMetadata) {
      // Explicit nodeType takes precedence
      if (peerMetadata.nodeType === 'nodejs' || peerMetadata.nodeType === 'nodejs-active') {
        targetNodeType = 'nodejs';
      } else if (peerMetadata.nodeType === 'browser') {
        targetNodeType = 'browser';
      } else if (peerMetadata.nodeType === 'bridge') {
        // Bridge nodes are Node.js servers
        targetNodeType = 'nodejs';
      } else if (peerMetadata.listeningAddress || peerMetadata.publicWssAddress) {
        // Has server address = Node.js server
        targetNodeType = 'nodejs';
      } else if (peerMetadata.membershipToken && !peerMetadata.listeningAddress) {
        // Has membership token but no server address = browser client
        targetNodeType = 'browser';
      }
      // If none of the above, keep default 'browser'
    }

    // Only log when there might be an issue (mismatched types)
    if (peerMetadata && !peerMetadata.nodeType && targetNodeType === 'browser') {
      console.log(`🔍 [ConnMgr] Inferred ${targetNodeType} for ${peerId.substring(0, 8)} (no explicit nodeType)`);
    }

    // Create manager on-demand based on connection requirements
    const manager = ConnectionManagerFactory.createForConnection(
      ConnectionManagerFactory.localNodeType,
      targetNodeType,
      ConnectionManagerFactory.defaultOptions
    );

    // Apply any existing global metadata to the new manager's local store
    // This is for handshake coordination before DHTNode exists
    if (manager.localMetadataStore) {
      for (const [metaPeerId, metadata] of ConnectionManagerFactory.globalMetadata.entries()) {
        manager.localMetadataStore.set(metaPeerId, metadata);
      }
    }

    // BUGFIX: Disabled caching (see getManagerForPeer comment above)
    // ConnectionManagerFactory.managerCache.set(peerId, manager);
    // console.log(`💾 Cached new connection manager for ${peerId.substring(0, 8)}...`);

    return manager;
  }

  /**
   * Create connection manager for specific connection type
   * @param {string} localNodeType - 'nodejs', 'browser', etc.
   * @param {string} targetNodeType - 'nodejs', 'browser', etc.
   * @param {Object} options - Configuration options
   * @returns {ConnectionManager} Appropriate connection manager instance
   */
  static createForConnection(localNodeType, targetNodeType, options = {}) {
    // Transport selection logic:
    // Browser → Browser: HybridConnectionManager (relay-first with WebRTC upgrade) or WebRTC
    // Browser → Node.js: WebSocket (Node.js is server)
    // Node.js → Browser: WebSocket (Node.js is server)
    // Node.js → Node.js: WebSocket
    // Future: Add LoRa, Bluetooth, etc.

    if (localNodeType === 'browser' && targetNodeType === 'browser') {
      // Use hybrid relay-first strategy if enabled and bridge node is available
      if (ConnectionManagerFactory.useHybridStrategy && 
          ConnectionManagerFactory.bridgeNodeId && 
          ConnectionManagerFactory.relayManager) {
        console.log('🚀 Creating HybridConnectionManager for Browser↔Browser (relay-first strategy)');
        
        // Task 6.1: Get local connection profile for IPv6 detection
        // This allows HybridConnectionManager to skip relay when both peers have IPv6
        const localConnectionProfile = ConnectionManagerFactory.getLocalConnectionProfile();
        
        return new HybridConnectionManager({
          localNodeType,
          targetNodeType,
          relayManager: ConnectionManagerFactory.relayManager,
          bridgeNodeId: ConnectionManagerFactory.bridgeNodeId,
          localConnectionProfile, // Task 6.1: Pass local profile for IPv6 detection
          ...options
        });
      }
      
      // Fallback to pure WebRTC if hybrid not available
      console.log('🚀 Creating WebRTCConnectionManager for Browser↔Browser');
      return new WebRTCConnectionManager({
        localNodeType,
        targetNodeType,
        ...options
      });
    } else {
      // All other combinations use WebSocket
      console.log(`🌐 Creating WebSocketConnectionManager for ${localNodeType}→${targetNodeType}`);
      return new WebSocketConnectionManager({
        enableServer: false,
        localNodeType,
        targetNodeType,
        ...options
      });
    }
  }
  
  /**
   * Get the local node's connection profile
   * Task 6.1: Used to detect IPv6 availability for direct-only strategy
   * @returns {Object|null} Connection profile or null if not available
   */
  static getLocalConnectionProfile() {
    // The local connection profile is stored in the local node's metadata
    // under the 'connectionProfile' key
    for (const [peerId, metadata] of ConnectionManagerFactory.globalMetadata.entries()) {
      if (metadata && metadata.connectionProfile) {
        return metadata.connectionProfile;
      }
    }
    return null;
  }

  /**
   * Remove cached connection manager for a peer
   * @param {string} peerId - Peer ID
   */
  static removePeerManager(peerId) {
    if (ConnectionManagerFactory.managerCache.has(peerId)) {
      console.log(`🗑️ Removing cached connection manager for ${peerId.substring(0, 8)}...`);
      ConnectionManagerFactory.managerCache.delete(peerId);
    }
  }

  /**
   * Get all cached connection managers
   * @returns {Array} Array of all cached connection manager instances
   */
  static getAllCachedManagers() {
    return Array.from(ConnectionManagerFactory.managerCache.values());
  }

  /**
   * Clear all cached connection managers
   */
  static clearManagerCache() {
    console.log(`🧹 Clearing ${ConnectionManagerFactory.managerCache.size} cached connection managers`);
    ConnectionManagerFactory.managerCache.clear();
  }

  /**
   * Set global metadata for a peer ID (typically used for LOCAL node metadata)
   * This is especially important for storing metadata about THIS node that needs
   * to be shared during handshakes (e.g., listeningAddress, nodeType, isBridgeNode)
   * @param {string} peerId - Peer ID (typically local node ID)
   * @param {object} metadata - Metadata to set
   */
  static setPeerMetadata(peerId, metadata) {
    ConnectionManagerFactory.globalMetadata.set(peerId, metadata);

    // Apply metadata to all cached managers' local stores
    // This ensures the metadata is available during handshakes
    for (const manager of ConnectionManagerFactory.managerCache.values()) {
      if (manager.localMetadataStore) {
        manager.localMetadataStore.set(peerId, metadata);
      }
    }
  }

  /**
   * Get global metadata for a peer ID
   * @param {string} peerId - Peer ID
   * @returns {object|null} Metadata or null if not found
   */
  static getPeerMetadata(peerId) {
    return ConnectionManagerFactory.globalMetadata.get(peerId) || null;
  }
}
