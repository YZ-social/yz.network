# DNS-Based Bootstrap Server Discovery

This guide explains how to configure multiple bootstrap servers using DNS for the YZSocialC DHT network.

## Overview

Instead of hardcoding bootstrap server addresses, you can use DNS to dynamically discover available servers. This provides:

- **High Availability**: Automatic failover between servers
- **Load Distribution**: DNS-based load balancing
- **Dynamic Configuration**: Update servers without client changes
- **Geographic Distribution**: Route clients to nearest servers

## DNS Methods Supported

### 1. DNS Round Robin (Simplest)

Configure multiple A records for the same hostname:

```dns
bootstrap.yzsocialc.network.    300    IN    A    192.168.1.10
bootstrap.yzsocialc.network.    300    IN    A    192.168.1.11
bootstrap.yzsocialc.network.    300    IN    A    192.168.1.12
```

**Usage:**
```javascript
import { DNSBootstrapClient } from './src/bootstrap/DNSBootstrapClient.js';

const dht = new KademliaDHT({
  bootstrap: new DNSBootstrapClient({
    useDNSRoundRobin: true,
    dnsHostname: 'bootstrap.yzsocialc.network'
  })
});
```

### 2. DNS SRV Records (Recommended for Production)

SRV records provide priority, weight, and port information:

```dns
_yzsocialc._tcp.network.yzsocialc.network.  300  IN  SRV  10  60  8080  primary.yzsocialc.network.
_yzsocialc._tcp.network.yzsocialc.network.  300  IN  SRV  10  30  8080  secondary.yzsocialc.network.
_yzsocialc._tcp.network.yzsocialc.network.  300  IN  SRV  20  10  8080  backup.yzsocialc.network.
```

**Record Format**: `priority weight port target`
- **Priority**: Lower = higher priority (10 vs 20)
- **Weight**: Higher = more traffic (60 vs 30 for same priority)
- **Port**: WebSocket port (8080)
- **Target**: Server hostname

**Usage:**
```javascript
const dht = new KademliaDHT({
  bootstrap: new DNSBootstrapClient({
    useSRVRecords: true,
    dnsHostname: 'network.yzsocialc.network',
    srvService: '_yzsocialc._tcp'
  })
});
```

### 3. DNS TXT Records (Configuration-Based)

Store server lists in TXT records:

```dns
bootstrap.yzsocialc.network.  300  IN  TXT  "ws://server1.example.com:8080,ws://server2.example.com:8080"
backup.yzsocialc.network.     300  IN  TXT  "ws://backup1.example.com:8080;ws://backup2.example.com:8080"
```

**Usage:**
```javascript
const dht = new KademliaDHT({
  bootstrap: new DNSBootstrapClient({
    useTXTConfig: true,
    dnsHostname: 'yzsocialc.network',
    txtPrefix: 'bootstrap'
  })
});
```

## Production Configuration Example

### DNS Zone Configuration

```dns
; Primary bootstrap discovery via SRV
_yzsocialc._tcp.bootstrap.yzsocialc.network.  300  IN  SRV  10  50  8080  us-east.bootstrap.yzsocialc.network.
_yzsocialc._tcp.bootstrap.yzsocialc.network.  300  IN  SRV  10  30  8080  us-west.bootstrap.yzsocialc.network.
_yzsocialc._tcp.bootstrap.yzsocialc.network.  300  IN  SRV  10  20  8080  eu-west.bootstrap.yzsocialc.network.
_yzsocialc._tcp.bootstrap.yzsocialc.network.  300  IN  SRV  20  10  8080  ap-southeast.bootstrap.yzsocialc.network.

; Backup configuration via TXT
config.yzsocialc.network.                     300  IN  TXT  "ws://backup1.yzsocialc.network:8080,ws://backup2.yzsocialc.network:8080"

; Emergency fallback via A records
emergency.yzsocialc.network.                  300  IN  A    203.0.113.10
emergency.yzsocialc.network.                  300  IN  A    203.0.113.11

; Individual server A records
us-east.bootstrap.yzsocialc.network.          300  IN  A    198.51.100.10
us-west.bootstrap.yzsocialc.network.          300  IN  A    198.51.100.11
eu-west.bootstrap.yzsocialc.network.          300  IN  A    198.51.100.12
ap-southeast.bootstrap.yzsocialc.network.     300  IN  A    198.51.100.13
```

### Client Configuration

```javascript
// Production DHT client with robust DNS discovery
const dht = new KademliaDHT({
  bootstrap: new DNSBootstrapClient({
    // Enable multiple DNS methods for maximum reliability
    useSRVRecords: true,
    useTXTConfig: true, 
    useDNSRoundRobin: true,
    
    // DNS configuration
    dnsHostname: 'bootstrap.yzsocialc.network',
    srvService: '_yzsocialc._tcp',
    txtPrefix: 'config',
    
    // Caching and refresh intervals
    dnsCacheTimeout: 600000,      // 10 minutes
    dnsRefreshInterval: 1800000,  // 30 minutes
    
    // Fallback to static servers if DNS fails
    fallbackToStaticServers: true,
    bootstrapServers: [
      'ws://emergency.yzsocialc.network:8080',
      'ws://203.0.113.10:8080'
    ],
    
    // Connection timeouts
    timeout: 15000,
    maxReconnectAttempts: 20,
    reconnectInterval: 10000
  })
});

await dht.startDHT();

// Start periodic DNS refresh
dht.bootstrap.startDNSRefresh();
```

## Browser Compatibility

The DNSBootstrapClient uses DNS-over-HTTPS for browser environments:

```javascript
// Browser-compatible configuration
const dht = new KademliaDHT({
  bootstrap: new DNSBootstrapClient({
    useSRVRecords: true,
    useTXTConfig: true,
    
    dnsHostname: 'bootstrap.yzsocialc.network',
    
    // Shorter intervals for mobile/browser
    dnsCacheTimeout: 120000,     // 2 minutes
    dnsRefreshInterval: 300000,  // 5 minutes
    
    fallbackToStaticServers: true,
    bootstrapServers: ['ws://localhost:8080']
  })
});
```

## Server Priority Algorithm

Servers are selected using this priority order:

1. **SRV Records**: Sorted by priority (lower first), then weight (higher first)
2. **TXT Records**: Equal priority, processed in order
3. **A Records**: Equal priority and weight
4. **Static Fallback**: Used when DNS resolution fails

## Monitoring and Health Checks

```javascript
// Monitor DNS resolution status
dht.bootstrap.on('dnsResolved', (servers) => {
  console.log(`✅ Resolved ${servers.length} bootstrap servers`);
  servers.forEach(server => {
    console.log(`   ${server.url} (priority: ${server.priority}, source: ${server.source})`);
  });
});

dht.bootstrap.on('dnsError', (error) => {
  console.error('❌ DNS resolution failed:', error.message);
});

// Health monitoring
setInterval(() => {
  const status = dht.bootstrap.getStatus();
  console.log('📊 Bootstrap Health:', {
    connected: status.connected,
    currentServer: status.currentServer,
    resolvedServers: dht.bootstrap.resolvedServers?.length || 0,
    lastDNSResolve: new Date(dht.bootstrap.lastDNSResolve).toLocaleString()
  });
}, 60000);
```

## Security Considerations

1. **DNSSEC**: Use DNSSEC to prevent DNS poisoning attacks
2. **TLS/WSS**: Use secure WebSocket connections (wss://) in production
3. **Domain Validation**: Validate that resolved servers belong to your domain
4. **Fallback Limits**: Limit fallback servers to prevent abuse
5. **Rate Limiting**: DNS providers may rate limit DNS-over-HTTPS requests

## Testing DNS Configuration

```bash
# Test SRV records
dig SRV _yzsocialc._tcp.bootstrap.yzsocialc.network

# Test TXT records  
dig TXT config.yzsocialc.network

# Test A records
dig A bootstrap.yzsocialc.network

# Test with specific DNS server
dig @8.8.8.8 SRV _yzsocialc._tcp.bootstrap.yzsocialc.network
```

## Example Deployments

### AWS Route 53 Configuration

```json
{
  "Name": "_yzsocialc._tcp.bootstrap.yzsocialc.network",
  "Type": "SRV", 
  "TTL": 300,
  "ResourceRecords": [
    "10 50 8080 us-east-1.bootstrap.yzsocialc.network",
    "10 30 8080 us-west-2.bootstrap.yzsocialc.network", 
    "20 10 8080 eu-west-1.bootstrap.yzsocialc.network"
  ]
}
```

### Cloudflare DNS Configuration

```bash
# Add SRV record via Cloudflare API
curl -X POST "https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records" \
  -H "Authorization: Bearer {api_token}" \
  -H "Content-Type: application/json" \
  --data '{
    "type": "SRV",
    "name": "_yzsocialc._tcp.bootstrap",
    "data": {
      "priority": 10,
      "weight": 50,
      "port": 8080,
      "target": "us-east.bootstrap.yzsocialc.network"
    }
  }'
```

### Google Cloud DNS Configuration

```yaml
# dns-config.yaml
kind: dns#resourceRecordSet
name: "_yzsocialc._tcp.bootstrap.yzsocialc.network."
type: "SRV"
ttl: 300
rrdatas:
  - "10 50 8080 us-central1.bootstrap.yzsocialc.network."
  - "10 30 8080 us-east1.bootstrap.yzsocialc.network."
  - "20 10 8080 europe-west1.bootstrap.yzsocialc.network."
```

## Migration from Static Configuration

1. **Phase 1**: Deploy DNSBootstrapClient with fallback enabled
2. **Phase 2**: Configure DNS records and test resolution
3. **Phase 3**: Gradually reduce static fallback servers
4. **Phase 4**: Switch to DNS-only mode

This DNS-based approach provides a robust, scalable solution for bootstrap server discovery in distributed YZSocialC DHT networks.