import { EventEmitter } from 'events';
import { WebSocket, WebSocketServer } from 'ws';
import crypto from 'crypto';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PROTOCOL_VERSION, BUILD_ID, checkVersionCompatibility } from '../version.js';
import { BridgeConnectionPool } from './BridgeConnectionPool.js';
import { RelayManager } from '../network/RelayManager.js';
import { RelayMessageType, createRelayAck, isRelayMessage } from '../network/RelayProtocol.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Enhanced Bootstrap Server with Bridge Integration
 *
 * Provides WebRTC signaling for new peers and reconnection services through bridge nodes.
 * Public-facing server that uses stateless requests to coordinate with bridge nodes.
 * 
 * ARCHITECTURE: Bootstrap server maintains NO persistent connections to bridge nodes.
 * All bridge interactions use connect-request-response-disconnect pattern for security.
 */
export class EnhancedBootstrapServer extends EventEmitter {
  constructor(options = {}) {
    super();

    this.options = {
      port: options.port || 8080,
      host: options.host || '0.0.0.0',
      maxPeers: options.maxPeers || 1000,
      peerTimeout: options.peerTimeout || 5 * 60 * 1000, // 5 minutes
      createNewDHT: options.createNewDHT || false,
      openNetwork: options.openNetwork || false, // Open network mode - no invitations required
      bridgeNodes: options.bridgeNodes || [
        'localhost:8083',  // Primary bridge node
        'localhost:8084',  // Backup bridge node
      ],
      bridgeAuth: options.bridgeAuth || 'default-bridge-auth-key',
      bridgeTimeout: options.bridgeTimeout || 30000, // 30 seconds
      ...options
    };

    // Client management
    this.peers = new Map(); // nodeId -> { ws, lastSeen, metadata, isGenesisPeer, type }
    this.connectedClients = new Map(); // nodeId -> { ws, nodeId, metadata, timestamp }
    this.server = null;
    this.genesisAssigned = false; // Track if genesis has been successfully assigned (for open network mode)

    // Bridge node management (persistent connections)
    this.pendingInvitations = new Map(); // invitationId -> { inviterNodeId, inviteeNodeId, inviterWs, inviteeWs, status, timestamp }
    
    // FIXED: Add pending bridge requests map for proper message handling
    this.pendingBridgeRequests = new Map(); // requestId -> { resolve, reject, timeout, timestamp }
    
    // Initialize bridge connection pool
    this.bridgePool = new BridgeConnectionPool(
      this.options.bridgeNodes,
      this.options.bridgeAuth,
      {
        maxReconnectAttempts: 10,
        idleTimeout: 300000, // 5 minutes
        healthCheckInterval: 30000, // 30 seconds
        requestTimeout: this.options.bridgeTimeout || 30000,
        // FIXED: Increase queue sizes to handle DHT formation load
        queue: {
          maxQueueSize: 500,  // Increased from default 100 to handle 15+ nodes connecting
          maxConcurrent: 10   // Increased from default 5 for better throughput
        }
      }
    );

    // Authentication management
    this.authChallenges = new Map(); // nodeId -> { nonce, timestamp, publicKey, ws }

    // Server state
    this.isStarted = false;
    this.totalConnections = 0;
    
    // Server metadata - advertise relay capability for symmetric NAT relay system
    // Bootstrap server can relay WebSocket traffic between browsers that can't establish direct WebRTC
    this.serverMetadata = {
      nodeType: 'bootstrap',
      canRelay: true,
      relayLoad: 0,                         // Current relay utilization (0-1), updated by RelayManager
      relayCapacity: 500,                   // Bootstrap server has highest capacity
      capabilities: ['websocket', 'relay', 'coordination']
    };
    
    // Connection profile metrics for network-wide NAT analysis
    this.connectionProfileMetrics = {
      totalReports: 0,
      natTypes: { open: 0, easy: 0, hard: 0, unknown: 0 },
      portPatterns: { sequential: 0, random: 0, unknown: 0 },
      ipv6Capable: 0,
      needsRelay: 0,
      lastUpdated: null,
      // Task 6.2: Track IPv6 availability by platform
      ipv6ByPlatform: {
        // Format: platform -> { total: count, ipv6Capable: count }
        // Platforms: 'windows', 'macos', 'linux', 'android', 'ios', 'chromeos', 'nodejs', 'unknown'
      },
      // Task 6.2: Track IPv6 availability by browser
      ipv6ByBrowser: {
        // Format: browser -> { total: count, ipv6Capable: count }
        // Browsers: 'chrome', 'firefox', 'safari', 'edge', 'opera', 'ie', 'nodejs', 'unknown'
      },
      // Task 6.2: Track IPv6 availability by platform category (aggregated)
      ipv6ByCategory: {
        // Format: category -> { total: count, ipv6Capable: count }
        // Categories: 'mobile-android', 'mobile-ios', 'mobile-other', 
        //             'desktop-windows', 'desktop-macos', 'desktop-linux', 'desktop-chromeos',
        //             'server-nodejs', 'unknown'
      }
    };
    // Track individual peer profiles for detailed analysis
    this.peerProfiles = new Map(); // nodeId -> { profile, timestamp }
    
    // Connection success rate metrics (Task 1.3: Add metrics endpoint)
    // Tracks connection attempt outcomes for network-wide success rate analysis
    this.connectionMetrics = {
      // Total counts
      totalAttempts: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      
      // By connection type
      byType: {
        webrtc: { attempts: 0, successes: 0, failures: 0 },
        websocket: { attempts: 0, successes: 0, failures: 0 },
        relay: { attempts: 0, successes: 0, failures: 0 }
      },
      
      // By NAT type combination (for browser-to-browser WebRTC)
      byNatPair: {
        // Format: 'localNat-remoteNat' -> { attempts, successes, failures }
        // e.g., 'easy-easy', 'hard-hard', 'easy-hard'
      },
      
      // ICE candidate types used in successful connections
      iceCandidateTypes: {
        host: 0,      // Direct LAN connection
        srflx: 0,     // Server reflexive (STUN)
        prflx: 0,     // Peer reflexive
        relay: 0      // Relay (our WebSocket relay, not TURN)
      },
      
      // Time-based metrics (rolling window)
      recentAttempts: [],  // Array of { timestamp, success, type, natPair }
      windowSize: 3600000, // 1 hour window for recent metrics
      
      lastUpdated: null
    };

    // Task 6.2: IPv6 adoption trend tracking over time
    // Stores periodic snapshots of IPv6 metrics for trend analysis
    this.ipv6TrendData = {
      // Hourly snapshots (keep last 24 hours)
      hourlySnapshots: [],
      maxHourlySnapshots: 24,
      
      // Daily snapshots (keep last 30 days)
      dailySnapshots: [],
      maxDailySnapshots: 30,
      
      // Weekly snapshots (keep last 12 weeks)
      weeklySnapshots: [],
      maxWeeklySnapshots: 12,
      
      // Snapshot interval timers
      lastHourlySnapshot: null,
      lastDailySnapshot: null,
      lastWeeklySnapshot: null,
      
      // Trend calculation cache
      trendCache: null,
      trendCacheExpiry: null
    };
    
    // Start IPv6 trend snapshot timer (every hour)
    this._startIPv6TrendTracking();

    // Relay manager for symmetric NAT relay system
    // Bootstrap server can relay WebSocket traffic between browsers that can't establish direct WebRTC
    this.relayManager = new RelayManager({
      maxRelaySessions: options.maxRelaySessions || 500,  // Bootstrap server has highest capacity
      sessionTimeout: options.relaySessionTimeout || 5 * 60 * 1000,  // 5 minutes
      healthCheckInterval: options.relayHealthCheckInterval || 30000  // 30 seconds
    });

    // ICE coordination for synchronized NAT traversal (Tailscale technique)
    // When both peers send ice_coordinate targeting each other, we send ice_start to both simultaneously
    // This helps packets cross in flight, opening both firewalls at the same time
    this.pendingIceCoordinations = new Map(); // 'peerA:peerB' (sorted) -> { peerA: {...}, peerB: {...}, timestamp }
    this.iceCoordinationTimeout = options.iceCoordinationTimeout || 10000; // 10 seconds to wait for peer
  }

  /**
   * Start the enhanced bootstrap server
   */
  async start() {
    if (this.isStarted) {
      throw new Error('Bootstrap server already started');
    }

    console.log('🚀 Starting Enhanced Bootstrap Server');

    // FIXED: Bridge interactions now use stateless requests (no persistent connections)

    // Create HTTP server that handles installer downloads
    this.httpServer = http.createServer((req, res) => {
      try {
        console.log(`📥 HTTP Request received: ${req.method} ${req.url}`);
        this.handleHttpRequest(req, res);
      } catch (error) {
        console.error('❌ HTTP Request Handler Error:', error);
        try {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        } catch (resError) {
          console.error('❌ Failed to send error response:', resError);
        }
      }
    });

    // Add error handler for HTTP server
    this.httpServer.on('error', (error) => {
      console.error('❌ HTTP Server Error:', error);
    });

    // Add error handler for client errors
    this.httpServer.on('clientError', (error, socket) => {
      console.error('❌ HTTP Client Error:', error);
      if (!socket.destroyed) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      }
    });

    console.log('✅ HTTP server created, now starting to listen...');

    // Start public bootstrap server attached to HTTP server
    this.server = new WebSocketServer({
      server: this.httpServer
    });

    this.server.on('connection', (ws, req) => {
      this.handleClientConnection(ws, req);
    });

    console.log(`🔌 Attempting to listen on ${this.options.host}:${this.options.port}...`);

    // Start HTTP server
    await new Promise((resolve, reject) => {
      this.httpServer.listen(this.options.port, this.options.host, () => {
        console.log(`✅ HTTP server successfully listening on ${this.options.host}:${this.options.port}`);
        resolve();
      });
      this.httpServer.on('error', (error) => {
        console.error(`❌ HTTP server listen error:`, error);
        reject(error);
      });
    });

    // FIXED: Bridge nodes will be queried on-demand using stateless requests

    // Start maintenance tasks
    this.startMaintenanceTasks();

    // FIXED: Add delay before initializing connection pool to allow bridge nodes to fully start
    console.log('⏳ Waiting for bridge nodes to be ready...');
    await new Promise(resolve => setTimeout(resolve, 5000)); // 5 second delay

    // DISABLED: Bridge connection pool - using existing connected bridge nodes instead
    // Initialize bridge connection pool
    // console.log('🔗 Initializing bridge connection pool...');
    // await this.bridgePool.initialize();
    // console.log('✅ Bridge connection pool initialized');
    // FIXED: Re-enable bridge connection pool as fallback when no bridge nodes are connected
    console.log('🔗 Initializing bridge connection pool (fallback for on-demand connections)...');
    try {
      await this.bridgePool.initialize();
      console.log('✅ Bridge connection pool initialized');
    } catch (poolError) {
      console.warn(`⚠️ Bridge connection pool initialization failed: ${poolError.message}`);
      console.log('   Will rely on bridge nodes connecting to bootstrap server');
    }

    // Initialize RelayManager for symmetric NAT relay system
    // Bootstrap server can relay WebSocket traffic between browsers that can't establish direct WebRTC
    // Generate a unique node ID for the bootstrap server (used for relay session tracking)
    this.bootstrapNodeId = `bootstrap_${crypto.randomBytes(16).toString('hex')}`;
    this.relayManager.initialize(this.bootstrapNodeId, true);  // canRelay = true for bootstrap server
    
    // Set up connection checker so RelayManager can verify peer connectivity
    this.relayManager.setConnectionChecker((peerId) => this.isPeerConnected(peerId));
    
    this.setupRelayManagerEventHandlers();
    console.log(`🔄 RelayManager initialized for bootstrap server`);

    this.isStarted = true;

    console.log(`🌟 Enhanced Bootstrap Server started`);
    console.log(`🔗 Public server: ${this.options.host}:${this.options.port}`);
    console.log(`📥 Installer: http://${this.options.host === '0.0.0.0' ? 'localhost' : this.options.host}:${this.options.port}/install.sh`);
    console.log(`🌉 Bridge nodes: ${this.options.bridgeNodes.length} configured`);
    console.log(`🆕 Create new DHT mode: ${this.options.createNewDHT ? 'ENABLED' : 'DISABLED'}`);
    console.log(`🌐 Open network mode: ${this.options.openNetwork ? 'ENABLED (no invitations required)' : 'DISABLED (invitations required)'}`);
    console.log(`👥 Max peers: ${this.options.maxPeers}`);
  }

  /**
   * Handle HTTP requests for installer downloads and info pages
   */
  handleHttpRequest(req, res) {
    try {
      const url = req.url;
      console.log(`📥 handleHttpRequest called: ${req.method} ${url}`);

      // CORS headers for installer scripts
      res.setHeader('Access-Control-Allow-Origin', '*');

      if (url === '/install.sh' || url === '/install') {
        // Serve bash installer
        const installerPath = path.join(__dirname, '../installer/bootstrap.sh');
        this.serveFile(res, installerPath, 'text/plain');
      } else if (url === '/install.ps1') {
        // Serve PowerShell installer
        const installerPath = path.join(__dirname, '../installer/bootstrap.ps1');
        this.serveFile(res, installerPath, 'text/plain');
      } else if (url === '/' || url === '/info') {
        // Serve landing page with installation instructions
        this.serveLandingPage(req, res);
      } else if (url === '/support') {
        // Detailed support page for non-technical users
        this.serveSupportPage(res);
      } else if (url === '/health') {
        // Health check endpoint
        console.log('✅ Health check endpoint hit, responding with OK');
        try {
          const peerCount = this.peers ? this.peers.size : 0;
          const healthData = { status: 'ok', peers: peerCount };
          console.log('📊 Health data:', JSON.stringify(healthData));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(healthData));
          console.log('✅ Health response sent successfully');
        } catch (healthError) {
          console.error('❌ Error in health check:', healthError);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'error', message: healthError.message }));
        }
      } else if (url === '/stats') {
        // Stats endpoint
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.getStats()));
      } else if (url === '/metrics') {
        // Connection success rate metrics endpoint (Task 1.3)
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.getConnectionMetrics()));
      } else if (url === '/bridge-health') {
        // IMPROVEMENT: Bridge availability endpoint for monitoring (stateless)
        (async () => {
          try {
            const availabilityStatus = await this.checkBridgeAvailability();
            const isHealthy = availabilityStatus.unavailable === 0;
            
            res.writeHead(isHealthy ? 200 : 503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              healthy: isHealthy,
              bridgeAvailability: availabilityStatus,
              timestamp: Date.now(),
              message: isHealthy ? 'All bridge nodes available' : `${availabilityStatus.unavailable} bridge nodes unavailable`
            }));
          } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              healthy: false,
              error: error.message,
              timestamp: Date.now()
            }));
          }
        })();
      } else {
        // Not found
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found\n\nAvailable endpoints:\n  /           - Installation info\n  /install.sh - Linux/Mac installer\n  /install.ps1 - Windows installer\n  /health     - Health check\n  /stats      - Server statistics\n  /metrics    - Connection success rate metrics');
      }
    } catch (error) {
      console.error('❌ Critical error in handleHttpRequest:', error);
      console.error('Stack:', error.stack);
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error: ' + error.message);
        }
      } catch (resError) {
        console.error('❌ Failed to send error response:', resError);
      }
    }
  }

  /**
   * Serve a file from disk
   */
  serveFile(res, filePath, contentType) {
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error reading file');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  }

  /**
   * Serve landing page with installation instructions
   */
  serveLandingPage(req, res) {
    const html = `<!DOCTYPE html>
<html>
<head>
  <title>YZ Network - Community Node Installer</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; background: #1a1a2e; color: #eee; }
    h1 { color: #00d4ff; }
    code { background: #16213e; padding: 10px 15px; border-radius: 5px; display: block; margin: 10px 0; color: #00ff88; overflow-x: auto; }
    .section { background: #16213e; padding: 20px; border-radius: 10px; margin: 20px 0; }
    .stats { display: flex; gap: 20px; flex-wrap: wrap; }
    .stat { background: #0f3460; padding: 15px; border-radius: 8px; text-align: center; }
    .stat-value { font-size: 2em; color: #00d4ff; }
    a { color: #00d4ff; }
    pre { margin: 0; }
  </style>
</head>
<body>
  <h1>YZ Network - Community Node Installer</h1>
  <p>Help strengthen the decentralized network by running DHT nodes on your computer!</p>

  <div class="section">
    <h2>Quick Install</h2>
    <h3>Linux / macOS / WSL</h3>
    <code><pre>curl -fsSL http://${req.headers.host}/install.sh | bash</pre></code>

    <h3>Windows (PowerShell)</h3>
    <code><pre>irm http://${req.headers.host}/install.ps1 | iex</pre></code>
  </div>

  <div class="section">
    <h2>Requirements</h2>
    <ul>
      <li><strong>Docker Desktop</strong> - installed and running</li>
      <li><strong>Internet connection</strong></li>
      <li><strong>Optional:</strong> UPnP-enabled router for automatic port forwarding</li>
    </ul>
  </div>

  <div class="section">
    <h2>Network Stats</h2>
    <div class="stats">
      <div class="stat">
        <div class="stat-value">${this.peers.size}</div>
        <div>Connected Peers</div>
      </div>
      <div class="stat">
        <div class="stat-value">${this.options.openNetwork ? 'Open' : 'Invite Only'}</div>
        <div>Network Mode</div>
      </div>
    </div>
  </div>

  <div class="section">
    <h2>What You'll Contribute</h2>
    <p>Each node uses minimal resources:</p>
    <ul>
      <li><strong>CPU:</strong> 0.15 cores per node</li>
      <li><strong>RAM:</strong> 128 MB per node</li>
      <li><strong>Disk:</strong> 50 MB per node</li>
    </ul>
  </div>

  <p style="text-align: center; margin-top: 40px; opacity: 0.7;">
    <a href="https://github.com/yz-network/yz.network">GitHub</a> |
    <a href="/health">Health Check</a> |
    <a href="/stats">API Stats</a>
  </p>
</body>
</html>`;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  }

  /**
   * Serve detailed support page with step-by-step instructions for non-technical users
   */
  serveSupportPage(res) {
    const html = `<!DOCTYPE html>
<html>
<head>
  <title>Help Support the YZ Network - Step-by-Step Guide</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; background: #1a1a2e; color: #eee; line-height: 1.6; }
    h1 { color: #00d4ff; text-align: center; margin-bottom: 10px; }
    h2 { color: #00d4ff; border-bottom: 2px solid #0f3460; padding-bottom: 10px; margin-top: 40px; }
    h3 { color: #00ff88; }
    .subtitle { text-align: center; opacity: 0.8; margin-bottom: 40px; }
    .step { background: #16213e; padding: 25px; border-radius: 10px; margin: 20px 0; border-left: 4px solid #00d4ff; }
    .step-number { background: #00d4ff; color: #1a1a2e; width: 35px; height: 35px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-weight: bold; margin-right: 10px; }
    code { background: #0f3460; padding: 3px 8px; border-radius: 4px; color: #00ff88; }
    .command-box { background: #0f3460; padding: 15px 20px; border-radius: 8px; margin: 15px 0; overflow-x: auto; }
    .command-box code { background: transparent; padding: 0; display: block; }
    .warning { background: #3d2914; border-left: 4px solid #ffa500; padding: 15px; margin: 15px 0; border-radius: 0 8px 8px 0; }
    .success { background: #143d29; border-left: 4px solid #00ff88; padding: 15px; margin: 15px 0; border-radius: 0 8px 8px 0; }
    .info { background: #142d3d; border-left: 4px solid #00d4ff; padding: 15px; margin: 15px 0; border-radius: 0 8px 8px 0; }
    ul { padding-left: 25px; }
    li { margin: 10px 0; }
    a { color: #00d4ff; }
    .platform-tabs { display: flex; gap: 10px; margin-bottom: 20px; }
    .platform-tab { padding: 10px 20px; background: #0f3460; border-radius: 8px; cursor: pointer; border: 2px solid transparent; }
    .platform-tab.active { border-color: #00d4ff; background: #16213e; }
    .platform-content { display: none; }
    .platform-content.active { display: block; }
    .resource-box { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin: 20px 0; }
    .resource-item { background: #0f3460; padding: 15px; border-radius: 8px; text-align: center; }
    .resource-value { font-size: 1.5em; color: #00d4ff; font-weight: bold; }
    .faq { background: #16213e; padding: 20px; border-radius: 10px; margin: 15px 0; }
    .faq summary { cursor: pointer; font-weight: bold; color: #00d4ff; }
    .faq p { margin: 15px 0 0 0; opacity: 0.9; }
    .btn { display: inline-block; padding: 12px 25px; background: linear-gradient(135deg, #00d4ff, #0099cc); color: #1a1a2e; text-decoration: none; border-radius: 8px; font-weight: bold; margin: 10px 5px; }
    .btn:hover { background: linear-gradient(135deg, #00e5ff, #00aadd); }
    footer { text-align: center; margin-top: 50px; padding-top: 20px; border-top: 1px solid #0f3460; opacity: 0.7; }
    img { max-width: 100%; border-radius: 8px; margin: 10px 0; }
  </style>
</head>
<body>
  <h1>Help Support the YZ Network</h1>
  <p class="subtitle">Run community nodes on your computer to help strengthen the decentralized network.<br>It's easy, secure, and uses minimal resources!</p>

  <div class="info">
    <strong>What are community nodes?</strong> Community nodes are small programs that help route messages and store data for the YZ Network. By running nodes, you help make the network faster, more reliable, and more decentralized. Think of it like helping to power a community internet.
  </div>

  <h2>What You'll Need</h2>
  <ul>
    <li><strong>A computer</strong> - Windows, Mac, or Linux (even a Raspberry Pi works!)</li>
    <li><strong>Docker Desktop</strong> - Free software that runs the nodes (we'll show you how to install it)</li>
    <li><strong>Internet connection</strong> - Standard home internet is fine</li>
    <li><strong>5 minutes</strong> - That's all it takes to set up!</li>
  </ul>

  <h2>Resource Usage (Very Light!)</h2>
  <div class="resource-box">
    <div class="resource-item">
      <div class="resource-value">0.15</div>
      <div>CPU cores per node</div>
    </div>
    <div class="resource-item">
      <div class="resource-value">128 MB</div>
      <div>RAM per node</div>
    </div>
    <div class="resource-item">
      <div class="resource-value">50 MB</div>
      <div>Disk per node</div>
    </div>
    <div class="resource-item">
      <div class="resource-value">1-5 Mbps</div>
      <div>Network usage</div>
    </div>
  </div>
  <p style="opacity: 0.8; font-size: 0.9em;">Running 3 nodes uses less resources than a single browser tab!</p>

  <h2>Step-by-Step Installation</h2>

  <div class="step">
    <h3><span class="step-number">1</span> Install Docker Desktop</h3>
    <p>Docker is free software that lets you run the community nodes. It's like a container that keeps everything organized and secure.</p>

    <div class="platform-tabs">
      <div class="platform-tab active" onclick="showPlatform('windows')">Windows</div>
      <div class="platform-tab" onclick="showPlatform('mac')">Mac</div>
      <div class="platform-tab" onclick="showPlatform('linux')">Linux</div>
    </div>

    <div id="windows" class="platform-content active">
      <ol>
        <li>Go to <a href="https://www.docker.com/products/docker-desktop" target="_blank">docker.com/products/docker-desktop</a></li>
        <li>Click the blue "Download for Windows" button</li>
        <li>Run the downloaded file (Docker Desktop Installer.exe)</li>
        <li>Follow the installation wizard - just click "Next" through the steps</li>
        <li>When asked, check "Use WSL 2" (recommended)</li>
        <li>Click "Close" when installation finishes</li>
        <li><strong>Restart your computer</strong> when prompted</li>
        <li>After restart, Docker Desktop will start automatically. Wait for it to say "Docker is running"</li>
      </ol>
      <div class="info">
        <strong>First time?</strong> Docker might ask you to create an account. You can skip this - click "Continue without signing in" or just close the sign-in window.
      </div>
    </div>

    <div id="mac" class="platform-content">
      <ol>
        <li>Go to <a href="https://www.docker.com/products/docker-desktop" target="_blank">docker.com/products/docker-desktop</a></li>
        <li>Click "Download for Mac" - choose Apple Chip or Intel based on your Mac</li>
        <li>Open the downloaded .dmg file</li>
        <li>Drag the Docker icon to your Applications folder</li>
        <li>Open Docker from Applications</li>
        <li>Click "Open" if macOS asks for permission</li>
        <li>Wait for Docker to start (you'll see the whale icon in your menu bar)</li>
      </ol>
      <div class="info">
        <strong>Not sure which Mac you have?</strong> Click the Apple menu > "About This Mac". If it says "Apple M1/M2/M3" choose Apple Chip. Otherwise choose Intel.
      </div>
    </div>

    <div id="linux" class="platform-content">
      <p>For Ubuntu/Debian, open Terminal and run:</p>
      <div class="command-box">
        <code>curl -fsSL https://get.docker.com | sudo sh</code>
      </div>
      <p>Then add your user to the docker group:</p>
      <div class="command-box">
        <code>sudo usermod -aG docker $USER</code>
      </div>
      <p>Log out and log back in for the changes to take effect.</p>
    </div>
  </div>

  <div class="step">
    <h3><span class="step-number">2</span> Verify Docker is Running</h3>
    <p>Before installing the nodes, make sure Docker is running:</p>
    <ul>
      <li><strong>Windows/Mac:</strong> Look for the Docker whale icon in your system tray (Windows) or menu bar (Mac). It should NOT have a red dot or warning symbol.</li>
      <li><strong>All platforms:</strong> Open a terminal/command prompt and type: <code>docker --version</code>. You should see a version number.</li>
    </ul>
    <div class="warning">
      <strong>Docker not running?</strong> Open Docker Desktop from your Start menu (Windows) or Applications (Mac). Wait until the whale icon stops animating.
    </div>
  </div>

  <div class="step">
    <h3><span class="step-number">3</span> Run the Installer</h3>
    <p>Now for the easy part! Just copy and paste ONE command:</p>

    <h4>Windows (PowerShell)</h4>
    <p>Right-click the Start button > "Windows PowerShell" (or "Terminal"), then paste:</p>
    <div class="command-box">
      <code>irm http://${this.options.host === '0.0.0.0' ? 'bootstrap.yz.network' : this.options.host}:${this.options.port}/install.ps1 | iex</code>
    </div>

    <h4>Mac / Linux</h4>
    <p>Open Terminal and paste:</p>
    <div class="command-box">
      <code>curl -fsSL http://${this.options.host === '0.0.0.0' ? 'bootstrap.yz.network' : this.options.host}:${this.options.port}/install.sh | bash</code>
    </div>

    <div class="success">
      <strong>That's it!</strong> The installer will guide you through a few simple questions:
      <ul style="margin: 10px 0;">
        <li>How many nodes to run (default: 3 - just press Enter)</li>
        <li>Whether to enable automatic port forwarding (recommended: Yes)</li>
      </ul>
    </div>
  </div>

  <div class="step">
    <h3><span class="step-number">4</span> You're Done!</h3>
    <p>After installation, your nodes will start automatically and begin helping the network. You can:</p>
    <ul>
      <li><strong>Check status:</strong> Open <a href="http://localhost:9090/health" target="_blank">http://localhost:9090/health</a> in your browser</li>
      <li><strong>View logs:</strong> Open Docker Desktop and click on the running containers</li>
      <li><strong>Let it run:</strong> The nodes will restart automatically when you restart your computer</li>
    </ul>
  </div>

  <h2>Managing Your Nodes</h2>

  <div class="info">
    <p>After installation, a folder is created at:</p>
    <ul>
      <li><strong>Windows:</strong> <code>%USERPROFILE%\\.yz-network</code></li>
      <li><strong>Mac/Linux:</strong> <code>~/.yz-network</code></li>
    </ul>
    <p>Navigate there in terminal/command prompt to run management commands.</p>
  </div>

  <h3>Common Commands</h3>
  <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
    <tr style="background: #0f3460;">
      <td style="padding: 12px; border: 1px solid #16213e;"><strong>View logs</strong></td>
      <td style="padding: 12px; border: 1px solid #16213e;"><code>docker-compose -f docker-compose.community.yml logs -f</code></td>
    </tr>
    <tr>
      <td style="padding: 12px; border: 1px solid #16213e;"><strong>Stop nodes</strong></td>
      <td style="padding: 12px; border: 1px solid #16213e;"><code>docker-compose -f docker-compose.community.yml stop</code></td>
    </tr>
    <tr style="background: #0f3460;">
      <td style="padding: 12px; border: 1px solid #16213e;"><strong>Start nodes</strong></td>
      <td style="padding: 12px; border: 1px solid #16213e;"><code>docker-compose -f docker-compose.community.yml start</code></td>
    </tr>
    <tr>
      <td style="padding: 12px; border: 1px solid #16213e;"><strong>Remove everything</strong></td>
      <td style="padding: 12px; border: 1px solid #16213e;"><code>docker-compose -f docker-compose.community.yml down</code></td>
    </tr>
  </table>

  <h2>Frequently Asked Questions</h2>

  <details class="faq">
    <summary>Is this safe? What data is being shared?</summary>
    <p>Yes, it's completely safe! Your nodes only route encrypted network traffic - no personal data, files, or information from your computer is ever accessed or shared. Think of it like being a relay in a chain - you help pass messages along, but you can't read them.</p>
  </details>

  <details class="faq">
    <summary>Will this slow down my computer or internet?</summary>
    <p>Barely noticeable! Running 3 nodes uses about 0.5 CPU cores and 400MB RAM - less than having a few browser tabs open. Network usage is typically 1-5 Mbps, which is a tiny fraction of most home internet connections.</p>
  </details>

  <details class="faq">
    <summary>Can I run this on an old computer or Raspberry Pi?</summary>
    <p>Yes! The nodes are very lightweight. Any computer from the last 10 years should work fine. Raspberry Pi 4 with 2GB+ RAM is perfect for running 1-3 nodes.</p>
  </details>

  <details class="faq">
    <summary>Do I need to keep my computer on all the time?</summary>
    <p>No! Run nodes whenever it's convenient for you. When you turn off your computer, the nodes stop. When you turn it back on, Docker restarts them automatically. Every bit of uptime helps!</p>
  </details>

  <details class="faq">
    <summary>What is port forwarding / UPnP?</summary>
    <p>UPnP (Universal Plug and Play) automatically configures your router to allow incoming connections to your nodes. This makes your nodes more useful to the network. If UPnP doesn't work on your router, the nodes will still function, just with slightly reduced connectivity.</p>
  </details>

  <details class="faq">
    <summary>How do I uninstall everything?</summary>
    <p>Open terminal/command prompt, navigate to the installation folder, and run: <code>docker-compose -f docker-compose.community.yml down</code>. Then delete the .yz-network folder. Optionally, uninstall Docker Desktop if you no longer need it.</p>
  </details>

  <details class="faq">
    <summary>I'm getting an error during installation. What do I do?</summary>
    <p>Most errors are because Docker isn't running or isn't installed correctly. Make sure Docker Desktop is running (look for the whale icon). If problems persist, try restarting Docker Desktop or your computer.</p>
  </details>

  <h2>Thank You!</h2>
  <div class="success" style="text-align: center;">
    <p style="font-size: 1.2em; margin: 0;">By running community nodes, you're helping to:</p>
    <ul style="text-align: left; display: inline-block; margin: 15px 0;">
      <li>Make the network more decentralized and resilient</li>
      <li>Improve speed and reliability for all users</li>
      <li>Support privacy-preserving communication</li>
      <li>Enable truly peer-to-peer applications</li>
    </ul>
    <p style="font-size: 1.3em; margin: 15px 0 0 0;"><strong>Every node counts!</strong></p>
  </div>

  <footer>
    <a href="/" class="btn">Back to Home</a>
    <a href="https://github.com/yz-network/yz.network" class="btn">GitHub</a>
    <p style="margin-top: 20px;">YZ Network Community Node Support</p>
  </footer>

  <script>
    function showPlatform(platform) {
      document.querySelectorAll('.platform-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.platform-content').forEach(c => c.classList.remove('active'));
      document.querySelector('[onclick="showPlatform(\\'' + platform + '\\')"]').classList.add('active');
      document.getElementById(platform).classList.add('active');
    }
  </script>
</body>
</html>`;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  }

  /**
   * Stop the bootstrap server
   */
  async stop() {
    if (!this.isStarted) {
      return;
    }

    console.log('🛑 Stopping Enhanced Bootstrap Server');

    // Stop IPv6 trend tracking
    this._stopIPv6TrendTracking();

    // Close all client connections
    for (const [nodeId, peer] of this.peers) {
      if (peer.ws && peer.ws.readyState === WebSocket.OPEN) {
        peer.ws.close(1000, 'Server shutdown');
      }
    }
    this.peers.clear();

    // Destroy RelayManager
    if (this.relayManager) {
      this.relayManager.destroy();
      console.log('🔄 RelayManager destroyed');
    }

    // Shutdown bridge connection pool
    if (this.bridgePool) {
      console.log('🔗 Shutting down bridge connection pool...');
      this.bridgePool.shutdown();
    }

    // Close WebSocket server
    if (this.server) {
      this.server.close();
      this.server = null;
    }

    // Close HTTP server
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }

    this.isStarted = false;
    console.log('🚀 Enhanced Bootstrap Server stopped');
  }

  /**
   * Test bridge node availability (using connection pool)
   * UPDATED: Uses connection pool status instead of stateless testing
   */
  async testBridgeAvailability() {
    console.log(`🌉 Testing availability of ${this.options.bridgeNodes.length} bridge nodes`);

    const availabilityStatus = await this.checkBridgeAvailability();
    const availableBridges = availabilityStatus.available;

    if (availableBridges === 0) {
      console.warn('⚠️ No bridge nodes available - reconnection services unavailable');
    } else {
      console.log(`✅ ${availableBridges}/${this.options.bridgeNodes.length} bridge nodes available`);
    }

    return availableBridges;
  }

  /**
   * Handle bridge response messages
   */
  handleBridgeResponse(ws, message) {
    const { requestId } = message;
    
    if (!requestId || !this.pendingBridgeRequests.has(requestId)) {
      console.warn(`⚠️ Received bridge response for unknown request: ${requestId}`);
      return;
    }

    const pendingRequest = this.pendingBridgeRequests.get(requestId);
    this.pendingBridgeRequests.delete(requestId);

    // Clear timeout
    if (pendingRequest.timeout) {
      clearTimeout(pendingRequest.timeout);
    }

    console.log(`📨 Received bridge response for request ${requestId.substring(0, 16)}...`);

    if (message.success) {
      console.log(`✅ Bridge request successful: ${requestId.substring(0, 16)}...`);
      pendingRequest.resolve(message.data);
    } else {
      // EMERGENCY MODE: Check if bridge provided network state for fallback
      if (message.data?.emergencyMode && message.data?.networkState) {
        console.log(`🚨 Bridge returned emergency mode data with network state`);
        console.log(`   Connected peers: ${message.data.networkState.connectedPeerCount}`);
        console.log(`   Routing table size: ${message.data.networkState.routingTableSize}`);
        console.log(`   Available peers: ${message.data.networkState.availablePeers?.length || 0}`);
        
        // Store emergency data for the error handler to use
        const error = new Error(message.error || 'Bridge request failed');
        error.emergencyMode = true;
        error.networkState = message.data.networkState;
        error.availablePeers = message.data.networkState.availablePeers || [];
        pendingRequest.reject(error);
      } else {
        console.warn(`❌ Bridge request failed: ${message.error || 'Unknown error'}`);
        pendingRequest.reject(new Error(message.error || 'Bridge request failed'));
      }
    }
  }

  /**
   * Request onboarding peer from bridge (using connected bridge nodes)
   * FIXED: Uses existing connected bridge nodes with proper message handling
   * FALLBACK: Uses connection pool if no bridge nodes are connected
   */
  async requestOnboardingPeerFromBridge(nodeId, metadata) {
    console.log(`🎲 Requesting onboarding peer for ${nodeId.substring(0, 8)}... from bridge nodes`);

    // DEBUG: Log all connected clients and their metadata in detail
    console.log(`🔍 DEBUG: Checking ${this.connectedClients.size} connected clients for bridge nodes:`);
    for (const [clientNodeId, client] of this.connectedClients) {
      console.log(`   Client ${clientNodeId.substring(0, 8)}...:`);
      console.log(`      metadata.isBridgeNode: ${client.metadata?.isBridgeNode}`);
      console.log(`      metadata.nodeType: ${client.metadata?.nodeType}`);
      console.log(`      ws.readyState: ${client.ws?.readyState}`);
    }

    // Get connected bridge nodes with OPEN WebSocket connections
    const connectedBridgeNodes = [];
    for (const [bridgeNodeId, client] of this.connectedClients) {
      if (client.metadata && client.metadata.isBridgeNode && client.ws?.readyState === 1) {
        connectedBridgeNodes.push({ nodeId: bridgeNodeId, ws: client.ws, metadata: client.metadata });
      }
    }

    console.log(`🔍 DEBUG: Found ${connectedBridgeNodes.length} connected bridge nodes with OPEN connections`);

    // FALLBACK: If no bridge nodes connected, try using the connection pool
    if (connectedBridgeNodes.length === 0) {
      console.log(`⚠️ No bridge nodes connected, trying connection pool fallback...`);
      return await this.requestOnboardingPeerViaPool(nodeId, metadata);
    }

    // Shuffle bridge nodes for load balancing
    const shuffledBridges = connectedBridgeNodes.sort(() => Math.random() - 0.5);
    
    // Try each bridge node until one succeeds
    const errors = [];
    for (let i = 0; i < shuffledBridges.length; i++) {
      const selectedBridge = shuffledBridges[i];
      console.log(`🎯 Trying bridge node ${i + 1}/${shuffledBridges.length}: ${selectedBridge.nodeId.substring(0, 8)}...`);

      try {
        const result = await this.tryBridgeForOnboarding(selectedBridge, nodeId, metadata);
        if (result && result.inviterPeerId) {
          console.log(`✅ Got onboarding peer from bridge ${selectedBridge.nodeId.substring(0, 8)}...: ${result.inviterPeerId.substring(0, 8)}...`);
          return result;
        }
      } catch (error) {
        console.warn(`⚠️ Bridge ${selectedBridge.nodeId.substring(0, 8)}... failed: ${error.message}`);
        errors.push({ bridge: selectedBridge.nodeId.substring(0, 8), error: error.message });
        // Continue to next bridge
      }
    }

    // All bridges failed
    console.error(`❌ All ${shuffledBridges.length} bridge nodes failed to find onboarding peer`);
    errors.forEach(e => console.error(`   - ${e.bridge}...: ${e.error}`));
    throw new Error(`All ${shuffledBridges.length} bridge nodes failed for onboarding coordination`);
  }

  /**
   * Try a single bridge node for onboarding peer discovery
   */
  async tryBridgeForOnboarding(bridge, nodeId, metadata) {
    const requestId = `onboarding_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const request = {
      type: 'get_onboarding_peer',
      requestId,
      newNodeId: nodeId,
      newNodeMetadata: metadata
    };

    // Check WebSocket state before sending
    const wsState = bridge.ws.readyState;
    const wsStateNames = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
    console.log(`📨 Sending onboarding request ${requestId.substring(0, 16)}... to bridge ${bridge.nodeId.substring(0, 8)}...`);
    console.log(`   WebSocket state: ${wsStateNames[wsState] || wsState} (${wsState})`);
    
    if (wsState !== 1) { // 1 = OPEN
      throw new Error(`Bridge WebSocket not open (state: ${wsStateNames[wsState]})`);
    }
    
    // Create promise that will be resolved by handleBridgeResponse
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingBridgeRequests.delete(requestId);
        console.warn(`⏰ Bridge request ${requestId.substring(0, 16)}... timed out after 10s`);
        reject(new Error('Bridge request timeout'));
      }, 10000); // 10 second timeout

      // Store pending request
      this.pendingBridgeRequests.set(requestId, {
        resolve,
        reject,
        timeout,
        timestamp: Date.now()
      });

      // Send request to bridge node
      try {
        bridge.ws.send(JSON.stringify(request));
        console.log(`✅ Onboarding request sent successfully to bridge ${bridge.nodeId.substring(0, 8)}...`);
      } catch (sendError) {
        console.error(`❌ Failed to send onboarding request: ${sendError.message}`);
        this.pendingBridgeRequests.delete(requestId);
        clearTimeout(timeout);
        reject(sendError);
      }
    });

    if (result && result.inviterPeerId) {
      return result;
    } else {
      throw new Error('Invalid response from bridge');
    }
  }

  /**
   * Request onboarding peer via connection pool (fallback when no bridge nodes connected)
   * Uses the BridgeConnectionPool to connect to bridge nodes on-demand
   */
  async requestOnboardingPeerViaPool(nodeId, metadata) {
    console.log(`🔗 Using connection pool to request onboarding peer for ${nodeId.substring(0, 8)}...`);

    if (!this.bridgePool) {
      throw new Error('Bridge connection pool not initialized');
    }

    try {
      // Use the connection pool to send the request
      const result = await this.bridgePool.sendRequest({
        type: 'get_onboarding_peer',
        newNodeId: nodeId,
        newNodeMetadata: metadata,
        requestId: `pool_onboarding_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      });

      if (result && result.inviterPeerId) {
        console.log(`✅ Got onboarding peer via pool: ${result.inviterPeerId.substring(0, 8)}...`);
        return result;
      } else if (result && result.emergencyMode && result.networkState) {
        // Bridge returned emergency mode data
        console.log(`🚨 Bridge returned emergency mode via pool`);
        const error = new Error('Bridge returned emergency mode');
        error.emergencyMode = true;
        error.networkState = result.networkState;
        error.availablePeers = result.networkState?.availablePeers || [];
        throw error;
      } else {
        throw new Error('Invalid response from bridge via pool');
      }
    } catch (error) {
      console.warn(`❌ Connection pool request failed: ${error.message}`);
      
      // Preserve emergency mode data if present
      if (error.emergencyMode) {
        throw error;
      }
      
      throw new Error(`Bridge connection pool failed: ${error.message}`);
    }
  }

  /**
   * Coordinate onboarding invitation between new peer and selected helper
   * FIXED: Stateless coordination without persistent bridge connections
   */
  async coordinateOnboardingInvitation(newPeerWs, newPeerNodeId, onboardingResult) {
    try {
      const { inviterPeerId, inviterMetadata } = onboardingResult;
      
      console.log(`🤝 Coordinating invitation: ${inviterPeerId.substring(0, 8)}... → ${newPeerNodeId.substring(0, 8)}...`);

      // Find the inviter peer connection
      const inviterClient = this.connectedClients.get(inviterPeerId);
      if (!inviterClient) {
        throw new Error(`Inviter peer ${inviterPeerId.substring(0, 8)}... not connected`);
      }

      // Create invitation tracking
      const invitationId = `${inviterPeerId}_${newPeerNodeId}_${Date.now()}`;
      this.pendingInvitations.set(invitationId, {
        inviterNodeId: inviterPeerId,
        inviteeNodeId: newPeerNodeId,
        inviterWs: inviterClient.ws,
        inviteeWs: newPeerWs,
        inviterMetadata: inviterMetadata || {},
        inviteeMetadata: {},
        status: 'coordinating',
        timestamp: Date.now()
      });

      // Ask inviter to send invitation to new peer
      inviterClient.ws.send(JSON.stringify({
        type: 'send_invitation_request',
        targetPeerId: newPeerNodeId,
        requestId: `invite_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        message: 'Please invite this new peer to join the DHT network'
      }));

      console.log(`✅ Onboarding invitation coordinated: ${invitationId}`);

    } catch (error) {
      console.error(`❌ Failed to coordinate onboarding invitation: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get emergency bootstrap targets when DHT network is empty/sparse
   * Returns connected DHT nodes (non-bridge) that can accept direct connections
   */
  getEmergencyBootstrapTargets(excludeNodeId) {
    const targets = [];
    
    for (const [clientNodeId, client] of this.connectedClients.entries()) {
      // Skip the requesting node
      if (clientNodeId === excludeNodeId) continue;
      
      // Skip bridge nodes - they can't create invitation tokens
      if (client.metadata?.isBridgeNode || client.metadata?.nodeType === 'bridge') continue;
      
      // Skip inactive browser tabs
      if (client.metadata?.nodeType === 'browser' && client.metadata?.tabVisible === false) continue;
      
      // Check if WebSocket is still open
      if (client.ws?.readyState !== 1) continue; // 1 = OPEN
      
      // This is a valid direct connection target
      targets.push({
        nodeId: clientNodeId,
        metadata: {
          ...client.metadata,
          emergencyTarget: true,
          directConnection: true
        }
      });
    }
    
    console.log(`🚨 Emergency targets: Found ${targets.length} direct connection candidates (excluding ${excludeNodeId?.substring(0, 8)}...)`);
    return targets;
  }

  /**
   * Get genesis peer for emergency direct connection
   * Used when no other peers are available
   */
  getGenesisPeerForEmergency(excludeNodeId) {
    // Find the genesis peer from connected clients
    for (const [clientNodeId, client] of this.connectedClients.entries()) {
      if (clientNodeId === excludeNodeId) continue;
      
      // Check if this is the genesis peer
      const peer = this.peers.get(clientNodeId);
      if (peer?.isGenesisPeer) {
        // Check if WebSocket is still open
        if (client.ws?.readyState !== 1) continue;
        
        console.log(`🌟 Found genesis peer for emergency: ${clientNodeId.substring(0, 8)}...`);
        return {
          nodeId: clientNodeId,
          metadata: {
            ...client.metadata,
            isGenesis: true,
            emergencyTarget: true,
            directConnection: true
          }
        };
      }
    }
    
    // Also check peers map for genesis
    for (const [peerId, peer] of this.peers.entries()) {
      if (peerId === excludeNodeId) continue;
      if (!peer.isGenesisPeer) continue;
      
      const client = this.connectedClients.get(peerId);
      if (client?.ws?.readyState === 1) {
        console.log(`🌟 Found genesis peer from peers map: ${peerId.substring(0, 8)}...`);
        return {
          nodeId: peerId,
          metadata: {
            ...peer.metadata,
            isGenesis: true,
            emergencyTarget: true,
            directConnection: true
          }
        };
      }
    }
    
    console.log(`⚠️ No genesis peer available for emergency connection`);
    return null;
  }

  /**
   * Check bridge availability (using connected bridge nodes)
   * FIXED: Check existing connected bridge nodes instead of trying to create new connections
   */
  async checkBridgeAvailability() {
    console.log(`🏥 Checking bridge availability via connected bridge nodes...`);

    // Get connected bridge nodes from existing connections
    const connectedBridgeNodes = [];
    let availableCount = 0;
    
    for (const [nodeId, client] of this.connectedClients) {
      if (client.metadata && client.metadata.isBridgeNode) {
        connectedBridgeNodes.push({
          nodeId,
          address: client.metadata.listeningAddress || 'unknown',
          available: true,
          state: 'CONNECTED',
          lastActivity: client.timestamp,
          connectAttempts: 0
        });
        availableCount++;
      }
    }
    
    const unavailableCount = this.options.bridgeNodes.length - availableCount;

    console.log(`🏥 Bridge availability: ${availableCount} connected, ${unavailableCount} missing`);
    console.log(`🔍 Connected bridge nodes:`, connectedBridgeNodes.map(b => `${b.nodeId.substring(0, 8)}... (${b.address})`));

    return {
      available: availableCount,
      unavailable: unavailableCount,
      total: this.options.bridgeNodes.length,
      results: connectedBridgeNodes,
      connectedBridgeNodes
    };
  }

  /**
   * Handle new client connection
   */
  handleClientConnection(ws) {
    this.totalConnections++;

    console.log(`🔗 New client connection (total: ${this.totalConnections})`);

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        this.handleClientMessage(ws, message);
      } catch (error) {
        console.error('Error parsing client message:', error);
        ws.close(1002, 'Invalid JSON');
      }
    });

    ws.on('close', () => {
      this.handleClientDisconnection(ws);
    });

    ws.on('error', (error) => {
      console.error('Client WebSocket error:', error);
    });
  }

  /**
   * Handle message from client
   */
  async handleClientMessage(ws, message) {
    try {
      // Update lastSeen timestamp for this peer to prevent timeout
      if (ws.nodeId && this.peers.has(ws.nodeId)) {
        this.peers.get(ws.nodeId).lastSeen = Date.now();
      }

      if (message.type === 'register') {
        await this.handleClientRegistration(ws, message);
      } else if (message.type === 'auth_response') {
        await this.handleAuthResponse(ws, message);
      } else if (message.type === 'get_peers_or_genesis') {
        await this.handleGetPeersOrGenesis(ws, message);
      } else if (message.type === 'send_invitation') {
        await this.handleSendInvitation(ws, message);
      } else if (message.type === 'signal') {
        this.handleSignaling(ws, message);
      } else if (message.type === 'join_peer') {
        this.handleJoinPeer(ws, message);
      } else if (message.type === 'forward_signal') {
        this.handleForwardSignal(ws, message);
      } else if (message.type === 'invitation_accepted') {
        this.handleInvitationAccepted(ws, message);
      } else if (message.type === 'announce_independent') {
        this.handleAnnounceIndependent(ws, message);
      } else if (message.type === 'profile_update') {
        // Handle connection profile update from browsers for network-wide metrics
        this.handleProfileUpdate(ws, message);
      } else if (message.type === 'connection_outcome') {
        // Handle connection outcome report for success rate metrics (Task 1.3)
        this.handleConnectionOutcome(ws, message);
      } else if (message.type === 'onboarding_peer_response') {
        console.log(`📥 Received onboarding_peer_response from bridge (requestId: ${message.requestId?.substring(0, 16)}...)`);
        this.handleBridgeResponse(ws, message);
      } else if (message.type === 'ping') {
        // Handle ping from bridge nodes or any client - respond with pong to keep connection alive
        this.handleClientPing(ws, message);
      } else if (message.type === 'get_connected_clients') {
        // Handle request for connected clients list (used by bridge nodes for emergency recovery)
        await this.handleGetConnectedClients(ws, message);
      } else if (message.type === 'bridge_health_update') {
        // Handle health status update from bridge nodes
        this.handleBridgeHealthUpdate(ws, message);
      } else if (message.type === 'pong') {
        // Handle pong response from bridge nodes - lastSeen already updated above
        // Just log for debugging
        const nodeId = ws.nodeId || 'unknown';
        console.log(`🏓 Received pong from ${nodeId.substring(0, 8)}... (keepalive acknowledged)`);
      } else if (message.type === 'ice_coordinate') {
        // Handle ICE coordination request for synchronized NAT traversal (Tailscale technique)
        // When both peers send ice_coordinate targeting each other, we send ice_start to both simultaneously
        this.handleIceCoordinate(ws, message);
      } else if (message.type === 'ice_restart_coordinate') {
        // Handle coordinated ICE restart for hard NAT pairs
        this.handleIceRestartCoordinate(ws, message);
      } else if (isRelayMessage(message)) {
        // Handle relay protocol messages for symmetric NAT relay system
        // Bootstrap server can relay WebSocket traffic between browsers that can't establish direct WebRTC
        const peerId = ws.nodeId || 'unknown';
        console.log(`🔄 Bootstrap received relay message: ${message.type} from ${peerId.substring(0, 8)}...`);
        this.handleRelayMessage(peerId, message, ws);
      } else {
        console.warn('Unknown message type from client:', message.type);
      }
    } catch (error) {
      console.error('Error handling client message:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Internal server error'
      }));
    }
  }

  /**
   * Handle get_peers_or_genesis request (BootstrapClient compatibility)
   */
  async handleGetPeersOrGenesis(ws, message) {
    const { nodeId, maxPeers } = message;

    console.log(`📋 Received get_peers_or_genesis request from ${nodeId?.substring(0, 8) || 'unknown'}...`);

    // Track responded requests to prevent duplicates
    if (!this.respondedRequests) {
      this.respondedRequests = new Set();
    }

    const requestKey = `${nodeId}_${message.requestId}`;
    if (this.respondedRequests.has(requestKey)) {
      console.warn(`⚠️ Duplicate request detected: ${requestKey} - ignoring`);
      return;
    }

    // Helper function to send response and mark as responded
    const sendResponse = (responseData) => {
      if (this.respondedRequests.has(requestKey)) {
        console.warn(`⚠️ Attempted duplicate response for ${requestKey} - prevented`);
        return false;
      }
      
      this.respondedRequests.add(requestKey);
      ws.send(JSON.stringify(responseData));
      
      // Clean up old requests after 5 minutes to prevent memory leaks
      setTimeout(() => {
        this.respondedRequests.delete(requestKey);
      }, 5 * 60 * 1000);
      
      return true;
    };

    try {
      // CRITICAL FIX: Check if this is a reconnecting peer with membership token
      // Reconnecting peers should be fast-tracked to get peers without bridge coordination
      const membershipToken = message.metadata?.membershipToken;
      const existingPeer = this.peers.get(nodeId);
      const isReconnecting = existingPeer?.type === 'reconnecting' || 
                             existingPeer?.type === 'active' ||
                             existingPeer?.type === 'validation_failed' ||
                             (membershipToken && membershipToken.holder && membershipToken.issuer);

      if (isReconnecting) {
        console.log(`🔄 Fast-tracking reconnecting peer ${nodeId?.substring(0, 8)}...`);
        
        // Get available peers for reconnection (excluding self and bridge nodes)
        const availablePeers = [];
        for (const [clientNodeId, client] of this.connectedClients.entries()) {
          if (clientNodeId === nodeId) continue;
          if (client.metadata?.isBridgeNode || client.metadata?.nodeType === 'bridge') continue;
          if (client.ws?.readyState !== 1) continue; // Only OPEN connections
          
          availablePeers.push({
            nodeId: clientNodeId,
            metadata: client.metadata || {}
          });
        }

        console.log(`📤 Sending ${availablePeers.length} peers to reconnecting client ${nodeId?.substring(0, 8)}...`);

        sendResponse({
          type: 'response',
          requestId: message.requestId,
          success: true,
          data: {
            peers: availablePeers.slice(0, maxPeers || 20),
            isGenesis: false,
            reconnecting: true,
            status: 'reconnection_peers',
            message: `Found ${availablePeers.length} peers for reconnection`
          }
        });
        return;
      }

      // Add client to connected clients if not already present
      if (nodeId && !this.connectedClients.has(nodeId)) {
        this.connectedClients.set(nodeId, {
          ws,
          nodeId,
          metadata: message.metadata || {},
          timestamp: Date.now()
        });
        console.log(`➕ Added client ${nodeId.substring(0, 8)}... to connected clients (total: ${this.connectedClients.size})`);
      }

      // In genesis mode, first NON-PASSIVE peer becomes genesis (only once)
      // Bridge nodes (passive) cannot be genesis - only regular DHT nodes
      const existingClient = this.connectedClients.get(nodeId);
      // Note: existingPeer is already declared above for reconnection check

      // Debug: Log what we're checking
      console.log(`🔍 Genesis check for ${nodeId?.substring(0, 8)}...:`);
      console.log(`   message.metadata:`, message.metadata);
      console.log(`   existingClient.metadata:`, existingClient?.metadata);
      console.log(`   existingPeer.metadata:`, existingPeer?.metadata);
      console.log(`   createNewDHT: ${this.options.createNewDHT}`);
      console.log(`   genesisAssigned: ${this.genesisAssigned}`);
      console.log(`   connectedClients.size: ${this.connectedClients.size}`);
      console.log(`   peers.size: ${this.peers.size}`);

      const isBridgeNode = message.metadata?.isBridgeNode === true ||
                           message.metadata?.nodeType === 'bridge' ||
                           existingClient?.metadata?.isBridgeNode === true ||
                           existingClient?.metadata?.nodeType === 'bridge' ||
                           existingPeer?.metadata?.isBridgeNode === true ||
                           existingPeer?.metadata?.nodeType === 'bridge';

      if (isBridgeNode) {
        console.log(`🌉 Detected bridge node ${nodeId?.substring(0, 8)}... - will not designate as genesis`);
      }

      if (this.options.createNewDHT && !isBridgeNode) {
        // Check if this node is already designated as genesis or if no genesis assigned yet
        const peer = this.peers.get(nodeId);
        const isAlreadyGenesis = peer?.isGenesisPeer === true;
        const hasGenesisMembershipToken = message.metadata?.membershipToken?.isGenesis === true;
        const shouldAssignGenesis = !this.genesisAssigned || isAlreadyGenesis || hasGenesisMembershipToken;
        
        if (shouldAssignGenesis) {
          console.log(`🌟 Genesis mode: ${hasGenesisMembershipToken ? 'Existing genesis with token' : isAlreadyGenesis ? 'Existing genesis peer' : 'Designating'} ${nodeId?.substring(0, 8)}... as genesis peer (non-passive node)`);

          // Update peer record to mark as genesis
          if (peer) {
            peer.isGenesisPeer = true;
          }

          // Mark genesis as assigned immediately to prevent race conditions
          this.genesisAssigned = true;

          // CRITICAL FIX: Send immediate response with bridge node addresses
          console.log(`📤 Sending immediate genesis response with bridge node addresses`);
          
          // Get real bridge node IDs from connected clients
          const bridgeNodePeers = [];
          for (const [clientNodeId, client] of this.connectedClients.entries()) {
            if (client.metadata?.isBridgeNode === true || client.metadata?.nodeType === 'bridge') {
              console.log(`🌉 Found connected bridge node: ${clientNodeId.substring(0, 8)}...`);
              bridgeNodePeers.push({
                nodeId: clientNodeId, // Use REAL node ID from connected bridge
                metadata: {
                  isBridgeNode: true,
                  nodeType: client.metadata.nodeType || 'bridge',
                  websocketAddress: client.metadata.listeningAddress || client.metadata.websocketAddress,
                  listeningAddress: client.metadata.listeningAddress,
                  publicWssAddress: client.metadata.publicWssAddress,
                  capabilities: client.metadata.capabilities || ['websocket']
                }
              });
            }
          }
          
          // Fallback: If no connected bridge nodes, use configured addresses with warning
          if (bridgeNodePeers.length === 0) {
            console.warn(`⚠️ No connected bridge nodes found, using configured addresses as fallback`);
            for (const bridgeAddr of this.options.bridgeNodes) {
              // Use correct protocol based on address
              const protocol = bridgeAddr.startsWith('wss://') || bridgeAddr.startsWith('ws://') 
                ? '' 
                : (bridgeAddr.includes('imeyouwe.com') ? 'wss://' : 'ws://');
              const fullAddress = protocol + bridgeAddr;
              
              bridgeNodePeers.push({
                nodeId: `bridge_${bridgeAddr.replace(/[:.]/g, '_')}`, // Temporary ID - will fail!
                metadata: {
                  isBridgeNode: true,
                  nodeType: 'bridge',
                  websocketAddress: fullAddress,
                  listeningAddress: fullAddress,
                  capabilities: ['websocket']
                }
              });
            }
          }
          
          console.log(`📤 Sending ${bridgeNodePeers.length} bridge nodes to genesis peer`);
          
          sendResponse({
            type: 'response',
            requestId: message.requestId,
            success: true,
            data: {
              peers: bridgeNodePeers, // Provide bridge node addresses for genesis connection
              isGenesis: true,
              message: `Genesis peer designated - connect to ${bridgeNodePeers.length} bridge nodes to form initial DHT`
            }
          });

          // Handle bridge coordination asynchronously (don't block response)
          setTimeout(async () => {
            try {
              console.log(`🌉 Genesis peer designated, testing bridge availability...`);

              // Test bridge availability (stateless)
              const availableBridges = await this.testBridgeAvailability();

              if (availableBridges > 0) {
                console.log(`✅ ${availableBridges} bridge nodes available for genesis coordination`);
                
                // CRITICAL FIX: Trigger bridge invitation process
                console.log(`🎫 Asking genesis peer to invite bridge nodes...`);
                await this.askGenesisToInviteBridgeNodes(nodeId);
              } else {
                console.warn(`⚠️ No bridge nodes available - genesis will operate independently`);
              }
            } catch (error) {
              console.error(`❌ Bridge availability test failed: ${error.message}`);
              // Genesis can operate independently without bridge coordination
            }
          }, 2000); // Give genesis peer time to complete setup

          return;
        }
      }

      // Bridge nodes in genesis mode - wait for genesis peer to connect
      // UNLESS they're in emergency recovery mode (0 peers)
      if (this.options.createNewDHT && isBridgeNode) {
        const isEmergencyRecovery = message.metadata?.emergencyRecovery === true || 
                                    message.metadata?.needsPeers === true ||
                                    message.bridgeNeedsPeers === true;
        
        if (isEmergencyRecovery) {
          console.log(`🆘 Bridge node ${nodeId?.substring(0, 8)}... in emergency recovery - providing DHT peers`);
          
          // Get available DHT peers (non-bridge nodes) for emergency recovery
          const emergencyPeers = [];
          for (const [clientNodeId, client] of this.connectedClients.entries()) {
            if (clientNodeId === nodeId) continue;
            if (client.metadata?.isBridgeNode || client.metadata?.nodeType === 'bridge') continue;
            if (client.ws?.readyState !== 1) continue; // Only OPEN connections
            
            emergencyPeers.push({
              nodeId: clientNodeId,
              metadata: client.metadata || {}
            });
          }
          
          console.log(`📤 Sending ${emergencyPeers.length} DHT peers to bridge for emergency recovery`);
          
          sendResponse({
            type: 'response',
            requestId: message.requestId,
            success: true,
            data: {
              peers: emergencyPeers.slice(0, maxPeers || 20),
              isGenesis: false,
              emergencyRecovery: true,
              status: 'emergency_peers_for_bridge',
              message: `Found ${emergencyPeers.length} DHT peers for bridge emergency recovery`
            }
          });
          return;
        }
        
        console.log(`🌉 Bridge node ${nodeId?.substring(0, 8)}... registered - waiting for genesis peer (passive nodes cannot be genesis)`);

        // Send empty peer list - bridges will be invited by genesis peer
        sendResponse({
          type: 'response',
          requestId: message.requestId,
          success: true,
          data: {
            peers: [],
            isGenesis: false
          }
        });

        return;
      }

      // Debug: Log the conditions for open network mode
      console.log(`🔍 Open network mode check for ${nodeId?.substring(0, 8)}...:`);
      console.log(`   options.openNetwork: ${this.options.openNetwork}`);
      console.log(`   genesisAssigned: ${this.genesisAssigned}`);
      console.log(`   Bridge availability: tested on-demand (stateless)`);

      // Open network mode - connect subsequent peers via random onboarding peer (after genesis)
      if (this.options.openNetwork && this.genesisAssigned) {
        console.log(`🌐 Open network mode: Finding random onboarding peer for ${nodeId?.substring(0, 8)}...`);

        try {
          // IMPROVED: Wait for bridge to find peer and return it directly (much faster!)
          console.log(`🎲 Requesting onboarding peer from bridge nodes (synchronous)...`);
          
          // Use stateless bridge request with reasonable timeout
          const onboardingResult = await this.requestOnboardingPeerFromBridge(nodeId, message.metadata || {});
          
          if (onboardingResult && onboardingResult.inviterPeerId) {
            console.log(`✅ Bridge found onboarding peer: ${onboardingResult.inviterPeerId.substring(0, 8)}...`);
            
            // Send response with the actual peer that will help with onboarding
            sendResponse({
              type: 'response',
              requestId: message.requestId,
              success: true,
              data: {
                peers: [{
                  nodeId: onboardingResult.inviterPeerId,
                  metadata: onboardingResult.inviterMetadata || {}
                }],
                isGenesis: false,
                membershipToken: onboardingResult.membershipToken,
                status: 'peer_found',
                message: `Found onboarding peer: ${onboardingResult.inviterPeerId.substring(0, 8)}...`
              }
            });

            // Coordinate invitation asynchronously (don't block - peer connection will trigger invitation)
            setTimeout(async () => {
              try {
                await this.coordinateOnboardingInvitation(ws, nodeId, onboardingResult);
              } catch (error) {
                console.error(`❌ Failed to coordinate invitation: ${error.message}`);
              }
            }, 100);

            return;
          } else {
            throw new Error('No suitable onboarding peer available');
          }
        } catch (error) {
          console.error(`❌ Failed to get onboarding peer from bridge: ${error.message}`);
          
          // EMERGENCY BOOTSTRAP MODE: When bridge can't find DHT peers, provide direct connection alternatives
          // This solves the chicken-and-egg problem where new nodes can't join an empty/sparse network
          console.log(`🚨 EMERGENCY BOOTSTRAP MODE: Providing direct connection alternatives`);
          
          // FIRST: Check if bridge provided available peers in emergency response
          // Bridge nodes have DHT routing tables with peers that may not be connected to bootstrap
          if (error.emergencyMode && error.availablePeers && error.availablePeers.length > 0) {
            console.log(`✅ Emergency mode: Using ${error.availablePeers.length} peers from bridge's DHT routing table`);
            
            // Format peers for response
            const bridgePeers = error.availablePeers.map(peer => ({
              nodeId: peer.nodeId,
              metadata: {
                ...peer.metadata,
                emergencyTarget: true,
                directConnection: true,
                fromBridgeRouting: true
              }
            }));
            
            sendResponse({
              type: 'response',
              requestId: message.requestId,
              success: true,
              data: {
                peers: bridgePeers,
                isGenesis: false,
                emergencyMode: true,
                status: 'emergency_bridge_routing',
                message: `DHT network sparse - connecting to ${bridgePeers.length} peers from bridge routing table`
              }
            });
            return;
          }
          
          // FALLBACK: Collect direct connection targets from connected clients
          const directTargets = this.getEmergencyBootstrapTargets(nodeId);
          
          if (directTargets.length > 0) {
            console.log(`✅ Emergency mode: Found ${directTargets.length} direct connection targets`);
            
            sendResponse({
              type: 'response',
              requestId: message.requestId,
              success: true,
              data: {
                peers: directTargets,
                isGenesis: false,
                emergencyMode: true,
                status: 'emergency_direct_connect',
                message: `DHT network sparse - connecting directly to ${directTargets.length} available nodes`
              }
            });
            return;
          }
          
          // Last resort: Return genesis peer if available
          const genesisPeer = this.getGenesisPeerForEmergency(nodeId);
          if (genesisPeer) {
            console.log(`✅ Emergency mode: Providing genesis peer as direct target`);
            sendResponse({
              type: 'response',
              requestId: message.requestId,
              success: true,
              data: {
                peers: [genesisPeer],
                isGenesis: false,
                emergencyMode: true,
                status: 'emergency_genesis_connect',
                message: 'DHT network empty - connecting directly to genesis peer'
              }
            });
            return;
          }
          
          // Absolute fallback: No peers available at all
          console.warn(`⚠️ Emergency mode: No direct connection targets available`);
          sendResponse({
            type: 'response',
            requestId: message.requestId,
            success: true,
            data: {
              peers: [],
              isGenesis: false,
              emergencyMode: true,
              status: 'network_empty',
              message: 'No peers available - you may be the first node in the network'
            }
          });
          return;
        }
      }

      // Standard mode (not open network) - return existing peers or empty list
      const availablePeers = Array.from(this.connectedClients.values())
        .filter(client => client.nodeId !== nodeId)
        .slice(0, maxPeers || 20)
        .map(client => ({
          nodeId: client.nodeId,
          metadata: client.metadata || {}
        }));

      console.log(`📤 Sending ${availablePeers.length} available peers to ${nodeId?.substring(0, 8)}...`);

      // Send standard BootstrapClient-compatible response
      sendResponse({
        type: 'response',
        requestId: message.requestId,
        success: true,
        data: {
          peers: availablePeers,
          isGenesis: false
        }
      });

    } catch (error) {
      console.error('Error handling get_peers_or_genesis request:', error);

      // Send error response in BootstrapClient format
      sendResponse({
        type: 'response',
        requestId: message.requestId,
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Handle send_invitation request from DHT clients
   */
  async handleSendInvitation(ws, message) {
    const { targetPeerId, invitationToken, inviterNodeId, websocketCoordination } = message;

    console.log(`🎫 Invitation request: ${inviterNodeId?.substring(0, 8)}... → ${targetPeerId?.substring(0, 8)}...`);

    try {
      // Check if target is a bridge node first
      let targetIsBridge = false;
      let bridgeConnection = null;

      // Check if target is a connected bridge node
      const targetClient = this.connectedClients.get(targetPeerId);
      if (targetClient && (targetClient.metadata?.isBridgeNode === true || targetClient.metadata?.nodeType === 'bridge')) {
        if (targetClient.ws.readyState === WebSocket.OPEN) {
          targetIsBridge = true;
          bridgeConnection = targetClient.ws;
          console.log(`🔍 Target ${targetPeerId.substring(0, 8)}... is connected bridge node`);
        }
      }

      if (targetIsBridge && bridgeConnection) {
        // Forward invitation to bridge node
        console.log(`🌉 Forwarding invitation to bridge node ${targetPeerId.substring(0, 8)}...`);

        bridgeConnection.send(JSON.stringify({
          type: 'invitation_for_bridge',
          targetPeerId: targetPeerId,
          fromPeer: inviterNodeId,
          invitationToken,
          websocketCoordination,
          message: 'You have been invited to join the DHT network'
        }));

        // Send success response to inviter
        ws.send(JSON.stringify({
          type: 'response',
          requestId: message.requestId,
          success: true,
          data: {
            message: 'Invitation sent to bridge node successfully',
            targetPeer: targetPeerId
          }
        }));

        console.log(`✅ Invitation forwarded to bridge node ${targetPeerId.substring(0, 8)}...`);
        return;
      }

      // Check target peer connection (already retrieved above)
      if (!targetClient) {
        // Target peer not connected - send failure response
        ws.send(JSON.stringify({
          type: 'response',
          requestId: message.requestId,
          success: false,
          error: 'Target peer not connected'
        }));
        return;
      }

      console.log(`📤 Forwarding invitation token to ${targetPeerId.substring(0, 8)}...`);

      // Get inviter peer information
      const inviterClient = this.connectedClients.get(inviterNodeId);

      // Check if this is a browser-to-browser invitation requiring WebRTC coordination
      const inviterIsBrowser = inviterClient?.metadata?.nodeType === 'browser';
      const targetIsBrowser = targetClient?.metadata?.nodeType === 'browser';

      // Create pending invitation for ALL connection types (WebRTC and WebSocket)
      // This enables handleInvitationAccepted to coordinate connections properly
      // CRITICAL: Store metadata so we can coordinate even if inviter disconnects
      const invitationId = `${inviterNodeId}_${targetPeerId}_${Date.now()}`;
      this.pendingInvitations.set(invitationId, {
        inviterNodeId: inviterNodeId,
        inviteeNodeId: targetPeerId,
        inviterWs: ws,
        inviteeWs: targetClient.ws,
        inviterMetadata: inviterClient?.metadata || {},  // Store for offline coordination
        inviteeMetadata: targetClient?.metadata || {},   // Store for offline coordination
        status: 'invitation_sent',
        timestamp: Date.now()
      });

      const coordinationType = (inviterIsBrowser && targetIsBrowser) ? 'WebRTC' : 'WebSocket';
      console.log(`📋 Created pending invitation tracking: ${invitationId} (${coordinationType})`);

      if (inviterIsBrowser && targetIsBrowser) {
        console.log(`🚀 Browser-to-browser invitation detected - will use WebRTC coordination`);
      } else {
        console.log(`🌐 Node.js connection detected - will use WebSocket metadata exchange`);
      }

      // Forward invitation to target peer
      // Debug: Check WebSocket state before sending
      const wsState = targetClient.ws.readyState;
      const wsStateNames = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
      console.log(`📡 Target WebSocket state: ${wsStateNames[wsState]} (${wsState}) for ${targetPeerId.substring(0, 8)}...`);

      if (wsState !== 1) { // 1 = OPEN
        console.error(`❌ Cannot send invitation - WebSocket not OPEN (state: ${wsStateNames[wsState]})`);
        ws.send(JSON.stringify({
          type: 'response',
          requestId: message.requestId,
          success: false,
          error: `Target peer WebSocket not open (state: ${wsStateNames[wsState]})`
        }));
        return;
      }

      try {
        targetClient.ws.send(JSON.stringify({
          type: 'invitation_received',
          fromPeer: inviterNodeId,
          invitationToken,
          websocketCoordination,
          message: 'You have been invited to join the DHT network'
        }));
        console.log(`📨 invitation_received message sent successfully to ${targetPeerId.substring(0, 8)}...`);
      } catch (sendError) {
        console.error(`❌ Error sending invitation to ${targetPeerId.substring(0, 8)}...:`, sendError);
        ws.send(JSON.stringify({
          type: 'response',
          requestId: message.requestId,
          success: false,
          error: `Failed to send invitation: ${sendError.message}`
        }));
        return;
      }

      // Send success response to inviter
      ws.send(JSON.stringify({
        type: 'response',
        requestId: message.requestId,
        success: true,
        data: {
          message: 'Invitation sent successfully',
          targetPeer: targetPeerId
        }
      }));

      console.log(`✅ Invitation forwarded successfully from ${inviterNodeId?.substring(0, 8)}... to ${targetPeerId.substring(0, 8)}...`);

    } catch (error) {
      console.error('Error handling send_invitation:', error);

      // Send error response
      ws.send(JSON.stringify({
        type: 'response',
        requestId: message.requestId,
        success: false,
        error: error.message
      }));
    }
  }

  /**
   * Request genesis connection from bridge nodes (DEPRECATED - using direct invitation flow)
   */
  async requestGenesisConnectionFromBridge(nodeId, metadata) {
    console.log(`🌟 Requesting genesis connection for ${nodeId.substring(0, 8)}... from bridge nodes`);

    try {
      // Find connected bridge nodes from connectedClients
      const bridgeClients = [];
      for (const [clientNodeId, client] of this.connectedClients.entries()) {
        if (client.metadata?.isBridgeNode === true || client.metadata?.nodeType === 'bridge') {
          bridgeClients.push(client);
        }
      }
      
      if (bridgeClients.length === 0) {
        throw new Error('No bridge nodes available for genesis connection');
      }

      const bridgeWs = bridgeClients[0].ws; // Use first bridge node
      const requestId = Date.now().toString() + Math.random().toString(36).substr(2, 9);

      // Send genesis connection request to bridge
      const request = {
        type: 'connect_genesis_peer',
        nodeId,
        metadata: metadata || {},
        requestId
      };

      console.log(`📤 Sent genesis connection request to bridge for ${nodeId.substring(0, 8)}...`);
      bridgeWs.send(JSON.stringify(request));

      // Set timeout for genesis connection
      const timeout = setTimeout(() => {
        const pending = this.pendingGenesisRequests.get(nodeId);
        if (pending) {
          this.pendingGenesisRequests.delete(nodeId);

          // Send timeout response to client
          pending.ws.send(JSON.stringify({
            type: 'response',
            requestId: pending.clientMessage.requestId,
            success: false,
            error: 'Genesis connection timeout'
          }));

          console.warn(`⏰ Genesis connection timeout for ${nodeId.substring(0, 8)}`);
        }
      }, 30000); // 30 second timeout

      // Update pending request with timeout
      const pending = this.pendingGenesisRequests.get(nodeId);
      if (pending) {
        pending.timeout = timeout;
      }

    } catch (error) {
      console.error('Error requesting genesis connection from bridge:', error);

      // Send error response to client
      const pending = this.pendingGenesisRequests.get(nodeId);
      if (pending) {
        this.pendingGenesisRequests.delete(nodeId);

        pending.ws.send(JSON.stringify({
          type: 'response',
          requestId: pending.clientMessage.requestId,
          success: false,
          error: `Genesis connection failed: ${error.message}`
        }));
      }
    }
  }

  /**
   * Handle client registration (new peers or reconnecting peers)
   */
  async handleClientRegistration(ws, message) {
    const { nodeId, metadata, membershipToken, protocolVersion, buildId } = message;

    // DEBUG: Log incoming registration
    console.log(`🔍 handleClientRegistration DEBUG - nodeId: ${nodeId?.substring(0, 8)}...`);
    console.log(`   metadata: ${JSON.stringify(metadata || {})}`);
    console.log(`   metadata.isBridgeNode: ${metadata?.isBridgeNode} (type: ${typeof metadata?.isBridgeNode})`);
    console.log(`   metadata.nodeType: ${metadata?.nodeType}`);

    if (!nodeId) {
      ws.close(1002, 'Missing nodeId');
      return;
    }

    // Check protocol version compatibility FIRST before any other processing
    const versionCheck = checkVersionCompatibility(protocolVersion, buildId, BUILD_ID);
    if (!versionCheck.compatible) {
      console.log(`❌ Version mismatch for ${nodeId?.substring(0, 8)}...: ${versionCheck.message}`);
      console.log(`   Client: protocol=${protocolVersion}, build=${buildId}`);
      console.log(`   Server: protocol=${PROTOCOL_VERSION}, build=${BUILD_ID}`);
      ws.send(JSON.stringify({
        type: 'version_mismatch',
        clientVersion: protocolVersion,
        clientBuildId: buildId,
        serverVersion: PROTOCOL_VERSION,
        serverBuildId: BUILD_ID,
        message: versionCheck.message
      }));
      ws.close(4001, 'Version mismatch');
      return;
    }

    // Check if this is a reconnecting peer (has membership token)
    if (membershipToken) {
      console.log(`🔄 Reconnecting peer detected: ${nodeId.substring(0, 8)}...`);
      await this.handleReconnectingPeer(ws, { nodeId, membershipToken, metadata });
    } else {
      console.log(`🆕 New peer registering: ${nodeId.substring(0, 8)}...`);
      await this.handleNewPeer(ws, { nodeId, metadata });
    }
  }

  /**
   * Handle new peer registration
   */
  async handleNewPeer(ws, { nodeId, metadata }) {
    // DEBUG: Log incoming metadata
    console.log(`🔍 handleNewPeer DEBUG - nodeId: ${nodeId?.substring(0, 8)}...`);
    console.log(`   metadata: ${JSON.stringify(metadata || {})}`);
    console.log(`   metadata.isBridgeNode: ${metadata?.isBridgeNode} (type: ${typeof metadata?.isBridgeNode})`);
    
    // Check peer limit
    if (this.peers.size >= this.options.maxPeers) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Server at capacity'
      }));
      ws.close(1000, 'Server full');
      return;
    }

    // Store peer (genesis determination happens in get_peers_or_genesis)
    this.peers.set(nodeId, {
      ws,
      lastSeen: Date.now(),
      metadata: metadata || {},
      isGenesisPeer: false, // Will be updated during get_peers_or_genesis if needed
      type: 'new'
    });

    // Add/update client in connectedClients with metadata
    if (this.connectedClients.has(nodeId)) {
      // Client already exists - update metadata
      const client = this.connectedClients.get(nodeId);
      client.metadata = metadata || {};
      console.log(`📋 Updated metadata for connected client ${nodeId.substring(0, 8)}...:`, metadata);
      console.log(`   🔍 METADATA STORAGE DEBUG - publicWssAddress: ${metadata?.publicWssAddress || 'NOT SET'}`);
    } else {
      // Client doesn't exist yet - add them with metadata
      this.connectedClients.set(nodeId, {
        ws,
        nodeId,
        metadata: metadata || {},
        timestamp: Date.now()
      });
      console.log(`📋 Added new client ${nodeId.substring(0, 8)}... to connected clients with metadata:`, metadata);
      console.log(`   🔍 METADATA STORAGE DEBUG - publicWssAddress: ${metadata?.publicWssAddress || 'NOT SET'}`);
    }

    console.log(`📋 Registered new peer: ${nodeId.substring(0, 8)}...`);

    // Send registration confirmation (genesis handling moved to get_peers_or_genesis)
    ws.send(JSON.stringify({
      type: 'registered',
      nodeId,
      timestamp: Date.now()
    }));

    // If client provided a public key with proper JWK structure, initiate cryptographic authentication
    // Node.js clients use GUID-based IDs and don't require authentication
    if (metadata && metadata.publicKey &&
        metadata.publicKey.kty === 'EC' &&
        metadata.publicKey.x &&
        metadata.publicKey.y) {
      console.log(`🔐 Initiating cryptographic authentication for ${nodeId.substring(0, 8)}...`);
      await this.initiateAuthentication(ws, nodeId, metadata.publicKey);
    } else if (metadata && metadata.nodeType === 'nodejs') {
      console.log(`✅ Node.js client ${nodeId.substring(0, 8)}... registered (no authentication required)`);
    }
  }

  /**
   * Derive 160-bit Kademlia node ID from public key (same algorithm as browser)
   */
  async deriveNodeIdFromPublicKey(publicKeyJwk) {
    try {
      // Decode base64url coordinates to bytes
      const base64UrlToBytes = (base64url) => {
        const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
        return Buffer.from(base64, 'base64');
      };

      // Concatenate x and y coordinates
      const xBytes = base64UrlToBytes(publicKeyJwk.x);
      const yBytes = base64UrlToBytes(publicKeyJwk.y);
      const publicKeyBytes = Buffer.concat([xBytes, yBytes]);

      // SHA-256 hash
      const hash = crypto.createHash('sha256').update(publicKeyBytes).digest('hex');

      // Take first 160 bits (40 hex characters)
      return hash.substring(0, 40);
    } catch (error) {
      console.error('Error deriving node ID from public key:', error);
      throw error;
    }
  }

  /**
   * Initiate cryptographic authentication challenge
   */
  async initiateAuthentication(ws, nodeId, publicKey) {
    try {
      // Step 1: Verify node ID matches public key hash
      const derivedNodeId = await this.deriveNodeIdFromPublicKey(publicKey);

      if (derivedNodeId !== nodeId) {
        console.error(`❌ Node ID mismatch! Claimed: ${nodeId.substring(0, 16)}..., Derived: ${derivedNodeId.substring(0, 16)}...`);
        ws.send(JSON.stringify({
          type: 'auth_failure',
          reason: 'Node ID does not match public key hash',
          timestamp: Date.now()
        }));
        return;
      }

      console.log(`✅ Node ID verified for ${nodeId.substring(0, 8)}...`);

      // Step 2: Generate authentication challenge
      const nonce = crypto.randomBytes(32).toString('hex');
      const timestamp = Date.now();

      // Store challenge for verification
      this.authChallenges.set(nodeId, {
        nonce,
        timestamp,
        publicKey,
        ws
      });

      // Clean up old challenges after 2 minutes
      setTimeout(() => {
        this.authChallenges.delete(nodeId);
      }, 2 * 60 * 1000);

      // Step 3: Send challenge to client
      console.log(`🎲 Sending authentication challenge to ${nodeId.substring(0, 8)}...`);
      ws.send(JSON.stringify({
        type: 'auth_challenge',
        nonce,
        timestamp
      }));
    } catch (error) {
      console.error('Error initiating authentication:', error);
      ws.send(JSON.stringify({
        type: 'auth_failure',
        reason: 'Authentication initialization failed',
        error: error.message,
        timestamp: Date.now()
      }));
    }
  }

  /**
   * Handle authentication response from client
   */
  async handleAuthResponse(ws, message) {
    try {
      const { nodeId, signature, timestamp } = message;

      if (!nodeId || !signature) {
        console.error('❌ Invalid auth response - missing nodeId or signature');
        ws.send(JSON.stringify({
          type: 'auth_failure',
          reason: 'Missing required authentication fields',
          timestamp: Date.now()
        }));
        return;
      }

      // Retrieve stored challenge
      const challenge = this.authChallenges.get(nodeId);
      if (!challenge) {
        console.error(`❌ No pending challenge for node ${nodeId.substring(0, 8)}...`);
        ws.send(JSON.stringify({
          type: 'auth_failure',
          reason: 'No pending authentication challenge',
          timestamp: Date.now()
        }));
        return;
      }

      // Verify signature
      const challengeData = `${challenge.nonce}:${challenge.timestamp}`;
      const isValid = await this.verifySignature(challengeData, signature, challenge.publicKey);

      // Clean up challenge
      this.authChallenges.delete(nodeId);

      if (isValid) {
        console.log(`✅ Authentication successful for ${nodeId.substring(0, 8)}...`);

        // Mark peer as verified
        if (this.peers.has(nodeId)) {
          const peer = this.peers.get(nodeId);
          peer.verified = true;
          peer.metadata.verified = true;
        }

        // CRITICAL FIX: Add authenticated client to connectedClients for invitation coordination
        // This ensures browser clients are available for handleInvitationAccepted()
        if (!this.connectedClients.has(nodeId)) {
          const peer = this.peers.get(nodeId);
          this.connectedClients.set(nodeId, {
            ws,
            nodeId,
            metadata: peer?.metadata || {},
            timestamp: Date.now()
          });
          console.log(`➕ Added authenticated client ${nodeId.substring(0, 8)}... to connected clients (total: ${this.connectedClients.size})`);
        }

        // Send success message
        ws.send(JSON.stringify({
          type: 'auth_success',
          nodeId,
          timestamp: Date.now()
        }));
      } else {
        console.error(`❌ Authentication failed for ${nodeId.substring(0, 8)}... - invalid signature`);
        ws.send(JSON.stringify({
          type: 'auth_failure',
          reason: 'Invalid signature',
          timestamp: Date.now()
        }));
      }
    } catch (error) {
      console.error('Error handling auth response:', error);
      ws.send(JSON.stringify({
        type: 'auth_failure',
        reason: 'Authentication verification failed',
        error: error.message,
        timestamp: Date.now()
      }));
    }
  }

  /**
   * Verify ECDSA signature using Node.js crypto
   *
   * CRITICAL: Web Crypto API outputs ECDSA signatures in IEEE P1363 format (raw r||s),
   * while Node.js crypto expects DER format by default. We must use the newer API
   * with dsaEncoding option to handle browser signatures correctly.
   */
  async verifySignature(data, signatureHex, publicKeyJwk) {
    try {
      // Import JWK public key as KeyObject
      const publicKeyObject = crypto.createPublicKey({
        key: publicKeyJwk,
        format: 'jwk'
      });

      // Convert hex signature to buffer
      const signatureBuffer = Buffer.from(signatureHex, 'hex');

      // Verify signature using newer API with IEEE P1363 format
      // This matches the format output by Web Crypto API in browsers
      const isValid = crypto.verify(
        'sha256',
        Buffer.from(data, 'utf8'),
        {
          key: publicKeyObject,
          dsaEncoding: 'ieee-p1363'  // CRITICAL: Match browser signature format
        },
        signatureBuffer
      );

      return isValid;
    } catch (error) {
      console.error('Error verifying signature:', error);
      return false;
    }
  }

  /**
   * Connect genesis peer to bridge nodes via invitation flow
   * Genesis creates its own membership token, then invites bridge nodes
   * Bridge nodes get membership tokens from the invitation process
   */
  async connectGenesisToBridge(ws, nodeId, metadata, clientMessage) {
    try {
      console.log(`🌟 Setting up genesis peer ${nodeId.substring(0, 8)} invitation flow...`);

      // Mark genesis as assigned
      this.genesisAssigned = true;

      // Send genesis response - genesis peer will create its own membership token
      ws.send(JSON.stringify({
        type: 'response',
        requestId: clientMessage.requestId,
        success: true,
        data: {
          isGenesis: true,
          peers: [],  // Genesis starts with no peers
          bootstrapServers: [`ws://${this.options.host}:${this.options.port}`]
        }
      }));

      console.log(`✅ Genesis peer ${nodeId.substring(0, 8)} designated - will create own membership token`);

      // Wait for genesis peer to create its membership token and be ready
      setTimeout(async () => {
        console.log(`🎫 Asking genesis peer ${nodeId.substring(0, 8)} to invite bridge nodes...`);
        // Ask genesis to invite all available bridge nodes
        await this.askGenesisToInviteBridgeNodes(nodeId);
      }, 2000); // Give genesis time to create token and set up

    } catch (error) {
      console.error(`❌ Failed to set up genesis peer: ${error.message}`);

      // Send error response
      ws.send(JSON.stringify({
        type: 'response',
        requestId: clientMessage.requestId,
        success: false,
        error: `Failed to set up genesis peer: ${error.message}`
      }));
    }
  }

  /**
   * Get onboarding peer from bridge (random peer selection for scalability)
   * Connection-agnostic approach - reuses existing invitation system
   */
  async getOnboardingPeerFromBridge(ws, nodeId, metadata, clientMessage) {
    try {
      console.log(`🎲 Requesting random onboarding peer from bridge for ${nodeId.substring(0, 8)}...`);

      // FIXED: Use stateless bridge request instead of persistent connection
      // Bridge availability will be tested during the actual request

      const requestId = `onboarding_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Create promise for bridge response
      const queryPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pendingBridgeQueries.delete(requestId);
          reject(new Error('Onboarding peer query timeout'));
        }, this.options.bridgeTimeout);

        this.pendingBridgeQueries.set(requestId, {
          ws,
          nodeId,
          metadata,
          clientMessage,
          resolve,
          reject,
          timeout
        });
      });

      // Get available bridge connection
      const bridgeClients = Array.from(this.peers.values()).filter(peer => peer.isBridgeNode);
      if (bridgeClients.length === 0) {
        throw new Error('No bridge nodes available for onboarding peer query');
      }

      const bridgeWs = bridgeClients[0].ws; // Use first bridge node

      // Send query to bridge
      bridgeWs.send(JSON.stringify({
        type: 'get_onboarding_peer',
        newNodeId: nodeId,
        newNodeMetadata: metadata,
        requestId,
        timestamp: Date.now()
      }));

      console.log(`📤 Sent onboarding peer query to bridge for ${nodeId.substring(0, 8)}, requestId=${requestId}`);

      // Wait for bridge response
      await queryPromise;

    } catch (error) {
      console.error(`❌ Failed to get onboarding peer from bridge:`, error);
      throw error;
    }
  }

  /**
   * Handle onboarding peer result from bridge
   * Bridge found random peer and sent invitation via DHT
   */
  async handleOnboardingPeerResult(response) {
    const { requestId, success, result, error } = response;

    const pending = this.pendingBridgeQueries.get(requestId);
    if (!pending) {
      console.warn(`Received onboarding result for unknown request: ${requestId}`);
      return;
    }

    // Clear timeout and remove from pending
    clearTimeout(pending.timeout);
    this.pendingBridgeQueries.delete(requestId);

    if (success && result) {
      console.log(`✅ Bridge found onboarding peer ${result.helperPeerId.substring(0, 8)} for ${pending.nodeId.substring(0, 8)}`);
      console.log(`   Status: ${result.status}`);
      console.log(`   Bridge sent invitation to helper peer via DHT (connection-agnostic)`);

      // Update peer status
      const peer = this.peers.get(pending.nodeId);
      if (peer) {
        peer.hasDHTMembership = true;
      }

      // Send membership token to new peer
      // Helper peer will coordinate connection through existing invitation system
      // Check if we already responded to prevent duplicates
      const requestKey = `${pending.nodeId}_${pending.clientMessage.requestId}`;
      if (!this.respondedRequests || !this.respondedRequests.has(requestKey)) {
        if (!this.respondedRequests) this.respondedRequests = new Set();
        this.respondedRequests.add(requestKey);
        
        pending.ws.send(JSON.stringify({
          type: 'response',
          requestId: pending.clientMessage.requestId,
          success: true,
          data: {
            peers: [], // No direct peers - helper will coordinate through bootstrap
            isGenesis: false,
            membershipToken: result.membershipToken,
            onboardingHelper: result.helperPeerId,
            status: 'helper_coordinating',
            message: 'Random DHT peer will help you join the network (invitation sent via DHT)'
          }
        }));
        
        // Clean up after 5 minutes
        setTimeout(() => {
          this.respondedRequests?.delete(requestKey);
        }, 5 * 60 * 1000);
      } else {
        console.log(`⚠️ Prevented duplicate response for ${requestKey} in handleOnboardingPeerResult`);
      }

      pending.resolve();
    } else {
      console.warn(`❌ Bridge failed to find onboarding peer for ${pending.nodeId.substring(0, 8)}: ${error}`);

      // Send failure response
      // Check if we already responded to prevent duplicates
      const requestKey = `${pending.nodeId}_${pending.clientMessage.requestId}`;
      if (!this.respondedRequests || !this.respondedRequests.has(requestKey)) {
        if (!this.respondedRequests) this.respondedRequests = new Set();
        this.respondedRequests.add(requestKey);
        
        pending.ws.send(JSON.stringify({
          type: 'response',
          requestId: pending.clientMessage.requestId,
          success: false,
          error: `Onboarding failed: ${error}`
        }));
        
        // Clean up after 5 minutes
        setTimeout(() => {
          this.respondedRequests?.delete(requestKey);
        }, 5 * 60 * 1000);
      } else {
        console.log(`⚠️ Prevented duplicate error response for ${requestKey} in handleOnboardingPeerResult`);
      }

      // Close connection
      pending.ws.close(1000, 'Onboarding failed');
      this.peers.delete(pending.nodeId);

      pending.reject(new Error(error));
    }
  }

  /**
   * Handle reconnecting peer
   */
  async handleReconnectingPeer(ws, { nodeId, membershipToken, metadata }) {
    console.log(`🔄 Processing reconnection for ${nodeId.substring(0, 8)}... with membership token`);

    // Store reconnecting peer immediately so they can receive responses
    this.peers.set(nodeId, {
      ws,
      lastSeen: Date.now(),
      metadata: metadata || {},
      isGenesisPeer: false,
      type: 'reconnecting',
      membershipToken
    });

    // Also add to connectedClients for peer discovery
    this.connectedClients.set(nodeId, {
      ws,
      nodeId,
      metadata: metadata || {},
      timestamp: Date.now()
    });

    // CRITICAL FIX: For reconnecting peers with valid membership tokens,
    // skip bridge validation and allow direct reconnection.
    // The membership token proves they were previously part of the network.
    // Bridge validation is only needed for NEW peers joining the network.
    
    // Basic membership token validation (check structure)
    if (membershipToken && membershipToken.holder && membershipToken.issuer) {
      console.log(`✅ Membership token validated for ${nodeId.substring(0, 8)}...`);
      console.log(`   Holder: ${membershipToken.holder.substring(0, 8)}...`);
      console.log(`   Issuer: ${membershipToken.issuer.substring(0, 8)}...`);
      
      // Send success response
      ws.send(JSON.stringify({
        type: 'reconnection_result',
        success: true,
        nodeId,
        message: 'Reconnection validated - membership token accepted'
      }));

      // Update peer type to active
      const peer = this.peers.get(nodeId);
      if (peer) {
        peer.type = 'active';
      }

      console.log(`✅ Reconnection successful for ${nodeId.substring(0, 8)}...`);
      return;
    }

    // If membership token is invalid/missing, try bridge validation as fallback
    console.log(`⚠️ Invalid membership token for ${nodeId.substring(0, 8)}..., attempting bridge validation`);

    // Get available bridge connection - check metadata.isBridgeNode
    const bridgeClients = Array.from(this.connectedClients.values()).filter(
      client => client.metadata?.isBridgeNode === true || client.metadata?.nodeType === 'bridge'
    );
    
    if (bridgeClients.length === 0) {
      // No bridge nodes available - allow reconnection anyway for resilience
      // The peer has a membership token, so they were previously part of the network
      console.warn(`⚠️ No bridge nodes available for validation, allowing reconnection for ${nodeId.substring(0, 8)}...`);
      
      ws.send(JSON.stringify({
        type: 'reconnection_result',
        success: true,
        nodeId,
        message: 'Reconnection allowed - no bridge validation available'
      }));

      const peer = this.peers.get(nodeId);
      if (peer) {
        peer.type = 'active';
      }
      return;
    }

    // Generate unique request ID
    const requestId = `reconnect_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Store pending reconnection
    const reconnectionPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingReconnections.delete(requestId);
        reject(new Error('Bridge validation timeout'));
      }, this.options.bridgeTimeout || 10000);

      this.pendingReconnections.set(requestId, {
        ws,
        nodeId,
        resolve,
        reject,
        timeout
      });
    });

    const bridgeWs = bridgeClients[0].ws;

    // Send validation request to bridge
    try {
      bridgeWs.send(JSON.stringify({
        type: 'validate_reconnection',
        nodeId,
        membershipToken,
        requestId,
        timestamp: Date.now()
      }));

      console.log(`📤 Sent reconnection validation to bridge for ${nodeId.substring(0, 8)}...`);

      // Wait for bridge response
      await reconnectionPromise;
      
      // Update peer type to active on success
      const peer = this.peers.get(nodeId);
      if (peer) {
        peer.type = 'active';
      }
      
    } catch (error) {
      console.warn(`⚠️ Bridge validation failed for ${nodeId.substring(0, 8)}: ${error.message}`);
      
      // CRITICAL FIX: Don't close connection on validation failure
      // Allow the peer to continue - they can still request peers via get_peers_or_genesis
      ws.send(JSON.stringify({
        type: 'reconnection_result',
        success: false,
        reason: error.message,
        fallback: true,
        message: 'Bridge validation failed, but you can still request peers'
      }));
      
      // Keep the peer registered so they can make further requests
      const peer = this.peers.get(nodeId);
      if (peer) {
        peer.type = 'validation_failed';
      }
    }
  }

  // REMOVED: getAvailableBridgeNode() and getAllAvailableBridgeNodes()
  // REASON: No persistent connections - bridge availability tested on-demand

  // REMOVED: getAllBridgeNodeMetadata()
  // REASON: No persistent connections - bridge metadata obtained via stateless requests

  /**
   * Generate authentication signature for bridge node
   */
  async generateBridgeAuthSignature(bridgeNodeId) {
    const authToken = 'bridge_auth_' + (this.options.bridgeAuth || 'default-bridge-auth-key');
    const message = `bridge_auth:${authToken}:${bridgeNodeId}:bootstrap_verified`;
    // Simple hash for now - TODO: implement proper cryptographic signature
    const { createHash } = await import('crypto');
    return createHash('sha256').update(message).digest('hex');
  }

  /**
   * Handle response from bridge node (address-based routing)
   */
  handleBridgeResponseByAddress(bridgeAddr, response) {
    if (response.type === 'reconnection_result') {
      this.handleReconnectionResult(response);
    } else if (response.type === 'genesis_connection_result') {
      this.handleGenesisConnectionResult(response);
    } else if (response.type === 'onboarding_peer_result') {
      this.handleOnboardingPeerResult(response);
    } else if (response.type === 'bridge_invitation_accepted') {
      this.handleBridgeInvitationAccepted(response);
    } else if (response.type === 'bridge_invitation_failed') {
      this.handleBridgeInvitationFailed(response);
    } else if (response.type === 'ping') {
      // Handle ping from bridge node - send pong back
      this.handleBridgePing(bridgeAddr, response);
    } else if (response.type === 'pong') {
      // Handle pong from bridge node - just log for now
      console.log(`🏓 Received pong from bridge ${bridgeAddr}`);
    } else {
      console.warn(`Unknown bridge response type: ${response.type}`);
    }
  }

  /**
   * Handle reconnection validation result from bridge
   */
  handleReconnectionResult(response) {
    const { nodeId, requestId, success, reason } = response;

    const pending = this.pendingReconnections.get(requestId);
    if (!pending) {
      console.warn(`Received result for unknown reconnection request: ${requestId}`);
      return;
    }

    // Clear timeout and remove from pending
    clearTimeout(pending.timeout);
    this.pendingReconnections.delete(requestId);

    if (success) {
      console.log(`✅ Bridge validated reconnection for ${nodeId.substring(0, 8)}`);

      // Send success response to client
      pending.ws.send(JSON.stringify({
        type: 'reconnection_result',
        success: true,
        reason: 'Reconnection validated',
        networkFingerprint: response.networkFingerprint,
        additionalData: response.additionalData
      }));

      // Send current peer list for reconnection
      this.sendPeerList(pending.ws, nodeId);

      pending.resolve();
    } else {
      console.warn(`❌ Bridge rejected reconnection for ${nodeId.substring(0, 8)}: ${reason}`);

      // Send failure response to client
      pending.ws.send(JSON.stringify({
        type: 'reconnection_result',
        success: false,
        reason
      }));

      // Close connection and remove peer
      pending.ws.close(1000, 'Reconnection denied');
      this.peers.delete(nodeId);

      pending.reject(new Error(reason));
    }
  }

  // REMOVED: handleBridgePing()
  // REASON: No persistent connections - no ping/pong mechanism needed

  /**
   * Handle genesis connection result from bridge node
   */
  async handleGenesisConnectionResult(response) {
    const { nodeId, requestId, success, reason } = response;

    console.log(`🔍 Looking for pending genesis request: nodeId=${nodeId?.substring(0, 8)}, requestId=${requestId}`);
    console.log(`🔍 Pending genesis requests:`, Array.from(this.pendingGenesisRequests.keys()));

    // Find pending request by iterating through all entries since we need to match the correct one
    let pending = null;
    let pendingKey = null;

    for (const [key, pendingRequest] of this.pendingGenesisRequests.entries()) {
      if (pendingRequest.nodeId === nodeId && pendingRequest.requestId === requestId) {
        pending = pendingRequest;
        pendingKey = key;
        console.log(`🔍 Found matching pending request with key: ${key}`);
        break;
      }
    }

    if (!pending) {
      console.warn(`Received genesis result for unknown request: nodeId=${nodeId?.substring(0, 8)}, requestId=${requestId}`);
      return;
    }

    // Clear timeout and remove from pending
    clearTimeout(pending.timeout);
    this.pendingGenesisRequests.delete(pendingKey);

    if (success) {
      console.log(`✅ Genesis peer ${nodeId.substring(0, 8)} connected to bridge - genesis status removed`);

      // Mark genesis as assigned (for open network mode)
      this.genesisAssigned = true;
      console.log(`🔒 Genesis flag set - subsequent peers will connect to bridge directly`);

      // Update peer status - no longer genesis, now has valid DHT membership
      const peer = this.peers.get(nodeId);
      if (peer) {
        peer.isGenesisPeer = false; // Genesis status removed by bridge connection
        peer.hasDHTMembership = true;
      }

      // Send BootstrapClient-compatible response for get_peers_or_genesis request
      let bridgeMetadata;
      try {
        bridgeMetadata = await this.getAllBridgeNodeMetadata();
        console.log(`🔍 Generated bridge metadata for ${bridgeMetadata.length} bridge nodes`);
      } catch (error) {
        console.error(`❌ Failed to generate bridge metadata:`, error);
        bridgeMetadata = [];
      }

      // Get the bridge node's actual listening address
      const bridgeWs = this.getBridgeNodeByNodeId(response.bridgeNodeId);
      const bridgeListeningAddress = bridgeWs?.listeningAddress || 'ws://localhost:8083';

      const responseData = {
        type: 'response',
        requestId: pending.clientMessage.requestId,
        success: true,
        data: {
          peers: bridgeMetadata, // Include ALL bridge nodes
          isGenesis: true, // This peer was genesis until bridge connection
          membershipToken: response.membershipToken, // Bridge provides membership token
          bridgeNodeId: response.bridgeNodeId,
          bridgeConnectionInfo: {
            nodeId: response.bridgeNodeId,
            websocketAddress: bridgeListeningAddress,
            nodeType: 'bridge',
            capabilities: ['websocket']
          },
          // Request to invite bridge node after genesis setup is complete
          bridgeInvitationRequest: {
            targetPeerId: response.bridgeNodeId,
            bridgeNodeInfo: {
              nodeId: response.bridgeNodeId,
              nodeType: 'bridge',
              listeningAddress: bridgeListeningAddress,
              capabilities: ['websocket'],
              isBridgeNode: true
            }
          },
          message: 'Connected to bridge node - you now have DHT membership and should invite the bridge node'
        }
      };

      console.log(`📤 Sending genesis response to ${nodeId.substring(0, 8)} with ${bridgeMetadata.length} bridge nodes`);
      console.log(`🔍 WebSocket state: ${pending.ws.readyState} (1=OPEN)`);

      // Check if we already responded to prevent duplicates
      const requestKey = `${nodeId}_${pending.clientMessage.requestId}`;
      if (!this.respondedRequests || !this.respondedRequests.has(requestKey)) {
        if (!this.respondedRequests) this.respondedRequests = new Set();
        this.respondedRequests.add(requestKey);
        
        try {
          pending.ws.send(JSON.stringify(responseData));
          console.log(`✅ Genesis response sent successfully to ${nodeId.substring(0, 8)}`);
          
          // Clean up after 5 minutes
          setTimeout(() => {
            this.respondedRequests?.delete(requestKey);
          }, 5 * 60 * 1000);
        } catch (error) {
          console.error(`❌ Failed to send genesis response to ${nodeId.substring(0, 8)}:`, error);
        }
      } else {
        console.log(`⚠️ Prevented duplicate response for ${requestKey} in handleGenesisConnectionResult`);
      }

      // Resolve the connection promise
      pending.resolve();
    } else {
      console.warn(`❌ Bridge rejected genesis connection for ${nodeId.substring(0, 8)}: ${reason}`);

      // Send BootstrapClient-compatible error response
      // Check if we already responded to prevent duplicates
      const requestKey = `${nodeId}_${pending.clientMessage.requestId}`;
      if (!this.respondedRequests || !this.respondedRequests.has(requestKey)) {
        if (!this.respondedRequests) this.respondedRequests = new Set();
        this.respondedRequests.add(requestKey);
        
        pending.ws.send(JSON.stringify({
          type: 'response',
          requestId: pending.clientMessage.requestId,
          success: false,
          error: reason
        }));
        
        // Clean up after 5 minutes
        setTimeout(() => {
          this.respondedRequests?.delete(requestKey);
        }, 5 * 60 * 1000);
      } else {
        console.log(`⚠️ Prevented duplicate error response for ${requestKey} in handleGenesisConnectionResult`);
      }

      // Close connection and remove peer
      pending.ws.close(1000, 'Genesis connection failed');
      this.peers.delete(nodeId);

      // Reject the connection promise
      pending.reject(new Error(reason));
    }
  }

  /**
   * Handle bridge invitation accepted response
   */
  handleBridgeInvitationAccepted(response) {
    const { bridgeNodeId, inviterNodeId, bridgeServerAddress, timestamp } = response;

    console.log(`✅ Bridge node ${bridgeNodeId?.substring(0, 8)}... accepted invitation from ${inviterNodeId?.substring(0, 8)}...`);
    console.log(`🔗 Bridge server address: ${bridgeServerAddress}`);

    // Update bridge node status if tracking
    const bridgeWs = this.getBridgeNodeByNodeId(bridgeNodeId);
    if (bridgeWs) {
      // Bridge node is now part of DHT network
      console.log(`🌉 Bridge node ${bridgeNodeId?.substring(0, 8)}... is now connected to DHT network`);
    }

    // Instruct genesis peer to connect to bridge node's WebSocket server
    const genesisPeer = this.peers.get(inviterNodeId);
    if (genesisPeer && genesisPeer.ws && genesisPeer.ws.readyState === 1 && bridgeServerAddress) {
      console.log(`🔗 Instructing genesis peer ${inviterNodeId?.substring(0, 8)}... to connect to bridge at ${bridgeServerAddress}`);

      genesisPeer.ws.send(JSON.stringify({
        type: 'connect_to_bridge',
        bridgeNodeId: bridgeNodeId,
        bridgeServerAddress: bridgeServerAddress,
        timestamp: Date.now()
      }));
    } else {
      console.warn(`⚠️ Could not find genesis peer ${inviterNodeId?.substring(0, 8)}... to send bridge connection instruction`);
    }

    // Optionally notify the inviter that bridge connection was successful
    const inviterPeer = this.peers.get(inviterNodeId);
    if (inviterPeer && inviterPeer.ws.readyState === WebSocket.OPEN) {
      inviterPeer.ws.send(JSON.stringify({
        type: 'bridge_connection_status',
        bridgeNodeId,
        status: 'connected',
        timestamp
      }));
    }
  }

  /**
   * Handle bridge invitation failed response
   */
  handleBridgeInvitationFailed(response) {
    const { bridgeNodeId, inviterNodeId, reason, timestamp } = response;

    console.warn(`❌ Bridge node ${bridgeNodeId?.substring(0, 8)}... failed to accept invitation from ${inviterNodeId?.substring(0, 8)}...: ${reason}`);

    // Optionally notify the inviter that bridge connection failed
    const inviterPeer = this.peers.get(inviterNodeId);
    if (inviterPeer && inviterPeer.ws.readyState === WebSocket.OPEN) {
      inviterPeer.ws.send(JSON.stringify({
        type: 'bridge_connection_status',
        bridgeNodeId,
        status: 'failed',
        reason,
        timestamp
      }));
    }
  }

  /**
   * Get bridge node WebSocket by node ID
   */
  getBridgeNodeByNodeId(nodeId) {
    const client = this.connectedClients.get(nodeId);
    if (client && (client.metadata?.isBridgeNode === true || client.metadata?.nodeType === 'bridge')) {
      return client.ws;
    }
    return null;
  }

  /**
   * Send peer list to client for bootstrapping
   */
  sendPeerList(ws, requestingNodeId) {
    const peers = Array.from(this.peers.entries())
      .filter(([nodeId, peer]) => {
        return nodeId !== requestingNodeId &&
               peer.ws.readyState === WebSocket.OPEN &&
               (Date.now() - peer.lastSeen) < this.options.peerTimeout;
      })
      .map(([nodeId, peer]) => ({
        nodeId,
        metadata: peer.metadata,
        lastSeen: peer.lastSeen
      }));

    ws.send(JSON.stringify({
      type: 'peers',
      peers,
      count: peers.length,
      timestamp: Date.now()
    }));

    console.log(`📋 Sent peer list (${peers.length} peers) to ${requestingNodeId.substring(0, 8)}...`);
  }

  /**
   * Handle WebRTC signaling between peers
   */
  handleSignaling(ws, message) {
    const { fromPeer, toPeer, signal } = message;

    const targetPeer = this.peers.get(toPeer);
    if (!targetPeer || targetPeer.ws.readyState !== WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'signal_error',
        message: 'Target peer not available'
      }));
      return;
    }

    // Forward signal to target peer
    targetPeer.ws.send(JSON.stringify({
      type: 'signal',
      fromPeer,
      signal,
      timestamp: Date.now()
    }));

    console.log(`📡 Forwarded signal: ${fromPeer.substring(0, 8)} → ${toPeer.substring(0, 8)}`);
  }

  /**
   * Handle join peer request
   */
  handleJoinPeer(ws, message) {
    const { fromPeer, targetPeer } = message;

    const target = this.peers.get(targetPeer);
    if (!target || target.ws.readyState !== WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'join_error',
        message: 'Target peer not available'
      }));
      return;
    }

    // Notify target peer of join request
    target.ws.send(JSON.stringify({
      type: 'peer_join_request',
      fromPeer,
      timestamp: Date.now()
    }));

    console.log(`🤝 Join request: ${fromPeer.substring(0, 8)} → ${targetPeer.substring(0, 8)}`);
  }

  /**
   * Handle WebRTC signal forwarding between peers
   */
  handleForwardSignal(ws, message) {
    const { fromPeer, toPeer, signal } = message;

    if (!fromPeer || !toPeer || !signal) {
      console.warn('Invalid forward_signal message - missing required fields');
      ws.send(JSON.stringify({
        type: 'error',
        error: 'Invalid signal forwarding request'
      }));
      return;
    }

    const targetPeer = this.peers.get(toPeer);
    if (!targetPeer || targetPeer.ws.readyState !== WebSocket.OPEN) {
      console.warn(`Cannot forward signal - target peer ${toPeer.substring(0, 8)} not available`);
      ws.send(JSON.stringify({
        type: 'error',
        error: 'Target peer not available'
      }));
      return;
    }

    // Forward the signal to the target peer
    targetPeer.ws.send(JSON.stringify({
      type: 'signal',
      fromPeer,
      toPeer,
      signal
    }));

    console.log(`📡 WebRTC signal forwarded: ${fromPeer.substring(0, 8)} → ${toPeer.substring(0, 8)} (${signal.type || 'unknown'})`);

    // Send success response back to requesting client
    if (message.requestId) {
      ws.send(JSON.stringify({
        type: 'response',
        requestId: message.requestId,
        success: true
      }));
    }
  }

  /**
   * Handle ICE coordination request for synchronized NAT traversal (Tailscale technique)
   * 
   * When Browser A wants to connect to Browser B:
   * 1. A sends: { type: 'ice_coordinate', target: B, candidates: [...], profile: {...} }
   * 2. Bootstrap holds A's request, waits for B to be ready
   * 3. B sends: { type: 'ice_coordinate', target: A, candidates: [...], profile: {...} }
   * 4. Bootstrap sends BOTH peers: { type: 'ice_start', timestamp: T, peerCandidates: [...], peerProfile: {...} }
   * 5. Both peers start ICE probing at exactly time T
   * 6. Packets cross in flight, opening both firewalls simultaneously
   * 
   * This is especially useful for symmetric NAT ↔ cone NAT pairs where timing matters.
   */
  handleIceCoordinate(ws, message) {
    const fromPeer = ws.nodeId;
    const { target, candidates, profile, sessionId } = message;

    if (!fromPeer) {
      console.warn('❄️ ICE coordinate from unregistered peer');
      ws.send(JSON.stringify({
        type: 'ice_coordinate_error',
        error: 'Not registered',
        sessionId
      }));
      return;
    }

    if (!target) {
      console.warn(`❄️ ICE coordinate from ${fromPeer.substring(0, 8)} missing target`);
      ws.send(JSON.stringify({
        type: 'ice_coordinate_error',
        error: 'Missing target peer',
        sessionId
      }));
      return;
    }

    // Create a canonical key for this peer pair (sorted to ensure same key regardless of who initiates)
    const peerPair = [fromPeer, target].sort().join(':');
    
    console.log(`❄️ ICE coordinate: ${fromPeer.substring(0, 8)} → ${target.substring(0, 8)} (pair: ${peerPair.substring(0, 20)}...)`);

    // Check if we already have a pending coordination for this pair
    let coordination = this.pendingIceCoordinations.get(peerPair);
    
    if (!coordination) {
      // First peer to request coordination - create pending entry and wait for the other peer
      coordination = {
        timestamp: Date.now(),
        sessionId: sessionId || `ice-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
        peers: {}
      };
      this.pendingIceCoordinations.set(peerPair, coordination);
      
      // Set timeout to clean up if the other peer doesn't respond
      coordination.timeoutId = setTimeout(() => {
        this._handleIceCoordinationTimeout(peerPair, fromPeer);
      }, this.iceCoordinationTimeout);
    }

    // Store this peer's data
    coordination.peers[fromPeer] = {
      ws,
      candidates: candidates || [],
      profile: profile || {},
      timestamp: Date.now()
    };

    // Check if both peers are now ready
    const peerIds = Object.keys(coordination.peers);
    if (peerIds.length === 2 && peerIds.includes(fromPeer) && peerIds.includes(target)) {
      // Both peers ready! Clear timeout and send ice_start to both simultaneously
      if (coordination.timeoutId) {
        clearTimeout(coordination.timeoutId);
      }
      
      this._sendIceStart(peerPair, coordination);
    } else {
      // Still waiting for the other peer
      console.log(`❄️ Waiting for ${target.substring(0, 8)} to coordinate ICE with ${fromPeer.substring(0, 8)}`);
      
      // Acknowledge receipt to the requesting peer
      ws.send(JSON.stringify({
        type: 'ice_coordinate_pending',
        sessionId: coordination.sessionId,
        target,
        message: 'Waiting for peer to coordinate'
      }));
    }
  }

  /**
   * Detect if both peers have hard NAT (symmetric NAT) from their connection profiles
   * Task 4.3: This detection is used to determine if coordinated ICE restart should be attempted
   * 
   * @param {Object} profileA - Connection profile of peer A
   * @param {Object} profileB - Connection profile of peer B
   * @returns {Object} Detection result with flags and recommendation
   */
  _detectHardNatPair(profileA, profileB) {
    const result = {
      bothHardNat: false,
      peerAHardNat: false,
      peerBHardNat: false,
      shouldAttemptCoordinatedRestart: false,
      estimatedSuccessRate: 0.8,
      reason: ''
    };

    // Check if profiles are available
    if (!profileA || !profileB) {
      result.reason = 'Missing connection profile(s)';
      return result;
    }

    // Detect hard NAT for each peer
    // Hard NAT = symmetric NAT with endpoint-dependent mapping
    result.peerAHardNat = profileA.natType === 'hard';
    result.peerBHardNat = profileB.natType === 'hard';
    result.bothHardNat = result.peerAHardNat && result.peerBHardNat;

    if (result.bothHardNat) {
      // Both peers have hard NAT - direct connection is very difficult
      // Check port allocation patterns to estimate success rate
      const peerASequential = profileA.portPattern === 'sequential';
      const peerBSequential = profileB.portPattern === 'sequential';

      if (peerASequential && peerBSequential) {
        // Sequential port allocation on both sides gives some hope
        // Port prediction may work, coordinated restart is worth trying
        result.shouldAttemptCoordinatedRestart = true;
        result.estimatedSuccessRate = 0.3;
        result.reason = 'Both hard NAT with sequential ports - coordinated restart recommended';
        console.log(`🔒 Hard NAT pair detected: Both peers have symmetric NAT with sequential port allocation`);
        console.log(`   → Coordinated ICE restart recommended if initial ICE fails`);
      } else if (profileA.portPattern === 'random' || profileB.portPattern === 'random') {
        // Random port allocation makes direct connection nearly impossible
        // Coordinated restart unlikely to help, but worth one try
        result.shouldAttemptCoordinatedRestart = true;
        result.estimatedSuccessRate = 0.05;
        result.reason = 'Both hard NAT with random ports - relay strongly recommended';
        console.log(`🔒 Hard NAT pair detected: Both peers have symmetric NAT with random port allocation`);
        console.log(`   → Direct connection very unlikely, relay recommended`);
      } else {
        // Unknown port pattern - try coordinated restart
        result.shouldAttemptCoordinatedRestart = true;
        result.estimatedSuccessRate = 0.2;
        result.reason = 'Both hard NAT with unknown port pattern - coordinated restart may help';
        console.log(`🔒 Hard NAT pair detected: Both peers have symmetric NAT`);
        console.log(`   → Coordinated ICE restart recommended if initial ICE fails`);
      }
    } else if (result.peerAHardNat || result.peerBHardNat) {
      // One peer has hard NAT, the other has easy/open NAT
      // Direct connection has a reasonable chance
      result.estimatedSuccessRate = 0.6;
      result.reason = 'One hard NAT, one easy/open NAT - direct connection may work';
      console.log(`🔓 Mixed NAT pair: One peer has hard NAT, other has ${result.peerAHardNat ? profileB.natType : profileA.natType}`);
    } else {
      // Neither peer has hard NAT - direct connection should work
      result.estimatedSuccessRate = 0.85;
      result.reason = 'No hard NAT detected - direct connection likely';
    }

    // Check for IPv6 availability which bypasses NAT entirely
    if (profileA.hasIPv6 && profileB.hasIPv6) {
      result.estimatedSuccessRate = Math.max(result.estimatedSuccessRate, 0.9);
      result.reason += ' (IPv6 available on both peers)';
      console.log(`🌐 IPv6 available on both peers - NAT traversal may not be needed`);
    }

    return result;
  }

  /**
   * Send ice_start to both peers simultaneously for coordinated NAT traversal
   */
  _sendIceStart(peerPair, coordination) {
    const peerIds = Object.keys(coordination.peers);
    const [peerA, peerB] = peerIds;
    const peerAData = coordination.peers[peerA];
    const peerBData = coordination.peers[peerB];

    // Task 4.3: Detect if both peers have hard NAT
    const hardNatDetection = this._detectHardNatPair(peerAData.profile, peerBData.profile);

    // Use a synchronized timestamp slightly in the future to account for network latency
    // Both peers will start ICE probing at this exact time
    const startTimestamp = Date.now() + 100; // 100ms in the future

    console.log(`❄️ ICE coordination complete! Sending ice_start to both peers: ${peerA.substring(0, 8)} ↔ ${peerB.substring(0, 8)}`);
    if (hardNatDetection.bothHardNat) {
      console.log(`   ⚠️ Both peers have hard NAT - ${hardNatDetection.reason}`);
    }

    // Send to peer A with peer B's candidates and profile
    if (peerAData.ws && peerAData.ws.readyState === 1) { // WebSocket.OPEN = 1
      peerAData.ws.send(JSON.stringify({
        type: 'ice_start',
        sessionId: coordination.sessionId,
        timestamp: startTimestamp,
        peer: peerB,
        peerCandidates: peerBData.candidates,
        peerProfile: peerBData.profile,
        // Task 4.3: Include hard NAT detection result so peers know to prepare for coordinated restart
        hardNatPair: hardNatDetection.bothHardNat,
        shouldAttemptCoordinatedRestart: hardNatDetection.shouldAttemptCoordinatedRestart,
        estimatedSuccessRate: hardNatDetection.estimatedSuccessRate
      }));
    }

    // Send to peer B with peer A's candidates and profile
    if (peerBData.ws && peerBData.ws.readyState === 1) { // WebSocket.OPEN = 1
      peerBData.ws.send(JSON.stringify({
        type: 'ice_start',
        sessionId: coordination.sessionId,
        timestamp: startTimestamp,
        peer: peerA,
        peerCandidates: peerAData.candidates,
        peerProfile: peerAData.profile,
        // Task 4.3: Include hard NAT detection result so peers know to prepare for coordinated restart
        hardNatPair: hardNatDetection.bothHardNat,
        shouldAttemptCoordinatedRestart: hardNatDetection.shouldAttemptCoordinatedRestart,
        estimatedSuccessRate: hardNatDetection.estimatedSuccessRate
      }));
    }

    // Clean up the pending coordination
    this.pendingIceCoordinations.delete(peerPair);
  }

  /**
   * Handle ICE coordination timeout - notify the waiting peer
   */
  _handleIceCoordinationTimeout(peerPair, waitingPeer) {
    const coordination = this.pendingIceCoordinations.get(peerPair);
    if (!coordination) return;

    console.log(`❄️ ICE coordination timeout for pair: ${peerPair.substring(0, 20)}...`);

    // Notify the waiting peer that coordination timed out
    const peerData = coordination.peers[waitingPeer];
    if (peerData && peerData.ws && peerData.ws.readyState === 1) {
      peerData.ws.send(JSON.stringify({
        type: 'ice_coordinate_timeout',
        sessionId: coordination.sessionId,
        message: 'Peer did not respond to coordination request'
      }));
    }

    // Clean up
    this.pendingIceCoordinations.delete(peerPair);
  }

  /**
   * Handle coordinated ICE restart for hard NAT pairs
   * 
   * When both peers are behind hard NATs and initial ICE fails:
   * 1. Detect the situation via connection profile exchange
   * 2. Coordinate ICE restart via bootstrap server
   * 3. Time the restart so both peers gather new candidates simultaneously
   * 4. Retry with fresh NAT mappings - sometimes NAT state changes help
   */
  handleIceRestartCoordinate(ws, message) {
    const fromPeer = ws.nodeId;
    const { target, myProfile, sessionId } = message;

    if (!fromPeer) {
      console.warn('🔄 ICE restart coordinate from unregistered peer');
      ws.send(JSON.stringify({
        type: 'ice_restart_error',
        error: 'Not registered',
        sessionId
      }));
      return;
    }

    if (!target) {
      console.warn(`🔄 ICE restart coordinate from ${fromPeer.substring(0, 8)} missing target`);
      ws.send(JSON.stringify({
        type: 'ice_restart_error',
        error: 'Missing target peer',
        sessionId
      }));
      return;
    }

    // Create a canonical key for this peer pair
    const peerPair = [fromPeer, target].sort().join(':');
    const restartKey = `restart:${peerPair}`;
    
    console.log(`🔄 ICE restart coordinate: ${fromPeer.substring(0, 8)} → ${target.substring(0, 8)}`);

    // Check if we already have a pending restart coordination for this pair
    let coordination = this.pendingIceCoordinations.get(restartKey);
    
    if (!coordination) {
      // First peer to request restart - create pending entry
      coordination = {
        timestamp: Date.now(),
        sessionId: sessionId || `restart-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
        isRestart: true,
        peers: {}
      };
      this.pendingIceCoordinations.set(restartKey, coordination);
      
      // Set timeout
      coordination.timeoutId = setTimeout(() => {
        this._handleIceRestartTimeout(restartKey, fromPeer);
      }, this.iceCoordinationTimeout);
    }

    // Store this peer's data
    coordination.peers[fromPeer] = {
      ws,
      profile: myProfile || {},
      timestamp: Date.now()
    };

    // Check if both peers are now ready for restart
    const peerIds = Object.keys(coordination.peers);
    if (peerIds.length === 2 && peerIds.includes(fromPeer) && peerIds.includes(target)) {
      // Both peers ready! Clear timeout and send ice_restart_go to both simultaneously
      if (coordination.timeoutId) {
        clearTimeout(coordination.timeoutId);
      }
      
      this._sendIceRestartGo(restartKey, coordination);
    } else {
      // Still waiting for the other peer
      console.log(`🔄 Waiting for ${target.substring(0, 8)} to coordinate ICE restart with ${fromPeer.substring(0, 8)}`);
      
      // Acknowledge receipt
      ws.send(JSON.stringify({
        type: 'ice_restart_pending',
        sessionId: coordination.sessionId,
        target,
        message: 'Waiting for peer to coordinate restart'
      }));
    }
  }

  /**
   * Send ice_restart_go to both peers simultaneously
   */
  _sendIceRestartGo(restartKey, coordination) {
    const peerIds = Object.keys(coordination.peers);
    const [peerA, peerB] = peerIds;
    const peerAData = coordination.peers[peerA];
    const peerBData = coordination.peers[peerB];

    // Task 4.3: Detect if both peers have hard NAT (reuse the detection method)
    const hardNatDetection = this._detectHardNatPair(peerAData.profile, peerBData.profile);

    // Use a synchronized timestamp slightly in the future
    const restartTimestamp = Date.now() + 100; // 100ms in the future

    console.log(`🔄 ICE restart coordination complete! Sending ice_restart_go to both peers: ${peerA.substring(0, 8)} ↔ ${peerB.substring(0, 8)}`);
    if (hardNatDetection.bothHardNat) {
      console.log(`   ⚠️ Both peers have hard NAT - estimated success rate: ${(hardNatDetection.estimatedSuccessRate * 100).toFixed(0)}%`);
    }

    // Send to peer A
    if (peerAData.ws && peerAData.ws.readyState === 1) {
      peerAData.ws.send(JSON.stringify({
        type: 'ice_restart_go',
        sessionId: coordination.sessionId,
        timestamp: restartTimestamp,
        peer: peerB,
        peerProfile: peerBData.profile,
        // Task 4.3: Include hard NAT detection result
        hardNatPair: hardNatDetection.bothHardNat,
        estimatedSuccessRate: hardNatDetection.estimatedSuccessRate
      }));
    }

    // Send to peer B
    if (peerBData.ws && peerBData.ws.readyState === 1) {
      peerBData.ws.send(JSON.stringify({
        type: 'ice_restart_go',
        sessionId: coordination.sessionId,
        timestamp: restartTimestamp,
        peer: peerA,
        peerProfile: peerAData.profile,
        // Task 4.3: Include hard NAT detection result
        hardNatPair: hardNatDetection.bothHardNat,
        estimatedSuccessRate: hardNatDetection.estimatedSuccessRate
      }));
    }

    // Clean up
    this.pendingIceCoordinations.delete(restartKey);
  }

  /**
   * Handle ICE restart coordination timeout
   */
  _handleIceRestartTimeout(restartKey, waitingPeer) {
    const coordination = this.pendingIceCoordinations.get(restartKey);
    if (!coordination) return;

    console.log(`🔄 ICE restart coordination timeout for: ${restartKey.substring(0, 30)}...`);

    // Notify the waiting peer
    const peerData = coordination.peers[waitingPeer];
    if (peerData && peerData.ws && peerData.ws.readyState === 1) {
      peerData.ws.send(JSON.stringify({
        type: 'ice_restart_timeout',
        sessionId: coordination.sessionId,
        message: 'Peer did not respond to restart coordination request'
      }));
    }

    // Clean up
    this.pendingIceCoordinations.delete(restartKey);
  }

  /**
   * Handle client disconnection
   */
  handleClientDisconnection(ws) {
    // Find and remove the peer from peers map
    for (const [nodeId, peer] of this.peers) {
      if (peer.ws === ws) {
        console.log(`🔌 Peer disconnected: ${nodeId.substring(0, 8)}...`);
        this.peers.delete(nodeId);
        
        // Clean up connection profile metrics for this peer
        this._removeProfileMetrics(nodeId);
        break;
      }
    }

    // CRITICAL FIX: Also remove from connectedClients to prevent stale WebSocket references
    // This fixes the bug where bridge nodes appear connected but have closed WebSockets
    for (const [nodeId, client] of this.connectedClients) {
      if (client.ws === ws) {
        const isBridge = client.metadata?.isBridgeNode || client.metadata?.nodeType === 'bridge';
        console.log(`🔌 Client disconnected: ${nodeId.substring(0, 8)}...${isBridge ? ' (bridge node)' : ''}`);
        this.connectedClients.delete(nodeId);
        
        // Clean up connection profile metrics for this peer (if not already done above)
        this._removeProfileMetrics(nodeId);
        
        // Clean up any pending ICE coordinations involving this peer
        this._cleanupPendingIceCoordinations(nodeId);
        break;
      }
    }
  }

  /**
   * Clean up pending ICE coordinations when a peer disconnects
   * @private
   */
  _cleanupPendingIceCoordinations(nodeId) {
    for (const [peerPair, coordination] of this.pendingIceCoordinations) {
      // Check if this peer is involved in the coordination
      if (coordination.peers && coordination.peers[nodeId]) {
        console.log(`❄️ Cleaning up ICE coordination for disconnected peer: ${nodeId.substring(0, 8)}`);
        
        // Clear the timeout if set
        if (coordination.timeoutId) {
          clearTimeout(coordination.timeoutId);
        }
        
        // Notify the other peer that coordination failed due to disconnect
        for (const [peerId, peerData] of Object.entries(coordination.peers)) {
          if (peerId !== nodeId && peerData.ws && peerData.ws.readyState === 1) {
            peerData.ws.send(JSON.stringify({
              type: coordination.isRestart ? 'ice_restart_error' : 'ice_coordinate_error',
              sessionId: coordination.sessionId,
              error: 'Peer disconnected',
              peer: nodeId
            }));
          }
        }
        
        // Remove the coordination
        this.pendingIceCoordinations.delete(peerPair);
      }
    }
  }
  
  /**
   * Remove a peer's profile from the metrics
   * @private
   */
  _removeProfileMetrics(nodeId) {
    const existingProfile = this.peerProfiles.get(nodeId);
    if (!existingProfile) return;
    
    const profile = existingProfile.profile;
    
    // Decrement counts
    if (profile.natType && this.connectionProfileMetrics.natTypes[profile.natType] !== undefined) {
      this.connectionProfileMetrics.natTypes[profile.natType]--;
    }
    if (profile.portPattern && this.connectionProfileMetrics.portPatterns[profile.portPattern] !== undefined) {
      this.connectionProfileMetrics.portPatterns[profile.portPattern]--;
    }
    if (profile.hasIPv6) {
      this.connectionProfileMetrics.ipv6Capable--;
    }
    if (profile.needsRelay) {
      this.connectionProfileMetrics.needsRelay--;
    }
    
    // Task 6.2: Decrement platform/browser metrics
    this._decrementPlatformMetrics(profile);
    
    // Note: We don't decrement totalReports - it's a cumulative count
    
    this.peerProfiles.delete(nodeId);
    console.log(`📊 Removed profile metrics for ${nodeId.substring(0, 8)}...`);
  }

  /**
   * Start maintenance tasks
   */
  startMaintenanceTasks() {
    // Clean up stale peers every minute
    setInterval(() => {
      this.cleanupStalePeers();
    }, 60000);

    // Clean up stale bridge requests every minute
    setInterval(() => {
      this.cleanupStaleBridgeRequests();
    }, 60000);

    // Clean up stale ICE coordinations every 30 seconds
    // ICE coordinations have a 10 second timeout, so this catches any that slip through
    setInterval(() => {
      this.cleanupStaleIceCoordinations();
    }, 30000);

    // CRITICAL FIX: Send keepalive pings to bridge nodes every 2 minutes
    // This prevents bridge node connections from timing out (5 minute timeout)
    // Bridge nodes respond to pings, which updates their lastSeen timestamp
    setInterval(() => {
      this.sendBridgeKeepalives();
    }, 2 * 60000); // Every 2 minutes (well under 5 minute timeout)

    // Log status every 5 minutes
    setInterval(() => {
      this.logStatus();
    }, 5 * 60000);

    // IMPROVEMENT: Test bridge availability periodically (stateless)
    setInterval(async () => {
      try {
        const availabilityStatus = await this.checkBridgeAvailability();
        
        if (availabilityStatus.unavailable > 0) {
          console.warn(`⚠️ ${availabilityStatus.unavailable}/${availabilityStatus.total} bridge nodes unavailable`);
          
          // Log details for monitoring
          const unavailableBridges = availabilityStatus.results.filter(r => !r.available);
          console.warn('Unavailable bridges:', unavailableBridges.map(b => b.address));
        }
      } catch (error) {
        console.error('❌ Bridge availability check failed:', error);
      }
    }, 5 * 60000); // Every 5 minutes (less frequent since stateless)
  }

  /**
   * Clean up stale bridge requests
   */
  cleanupStaleBridgeRequests() {
    const now = Date.now();
    const staleRequests = [];

    for (const [requestId, request] of this.pendingBridgeRequests) {
      if (now - request.timestamp > 60000) { // 1 minute timeout
        staleRequests.push(requestId);
      }
    }

    for (const requestId of staleRequests) {
      const request = this.pendingBridgeRequests.get(requestId);
      if (request) {
        if (request.timeout) {
          clearTimeout(request.timeout);
        }
        this.pendingBridgeRequests.delete(requestId);
        console.log(`🧹 Cleaned up stale bridge request: ${requestId.substring(0, 16)}...`);
      }
    }

    if (staleRequests.length > 0) {
      console.log(`🧹 Cleaned up ${staleRequests.length} stale bridge requests`);
    }
  }

  /**
   * Clean up stale ICE coordinations that have exceeded their timeout
   * This catches any coordinations that weren't cleaned up by the normal timeout mechanism
   */
  cleanupStaleIceCoordinations() {
    const now = Date.now();
    const staleCoordinations = [];

    for (const [peerPair, coordination] of this.pendingIceCoordinations) {
      // Use 2x the coordination timeout as the stale threshold
      if (now - coordination.timestamp > this.iceCoordinationTimeout * 2) {
        staleCoordinations.push(peerPair);
      }
    }

    for (const peerPair of staleCoordinations) {
      const coordination = this.pendingIceCoordinations.get(peerPair);
      if (coordination) {
        // Clear the timeout if set
        if (coordination.timeoutId) {
          clearTimeout(coordination.timeoutId);
        }
        this.pendingIceCoordinations.delete(peerPair);
        console.log(`🧹 Cleaned up stale ICE coordination: ${peerPair.substring(0, 20)}...`);
      }
    }

    if (staleCoordinations.length > 0) {
      console.log(`🧹 Cleaned up ${staleCoordinations.length} stale ICE coordinations`);
    }
  }

  /**
   * Clean up stale peer connections
   */
  cleanupStalePeers() {
    const now = Date.now();
    const stalePeers = [];

    for (const [nodeId, peer] of this.peers) {
      if (peer.ws.readyState !== WebSocket.OPEN ||
          (now - peer.lastSeen) > this.options.peerTimeout) {
        stalePeers.push(nodeId);
      }
    }

    for (const nodeId of stalePeers) {
      const peer = this.peers.get(nodeId);
      if (peer && peer.ws.readyState === WebSocket.OPEN) {
        peer.ws.close(1000, 'Peer timeout');
      }
      this.peers.delete(nodeId);
    }

    if (stalePeers.length > 0) {
      console.log(`🧹 Cleaned up ${stalePeers.length} stale peers`);
    }
  }

  /**
   * Send keepalive pings to connected bridge nodes
   * This prevents bridge connections from timing out due to inactivity
   */
  sendBridgeKeepalives() {
    // Find all connected bridge nodes
    const bridgeNodes = [];
    for (const [nodeId, client] of this.connectedClients) {
      if (client.metadata?.isBridgeNode === true || client.metadata?.nodeType === 'bridge') {
        if (client.ws?.readyState === WebSocket.OPEN) {
          bridgeNodes.push({ nodeId, ws: client.ws });
        }
      }
    }

    if (bridgeNodes.length === 0) {
      console.log(`🏓 No connected bridge nodes to ping`);
      return;
    }

    console.log(`🏓 Sending keepalive pings to ${bridgeNodes.length} bridge nodes`);

    for (const { nodeId, ws } of bridgeNodes) {
      try {
        const requestId = `keepalive_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        ws.send(JSON.stringify({
          type: 'ping',
          requestId,
          timestamp: Date.now()
        }));
        
        // Update lastSeen when we send the ping (bridge will respond with pong)
        const peer = this.peers.get(nodeId);
        if (peer) {
          peer.lastSeen = Date.now();
        }
        
        console.log(`  🏓 Pinged bridge ${nodeId.substring(0, 8)}...`);
      } catch (error) {
        console.warn(`  ⚠️ Failed to ping bridge ${nodeId.substring(0, 8)}...: ${error.message}`);
      }
    }
  }

  /**
   * Log server status
   */
  logStatus() {
    // FIXED: No persistent bridge connections - show configured bridge count
    const bridgeCount = this.options.bridgeNodes.length;

    const peerTypes = {
      new: 0,
      reconnecting: 0,
      genesis: 0
    };

    for (const peer of this.peers.values()) {
      if (peer.isGenesisPeer) peerTypes.genesis++;
      else if (peer.type === 'reconnecting') peerTypes.reconnecting++;
      else peerTypes.new++;
    }

    console.log(`📊 Server Status - Peers: ${this.peers.size}/${this.options.maxPeers} | Bridge: ${bridgeCount}/${this.options.bridgeNodes.length} | New: ${peerTypes.new} | Reconnecting: ${peerTypes.reconnecting} | Genesis: ${peerTypes.genesis}`);
    
    // Log NAT type distribution across connected browsers (Task 1.3)
    this.logNatTypeDistribution();
  }
  
  /**
   * Log NAT type distribution across connected browsers
   * Provides visibility into network-wide NAT characteristics for relay planning
   */
  logNatTypeDistribution() {
    const metrics = this.connectionProfileMetrics;
    const totalProfiles = this.peerProfiles.size; // Currently connected browsers with profiles
    
    if (totalProfiles === 0) {
      console.log(`📊 NAT Distribution: No browser profiles reported yet`);
      return;
    }
    
    // Calculate current distribution from connected peers
    const currentDistribution = { open: 0, easy: 0, hard: 0, unknown: 0 };
    for (const [nodeId, data] of this.peerProfiles.entries()) {
      const natType = data.profile?.natType || 'unknown';
      if (currentDistribution[natType] !== undefined) {
        currentDistribution[natType]++;
      } else {
        currentDistribution.unknown++;
      }
    }
    
    // Calculate percentages
    const pct = (count) => totalProfiles > 0 ? ((count / totalProfiles) * 100).toFixed(1) : '0.0';
    
    // Count browsers that need relay (hard NAT without IPv6)
    let needsRelayCount = 0;
    for (const [nodeId, data] of this.peerProfiles.entries()) {
      if (data.profile?.needsRelay) {
        needsRelayCount++;
      }
    }
    
    console.log(`📊 NAT Distribution (${totalProfiles} browsers): Open=${currentDistribution.open} (${pct(currentDistribution.open)}%) | Easy=${currentDistribution.easy} (${pct(currentDistribution.easy)}%) | Hard=${currentDistribution.hard} (${pct(currentDistribution.hard)}%) | Unknown=${currentDistribution.unknown} (${pct(currentDistribution.unknown)}%) | NeedsRelay=${needsRelayCount}`);
    
    // Log warning if high percentage of hard NAT (indicates relay infrastructure needed)
    const hardNatPct = parseFloat(pct(currentDistribution.hard));
    if (hardNatPct > 30 && totalProfiles >= 3) {
      console.log(`⚠️ High hard NAT percentage (${hardNatPct}%) - relay infrastructure recommended`);
    }
  }

  /**
   * Ask genesis peer to invite all available bridge nodes
   */
  async askGenesisToInviteBridgeNodes(genesisNodeId) {
    console.log(`🌉 Asking genesis peer ${genesisNodeId.substring(0, 8)}... to invite bridge nodes`);

    // Get all connected bridge nodes with their actual IDs
    const bridgeNodeIds = [];
    for (const [clientNodeId, client] of this.connectedClients.entries()) {
      if ((client.metadata?.isBridgeNode === true || client.metadata?.nodeType === 'bridge') && 
          client.ws.readyState === WebSocket.OPEN) {
        bridgeNodeIds.push(clientNodeId);
        console.log(`🔍 Found connected bridge node: ${clientNodeId.substring(0, 8)}...`);
      }
    }

    if (bridgeNodeIds.length === 0) {
      console.warn(`⚠️ No bridge node IDs available - bridges may not be authenticated yet`);
      return;
    }

    // Ask genesis to invite each bridge node
    for (const bridgeNodeId of bridgeNodeIds) { // Invite ALL bridge nodes for redundancy
      await this.askGenesisToInviteBridge(genesisNodeId, bridgeNodeId);
    }
  }

  /**
   * Ask genesis peer to invite bridge node (correct invitation flow)
   */
  async askGenesisToInviteBridge(genesisNodeId, bridgeNodeId) {
    try {
      console.log(`🎫 Asking genesis peer ${genesisNodeId.substring(0, 8)}... to invite bridge node ${bridgeNodeId.substring(0, 8)}...`);

      // Find the genesis peer connection
      const genesisClient = this.connectedClients.get(genesisNodeId);
      if (!genesisClient) {
        console.warn(`⚠️ Genesis peer ${genesisNodeId.substring(0, 8)}... not found for bridge invitation request`);
        return;
      }

      // Get the bridge node's actual listening address
      const bridgeWs = this.getBridgeNodeByNodeId(bridgeNodeId);
      const bridgeListeningAddr = bridgeWs?.listeningAddress || 'ws://localhost:8083';

      // Send bridge node information to genesis peer with invitation request
      genesisClient.ws.send(JSON.stringify({
        type: 'bridge_invitation_request',
        targetPeerId: bridgeNodeId,
        bridgeNodeInfo: {
          nodeId: bridgeNodeId,
          nodeType: 'bridge',
          listeningAddress: bridgeListeningAddr,
          capabilities: ['websocket'],
          isBridgeNode: true
        },
        message: 'Please invite this bridge node to join the DHT network'
      }));

      console.log(`✅ Bridge invitation request sent to genesis peer ${genesisNodeId.substring(0, 8)}...`);

    } catch (error) {
      console.error('Error asking genesis to invite bridge:', error);
    }
  }

  /**
   * Get server statistics
   */
  getStats() {
    // FIXED: No persistent connections - show configured bridge nodes
    const bridgeStats = this.options.bridgeNodes.map(addr => ({
      address: addr,
      connected: 'tested_on_demand', // Stateless - no persistent connection state
      readyState: 'stateless'
    }));

    // Calculate connection profile percentages
    const totalProfiles = this.connectionProfileMetrics.totalReports;
    const profileStats = totalProfiles > 0 ? {
      totalReports: totalProfiles,
      natTypes: this.connectionProfileMetrics.natTypes,
      portPatterns: this.connectionProfileMetrics.portPatterns,
      ipv6Capable: this.connectionProfileMetrics.ipv6Capable,
      needsRelay: this.connectionProfileMetrics.needsRelay,
      percentages: {
        hardNat: Math.round((this.connectionProfileMetrics.natTypes.hard / totalProfiles) * 100),
        easyNat: Math.round((this.connectionProfileMetrics.natTypes.easy / totalProfiles) * 100),
        openNat: Math.round((this.connectionProfileMetrics.natTypes.open / totalProfiles) * 100),
        ipv6: Math.round((this.connectionProfileMetrics.ipv6Capable / totalProfiles) * 100),
        needsRelay: Math.round((this.connectionProfileMetrics.needsRelay / totalProfiles) * 100)
      },
      lastUpdated: this.connectionProfileMetrics.lastUpdated,
      // Task 6.2: IPv6 availability by platform/browser
      ipv6ByPlatform: this._calculateIPv6Percentages(this.connectionProfileMetrics.ipv6ByPlatform),
      ipv6ByBrowser: this._calculateIPv6Percentages(this.connectionProfileMetrics.ipv6ByBrowser),
      ipv6ByCategory: this._calculateIPv6Percentages(this.connectionProfileMetrics.ipv6ByCategory)
    } : null;

    return {
      isStarted: this.isStarted,
      totalPeers: this.peers.size,
      maxPeers: this.options.maxPeers,
      totalConnections: this.totalConnections,
      bridgeNodes: bridgeStats,
      createNewDHT: this.options.createNewDHT,
      pendingReconnections: this.pendingReconnections.size,
      connectionProfiles: profileStats,
      // Relay capability metadata for symmetric NAT relay system
      canRelay: this.serverMetadata.canRelay,
      capabilities: this.serverMetadata.capabilities
    };
  }

  /**
   * Task 6.2: Calculate IPv6 percentages for platform/browser metrics
   * @private
   */
  _calculateIPv6Percentages(metricsMap) {
    const result = {};
    for (const [key, data] of Object.entries(metricsMap)) {
      if (data.total > 0) {
        result[key] = {
          total: data.total,
          ipv6Capable: data.ipv6Capable,
          ipv6Percentage: Math.round((data.ipv6Capable / data.total) * 100)
        };
      }
    }
    return result;
  }

  /**
   * Task 6.2: Start IPv6 trend tracking with periodic snapshots
   * Takes hourly snapshots of IPv6 adoption metrics for trend analysis
   * @private
   */
  _startIPv6TrendTracking() {
    // Take initial snapshot
    this._takeIPv6Snapshot('hourly');
    
    // Schedule hourly snapshots
    this._ipv6HourlyTimer = setInterval(() => {
      this._takeIPv6Snapshot('hourly');
      
      // Check if we need daily/weekly snapshots
      const now = new Date();
      const lastDaily = this.ipv6TrendData.lastDailySnapshot;
      const lastWeekly = this.ipv6TrendData.lastWeeklySnapshot;
      
      // Daily snapshot at midnight (or if 24+ hours since last)
      if (!lastDaily || (now - lastDaily) >= 24 * 60 * 60 * 1000) {
        this._takeIPv6Snapshot('daily');
      }
      
      // Weekly snapshot on Sunday midnight (or if 7+ days since last)
      if (!lastWeekly || (now - lastWeekly) >= 7 * 24 * 60 * 60 * 1000) {
        this._takeIPv6Snapshot('weekly');
      }
    }, 60 * 60 * 1000); // Every hour
    
    console.log('📊 IPv6 trend tracking started (hourly snapshots)');
  }

  /**
   * Task 6.2: Stop IPv6 trend tracking (for cleanup)
   * @private
   */
  _stopIPv6TrendTracking() {
    if (this._ipv6HourlyTimer) {
      clearInterval(this._ipv6HourlyTimer);
      this._ipv6HourlyTimer = null;
    }
  }

  /**
   * Task 6.2: Take a snapshot of current IPv6 adoption metrics
   * @param {string} type - 'hourly', 'daily', or 'weekly'
   * @private
   */
  _takeIPv6Snapshot(type) {
    const now = Date.now();
    const metrics = this.connectionProfileMetrics;
    const totalProfiles = metrics.totalReports;
    
    // Don't take snapshot if no data
    if (totalProfiles === 0) {
      return;
    }
    
    const snapshot = {
      timestamp: now,
      timestampISO: new Date(now).toISOString(),
      
      // Overall IPv6 adoption
      totalPeers: totalProfiles,
      ipv6Capable: metrics.ipv6Capable,
      ipv6Percentage: Math.round((metrics.ipv6Capable / totalProfiles) * 100),
      
      // By platform category (aggregated for trend analysis)
      byCategory: {},
      
      // By browser (aggregated for trend analysis)
      byBrowser: {},
      
      // NAT type distribution (for correlation analysis)
      natTypes: { ...metrics.natTypes },
      
      // Relay needs (inverse correlation with IPv6)
      needsRelay: metrics.needsRelay,
      needsRelayPercentage: Math.round((metrics.needsRelay / totalProfiles) * 100)
    };
    
    // Aggregate category data
    for (const [category, data] of Object.entries(metrics.ipv6ByCategory)) {
      if (data.total > 0) {
        snapshot.byCategory[category] = {
          total: data.total,
          ipv6Capable: data.ipv6Capable,
          ipv6Percentage: Math.round((data.ipv6Capable / data.total) * 100)
        };
      }
    }
    
    // Aggregate browser data
    for (const [browser, data] of Object.entries(metrics.ipv6ByBrowser)) {
      if (data.total > 0) {
        snapshot.byBrowser[browser] = {
          total: data.total,
          ipv6Capable: data.ipv6Capable,
          ipv6Percentage: Math.round((data.ipv6Capable / data.total) * 100)
        };
      }
    }
    
    // Add to appropriate snapshot array
    switch (type) {
      case 'hourly':
        this.ipv6TrendData.hourlySnapshots.push(snapshot);
        if (this.ipv6TrendData.hourlySnapshots.length > this.ipv6TrendData.maxHourlySnapshots) {
          this.ipv6TrendData.hourlySnapshots.shift();
        }
        this.ipv6TrendData.lastHourlySnapshot = now;
        break;
        
      case 'daily':
        this.ipv6TrendData.dailySnapshots.push(snapshot);
        if (this.ipv6TrendData.dailySnapshots.length > this.ipv6TrendData.maxDailySnapshots) {
          this.ipv6TrendData.dailySnapshots.shift();
        }
        this.ipv6TrendData.lastDailySnapshot = now;
        console.log(`📊 IPv6 daily snapshot: ${snapshot.ipv6Percentage}% adoption (${snapshot.ipv6Capable}/${snapshot.totalPeers} peers)`);
        break;
        
      case 'weekly':
        this.ipv6TrendData.weeklySnapshots.push(snapshot);
        if (this.ipv6TrendData.weeklySnapshots.length > this.ipv6TrendData.maxWeeklySnapshots) {
          this.ipv6TrendData.weeklySnapshots.shift();
        }
        this.ipv6TrendData.lastWeeklySnapshot = now;
        console.log(`📊 IPv6 weekly snapshot: ${snapshot.ipv6Percentage}% adoption (${snapshot.ipv6Capable}/${snapshot.totalPeers} peers)`);
        break;
    }
    
    // Invalidate trend cache
    this.ipv6TrendData.trendCache = null;
    this.ipv6TrendData.trendCacheExpiry = null;
  }

  /**
   * Task 6.2: Calculate IPv6 adoption trends from historical snapshots
   * @returns {Object} Trend analysis with direction, rate of change, and predictions
   */
  getIPv6AdoptionTrends() {
    const now = Date.now();
    
    // Return cached trends if still valid (5 minute cache)
    if (this.ipv6TrendData.trendCache && 
        this.ipv6TrendData.trendCacheExpiry && 
        now < this.ipv6TrendData.trendCacheExpiry) {
      return this.ipv6TrendData.trendCache;
    }
    
    const hourly = this.ipv6TrendData.hourlySnapshots;
    const daily = this.ipv6TrendData.dailySnapshots;
    const weekly = this.ipv6TrendData.weeklySnapshots;
    
    const trends = {
      timestamp: now,
      timestampISO: new Date(now).toISOString(),
      
      // Current state
      current: this._getCurrentIPv6State(),
      
      // Short-term trend (last 24 hours from hourly snapshots)
      shortTerm: this._calculateTrend(hourly, '24 hours'),
      
      // Medium-term trend (last 30 days from daily snapshots)
      mediumTerm: this._calculateTrend(daily, '30 days'),
      
      // Long-term trend (last 12 weeks from weekly snapshots)
      longTerm: this._calculateTrend(weekly, '12 weeks'),
      
      // Platform-specific trends
      platformTrends: this._calculatePlatformTrends(daily),
      
      // Browser-specific trends
      browserTrends: this._calculateBrowserTrends(daily),
      
      // Insights and recommendations
      insights: this._generateIPv6Insights(hourly, daily, weekly),
      
      // Raw data for visualization
      snapshots: {
        hourly: hourly.slice(-24),  // Last 24 hourly snapshots
        daily: daily.slice(-30),    // Last 30 daily snapshots
        weekly: weekly.slice(-12)   // Last 12 weekly snapshots
      }
    };
    
    // Cache the result
    this.ipv6TrendData.trendCache = trends;
    this.ipv6TrendData.trendCacheExpiry = now + 5 * 60 * 1000; // 5 minute cache
    
    return trends;
  }

  /**
   * Task 6.2: Get current IPv6 adoption state
   * @private
   */
  _getCurrentIPv6State() {
    const metrics = this.connectionProfileMetrics;
    const totalProfiles = metrics.totalReports;
    
    if (totalProfiles === 0) {
      return {
        totalPeers: 0,
        ipv6Capable: 0,
        ipv6Percentage: 0,
        needsRelay: 0,
        needsRelayPercentage: 0
      };
    }
    
    return {
      totalPeers: totalProfiles,
      ipv6Capable: metrics.ipv6Capable,
      ipv6Percentage: Math.round((metrics.ipv6Capable / totalProfiles) * 100),
      needsRelay: metrics.needsRelay,
      needsRelayPercentage: Math.round((metrics.needsRelay / totalProfiles) * 100),
      byCategory: this._calculateIPv6Percentages(metrics.ipv6ByCategory),
      byBrowser: this._calculateIPv6Percentages(metrics.ipv6ByBrowser),
      byPlatform: this._calculateIPv6Percentages(metrics.ipv6ByPlatform)
    };
  }

  /**
   * Task 6.2: Calculate trend from snapshot array
   * @param {Array} snapshots - Array of snapshots
   * @param {string} period - Human-readable period description
   * @returns {Object} Trend analysis
   * @private
   */
  _calculateTrend(snapshots, period) {
    if (!snapshots || snapshots.length < 2) {
      return {
        period,
        dataPoints: snapshots ? snapshots.length : 0,
        trend: 'insufficient_data',
        direction: 'unknown',
        changePercentagePoints: 0,
        changeRate: 0,
        startValue: null,
        endValue: null,
        minValue: null,
        maxValue: null,
        avgValue: null
      };
    }
    
    const first = snapshots[0];
    const last = snapshots[snapshots.length - 1];
    const values = snapshots.map(s => s.ipv6Percentage);
    
    const minValue = Math.min(...values);
    const maxValue = Math.max(...values);
    const avgValue = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
    
    // Calculate change in percentage points
    const changePercentagePoints = last.ipv6Percentage - first.ipv6Percentage;
    
    // Calculate rate of change (percentage points per day)
    const timeDiffDays = (last.timestamp - first.timestamp) / (24 * 60 * 60 * 1000);
    const changeRate = timeDiffDays > 0 
      ? Math.round((changePercentagePoints / timeDiffDays) * 100) / 100 
      : 0;
    
    // Determine trend direction
    let direction = 'stable';
    let trend = 'stable';
    if (changePercentagePoints > 2) {
      direction = 'increasing';
      trend = changePercentagePoints > 5 ? 'strong_increase' : 'moderate_increase';
    } else if (changePercentagePoints < -2) {
      direction = 'decreasing';
      trend = changePercentagePoints < -5 ? 'strong_decrease' : 'moderate_decrease';
    }
    
    // Calculate linear regression for prediction
    const regression = this._linearRegression(snapshots.map((s, i) => [i, s.ipv6Percentage]));
    
    return {
      period,
      dataPoints: snapshots.length,
      trend,
      direction,
      changePercentagePoints,
      changeRate, // Percentage points per day
      startValue: first.ipv6Percentage,
      endValue: last.ipv6Percentage,
      startTimestamp: first.timestamp,
      endTimestamp: last.timestamp,
      minValue,
      maxValue,
      avgValue,
      regression: {
        slope: Math.round(regression.slope * 1000) / 1000,
        intercept: Math.round(regression.intercept * 100) / 100,
        r2: Math.round(regression.r2 * 1000) / 1000 // Coefficient of determination
      }
    };
  }

  /**
   * Task 6.2: Calculate platform-specific IPv6 trends
   * @param {Array} dailySnapshots - Daily snapshots for trend analysis
   * @returns {Object} Platform trends
   * @private
   */
  _calculatePlatformTrends(dailySnapshots) {
    if (!dailySnapshots || dailySnapshots.length < 2) {
      return {};
    }
    
    const platformTrends = {};
    const categories = new Set();
    
    // Collect all categories seen
    for (const snapshot of dailySnapshots) {
      for (const category of Object.keys(snapshot.byCategory || {})) {
        categories.add(category);
      }
    }
    
    // Calculate trend for each category
    for (const category of categories) {
      const categorySnapshots = dailySnapshots
        .filter(s => s.byCategory && s.byCategory[category])
        .map(s => ({
          timestamp: s.timestamp,
          ipv6Percentage: s.byCategory[category].ipv6Percentage,
          total: s.byCategory[category].total
        }));
      
      if (categorySnapshots.length >= 2) {
        const first = categorySnapshots[0];
        const last = categorySnapshots[categorySnapshots.length - 1];
        const change = last.ipv6Percentage - first.ipv6Percentage;
        
        platformTrends[category] = {
          dataPoints: categorySnapshots.length,
          startValue: first.ipv6Percentage,
          endValue: last.ipv6Percentage,
          changePercentagePoints: change,
          direction: change > 2 ? 'increasing' : (change < -2 ? 'decreasing' : 'stable'),
          avgSampleSize: Math.round(categorySnapshots.reduce((a, s) => a + s.total, 0) / categorySnapshots.length)
        };
      }
    }
    
    return platformTrends;
  }

  /**
   * Task 6.2: Calculate browser-specific IPv6 trends
   * @param {Array} dailySnapshots - Daily snapshots for trend analysis
   * @returns {Object} Browser trends
   * @private
   */
  _calculateBrowserTrends(dailySnapshots) {
    if (!dailySnapshots || dailySnapshots.length < 2) {
      return {};
    }
    
    const browserTrends = {};
    const browsers = new Set();
    
    // Collect all browsers seen
    for (const snapshot of dailySnapshots) {
      for (const browser of Object.keys(snapshot.byBrowser || {})) {
        browsers.add(browser);
      }
    }
    
    // Calculate trend for each browser
    for (const browser of browsers) {
      const browserSnapshots = dailySnapshots
        .filter(s => s.byBrowser && s.byBrowser[browser])
        .map(s => ({
          timestamp: s.timestamp,
          ipv6Percentage: s.byBrowser[browser].ipv6Percentage,
          total: s.byBrowser[browser].total
        }));
      
      if (browserSnapshots.length >= 2) {
        const first = browserSnapshots[0];
        const last = browserSnapshots[browserSnapshots.length - 1];
        const change = last.ipv6Percentage - first.ipv6Percentage;
        
        browserTrends[browser] = {
          dataPoints: browserSnapshots.length,
          startValue: first.ipv6Percentage,
          endValue: last.ipv6Percentage,
          changePercentagePoints: change,
          direction: change > 2 ? 'increasing' : (change < -2 ? 'decreasing' : 'stable'),
          avgSampleSize: Math.round(browserSnapshots.reduce((a, s) => a + s.total, 0) / browserSnapshots.length)
        };
      }
    }
    
    return browserTrends;
  }

  /**
   * Task 6.2: Generate insights from IPv6 trend data
   * @param {Array} hourly - Hourly snapshots
   * @param {Array} daily - Daily snapshots
   * @param {Array} weekly - Weekly snapshots
   * @returns {Array} Array of insight objects
   * @private
   */
  _generateIPv6Insights(hourly, daily, weekly) {
    const insights = [];
    const current = this._getCurrentIPv6State();
    
    // Insight: Overall IPv6 adoption level
    if (current.ipv6Percentage >= 50) {
      insights.push({
        type: 'positive',
        category: 'adoption',
        message: `Strong IPv6 adoption at ${current.ipv6Percentage}% - NAT traversal bypassed for many connections`,
        recommendation: 'Continue prioritizing IPv6 paths for optimal performance'
      });
    } else if (current.ipv6Percentage >= 30) {
      insights.push({
        type: 'neutral',
        category: 'adoption',
        message: `Moderate IPv6 adoption at ${current.ipv6Percentage}%`,
        recommendation: 'IPv6 provides benefits for a significant portion of users'
      });
    } else if (current.ipv6Percentage > 0) {
      insights.push({
        type: 'info',
        category: 'adoption',
        message: `Low IPv6 adoption at ${current.ipv6Percentage}% - most connections require NAT traversal`,
        recommendation: 'Relay infrastructure remains important for connectivity'
      });
    }
    
    // Insight: Trend direction
    if (daily.length >= 7) {
      const weekAgo = daily[Math.max(0, daily.length - 7)];
      const now = daily[daily.length - 1];
      const weekChange = now.ipv6Percentage - weekAgo.ipv6Percentage;
      
      if (weekChange > 5) {
        insights.push({
          type: 'positive',
          category: 'trend',
          message: `IPv6 adoption increased ${weekChange} percentage points in the last week`,
          recommendation: 'Positive trend - IPv6 infrastructure investments are paying off'
        });
      } else if (weekChange < -5) {
        insights.push({
          type: 'warning',
          category: 'trend',
          message: `IPv6 adoption decreased ${Math.abs(weekChange)} percentage points in the last week`,
          recommendation: 'Investigate potential IPv6 connectivity issues'
        });
      }
    }
    
    // Insight: Mobile vs Desktop comparison
    const mobileCategories = ['mobile-android', 'mobile-ios', 'mobile-other'];
    const desktopCategories = ['desktop-windows', 'desktop-macos', 'desktop-linux', 'desktop-chromeos'];
    
    let mobileTotal = 0, mobileIPv6 = 0;
    let desktopTotal = 0, desktopIPv6 = 0;
    
    for (const [category, data] of Object.entries(current.byCategory || {})) {
      if (mobileCategories.includes(category)) {
        mobileTotal += data.total;
        mobileIPv6 += data.ipv6Capable;
      } else if (desktopCategories.includes(category)) {
        desktopTotal += data.total;
        desktopIPv6 += data.ipv6Capable;
      }
    }
    
    if (mobileTotal > 0 && desktopTotal > 0) {
      const mobilePct = Math.round((mobileIPv6 / mobileTotal) * 100);
      const desktopPct = Math.round((desktopIPv6 / desktopTotal) * 100);
      
      if (mobilePct > desktopPct + 10) {
        insights.push({
          type: 'info',
          category: 'platform',
          message: `Mobile users have higher IPv6 adoption (${mobilePct}%) than desktop (${desktopPct}%)`,
          recommendation: 'Mobile carriers often provide better IPv6 support'
        });
      } else if (desktopPct > mobilePct + 10) {
        insights.push({
          type: 'info',
          category: 'platform',
          message: `Desktop users have higher IPv6 adoption (${desktopPct}%) than mobile (${mobilePct}%)`,
          recommendation: 'Consider mobile-specific relay optimizations'
        });
      }
    }
    
    // Insight: Relay correlation
    if (current.totalPeers > 10) {
      const relayPct = current.needsRelayPercentage;
      const ipv6Pct = current.ipv6Percentage;
      
      // IPv6 users typically don't need relay (no NAT)
      if (relayPct > 30 && ipv6Pct < 30) {
        insights.push({
          type: 'info',
          category: 'relay',
          message: `${relayPct}% of peers need relay, correlating with low IPv6 adoption (${ipv6Pct}%)`,
          recommendation: 'Increasing IPv6 adoption would reduce relay load'
        });
      }
    }
    
    return insights;
  }

  /**
   * Task 6.2: Simple linear regression for trend prediction
   * @param {Array} points - Array of [x, y] points
   * @returns {Object} Regression parameters (slope, intercept, r2)
   * @private
   */
  _linearRegression(points) {
    if (points.length < 2) {
      return { slope: 0, intercept: 0, r2: 0 };
    }
    
    const n = points.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    
    for (const [x, y] of points) {
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumX2 += x * x;
      sumY2 += y * y;
    }
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    // Calculate R² (coefficient of determination)
    const yMean = sumY / n;
    let ssTotal = 0, ssResidual = 0;
    
    for (const [x, y] of points) {
      const yPredicted = slope * x + intercept;
      ssTotal += (y - yMean) ** 2;
      ssResidual += (y - yPredicted) ** 2;
    }
    
    const r2 = ssTotal > 0 ? 1 - (ssResidual / ssTotal) : 0;
    
    return { slope, intercept, r2 };
  }

  /**
   * Task 6.2: Log IPv6 adoption trends to console
   * Useful for monitoring and debugging
   */
  logIPv6AdoptionTrends() {
    const trends = this.getIPv6AdoptionTrends();
    
    console.log('\n📊 IPv6 Adoption Trends Report');
    console.log('═══════════════════════════════════════════════════════════');
    
    // Current state
    const current = trends.current;
    console.log(`\n📍 Current State:`);
    console.log(`   Total Peers: ${current.totalPeers}`);
    console.log(`   IPv6 Capable: ${current.ipv6Capable} (${current.ipv6Percentage}%)`);
    console.log(`   Needs Relay: ${current.needsRelay} (${current.needsRelayPercentage}%)`);
    
    // Short-term trend
    const shortTerm = trends.shortTerm;
    if (shortTerm.dataPoints >= 2) {
      console.log(`\n📈 Short-term (${shortTerm.period}):`);
      console.log(`   Direction: ${shortTerm.direction} (${shortTerm.trend})`);
      console.log(`   Change: ${shortTerm.changePercentagePoints > 0 ? '+' : ''}${shortTerm.changePercentagePoints} percentage points`);
      console.log(`   Range: ${shortTerm.minValue}% - ${shortTerm.maxValue}% (avg: ${shortTerm.avgValue}%)`);
    }
    
    // Medium-term trend
    const mediumTerm = trends.mediumTerm;
    if (mediumTerm.dataPoints >= 2) {
      console.log(`\n📈 Medium-term (${mediumTerm.period}):`);
      console.log(`   Direction: ${mediumTerm.direction} (${mediumTerm.trend})`);
      console.log(`   Change: ${mediumTerm.changePercentagePoints > 0 ? '+' : ''}${mediumTerm.changePercentagePoints} percentage points`);
      console.log(`   Rate: ${mediumTerm.changeRate > 0 ? '+' : ''}${mediumTerm.changeRate} pp/day`);
    }
    
    // Long-term trend
    const longTerm = trends.longTerm;
    if (longTerm.dataPoints >= 2) {
      console.log(`\n📈 Long-term (${longTerm.period}):`);
      console.log(`   Direction: ${longTerm.direction} (${longTerm.trend})`);
      console.log(`   Change: ${longTerm.changePercentagePoints > 0 ? '+' : ''}${longTerm.changePercentagePoints} percentage points`);
    }
    
    // Insights
    if (trends.insights.length > 0) {
      console.log(`\n💡 Insights:`);
      for (const insight of trends.insights) {
        const icon = insight.type === 'positive' ? '✅' : 
                     insight.type === 'warning' ? '⚠️' : 
                     insight.type === 'info' ? 'ℹ️' : '📌';
        console.log(`   ${icon} ${insight.message}`);
      }
    }
    
    console.log('\n═══════════════════════════════════════════════════════════\n');
  }

  /**
   * Handle invitation acceptance for WebRTC coordination
   */
  handleInvitationAccepted(ws, message) {
    const { fromPeer, toPeer } = message;

    // Find the accepting peer's node ID from the WebSocket connection
    let acceptingNodeId = null;
    for (const [nodeId, client] of this.connectedClients.entries()) {
      if (client.ws === ws) {
        acceptingNodeId = nodeId;
        break;
      }
    }

    if (!acceptingNodeId) {
      console.warn(`⚠️ Invitation acceptance from unregistered peer: ${fromPeer?.substring(0, 8)}...`);
      return;
    }

    if (acceptingNodeId !== fromPeer) {
      console.warn(`⚠️ Invitation acceptance from wrong peer - expected ${fromPeer?.substring(0, 8)}..., got ${acceptingNodeId?.substring(0, 8)}...`);
      return;
    }

    console.log(`📨 Invitation acceptance received from ${fromPeer?.substring(0, 8)}... for invitation to ${toPeer?.substring(0, 8)}...`);

    // Find the pending invitation
    let matchingInvitation = null;
    let invitationId = null;

    for (const [id, invitation] of this.pendingInvitations.entries()) {
      if (invitation.inviterNodeId === toPeer && invitation.inviteeNodeId === fromPeer) {
        matchingInvitation = invitation;
        invitationId = id;
        break;
      }
    }

    if (!matchingInvitation) {
      console.warn(`⚠️ No pending invitation found for ${toPeer?.substring(0, 8)}... → ${fromPeer?.substring(0, 8)}...`);
      return;
    }

    console.log(`🤝 Found matching invitation: ${invitationId} - initiating connection coordination`);

    // Update invitation status
    matchingInvitation.status = 'invitation_accepted';
    matchingInvitation.acceptedAt = Date.now();

    // Get peer connections
    const inviterClient = this.connectedClients.get(matchingInvitation.inviterNodeId);
    const inviteeClient = this.connectedClients.get(matchingInvitation.inviteeNodeId);

    // CRITICAL FIX: For bridge-coordinated invitations, inviter may be offline
    // Use stored metadata from pending invitation if inviter disconnected
    const inviterOnline = inviterClient && inviterClient.ws.readyState === 1;
    const inviteeOnline = inviteeClient && inviteeClient.ws.readyState === 1;

    if (!inviteeOnline) {
      console.error(`❌ Cannot coordinate - invitee ${fromPeer?.substring(0, 8)}... is offline`);
      this.pendingInvitations.delete(invitationId);
      return;
    }

    // Get metadata - use live connection or fallback to stored metadata
    const inviterMetadata = inviterOnline ? inviterClient.metadata : matchingInvitation.inviterMetadata;
    const inviteeMetadata = inviteeClient.metadata;

    if (!inviterMetadata) {
      console.error(`❌ Cannot coordinate - no metadata available for inviter ${toPeer?.substring(0, 8)}...`);
      this.pendingInvitations.delete(invitationId);
      return;
    }

    // Log coordination mode
    if (!inviterOnline) {
      console.log(`📝 Inviter offline - using stored metadata for coordination`);
      console.log(`   Inviter will not receive metadata (expected for bridge-coordinated invitations)`);
    }

    // Determine connection type based on node types
    const inviterNodeType = inviterMetadata.nodeType || 'browser';
    const inviteeNodeType = inviteeMetadata.nodeType || 'browser';

    console.log(`🔍 Connection coordination: ${inviterNodeType} → ${inviteeNodeType}`);

    if (inviterNodeType === 'browser' && inviteeNodeType === 'browser') {
      // Browser-to-browser: Use WebRTC coordination
      console.log(`🚀 Using WebRTC coordination for browser-to-browser connection`);

      inviterClient.ws.send(JSON.stringify({
        type: 'webrtc_start_offer',
        targetPeer: matchingInvitation.inviteeNodeId,
        invitationId: invitationId,
        message: 'Send WebRTC offer to establish connection with invited peer'
      }));

      inviteeClient.ws.send(JSON.stringify({
        type: 'webrtc_expect_offer',
        fromPeer: matchingInvitation.inviterNodeId,
        invitationId: invitationId,
        message: 'Expect WebRTC offer from inviting peer'
      }));

    } else {
      // Node.js involved: Send metadata for WebSocket connection
      console.log(`🌐 Using WebSocket coordination for Node.js connection`);

      // Debug: Log metadata being sent
      console.log(`🔍 Invitee metadata:`, JSON.stringify(inviteeMetadata, null, 2));
      console.log(`🔍 Inviter metadata:`, JSON.stringify(inviterMetadata, null, 2));

      // Send invitee's metadata to inviter (only if online)
      if (inviterOnline) {
        inviterClient.ws.send(JSON.stringify({
          type: 'websocket_peer_metadata',
          targetPeer: matchingInvitation.inviteeNodeId,
          targetPeerMetadata: inviteeMetadata,
          invitationId: invitationId,
          message: 'Connect to invited peer using WebSocket (metadata provided)'
        }));
        console.log(`📤 Sent invitee metadata to online inviter`);
      }

      // ALWAYS send inviter's metadata to invitee (invitee must initiate if inviter offline)
      // CRITICAL DEBUG: Log exact metadata being sent to browser
      console.log(`📤 SENDING TO BROWSER - Inviter metadata:`, JSON.stringify({
        listeningAddress: inviterMetadata.listeningAddress,
        publicWssAddress: inviterMetadata.publicWssAddress,
        nodeType: inviterMetadata.nodeType,
        fullMetadata: inviterMetadata
      }, null, 2));

      inviteeClient.ws.send(JSON.stringify({
        type: 'websocket_peer_metadata',
        fromPeer: matchingInvitation.inviterNodeId,
        fromPeerMetadata: inviterMetadata,
        invitationId: invitationId,
        message: 'Inviter peer metadata - initiate connection if inviter is nodejs'
      }));
      console.log(`📤 Sent inviter metadata to invitee`);
    }

    console.log(`🚀 Connection coordination initiated between ${matchingInvitation.inviterNodeId.substring(0,8)}... and ${matchingInvitation.inviteeNodeId.substring(0,8)}...`);

    // Clean up the pending invitation after a delay
    setTimeout(() => {
      this.pendingInvitations.delete(invitationId);
      console.log(`🧹 Cleaned up pending invitation: ${invitationId}`);
    }, 60000); // 1 minute cleanup delay
  }

  /**
   * Handle announce_independent message from client
   * Client is announcing they no longer need bootstrap server for DHT operations
   */
  handleAnnounceIndependent(ws, message) {
    const { nodeId } = message;
    console.log(`🔓 Node ${nodeId.substring(0, 8)}... announced independence from bootstrap server`);

    // Optional: Could track this state if needed for monitoring
    // For now, just acknowledge the message silently (no warning)
  }

  /**
   * Handle profile_update message from client
   * Tracks connection profile metrics for network-wide NAT analysis
   */
  handleProfileUpdate(ws, message) {
    const { nodeId, connectionProfile } = message;
    
    if (!nodeId || !connectionProfile) {
      console.warn('⚠️ Invalid profile_update message - missing nodeId or connectionProfile');
      return;
    }
    
    const shortId = nodeId.substring(0, 8);
    
    // Check if this is an update to an existing profile
    const existingProfile = this.peerProfiles.get(nodeId);
    
    if (existingProfile) {
      // Decrement old counts before updating
      const old = existingProfile.profile;
      if (old.natType && this.connectionProfileMetrics.natTypes[old.natType] !== undefined) {
        this.connectionProfileMetrics.natTypes[old.natType]--;
      }
      if (old.portPattern && this.connectionProfileMetrics.portPatterns[old.portPattern] !== undefined) {
        this.connectionProfileMetrics.portPatterns[old.portPattern]--;
      }
      if (old.hasIPv6) {
        this.connectionProfileMetrics.ipv6Capable--;
      }
      if (old.needsRelay) {
        this.connectionProfileMetrics.needsRelay--;
      }
      // Task 6.2: Decrement old platform/browser counts
      this._decrementPlatformMetrics(old);
    } else {
      // New profile report
      this.connectionProfileMetrics.totalReports++;
    }
    
    // Update counts with new profile
    const natType = connectionProfile.natType || 'unknown';
    const portPattern = connectionProfile.portPattern || 'unknown';
    
    if (this.connectionProfileMetrics.natTypes[natType] !== undefined) {
      this.connectionProfileMetrics.natTypes[natType]++;
    } else {
      this.connectionProfileMetrics.natTypes.unknown++;
    }
    
    if (this.connectionProfileMetrics.portPatterns[portPattern] !== undefined) {
      this.connectionProfileMetrics.portPatterns[portPattern]++;
    } else {
      this.connectionProfileMetrics.portPatterns.unknown++;
    }
    
    if (connectionProfile.hasIPv6) {
      this.connectionProfileMetrics.ipv6Capable++;
    }
    
    if (connectionProfile.needsRelay) {
      this.connectionProfileMetrics.needsRelay++;
    }
    
    // Task 6.2: Update platform/browser IPv6 metrics
    this._incrementPlatformMetrics(connectionProfile);
    
    // Store the profile for this peer
    this.peerProfiles.set(nodeId, {
      profile: connectionProfile,
      timestamp: Date.now()
    });
    
    this.connectionProfileMetrics.lastUpdated = Date.now();
    
    // Task 6.2: Include platform info in log
    const platform = connectionProfile.platform || 'unknown';
    const browser = connectionProfile.browser || 'unknown';
    console.log(`📊 Profile update from ${shortId}...: NAT=${natType}, port=${portPattern}, IPv6=${connectionProfile.hasIPv6}, needsRelay=${connectionProfile.needsRelay}, platform=${platform}, browser=${browser}`);
  }

  /**
   * Task 6.2: Increment platform/browser IPv6 metrics
   * @private
   */
  _incrementPlatformMetrics(profile) {
    const platform = profile.platform || 'unknown';
    const browser = profile.browser || 'unknown';
    const isMobile = profile.isMobile || false;
    const hasIPv6 = profile.hasIPv6 || false;
    
    // Get platform category
    const category = this._getPlatformCategory(platform, isMobile);
    
    // Initialize platform entry if needed
    if (!this.connectionProfileMetrics.ipv6ByPlatform[platform]) {
      this.connectionProfileMetrics.ipv6ByPlatform[platform] = { total: 0, ipv6Capable: 0 };
    }
    this.connectionProfileMetrics.ipv6ByPlatform[platform].total++;
    if (hasIPv6) {
      this.connectionProfileMetrics.ipv6ByPlatform[platform].ipv6Capable++;
    }
    
    // Initialize browser entry if needed
    if (!this.connectionProfileMetrics.ipv6ByBrowser[browser]) {
      this.connectionProfileMetrics.ipv6ByBrowser[browser] = { total: 0, ipv6Capable: 0 };
    }
    this.connectionProfileMetrics.ipv6ByBrowser[browser].total++;
    if (hasIPv6) {
      this.connectionProfileMetrics.ipv6ByBrowser[browser].ipv6Capable++;
    }
    
    // Initialize category entry if needed
    if (!this.connectionProfileMetrics.ipv6ByCategory[category]) {
      this.connectionProfileMetrics.ipv6ByCategory[category] = { total: 0, ipv6Capable: 0 };
    }
    this.connectionProfileMetrics.ipv6ByCategory[category].total++;
    if (hasIPv6) {
      this.connectionProfileMetrics.ipv6ByCategory[category].ipv6Capable++;
    }
  }

  /**
   * Task 6.2: Decrement platform/browser IPv6 metrics when profile is updated
   * @private
   */
  _decrementPlatformMetrics(profile) {
    const platform = profile.platform || 'unknown';
    const browser = profile.browser || 'unknown';
    const isMobile = profile.isMobile || false;
    const hasIPv6 = profile.hasIPv6 || false;
    
    // Get platform category
    const category = this._getPlatformCategory(platform, isMobile);
    
    // Decrement platform counts
    if (this.connectionProfileMetrics.ipv6ByPlatform[platform]) {
      this.connectionProfileMetrics.ipv6ByPlatform[platform].total = 
        Math.max(0, this.connectionProfileMetrics.ipv6ByPlatform[platform].total - 1);
      if (hasIPv6) {
        this.connectionProfileMetrics.ipv6ByPlatform[platform].ipv6Capable = 
          Math.max(0, this.connectionProfileMetrics.ipv6ByPlatform[platform].ipv6Capable - 1);
      }
    }
    
    // Decrement browser counts
    if (this.connectionProfileMetrics.ipv6ByBrowser[browser]) {
      this.connectionProfileMetrics.ipv6ByBrowser[browser].total = 
        Math.max(0, this.connectionProfileMetrics.ipv6ByBrowser[browser].total - 1);
      if (hasIPv6) {
        this.connectionProfileMetrics.ipv6ByBrowser[browser].ipv6Capable = 
          Math.max(0, this.connectionProfileMetrics.ipv6ByBrowser[browser].ipv6Capable - 1);
      }
    }
    
    // Decrement category counts
    if (this.connectionProfileMetrics.ipv6ByCategory[category]) {
      this.connectionProfileMetrics.ipv6ByCategory[category].total = 
        Math.max(0, this.connectionProfileMetrics.ipv6ByCategory[category].total - 1);
      if (hasIPv6) {
        this.connectionProfileMetrics.ipv6ByCategory[category].ipv6Capable = 
          Math.max(0, this.connectionProfileMetrics.ipv6ByCategory[category].ipv6Capable - 1);
      }
    }
  }

  /**
   * Task 6.2: Get platform category for aggregated metrics
   * @private
   */
  _getPlatformCategory(platform, isMobile) {
    if (isMobile) {
      if (platform === 'android') return 'mobile-android';
      if (platform === 'ios') return 'mobile-ios';
      return 'mobile-other';
    }
    
    if (platform === 'windows') return 'desktop-windows';
    if (platform === 'macos') return 'desktop-macos';
    if (platform === 'linux') return 'desktop-linux';
    if (platform === 'chromeos') return 'desktop-chromeos';
    if (platform === 'nodejs') return 'server-nodejs';
    
    return 'unknown';
  }

  /**
   * Handle connection outcome report from clients (Task 1.3)
   * Tracks connection success/failure rates for network-wide metrics
   * 
   * @param {WebSocket} ws - The WebSocket connection
   * @param {Object} message - The connection outcome message
   * @param {string} message.nodeId - The reporting node's ID
   * @param {boolean} message.success - Whether the connection succeeded
   * @param {string} message.connectionType - 'webrtc', 'websocket', or 'relay'
   * @param {string} [message.localNatType] - Local peer's NAT type
   * @param {string} [message.remoteNatType] - Remote peer's NAT type
   * @param {string} [message.iceCandidateType] - ICE candidate type used (for successful WebRTC)
   * @param {string} [message.failureReason] - Reason for failure (if applicable)
   */
  handleConnectionOutcome(ws, message) {
    const { nodeId, success, connectionType, localNatType, remoteNatType, iceCandidateType, failureReason } = message;
    
    if (!nodeId || typeof success !== 'boolean' || !connectionType) {
      console.warn('⚠️ Invalid connection_outcome message - missing required fields');
      return;
    }
    
    const shortId = nodeId.substring(0, 8);
    const now = Date.now();
    
    // Update total counts
    this.connectionMetrics.totalAttempts++;
    if (success) {
      this.connectionMetrics.totalSuccesses++;
    } else {
      this.connectionMetrics.totalFailures++;
    }
    
    // Update by connection type
    const validTypes = ['webrtc', 'websocket', 'relay'];
    const type = validTypes.includes(connectionType) ? connectionType : 'websocket';
    
    this.connectionMetrics.byType[type].attempts++;
    if (success) {
      this.connectionMetrics.byType[type].successes++;
    } else {
      this.connectionMetrics.byType[type].failures++;
    }
    
    // Update by NAT pair (for browser-to-browser WebRTC connections)
    if (connectionType === 'webrtc' && localNatType && remoteNatType) {
      // Normalize NAT pair key (alphabetically sorted to avoid duplicates like 'easy-hard' vs 'hard-easy')
      const natPair = [localNatType, remoteNatType].sort().join('-');
      
      if (!this.connectionMetrics.byNatPair[natPair]) {
        this.connectionMetrics.byNatPair[natPair] = { attempts: 0, successes: 0, failures: 0 };
      }
      
      this.connectionMetrics.byNatPair[natPair].attempts++;
      if (success) {
        this.connectionMetrics.byNatPair[natPair].successes++;
      } else {
        this.connectionMetrics.byNatPair[natPair].failures++;
      }
    }
    
    // Track ICE candidate types for successful WebRTC connections
    if (success && connectionType === 'webrtc' && iceCandidateType) {
      const validCandidateTypes = ['host', 'srflx', 'prflx', 'relay'];
      if (validCandidateTypes.includes(iceCandidateType)) {
        this.connectionMetrics.iceCandidateTypes[iceCandidateType]++;
      }
    }
    
    // Add to recent attempts (rolling window)
    this.connectionMetrics.recentAttempts.push({
      timestamp: now,
      success,
      type: connectionType,
      natPair: localNatType && remoteNatType ? `${localNatType}-${remoteNatType}` : null,
      failureReason: success ? null : failureReason
    });
    
    // Prune old entries from rolling window
    const windowStart = now - this.connectionMetrics.windowSize;
    this.connectionMetrics.recentAttempts = this.connectionMetrics.recentAttempts.filter(
      entry => entry.timestamp >= windowStart
    );
    
    this.connectionMetrics.lastUpdated = now;
    
    const outcomeStr = success ? '✅ SUCCESS' : `❌ FAILURE (${failureReason || 'unknown'})`;
    console.log(`📊 Connection outcome from ${shortId}...: ${connectionType} ${outcomeStr}${iceCandidateType ? ` [${iceCandidateType}]` : ''}`);
  }

  /**
   * Get connection success rate metrics (Task 1.3)
   * Returns comprehensive metrics for the /metrics endpoint
   * 
   * @returns {Object} Connection metrics with success rates and breakdowns
   */
  getConnectionMetrics() {
    const metrics = this.connectionMetrics;
    const now = Date.now();
    
    // Calculate overall success rate
    const overallSuccessRate = metrics.totalAttempts > 0
      ? Math.round((metrics.totalSuccesses / metrics.totalAttempts) * 100)
      : 0;
    
    // Calculate success rates by type
    const byTypeRates = {};
    for (const [type, data] of Object.entries(metrics.byType)) {
      byTypeRates[type] = {
        attempts: data.attempts,
        successes: data.successes,
        failures: data.failures,
        successRate: data.attempts > 0
          ? Math.round((data.successes / data.attempts) * 100)
          : 0
      };
    }
    
    // Calculate success rates by NAT pair
    const byNatPairRates = {};
    for (const [pair, data] of Object.entries(metrics.byNatPair)) {
      byNatPairRates[pair] = {
        attempts: data.attempts,
        successes: data.successes,
        failures: data.failures,
        successRate: data.attempts > 0
          ? Math.round((data.successes / data.attempts) * 100)
          : 0
      };
    }
    
    // Calculate recent success rate (last hour)
    const recentAttempts = metrics.recentAttempts;
    const recentSuccesses = recentAttempts.filter(a => a.success).length;
    const recentSuccessRate = recentAttempts.length > 0
      ? Math.round((recentSuccesses / recentAttempts.length) * 100)
      : 0;
    
    // Calculate ICE candidate type distribution
    const totalIceCandidates = Object.values(metrics.iceCandidateTypes).reduce((a, b) => a + b, 0);
    const iceCandidateDistribution = {};
    for (const [type, count] of Object.entries(metrics.iceCandidateTypes)) {
      iceCandidateDistribution[type] = {
        count,
        percentage: totalIceCandidates > 0
          ? Math.round((count / totalIceCandidates) * 100)
          : 0
      };
    }
    
    // Get failure reasons from recent attempts
    const failureReasons = {};
    for (const attempt of recentAttempts) {
      if (!attempt.success && attempt.failureReason) {
        failureReasons[attempt.failureReason] = (failureReasons[attempt.failureReason] || 0) + 1;
      }
    }
    
    return {
      summary: {
        totalAttempts: metrics.totalAttempts,
        totalSuccesses: metrics.totalSuccesses,
        totalFailures: metrics.totalFailures,
        overallSuccessRate,
        targetSuccessRate: 95, // From requirements: 95%+ connection success rate
        meetsTarget: overallSuccessRate >= 95
      },
      byConnectionType: byTypeRates,
      byNatPair: byNatPairRates,
      iceCandidateTypes: iceCandidateDistribution,
      recentMetrics: {
        windowSizeMs: metrics.windowSize,
        windowSizeHuman: '1 hour',
        attempts: recentAttempts.length,
        successes: recentSuccesses,
        successRate: recentSuccessRate,
        failureReasons
      },
      connectionProfiles: {
        totalReports: this.connectionProfileMetrics.totalReports,
        natTypes: this.connectionProfileMetrics.natTypes,
        portPatterns: this.connectionProfileMetrics.portPatterns,
        ipv6Capable: this.connectionProfileMetrics.ipv6Capable,
        needsRelay: this.connectionProfileMetrics.needsRelay,
        // Task 6.2: IPv6 availability by platform/browser
        ipv6ByPlatform: this._calculateIPv6Percentages(this.connectionProfileMetrics.ipv6ByPlatform),
        ipv6ByBrowser: this._calculateIPv6Percentages(this.connectionProfileMetrics.ipv6ByBrowser),
        ipv6ByCategory: this._calculateIPv6Percentages(this.connectionProfileMetrics.ipv6ByCategory)
      },
      // Task 6.2: IPv6 adoption trends over time
      ipv6Trends: this.getIPv6AdoptionTrends(),
      lastUpdated: metrics.lastUpdated,
      timestamp: now
    };
  }

  /**
   * Handle ping message from client (bridge nodes or any connected client)
   * Responds with pong to keep the WebSocket connection alive
   */
  handleClientPing(ws, message) {
    const nodeId = ws.nodeId || message.from || 'unknown';
    const requestId = message.requestId;
    
    // Update lastSeen for this client
    if (ws.nodeId && this.connectedClients.has(ws.nodeId)) {
      this.connectedClients.get(ws.nodeId).timestamp = Date.now();
    }
    if (ws.nodeId && this.peers.has(ws.nodeId)) {
      this.peers.get(ws.nodeId).lastSeen = Date.now();
    }
    
    // Send pong response
    try {
      ws.send(JSON.stringify({
        type: 'pong',
        requestId,
        from: 'bootstrap_server',
        timestamp: Date.now()
      }));
      console.log(`🏓 Sent pong to ${nodeId.substring(0, 8)}... (requestId: ${requestId?.substring(0, 16) || 'none'})`);
    } catch (error) {
      console.error(`❌ Failed to send pong to ${nodeId.substring(0, 8)}...:`, error.message);
    }
  }

  /**
   * Handle health status update from bridge nodes
   * Updates the bridge node's metadata with current health status
   */
  handleBridgeHealthUpdate(ws, message) {
    const { bridgeNodeId, bridgeHealth } = message;
    const nodeId = ws.nodeId || bridgeNodeId;
    
    if (!nodeId) {
      console.warn(`⚠️ Received bridge_health_update without node ID`);
      return;
    }
    
    // Update the connected client's metadata with health status
    const client = this.connectedClients.get(nodeId);
    if (client) {
      client.metadata = client.metadata || {};
      client.metadata.bridgeHealth = bridgeHealth;
      
      const healthStatus = bridgeHealth?.isHealthy ? '✅ healthy' : '❌ unhealthy';
      console.log(`📊 Bridge ${nodeId.substring(0, 8)}... health update: ${healthStatus} (peers: ${bridgeHealth?.connectedPeers || 0}, bootstrapped: ${bridgeHealth?.hasBootstrapped})`);
    }
    
    // Also update peers map if exists
    const peer = this.peers.get(nodeId);
    if (peer) {
      peer.metadata = peer.metadata || {};
      peer.metadata.bridgeHealth = bridgeHealth;
    }
  }

  /**
   * Handle request for connected clients list
   * Used by bridge nodes for emergency recovery when they have 0 peers
   */
  async handleGetConnectedClients(ws, message) {
    const { requestId, bridgeNodeId, reason } = message;
    const nodeId = ws.nodeId || bridgeNodeId || 'unknown';
    
    console.log(`📋 Received get_connected_clients request from ${nodeId.substring(0, 8)}... (reason: ${reason})`);
    
    try {
      // Get all connected clients including healthy bridge nodes
      const connectedClients = [];
      for (const [clientNodeId, client] of this.connectedClients.entries()) {
        // Skip the requesting node
        if (clientNodeId === nodeId) continue;
        
        // Skip inactive connections
        if (client.ws?.readyState !== 1) continue; // 1 = OPEN
        
        const isBridgeNode = client.metadata?.isBridgeNode || client.metadata?.nodeType === 'bridge';
        
        // For bridge nodes, check if they're healthy (have peers)
        // Skip unhealthy bridge nodes (0 peers after bootstrapping)
        if (isBridgeNode) {
          const bridgeHealth = client.metadata?.bridgeHealth;
          const isHealthy = bridgeHealth?.isHealthy !== false; // Default to healthy if not reported
          const hasBootstrapped = bridgeHealth?.hasBootstrapped === true;
          
          // Skip bridge nodes that have bootstrapped but now have 0 peers (unhealthy)
          if (hasBootstrapped && !isHealthy) {
            console.log(`⏭️ Skipping unhealthy bridge node ${clientNodeId.substring(0, 8)}... (0 peers after bootstrap)`);
            continue;
          }
        }
        
        connectedClients.push({
          nodeId: clientNodeId,
          metadata: {
            nodeType: client.metadata?.nodeType || 'unknown',
            isBridgeNode: isBridgeNode,
            listeningAddress: client.metadata?.listeningAddress,
            publicWssAddress: client.metadata?.publicWssAddress,
            capabilities: client.metadata?.capabilities || [],
            bridgeHealth: isBridgeNode ? client.metadata?.bridgeHealth : undefined
          }
        });
      }
      
      console.log(`📤 Sending ${connectedClients.length} connected clients to ${nodeId.substring(0, 8)}...`);
      
      ws.send(JSON.stringify({
        type: 'connected_clients_response',
        requestId,
        success: true,
        clients: connectedClients,
        totalConnected: this.connectedClients.size,
        timestamp: Date.now()
      }));
      
    } catch (error) {
      console.error(`❌ Error handling get_connected_clients:`, error);
      ws.send(JSON.stringify({
        type: 'connected_clients_response',
        requestId,
        success: false,
        error: error.message
      }));
    }
  }

  // ============================================================================
  // Relay Message Handling for Symmetric NAT Relay System
  // ============================================================================

  /**
   * Setup RelayManager event handlers
   * RelayManager emits events when it needs to send messages to peers
   */
  setupRelayManagerEventHandlers() {
    // Handle relay acknowledgment - send ack to requesting peer
    this.relayManager.on('sendRelayAck', async ({ toPeerId, sessionId, success, error }) => {
      try {
        const ackMessage = createRelayAck(sessionId, success, error);
        const ws = this.getWebSocketForPeer(toPeerId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(ackMessage));
          console.log(`🔄 Sent relay ack to ${toPeerId.substring(0, 8)}... (success: ${success})`);
        } else {
          console.warn(`⚠️ Cannot send relay ack - peer ${toPeerId.substring(0, 8)}... not connected`);
        }
      } catch (err) {
        console.error(`❌ Failed to send relay ack to ${toPeerId.substring(0, 8)}...:`, err.message);
      }
    });

    // Handle relay request rejection - send rejection ack
    this.relayManager.on('relayRequestRejected', async ({ fromPeerId, sessionId, reason }) => {
      try {
        const ackMessage = createRelayAck(sessionId, false, reason);
        const ws = this.getWebSocketForPeer(fromPeerId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(ackMessage));
          console.log(`🔄 Sent relay rejection to ${fromPeerId.substring(0, 8)}... (reason: ${reason})`);
        }
      } catch (err) {
        console.error(`❌ Failed to send relay rejection to ${fromPeerId.substring(0, 8)}...:`, err.message);
      }
    });

    // Handle relay forward - forward message to target peer
    this.relayManager.on('forwardRelayMessage', async ({ toPeerId, message }) => {
      try {
        const ws = this.getWebSocketForPeer(toPeerId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(message));
          console.log(`🔄 Forwarded relay message to ${toPeerId.substring(0, 8)}... (session: ${message.sessionId?.substring(0, 8)}...)`);
        } else {
          console.warn(`⚠️ Cannot forward relay message - peer ${toPeerId.substring(0, 8)}... not connected`);
        }
      } catch (err) {
        console.error(`❌ Failed to forward relay message to ${toPeerId.substring(0, 8)}...:`, err.message);
      }
    });

    // Handle relay pong - send pong response
    this.relayManager.on('sendRelayPong', async ({ toPeerId, message }) => {
      try {
        const ws = this.getWebSocketForPeer(toPeerId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(message));
        }
      } catch (err) {
        console.error(`❌ Failed to send relay pong to ${toPeerId.substring(0, 8)}...:`, err.message);
      }
    });

    // Handle relay ping - send ping for health check
    this.relayManager.on('sendRelayPing', async ({ toPeerId, message }) => {
      try {
        const ws = this.getWebSocketForPeer(toPeerId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(message));
        }
      } catch (err) {
        console.error(`❌ Failed to send relay ping to ${toPeerId.substring(0, 8)}...:`, err.message);
      }
    });

    // Handle relay close - send close message
    this.relayManager.on('sendRelayClose', async ({ toPeerId, sessionId, reason }) => {
      try {
        const ws = this.getWebSocketForPeer(toPeerId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: RelayMessageType.CLOSE,
            sessionId,
            reason,
            timestamp: Date.now()
          }));
          console.log(`🔄 Sent relay close to ${toPeerId.substring(0, 8)}... (session: ${sessionId.substring(0, 8)}...)`);
        }
      } catch (err) {
        console.error(`❌ Failed to send relay close to ${toPeerId.substring(0, 8)}...:`, err.message);
      }
    });

    // Handle relay request (for failover) - send request to new relay
    this.relayManager.on('sendRelayRequest', async ({ toPeerId, message }) => {
      try {
        const ws = this.getWebSocketForPeer(toPeerId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(message));
          console.log(`🔄 Sent relay request to ${toPeerId.substring(0, 8)}...`);
        }
      } catch (err) {
        console.error(`❌ Failed to send relay request to ${toPeerId.substring(0, 8)}...:`, err.message);
      }
    });

    // Handle relay forward (outgoing) - send forward message through relay
    this.relayManager.on('sendRelayForward', async ({ toPeerId, message }) => {
      try {
        const ws = this.getWebSocketForPeer(toPeerId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(message));
        }
      } catch (err) {
        console.error(`❌ Failed to send relay forward to ${toPeerId.substring(0, 8)}...:`, err.message);
      }
    });

    // Log relay session events for monitoring
    this.relayManager.on('relaySessionEstablished', ({ session }) => {
      console.log(`✅ Relay session established: ${session.fromPeerId.substring(0, 8)}... ↔ ${session.toPeerId.substring(0, 8)}... (session: ${session.sessionId.substring(0, 8)}...)`);
      // Update relay load in server metadata
      this.serverMetadata.relayLoad = this.relayManager.getRelayLoad();
    });

    this.relayManager.on('sessionClosed', ({ session, reason }) => {
      console.log(`🔄 Relay session closed: ${session.sessionId.substring(0, 8)}... (reason: ${reason})`);
      // Update relay load in server metadata
      this.serverMetadata.relayLoad = this.relayManager.getRelayLoad();
    });

    console.log(`✅ RelayManager event handlers set up successfully`);
  }

  /**
   * Handle incoming relay messages from clients
   * Routes messages to the appropriate RelayManager handler
   * @param {string} peerId - Peer that sent the message
   * @param {Object} message - Relay protocol message
   * @param {WebSocket} ws - WebSocket connection that received the message
   */
  handleRelayMessage(peerId, message, ws) {
    switch (message.type) {
      case RelayMessageType.REQUEST:
        // Browser requesting relay session through this bootstrap server
        this.relayManager.handleRelayRequest(peerId, message);
        break;

      case RelayMessageType.FORWARD:
        // Forward message to target peer
        this.relayManager.handleRelayForward(peerId, message);
        break;

      case RelayMessageType.ACK:
        // Relay acknowledgment (when this node requested a relay)
        this.relayManager.handleRelayAck(peerId, message);
        break;

      case RelayMessageType.CLOSE:
        // Relay session close request
        this.relayManager.handleRelayClose(peerId, message);
        break;

      case RelayMessageType.PING:
        // Health check ping
        this.relayManager.handleRelayPing(peerId, message);
        break;

      case RelayMessageType.PONG:
        // Health check pong response
        this.relayManager.handleRelayPong(peerId, message);
        break;

      default:
        console.warn(`⚠️ Unknown relay message type: ${message.type} from ${peerId.substring(0, 8)}...`);
    }
  }

  /**
   * Get WebSocket connection for a peer
   * Looks up the peer in connectedClients or peers maps
   * @param {string} peerId - Peer ID to look up
   * @returns {WebSocket|null} WebSocket connection or null if not found
   */
  getWebSocketForPeer(peerId) {
    // First check connectedClients (primary source)
    const client = this.connectedClients.get(peerId);
    if (client && client.ws && client.ws.readyState === WebSocket.OPEN) {
      return client.ws;
    }

    // Fall back to peers map
    const peer = this.peers.get(peerId);
    if (peer && peer.ws && peer.ws.readyState === WebSocket.OPEN) {
      return peer.ws;
    }

    return null;
  }

  /**
   * Check if a peer is connected to this bootstrap server
   * Used by RelayManager to verify peer connectivity
   * @param {string} peerId - Peer ID to check
   * @returns {boolean} True if peer is connected
   */
  isPeerConnected(peerId) {
    return this.getWebSocketForPeer(peerId) !== null;
  }
}