#!/usr/bin/env node

/**
 * YZ Network - Community Node Installer
 *
 * Installs and configures Docker nodes for users to contribute to network stability.
 * Features:
 * - Automatic Docker installation check
 * - UPnP port forwarding configuration
 * - External IP detection
 * - Resource usage estimation
 * - User-configurable node count
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import readline from 'readline';
import os from 'os';
import { UPnPHelper, detectExternalIP } from './upnp-helper.js';

// ANSI color codes for pretty output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m'
};

class NodeInstaller {
  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    this.config = {
      nodeCount: 1,
      basePort: 8100,
      bootstrapUrl: 'ws://bootstrap.yz.network:8080', // Default public bootstrap
      externalIP: null,
      upnpEnabled: true,
      includeDashboard: false // Optional monitoring dashboard
    };

    // Resource estimates per node (from docker-compose.nodes.yml)
    this.resourcesPerNode = {
      cpuCores: 0.15,
      memoryMB: 128,
      diskMB: 50
    };

    // UPnP helper for port forwarding
    this.upnp = new UPnPHelper();
  }

  // Colored logging
  log(message, color = 'reset') {
    console.log(`${colors[color]}${message}${colors.reset}`);
  }

  logSection(title) {
    console.log('\n' + '='.repeat(60));
    this.log(title, 'bright');
    console.log('='.repeat(60));
  }

  // Promisified readline question
  question(query) {
    return new Promise((resolve) => {
      if (this.rl.closed) {
        // Readline is closed, return empty string as default
        resolve('');
        return;
      }

      try {
        this.rl.question(query, resolve);
      } catch (error) {
        // If question fails, return empty string
        resolve('');
      }
    });
  }

  // Execute shell command
  async exec(command, args = []) {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, { shell: true });
      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', data => stdout += data.toString());
      proc.stderr?.on('data', data => stderr += data.toString());

      proc.on('close', code => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`Command failed: ${stderr || stdout}`));
        }
      });
    });
  }

  // Check if Docker is installed
  async checkDocker() {
    this.logSection('🐳 Checking Docker Installation');

    try {
      const version = await this.exec('docker', ['--version']);
      this.log(`✅ Docker found: ${version}`, 'green');

      // Check if Docker daemon is running
      try {
        await this.exec('docker', ['ps']);
        this.log('✅ Docker daemon is running', 'green');
        return true;
      } catch (error) {
        this.log('❌ Docker daemon is not running. Please start Docker.', 'red');
        return false;
      }
    } catch (error) {
      this.log('❌ Docker not found', 'red');
      this.log('\nPlease install Docker Desktop:', 'yellow');
      this.log('  Windows/Mac: https://www.docker.com/products/docker-desktop', 'cyan');
      this.log('  Linux: https://docs.docker.com/engine/install/', 'cyan');
      return false;
    }
  }

  // Detect external IP address
  async detectExternalIP() {
    this.logSection('🌐 Detecting External IP Address');

    try {
      // Try UPnP first (most reliable for home networks)
      if (this.upnp.isAvailable()) {
        const upnpIP = await this.upnp.getExternalIP();
        if (upnpIP) {
          this.config.externalIP = upnpIP;
          this.log(`✅ External IP detected via UPnP: ${upnpIP}`, 'green');
          return upnpIP;
        }
      }

      // Fallback to web services
      const ip = await detectExternalIP();
      this.config.externalIP = ip;
      this.log(`✅ External IP detected: ${ip}`, 'green');
      return ip;

    } catch (error) {
      this.log(`⚠️  Could not auto-detect external IP: ${error.message}`, 'yellow');

      const manualIP = await this.question('Please enter your external IP address (or press Enter to skip): ');
      if (manualIP.trim()) {
        this.config.externalIP = manualIP.trim();
        this.log(`✅ Using manual IP: ${this.config.externalIP}`, 'green');
      } else {
        this.log('⚠️  Continuing without external IP (nodes will only work on local network)', 'yellow');
      }
    }
  }

  // Configure UPnP port forwarding
  async configureUPnP() {
    this.logSection('🔌 UPnP Port Forwarding');

    this.log('UPnP will automatically configure your router to forward ports.', 'cyan');
    this.log('This allows external nodes to connect to your contribution nodes.\n', 'cyan');

    // Check if readline is still open
    if (this.rl.closed) {
      this.log('⚠️  Input interface closed, defaulting to UPnP enabled', 'yellow');
      this.config.upnpEnabled = true;
      this.log('✅ UPnP will be enabled', 'green');
      this.log('   Ports will be configured when nodes start', 'cyan');
      return;
    }

    const enableUPnP = await this.question('Enable automatic UPnP port forwarding? (Y/n): ');
    this.config.upnpEnabled = !enableUPnP.toLowerCase().startsWith('n');

    if (this.config.upnpEnabled) {
      this.log('✅ UPnP will be enabled', 'green');
      this.log('   Ports will be configured when nodes start', 'cyan');
    } else {
      this.log('⚠️  UPnP disabled - you will need to manually configure port forwarding:', 'yellow');
      this.log(`   Forward ports ${this.config.basePort}-${this.config.basePort + this.config.nodeCount - 1} to this machine`, 'cyan');
    }
  }

  // Get node count from user
  async getNodeCount() {
    this.logSection('🔢 Node Configuration');

    // Show system resources
    const totalCPUs = os.cpus().length;
    const totalMemoryGB = (os.totalmem() / (1024 ** 3)).toFixed(1);
    const freeMemoryGB = (os.freemem() / (1024 ** 3)).toFixed(1);

    this.log(`Your System:`, 'cyan');
    this.log(`  CPU Cores: ${totalCPUs}`);
    this.log(`  Total Memory: ${totalMemoryGB} GB`);
    this.log(`  Available Memory: ${freeMemoryGB} GB\n`);

    // Show resource estimates for different node counts
    this.log('Resource Usage Estimates:', 'bright');
    console.log('┌─────────┬──────────────┬───────────┬────────────┐');
    console.log('│ Nodes   │ CPU Cores    │ Memory    │ Disk Space │');
    console.log('├─────────┼──────────────┼───────────┼────────────┤');

    for (let nodes of [1, 3, 5, 10]) {
      const cpu = (nodes * this.resourcesPerNode.cpuCores).toFixed(2);
      const mem = (nodes * this.resourcesPerNode.memoryMB / 1024).toFixed(2);
      const disk = (nodes * this.resourcesPerNode.diskMB / 1024).toFixed(2);
      console.log(`│ ${nodes.toString().padEnd(7)} │ ${cpu.padEnd(12)} │ ${mem.padEnd(7)} GB │ ${disk.padEnd(8)} GB │`);
    }
    console.log('└─────────┴──────────────┴───────────┴────────────┘\n');

    // Get user input
    const maxRecommended = Math.min(
      Math.floor(totalCPUs / this.resourcesPerNode.cpuCores),
      Math.floor((os.freemem() / (1024 ** 2)) / this.resourcesPerNode.memoryMB)
    );

    this.log(`Recommended maximum for your system: ${maxRecommended} nodes`, 'yellow');

    // If readline is closed, use default
    if (this.rl.closed) {
      const defaultNodes = Math.min(3, maxRecommended);
      this.log(`\n⚠️  Using default: ${defaultNodes} nodes (interactive input not available)`, 'yellow');
      this.config.nodeCount = defaultNodes;
      const finalCPU = (defaultNodes * this.resourcesPerNode.cpuCores).toFixed(2);
      const finalMem = (defaultNodes * this.resourcesPerNode.memoryMB / 1024).toFixed(2);
      const finalDisk = (defaultNodes * this.resourcesPerNode.diskMB / 1024).toFixed(2);

      this.log(`\n✅ Configuration:`, 'green');
      this.log(`   Nodes: ${defaultNodes}`);
      this.log(`   Total CPU: ${finalCPU} cores`);
      this.log(`   Total Memory: ${finalMem} GB`);
      this.log(`   Total Disk: ${finalDisk} GB`);
      return;
    }

    let nodeCount;
    while (true) {
      const input = await this.question(`\nHow many nodes would you like to run? (1-${maxRecommended}): `);

      // If input is empty and readline is closed, use default
      if (!input && this.rl.closed) {
        nodeCount = Math.min(3, maxRecommended);
        this.log(`\nUsing default: ${nodeCount} nodes`, 'yellow');
        break;
      }

      nodeCount = parseInt(input);

      if (isNaN(nodeCount) || nodeCount < 1) {
        this.log('Please enter a number greater than 0', 'red');
        continue;
      }

      if (nodeCount > maxRecommended) {
        this.log(`⚠️  Warning: ${nodeCount} nodes may strain your system`, 'yellow');
        const confirm = await this.question('Continue anyway? (y/N): ');
        if (!confirm.toLowerCase().startsWith('y')) {
          continue;
        }
      }

      break;
    }

    this.config.nodeCount = nodeCount;

    // Show final resource usage
    const finalCPU = (nodeCount * this.resourcesPerNode.cpuCores).toFixed(2);
    const finalMem = (nodeCount * this.resourcesPerNode.memoryMB / 1024).toFixed(2);
    const finalDisk = (nodeCount * this.resourcesPerNode.diskMB / 1024).toFixed(2);

    this.log(`\n✅ You will donate:`, 'green');
    this.log(`   ${finalCPU} CPU cores`);
    this.log(`   ${finalMem} GB memory`);
    this.log(`   ${finalDisk} GB disk space`);
    this.log(`   Nodes: ${nodeCount}`, 'bright');
  }

  // Configure bootstrap server
  async configureBootstrap() {
    this.logSection('🌉 Bootstrap Server Configuration');

    this.log(`Default bootstrap server: ${this.config.bootstrapUrl}`, 'cyan');

    // If readline is closed, use default
    if (this.rl.closed) {
      this.log('✅ Using default bootstrap server', 'green');
      return;
    }

    const useCustom = await this.question('Use a different bootstrap server? (y/N): ');

    if (useCustom.toLowerCase().startsWith('y')) {
      const customUrl = await this.question('Enter bootstrap WebSocket URL (ws://host:port): ');
      if (customUrl.trim()) {
        this.config.bootstrapUrl = customUrl.trim();
        this.log(`✅ Using custom bootstrap: ${this.config.bootstrapUrl}`, 'green');
      }
    } else {
      this.log('✅ Using default bootstrap server', 'green');
    }
  }

  // Configure optional dashboard
  async configureDashboard() {
    this.logSection('📊 Monitoring Dashboard (Optional)');

    this.log('The dashboard provides a web UI to monitor your nodes:', 'cyan');
    this.log('  • Real-time connection status', 'cyan');
    this.log('  • DHT operations metrics', 'cyan');
    this.log('  • Resource usage graphs', 'cyan');
    this.log('  • Health status for each node\n', 'cyan');

    this.log('⚠️  Dashboard adds ~50MB RAM and 0.1 CPU cores', 'yellow');
    this.log('   Only monitors nodes on THIS computer\n', 'yellow');

    // If readline is closed, default to no dashboard (lean setup)
    if (this.rl.closed) {
      this.config.includeDashboard = false;
      this.log('✅ Dashboard disabled - running lean', 'green');
      return;
    }

    const includeDashboard = await this.question('Include monitoring dashboard? (y/N): ');
    this.config.includeDashboard = includeDashboard.toLowerCase().startsWith('y');

    if (this.config.includeDashboard) {
      this.log('✅ Dashboard will be available at http://localhost:3001', 'green');
    } else {
      this.log('✅ Dashboard disabled - running lean', 'green');
    }
  }

  // Generate docker-compose.yml with specified number of nodes
  async generateDockerCompose() {
    this.logSection('📝 Generating Docker Configuration');

    const services = {};
    const ports = [];

    // Generate service definition for each node
    for (let i = 1; i <= this.config.nodeCount; i++) {
      const nodePort = this.config.basePort + i - 1;
      const metricsPort = 9090 + i - 1;
      ports.push(nodePort);

      const publicAddress = this.config.externalIP
        ? `ws://${this.config.externalIP}:${nodePort}`
        : `ws://localhost:${nodePort}`;

      services[`dht-node-${i}`] = {
        build: {
          context: '.',
          dockerfile: 'Dockerfile'
        },
        container_name: `yz-community-node-${i}`,
        command: 'node src/docker/start-dht-node.js',
        ports: [
          `${nodePort}:${nodePort}`,
          `${metricsPort}:9090`
        ],
        environment: [
          `BOOTSTRAP_URL=${this.config.bootstrapUrl}`,
          'OPEN_NETWORK=true',
          `WEBSOCKET_PORT=${nodePort}`,
          `PUBLIC_ADDRESS=${publicAddress}`,
          `METRICS_PORT=9090`,
          `NODE_NAME=community-node-${i}`,
          `UPNP_ENABLED=${this.config.upnpEnabled}`
        ],
        networks: ['dht-network'],
        restart: 'unless-stopped',
        deploy: {
          resources: {
            limits: {
              cpus: this.resourcesPerNode.cpuCores.toString(),
              memory: `${this.resourcesPerNode.memoryMB}M`
            },
            reservations: {
              cpus: (this.resourcesPerNode.cpuCores / 2).toString(),
              memory: `${Math.floor(this.resourcesPerNode.memoryMB / 2)}M`
            }
          }
        },
        healthcheck: {
          test: ['CMD', 'wget', '--spider', '-q', 'http://localhost:9090/health'],
          interval: '30s',
          timeout: '10s',
          retries: 3,
          start_period: '60s'
        }
      };
    }

    // Add optional dashboard service
    if (this.config.includeDashboard) {
      services['dashboard'] = {
        build: {
          context: '.',
          dockerfile: 'Dockerfile.dashboard'
        },
        container_name: 'yz-community-dashboard',
        ports: ['3001:3000'],
        environment: [
          'METRICS_SCRAPE_INTERVAL=10000'
        ],
        volumes: [
          '/var/run/docker.sock:/var/run/docker.sock:ro'
        ],
        networks: ['dht-network'],
        restart: 'unless-stopped',
        healthcheck: {
          test: ['CMD', 'wget', '--spider', '-q', 'http://localhost:3000/health'],
          interval: '30s',
          timeout: '10s',
          retries: 3
        }
      };
    }

    const composeConfig = {
      version: '3.8',
      services,
      networks: {
        'dht-network': {
          driver: 'bridge'
        }
      }
    };

    // Write docker-compose file
    const composeYaml = this.objectToYaml(composeConfig);
    const outputPath = path.join(process.cwd(), 'docker-compose.community.yml');
    await fs.writeFile(outputPath, composeYaml);

    this.log(`✅ Generated: ${outputPath}`, 'green');
    this.log(`   ${this.config.nodeCount} node(s) configured`, 'cyan');
    this.log(`   Ports: ${ports.join(', ')}`, 'cyan');
    if (this.config.includeDashboard) {
      this.log(`   Dashboard: http://localhost:3001`, 'cyan');
    }

    return outputPath;
  }

  // Simple YAML generator (basic implementation)
  objectToYaml(obj, indent = 0) {
    const spaces = '  '.repeat(indent);
    let yaml = '';

    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined) continue;

      if (Array.isArray(value)) {
        yaml += `${spaces}${key}:\n`;
        for (const item of value) {
          if (typeof item === 'object') {
            yaml += `${spaces}  -\n${this.objectToYaml(item, indent + 2)}`;
          } else {
            yaml += `${spaces}  - ${item}\n`;
          }
        }
      } else if (typeof value === 'object') {
        yaml += `${spaces}${key}:\n${this.objectToYaml(value, indent + 1)}`;
      } else {
        yaml += `${spaces}${key}: ${value}\n`;
      }
    }

    return yaml;
  }

  // Start the nodes
  async startNodes(composePath) {
    this.logSection('🚀 Starting Community Nodes');

    const startNow = await this.question('Start nodes now? (Y/n): ');

    if (startNow.toLowerCase().startsWith('n')) {
      this.log('\nNodes not started. To start manually:', 'yellow');
      this.log(`  docker-compose -f ${path.basename(composePath)} up -d`, 'cyan');
      return;
    }

    try {
      // Open UPnP ports if enabled
      if (this.config.upnpEnabled && this.upnp.isAvailable()) {
        this.log('\n🔌 Opening ports via UPnP...', 'cyan');
        for (let i = 0; i < this.config.nodeCount; i++) {
          const port = this.config.basePort + i;
          await this.upnp.openPort(port, `YZ Network Community Node ${i + 1}`);
        }
      }

      this.log('\nStarting Docker containers...', 'cyan');
      await this.exec('docker-compose', ['-f', composePath, 'up', '-d']);

      this.log('\n✅ Community nodes started successfully!', 'green');
      this.log('\nNode Status:', 'bright');

      // Show status
      const status = await this.exec('docker-compose', ['-f', composePath, 'ps']);
      console.log(status);

    } catch (error) {
      this.log(`\n❌ Failed to start nodes: ${error.message}`, 'red');
      this.log('\nTry starting manually:', 'yellow');
      this.log(`  docker-compose -f ${path.basename(composePath)} up -d`, 'cyan');
    }
  }

  // Show final summary and instructions
  showSummary() {
    this.logSection('🎉 Installation Complete!');

    this.log('Your contribution:', 'bright');
    this.log(`  Nodes: ${this.config.nodeCount}`);
    this.log(`  CPU: ${(this.config.nodeCount * this.resourcesPerNode.cpuCores).toFixed(2)} cores`);
    this.log(`  Memory: ${(this.config.nodeCount * this.resourcesPerNode.memoryMB / 1024).toFixed(2)} GB`);
    if (this.config.externalIP) {
      this.log(`  Public IP: ${this.config.externalIP}`);
    }
    if (this.config.includeDashboard) {
      this.log(`  Dashboard: http://localhost:3001`, 'cyan');
    }

    this.log('\nUseful Commands:', 'bright');
    this.log('  View logs:    docker-compose -f docker-compose.community.yml logs -f', 'cyan');
    this.log('  Stop nodes:   docker-compose -f docker-compose.community.yml stop', 'cyan');
    this.log('  Start nodes:  docker-compose -f docker-compose.community.yml start', 'cyan');
    this.log('  Remove nodes: docker-compose -f docker-compose.community.yml down', 'cyan');
    if (this.config.includeDashboard) {
      this.log('\nMonitoring:', 'bright');
      this.log('  Open dashboard: http://localhost:3001', 'cyan');
      this.log('  (Dashboard only shows nodes on this computer)', 'yellow');
    }

    this.log('\nThank you for contributing to the YZ Network! 🙏', 'green');
  }

  // Main installation flow
  async install() {
    console.clear();
    this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'cyan');
    this.log('          YZ Network - Community Node Installer', 'bright');
    this.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'cyan');
    this.log('\nHelp strengthen the network by running DHT nodes!', 'cyan');
    this.log('Your nodes will help provide stability and connectivity.\n', 'cyan');

    try {
      // Step 1: Check Docker
      const dockerOk = await this.checkDocker();
      if (!dockerOk) {
        process.exit(1);
      }

      // Step 2: Detect external IP
      await this.detectExternalIP();

      // Step 3: Configure UPnP
      await this.configureUPnP();

      // Step 4: Get node count
      await this.getNodeCount();

      // Step 5: Configure bootstrap
      await this.configureBootstrap();

      // Step 6: Configure optional dashboard
      await this.configureDashboard();

      // Step 7: Generate docker-compose
      const composePath = await this.generateDockerCompose();

      // Step 7: Start nodes
      await this.startNodes(composePath);

      // Step 8: Show summary
      this.showSummary();

    } catch (error) {
      this.log(`\n❌ Installation failed: ${error.message}`, 'red');
      console.error(error);
      process.exit(1);
    } finally {
      this.rl.close();
    }
  }
}

// Run installer
const installer = new NodeInstaller();
installer.install().catch(console.error);
