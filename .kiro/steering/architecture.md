# YZ Network Architecture & Development Guidelines

## Production Server (oracle-yz)

Access the production server via SSH:
```bash
ssh oracle-yz "command"
```

### Server Management Scripts
- `DockerServerUp.sh` - Start all Docker containers (web server, DHT nodes, nginx)
- `DockerServerDown.sh` - Stop all Docker containers
- `DockerServerLogs.sh` - View container logs

### Infrastructure
- Domain: `imeyouwe.com`
- All services run in Docker containers
- nginx runs as a Docker container (configured via `nginx.conf`, `nginx-ssl.conf`)
- nginx reverse proxies all connections so internal and external nodes use external addresses

## Deployment Workflow

1. Run tests locally: `npm test`
2. Commit changes to git (only after tests pass)
3. SSH to oracle-yz and pull: `ssh oracle-yz "cd /path/to/repo && git pull"`
4. Restart services: `ssh oracle-yz "./DockerServerDown.sh && ./DockerServerUp.sh"`

## Browser/Playwright Testing

Browser tests (Playwright) CANNOT be run locally against localhost. They require the production server.

### Running Browser Tests

1. Commit and push changes to git
2. Deploy to production server:
   ```bash
   ssh oracle-yz "cd YZSocialC && git pull && ./DockerServerDown.sh && ./DockerServerUp.sh"
   ```
3. Wait for Docker containers to start (builds the app inside container)
4. Run Playwright tests locally - they connect to `https://imeyouwe.com`:
   ```bash
   npx playwright test tests/browser/mesh-stability.spec.js
   ```

### Why Browser Tests Need Production

- The test server serves the built app, but browsers need to connect to the DHT network
- DHT bootstrap server runs at `wss://imeyouwe.com/ws` (production only)
- WebRTC connections require the production STUN/TURN infrastructure
- Docker containers provide the Node.js DHT nodes that browsers connect to

## Connection Architecture

### Core Invariant: Connection-Agnostic Code

All connection logic MUST be centralized in `ConnectionManagerFactory.js`. This factory:
- Determines source and target node types
- Selects the appropriate ConnectionManager subclass
- Controls all connection details

**DO NOT place connection logic anywhere else.** This allows future changes to connection strategies by modifying only the factory and its subclasses.

### Connection Types by Node

| Source | Target | Connection Type | Notes |
|--------|--------|-----------------|-------|
| Node.js | Node.js | WebSocket | No stable WebRTC library for Node.js |
| Node.js | Browser | WebSocket | Browser initiates (can't act as server) |
| Browser | Node.js | WebSocket | Browser initiates connection |
| Browser | Browser | WebRTC | Peer-to-peer via ICE/STUN/TURN |

### Browser Connection Pattern

Browsers cannot act as servers. When a Node.js node needs to connect to a browser:
1. Node.js sends a message via the overlay network asking browser to connect
2. Browser initiates WebSocket connection to the Node.js node
3. Node.js accepts the incoming connection

### Address Resolution via nginx

**Problem solved:** Tracking internal vs external addresses for Docker containers was brittle.

**Solution:** nginx reverse proxy handles all routing:
- All nodes (internal Docker containers and external browsers) use external addresses (`wss://imeyouwe.com/...`)
- nginx detects internal connections to external addresses and forwards to proper Docker container
- Node metadata always contains external addresses

This eliminates the need for nodes to know if they're connecting to a local or remote peer.

## Key Files

- `src/network/ConnectionManagerFactory.js` - Connection type selection (THE source of truth)
- `src/network/ConnectionManager.js` - Base connection manager class
- `nginx.conf` / `nginx-ssl.conf` - nginx configuration for Docker
- `docker-compose.yml` - Docker service definitions
