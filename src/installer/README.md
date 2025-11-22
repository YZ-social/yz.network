# YZ Network - Community Node Installer

Help strengthen the YZ Network by running DHT nodes on your computer!

## What Are Community Nodes?

Community nodes are DHT (Distributed Hash Table) participants that:
- Help route messages between peers
- Store and retrieve data for the network
- Provide stability and redundancy
- Enable browsers to participate in pub/sub communication

## Quick Start (One-Line Install)

### Linux / macOS / WSL
```bash
curl -fsSL https://yz.network/install.sh | bash
```

### Windows (PowerShell)
```powershell
irm https://yz.network/install.ps1 | iex
```

### Requirements
- **Docker Desktop** installed and running
- Internet connection

That's it! The installer will guide you through the rest.

## Alternative: Manual Installation

If you prefer to clone the repository:

```bash
# Clone the repo
git clone https://github.com/yz-network/yz.network.git
cd yz.network

# Install dependencies
npm install
npm install nat-upnp  # Optional: for automatic UPnP port forwarding

# Run the installer
npm run install-node
```

The installer will guide you through:
1. ✅ Checking Docker installation
2. 🌐 Detecting your external IP address
3. 🔌 Configuring UPnP port forwarding (automatic)
4. 🔢 Choosing how many nodes to run
5. 📊 Showing resource usage estimates
6. 📈 Optional monitoring dashboard
7. 🚀 Starting your contribution nodes

## System Requirements

### Minimum (1-3 nodes)
- **CPU**: 0.5 cores
- **RAM**: 384 MB
- **Disk**: 150 MB
- **Network**: Broadband internet connection

### Recommended (5-10 nodes)
- **CPU**: 2 cores
- **RAM**: 1 GB
- **Disk**: 500 MB
- **Network**: Stable broadband with static IP (preferred)

### Software
- **Docker Desktop** (Windows/Mac) or **Docker Engine** (Linux)
- **Node.js** 16+ (for running the installer)
- **UPnP enabled on router** (for automatic port forwarding)

## Resource Usage Per Node

Each node uses minimal resources:
- **CPU**: 0.15 cores (15% of one CPU core)
- **RAM**: 128 MB
- **Disk**: 50 MB
- **Network**: ~1-5 Mbps depending on activity

## Network Configuration

### Automatic (UPnP - Recommended)

The installer will automatically:
1. Detect your external IP address
2. Open required ports on your router via UPnP
3. Configure nodes with correct public addresses

**Requirements**:
- UPnP/NAT-PMP enabled on your router
- `nat-upnp` package installed (`npm install nat-upnp`)

### Manual Configuration

If UPnP is not available or disabled:

1. **Find your external IP**: Visit https://ifconfig.me
2. **Forward ports on your router**:
   - Default ports: 8100-8114 (for up to 15 nodes)
   - Protocol: TCP
   - Forward to your computer's local IP
3. **Enter IP manually** when prompted by installer

## Usage

### Start Nodes
```bash
# Nodes are started automatically by installer
# Or start manually:
docker-compose -f docker-compose.community.yml up -d
```

### View Logs
```bash
docker-compose -f docker-compose.community.yml logs -f
```

### Stop Nodes
```bash
docker-compose -f docker-compose.community.yml stop
```

### Restart Nodes
```bash
docker-compose -f docker-compose.community.yml restart
```

### Remove Nodes
```bash
docker-compose -f docker-compose.community.yml down
```

## Monitoring

### Option 1: Dashboard (Optional - Recommended for Beginners)

During installation, you can choose to include a monitoring dashboard:
- **Web UI**: http://localhost:3001
- **Visual graphs** of network activity
- **Real-time status** of all your nodes
- **Resource usage** monitoring
- **Only monitors nodes on THIS computer**

⚠️ **Dashboard adds ~50MB RAM and 0.1 CPU cores**

### Option 2: Direct Metrics (For Advanced Users)

Each node exposes metrics on ports 9090+:

- **Node 1 Health**: http://localhost:9090/health
- **Node 1 Metrics**: http://localhost:9090/metrics
- **Node 1 Status**: http://localhost:9090/status

Metrics include:
- Connected peers
- Routing table size
- DHT operations (store, get, find_node)
- PubSub message counts
- Latency percentiles

## Troubleshooting

### Docker Not Found
```
❌ Docker not found
```

**Solution**: Install Docker Desktop:
- Windows/Mac: https://www.docker.com/products/docker-desktop
- Linux: https://docs.docker.com/engine/install/

### Docker Daemon Not Running
```
❌ Docker daemon is not running
```

**Solution**: Start Docker Desktop or run `sudo systemctl start docker` (Linux)

### UPnP Port Forwarding Failed
```
❌ Failed to open port 8100: UPnP disabled
```

**Solutions**:
1. Enable UPnP on your router:
   - Log into router admin panel (usually 192.168.1.1 or 192.168.0.1)
   - Find UPnP/NAT-PMP settings
   - Enable UPnP
2. Or manually forward ports (see Manual Configuration above)

### Can't Detect External IP
```
⚠️ Could not auto-detect external IP
```

**Solution**:
1. Visit https://ifconfig.me to find your IP
2. Enter it manually when prompted
3. Or press Enter to skip (nodes will only work on local network)

### Nodes Not Connecting to Network
```
⚠️ Health check warning: connections=0
```

**Possible causes**:
1. **Firewall blocking**: Check your firewall allows Docker
2. **Router not forwarding ports**: Verify port forwarding is working
3. **Bootstrap server down**: Wait and retry (network may be starting)
4. **ISP blocking**: Some ISPs block certain ports - try different base port

## Advanced Configuration

### Custom Bootstrap Server
```bash
# Edit generated docker-compose.community.yml
# Change BOOTSTRAP_URL environment variable
BOOTSTRAP_URL=ws://your-bootstrap-server:8080
```

### Change Base Port
```bash
# Ports are assigned sequentially from base port
# Default: 8100, 8101, 8102, etc.
# To change: Edit the installer or docker-compose.community.yml
```

### Run on Server (VPS)
```bash
# Set explicit public IP
export PUBLIC_IP=203.0.113.45
export WEBSOCKET_PORT=8100

# Run without installer
docker-compose -f docker-compose.community.yml up -d
```

## Security & Privacy

- **No personal data**: Nodes only route encrypted DHT traffic
- **Local control**: You control which nodes run and when
- **Open source**: All code is auditable
- **Firewall friendly**: Only specified ports are opened
- **Resource limits**: Docker limits prevent resource abuse

## Contributing More

Want to contribute more resources? You can:
1. **Run more nodes**: Installer supports 1-15 nodes per machine
2. **Run on multiple machines**: Install on multiple computers
3. **Run on a server**: Deploy on VPS for 24/7 operation
4. **Share with friends**: Help them install nodes too!

## Support

- **Issues**: https://github.com/yz-network/issues
- **Documentation**: https://docs.yz.network
- **Community**: https://discord.gg/yz-network

## Thank You! 🙏

Thank you for contributing to the YZ Network! Your nodes help:
- Make the network more decentralized
- Improve reliability and uptime
- Support browser-based applications
- Enable secure, private communication

Every node counts! 🌐
