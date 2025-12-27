#!/bin/bash
# Check bootstrap server for node registration activity

echo "🔍 Checking Bootstrap Server Registration Activity"
echo "==================================================="
echo ""

# Check for successful registrations
echo "✅ Successful registrations (last 20):"
docker logs yz-bootstrap-server 2>&1 | grep -E "(registered|Registration|welcome)" | tail -20
echo ""

# Check for connection errors
echo "❌ Connection/Registration errors (last 20):"
docker logs yz-bootstrap-server 2>&1 | grep -iE "(error|fail|reject|mismatch)" | tail -20
echo ""

# Check for peer introductions
echo "🤝 Peer introductions (last 10):"
docker logs yz-bootstrap-server 2>&1 | grep -iE "(introduce|peer.*found|routing)" | tail -10
echo ""

# Check connected clients count
echo "📊 Current connected clients:"
docker logs yz-bootstrap-server 2>&1 | grep -iE "connected.*client|client.*count|active.*connection" | tail -5
echo ""

# Check genesis node status
echo "🌱 Genesis node status:"
docker logs yz-bootstrap-server 2>&1 | grep -iE "genesis" | tail -10
echo ""

# Check bridge node status
echo "🌉 Bridge node status:"
docker logs yz-bootstrap-server 2>&1 | grep -iE "bridge" | tail -10
echo ""

# Check DHT node 1 logs for bootstrap connection
echo "📡 DHT Node 1 bootstrap connection attempts:"
docker logs yz-dht-node-1 2>&1 | grep -iE "(bootstrap|connect|register)" | tail -15
echo ""

# Check for WebSocket errors
echo "🔌 WebSocket errors in DHT Node 1:"
docker logs yz-dht-node-1 2>&1 | grep -iE "(websocket|ws.*error|connection.*fail)" | tail -10
