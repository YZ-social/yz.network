#!/bin/bash
# Check genesis node's bridge connection attempts

echo "🌱 Genesis Node - Bridge Connection Status"
echo "==========================================="
echo ""

# Genesis node full recent logs
echo "📋 Genesis Node - Last 100 lines:"
docker logs yz-genesis-node 2>&1 | tail -100
echo ""
echo "---"
echo ""

# Genesis bridge invitation activity
echo "🎫 Genesis - Bridge invitation activity:"
docker logs yz-genesis-node 2>&1 | grep -iE "(bridge|invite|invitation)" | tail -20
echo ""

# Genesis peer connections
echo "🔗 Genesis - Peer connections:"
docker logs yz-genesis-node 2>&1 | grep -iE "(connect.*peer|peer.*connect|routing.*table)" | tail -15
echo ""

# Genesis errors
echo "❌ Genesis - Errors:"
docker logs yz-genesis-node 2>&1 | grep -iE "(error|fail|timeout)" | tail -15
echo ""

# Check if genesis received bridge node addresses
echo "📍 Genesis - Bridge node addresses received:"
docker logs yz-genesis-node 2>&1 | grep -iE "(bridge.*address|address.*bridge|wss://)" | tail -10
