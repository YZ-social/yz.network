# Phase 1 Deployment to Oracle Cloud

## Changes in This Deployment

### Fixed Issues:
1. ✅ PassiveBridgeNode now extends NodeDHTClient (gets WebSocket metadata)
2. ✅ Bridge nodes advertise listening addresses for browser connections
3. ✅ Mock bootstrap client allows bridge nodes to start independently
4. ✅ Different metrics ports for local testing (9090, 9091)
5. ✅ Browser detects local vs production bootstrap URLs
6. ✅ **CRITICAL FIX**: Bridge connection storage race condition (was logging "authenticated" before actually authenticating)
7. ✅ **CRITICAL FIX**: Added WebSocket keep-alive ping/pong mechanism (10s interval, 30s timeout)

### Files Changed:
- `src/bridge/PassiveBridgeNode.js` - Fixed inheritance + ping/pong handling
- `src/bridge/EnhancedBootstrapServer.js` - Fixed race condition + keep-alive mechanism
- `src/node/NodeDHTClient.js` - Use createBootstrapClient() method
- `src/bridge/start-bridge-nodes.js` - Metrics port configuration
- `src/index.js` - Local vs production bootstrap URL detection
- `scripts/kill-ports.js` - Added bridge node ports

## Deployment Steps

### Step 1: Build Docker Image
```bash
docker build -t itsmeront/yz-dht-node:latest .
```

### Step 2: Push to Docker Hub
```bash
docker push itsmeront/yz-dht-node:latest
```

### Step 3: SSH to Oracle Cloud
```bash
ssh ubuntu@imeyouwe.com
cd yz.network
```

### Step 4: Pull Latest Image
```bash
docker-compose -f docker-compose.production.yml pull
```

### Step 5: Restart Services
```bash
docker-compose -f docker-compose.production.yml down
docker-compose -f docker-compose.production.yml up -d
```

### Step 6: Verify Services

**Check Bootstrap Server:**
```bash
docker logs yz-bootstrap-server --tail 50
```
Expected: `Enhanced Bootstrap Server started`

**Check Bridge Node 1:**
```bash
docker logs yz-bridge-node-1 --tail 50
docker exec yz-bridge-node-1 wget -q -O- http://127.0.0.1:9090/health
```
Expected: `{"healthy":true,"uptime":...,"connectedPeers":...}`

**Check Bridge Node 2:**
```bash
docker logs yz-bridge-node-2 --tail 50
docker exec yz-bridge-node-2 wget -q -O- http://127.0.0.1:9090/health
```
Expected: `{"healthy":true,"uptime":...,"connectedPeers":...}`

**Check Genesis Node:**
```bash
docker logs yz-genesis-node --tail 50
docker exec yz-genesis-node wget -q -O- http://127.0.0.1:9090/health
```
Expected: `{"healthy":true,"uptime":...,"connectedPeers":...}`

**Check Webserver:**
```bash
docker logs yz-webserver --tail 20
curl -I https://imeyouwe.com
```
Expected: `HTTP/2 200`

### Step 7: Test Browser Connectivity

**Open browser to:** https://imeyouwe.com

**Expected in console:**
```javascript
Connecting to bootstrap server: wss://imeyouwe.com/ws
✅ Connected to bootstrap server
📋 Received inviter metadata from <genesis-node-id>...
   Listening address: ws://genesis-node:8085  ✅ NOW PRESENT
   Public WSS address: wss://imeyouwe.com/genesis  ✅ NOW PRESENT
   Node type: nodejs
```

**Successful connection indicators:**
- Bootstrap WebSocket connects (not connection refused)
- Genesis node metadata includes WebSocket addresses
- Browser establishes WebSocket connection to genesis node
- DHT network forms

## Rollback Plan

If deployment fails:
```bash
# Tag current image as backup
docker tag itsmeront/yz-dht-node:latest itsmeront/yz-dht-node:backup-$(date +%Y%m%d)

# Revert to previous working version
docker-compose -f docker-compose.production.yml down
# Edit docker-compose.production.yml to use previous tag
docker-compose -f docker-compose.production.yml up -d
```

## Expected Results

### Before Phase 1:
```javascript
// Browser console - BROKEN
📋 Received inviter metadata from genesis...
   Listening address: undefined  ❌
   Public WSS address: undefined  ❌
```

### After Phase 1:
```javascript
// Browser console - FIXED
📋 Received inviter metadata from genesis...
   Listening address: ws://genesis-node:8085  ✅
   Public WSS address: wss://imeyouwe.com/genesis  ✅
```

## Monitoring

**Container Status:**
```bash
docker ps
```
All containers should be `Up` and `healthy`

**Service Logs:**
```bash
# Follow all logs
docker-compose -f docker-compose.production.yml logs -f

# Specific service
docker logs -f yz-bootstrap-server
docker logs -f yz-bridge-node-1
docker logs -f yz-genesis-node
```

**Health Endpoints:**
- Bootstrap: `http://imeyouwe.com:8080/health` (internal only)
- Bridge 1: `http://localhost:9083/health` (mapped from container 9090)
- Bridge 2: `http://localhost:9084/health` (mapped from container 9090)
- Genesis: `http://localhost:9095/health` (mapped from container 9090)

## Troubleshooting

### Issue: Bridge nodes show "listening address: undefined"
**Fix**: Verify PassiveBridgeNode extends NodeDHTClient, rebuild Docker image

### Issue: Browser can't connect to genesis node
**Check**:
1. Genesis node logs for WebSocket server startup
2. Nginx proxy configuration for `/genesis` path
3. SSL certificates valid

### Issue: Services won't start
**Check**:
1. Port conflicts: `netstat -tuln | grep -E '8080|8083|8084|8085'`
2. Docker logs for error messages
3. Health checks passing

### Issue: Nginx 502 Bad Gateway
**Check**:
1. Backend services running: `docker ps`
2. Internal DNS resolution: `docker exec yz-webserver ping bootstrap`
3. Nginx config: `docker exec yz-webserver nginx -t`

## Success Criteria

- [ ] All containers start and become healthy
- [ ] Bootstrap server accepts WebSocket connections
- [ ] Bridge nodes advertise WebSocket addresses in metadata
- [ ] Genesis node connects to bridge node
- [ ] Browser connects to bootstrap server (wss://imeyouwe.com/ws)
- [ ] Browser receives genesis node metadata with addresses
- [ ] Browser establishes WebSocket connection to genesis node
- [ ] DHT network forms successfully

## Next Steps After Deployment

Once Phase 1 is verified working:
1. Test browser DHT operations (store/get)
2. Test multiple browser clients connecting
3. Monitor network stability
4. Plan Phase 2 (merge ActiveDHTNode into NodeDHTClient)
