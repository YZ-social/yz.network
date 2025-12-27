#!/bin/bash
# Check genesis node's bridge connection attempts

echo "🌱 Genesis Node - Bridge Connection Status"
echo "==========================================="
echo ""

# Genesis node full recent logs
echo "📋 Genesis Node - Last 150 lines:"
docker logs yz-genesis-node 2>&1 | tail -150
echo ""
echo "---"
echo ""

# Genesis bridge invitation activity
echo "🎫 Genesis - Bridge invitation activity:"
docker logs yz-genesis-node 2>&1 | grep -iE "(bridge|invite|invitation|membership.*token)" | tail -30
echo ""

# Genesis peer connections
echo "🔗 Genesis - Peer connections:"
docker logs yz-genesis-node 2>&1 | grep -iE "(connect.*peer|peer.*connect|routing.*table|connected.*peer)" | tail -15
echo ""

# Genesis errors
echo "❌ Genesis - Errors:"
docker logs yz-genesis-node 2>&1 | grep -iE "(error|fail|timeout|warn)" | tail -20
echo ""

# Check if genesis received bridge node addresses
echo "📍 Genesis - Bridge node addresses received:"
docker logs yz-genesis-node 2>&1 | grep -iE "(bridge.*address|address.*bridge|wss://|ws://)" | tail -10
echo ""

# Check genesis token status
echo "🎫 Genesis - Token status:"
docker logs yz-genesis-node 2>&1 | grep -iE "(genesis.*token|token.*genesis|membership|isGenesis)" | tail -10
