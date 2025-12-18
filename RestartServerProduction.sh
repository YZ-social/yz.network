#!/bin/bash

# RestartServerProduction.sh - Restart production server without rebuilding Docker images
# Use this on production servers that pull pre-built images from Docker Hub

echo "🔄 Production Server Restart"
echo "=============================="
echo ""

# Pull latest code
echo "📥 Pulling latest code from git..."
git pull

# Build browser bundle
echo "🔨 Building browser bundle..."
npm run build

# Pull latest Docker images
echo "🐳 Pulling latest Docker images..."
docker pull itsmeront/yz-dht-node:latest
docker pull itsmeront/yz-dashboard:latest

# Restart services
echo "🛑 Stopping services..."
./DockerServerDown.sh

echo ""
echo "🚀 Starting services..."
./DockerServerUp.sh

echo ""
echo "✅ Production server restart complete!"
