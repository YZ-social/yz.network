import { KademliaDHT } from '../src/dht/KademliaDHT.js';
import { DNSBootstrapClient } from '../src/bootstrap/DNSBootstrapClient.js';

/**
 * Examples of DNS-based bootstrap server discovery
 */

// Example 1: DNS Round Robin (Simplest)
// DNS Configuration:
// bootstrap.example.com    A    192.168.1.10
// bootstrap.example.com    A    192.168.1.11  
// bootstrap.example.com    A    192.168.1.12

async function exampleDNSRoundRobin() {
  console.log('🔍 Example 1: DNS Round Robin');
  
  const dht = new KademliaDHT({
    bootstrap: new DNSBootstrapClient({
      useDNSRoundRobin: true,
      dnsHostname: 'bootstrap.example.com',
      fallbackToStaticServers: true,
      bootstrapServers: ['ws://localhost:8080'] // Fallback
    })
  });
  
  await dht.startDHT();
}

// Example 2: DNS SRV Records (Best for Production)
// DNS Configuration:
// _yzsocialc._tcp.network.example.com.  300  IN  SRV  10  60  8080  primary.example.com.
// _yzsocialc._tcp.network.example.com.  300  IN  SRV  10  30  8080  secondary.example.com.
// _yzsocialc._tcp.network.example.com.  300  IN  SRV  20  10  8080  backup.example.com.

async function exampleSRVRecords() {
  console.log('🔍 Example 2: DNS SRV Records');
  
  const dht = new KademliaDHT({
    bootstrap: new DNSBootstrapClient({
      useSRVRecords: true,
      dnsHostname: 'network.example.com',
      srvService: '_yzsocialc._tcp',
      dnsCacheTimeout: 300000,     // 5 minutes
      dnsRefreshInterval: 600000,  // 10 minutes
      fallbackToStaticServers: true
    })
  });
  
  await dht.startDHT();
  
  // Start periodic DNS refresh
  dht.bootstrap.startDNSRefresh();
}

// Example 3: DNS TXT Records (Configuration-based)
// DNS Configuration:
// yzsocialc-bootstrap.example.com.  300  IN  TXT  "ws://server1.example.com:8080,ws://server2.example.com:8080"
// yzsocialc-backup.example.com.     300  IN  TXT  "ws://backup1.example.com:8080;ws://backup2.example.com:8080"

async function exampleTXTRecords() {
  console.log('🔍 Example 3: DNS TXT Records');
  
  const dht = new KademliaDHT({
    bootstrap: new DNSBootstrapClient({
      useTXTConfig: true,
      dnsHostname: 'example.com',
      txtPrefix: 'yzsocialc-bootstrap',
      fallbackToStaticServers: false // Strict DNS-only mode
    })
  });
  
  await dht.startDHT();
}

// Example 4: Multi-Method DNS Discovery (Most Robust)
// Uses all DNS methods with priority: SRV > TXT > Round Robin

async function exampleMultiMethodDNS() {
  console.log('🔍 Example 4: Multi-Method DNS Discovery');
  
  const dht = new KademliaDHT({
    bootstrap: new DNSBootstrapClient({
      // Enable all DNS methods
      useSRVRecords: true,
      useTXTConfig: true,
      useDNSRoundRobin: true,
      
      // DNS configuration
      dnsHostname: 'yzsocialc.network',
      srvService: '_yzsocialc._tcp',
      txtPrefix: 'bootstrap',
      
      // Caching and refresh
      dnsCacheTimeout: 180000,     // 3 minutes
      dnsRefreshInterval: 300000,  // 5 minutes
      
      // Fallback behavior
      fallbackToStaticServers: true,
      bootstrapServers: [
        'ws://localhost:8080',
        'ws://fallback.yzsocialc.network:8080'
      ]
    })
  });
  
  await dht.startDHT();
  dht.bootstrap.startDNSRefresh();
}

// Example 5: Production Configuration with Health Monitoring

async function exampleProductionDNS() {
  console.log('🔍 Example 5: Production DNS Configuration');
  
  const dht = new KademliaDHT({
    bootstrap: new DNSBootstrapClient({
      useSRVRecords: true,
      useTXTConfig: true,
      
      dnsHostname: 'bootstrap.yzsocialc.network',
      srvService: '_yzsocialc._tcp',
      txtPrefix: 'config',
      
      // Production timeouts
      dnsCacheTimeout: 600000,      // 10 minutes
      dnsRefreshInterval: 1800000,  // 30 minutes
      timeout: 15000,               // Connection timeout
      
      // Robust fallback
      fallbackToStaticServers: true,
      bootstrapServers: [
        'ws://primary.yzsocialc.network:8080',
        'ws://secondary.yzsocialc.network:8080',
        'ws://emergency.yzsocialc.network:8080'
      ],
      
      // Enhanced retry logic
      maxReconnectAttempts: 20,
      reconnectInterval: 10000
    })
  });
  
  // Monitor DNS resolution events
  dht.bootstrap.on('dnsResolved', (servers) => {
    console.log(`✅ DNS resolved ${servers.length} bootstrap servers`);
  });
  
  dht.bootstrap.on('dnsError', (error) => {
    console.error('❌ DNS resolution failed:', error.message);
  });
  
  await dht.startDHT();
  dht.bootstrap.startDNSRefresh();
  
  // Health monitoring
  setInterval(() => {
    const status = dht.bootstrap.getStatus();
    console.log('📊 Bootstrap status:', {
      connected: status.connected,
      currentServer: status.currentServer,
      resolvedServers: dht.bootstrap.resolvedServers.length,
      lastDNSResolve: new Date(dht.bootstrap.lastDNSResolve).toISOString()
    });
  }, 60000); // Every minute
}

// Example 6: Browser-Compatible Configuration
// Uses DNS-over-HTTPS for browser environments

async function exampleBrowserDNS() {
  console.log('🔍 Example 6: Browser DNS-over-HTTPS');
  
  if (typeof window === 'undefined') {
    console.log('Skipping browser example in Node.js environment');
    return;
  }
  
  const dht = new KademliaDHT({
    bootstrap: new DNSBootstrapClient({
      // Browser-compatible methods
      useSRVRecords: true,
      useTXTConfig: true,
      useDNSRoundRobin: true,
      
      dnsHostname: 'bootstrap.yzsocialc.network',
      
      // Shorter timeouts for browser
      dnsCacheTimeout: 120000,     // 2 minutes
      dnsRefreshInterval: 300000,  // 5 minutes
      timeout: 10000,              // 10 second connection timeout
      
      fallbackToStaticServers: true,
      bootstrapServers: ['ws://localhost:8080']
    })
  });
  
  await dht.startDHT();
}

// Export examples for testing
export {
  exampleDNSRoundRobin,
  exampleSRVRecords, 
  exampleTXTRecords,
  exampleMultiMethodDNS,
  exampleProductionDNS,
  exampleBrowserDNS
};

// Run example if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const example = process.argv[2] || 'production';
  
  switch (example) {
    case 'roundrobin':
      await exampleDNSRoundRobin();
      break;
    case 'srv':
      await exampleSRVRecords();
      break;
    case 'txt':
      await exampleTXTRecords();
      break;
    case 'multi':
      await exampleMultiMethodDNS();
      break;
    case 'production':
      await exampleProductionDNS();
      break;
    case 'browser':
      await exampleBrowserDNS();
      break;
    default:
      console.log('Available examples: roundrobin, srv, txt, multi, production, browser');
  }
}