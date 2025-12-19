#!/bin/bash

# RestartServer.sh - Enhanced restart with bridge reconnection handling
echo "🔄 YZ Network Server Restart with Bridge Recovery"
echo "================================================="

# Update and build
echo "📦 Updating and building..."
./DockerUpdate.sh
./DockerBuild.sh
./DockerUpdate.sh

# Shutdown
echo "🛑 Shutting down services..."
./DockerServerDown.sh

# Startup with bridge recovery
echo "🚀 Starting services with bridge recovery..."
./DockerServerUp.sh

# Wait for services to stabilize
echo "⏳ Waiting for services to stabilize..."
sleep 30

# Check and fix bridge connections
echo "🔧 Checking bridge connections..."
if command -v node >/dev/null 2>&1; then
    node scripts/fix-bridge-connections.js
else
    echo "⚠️ Node.js not available - skipping automated bridge recovery"
    echo "💡 Manually check bridge health: curl http://localhost:8080/bridge-health"
fi

echo "✅ Restart completed!"

