/**
 * TestCoordinator - Manages multiple browser instances for mesh stability tests
 * 
 * Coordinates launching browsers, connecting to DHT, verifying mesh formation,
 * and monitoring connection stability.
 * 
 * Requirements: 2.1, 2.3, 2.4, 2.5, 3.1, 3.2, 3.6, 5.5
 */
// MetricsManager is in test/browser/helpers (Jest test directory)
// We need to import from the correct location
import { MetricsManager } from '../../../test/browser/helpers/MetricsManager.js';

/**
 * Default test configuration
 */
const DEFAULT_CONFIG = {
  browserCount: 4,
  meshFormationTimeout: 120000,
  monitoringDuration: 60000,
  stabilityThreshold: 99,
  bootstrapUrl: 'wss://imeyouwe.com/ws'
};

class TestCoordinator {
  /**
   * @param {Object} config - Test configuration
   * @param {number} config.browserCount - Number of browsers to launch (default: 4, min: 3)
   * @param {number} config.meshFormationTimeout - Timeout for mesh formation in ms
   * @param {number} config.monitoringDuration - Duration for stability monitoring in ms
   * @param {number} config.stabilityThreshold - Uptime threshold for stability (percent)
   * @param {string} config.bootstrapUrl - Bootstrap server URL
   */
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (this.config.browserCount < 3) {
      this.config.browserCount = 3;
    }
    
    this.browsers = [];      // Playwright Browser instances
    this.contexts = [];      // Playwright BrowserContext instances
    this.pages = [];         // Playwright Page instances
    this.nodeIds = [];       // DHT node IDs for each browser
    this.metricsManager = new MetricsManager();
    this._monitoringActive = false;
    this._eventListeners = [];
  }

  /**
   * Launch all browser instances
   * @param {import('@playwright/test').Browser} browser - Playwright browser instance
   * @returns {Promise<void>}
   */
  async launchBrowsers(browser) {
    console.log(`🚀 Launching ${this.config.browserCount} browser contexts...`);
    
    for (let i = 0; i < this.config.browserCount; i++) {
      // Create isolated browser context for each "browser"
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 }
      });
      
      const page = await context.newPage();
      
      // Set up console logging for debugging
      page.on('console', msg => {
        if (msg.type() === 'error') {
          console.log(`[Browser ${i}] ERROR: ${msg.text()}`);
        }
      });
      
      this.contexts.push(context);
      this.pages.push(page);
      
      console.log(`  ✅ Browser context ${i + 1} created`);
    }
  }

  /**
   * Navigate all browsers to the app and start DHT
   * @param {string} baseUrl - Base URL for the app
   * @param {number} timeout - Connection timeout in ms
   * @returns {Promise<void>}
   */
  async connectAll(baseUrl = 'http://localhost:3000', timeout = 60000) {
    console.log(`🔗 Connecting ${this.pages.length} browsers to DHT...`);
    
    // Navigate all pages to the app
    await Promise.all(this.pages.map(async (page, i) => {
      await page.goto(baseUrl);
      await page.waitForFunction(() => window.YZSocialC !== undefined, {
        timeout: 10000
      });
      console.log(`  ✅ Browser ${i + 1} loaded YZSocialC`);
    }));
    
    // Start DHT on all browsers
    await Promise.all(this.pages.map(async (page, i) => {
      await page.evaluate(async () => {
        await window.YZSocialC.startDHT();
      });
      console.log(`  🔄 Browser ${i + 1} starting DHT...`);
    }));
    
    // Wait for all browsers to connect
    await Promise.all(this.pages.map(async (page, i) => {
      await page.waitForFunction(
        () => window.YZSocialC?.dht?.isConnected?.() === true,
        { timeout }
      );
      
      const nodeId = await page.evaluate(() => window.YZSocialC.getNodeId());
      this.nodeIds[i] = nodeId;
      console.log(`  ✅ Browser ${i + 1} connected: ${nodeId.substring(0, 8)}...`);
    }));
    
    console.log(`✅ All ${this.pages.length} browsers connected to DHT`);
  }

  /**
   * Get connection info from a specific browser
   * @param {number} pageIndex - Index of the page
   * @returns {Promise<Object>} Connection information
   */
  async getConnectionInfo(pageIndex) {
    if (pageIndex < 0 || pageIndex >= this.pages.length) {
      throw new Error(`Invalid page index: ${pageIndex}`);
    }
    
    const page = this.pages[pageIndex];
    return await page.evaluate(() => {
      const dht = window.YZSocialC?.dht;
      if (!dht) {
        return { connected: false, peers: [] };
      }
      
      const allNodes = dht.routingTable?.getAllNodes() || [];
      const peers = allNodes.map(node => {
        const peerId = node.id.toString();
        let connectionType = 'unknown';
        let isConnected = false;
        
        if (node.connectionManager) {
          const managerType = node.connectionManager.constructor.name;
          if (managerType === 'WebRTCConnectionManager') {
            connectionType = 'webrtc';
          } else if (managerType === 'WebSocketConnectionManager') {
            connectionType = 'websocket';
          }
          isConnected = node.connectionManager.isConnected();
        }
        
        return {
          peerId,
          connectionType,
          nodeType: node.metadata?.nodeType || 'unknown',
          isConnected
        };
      });
      
      return {
        connected: dht.isConnected(),
        nodeId: window.YZSocialC.getNodeId(),
        peerCount: peers.filter(p => p.isConnected).length,
        peers
      };
    });
  }

  /**
   * Stop all DHT instances and close browser contexts
   * @returns {Promise<void>}
   */
  async teardown() {
    console.log('🧹 Tearing down test coordinator...');
    
    // Stop monitoring if active
    this._monitoringActive = false;
    
    // Stop DHT on all browsers
    for (let i = 0; i < this.pages.length; i++) {
      try {
        await this.pages[i].evaluate(async () => {
          if (window.YZSocialC?.dht?.isConnected?.()) {
            await window.YZSocialC.stopDHT();
          }
        });
        console.log(`  ✅ Browser ${i + 1} DHT stopped`);
      } catch (error) {
        console.log(`  ⚠️ Browser ${i + 1} teardown error: ${error.message}`);
      }
    }
    
    // Close all browser contexts
    for (const context of this.contexts) {
      try {
        await context.close();
      } catch (error) {
        // Ignore close errors
      }
    }
    
    this.browsers = [];
    this.contexts = [];
    this.pages = [];
    this.nodeIds = [];
    
    console.log('✅ Teardown complete');
  }


  /**
   * Verify that all browsers have formed a full mesh network
   * A full mesh of N nodes has N*(N-1)/2 unique peer-to-peer connections
   * 
   * @param {number} timeout - Timeout for mesh formation in ms
   * @returns {Promise<Object>} MeshStatus object
   */
  async verifyMeshFormation(timeout = null) {
    const meshTimeout = timeout || this.config.meshFormationTimeout;
    const startTime = Date.now();
    const expectedPairs = this.calculateExpectedPairs();
    
    console.log(`🔍 Verifying mesh formation (expecting ${expectedPairs} browser-to-browser connections)...`);
    
    // Poll until mesh is complete or timeout
    while (Date.now() - startTime < meshTimeout) {
      const status = await this.getMeshStatus();
      
      if (status.isComplete) {
        status.formationTimeMs = Date.now() - startTime;
        console.log(`✅ Full mesh formed in ${status.formationTimeMs}ms`);
        return status;
      }
      
      // Wait before next check
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // Timeout - return current status
    const finalStatus = await this.getMeshStatus();
    finalStatus.formationTimeMs = Date.now() - startTime;
    finalStatus.timedOut = true;
    
    console.log(`⚠️ Mesh formation timed out after ${finalStatus.formationTimeMs}ms`);
    console.log(`   Connected pairs: ${finalStatus.connectedPairs}/${expectedPairs}`);
    
    if (finalStatus.missingConnections.length > 0) {
      console.log(`   Missing connections:`);
      for (const missing of finalStatus.missingConnections.slice(0, 5)) {
        console.log(`     - ${missing.from.substring(0, 8)}... <-> ${missing.to.substring(0, 8)}...`);
      }
      if (finalStatus.missingConnections.length > 5) {
        console.log(`     ... and ${finalStatus.missingConnections.length - 5} more`);
      }
    }
    
    return finalStatus;
  }

  /**
   * Get current mesh status without waiting
   * @returns {Promise<Object>} MeshStatus object
   */
  async getMeshStatus() {
    const browserNodeIds = this.nodeIds.filter(id => id); // Filter out undefined
    const expectedPairs = this.calculateExpectedPairs();
    const connectedPairs = new Set();
    const missingConnections = [];
    
    // Get connection info from each browser
    for (let i = 0; i < this.pages.length; i++) {
      const info = await this.getConnectionInfo(i);
      const myNodeId = this.nodeIds[i];
      
      if (!myNodeId) continue;
      
      // Find connections to other browser nodes
      for (const peer of info.peers) {
        // Only count browser-to-browser connections (WebRTC)
        if (peer.isConnected && 
            peer.connectionType === 'webrtc' && 
            browserNodeIds.includes(peer.peerId)) {
          // Create a canonical pair key (sorted to avoid duplicates)
          const pairKey = [myNodeId, peer.peerId].sort().join('-');
          connectedPairs.add(pairKey);
        }
      }
    }
    
    // Find missing connections
    for (let i = 0; i < browserNodeIds.length; i++) {
      for (let j = i + 1; j < browserNodeIds.length; j++) {
        const pairKey = [browserNodeIds[i], browserNodeIds[j]].sort().join('-');
        if (!connectedPairs.has(pairKey)) {
          missingConnections.push({
            from: browserNodeIds[i],
            to: browserNodeIds[j]
          });
        }
      }
    }
    
    return {
      totalNodes: browserNodeIds.length,
      connectedPairs: connectedPairs.size,
      expectedPairs,
      isComplete: connectedPairs.size >= expectedPairs,
      missingConnections,
      formationTimeMs: 0
    };
  }

  /**
   * Calculate expected number of pairs for a full mesh
   * @returns {number} Expected pair count: N*(N-1)/2
   */
  calculateExpectedPairs() {
    const n = this.nodeIds.filter(id => id).length;
    return (n * (n - 1)) / 2;
  }


  /**
   * Start monitoring connections for stability
   * Tracks connect/disconnect/reconnect events and feeds them to MetricsManager
   * 
   * @param {number} durationMs - Monitoring duration in ms
   * @returns {Promise<Object>} StabilityReport from MetricsManager
   */
  async startMonitoring(durationMs = null) {
    const duration = durationMs || this.config.monitoringDuration;
    const startTime = Date.now();
    
    console.log(`📊 Starting stability monitoring for ${duration / 1000}s...`);
    
    this.metricsManager = new MetricsManager();
    this.metricsManager.start(startTime);
    this._monitoringActive = true;
    
    // Record initial connection state for all browsers
    await this._recordInitialState(startTime);
    
    // Set up event listeners on all pages
    await this._setupEventListeners();
    
    // Wait for monitoring duration
    const endTime = startTime + duration;
    while (Date.now() < endTime && this._monitoringActive) {
      // Poll connection state periodically to catch any missed events
      await this._pollConnectionState();
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Stop monitoring
    this._monitoringActive = false;
    this.metricsManager.stop(Date.now());
    
    // Clean up event listeners
    await this._cleanupEventListeners();
    
    const summary = this.metricsManager.getSummary();
    
    console.log(`✅ Monitoring complete`);
    console.log(`   Duration: ${summary.duration}ms`);
    console.log(`   Total disconnects: ${summary.totalDisconnects}`);
    console.log(`   Churn rate: ${summary.churnRate.toFixed(2)} disconnects/min`);
    console.log(`   Overall stability: ${summary.overallStability ? '✅ STABLE' : '❌ UNSTABLE'}`);
    
    return summary;
  }

  /**
   * Record initial connection state for all browsers
   * @param {number} timestamp - Start timestamp
   * @private
   */
  async _recordInitialState(timestamp) {
    for (let i = 0; i < this.pages.length; i++) {
      const info = await this.getConnectionInfo(i);
      const myNodeId = this.nodeIds[i];
      
      if (!myNodeId) continue;
      
      // Record initial connections
      for (const peer of info.peers) {
        if (peer.isConnected && peer.connectionType === 'webrtc') {
          this.metricsManager.recordEvent('connect', peer.peerId, timestamp, {
            fromNode: myNodeId,
            connectionType: peer.connectionType
          });
        }
      }
    }
  }

  /**
   * Set up connection event listeners on all pages
   * @private
   */
  async _setupEventListeners() {
    for (let i = 0; i < this.pages.length; i++) {
      const page = this.pages[i];
      const myNodeId = this.nodeIds[i];
      
      if (!myNodeId) continue;
      
      // Expose a function to receive events from the browser
      await page.exposeFunction('__testCoordinatorEvent', (eventType, peerId, connectionType) => {
        if (!this._monitoringActive) return;
        
        const timestamp = Date.now();
        this.metricsManager.recordEvent(eventType, peerId, timestamp, {
          fromNode: myNodeId,
          connectionType
        });
        
        console.log(`  📡 [Browser ${i + 1}] ${eventType}: ${peerId.substring(0, 8)}...`);
      });
      
      // Set up listeners in the browser
      await page.evaluate(() => {
        const dht = window.YZSocialC?.dht;
        if (!dht) return;
        
        // Listen for connection events
        const originalOnPeerConnected = dht.onPeerConnected?.bind(dht);
        const originalOnPeerDisconnected = dht.onPeerDisconnected?.bind(dht);
        
        dht.onPeerConnected = (peerId, connectionManager) => {
          const connType = connectionManager?.constructor?.name === 'WebRTCConnectionManager' 
            ? 'webrtc' : 'websocket';
          window.__testCoordinatorEvent('connect', peerId, connType);
          if (originalOnPeerConnected) originalOnPeerConnected(peerId, connectionManager);
        };
        
        dht.onPeerDisconnected = (peerId) => {
          window.__testCoordinatorEvent('disconnect', peerId, null);
          if (originalOnPeerDisconnected) originalOnPeerDisconnected(peerId);
        };
      });
    }
  }

  /**
   * Poll connection state to catch any missed events
   * @private
   */
  async _pollConnectionState() {
    // This is a backup mechanism - the event listeners should catch most events
    // We just verify the current state matches what we've recorded
    for (let i = 0; i < this.pages.length; i++) {
      try {
        // Query connection info to detect any state drift
        await this.getConnectionInfo(i);
        // Could add drift detection here if needed
      } catch (error) {
        // Page might have crashed or closed
        console.log(`  ⚠️ Browser ${i + 1} poll error: ${error.message}`);
      }
    }
  }

  /**
   * Clean up event listeners
   * @private
   */
  async _cleanupEventListeners() {
    // Event listeners are automatically cleaned up when pages close
    // This method is here for explicit cleanup if needed
  }

  /**
   * Get the MetricsManager instance
   * @returns {MetricsManager}
   */
  getMetricsManager() {
    return this.metricsManager;
  }
}

export { TestCoordinator, DEFAULT_CONFIG };
