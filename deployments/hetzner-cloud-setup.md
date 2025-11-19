# Hetzner Cloud Deployment Guide

Deploy 12-15 DHT nodes on affordable European infrastructure.

## Prerequisites

1. Hetzner Cloud account
2. `hcloud` CLI tool (optional)
3. SSH key

## Pricing Options

| Instance | vCPU | RAM | Storage | Price/month | DHT Nodes |
|----------|------|-----|---------|-------------|-----------|
| **CPX11** | 2 | 2 GB | 40 GB | €4.51 (~$5) | 15-18 |
| **CPX21** | 3 | 4 GB | 80 GB | €8.93 (~$10) | 30-36 |
| **CPX31** | 4 | 8 GB | 160 GB | €16.90 (~$18) | 60-72 |

**Recommendation: CPX11 for 15-18 nodes (optimized)**

## Step 1: Create Server via Web Console

1. Go to https://console.hetzner.cloud
2. Create new project: "yz-network"
3. Add Server:
   - **Location**: Nuremberg, Germany (nbg1) or Falkenstein (fsn1)
   - **Image**: Ubuntu 22.04
   - **Type**: CPX11 (2 vCPU, 2 GB RAM)
   - **Volume**: None (use included storage)
   - **Network**: Default
   - **SSH Key**: Add your public key
   - **Name**: yz-dht-server

4. Create server

## Step 2: Create Server via CLI

```bash
# Install hcloud CLI
brew install hcloud  # macOS
# or
wget https://github.com/hetznercloud/cli/releases/download/v1.38.2/hcloud-linux-amd64.tar.gz
tar -xzf hcloud-linux-amd64.tar.gz
sudo mv hcloud /usr/local/bin/

# Configure CLI
hcloud context create yz-network
# Paste API token from Hetzner console

# Create server
hcloud server create \
  --name yz-dht-server \
  --type cpx11 \
  --image ubuntu-22.04 \
  --location nbg1 \
  --ssh-key <your-ssh-key-name>

# Get server IP
hcloud server list
```

## Step 3: Configure Firewall

### Via Web Console

1. Go to Firewalls
2. Create Firewall: "yz-network-fw"
3. Add Rules:
   - **Inbound**:
     - Port 8080 (TCP) - Bootstrap WebSocket
     - Port 3001 (TCP) - Dashboard
     - Port 22 (TCP) - SSH
   - **Outbound**: Allow all

4. Apply to server

### Via CLI

```bash
# Create firewall
hcloud firewall create \
  --name yz-network-fw \
  --rules-file firewall-rules.json

# firewall-rules.json:
{
  "rules": [
    {
      "direction": "in",
      "port": "8080",
      "protocol": "tcp",
      "source_ips": ["0.0.0.0/0", "::/0"]
    },
    {
      "direction": "in",
      "port": "3001",
      "protocol": "tcp",
      "source_ips": ["0.0.0.0/0", "::/0"]
    },
    {
      "direction": "in",
      "port": "22",
      "protocol": "tcp",
      "source_ips": ["0.0.0.0/0", "::/0"]
    }
  ]
}

# Apply firewall to server
hcloud firewall apply-to-resource yz-network-fw \
  --type server \
  --server yz-dht-server
```

## Step 4: Install Docker

```bash
# SSH into server
ssh root@<server-ip>

# Update system
apt update && apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh

# Install Docker Compose
apt install docker-compose -y

# Enable Docker on boot
systemctl enable docker

# Verify
docker --version
docker-compose --version
```

## Step 5: Deploy Application

```bash
# Clone repository
git clone https://github.com/your-org/yz.network.git
cd yz.network

# Get public IP
PUBLIC_IP=$(curl -s ifconfig.me)

# Create environment file
cat > .env <<EOF
BOOTSTRAP_PORT=8080
DASHBOARD_PORT=3001
PUBLIC_IP=${PUBLIC_IP}
NODE_COUNT=15
OPEN_NETWORK=true
EOF

# Build images
docker-compose build

# Start services (optimized: 15 nodes on CPX11)
docker-compose up -d
docker-compose up -d --scale dht-node=15

# Verify
docker-compose ps
docker-compose logs -f --tail=50
```

## Step 6: Configure Nginx + SSL (Optional)

### Install Nginx and Certbot

```bash
apt install nginx certbot python3-certbot-nginx -y
```

### Configure Nginx

```bash
cat > /etc/nginx/sites-available/yz-network <<'EOF'
# WebSocket proxy for bootstrap
upstream ws_bootstrap {
    server 127.0.0.1:8080;
}

# HTTP proxy for dashboard
upstream dashboard {
    server 127.0.0.1:3001;
}

server {
    listen 80;
    server_name your-domain.com;  # Replace with your domain

    # Redirect HTTP to HTTPS (after SSL setup)
    # return 301 https://$server_name$request_uri;

    # WebSocket endpoint at /yz/ws
    location /yz/ws {
        proxy_pass http://ws_bootstrap;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket timeout
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # Dashboard at /yz/
    location /yz/ {
        proxy_pass http://dashboard/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Dashboard API
    location /yz/api/ {
        proxy_pass http://dashboard/api/;
        proxy_set_header Host $host;
    }
}
EOF

# Enable site
ln -s /etc/nginx/sites-available/yz-network /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx
```

### Setup SSL with Let's Encrypt

```bash
# Replace your-domain.com with actual domain
certbot --nginx -d your-domain.com

# Auto-renewal is configured automatically
```

### Update Docker Configuration for Nginx

```bash
# Edit docker-compose.yml to bind only to localhost
# Ports section should be:
#   ports:
#     - "127.0.0.1:8080:8080"
#     - "127.0.0.1:3001:3000"

docker-compose up -d
```

## Step 7: System Optimization

### Increase file descriptors

```bash
cat >> /etc/security/limits.conf <<EOF
* soft nofile 65536
* hard nofile 65536
EOF

# Reload
sysctl -p
```

### Optimize Docker

```bash
cat > /etc/docker/daemon.json <<EOF
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
EOF

systemctl restart docker
```

## Monitoring

### View real-time stats

```bash
# Container stats
docker stats

# System resources
htop

# Network
iftop
```

### Check dashboard

```
# Via domain:
https://your-domain.com/yz/

# Via IP:
http://<server-ip>:3001
```

## Backup

### Automated backup script

```bash
cat > /root/backup-yz-network.sh <<'EOF'
#!/bin/bash
DATE=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="/root/backups"
mkdir -p $BACKUP_DIR

cd /root/yz.network
docker-compose down
tar -czf $BACKUP_DIR/yz-network-$DATE.tar.gz \
  /root/yz.network \
  /var/lib/docker/volumes

docker-compose up -d

# Keep only last 7 backups
ls -t $BACKUP_DIR/yz-network-*.tar.gz | tail -n +8 | xargs rm -f
EOF

chmod +x /root/backup-yz-network.sh

# Add to cron (daily at 3 AM)
echo "0 3 * * * /root/backup-yz-network.sh" | crontab -
```

## Scaling

### Upgrade to larger instance

```bash
# Via CLI
hcloud server change-type yz-dht-server --type cpx21 --upgrade-disk

# Update node count (optimized: 30-36 nodes on CPX21)
docker-compose up -d --scale dht-node=30
```

## Troubleshooting

### Check logs

```bash
docker-compose logs -f dht-node
docker-compose logs -f bootstrap
journalctl -u docker -f
```

### Restart services

```bash
docker-compose restart
# or
docker-compose down && docker-compose up -d
```

### Check network

```bash
netstat -tlnp | grep -E '8080|3001'
curl -I http://localhost:8080
curl -I http://localhost:3001
```

## Cost Summary

| Configuration | Instance | Nodes | Cost/month |
|---------------|----------|-------|------------|
| **Minimal** | CPX11 | 15 | €4.51 (~$5) |
| **Standard** | CPX21 | 30 | €8.93 (~$10) |
| **Performance** | CPX31 | 60 | €16.90 (~$18) |

## DNS Setup (Optional)

1. Point A record to server IP:
   ```
   A    @             <server-ip>
   A    yz            <server-ip>
   ```

2. Update Nginx config with domain name

3. Run Certbot for SSL

## Estimated Performance

**CPX11 (2 vCPU, 2 GB RAM):**
- 15-18 DHT nodes (optimized)
- ~80-100 MB RAM per node (optimized from 140 MB)
- 15-20 connections per node
- ~10-20ms inter-node latency
- ~60-80 DHT ops/sec per node
- 99%+ uptime (Hetzner SLA)

**Network location**: Excellent for EU, good for US East Coast
