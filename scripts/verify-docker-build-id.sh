#!/bin/bash
# Run this on the Oracle server to verify BUILD_ID status

echo "🔍 Checking BUILD_ID status in Docker containers"
echo "================================================="
echo ""

# Check if bundle-hash.json exists on host
echo "📁 Host bundle-hash.json:"
if [ -f "./dist/bundle-hash.json" ]; then
    cat ./dist/bundle-hash.json
    echo ""
else
    echo "❌ NOT FOUND at ./dist/bundle-hash.json"
fi
echo ""

# Check bootstrap server BUILD_ID
echo "🔧 Bootstrap Server BUILD_ID (from logs):"
docker logs yz-bootstrap-server 2>&1 | grep -E "(bundle-hash|BUILD_ID|Loaded bundle)" | tail -5
echo ""

# Check a DHT node BUILD_ID
echo "🔧 DHT Node 1 BUILD_ID (from logs):"
docker logs yz-dht-node-1 2>&1 | grep -E "(bundle-hash|BUILD_ID|Loaded bundle)" | tail -5
echo ""

# Check if bundle-hash.json is mounted in containers
echo "📂 Checking if bundle-hash.json is mounted in dht-node-1:"
docker exec yz-dht-node-1 cat /app/dist/bundle-hash.json 2>/dev/null || echo "❌ File not found or not readable"
echo ""

echo "📂 Checking if bundle-hash.json is mounted in bootstrap:"
docker exec yz-bootstrap-server cat /app/dist/bundle-hash.json 2>/dev/null || echo "❌ File not found or not readable"
echo ""

# Check version mismatch errors
echo "❌ Recent version mismatch errors in bootstrap:"
docker logs yz-bootstrap-server 2>&1 | grep -i "version.*mismatch" | tail -5
echo ""

echo "💡 If BUILD_IDs don't match, the volume mount may not be working."
echo "   Verify docker-compose.nodes.yml has the volumes section for each node."
