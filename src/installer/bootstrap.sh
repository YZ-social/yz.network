#!/bin/bash
# YZ Network Community Node Installer - Bootstrap Script
# Usage: curl -fsSL https://yz.network/install.sh | bash

set -e

INSTALLER_VERSION="1.0.0"
REPO_URL="https://github.com/yz-network/yz.network"
INSTALL_DIR="$HOME/.yz-network"

# Detect the bootstrap server we were downloaded from (passed as argument or use default)
BOOTSTRAP_SERVER="${1:-ws://bootstrap.yz.network:8080}"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "          YZ Network - Community Node Installer v${INSTALLER_VERSION}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check for required tools
check_command() {
    if ! command -v "$1" &> /dev/null; then
        echo "❌ $1 is required but not installed."
        return 1
    fi
    echo "✅ $1 found"
    return 0
}

# Check Docker
echo "Checking prerequisites..."
if ! check_command docker; then
    echo ""
    echo "Please install Docker first:"
    echo "  - Windows/Mac: https://www.docker.com/products/docker-desktop"
    echo "  - Linux: https://docs.docker.com/engine/install/"
    exit 1
fi

# Check if Docker daemon is running
if ! docker info &> /dev/null; then
    echo "❌ Docker daemon is not running. Please start Docker Desktop."
    exit 1
fi
echo "✅ Docker daemon is running"

# Check for Node.js (optional, for advanced config)
if check_command node; then
    NODE_AVAILABLE=true
else
    NODE_AVAILABLE=false
    echo "⚠️  Node.js not found - using simplified installation"
fi

echo ""

# Create install directory
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# Detect external IP
echo "🌐 Detecting external IP address..."
EXTERNAL_IP=$(curl -s https://api.ipify.org 2>/dev/null || curl -s https://icanhazip.com 2>/dev/null || echo "")

if [ -n "$EXTERNAL_IP" ]; then
    echo "✅ External IP: $EXTERNAL_IP"
else
    echo "⚠️  Could not detect external IP"
    read -p "Enter your external IP address (or press Enter to skip): " EXTERNAL_IP
fi

# Get node count
echo ""
echo "📊 Resource Usage Per Node:"
echo "   CPU: 0.15 cores | RAM: 128 MB | Disk: 50 MB"
echo ""
read -p "How many nodes would you like to run? (1-10, default: 3): " NODE_COUNT
NODE_COUNT=${NODE_COUNT:-3}

# Validate node count
if ! [[ "$NODE_COUNT" =~ ^[0-9]+$ ]] || [ "$NODE_COUNT" -lt 1 ] || [ "$NODE_COUNT" -gt 15 ]; then
    echo "Invalid node count, using default: 3"
    NODE_COUNT=3
fi

echo "✅ Will deploy $NODE_COUNT node(s)"

# Ask about UPnP
echo ""
read -p "Enable UPnP port forwarding? (Y/n): " UPNP_CHOICE
UPNP_ENABLED="true"
if [[ "$UPNP_CHOICE" =~ ^[Nn] ]]; then
    UPNP_ENABLED="false"
    echo "⚠️  UPnP disabled - manually forward ports 8100-$((8100 + NODE_COUNT - 1))"
fi

# Dashboard not yet available - disabled for now
INCLUDE_DASHBOARD="false"
# echo ""
# read -p "Include monitoring dashboard? (y/N): " DASHBOARD_CHOICE
# if [[ "$DASHBOARD_CHOICE" =~ ^[Yy] ]]; then
#     INCLUDE_DASHBOARD="true"
# fi

# Generate docker-compose.yml
echo ""
echo "📝 Generating configuration..."

BASE_PORT=8100
BOOTSTRAP_URL="${BOOTSTRAP_SERVER}"

cat > docker-compose.community.yml << DOCKER_EOF
version: '3.8'

services:
DOCKER_EOF

# Add node services
for i in $(seq 1 $NODE_COUNT); do
    PORT=$((BASE_PORT + i - 1))
    METRICS_PORT=$((9090 + i - 1))

    if [ -n "$EXTERNAL_IP" ]; then
        PUBLIC_ADDRESS="ws://${EXTERNAL_IP}:${PORT}"
    else
        PUBLIC_ADDRESS="ws://localhost:${PORT}"
    fi

    cat >> docker-compose.community.yml << NODE_EOF
  dht-node-${i}:
    image: itsmeront/yz-dht-node:latest
    container_name: yz-community-node-${i}
    ports:
      - "${PORT}:${PORT}"
      - "${METRICS_PORT}:9090"
    environment:
      - BOOTSTRAP_URL=${BOOTSTRAP_URL}
      - NODE_NAME=community-node-${i}
      - OPEN_NETWORK=true
      - WEBSOCKET_PORT=${PORT}
      - WEBSOCKET_HOST=0.0.0.0
      - PUBLIC_ADDRESS=${PUBLIC_ADDRESS}
      - UPNP_ENABLED=${UPNP_ENABLED}
      - METRICS_PORT=9090
    networks:
      - dht-network
    restart: unless-stopped
    deploy:
      resources:
        limits:
          cpus: '0.25'
          memory: 192M

NODE_EOF
done

# Add dashboard if requested
if [ "$INCLUDE_DASHBOARD" = "true" ]; then
    cat >> docker-compose.community.yml << DASH_EOF
  dashboard:
    image: itsmeront/yz-dashboard:latest
    container_name: yz-community-dashboard
    ports:
      - "3001:3000"
    environment:
      - METRICS_SCRAPE_INTERVAL=10000
    networks:
      - dht-network
    restart: unless-stopped

DASH_EOF
fi

# Add network
cat >> docker-compose.community.yml << NET_EOF

networks:
  dht-network:
    driver: bridge
NET_EOF

echo "✅ Configuration saved to: $INSTALL_DIR/docker-compose.community.yml"

# Pull images
echo ""
echo "📥 Pulling Docker images..."
docker pull itsmeront/yz-dht-node:latest || {
    echo "⚠️  Pre-built image not available, building locally..."
    # Fall back to building from source if image doesn't exist
    if [ ! -d "yz.network" ]; then
        git clone --depth 1 "$REPO_URL" yz.network
    fi
    cd yz.network
    docker build -t yznetwork/dht-node:latest -f src/docker/Dockerfile .
    cd ..
}

# Note: Dashboard image not yet available - skipping for now
# if [ "$INCLUDE_DASHBOARD" = "true" ]; then
#     docker pull itsmeront/yz-dashboard:latest 2>/dev/null || echo "⚠️  Dashboard image not available"
# fi

# Start nodes
echo ""
read -p "🚀 Start nodes now? (Y/n): " START_CHOICE
if [[ ! "$START_CHOICE" =~ ^[Nn] ]]; then
    echo "Starting $NODE_COUNT community node(s)..."
    docker-compose -f docker-compose.community.yml up -d

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "✅ YZ Network Community Nodes Started!"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "📊 Node Status:"
    for i in $(seq 1 $NODE_COUNT); do
        PORT=$((BASE_PORT + i - 1))
        METRICS=$((9090 + i - 1))
        echo "   Node $i: http://localhost:${METRICS}/health"
    done
    if [ "$INCLUDE_DASHBOARD" = "true" ]; then
        echo ""
        echo "📈 Dashboard: http://localhost:3001"
    fi
    echo ""
    echo "🔧 Management Commands:"
    echo "   View logs:    docker-compose -f $INSTALL_DIR/docker-compose.community.yml logs -f"
    echo "   Stop nodes:   docker-compose -f $INSTALL_DIR/docker-compose.community.yml stop"
    echo "   Start nodes:  docker-compose -f $INSTALL_DIR/docker-compose.community.yml start"
    echo "   Remove all:   docker-compose -f $INSTALL_DIR/docker-compose.community.yml down"
    echo ""
else
    echo ""
    echo "Configuration saved. To start nodes later, run:"
    echo "   docker-compose -f $INSTALL_DIR/docker-compose.community.yml up -d"
fi

echo "Thank you for contributing to the YZ Network! 🙏"
