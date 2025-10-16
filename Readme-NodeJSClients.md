# Node.js DHT Clients Deployment Guide

Node.js clients can participate in the YZSocialC DHT network as full peers, connecting to both browser clients and other Node.js clients. They're ideal for server-side applications, automated services, and always-on network participants.

## Overview

Node.js clients can:
- **Connect to bridge nodes** via WebSocket
- **Connect to other Node.js clients** via WebSocket
- **Connect to browser clients** by acting as WebSocket servers
- **Participate in DHT operations** (store, retrieve, routing)
- **Run automated services** (data sync, network monitoring)
- **Provide stable network infrastructure** when kept online

## Quick Start

```bash
# Install dependencies
npm install

# Start a Node.js DHT client
node examples/nodejs-client.js

# Or create your own client
node -e "
const YZSocialC = require('./src/index.js');
const client = new YZSocialC();
client.startDHT().then(() => console.log('DHT started'));
"
```

## Basic Node.js Client

```javascript
// examples/nodejs-client.js
const YZSocialC = require('../src/index.js');

async function startNodeClient() {
  const client = new YZSocialC({
    // Node.js clients can act as WebSocket servers
    enableWebSocketServer: true,
    webSocketPort: 9000,
    
    // Connect to bridge nodes for network access
    bootstrapServers: ['ws://localhost:8080'],
    
    // DHT options
    k: 20,
    alpha: 3
  });

  try {
    // Start DHT
    await client.startDHT();
    console.log('✅ Node.js DHT client started');
    console.log('Node ID:', client.getNodeId());
    console.log('WebSocket server listening on port 9000');
    
    // Example DHT operations
    await client.store('test-key', 'Hello from Node.js!');
    const value = await client.get('test-key');
    console.log('Retrieved value:', value);
    
    // Monitor network
    setInterval(() => {
      const stats = client.getStats();
      console.log(`Connected peers: ${stats.connections.total}, Routing table: ${stats.routingTable.size}`);
    }, 30000);
    
  } catch (error) {
    console.error('Failed to start DHT client:', error);
  }
}

startNodeClient();
```

## Production Deployment

### Server Setup

#### AWS EC2 / DigitalOcean

```bash
# Launch Ubuntu 22.04 instance
# Recommended: t3.micro or larger (1GB+ RAM)

# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PM2
sudo npm install -g pm2

# Clone and setup
git clone https://github.com/your-repo/yz.network.git
cd yz.network
npm install
```

#### Configuration

```javascript
// config/production.js
module.exports = {
  dht: {
    bootstrapServers: [
      'ws://your-bridge-server.com:8080'
    ],
    enableWebSocketServer: true,
    webSocketPort: process.env.WS_PORT || 9000,
    k: 20,
    alpha: 3,
    maxConnections: 100
  },
  logging: {
    level: 'info',
    file: '/var/log/yzsocialc/client.log'
  }
};
```

#### Process Management

```bash
# Create PM2 ecosystem file
cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'yzsocialc-client',
    script: 'examples/nodejs-client.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      WS_PORT: 9000
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true
  }]
};
EOF

# Start with PM2
pm2 start ecosystem.config.js

# Setup auto-start
pm2 startup
pm2 save
```

### Prevent System Sleep (Critical for Always-On Clients)

Node.js clients providing network services should prevent system sleep to maintain DHT connectivity.

#### Windows (Run as Administrator)

```powershell
# Disable sleep permanently for servers
powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0
powercfg /change hibernate-timeout-ac 0
powercfg /change hibernate-timeout-dc 0

# Alternative: Keep system awake while process runs
# Use PowerShell to prevent sleep programmatically
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::SetSuspendState("Standby", $false, $false)

# Or use command line tool
powercfg /requests  # Show what's preventing sleep
```

#### macOS

```bash
# Prevent sleep while process runs
caffeinate -s node examples/nodejs-client.js

# Or prevent sleep system-wide
sudo pmset -c sleep 0

# Create launch daemon for permanent prevention
sudo nano /Library/LaunchDaemons/com.yzsocialc.nosleep.plist
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.yzsocialc.nosleep</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/caffeinate</string>
        <string>-s</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
```

```bash
# Load the daemon
sudo launchctl load /Library/LaunchDaemons/com.yzsocialc.nosleep.plist
```

#### Linux (Ubuntu/Debian)

```bash
# Method 1: Disable system sleep entirely
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target

# Method 2: Configure systemd-logind
sudo nano /etc/systemd/logind.conf
```

```ini
# Add these lines to /etc/systemd/logind.conf
[Login]
HandleLidSwitch=ignore
HandleSuspendKey=ignore
HandleHibernateKey=ignore
IdleAction=ignore
IdleActionSec=infinity
```

```bash
# Restart logind service
sudo systemctl restart systemd-logind

# Method 3: Use systemd-inhibit to prevent sleep while running
systemd-inhibit --what=sleep --why="YZSocialC DHT Client" --who="yzsocialc" node examples/nodejs-client.js

# Method 4: Install and use caffeine
sudo apt install caffeine-indicator
caffeine -a  # Activate caffeine to prevent sleep
```

### Docker Deployment

```dockerfile
# Dockerfile
FROM node:18-alpine

# Install tools for keeping container awake
RUN apk add --no-cache curl

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm ci --only=production

# Copy source code
COPY . .

# Create logs directory
RUN mkdir -p logs

# Expose WebSocket port
EXPOSE 9000

# Add health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:9000/health || exit 1

# Start client
CMD ["node", "examples/nodejs-client.js"]
```

```yaml
# docker-compose.yml
version: '3.8'
services:
  yzsocialc-client:
    build: .
    ports:
      - "9000:9000"
    environment:
      - NODE_ENV=production
      - WS_PORT=9000
      - BRIDGE_SERVERS=ws://bridge.example.com:8080
    restart: unless-stopped
    volumes:
      - ./logs:/app/logs
      - ./data:/app/data
    networks:
      - yzsocialc-network

networks:
  yzsocialc-network:
    driver: bridge
```

## Advanced Node.js Client Examples

### Auto-Reconnecting Client

```javascript
// examples/resilient-client.js
const YZSocialC = require('../src/index.js');

class ResilientDHTClient {
  constructor(options = {}) {
    this.options = {
      reconnectInterval: 5000,
      maxReconnectAttempts: 10,
      ...options
    };
    this.client = null;
    this.reconnectAttempts = 0;
    this.isShuttingDown = false;
  }

  async start() {
    this.client = new YZSocialC(this.options);
    
    // Setup event handlers
    this.client.on('disconnected', () => this.handleDisconnection());
    this.client.on('error', (error) => this.handleError(error));
    
    try {
      await this.client.startDHT();
      console.log('✅ DHT client started successfully');
      this.reconnectAttempts = 0;
      
      // Prevent system sleep while running
      this.preventSleep();
      
    } catch (error) {
      console.error('Failed to start DHT client:', error);
      this.scheduleReconnect();
    }
  }

  async handleDisconnection() {
    if (this.isShuttingDown) return;
    
    console.log('🔌 DHT client disconnected, attempting to reconnect...');
    this.scheduleReconnect();
  }

  handleError(error) {
    console.error('DHT client error:', error);
    if (!this.isShuttingDown) {
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached, giving up');
      return;
    }

    this.reconnectAttempts++;
    console.log(`Reconnection attempt ${this.reconnectAttempts}/${this.options.maxReconnectAttempts} in ${this.options.reconnectInterval}ms`);
    
    setTimeout(() => {
      if (!this.isShuttingDown) {
        this.start();
      }
    }, this.options.reconnectInterval);
  }

  preventSleep() {
    // Keep process alive and prevent idle sleep
    const keepAlive = setInterval(() => {
      // Do minimal work to prevent process from being considered idle
      if (this.client) {
        const stats = this.client.getStats();
        console.log(`Heartbeat: ${stats.connections.total} connections`);
      }
    }, 60000); // Every minute

    // Cleanup on shutdown
    process.on('SIGTERM', () => {
      clearInterval(keepAlive);
      this.shutdown();
    });
  }

  async shutdown() {
    this.isShuttingDown = true;
    if (this.client) {
      await this.client.stopDHT();
    }
    console.log('DHT client shut down gracefully');
    process.exit(0);
  }
}

const client = new ResilientDHTClient({
  bootstrapServers: ['ws://localhost:8080'],
  enableWebSocketServer: true,
  webSocketPort: 9000
});

client.start();
```

### Service Node with Data Synchronization

```javascript
// examples/service-node.js
const YZSocialC = require('../src/index.js');
const fs = require('fs').promises;

class ServiceNode {
  constructor() {
    this.client = new YZSocialC({
      enableWebSocketServer: true,
      webSocketPort: 9001,
      bootstrapServers: ['ws://localhost:8080']
    });
    
    this.dataStore = new Map();
    this.syncInterval = null;
  }

  async start() {
    await this.client.startDHT();
    console.log('Service node started');
    
    // Start periodic data synchronization
    this.startDataSync();
    
    // Provide service endpoints
    this.setupServiceHandlers();
    
    // Keep system awake
    this.preventSleep();
  }

  startDataSync() {
    this.syncInterval = setInterval(async () => {
      try {
        // Sync local data to DHT
        for (const [key, value] of this.dataStore) {
          await this.client.store(`service:${key}`, value);
        }
        
        console.log(`Synced ${this.dataStore.size} items to DHT`);
      } catch (error) {
        console.error('Data sync failed:', error);
      }
    }, 30000); // Every 30 seconds
  }

  setupServiceHandlers() {
    // Handle custom service messages
    this.client.on('message', (message, fromPeer) => {
      if (message.type === 'service_request') {
        this.handleServiceRequest(message, fromPeer);
      }
    });
  }

  async handleServiceRequest(message, fromPeer) {
    try {
      const response = {
        type: 'service_response',
        requestId: message.requestId,
        data: this.dataStore.get(message.key),
        timestamp: Date.now()
      };
      
      await this.client.sendMessage(fromPeer, response);
    } catch (error) {
      console.error('Service request failed:', error);
    }
  }

  preventSleep() {
    // Prevent system sleep on different platforms
    const platform = process.platform;
    
    if (platform === 'win32') {
      // Windows: Use PowerShell to prevent sleep
      const { spawn } = require('child_process');
      spawn('powershell', ['-Command', 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState("Standby", $false, $false)']);
    } else if (platform === 'darwin') {
      // macOS: Use caffeinate
      const { spawn } = require('child_process');
      this.caffeinate = spawn('caffeinate', ['-s']);
    } else if (platform === 'linux') {
      // Linux: Use systemd-inhibit if available
      const { spawn } = require('child_process');
      try {
        this.inhibitor = spawn('systemd-inhibit', ['--what=sleep', '--why=YZSocialC Service Node', 'sleep', 'infinity']);
      } catch (error) {
        console.warn('Could not prevent system sleep:', error.message);
      }
    }
  }

  async shutdown() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }
    
    // Cleanup sleep prevention
    if (this.caffeinate) this.caffeinate.kill();
    if (this.inhibitor) this.inhibitor.kill();
    
    if (this.client) {
      await this.client.stopDHT();
    }
    
    console.log('Service node shut down');
  }
}

const serviceNode = new ServiceNode();
serviceNode.start().catch(console.error);

// Graceful shutdown
process.on('SIGTERM', () => serviceNode.shutdown());
process.on('SIGINT', () => serviceNode.shutdown());
```

## Monitoring and Maintenance

### Health Monitoring

```javascript
// examples/health-monitor.js
const YZSocialC = require('../src/index.js');

class HealthMonitor {
  constructor() {
    this.client = new YZSocialC();
    this.metrics = {
      uptime: Date.now(),
      connections: 0,
      routingTableSize: 0,
      messagesReceived: 0,
      messagesSent: 0
    };
  }

  async start() {
    await this.client.startDHT();
    
    // Collect metrics every 30 seconds
    setInterval(() => this.collectMetrics(), 30000);
    
    // Report health every 5 minutes
    setInterval(() => this.reportHealth(), 300000);
  }

  collectMetrics() {
    const stats = this.client.getStats();
    this.metrics = {
      ...this.metrics,
      connections: stats.connections.total,
      routingTableSize: stats.routingTable.size,
      uptime: Date.now() - this.metrics.uptime
    };
  }

  reportHealth() {
    console.log('📊 Health Report:', {
      uptime: `${Math.floor(this.metrics.uptime / 1000 / 60)} minutes`,
      ...this.metrics
    });
  }
}

const monitor = new HealthMonitor();
monitor.start();
```

### Log Rotation

```bash
# Setup logrotate for Node.js client logs
sudo nano /etc/logrotate.d/yzsocialc

# Add:
/var/log/yzsocialc/*.log {
    daily
    missingok
    rotate 30
    compress
    delaycompress
    notifempty
    postrotate
        pm2 reload yzsocialc-client
    endscript
}
```

## Troubleshooting

### Common Issues

1. **System Sleep Interrupting Service**
   ```bash
   # Check if sleep prevention is working
   # Linux
   systemd-inhibit --list
   
   # macOS
   pmset -g assertions
   
   # Windows
   powercfg /requests
   ```

2. **WebSocket Connection Issues**
   ```bash
   # Check port availability
   netstat -tlnp | grep :9000
   
   # Test connection
   curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" http://localhost:9000/
   ```

3. **Memory Leaks**
   ```bash
   # Monitor memory usage
   pm2 monit
   
   # Set memory limits
   pm2 restart yzsocialc-client --max-memory-restart 1G
   ```

## Best Practices

1. **Always use PM2 or similar process manager** for production
2. **Disable system sleep** for always-on services  
3. **Set up monitoring** and alerting for crashes
4. **Use health checks** in containerized deployments
5. **Implement graceful shutdown** for clean disconnections
6. **Keep logs rotated** to prevent disk space issues
7. **Monitor memory usage** to detect leaks early
8. **Use environment variables** for configuration
9. **Set up auto-restart** with memory limits
10. **Test reconnection scenarios** regularly

Node.js clients are powerful participants in the YZSocialC network when properly configured and maintained.