# Oracle YZ Node Mesh Formation Failure - Root Cause Analysis

## Date: December 27, 2025

## Problem
- 13 out of 15 Oracle YZ nodes are unhealthy
- All nodes show 0 peer connections
- Dashboard shows only 2 healthy nodes
- Nodes cannot form a mesh network

## Root Cause: BUILD_ID Version Mismatch

### Discovery
Running the diagnostic script `scripts/debug-oracle-mesh-formation.js` revealed:
- All 18 nodes (genesis, 2 bridges, 15 DHT nodes) are unhealthy
- All nodes show `bootstrap ✗` (bootstrap connection failing)
- WebSocket connections to nodes work externally
- Cross-node connectivity works

### The Actual Issue
When connecting to the bootstrap server, we receive:
```json
{
  "type": "version_mismatch",
  "clientVersion": "1.0.0",
  "clientBuildId": "diagnostic",
  "serverVersion": "1.0.0",
  "serverBuildId": "0a2d87da7ff14a6729a6",
  "message": "Bundle version mismatch. Please refresh your browser to get the latest version."
}
```

The bootstrap server has `BUILD_ID: 0a2d87da7ff14a6729a6` but the DHT nodes have a different BUILD_ID.

### How BUILD_ID Works
1. Webpack builds `bundle.HASH.js` and writes hash to `dist/bundle-hash.json`
2. Browser extracts BUILD_ID from script src (`bundle.HASH.js`)
3. Server reads BUILD_ID from `dist/bundle-hash.json` at startup
4. Client connects to bootstrap and sends both values in registration
5. Bootstrap checks BUILD_ID match (must match for synchronized deployment)
6. If mismatch, sends `version_mismatch` error

### Why This Happened
The Docker containers on Oracle server were built with a different `bundle-hash.json` than what's currently deployed. This can happen when:
1. Docker image was built at a different time than the web deployment
2. The `dist/bundle-hash.json` file wasn't properly mounted/synced to containers
3. Containers were restarted without rebuilding with the latest hash

## Solution

### Option 1: Rebuild and Redeploy Docker Images (Recommended)
```bash
# On the Oracle server:
cd /path/to/yz.network

# Pull latest code
git pull

# Rebuild webpack bundle (generates new bundle-hash.json)
npm run build

# Rebuild Docker images with new bundle-hash.json
docker-compose -f docker-compose.production.yml build --no-cache

# Restart all containers
docker-compose -f docker-compose.production.yml -f docker-compose.nodes.yml down
docker-compose -f docker-compose.production.yml -f docker-compose.nodes.yml up -d
```

### Option 2: Mount bundle-hash.json as Volume ✅ IMPLEMENTED
The `docker-compose.production.yml` already has this for the bootstrap server:
```yaml
volumes:
  - ./dist/bundle-hash.json:/app/dist/bundle-hash.json:ro
```

**FIXED**: All 15 DHT nodes in `docker-compose.nodes.yml` now have this volume mount added.
This ensures all nodes read the same BUILD_ID from the deployed `dist/bundle-hash.json` file.

### Option 3: Disable BUILD_ID Checking (Temporary Fix)
Modify `src/version.js` to skip BUILD_ID checking for Node.js clients:
```javascript
// In checkVersionCompatibility function, add:
const isNodeClient = clientBuildId && clientBuildId.startsWith('node_');
if (isNodeClient) {
  return { compatible: true }; // Skip BUILD_ID check for Node.js clients
}
```

## Verification
After applying the fix, run:
```bash
node scripts/debug-oracle-mesh-formation.js
```

Expected result:
- All nodes should show `bootstrap ✓`
- Nodes should start forming connections
- Health status should improve to healthy

## Prevention
1. Always rebuild Docker images after webpack build
2. Mount `bundle-hash.json` as a volume in all containers
3. Use CI/CD to ensure synchronized deployments
4. Consider using a deployment version file instead of bundle hash for server-to-server communication

## Deployment Steps (After Fix Applied)

To apply this fix on the Oracle server:

```bash
# 1. Pull the latest code with the docker-compose.nodes.yml fix
git pull

# 2. Restart the DHT nodes to pick up the new volume mount
docker-compose -f docker-compose.nodes.yml down
docker-compose -f docker-compose.nodes.yml up -d

# 3. Wait 60 seconds for nodes to start and connect
sleep 60

# 4. Verify nodes are healthy
node scripts/debug-oracle-mesh-formation.js
```

The nodes should now all read the same BUILD_ID from the mounted `dist/bundle-hash.json` file and successfully connect to the bootstrap server.
