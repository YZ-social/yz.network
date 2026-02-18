#!/bin/bash

# DockerServerMinimal.sh - Start YZ Network with minimal services (no extra DHT nodes)
# Use this for browser-to-browser WebRTC testing

echo "📦 Building browser bundle..."
npm run build

echo ""
echo "🐳 Rebuilding Docker image with latest code..."
docker build -t itsmeront/yz-dht-node:latest .

echo ""
echo "🚀 Starting YZ Network MINIMAL services (bootstrap + bridges + genesis only)..."
docker compose -f docker-compose.production.yml up -d

echo ""
echo "⏳ Waiting 45 seconds for bootstrap/bridges to stabilize..."
sleep 45

echo ""
echo "⏳ Waiting additional 30 seconds for genesis node to connect..."
sleep 30

echo ""
echo "📊 Checking service status..."
docker compose -f docker-compose.production.yml ps

echo ""
echo "✅ Minimal services started (NO extra DHT nodes)"
echo ""
echo "💡 This configuration has:"
echo "   - Bootstrap server"
echo "   - 2 Bridge nodes"
echo "   - 1 Genesis node"
echo "   - Dashboard"
echo "   - Nginx webserver"
echo ""
echo "💡 Useful commands:"
echo "   View logs:         ./DockerServerLogs.sh"
echo "   Stop services:     ./DockerServerDown.sh"
echo "   Full deployment:   ./DockerServerUp.sh"
