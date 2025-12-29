/**
 * Browser DHT Client - Hybrid DHT node for browser environments
 *
 * This client connects to browser peers via WebRTC and Node.js peers via WebSocket.
 * Uses bootstrap server only for initial peer discovery and invitation exchange.
 *
 * Architecture:
 * - Browser-to-Browser: WebRTC DataChannels with keep-alive for inactive tabs
 * - Browser-to-Node.js: WebSocket client connections (Node.js acts as WebSocket server)
 * - Cryptographic Identity: ECDSA P-256 keys stored in IndexedDB
 * - Node ID: Derived from public key hash (160-bit Kademlia ID)
 */

import { DHTClient } from '../core/DHTClient.js';
import { IdentityStore } from './IdentityStore.js';
import { DHTNodeId } from '../core/DHTNodeId.js';

/**
 * Browser DHT Client with WebRTC connection support and cryptographic identity
 */
export class BrowserDHTClient extends DHTClient {
  constructor(options = {}) {
    // Call parent constructor first (generates temporary node ID)
    super(options);

    // Initialize identity store
    // The real node ID will be set in start() after loading identity
    // useTabIdentity: enables testing multiple clients in same browser (different tabs)
    this.identityStore = new IdentityStore({
      useTabIdentity: options.useTabIdentity || false
    });
    this.identity = null;

    // Metrics tracking for browser client
    this.metrics = {
      startTime: Date.now(),
      bytesReceived: 0,
      bytesSent: 0,
      dataTransferSamples: []
    };
  }

  /**
   * Override generateNodeId to use temporary placeholder
   * Actual node ID will be set during start() after identity is loaded
   */
  generateNodeId() {
    // Return temporary placeholder - will be replaced in start()
    const tempSeed = new Uint8Array(20);
    crypto.getRandomValues(tempSeed);
    return new DHTNodeId(tempSeed);
  }

  /**
   * Override start() to initialize identity before DHT
   */
  async start() {
    console.log('🔑 BrowserDHTClient: Initializing cryptographic identity...');

    // Load or generate identity
    this.identity = await this.identityStore.getOrCreate();

    // Convert node ID string to DHTNodeId object
    this.nodeId = DHTNodeId.fromHex(this.identity.nodeId);

    console.log(`✅ BrowserDHTClient: Identity loaded`);
    console.log(`   Node ID: ${this.identity.nodeId.substring(0, 16)}...`);
    console.log(`   Public Key: ${JSON.stringify(this.identity.publicKey).substring(0, 60)}...`);

    // CRITICAL: Set up authentication handler BEFORE connecting to bootstrap
    // so we're ready to respond when the challenge arrives
    this.setupAuthenticationHandlerEarly();

    // Now call parent start() with proper node ID
    const result = await super.start();

    // Pass metrics tracker to DHT for data transfer tracking
    if (this.dht) {
      this.dht.metricsTracker = this;
    }

    // Setup tab visibility handling for automatic disconnect/reconnect
    this.setupTabVisibilityHandling();

    return result;
  }

  /**
   * Record data transfer (bytes sent/received) - compatible with ActiveDHTNode interface
   * Fail-safe implementation that never throws (Requirement 5.1, 5.3)
   */
  recordDataTransfer(bytesSent = 0, bytesReceived = 0) {
    try {
      // Validate inputs - ensure they're numbers
      const safeSent = typeof bytesSent === 'number' && !isNaN(bytesSent) ? Math.max(0, bytesSent) : 0;
      const safeReceived = typeof bytesReceived === 'number' && !isNaN(bytesReceived) ? Math.max(0, bytesReceived) : 0;

      // Update totals
      this.metrics.bytesSent += safeSent;
      this.metrics.bytesReceived += safeReceived;

      // Add sample for rate calculation
      const sample = {
        timestamp: Date.now(),
        sent: safeSent,
        received: safeReceived
      };

      // Ensure dataTransferSamples array exists
      if (!Array.isArray(this.metrics.dataTransferSamples)) {
        this.metrics.dataTransferSamples = [];
      }

      this.metrics.dataTransferSamples.push(sample);

      // Keep only last 100 samples (about 10 minutes at 6 samples/minute)
      if (this.metrics.dataTransferSamples.length > 100) {
        this.metrics.dataTransferSamples.shift();
      }

      // Clean up old samples (older than 5 minutes)
      const fiveMinutesAgo = Date.now() - 300000;
      this.metrics.dataTransferSamples = this.metrics.dataTransferSamples.filter(
        sample => sample && sample.timestamp > fiveMinutesAgo
      );
    } catch (error) {
      // Silently ignore errors - metrics should never break the system
      // This ensures Requirement 5.3: metrics tracking fails gracefully
      console.warn(`⚠️ BrowserDHTClient metrics recording failed: ${error.message}`);
    }
  }

  /**
   * Calculate data transfer rate (bytes per second over last minute)
   */
  calculateDataTransferRate(direction) {
    if (!this.metrics.dataTransferSamples || this.metrics.dataTransferSamples.length === 0) {
      return 0;
    }

    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    // Filter to last minute and sum bytes for the specified direction
    const recentSamples = this.metrics.dataTransferSamples.filter(sample => sample.timestamp > oneMinuteAgo);
    const totalBytes = recentSamples.reduce((sum, sample) => {
      return sum + (sample[direction] || 0);
    }, 0);

    return totalBytes / 60; // bytes per second
  }

  /**
   * Setup bootstrap authentication challenge handler BEFORE parent.start()
   * This ensures we're listening for auth challenges before they arrive
   */
  setupAuthenticationHandlerEarly() {
    // Wait for bootstrap to be initialized by parent.start()
    // We set up a one-time handler that will attach the real handlers
    const setupHandler = () => {
      if (!this.bootstrap) {
        // Bootstrap not ready yet, try again after a short delay
        setTimeout(setupHandler, 10);
        return;
      }

      // Handle authentication challenges from bootstrap server
      this.bootstrap.on('authChallenge', async (message) => {
        try {
          console.log('🔐 Processing authentication challenge...');

          // Sign the challenge with our private key
          const challengeData = `${message.nonce}:${message.timestamp}`;
          const signature = await this.sign(challengeData);

          console.log('✍️ Challenge signed, sending response to server');

          // Send signature back to server
          this.bootstrap.sendMessage({
            type: 'auth_response',
            nodeId: this.nodeId.toString(),
            signature: signature,
            timestamp: Date.now()
          });
        } catch (error) {
          console.error('❌ Failed to respond to authentication challenge:', error);
          this.bootstrap.sendMessage({
            type: 'auth_response',
            nodeId: this.nodeId.toString(),
            error: error.message,
            timestamp: Date.now()
          });
        }
      });

      // Handle authentication success
      this.bootstrap.on('authSuccess', (message) => {
        console.log('🎉 Bootstrap authentication successful!');
        this.emit('authSuccess', message);
      });

      // Handle authentication failure
      this.bootstrap.on('authFailure', (message) => {
        console.error('🚫 Bootstrap authentication failed:', message.reason);
        this.emit('authFailure', message);
        // Optionally disconnect or retry
      });

      console.log('✅ Authentication challenge handler configured');
    };

    // Start trying to set up handlers
    setupHandler();
  }

  /**
   * Override getBootstrapMetadata to include public key for signature verification
   */
  getBootstrapMetadata() {
    return {
      ...super.getBootstrapMetadata(),
      publicKey: this.identity?.publicKey,
      verified: !!this.identity // True if cryptographic identity loaded
    };
  }

  /**
   * Sign data with private key (for bootstrap authentication and pub/sub renewal)
   */
  async sign(data) {
    if (!this.identity) {
      throw new Error('Identity not loaded');
    }
    return await this.identityStore.sign(data);
  }

  /**
   * Get identity info (without private key)
   */
  getIdentityInfo() {
    return this.identityStore.getInfo();
  }

  /**
   * Export identity for backup
   */
  async exportIdentity() {
    return await this.identityStore.export();
  }

  /**
   * Import identity from backup
   */
  async importIdentity(backup) {
    const identity = await this.identityStore.import(backup);
    this.identity = identity;
    this.nodeId = DHTNodeId.fromHex(identity.nodeId);
    return identity;
  }

  /**
   * Delete identity (requires restart to generate new one)
   */
  async deleteIdentity() {
    await this.identityStore.delete();
    this.identity = null;
  }

  /**
   * Override stop to clean up PubSub clients
   */
  async stop() {
    // Shutdown all registered PubSub clients
    for (const pubsubClient of this.pubsubClients) {
      try {
        await pubsubClient.shutdown();
      } catch (error) {
        console.warn('⚠️ Failed to shutdown PubSub client:', error);
      }
    }
    this.pubsubClients.clear();

    // Clear tab visibility state
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
    this.tabState = 'active';
    this.reconnectInProgress = false;
    this.savedSubscriptions = [];

    // Call parent stop
    return await super.stop();
  }

  getNodeType() {
    return 'browser';
  }

  getCapabilities() {
    return ['webrtc', 'websocket-client'];
  }

  canAcceptConnections() {
    return false;
  }

  canInitiateConnections() {
    return true;
  }

  /**
   * Proxy localNodeId to internal DHT for backward compatibility
   */
  get localNodeId() {
    // If DHT is started, use its localNodeId
    // Otherwise, use our nodeId (temporary during initialization)
    return this.dht ? this.dht.localNodeId : this.nodeId;
  }

  /**
   * Proxy keyInfo to internal DHT for pub/sub
   */
  get keyInfo() {
    // Return Ed25519 keys from internal DHT for pub/sub message signing
    // Note: KademliaDHT stores keys in 'keyPair' property
    return this.dht ? this.dht.keyPair : null;
  }

  /**
   * Create PubSubClient instance (call after DHT is started)
   * @param {Object} options - PubSubClient options
   * @returns {Promise<PubSubClient>} - PubSub client instance
   */
  async createPubSubClient(options = {}) {
    if (!this.dht || !this.identity || !this.keyInfo) {
      throw new Error('DHT must be started and identity loaded before creating PubSubClient');
    }

    // Dynamic import for browser compatibility
    const { PubSubClient } = await import('../pubsub/PubSubClient.js');
    
    const pubsubClient = new PubSubClient(
      this.dht,
      this.identity.nodeId,
      this.keyInfo,
      {
        enableBatching: true,
        batchSize: 10,
        batchTime: 100,
        ...options
      }
    );

    // Register for tab visibility handling
    this.pubsubClients.add(pubsubClient);
    
    return pubsubClient;
  }

  /**
   * Register external PubSubClient for tab visibility handling
   * @param {PubSubClient} pubsubClient - PubSub client to register
   */
  registerPubSubClient(pubsubClient) {
    this.pubsubClients.add(pubsubClient);
  }

  /**
   * Unregister PubSubClient from tab visibility handling
   * @param {PubSubClient} pubsubClient - PubSub client to unregister
   */
  unregisterPubSubClient(pubsubClient) {
    this.pubsubClients.delete(pubsubClient);
  }

  /**
   * Proxy routingTable to internal DHT for UI access
   */
  get routingTable() {
    return this.dht ? this.dht.routingTable : null;
  }

  /**
   * Override getStats to include browser-specific connection manager stats and identity info
   */
  getStats() {
    const baseStats = super.getStats();
    if (!this.dht) return baseStats;

    return {
      ...baseStats,
      identity: {
        nodeId: this.identity?.nodeId,
        verified: !!this.identity,
        createdAt: this.identity?.createdAt,
        lastUsed: this.identity?.lastUsed
      },
      connections: this.dht.getConnectionStats?.() || {},
      dht: {
        routingTableSize: this.dht.routingTable?.getAllNodes()?.length || 0,
        connectedPeers: this.getConnectedPeers().length
      },
      dataTransfer: {
        bytesReceived: this.metrics.bytesReceived,
        bytesSent: this.metrics.bytesSent,
        bytesReceivedPerSecond: this.calculateDataTransferRate('received'),
        bytesSentPerSecond: this.calculateDataTransferRate('sent')
      }
    };
  }

  /**
   * Setup tab visibility handling for automatic disconnect/reconnect
   *
   * Strategy:
   * - Tab becomes inactive → Wait 30 seconds → Disconnect to save resources
   * - Tab becomes active → Reconnect if disconnected
   * - During reconnection → Don't disconnect even if tab becomes inactive
   * - Save pub/sub subscriptions before disconnect, restore after reconnect
   */
  setupTabVisibilityHandling() {
    // State tracking
    this.tabState = 'active';  // 'active' | 'disconnecting' | 'disconnected' | 'reconnecting'
    this.disconnectTimer = null;
    this.reconnectInProgress = false;
    this.savedSubscriptions = [];
    
    // Registry for PubSubClient instances (for tab visibility handling)
    this.pubsubClients = new Set();

    console.log('👁️ Tab visibility handling enabled');

    document.addEventListener('visibilitychange', async () => {
      if (document.hidden) {
        // Tab became inactive
        console.log('📴 Tab hidden - scheduling disconnect');

        // CRITICAL: Don't disconnect if we're reconnecting
        if (this.reconnectInProgress) {
          console.log('⏸️ Reconnection in progress - keeping connection alive');
          return;
        }

        // Don't disconnect immediately - wait 30 seconds
        // Handles fast tab switching (checking email, etc.)
        this.disconnectTimer = setTimeout(async () => {
          console.log('⏱️ Tab inactive for 30s - disconnecting from DHT');
          this.tabState = 'disconnecting';

          try {
            // Save current pub/sub subscriptions before disconnecting
            this.savedSubscriptions = [];
            
            for (const pubsubClient of this.pubsubClients) {
              try {
                const subscriptions = pubsubClient.getSubscriptions?.() || [];

                // Save topic names and event listeners for each subscription
                const clientSubscriptions = subscriptions.map(sub => ({
                  topicID: sub.topicID,
                  // Get all listeners for this topic from the EventEmitter
                  listeners: pubsubClient.listeners(sub.topicID),
                  clientId: pubsubClient.nodeID // Track which client this belongs to
                }));

                this.savedSubscriptions.push(...clientSubscriptions);
              } catch (error) {
                console.warn('⚠️ Failed to save subscriptions from PubSub client:', error);
              }
            }

            console.log(`💾 Saved ${this.savedSubscriptions.length} pub/sub subscriptions from ${this.pubsubClients.size} clients`);

            // Disconnect (but keep membership token!)
            // Note: stop() preserves membership token in dht._membershipToken
            await this.stop();
            this.tabState = 'disconnected';
            console.log('✅ Disconnected from DHT (tab inactive)');

          } catch (error) {
            console.error('❌ Error during inactive tab disconnect:', error);
            this.tabState = 'active'; // Reset state on error
          }
        }, 30000); // 30 second delay

      } else {
        // Tab became active
        console.log('📱 Tab visible');

        // Cancel pending disconnect if tab was just hidden briefly
        if (this.disconnectTimer) {
          console.log('✅ Canceled pending disconnect - tab visible again');
          clearTimeout(this.disconnectTimer);
          this.disconnectTimer = null;
          return; // Still connected, nothing to do
        }

        // If we're already disconnected, reconnect FAST
        if (this.tabState === 'disconnected') {
          console.log('🔄 Reconnecting to DHT (tab was inactive)');
          this.reconnectInProgress = true;
          this.tabState = 'reconnecting';

          try {
            // PRIORITY 1: Reconnect to DHT
            await this.start();
            console.log('✅ DHT reconnected');

            // PRIORITY 2: Restore pub/sub subscriptions IMMEDIATELY
            if (this.savedSubscriptions && this.savedSubscriptions.length > 0) {
              console.log(`🔄 Restoring ${this.savedSubscriptions.length} pub/sub subscriptions`);

              // Group subscriptions by client ID
              const subscriptionsByClient = new Map();
              for (const sub of this.savedSubscriptions) {
                if (!subscriptionsByClient.has(sub.clientId)) {
                  subscriptionsByClient.set(sub.clientId, []);
                }
                subscriptionsByClient.get(sub.clientId).push(sub);
              }

              // Restore subscriptions for each client
              for (const pubsubClient of this.pubsubClients) {
                const clientSubs = subscriptionsByClient.get(pubsubClient.nodeID) || [];
                
                if (clientSubs.length > 0) {
                  console.log(`🔄 Restoring ${clientSubs.length} subscriptions for client ${pubsubClient.nodeID.substring(0, 8)}...`);
                  
                  // Resubscribe in parallel for speed
                  await Promise.all(
                    clientSubs.map(async sub => {
                      try {
                        // Resubscribe to topic (creates internal message handler)
                        await pubsubClient.subscribe(sub.topicID);

                        // Restore all saved event listeners
                        if (sub.listeners && sub.listeners.length > 0) {
                          sub.listeners.forEach(listener => {
                            pubsubClient.on(sub.topicID, listener);
                          });
                        }
                      } catch (err) {
                        console.warn(`⚠️ Failed to restore subscription to ${sub.topicID}:`, err);
                      }
                    })
                  );
                }
              }

              console.log('✅ Pub/sub subscriptions restored');
            }

            this.tabState = 'active';

            // CRITICAL FIX: Emit events to notify UI of successful reconnection
            console.log('📡 Emitting reconnection events for UI update...');
            
            // Emit started event to trigger UI refresh
            this.emit('reconnected', {
              nodeId: this.nodeId?.toString(),
              connectedPeers: this.getConnectedPeers().length,
              pubsubClients: this.pubsubClients.size,
              restoredSubscriptions: this.savedSubscriptions.length
            });

            // Also emit the standard started event that UI listens for
            this.emit('started');

            // Force UI refresh if DHT visualizer is available
            if (typeof window !== 'undefined' && window.YZSocialC?.visualizer) {
              console.log('🔄 Forcing UI refresh after reconnection...');
              setTimeout(() => {
                window.YZSocialC.visualizer.forceRefresh?.();
              }, 500);
            }

          } catch (error) {
            console.error('❌ Reconnection failed:', error);
            this.tabState = 'disconnected';
            
            // Emit reconnection failure event
            this.emit('reconnectionFailed', {
              error: error.message,
              tabState: this.tabState
            });
          } finally {
            this.reconnectInProgress = false;
          }
        }
      }
    });
  }
}