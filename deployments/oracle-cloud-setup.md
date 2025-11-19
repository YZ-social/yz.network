# Oracle Cloud Free Tier Deployment Guide

Deploy 40-60 DHT nodes across 4 free ARM instances.

## Prerequisites

1. Oracle Cloud account (free tier)
2. SSH key pair
3. Docker and docker-compose installed locally

## Step 1: Create 4 ARM Instances

### Instance Configuration

**Create 4 instances with:**
- **Shape**: VM.Standard.A1.Flex (Ampere ARM)
- **OCPU**: 1-2 OCPUs per instance
- **Memory**: 6-12 GB per instance
- **Image**: Ubuntu 22.04 ARM
- **Network**: Default VCN, assign public IP

**Distribution options:**

**Option A: Balanced (Recommended)**
- 4 instances × 1 OCPU, 6 GB each
- Run 15-18 nodes per instance (optimized)
- **Total: 60-72 nodes**

**Option B: Concentrated**
- 2 instances × 2 OCPU, 12 GB each
- Run 30-36 nodes per instance (optimized)
- **Total: 60-72 nodes**

### Create via OCI CLI

```bash
# Set variables
COMPARTMENT_ID="your-compartment-id"
SUBNET_ID="your-subnet-id"
SSH_KEY="$(cat ~/.ssh/id_rsa.pub)"

# Create 4 instances
for i in {1..4}; do
  oci compute instance launch \
    --compartment-id $COMPARTMENT_ID \
    --availability-domain US-ASHBURN-AD-1 \
    --shape VM.Standard.A1.Flex \
    --shape-config '{"ocpus": 1, "memory_in_gbs": 6}' \
    --subnet-id $SUBNET_ID \
    --image-id <ubuntu-22.04-arm-image-id> \
    --ssh-authorized-keys-file ~/.ssh/id_rsa.pub \
    --display-name "yz-dht-node-$i"
done
```

## Step 2: Configure Firewall (Security List)

**Ingress Rules:**
```
Port 8080 (TCP) - Bootstrap WebSocket
Port 3001 (TCP) - Dashboard (optional)
Port 22 (TCP) - SSH
```

**Via OCI Console:**
1. Networking → Virtual Cloud Networks
2. Select your VCN → Security Lists
3. Add Ingress Rules

**Via OCI CLI:**
```bash
oci network security-list update \
  --security-list-id <your-security-list-id> \
  --ingress-security-rules '[
    {"protocol": "6", "source": "0.0.0.0/0", "tcp-options": {"destination-port-range": {"min": 8080, "max": 8080}}},
    {"protocol": "6", "source": "0.0.0.0/0", "tcp-options": {"destination-port-range": {"min": 3001, "max": 3001}}},
    {"protocol": "6", "source": "0.0.0.0/0", "tcp-options": {"destination-port-range": {"min": 22, "max": 22}}}
  ]'
```

## Step 3: Install Docker on Each Instance

SSH into each instance and run:

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Install Docker Compose
sudo apt install docker-compose -y

# Add user to docker group
sudo usermod -aG docker $USER
newgrp docker

# Verify installation
docker --version
docker-compose --version
```

## Step 4: Deploy DHT Nodes

### On Instance 1 (Bootstrap + Nodes)

```bash
# Clone repository
git clone https://github.com/your-org/yz.network.git
cd yz.network

# Create environment file
cat > .env <<EOF
BOOTSTRAP_PORT=8080
DASHBOARD_PORT=3001
PUBLIC_IP=$(curl -s ifconfig.me)
NODE_COUNT=18
EOF

# Build ARM images
docker-compose build

# Start bootstrap + 18 nodes (optimized)
docker-compose up -d
docker-compose up -d --scale dht-node=18
```

### On Instances 2-4 (Nodes Only)

```bash
# Clone repository
git clone https://github.com/your-org/yz.network.git
cd yz.network

# Point to bootstrap on Instance 1
BOOTSTRAP_IP="<instance-1-public-ip>"

cat > .env <<EOF
BOOTSTRAP_URL=ws://${BOOTSTRAP_IP}:8080
NODE_COUNT=18
EOF

# Build and start nodes only (optimized: 18 nodes)
docker-compose build
docker-compose -f docker-compose.nodes-only.yml up -d --scale dht-node=18
```

## Step 5: Verify Deployment

```bash
# Check running containers
docker ps

# Check node logs
docker-compose logs -f --tail=50 dht-node

# Check dashboard (Instance 1)
curl http://localhost:3001/api/metrics

# Check from external
curl http://<instance-1-ip>:3001/api/metrics
```

## Step 6: Configure Load Balancing (Optional)

Use Oracle Cloud Load Balancer (paid) or configure Nginx on Instance 1:

```bash
# Install Nginx on Instance 1
sudo apt install nginx -y

# Configure as reverse proxy
sudo tee /etc/nginx/sites-available/yz-network <<EOF
upstream dht_bootstrap {
    server 127.0.0.1:8080;
}

server {
    listen 80;
    server_name _;

    location /yz {
        proxy_pass http://dht_bootstrap;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
    }
}
EOF

sudo ln -s /etc/nginx/sites-available/yz-network /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## Resource Monitoring

```bash
# Monitor resource usage
docker stats

# Check system resources
htop

# Monitor network
iftop
```

## Cost Tracking

**Free Tier Limits:**
- 4 instances with 1 OCPU, 6 GB RAM each (total 24 GB)
- 200 GB total storage
- 10 TB outbound data transfer per month

**Always free as long as you stay within limits!**

## Troubleshooting

**ARM Architecture Issues:**
```bash
# Rebuild for ARM
docker-compose build --no-cache

# Check architecture
uname -m  # Should show: aarch64
```

**Connection Issues:**
```bash
# Check security list allows ingress
# Check instance firewall
sudo iptables -L

# Check if services are listening
sudo netstat -tlnp | grep -E '8080|3001'
```

## Backup and Recovery

```bash
# Backup docker volumes
docker-compose down
tar -czf yz-network-backup.tar.gz /var/lib/docker/volumes

# Restore
tar -xzf yz-network-backup.tar.gz -C /
docker-compose up -d
```

## Estimated Performance

**4 × VM.Standard.A1.Flex (1 OCPU, 6 GB):**
- 18 nodes per instance = **72 total nodes** (optimized)
- Each node: ~80-100 MB RAM (optimized from 140 MB)
- Avg 15-20 DHT connections per node
- ~5-10ms inter-node latency
- ~60-80 DHT ops/sec per node

**Cost: $0/month (FREE!)**
