import { EventEmitter } from 'events';
import { WebSocket, WebSocketServer } from 'ws';
import crypto from 'crypto';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PROTOCOL_VERSION, BUILD_ID, checkVersionCompatibility } from '../version.js';

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

    // Bridge node management (stateless)
    this.pendingInvitations = new Map(); // invitationId -> { inviterNodeId, inviteeNodeId, inviterWs, inviteeWs, status, timestamp }

    // Authentication management
    this.authChallenges = new Map(); // nodeId -> { nonce, timestamp, publicKey, ws }

    // Server state
    this.isStarted = false;
    this.totalConnections = 0;
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
        res.end('Not Found\n\nAvailable endpoints:\n  /           - Installation info\n  /install.sh - Linux/Mac installer\n  /install.ps1 - Windows installer\n  /health     - Health check\n  /stats      - Server statistics');
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

    // Close all client connections
    for (const [nodeId, peer] of this.peers) {
      if (peer.ws && peer.ws.readyState === WebSocket.OPEN) {
        peer.ws.close(1000, 'Server shutdown');
      }
    }
    this.peers.clear();

    // No persistent bridge connections to clean up

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
   * Test bridge node availability (stateless)
   * FIXED: No persistent connections - just test reachability
   */
  async testBridgeAvailability() {
    console.log(`🌉 Testing availability of ${this.options.bridgeNodes.length} bridge nodes`);

    const availabilityPromises = this.options.bridgeNodes.map(bridgeAddr =>
      this.testSingleBridge(bridgeAddr)
    );

    const results = await Promise.allSettled(availabilityPromises);
    const availableBridges = results.filter(r => r.status === 'fulfilled').length;

    if (availableBridges === 0) {
      console.warn('⚠️ No bridge nodes available - reconnection services unavailable');
    } else {
      console.log(`✅ ${availableBridges}/${this.options.bridgeNodes.length} bridge nodes available`);
    }

    return availableBridges;
  }

  /**
   * Test a single bridge node availability (stateless)
   * FIXED: Use proper authentication for availability test
   */
  async testSingleBridge(bridgeAddr) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Bridge availability test timeout: ${bridgeAddr}`));
      }, 5000);

      try {
        const ws = new WebSocket(`ws://${bridgeAddr}`);
        let authenticated = false;

        ws.onopen = () => {
          // Send bootstrap authentication (required for bridge nodes)
          ws.send(JSON.stringify({
            type: 'bootstrap_auth',
            auth_token: this.options.bridgeAuth,
            bootstrapServer: `${this.options.host}:${this.options.port}`
          }));
        };

        ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            
            if (message.type === 'auth_success' && !authenticated) {
              authenticated = true;
              // Bridge is available and authenticated successfully
              clearTimeout(timeout);
              ws.close(1000, 'Availability test complete');
              resolve(bridgeAddr);
            }
          } catch (error) {
            clearTimeout(timeout);
            ws.close(1000, 'Parse error');
            reject(new Error(`Bridge response parse error: ${bridgeAddr}`));
          }
        };

        ws.onerror = (error) => {
          clearTimeout(timeout);
          reject(new Error(`Bridge unavailable: ${bridgeAddr}`));
        };

        ws.onclose = () => {
          // Connection closed - this is expected after successful test
        };

      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  /**
   * Request onboarding peer from bridge (stateless)
   * FIXED: Connect, request, get response, disconnect
   */
  async requestOnboardingPeerFromBridge(nodeId, metadata) {
    console.log(`🎲 Requesting onboarding peer for ${nodeId.substring(0, 8)}... from bridge nodes`);

    // Try each bridge node until one responds
    for (const bridgeAddr of this.options.bridgeNodes) {
      try {
        const result = await this.queryBridgeForOnboardingPeer(bridgeAddr, nodeId, metadata);
        if (result) {
          console.log(`✅ Got onboarding peer from bridge ${bridgeAddr}`);
          return result;
        }
      } catch (error) {
        console.warn(`❌ Bridge ${bridgeAddr} failed: ${error.message}`);
        continue; // Try next bridge
      }
    }

    throw new Error('No bridge nodes available for onboarding coordination');
  }

  /**
   * Query a single bridge for onboarding peer (stateless)
   */
  async queryBridgeForOnboardingPeer(bridgeAddr, nodeId, metadata) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Bridge query timeout: ${bridgeAddr}`));
      }, 10000);

      try {
        const ws = new WebSocket(`ws://${bridgeAddr}`);
        let authenticated = false;

        ws.onopen = () => {
          // Authenticate first
          ws.send(JSON.stringify({
            type: 'bootstrap_auth',
            auth_token: this.options.bridgeAuth,
            bootstrapServer: `${this.options.host}:${this.options.port}`
          }));
        };

        ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);

            if (message.type === 'auth_success' && !authenticated) {
              authenticated = true;
              // Now request onboarding peer
              ws.send(JSON.stringify({
                type: 'get_onboarding_peer',
                newNodeId: nodeId,
                newNodeMetadata: metadata,
                requestId: `onboarding_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
              }));
            } else if (message.type === 'onboarding_peer_response') {
              clearTimeout(timeout);
              ws.close(1000, 'Request complete');
              resolve(message.data);
            } else if (message.type === 'error') {
              clearTimeout(timeout);
              ws.close(1000, 'Request failed');
              reject(new Error(message.message || 'Bridge request failed'));
            }
          } catch (error) {
            clearTimeout(timeout);
            ws.close(1000, 'Parse error');
            reject(error);
          }
        };

        ws.onerror = (error) => {
          clearTimeout(timeout);
          reject(new Error(`Bridge connection failed: ${bridgeAddr}`));
        };

        ws.onclose = () => {
          // Connection closed - this is expected after request
        };

      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
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
   * Check bridge availability (stateless)
   * FIXED: No persistent connections - test availability on demand
   */
  async checkBridgeAvailability() {
    console.log(`🏥 Testing bridge availability (${this.options.bridgeNodes.length} bridges)...`);

    const availabilityPromises = this.options.bridgeNodes.map(async (bridgeAddr) => {
      try {
        await this.testSingleBridge(bridgeAddr);
        return { address: bridgeAddr, available: true };
      } catch (error) {
        return { address: bridgeAddr, available: false, error: error.message };
      }
    });

    const results = await Promise.allSettled(availabilityPromises);
    const availableCount = results.filter(r => r.status === 'fulfilled' && r.value.available).length;
    const unavailableCount = this.options.bridgeNodes.length - availableCount;

    console.log(`🏥 Bridge availability: ${availableCount} available, ${unavailableCount} unavailable`);

    return {
      available: availableCount,
      unavailable: unavailableCount,
      total: this.options.bridgeNodes.length,
      results: results.map(r => r.status === 'fulfilled' ? r.value : { available: false, error: 'Promise rejected' })
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
      const existingPeer = this.peers.get(nodeId);

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
              bridgeNodePeers.push({
                nodeId: `bridge_${bridgeAddr.replace(':', '_')}`, // Temporary ID - will fail!
                metadata: {
                  isBridgeNode: true,
                  nodeType: 'bridge',
                  websocketAddress: `ws://${bridgeAddr}`,
                  listeningAddress: `ws://${bridgeAddr}`,
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
                // Genesis can operate independently - bridge coordination is optional
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
      if (this.options.createNewDHT && isBridgeNode) {
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
          
          // Use connected bridge nodes for onboarding coordination
          await this.getOnboardingPeerFromBridge(ws, nodeId, message.metadata || {}, message);
          
          // getOnboardingPeerFromBridge handles the response internally, so we're done
          return;
        } catch (error) {
          console.error(`❌ Failed to get onboarding peer from bridge: ${error.message}`);
          
          // Fallback to async coordination if synchronous fails
          console.log(`📤 Falling back to async onboarding coordination...`);
          sendResponse({
            type: 'response',
            requestId: message.requestId,
            success: true,
            data: {
              peers: [],
              isGenesis: false,
              status: 'helper_coordinating',
              message: `Onboarding peer lookup failed, retrying: ${error.message}`
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
    // FIXED: Use stateless bridge request for reconnection validation
    // Bridge availability will be tested during the actual request

    // Store reconnecting peer
    this.peers.set(nodeId, {
      ws,
      lastSeen: Date.now(),
      metadata: metadata || {},
      isGenesisPeer: false,
      type: 'reconnecting',
      membershipToken
    });

    // Generate unique request ID
    const requestId = `reconnect_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Store pending reconnection
    const reconnectionPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingReconnections.delete(requestId);
        reject(new Error('Bridge validation timeout'));
      }, this.options.bridgeTimeout);

      this.pendingReconnections.set(requestId, {
        ws,
        nodeId,
        resolve,
        reject,
        timeout
      });
    });

    // Get available bridge connection
    const bridgeClients = Array.from(this.peers.values()).filter(peer => peer.isBridgeNode);
    if (bridgeClients.length === 0) {
      throw new Error('No bridge nodes available for reconnection validation');
    }

    const bridgeWs = bridgeClients[0].ws; // Use first bridge node

    // Send validation request to bridge
    bridgeWs.send(JSON.stringify({
      type: 'validate_reconnection',
      nodeId,
      membershipToken,
      requestId,
      timestamp: Date.now()
    }));

    console.log(`📤 Sent reconnection validation to bridge for ${nodeId.substring(0, 8)}...`);

    // Wait for bridge response
    try {
      await reconnectionPromise;
    } catch (error) {
      console.warn(`Bridge validation failed for ${nodeId.substring(0, 8)}: ${error.message}`);
      ws.send(JSON.stringify({
        type: 'reconnection_result',
        success: false,
        reason: error.message
      }));
      ws.close(1000, 'Validation failed');
      this.peers.delete(nodeId);
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
   * Handle response from bridge node
   */
  handleBridgeResponse(bridgeAddr, response) {
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
   * Handle client disconnection
   */
  handleClientDisconnection(ws) {
    // Find and remove the peer
    for (const [nodeId, peer] of this.peers) {
      if (peer.ws === ws) {
        console.log(`🔌 Peer disconnected: ${nodeId.substring(0, 8)}...`);
        this.peers.delete(nodeId);
        break;
      }
    }
  }

  /**
   * Start maintenance tasks
   */
  startMaintenanceTasks() {
    // Clean up stale peers every minute
    setInterval(() => {
      this.cleanupStalePeers();
    }, 60000);

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

    return {
      isStarted: this.isStarted,
      totalPeers: this.peers.size,
      maxPeers: this.options.maxPeers,
      totalConnections: this.totalConnections,
      bridgeNodes: bridgeStats,
      createNewDHT: this.options.createNewDHT,
      pendingReconnections: this.pendingReconnections.size
    };
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
}