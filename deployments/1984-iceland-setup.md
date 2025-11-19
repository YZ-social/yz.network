# 1984.is (Iceland) Deployment Guide

Privacy-focused hosting in Iceland with strong legal protections.

## Why 1984.is?

✅ **Privacy**: Strong Icelandic privacy laws
✅ **Freedom**: No censorship, free speech protection
✅ **Ethics**: Employee-owned cooperative
✅ **Security**: Full disk encryption, secure facilities
✅ **Independence**: Not subject to US/EU data requests (easily)

## Pricing Options

| Plan | vCPU | RAM | Storage | Price/month | DHT Nodes |
|------|------|-----|---------|-------------|-----------|
| **Einherji** | 1 | 1 GB | 25 GB | ISK 1,799 (~$13) | 6-8 |
| **Bifrost** | 2 | 2 GB | 50 GB | ISK 3,499 (~$25) | 15-18 |
| **Sleipnir** | 4 | 4 GB | 100 GB | ISK 6,999 (~$50) | 30-36 |

**Recommendation: Bifrost for 15-18 nodes (optimized)**

## Step 1: Order VPS

1. Go to https://www.1984.is/product/vps/
2. Select **Bifrost** plan
3. Choose **FreeBSD** or **Ubuntu 22.04**
4. Add SSH key
5. Complete order

Payment: Credit card or Bitcoin

## Step 2: Access Server

```bash
# SSH provided in welcome email
ssh root@your-server.1984.is
# or
ssh root@<ip-address>
```

## Step 3: Initial Setup

### For Ubuntu

```bash
# Update system
apt update && apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sh

# Install Docker Compose
apt install docker-compose -y

# Install monitoring tools
apt install htop iftop -y
```

### For FreeBSD (if chosen)

```bash
# Update system
pkg update && pkg upgrade -y

# Install Docker (via Linux compatibility)
pkg install linux-c7 docker docker-compose

# Enable Docker
sysrc docker_enable="YES"
service docker start
```

## Step 4: Configure Firewall

### Ubuntu (UFW)

```bash
# Enable firewall
ufw --force enable

# Allow SSH
ufw allow 22/tcp

# Allow bootstrap WebSocket
ufw allow 8080/tcp

# Allow dashboard
ufw allow 3001/tcp

# Check status
ufw status
```

### FreeBSD (pf)

```bash
# Edit /etc/pf.conf
cat >> /etc/pf.conf <<EOF
# Allow SSH
pass in proto tcp to port 22

# Allow DHT services
pass in proto tcp to port 8080
pass in proto tcp to port 3001
EOF

# Enable pf
sysrc pf_enable="YES"
service pf start
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

# Build Docker images
docker-compose build

# Start services (optimized: 15 nodes on Bifrost)
docker-compose up -d
docker-compose up -d --scale dht-node=15

# Verify deployment
docker-compose ps
docker-compose logs -f --tail=50
```

## Step 6: SSL/TLS Setup

### Option A: Let's Encrypt

```bash
# Install Nginx and Certbot
apt install nginx certbot python3-certbot-nginx -y

# Configure Nginx (see Hetzner guide for config)
# ...

# Get SSL certificate
certbot --nginx -d your-domain.is
```

### Option B: Self-Signed Certificate

```bash
# Generate certificate
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/ssl/private/yz-network.key \
  -out /etc/ssl/certs/yz-network.crt

# Configure Nginx to use it
```

## Step 7: Privacy Enhancements

### Disable logging (optional)

```bash
# Edit docker-compose.yml
logging:
  driver: "none"  # Disable Docker logs

# Disable Nginx access logs
# In /etc/nginx/nginx.conf:
access_log off;
```

### Use Tor hidden service (advanced)

```bash
# Install Tor
apt install tor -y

# Configure hidden service
cat >> /etc/tor/torrc <<EOF
HiddenServiceDir /var/lib/tor/yz-network/
HiddenServicePort 80 127.0.0.1:8080
EOF

# Restart Tor
systemctl restart tor

# Get .onion address
cat /var/lib/tor/yz-network/hostname
```

## Monitoring

```bash
# System resources
htop

# Network
iftop

# Docker stats
docker stats

# Logs
docker-compose logs -f
```

## Backup

### Local backup

```bash
# Backup script
cat > /root/backup.sh <<'EOF'
#!/bin/sh
DATE=$(date +%Y%m%d)
tar -czf /root/backups/yz-$DATE.tar.gz \
  /root/yz.network \
  /var/lib/docker/volumes
EOF

chmod +x /root/backup.sh

# Add to cron
echo "0 3 * * * /root/backup.sh" | crontab -
```

### Offsite backup to encrypted storage

```bash
# Install restic
apt install restic -y

# Initialize repository
restic init --repo /path/to/backup

# Backup
restic backup /root/yz.network
```

## Legal/Privacy Considerations

**Iceland Benefits:**
- Strong data protection laws
- Requires court order for data access
- Not part of 14 Eyes surveillance
- Favorable for freedom of speech

**1984.is Policies:**
- No logging unless required by law
- Accepts Bitcoin for anonymity
- Transparent about any government requests
- Open source friendly

## Performance

**Bifrost (2 vCPU, 2 GB) Performance:**
- 15-18 DHT nodes (optimized)
- ~80-100 MB per node (optimized from 140 MB)
- 10-20ms inter-node latency (within Iceland)
- 80-120ms latency to US East Coast
- 150-200ms latency to US West Coast
- 20-40ms latency to Europe
- ~60-80 DHT ops/sec per node

**Network:** Iceland - Europe fiber, good connectivity

## Cost Summary

| Plan | Nodes | Monthly | Annually | Savings |
|------|-------|---------|----------|---------|
| Bifrost | 15-18 | $25 | $300 | Pay monthly |
| Bifrost (annual) | 15-18 | ~$21 | $250 | 16% discount |

**Plus:** Bitcoin payments accepted (no KYC trail)

## Comparison

| Provider | Location | Privacy | Price | DHT Nodes |
|----------|----------|---------|-------|-----------|
| **1984.is** | 🇮🇸 Iceland | ⭐⭐⭐⭐⭐ | $25/mo | 15-18 |
| **Hetzner** | 🇩🇪 Germany | ⭐⭐⭐ | $5/mo | 15-18 |
| **Oracle** | 🌍 Global | ⭐⭐ | FREE | 60-72 |

**Choose 1984.is if:**
- Privacy is top priority
- Want ethical hosting
- Need strong legal protections
- OK with higher cost

**Choose Hetzner if:**
- Want cheap EU hosting
- Privacy important but not critical
- Need more datacenters

**Choose Oracle if:**
- Want free hosting
- Privacy not critical
- OK with big tech

## Support

**1984.is Support:**
- Email: help@1984.is
- Ticket system via account
- Response time: Usually same day
- IRC: #1984 on OFTC

## Troubleshooting

### Network issues

```bash
# Check routing
traceroute 8.8.8.8

# Check DNS
dig google.com

# Check firewall
pf status  # FreeBSD
ufw status  # Ubuntu
```

### Docker issues

```bash
# Restart Docker
service docker restart  # Ubuntu
service docker restart  # FreeBSD

# Check logs
journalctl -u docker -f  # Ubuntu
service docker status    # FreeBSD
```

## Additional Privacy Tips

1. **Use Tor**: Access via .onion address
2. **No logs**: Disable all logging
3. **Bitcoin**: Pay with crypto
4. **VPN**: Access server through VPN
5. **Encryption**: Full disk encryption (ask 1984.is)

## Recommended Reading

- https://www.1984.is/about/
- https://www.1984.is/privacy-policy/
- https://immi.is/ (Icelandic Modern Media Initiative)
