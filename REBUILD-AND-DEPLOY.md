# Rebuild and Deploy with Bridge Connection Fixes

## Critical Fixes Applied

Three critical bugs were fixed in the local codebase:

1. **Race Condition** - Connection storage was happening before authentication
2. **No Keep-Alive** - Missing ping/pong mechanism causing idle connection timeouts
3. **Docker Network Binding** - WebSocket server binding to 127.0.0.1 instead of 0.0.0.0

## Deploy These Fixes to Oracle Cloud

### Step 1: Commit Changes Locally
```bash
cd C:\git\yz.network

# Check what changed
git status
git diff src/bridge/EnhancedBootstrapServer.js
git diff src/bridge/PassiveBridgeNode.js
git diff src/node/NodeDHTClient.js

# Commit the fixes
git add src/bridge/EnhancedBootstrapServer.js src/bridge/PassiveBridgeNode.js src/node/NodeDHTClient.js docs/bridge-connection-fix.md REBUILD-AND-DEPLOY.md DEPLOY.md
git commit -m "fix: Bridge node connection stability - race condition, keep-alive, and Docker binding

- Fixed race condition where connection was stored before authentication
- Added WebSocket keep-alive ping/pong mechanism (10s interval, 30s timeout)
- Fixed Docker network binding (0.0.0.0 instead of 127.0.0.1)
- Moved connection storage into auth_success handler
- Added pong response handler in PassiveBridgeNode
- Bridge nodes can now accept connections from other Docker containers
- Bridge connections should now persist indefinitely"

# Push to repository (if using git)
git push
```

### Step 2: Build Docker Image
```bash
# Build with latest fixes
docker build -t itsmeront/yz-dht-node:latest .

# Verify the build succeeded
docker images | grep yz-dht-node
```

### Step 3: Push to Docker Hub
```bash
docker push itsmeront/yz-dht-node:latest
```

### Step 4: Deploy to Oracle Cloud
```bash
# SSH to Oracle server
ssh ubuntu@imeyouwe.com
cd yz.network

# Pull latest image
docker-compose -f docker-compose.production.yml pull

# Restart services
docker-compose -f docker-compose.production.yml down
docker-compose -f docker-compose.production.yml up -d

# Wait for services to start (30 seconds)
sleep 30
```

### Step 5: Verify the Fix

**Check bootstrap server logs:**
```bash
docker logs yz-bootstrap-server --tail 100 | grep -E "Bridge node|ping|pong"
```

**Expected output:**
```
✅ Bridge node connected and authenticated: bridge-node-1:8083
✅ Bridge node connected and authenticated: bridge-node-2:8084
[NO disconnection messages should appear!]
[Ping/pong messages should appear every 10 seconds - might not be logged]
```

**Check bridge node logs:**
```bash
docker logs yz-bridge-node-1 --tail 50 | grep -E "Bootstrap|auth|ping|pong"
```

**Expected output:**
```
🔗 Incoming connection from bootstrap_... via connection manager
🎧 Setting up event listeners on dedicated manager for bootstrap_...
🔐 Bootstrap auth attempt: peerId=bootstrap_...
✅ Added bootstrap_... to authorized bootstrap servers
✅ Bootstrap server authenticated with bridge...
[Pong responses every 10 seconds]
```

**Monitor for 60 seconds:**
```bash
# Watch for disconnections (should see NONE)
watch -n 2 "docker logs yz-bootstrap-server --tail 20 | grep 'Bridge node'"
```

**Test browser connection:**
```
1. Open browser to: https://imeyouwe.com
2. Open DevTools console
3. Should see:
   ✅ Connected to bootstrap server
   📋 Received genesis status
   🌟 Connecting to bridge node...
   ✅ Received invitation from bridge
   📡 Connecting to bridge via WebSocket
   ✅ Connected to bridge node
```

### Step 6: Verify Bridge Connections Persist

**After 2 minutes, check if bridge connections are still alive:**
```bash
docker logs yz-bootstrap-server --tail 50 | grep "Bridge node"
```

**Should show:**
- Initial connection messages
- NO disconnection messages
- Connections should persist indefinitely

**Check bridge node health:**
```bash
docker exec yz-bridge-node-1 wget -q -O- http://127.0.0.1:9090/health
docker exec yz-bridge-node-2 wget -q -O- http://127.0.0.1:9090/health
```

## Rollback Plan (If Still Failing)

If bridge nodes still disconnect after deploying the fixes:

```bash
# On Oracle server
docker-compose -f docker-compose.production.yml logs yz-bootstrap-server --tail 200 > bootstrap-debug.log
docker-compose -f docker-compose.production.yml logs yz-bridge-node-1 --tail 200 > bridge1-debug.log
docker-compose -f docker-compose.production.yml logs yz-bridge-node-2 --tail 200 > bridge2-debug.log

# Send these log files for analysis
cat bootstrap-debug.log
cat bridge1-debug.log
cat bridge2-debug.log
```

## What the Fixes Should Solve

### Before Fixes:
```
✅ Bridge node connected and authenticated: bridge-node-1:8083  [PREMATURE - not actually authenticated yet]
🔌 Bridge node disconnected: bridge-node-1:8083  [Immediate disconnect]
❌ Failed to connect genesis to bridge: No bridge nodes available
```

### After Fixes:
```
✅ Bridge node connected and authenticated: bridge-node-1:8083  [Only after actual auth]
✅ Bridge node connected and authenticated: bridge-node-2:8084
[Connections persist - NO disconnection messages]
[Genesis connections succeed]
[Browser clients can join DHT]
```

## Additional Debugging

If issues persist after deploying fixes, check:

1. **Bridge node received auth message:**
   ```bash
   docker logs yz-bridge-node-1 | grep "Bootstrap auth attempt"
   ```
   If NOT found → message isn't reaching bridge node (network issue)

2. **WebSocket connection reaching bridge:**
   ```bash
   docker logs yz-bridge-node-1 | grep "Incoming connection"
   ```
   If NOT found → WebSocket server not receiving connections

3. **Docker network connectivity:**
   ```bash
   docker exec yz-bootstrap-server ping -c 3 bridge-node-1
   docker exec yz-bootstrap-server ping -c 3 bridge-node-2
   ```
   Should succeed - if not, Docker network issue

4. **Port accessibility:**
   ```bash
   docker exec yz-bootstrap-server wget -O- http://bridge-node-1:8083 2>&1
   docker exec yz-bootstrap-server wget -O- http://bridge-node-2:8084 2>&1
   ```
   Should get WebSocket upgrade error (expected) - proves port is reachable

## Success Criteria

- [ ] Bridge nodes connect and authenticate
- [ ] Connections persist for at least 5 minutes
- [ ] No "Bridge node disconnected" messages
- [ ] Genesis node successfully connects to bridge
- [ ] Browser clients successfully connect
- [ ] DHT network forms correctly
- [ ] Ping/pong keep-alive functioning (check logs for pong responses)
