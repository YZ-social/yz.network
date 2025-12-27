#!/bin/bash
# Fix: Restart bridge nodes and genesis in correct order to establish connections

echo "🔧 Fixing Bridge-Genesis Connection"
echo "===================================="
echo ""

echo "Step 1: Stop all DHT nodes (keep bootstrap running)"
docker-compose -f docker-compose.nodes.yml down
echo ""

echo "Step 2: Stop genesis and bridge nodes"
docker stop yz-genesis-node yz-bridge-node-1 yz-bridge-node-2 2>/dev/null || true
echo ""

echo "Step 3: Wait for cleanup"
sleep 5
echo ""

echo "Step 4: Start genesis node first"
docker start yz-genesis-node
echo "Waiting 30 seconds for genesis to initialize..."
sleep 30
echo ""

echo "Step 5: Check genesis status"
docker logs yz-genesis-node --tail 20 2>&1 | grep -iE "(genesis|ready|peer)"
echo ""

echo "Step 6: Start bridge nodes"
docker start yz-bridge-node-1 yz-bridge-node-2
echo "Waiting 30 seconds for bridge nodes to connect..."
sleep 30
echo ""

echo "Step 7: Check bridge node status"
echo "Bridge 1:"
docker logs yz-bridge-node-1 --tail 10 2>&1 | grep -iE "(peer|connect|genesis)"
echo ""
echo "Bridge 2:"
docker logs yz-bridge-node-2 --tail 10 2>&1 | grep -iE "(peer|connect|genesis)"
echo ""

echo "Step 8: Start DHT nodes"
docker-compose -f docker-compose.nodes.yml up -d
echo "Waiting 60 seconds for DHT nodes to connect..."
sleep 60
echo ""

echo "Step 9: Final status check"
echo "Genesis peers:"
docker logs yz-genesis-node --tail 5 2>&1 | grep -iE "peer"
echo ""
echo "Bridge 1 peers:"
docker logs yz-bridge-node-1 --tail 5 2>&1 | grep -iE "peer"
echo ""

echo "✅ Restart sequence complete"
echo "Check dashboard to verify node health"
