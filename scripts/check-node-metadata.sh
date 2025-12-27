#!/bin/bash
# Check what metadata nodes are sending to bootstrap

echo "🔍 Node Metadata Check"
echo "======================"
echo ""

# Check what metadata bridge nodes are sending
echo "🌉 Bridge Node 1 metadata in logs:"
docker logs yz-bridge-node-1 2>&1 | grep -iE "(metadata|isBridgeNode|nodeType)" | head -20
echo ""

echo "🌉 Bridge Node 2 metadata in logs:"
docker logs yz-bridge-node-2 2>&1 | grep -iE "(metadata|isBridgeNode|nodeType)" | head -20
echo ""

# Check what DHT nodes are sending
echo "📡 DHT Node 1 metadata in logs:"
docker logs yz-dht-node-1 2>&1 | grep -iE "(metadata|isBridgeNode|nodeType)" | head -10
echo ""

# Check bootstrap server's view of connected clients
echo "📊 Bootstrap server - client metadata:"
docker logs yz-bootstrap-server 2>&1 | grep -iE "(client.*metadata|metadata.*client|isBridgeNode|nodeType.*bridge)" | tail -30
echo ""

# Check which nodes bootstrap thinks are bridges
echo "🎯 Bootstrap server - bridge node selection:"
docker logs yz-bootstrap-server 2>&1 | grep -iE "(selected.*bridge|bridge.*selected|found.*bridge.*node)" | tail -10
echo ""

# Check bridge node IDs
echo "🆔 Bridge node IDs:"
echo "Bridge 1:"
docker logs yz-bridge-node-1 2>&1 | grep -iE "localNodeId|nodeId.*=" | head -3
echo ""
echo "Bridge 2:"
docker logs yz-bridge-node-2 2>&1 | grep -iE "localNodeId|nodeId.*=" | head -3
