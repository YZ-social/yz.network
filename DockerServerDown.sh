#!/bin/bash

# DockerServerDown.sh - Stop YZ Network production services

echo "🛑 Stopping YZ Network production services..."
docker compose -f docker-compose.production.yml down

echo "✅ All services stopped"
