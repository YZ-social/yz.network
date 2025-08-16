#!/bin/bash

# Production Headless DHT Node Runner
# Usage: ./scripts/run-headless-node.sh [bootstrap_url] [node_name]

set -e

# Parameters
BOOTSTRAP_URL=${1:-"ws://localhost:8080"}
NODE_NAME=${2:-"dht-node-$(date +%s)"}
DHT_IMAGE="dht-node"

echo "🚀 Starting production headless DHT node"
echo "   Bootstrap URL: $BOOTSTRAP_URL"
echo "   Node Name: $NODE_NAME"

# Build image if it doesn't exist
if ! docker image inspect $DHT_IMAGE >/dev/null 2>&1; then
    echo "🔨 Building DHT node image..."
    docker build -t $DHT_IMAGE -f docker/Dockerfile .
fi

# Run headless node with host network for production connectivity
echo "🐳 Starting headless DHT node..."
docker run -d \
    --name "$NODE_NAME" \
    --network host \
    --restart unless-stopped \
    -e NODE_INDEX=0 \
    -e BOOTSTRAP_URL="$BOOTSTRAP_URL" \
    -e NODE_ENV=production \
    $DHT_IMAGE

echo "✅ Headless DHT node started successfully!"
echo "   Container: $NODE_NAME"
echo "   Network: Host (can connect to browsers)"
echo ""
echo "Monitor with:"
echo "   docker logs -f $NODE_NAME"
echo ""
echo "Stop with:"
echo "   docker stop $NODE_NAME && docker rm $NODE_NAME"