#!/bin/bash

# DockerServerUp.sh - Start YZ Network production services

echo "🚀 Starting YZ Network production services..."
docker compose -f docker-compose.production.yml up -d

echo ""
echo "📊 Checking service status..."
docker compose -f docker-compose.production.yml ps

echo ""
echo "✅ All services started"
echo ""
echo "💡 Useful commands:"
echo "   View all logs:        ./DockerServerLogs.sh"
echo "   View specific service: ./DockerServerLogs.sh genesis-node"
echo "   Stop services:        ./DockerServerDown.sh"
