# YZ Network Production Deployment Guide

## Overview

This guide covers deploying the YZ Network infrastructure to Oracle Cloud (or any server).

### Architecture

**Production Server (Oracle Cloud):**
- Bootstrap Server (port 8080) - Public-facing WebSocket server
- Bridge Node 1 (port 8083) - Internal DHT observer
- Bridge Node 2 (port 8084) - Internal DHT observer
- Dashboard (port 3001) - Monitoring interface

**Community Nodes:**
- Run by community members on their own machines
- Use the installer scripts (`install.sh` / `install.ps1`)

## Prerequisites

- Oracle Cloud account (or any VPS)
- Docker and Docker Compose installed
- Domain name (optional, for production)

## Step 1: Build Multi-Arch Docker Images

From your local development machine:

```bash
# Login to Docker Hub
docker login

# Build and push multi-arch images (AMD64 + ARM64)
chmod +x build-multiarch.sh
./build-multiarch.sh itsmeront/yz-dht-node latest

# This builds for both x86_64 and ARM64
```

## Step 2: Setup Oracle Cloud Instance

### Create VM
- Shape: VM.Standard.A1.Flex (1 OCPU, 6GB RAM)
- Image: Ubuntu 22.04
- Network: Assign public IPv4 address

### Configure Firewall
Add ingress rules in Security List:
- Port 22 (SSH)
- Port 8080 (Bootstrap WebSocket)
- Port 3001 (Dashboard - optional)

### Install Docker

```bash
# SSH into instance
ssh -i your-key.pem ubuntu@YOUR_PUBLIC_IP

# Install Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER

# Install Docker Compose
sudo apt install docker-compose -y

# Logout and back in
exit
ssh -i your-key.pem ubuntu@YOUR_PUBLIC_IP
```

## Step 3: Deploy Infrastructure

```bash
# Clone repository
git clone git@github.com:YZ-social/yz.network.git
cd yz.network

# Set environment variables
export BRIDGE_AUTH="your-secure-random-key-here"

# Pull images
docker pull itsmeront/yz-dht-node:latest

# Start services
docker-compose -f docker-compose.production.yml up -d

# Check status
docker-compose -f docker-compose.production.yml ps
docker-compose -f docker-compose.production.yml logs -f
```

## Step 4: Verify Deployment

### Check Bootstrap Server
```bash
curl http://localhost:8080/health
# Should return: {"status":"ok","peers":0}
```

### Check Bridge Nodes
```bash
curl http://localhost:9083/health  # Bridge node 1
curl http://localhost:9084/health  # Bridge node 2
```

### Access Dashboard
Open browser: `http://YOUR_PUBLIC_IP:3001`

## Step 5: Configure DNS (Optional)

Point your domain to the Oracle instance:
- `bootstrap.yz.network` → Oracle Public IP
- Update installer scripts to use your domain

## Management Commands

### View Logs
```bash
docker-compose -f docker-compose.production.yml logs -f [service_name]
```

### Restart Services
```bash
docker-compose -f docker-compose.production.yml restart
```

### Stop Services
```bash
docker-compose -f docker-compose.production.yml stop
```

### Update Images
```bash
docker-compose -f docker-compose.production.yml pull
docker-compose -f docker-compose.production.yml up -d
```

### Remove Everything
```bash
docker-compose -f docker-compose.production.yml down
```

## Monitoring

### Dashboard Access
- URL: `http://YOUR_PUBLIC_IP:3001`
- Shows: Bootstrap status, bridge node metrics, network health

### Metrics Endpoints
- Bootstrap: `http://localhost:8080/stats`
- Bridge 1: `http://localhost:9083/metrics`
- Bridge 2: `http://localhost:9084/metrics`

## Security Best Practices

1. **Change default BRIDGE_AUTH key**
   ```bash
   export BRIDGE_AUTH=$(openssl rand -hex 32)
   ```

2. **Configure firewall** - only expose ports 8080 and 3001

3. **Regular updates**
   ```bash
   docker-compose -f docker-compose.production.yml pull
   docker-compose -f docker-compose.production.yml up -d
   ```

4. **Monitor logs** for suspicious activity

## Troubleshooting

### Services won't start
```bash
# Check logs
docker-compose -f docker-compose.production.yml logs

# Check ports
sudo netstat -tlnp | grep -E '8080|8083|8084|3001'
```

### Can't connect to bootstrap
- Verify Oracle security list has port 8080 open
- Check firewall: `sudo ufw status`
- Test locally: `curl http://localhost:8080/health`

### Out of memory
- Check resources: `docker stats`
- Reduce resource limits in docker-compose.production.yml
- Consider upgrading Oracle instance

## Oracle Cloud Free Tier Limits

- 4 OCPUs + 24GB RAM total (Ampere A1)
- Currently using: 1 OCPU + 6GB RAM
- Remaining: 3 OCPUs + 18GB RAM for redundancy/scaling

## Next Steps

1. Configure domain DNS
2. Enable HTTPS with Let's Encrypt
3. Set up monitoring/alerting
4. Create backup strategy
