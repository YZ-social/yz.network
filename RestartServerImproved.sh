#!/bin/bash

# RestartServerImproved.sh - Enhanced restart with bridge reconnection handling
# Ensures bridge nodes are properly invited after genesis restart

set -e

echo "🔄 Enhanced YZ Network Server Restart"
echo "====================================="

# Step 1: Update and build
echo ""
echo "📦 Step 1: Updating and building..."
./DockerUpdate.sh
./DockerBuild.sh
./DockerUpdate.sh

# Step 2: Graceful shutdown
echo ""
echo "🛑 Step 2: Graceful shutdown..."
./DockerServerDown.sh

# Step 3: Clean up any stale containers/networks
echo ""
echo "🧹 Step 3: Cleaning up stale resources..."
docker system prune -f --volumes 2>/dev/null || true

# Step 4: Start infrastructure services first
echo ""
echo "🚀 Step 4: Starting infrastructure services..."
echo "   - Bootstrap server"
echo "   - Bridge nodes"
echo "   - Genesis node"
docker compose -f docker-compose.production.yml up -d

# Step 5: Wait for bootstrap server to be ready
echo ""
echo "⏳ Step 5: Waiting for bootstrap server to be ready..."
for i in {1..30}; do
    if curl -s http://localhost:8080/health > /dev/null 2>&1; then
        echo "✅ Bootstrap server is ready"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "❌ Bootstrap server failed to start within 30 seconds"
        exit 1
    fi
    sleep 1
done

# Step 6: Wait for bridge nodes to connect and be healthy
echo ""
echo "⏳ Step 6: Waiting for bridge nodes to connect..."
sleep 30  # Increased from 15 to 30 seconds

# Check bridge node health with longer timeout
for bridge in "bridge-node-1:9083" "bridge-node-2:9084"; do
    bridge_name=$(echo $bridge | cut -d: -f1)
    bridge_port=$(echo $bridge | cut -d: -f2)
    
    echo "🔍 Checking $bridge_name health..."
    for i in {1..60}; do  # Increased from 20 to 60 attempts (60 seconds total)
        if curl -s http://localhost:$bridge_port/health > /dev/null 2>&1; then
            echo "✅ $bridge_name is healthy"
            break
        fi
        if [ $i -eq 60 ]; then
            echo "⚠️ $bridge_name not responding after 60 seconds"
            echo "🚨 CRITICAL: Bridge node $bridge_name may be failing"
            echo "🚨 Bridge nodes are essential DHT infrastructure - manual intervention required"
        fi
        sleep 1
    done
done

# Step 7: Wait for genesis node and bridge invitation process
echo ""
echo "⏳ Step 7: Waiting for genesis node and bridge invitations..."
sleep 45  # Increased from 30 to 45 seconds for more reliable bridge invitation

# Check if genesis node is connected and bridge invitations were sent
echo "🔍 Checking genesis connection and bridge invitations..."
GENESIS_LOGS=$(docker logs yz-genesis-node --tail 100 2>&1)  # Increased from 50 to 100 lines
BOOTSTRAP_LOGS=$(docker logs yz-bootstrap-server --tail 200 2>&1)  # Increased from 100 to 200 lines

# Check if genesis is connected
if echo "$BOOTSTRAP_LOGS" | grep -q "Genesis peer.*designated"; then
    echo "✅ Genesis peer designated successfully"
else
    echo "⚠️ Genesis peer designation not found in logs"
    echo "🔍 Checking for alternative genesis indicators..."
    if echo "$BOOTSTRAP_LOGS" | grep -q "createNewDHT.*true"; then
        echo "✅ Genesis mode is enabled - genesis should be designated on first connection"
    fi
fi

# Check if bridge invitations were sent
if echo "$BOOTSTRAP_LOGS" | grep -q "Bridge invitation request sent"; then
    echo "✅ Bridge invitation requests sent"
elif echo "$BOOTSTRAP_LOGS" | grep -q "Bridge.*connected"; then
    echo "✅ Bridge nodes connected (invitation may be automatic)"
else
    echo "⚠️ Bridge invitation status unclear - checking bridge connection status..."
    
    # Check if bridge nodes are connected to DHT
    if echo "$GENESIS_LOGS" | grep -q "bridge.*connected" || echo "$BOOTSTRAP_LOGS" | grep -q "bridge.*ready"; then
        echo "✅ Bridge nodes appear to be connected to DHT"
    else
        echo "🚨 CRITICAL: Bridge nodes may not be properly connected to DHT"
        echo "🚨 This will break network formation and connection pool"
    fi
fi

# Step 8: Verify bridge connectivity before starting DHT nodes
echo ""
echo "🔍 Step 8: Verifying bridge connectivity..."

# Test bridge availability through bootstrap server
BRIDGE_TEST=$(curl -s http://localhost:8080/bridge-health 2>/dev/null || echo '{"healthy":false}')
if echo "$BRIDGE_TEST" | grep -q '"healthy":true'; then
    echo "✅ Bridge nodes are available for onboarding"
else
    echo "⚠️ Bridge nodes may not be fully available"
    echo "🚨 WARNING: Not restarting bridge nodes - they cannot rejoin DHT after genesis formation"
    echo "💡 Bridge connection pool will retry automatically in the background"
    echo "💡 If bridge nodes are truly broken, manual intervention is required"
fi

# Step 9: Start DHT nodes
echo ""
echo "🚀 Step 9: Starting DHT nodes..."
docker compose -f docker-compose.nodes.yml up -d

# Step 10: Wait for DHT nodes to initialize
echo ""
echo "⏳ Step 10: Waiting for DHT nodes to initialize..."
sleep 15

# Step 11: Health check
echo ""
echo "🏥 Step 11: Performing health checks..."

# Check production services
echo ""
echo "Production services status:"
docker compose -f docker-compose.production.yml ps

# Check DHT nodes
echo ""
echo "DHT nodes status:"
docker compose -f docker-compose.nodes.yml ps

# Check for unhealthy nodes
echo ""
echo "🔍 Checking for unhealthy nodes..."
UNHEALTHY_NODES=$(docker ps --filter "health=unhealthy" --format "{{.Names}}" | grep -E "(dht-node|bootstrap|genesis)" || true)
UNHEALTHY_BRIDGES=$(docker ps --filter "health=unhealthy" --format "{{.Names}}" | grep -E "bridge" || true)

if [ -n "$UNHEALTHY_BRIDGES" ]; then
    echo "⚠️ Found unhealthy bridge nodes:"
    echo "$UNHEALTHY_BRIDGES"
    echo "🚨 WARNING: Bridge nodes cannot be safely restarted after genesis formation!"
    echo "🚨 Bridge nodes that are restarted will lose DHT membership and cannot rejoin."
    echo "🚨 This will break the connection pool and network formation."
    echo "💡 Bridge nodes will be left running - check logs manually if needed."
fi

if [ -n "$UNHEALTHY_NODES" ]; then
    echo "⚠️ Found unhealthy non-bridge nodes:"
    echo "$UNHEALTHY_NODES"
    echo ""
    echo "🔧 Attempting to restart unhealthy non-bridge nodes..."
    echo "$UNHEALTHY_NODES" | xargs -r docker restart
    sleep 10
    echo "✅ Restart attempt completed"
else
    echo "✅ All non-bridge nodes are healthy"
fi

# Step 12: Final verification
echo ""
echo "🎯 Step 12: Final verification..."

# Test a few DHT nodes
for node_num in 1 5 10; do
    if docker ps --format "{{.Names}}" | grep -q "yz-dht-node-$node_num"; then
        echo "🔍 Testing yz-dht-node-$node_num..."
        NODE_PORT=$((9095 + node_num))
        if curl -s http://localhost:$NODE_PORT/health > /dev/null 2>&1; then
            echo "✅ yz-dht-node-$node_num is healthy"
        else
            echo "⚠️ yz-dht-node-$node_num may be unhealthy"
        fi
    fi
done

echo ""
echo "🎉 Enhanced restart completed!"
echo ""
echo "📊 Summary:"
echo "   Bootstrap:  $(docker ps --filter "name=yz-bootstrap-server" --format "{{.Status}}")"
echo "   Bridge 1:   $(docker ps --filter "name=yz-bridge-node-1" --format "{{.Status}}")"
echo "   Bridge 2:   $(docker ps --filter "name=yz-bridge-node-2" --format "{{.Status}}")"
echo "   Genesis:    $(docker ps --filter "name=yz-genesis-node" --format "{{.Status}}")"
echo "   DHT Nodes:  $(docker ps --filter "name=yz-dht-node" --format "{{.Names}}" | wc -l) running"
echo ""
echo "💡 Useful commands:"
echo "   Monitor logs:          ./DockerServerLogs.sh"
echo "   Check bridge health:   curl http://localhost:8080/bridge-health"
echo "   Check node health:     docker exec yz-dht-node-5 wget -qO- http://127.0.0.1:9090/health"
echo "   Stop services:         ./DockerServerDown.sh"