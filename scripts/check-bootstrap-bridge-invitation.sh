#!/bin/bash
# Check if bootstrap server is sending bridge invitation requests

echo "🔍 Bootstrap Server - Bridge Invitation Flow"
echo "============================================="
echo ""

# Check for bridge invitation requests being sent
echo "🎫 Bridge invitation requests sent:"
docker logs yz-bootstrap-server 2>&1 | grep -iE "(bridge.*invitation|invitation.*bridge|askGenesis)" | tail -20
echo ""

# Check for genesis peer designation
echo "🌟 Genesis peer designation:"
docker logs yz-bootstrap-server 2>&1 | grep -iE "(genesis.*peer|peer.*genesis|designated.*genesis)" | tail -10
echo ""

# Check for bridge node registration
echo "🌉 Bridge node registration:"
docker logs yz-bootstrap-server 2>&1 | grep -iE "(bridge.*register|register.*bridge|bridge.*node)" | tail -10
echo ""

# Check for errors in bridge invitation flow
echo "❌ Errors in bridge invitation flow:"
docker logs yz-bootstrap-server 2>&1 | grep -iE "(error|fail).*bridge|bridge.*(error|fail)" | tail -10
echo ""

# Check connected clients
echo "📊 Connected clients info:"
docker logs yz-bootstrap-server 2>&1 | grep -iE "connectedClients" | tail -5
echo ""

# Check if genesis is in connected clients when bridge invitation is attempted
echo "🔗 Genesis peer connection status:"
docker logs yz-bootstrap-server 2>&1 | grep -iE "genesis.*connect|connect.*genesis|genesis.*found|found.*genesis" | tail -10
