#!/bin/bash
# Oracle Cloud Deployment Script for 60 DHT Nodes
# Deploys across 4 FREE Oracle ARM instances

set -e

echo "🚀 YZ.Network Oracle Cloud Deployment (60 nodes)"
echo "=================================================="

# Configuration
INSTANCE_TYPE=${1:-"primary"}  # primary, secondary
BOOTSTRAP_IP=${2:-""}
NODE_COUNT=${3:-15}

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# System updates
log_info "Updating system..."
sudo apt update && sudo apt upgrade -y

# Install Docker if not present
if ! command -v docker &> /dev/null; then
    log_info "Installing Docker..."
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker $USER
    log_success "Docker installed"
else
    log_info "Docker already installed"
fi

# Install Docker Compose if not present
if ! command -v docker-compose &> /dev/null; then
    log_info "Installing Docker Compose..."
    sudo apt install docker-compose -y
    log_success "Docker Compose installed"
else
    log_info "Docker Compose already installed"
fi

# Clone repository if not exists
if [ ! -d "yz.network" ]; then
    log_info "Cloning repository..."
    git clone https://github.com/your-org/yz.network.git
    cd yz.network
else
    log_info "Repository already cloned"
    cd yz.network
    git pull
fi

# Build ARM image
log_info "Building ARM Docker image..."
docker build -t itsmeront/yz-dht-node:latest .
log_success "Docker image built"

# Deploy based on instance type
if [ "$INSTANCE_TYPE" == "primary" ]; then
    log_info "Deploying PRIMARY instance (Infrastructure + ${NODE_COUNT} nodes)..."

    # Generate secure bridge auth
    if [ ! -f ".env" ]; then
        BRIDGE_AUTH=$(openssl rand -hex 32)
        echo "BRIDGE_AUTH=$BRIDGE_AUTH" > .env
        log_success "Generated bridge authentication key"
    fi

    # Start infrastructure
    log_info "Starting infrastructure (bootstrap + bridges + genesis)..."
    docker-compose -f docker-compose.production.yml up -d

    # Wait for infrastructure
    log_info "Waiting for infrastructure to stabilize (60 seconds)..."
    sleep 60

    # Verify infrastructure health
    log_info "Checking infrastructure health..."
    docker-compose -f docker-compose.production.yml ps

    # Start DHT nodes
    log_info "Starting ${NODE_COUNT} DHT nodes..."
    docker-compose -f docker-compose.nodes.yml up -d --scale dht-node=${NODE_COUNT}

    log_success "PRIMARY instance deployed successfully!"
    log_info "Bootstrap URL: ws://$(curl -s ifconfig.me):8080"
    log_info "Dashboard: http://$(curl -s ifconfig.me):3001"

else
    # Secondary instance
    if [ -z "$BOOTSTRAP_IP" ]; then
        log_error "Bootstrap IP required for secondary instance"
        echo "Usage: $0 secondary <bootstrap_ip> <node_count>"
        exit 1
    fi

    log_info "Deploying SECONDARY instance (${NODE_COUNT} nodes)..."

    # Set bootstrap URL
    export BOOTSTRAP_URL="ws://${BOOTSTRAP_IP}:8080"
    log_info "Bootstrap URL: $BOOTSTRAP_URL"

    # Start DHT nodes
    log_info "Starting ${NODE_COUNT} DHT nodes..."
    docker-compose -f docker-compose.nodes.yml up -d --scale dht-node=${NODE_COUNT}

    log_success "SECONDARY instance deployed successfully!"
    log_info "Nodes connecting to: $BOOTSTRAP_URL"
fi

# Show running containers
log_info "Running containers:"
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

# Show resource usage
log_info "Resource usage:"
docker stats --no-stream

log_success "Deployment complete! 🎉"
log_info ""
log_info "Next steps:"
if [ "$INSTANCE_TYPE" == "primary" ]; then
    echo "  1. Note your public IP: $(curl -s ifconfig.me)"
    echo "  2. Configure Oracle Security List to allow ports 8080, 443, 3001"
    echo "  3. Deploy secondary instances with: ./oracle-deploy-60-nodes.sh secondary <this_ip> 18"
    echo "  4. Access dashboard at: http://$(curl -s ifconfig.me):3001"
else
    echo "  1. Verify nodes connected: docker logs <container_name>"
    echo "  2. Check dashboard on primary instance"
fi
