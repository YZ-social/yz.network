# YZ Network - Docker Deployment Guide

Complete guide for deploying 1000 DHT nodes with monitoring dashboard.

## 📋 Table of Contents
- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Scaling](#scaling)
- [Monitoring](#monitoring)
- [External Access](#external-access)
- [Troubleshooting](#troubleshooting)

---

## 🌐 Overview

This deployment creates a complete DHT network with:
- **Bootstrap Server**: Public entry point for DHT network
- **1000 DHT Nodes**: Full participants in DHT storage and PubSub
- **Monitoring Dashboard**: Real-time metrics and health monitoring
- **Auto-healing**: Docker health checks and automatic restarts

**Architecture:**
```
Internet → Bootstrap (port 8080) → DHT Mesh Network (1000 nodes)
              ↓
     Monitoring Dashboard (port 3001) → Metrics API
```

---

## 🔧 Prerequisites

**Server Requirements:**
- **RAM**: 256 GB recommended (256 MB per node × 1000)
- **CPU**: 64+ cores (0.5 core per node × 1000 / 8 threads)
- **Disk**: 50 GB minimum
- **OS**: Linux (Ubuntu 20.04+ recommended)

**Software:**
- Docker 20.10+
- Docker Compose 1.29+
- 10 Gbps network recommended

**System Tuning:**
```bash
# Increase file descriptor limits
echo "* soft nofile 100000" >> /etc/security/limits.conf
echo "* hard nofile 100000" >> /etc/security/limits.conf

# Increase network buffers
sysctl -w net.core.rmem_max=134217728
sysctl -w net.core.wmem_max=134217728
sysctl -w net.ipv4.tcp_rmem="4096 87380 134217728"
sysctl -w net.ipv4.tcp_wmem="4096 65536 134217728"

# Increase connection tracking
sysctl -w net.netfilter.nf_conntrack_max=2000000
sysctl -w net.nf_conntrack_max=2000000
```

---

## 🚀 Quick Start

### 1. Clone and Prepare
```bash
cd /path/to/yz.network
npm install
```

### 2. Create Environment File
```bash
# Create .env file
cat > .env <<EOF
# Bootstrap Server
BOOTSTRAP_PORT=8080

# Dashboard
DASHBOARD_PORT=3001

# Optional: Set resource limits
NODE_CPU_LIMIT=0.5
NODE_MEM_LIMIT=256M
EOF
```

### 3. Start with 10 Nodes (Test)
```bash
# Build images
docker-compose build

# Start with 10 nodes first
docker-compose up -d

# Check status
docker-compose ps
docker-compose logs -f bootstrap
```

### 4. Verify Test Deployment
```bash
# Check bootstrap server
curl http://localhost:9091/health

# Check dashboard
open http://localhost:3001

# Wait 2-3 minutes for nodes to connect
# Dashboard should show 10 healthy nodes
```

### 5. Scale to 1000 Nodes
```bash
# Scale gradually
docker-compose up -d --scale dht-node=100
# Wait 2 minutes, verify in dashboard

docker-compose up -d --scale dht-node=500
# Wait 5 minutes, verify in dashboard

docker-compose up -d --scale dht-node=1000
# Wait 10-15 minutes for full mesh formation
```

---

## ⚙️ Configuration

### Environment Variables

**Bootstrap Server:**
```bash
BOOTSTRAP_PORT=8080          # Public WebSocket port
CREATE_NEW_DHT=true          # Genesis mode
OPEN_NETWORK=true            # Allow automatic onboarding
MAX_PEERS=10000              # Maximum connections
```

**DHT Nodes:**
```bash
BOOTSTRAP_URL=ws://bootstrap:8080
METRICS_PORT=9090
OPEN_NETWORK=true
```

**Dashboard:**
```bash
DASHBOARD_PORT=3001
METRICS_SCRAPE_INTERVAL=10000  # 10 seconds
```

### Resource Limits

Edit `docker-compose.yml`:
```yaml
deploy:
  resources:
    limits:
      cpus: '0.5'      # Max CPU per node
      memory: 256M      # Max RAM per node
    reservations:
      cpus: '0.1'       # Reserved CPU
      memory: 128M      # Reserved RAM
```

---

## 📈 Scaling

### Gradual Scaling (Recommended)
```bash
# Start small
docker-compose up -d --scale dht-node=10

# Incremental scaling
docker-compose up -d --scale dht-node=50
docker-compose up -d --scale dht-node=100
docker-compose up -d --scale dht-node=500
docker-compose up -d --scale dht-node=1000
```

### Scaling Down
```bash
# Reduce node count
docker-compose up -d --scale dht-node=500

# Stop all nodes
docker-compose down
```

### Monitor During Scaling
```bash
# Watch resource usage
docker stats

# Watch logs
docker-compose logs -f --tail=100 dht-node

# Check dashboard
open http://localhost:3001
```

---

## 📊 Monitoring

### Monitoring Dashboard
- **URL**: `http://your-server:3001`
- **Features**:
  - Total nodes count
  - Healthy vs unhealthy nodes
  - Average connections per node
  - DHT operations (store/get)
  - PubSub operations (publish/subscribe)
  - Latency percentiles (P50, P95, P99)
  - Throughput (operations per second)
  - Individual node health and metrics

### Metrics API Endpoints

**Aggregate Metrics:**
```bash
curl http://localhost:3001/api/metrics
```

**Node List:**
```bash
curl http://localhost:3001/api/nodes
```

**Historical Data:**
```bash
curl http://localhost:3001/api/history
```

**Bootstrap Health:**
```bash
curl http://localhost:9091/health
curl http://localhost:9091/metrics
```

### Prometheus Integration (Optional)
All nodes expose Prometheus-compatible metrics on port 9090:
```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'dht-nodes'
    docker_sd_configs:
      - host: unix:///var/run/docker.sock
    relabel_configs:
      - source_labels: [__meta_docker_container_name]
        regex: '.*dht-node.*'
        action: keep
```

---

## 🌍 External Access

### Allow External Nodes to Join

**1. Configure Firewall:**
```bash
# Allow bootstrap WebSocket connections
sudo ufw allow 8080/tcp

# Allow dashboard access (optional)
sudo ufw allow 3001/tcp
```

**2. Update Bootstrap URL:**
External nodes should connect to:
```
ws://YOUR_SERVER_IP:8080
```

**3. Browser Client Connection:**
```html
<script>
  // In browser client
  const dht = new BrowserDHTClient({
    bootstrapServers: ['ws://YOUR_SERVER_IP:8080']
  });
  await dht.start();
</script>
```

**4. Node.js Client Connection:**
```javascript
import { ActiveDHTNode } from './src/docker/ActiveDHTNode.js';

const node = new ActiveDHTNode({
  bootstrapServers: ['ws://YOUR_SERVER_IP:8080']
});
await node.start();
```

### DNS Configuration (Optional)
```bash
# Set up subdomain for bootstrap
bootstrap.yourdomain.com → YOUR_SERVER_IP:8080

# Set up subdomain for dashboard
dashboard.yourdomain.com → YOUR_SERVER_IP:3001
```

---

## 🔧 Troubleshooting

### Nodes Not Connecting

**Check bootstrap server:**
```bash
docker-compose logs bootstrap
curl http://localhost:9091/health
```

**Check node logs:**
```bash
docker-compose logs --tail=50 dht-node
```

**Common issues:**
- Bootstrap server not fully started (wait 30 seconds)
- Network isolation (check Docker network)
- Resource exhaustion (check `docker stats`)

### High Memory Usage
```bash
# Check memory per container
docker stats --no-stream

# Reduce node count if needed
docker-compose up -d --scale dht-node=500

# Adjust memory limits in docker-compose.yml
```

### Nodes Marked Unhealthy
```bash
# Check specific node
docker inspect <container_id>

# View health check logs
docker inspect <container_id> | grep -A 20 Health

# Restart unhealthy nodes
docker-compose restart
```

### Network Performance Issues
```bash
# Check connection count
curl http://localhost:3001/api/metrics | jq '.aggregate.avgConnectionsPerNode'

# Should be 15-25 connections per node
# If too low: nodes are isolated
# If too high: network congestion
```

### Dashboard Not Showing Nodes
```bash
# Check dashboard logs
docker-compose logs dashboard

# Verify dashboard can reach nodes
docker exec yz-dashboard ping yz-bootstrap

# Restart dashboard
docker-compose restart dashboard
```

---

## 📦 Management Commands

### View Status
```bash
# All services
docker-compose ps

# Specific service
docker-compose ps dht-node

# Resource usage
docker stats
```

### View Logs
```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f bootstrap
docker-compose logs -f dashboard

# Last 100 lines
docker-compose logs --tail=100 dht-node
```

### Restart Services
```bash
# All services
docker-compose restart

# Specific service
docker-compose restart bootstrap

# Recreate containers
docker-compose up -d --force-recreate
```

### Stop Everything
```bash
# Stop containers (keeps images)
docker-compose stop

# Stop and remove containers
docker-compose down

# Stop, remove containers and volumes
docker-compose down -v
```

### Clean Up
```bash
# Remove unused containers
docker container prune

# Remove unused images
docker image prune

# Full cleanup (be careful!)
docker system prune -a
```

---

## 🎯 Next Steps

1. **Test PubSub**: Connect a browser client and test pub/sub functionality
2. **Load Testing**: Use stress testing tools to validate throughput
3. **Production Hardening**: Add SSL/TLS, authentication, rate limiting
4. **Geographic Distribution**: Deploy across multiple regions
5. **Backup Strategy**: Implement DHT state backup/recovery

---

## 📝 Notes

- **Startup Time**: 1000 nodes take 10-15 minutes to fully mesh
- **Resource Usage**: Monitor with `docker stats` - expect 100-150 GB RAM usage
- **Network Bandwidth**: Each node uses ~1-5 Mbps during mesh formation
- **Health Checks**: Nodes auto-restart if unhealthy for >90 seconds
- **Data Persistence**: Currently ephemeral - add volumes for persistence

---

## 🆘 Support

**Issues**: https://github.com/anthropics/yz-network/issues
**Documentation**: See `CLAUDE.md` for architecture details
**Dashboard**: http://localhost:3001
**Bootstrap**: http://localhost:8080
