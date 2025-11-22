#!/bin/bash

# DockerServerLogs.sh - View YZ Network production service logs
# Usage:
#   ./DockerServerLogs.sh                    # View all logs (follow mode)
#   ./DockerServerLogs.sh genesis-node       # View specific service logs
#   ./DockerServerLogs.sh genesis-node 50    # View last 50 lines of specific service

SERVICE=${1:-""}
TAIL=${2:-"all"}

if [ -z "$SERVICE" ]; then
  echo "📋 Viewing logs for all services (Ctrl+C to exit)..."
  docker compose -f docker-compose.production.yml logs -f
else
  if [ "$TAIL" = "all" ]; then
    echo "📋 Viewing logs for: $SERVICE (Ctrl+C to exit)..."
    docker compose -f docker-compose.production.yml logs -f "$SERVICE"
  else
    echo "📋 Viewing last $TAIL lines for: $SERVICE"
    docker compose -f docker-compose.production.yml logs --tail="$TAIL" "$SERVICE"
  fi
fi
