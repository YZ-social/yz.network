#!/bin/bash

# DockerServerDown.sh - Stop YZ Network services

echo "🛑 Stopping YZ Network DHT nodes..."
docker compose -f docker-compose.nodes.yml down

echo "🛑 Stopping YZ Network production services..."
docker compose -f docker-compose.production.yml down

# Restart nginx to clear any dangling connections (if container still exists from partial shutdown)
if docker ps -a --format '{{.Names}}' | grep -q yz-webserver; then
    echo "🔄 Restarting nginx to clear connections..."
    docker restart yz-webserver 2>/dev/null || true
fi

echo "✅ All services stopped"
