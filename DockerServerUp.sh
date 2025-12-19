#!/bin/bash

# DockerServerUp.sh - Start YZ Network services

echo "🚀 Starting YZ Network production services..."
docker compose -f docker-compose.production.yml up -d

echo ""
echo "⏳ Waiting 45 seconds for bootstrap/bridges to stabilize and authenticate..."
sleep 45

echo ""
echo "⏳ Waiting additional 30 seconds for genesis node to connect to bootstrap..."
sleep 30

echo ""
echo "🔍 Checking if genesis node is connected to bootstrap..."
# Check if genesis node has connected and is available as a peer
GENESIS_CONNECTED=$(docker logs yz-bootstrap-server 2>&1 | grep -c "genesis-node.*connected" || echo "0")
if [ "$GENESIS_CONNECTED" -gt "0" ]; then
    echo "✅ Genesis node is connected to bootstrap server"
else
    echo "⚠️ Genesis node may not be connected yet, but proceeding..."
fi

echo ""
echo "🚀 Starting YZ Network DHT nodes..."
docker compose -f docker-compose.nodes.yml up -d

echo ""
echo "⏳ Waiting 10 seconds for DHT nodes to initialize..."
sleep 10

echo ""
echo "📊 Checking service status..."
echo ""
echo "Production services:"
docker compose -f docker-compose.production.yml ps
echo ""
echo "DHT nodes:"
docker compose -f docker-compose.nodes.yml ps

echo ""
echo "✅ All services started"
echo ""
echo "💡 Useful commands:"
echo "   View all logs:         ./DockerServerLogs.sh"
echo "   View specific service: ./DockerServerLogs.sh genesis-node"
echo "   View DHT node logs:    docker logs yz-dht-node-1"
echo "   Stop services:         ./DockerServerDown.sh"
echo "   Check metadata:        docker logs yz-bootstrap-server | grep 'publicWssAddress: wss'"
