import { PassiveBridgeNode } from './src/bridge/PassiveBridgeNode.js';
import { EnhancedBootstrapServer } from './src/bridge/EnhancedBootstrapServer.js';
import { NodeDHTClient } from './src/node/NodeDHTClient.js';

const MAX_CONNECTIONS = 20; // Per node, for various kinds of nodes.
const BOOTSTRAP_PORT = 8080;
const BOOTSTRAP_SERVERS = [`ws://localhost:${BOOTSTRAP_PORT}`];

function delay(ms) { // Should not need this, but I'm being conservative while figuring things out.
  return new Promise(resolve => setTimeout(resolve, ms));
}

const bridges = []; // Keeps from gc.
function configureBridges({number = 1, listeningPort = 8083, auth = 'default-bridge-auth-key'} = {}) {
  // Start a number of nodes that can be connected by websocket to reconnect to the dht (which they these nodes sit on).
  // PassiveBridgeNode creates its own connection manager via factory
  do {
    const bridge = new PassiveBridgeNode({
      bridgePort: listeningPort++,
      bridgeAuth: auth,
      maxConnections: MAX_CONNECTIONS,
      dhtOptions: {
        bootstrapServers: BOOTSTRAP_SERVERS
      },
      connectionOptions: {
        maxConnections: MAX_CONNECTIONS
      }
    });
    bridge.start();
    bridges.push(bridge);
  } while (--number);
}

let server;
function configureBootstrap({port = BOOTSTRAP_PORT, auth = 'default-bridge-auth-key'} = {}) {
  // Start the bootstrap server.
  server = new EnhancedBootstrapServer({
    port,
    createNewDHT: true,
    bridgeAuth: auth,
    bridgeNodes: bridges.map(bridge => `${bridge.bridgeHost}:${bridge.bridgePort}`)
  });
  server.start();
  return server;
}

let nodes = [];
async function configureNodes({number = 2} = {}) {
  // Start a number of bots. The first is authorized as the genesis, and it invites all the rest.
  do {
    const client = new NodeDHTClient({boostrapServers: BOOTSTRAP_SERVERS, port: 0});
    await client.start();
    if (nodes.length) { // First node in is authorized.
      await nodes[0].inviteNewClient(client.nodeId.toString());
      await delay(1e3);
    }
    nodes.push(client);
  } while (--number);
}
  

configureBridges();
await delay(1e3);

configureBootstrap();
await delay(5e3);

await configureNodes();
await nodes[0].store('test-key', 'Hello from Node 0');
let value = await nodes[0].get('test-key');
console.log('\n\n\nxxxx Retrieved value from Node 0', value, 'xxxx\n\n');

value = await nodes[1].get('test-key');
console.log('\n\n\nxxxx Retrieved value from Node 1:', value, 'xxxx\n\n');

await nodes[1].store('test-key2', 'Hello from Node 1');
value = await nodes[1].get('test-key2');
console.log('\n\n\nxxxx Retrieved value2 from Node 1:', value, 'xxxx\n\n');
value = await nodes[0].get('test-key2');
console.log('\n\n\nxxxx Retrieved value2 from Node 0:', value, 'xxxx\n\n');
