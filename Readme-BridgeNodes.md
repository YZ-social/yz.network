# Bridge Nodes Deployment Guide

Bridge nodes are critical infrastructure components that provide reconnection services for the YZSocialC DHT network. They must be always-available and should be deployed on dedicated, reliable infrastructure.

## Overview

Bridge nodes serve as:
- **Network observers** that monitor DHT activity
- **Reconnection facilitators** for disconnected peers
- **Network health validators** using cryptographic membership tokens
- **Internal infrastructure** (not exposed to public internet)

## Quick Start (Development)

```bash
# Start bridge nodes locally
npm run bridge-nodes

# In separate terminal, start bootstrap server
npm run bridge-bootstrap:genesis
```

## Production Deployment

### AWS EC2 Deployment

#### 1. Launch EC2 Instance

```bash
# Launch Ubuntu 22.04 LTS instance
# Recommended: t3.small or larger (2GB+ RAM)
# Security Group: Allow ports 8083, 8084 (internal), 22 (SSH)

# Connect to instance
ssh -i your-key.pem ubuntu@your-instance-ip
```

#### 2. Install Dependencies

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PM2 for process management
sudo npm install -g pm2

# Install Git
sudo apt install -y git

# Clone repository
git clone https://github.com/your-repo/yz.network.git
cd yz.network

# Install dependencies
npm install
```

#### 3. Configure Environment

```bash
# Create environment file
cat > .env << EOF
NODE_ENV=production
BRIDGE_AUTH=your-secure-bridge-auth-key-here
BOOTSTRAP_PORT=8080
BRIDGE_PORT_1=8083
BRIDGE_PORT_2=8084
MAX_PEERS=1000
EOF

# Set secure permissions
chmod 600 .env
```

#### 4. Build Application

```bash
# Build for production
npm run build
```

#### 5. Start Bridge Nodes with PM2

```bash
# Start bridge nodes
pm2 start npm --name "bridge-nodes" -- run bridge-nodes

# Start bootstrap server
pm2 start npm --name "bridge-bootstrap" -- run bridge-bootstrap:genesis

# View logs
pm2 logs

# Monitor processes
pm2 monit
```

#### 6. Configure Auto-Start

```bash
# Generate startup script
pm2 startup

# Save current process list
pm2 save

# Test restart
sudo reboot
# After reboot, check: pm2 list
```

### DigitalOcean Deployment

```bash
# Create Ubuntu 22.04 droplet (2GB+ RAM recommended)
# Enable monitoring and backups

# Follow same installation steps as AWS
# Configure firewall
sudo ufw allow 22
sudo ufw allow 8083
sudo ufw allow 8084
sudo ufw enable
```

### Docker Deployment

```dockerfile
# Dockerfile
FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm ci --only=production

# Copy source code
COPY . .

# Build application
RUN npm run build

# Expose ports
EXPOSE 8083 8084

# Start bridge nodes
CMD ["npm", "run", "bridge-nodes"]
```

```yaml
# docker-compose.yml
version: '3.8'
services:
  bridge-nodes:
    build: .
    ports:
      - "8083:8083"
      - "8084:8084"
    environment:
      - NODE_ENV=production
      - BRIDGE_AUTH=your-secure-key
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8083/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

## Local Development Setup

### Prevent System Sleep (Critical for Local Bridge Nodes)

Bridge nodes must remain online to provide reconnection services. System sleep will break all connections.

#### Windows (Run as Administrator)

```powershell
# Disable sleep permanently
powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0
powercfg /change hibernate-timeout-ac 0
powercfg /change hibernate-timeout-dc 0

# Or disable for 8 hours (480 minutes)
powercfg /change standby-timeout-ac 480
powercfg /change standby-timeout-dc 480

# Check current settings
powercfg /query SCHEME_CURRENT SUB_SLEEP
```

#### macOS

```bash
# Prevent sleep while plugged in
sudo pmset -c sleep 0

# Prevent sleep on battery (not recommended)
sudo pmset -b sleep 0

# Prevent system sleep but allow display sleep
sudo pmset -c displaysleep 10 sleep 0

# Check current settings
pmset -g
```

#### Linux (Ubuntu/Debian)

```bash
# Disable all sleep states
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target

# Or configure power management
sudo nano /etc/systemd/logind.conf
# Set:
# HandleLidSwitch=ignore
# HandleSuspendKey=ignore
# IdleAction=ignore

# Restart service
sudo systemctl restart systemd-logind

# Alternative: Use caffeine
sudo apt install caffeine
caffeine -a  # Prevent sleep
```

### Process Management (Development)

```bash
# Using PM2 locally
npm install -g pm2

# Start bridge nodes
pm2 start "npm run bridge-nodes" --name bridge-nodes

# Start bootstrap
pm2 start "npm run bridge-bootstrap:genesis" --name bootstrap

# Monitor
pm2 logs --lines 100
pm2 monit

# Restart on crashes
pm2 restart bridge-nodes
```

## Monitoring and Maintenance

### Health Checks

```bash
# Check bridge node status
curl http://localhost:8083/health
curl http://localhost:8084/health

# Check bootstrap server
curl http://localhost:8080/health
```

### Log Monitoring

```bash
# PM2 logs
pm2 logs --lines 50
pm2 logs bridge-nodes --lines 100

# System logs (Linux)
journalctl -u your-bridge-service -f

# Check memory usage
pm2 status
htop
```

### Memory Leak Detection

Bridge nodes may experience memory leaks due to routing table issues:

```bash
# Monitor memory usage
pm2 monit

# Restart if memory exceeds threshold
pm2 restart bridge-nodes

# Set memory limit with auto-restart
pm2 start "npm run bridge-nodes" --name bridge-nodes --max-memory-restart 1G
```

### Backup and Updates

```bash
# Backup configuration
cp .env .env.backup
cp ecosystem.config.js ecosystem.config.js.backup

# Update code
git pull origin main
npm install
npm run build

# Restart services
pm2 restart all
```

## Troubleshooting

### Common Issues

1. **Port Conflicts**
   ```bash
   # Check what's using ports
   sudo netstat -tlnp | grep :8083
   sudo lsof -i :8083
   ```

2. **Memory Crashes**
   ```bash
   # Increase Node.js heap size
   export NODE_OPTIONS="--max-old-space-size=2048"
   pm2 restart bridge-nodes
   ```

3. **Connection Issues**
   ```bash
   # Check firewall
   sudo ufw status
   
   # Check process is running
   pm2 status
   ```

4. **System Sleep Broke Connections**
   ```bash
   # Restart all services
   pm2 restart all
   
   # Check system didn't sleep
   last | grep reboot
   ```

### Debug Mode

```bash
# Start with debug logging
DEBUG=* npm run bridge-nodes

# Or with PM2
pm2 start "npm run bridge-nodes" --name bridge-nodes-debug -- --debug
```

## Security Considerations

1. **Bridge Authentication**: Use strong `BRIDGE_AUTH` keys
2. **Internal Network**: Bridge nodes should not be directly accessible from internet
3. **Firewall**: Only allow necessary ports
4. **Updates**: Keep Node.js and dependencies updated
5. **Monitoring**: Set up alerts for crashes or high resource usage

## Architecture Notes

- **Port 8083**: Bridge Node 1 (WebSocket server for browser connections)
- **Port 8084**: Bridge Node 2 (WebSocket server for browser connections)  
- **Port 8080**: Bootstrap server (public-facing, coordinates with bridges)
- **Internal Communication**: Bridges communicate with bootstrap via shared secrets
- **DHT Participation**: Bridges participate in DHT as limited Node.js clients
- **Passive Monitoring**: Bridges observe network without active DHT operations

## Performance Tuning

```bash
# Increase file descriptor limits
echo "* soft nofile 65535" >> /etc/security/limits.conf
echo "* hard nofile 65535" >> /etc/security/limits.conf

# Optimize Node.js
export UV_THREADPOOL_SIZE=16
export NODE_OPTIONS="--max-old-space-size=2048 --optimize-for-size"
```

Bridge nodes are critical infrastructure - deploy them on reliable, always-on systems with proper monitoring and backup procedures.