#!/bin/bash
# Check bridge node status and why they're not responding to onboarding

echo "🌉 Bridge Node Status Check"
echo "==========================="
echo ""

# Bridge 1 logs
echo "📋 Bridge Node 1 - Recent logs:"
docker logs yz-bridge-node-1 2>&1 | tail -50
echo ""
echo "---"
echo ""

# Bridge 1 onboarding activity
echo "🎯 Bridge Node 1 - Onboarding activity:"
docker logs yz-bridge-node-1 2>&1 | grep -iE "(onboard|peer|genesis|dht|connect)" | tail -20
echo ""

# Bridge 1 errors
echo "❌ Bridge Node 1 - Errors:"
docker logs yz-bridge-node-1 2>&1 | grep -iE "(error|fail|timeout)" | tail -10
echo ""
echo "---"
echo ""

# Bridge 2 logs
echo "📋 Bridge Node 2 - Recent logs:"
docker logs yz-bridge-node-2 2>&1 | tail -30
echo ""

# Check if bridges have DHT peers
echo "🔍 Bridge Node 1 - DHT status:"
docker logs yz-bridge-node-1 2>&1 | grep -iE "(routing.*table|peer.*count|dht.*peer)" | tail -5
echo ""

echo "🔍 Bridge Node 2 - DHT status:"
docker logs yz-bridge-node-2 2>&1 | grep -iE "(routing.*table|peer.*count|dht.*peer)" | tail -5
echo ""

# Check genesis node
echo "🌱 Genesis Node - Status:"
docker logs yz-genesis-node 2>&1 | grep -iE "(peer|connect|dht|routing)" | tail -10
