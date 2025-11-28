#!/bin/bash

# DockerServerDown.sh - Stop YZ Network services

echo "🛑 Stopping YZ Network DHT nodes..."
docker compose -f docker-compose.nodes.yml down

echo "🛑 Stopping YZ Network production services..."
docker compose -f docker-compose.production.yml down

echo "✅ All services stopped"
