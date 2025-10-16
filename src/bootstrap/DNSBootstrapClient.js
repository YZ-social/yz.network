import { BootstrapClient } from './BootstrapClient.js';

/**
 * Enhanced Bootstrap Client with DNS-based server discovery
 * Supports DNS round robin, SRV records, and TXT record configurations
 */
export class DNSBootstrapClient extends BootstrapClient {
  constructor(options = {}) {
    super(options);
    
    this.dnsOptions = {
      // DNS discovery methods
      useDNSRoundRobin: options.useDNSRoundRobin || false,
      useSRVRecords: options.useSRVRecords || false,
      useTXTConfig: options.useTXTConfig || false,
      
      // DNS configuration
      dnsHostname: options.dnsHostname || 'bootstrap.yzsocialc.network',
      srvService: options.srvService || '_yzsocialc._tcp',
      txtPrefix: options.txtPrefix || 'yzsocialc-bootstrap',
      
      // Caching and refresh
      dnsCacheTimeout: options.dnsCacheTimeout || 300000, // 5 minutes
      dnsRefreshInterval: options.dnsRefreshInterval || 600000, // 10 minutes
      
      // Fallback behavior
      fallbackToStaticServers: options.fallbackToStaticServers !== false,
      
      ...options.dns
    };
    
    this.resolvedServers = [];
    this.lastDNSResolve = 0;
    this.dnsResolvePromise = null;
  }

  /**
   * Connect with DNS-based server discovery
   */
  async connect(localNodeId, metadata = {}) {
    this.localNodeId = localNodeId;
    
    if (this.isDestroyed) {
      throw new Error('BootstrapClient is destroyed');
    }

    this.metadata = metadata;
    
    // Resolve bootstrap servers via DNS first
    await this.resolveDNSServers();
    
    return this.attemptConnection();
  }

  /**
   * Resolve bootstrap servers using DNS
   */
  async resolveDNSServers() {
    const now = Date.now();
    
    // Check if we have cached results that are still valid
    if (this.resolvedServers.length > 0 && 
        (now - this.lastDNSResolve) < this.dnsOptions.dnsCacheTimeout) {
      console.log(`🔍 Using cached DNS results (${this.resolvedServers.length} servers)`);
      return;
    }
    
    // Prevent concurrent DNS lookups
    if (this.dnsResolvePromise) {
      return this.dnsResolvePromise;
    }
    
    this.dnsResolvePromise = this._performDNSResolution();
    
    try {
      await this.dnsResolvePromise;
      this.lastDNSResolve = now;
    } finally {
      this.dnsResolvePromise = null;
    }
  }

  /**
   * Perform actual DNS resolution using multiple methods
   */
  async _performDNSResolution() {
    const discoveredServers = [];
    
    console.log('🔍 Resolving bootstrap servers via DNS...');
    
    try {
      // Method 1: DNS SRV Records (most sophisticated)
      if (this.dnsOptions.useSRVRecords) {
        const srvServers = await this._resolveSRVRecords();
        discoveredServers.push(...srvServers);
        console.log(`🔍 Found ${srvServers.length} servers via SRV records`);
      }
      
      // Method 2: DNS TXT Records (configuration-based)
      if (this.dnsOptions.useTXTConfig) {
        const txtServers = await this._resolveTXTRecords();
        discoveredServers.push(...txtServers);
        console.log(`🔍 Found ${txtServers.length} servers via TXT records`);
      }
      
      // Method 3: DNS Round Robin (simplest)
      if (this.dnsOptions.useDNSRoundRobin) {
        const roundRobinServers = await this._resolveDNSRoundRobin();
        discoveredServers.push(...roundRobinServers);
        console.log(`🔍 Found ${roundRobinServers.length} servers via DNS round robin`);
      }
      
      // Remove duplicates and sort by priority
      this.resolvedServers = this._deduplicateAndSort(discoveredServers);
      
      if (this.resolvedServers.length > 0) {
        console.log(`✅ DNS resolution successful: ${this.resolvedServers.length} bootstrap servers`);
        this.resolvedServers.forEach((server, i) => {
          console.log(`   ${i + 1}. ${server.url} (priority: ${server.priority}, weight: ${server.weight})`);
        });
        
        // Update bootstrap servers list
        this.options.bootstrapServers = this.resolvedServers.map(s => s.url);
      } else {
        console.warn('⚠️ No bootstrap servers found via DNS');
        
        if (this.dnsOptions.fallbackToStaticServers) {
          console.log('🔄 Falling back to static server configuration');
          // Keep existing static servers
        } else {
          throw new Error('No bootstrap servers could be resolved via DNS');
        }
      }
      
    } catch (error) {
      console.error('❌ DNS resolution failed:', error.message);
      
      if (this.dnsOptions.fallbackToStaticServers) {
        console.log('🔄 Falling back to static server configuration');
        // Keep existing static servers
      } else {
        throw error;
      }
    }
  }

  /**
   * Resolve bootstrap servers using DNS SRV records
   * Format: _yzsocialc._tcp.network.example.com
   */
  async _resolveSRVRecords() {
    const srvName = `${this.dnsOptions.srvService}.${this.dnsOptions.dnsHostname}`;
    
    try {
      // In browser, we need to use a DNS-over-HTTPS service or proxy
      const servers = await this._performSRVLookup(srvName);
      
      return servers.map(srv => ({
        url: `ws://${srv.target}:${srv.port}`,
        priority: srv.priority,
        weight: srv.weight,
        source: 'SRV'
      }));
    } catch (error) {
      console.warn(`⚠️ SRV lookup failed for ${srvName}:`, error.message);
      return [];
    }
  }

  /**
   * Resolve bootstrap servers using DNS TXT records
   * Format: yzsocialc-bootstrap.example.com TXT "ws://server1:8080;ws://server2:8080"
   */
  async _resolveTXTRecords() {
    const txtName = `${this.dnsOptions.txtPrefix}.${this.dnsOptions.dnsHostname}`;
    
    try {
      const txtRecords = await this._performTXTLookup(txtName);
      const servers = [];
      
      txtRecords.forEach(record => {
        // Parse TXT record format: "server1:8080;server2:8080" or "ws://server1:8080,ws://server2:8080"
        const serverUrls = record.split(/[;,]/).map(s => s.trim());
        
        serverUrls.forEach((serverUrl, index) => {
          // Normalize URL format
          if (!serverUrl.startsWith('ws://') && !serverUrl.startsWith('wss://')) {
            serverUrl = `ws://${serverUrl}`;
          }
          
          servers.push({
            url: serverUrl,
            priority: 10, // Default priority for TXT records
            weight: 100,  // Equal weight
            source: 'TXT'
          });
        });
      });
      
      return servers;
    } catch (error) {
      console.warn(`⚠️ TXT lookup failed for ${txtName}:`, error.message);
      return [];
    }
  }

  /**
   * Resolve bootstrap servers using DNS round robin (multiple A records)
   */
  async _resolveDNSRoundRobin() {
    try {
      const addresses = await this._performALookup(this.dnsOptions.dnsHostname);
      
      return addresses.map((address, index) => ({
        url: `ws://${address}:8080`, // Default port
        priority: 10, // Equal priority
        weight: 100,  // Equal weight
        source: 'A'
      }));
    } catch (error) {
      console.warn(`⚠️ A record lookup failed for ${this.dnsOptions.dnsHostname}:`, error.message);
      return [];
    }
  }

  /**
   * Perform SRV record lookup (browser-compatible)
   */
  async _performSRVLookup(srvName) {
    if (typeof window !== 'undefined') {
      // Browser environment - use DNS-over-HTTPS
      return this._browserSRVLookup(srvName);
    } else {
      // Node.js environment - use dns module
      return this._nodeSRVLookup(srvName);
    }
  }

  /**
   * Browser-compatible SRV lookup using DNS-over-HTTPS
   */
  async _browserSRVLookup(srvName) {
    const dohUrl = `https://cloudflare-dns.com/dns-query?name=${srvName}&type=SRV`;
    
    const response = await fetch(dohUrl, {
      headers: { 'Accept': 'application/dns-json' }
    });
    
    if (!response.ok) {
      throw new Error(`DNS-over-HTTPS query failed: ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data.Status !== 0 || !data.Answer) {
      throw new Error('No SRV records found');
    }
    
    return data.Answer
      .filter(record => record.type === 33) // SRV record type
      .map(record => {
        const parts = record.data.split(' ');
        return {
          priority: parseInt(parts[0]),
          weight: parseInt(parts[1]),
          port: parseInt(parts[2]),
          target: parts[3].replace(/\.$/, '') // Remove trailing dot
        };
      });
  }

  /**
   * Node.js SRV lookup using dns module
   */
  async _nodeSRVLookup(srvName) {
    const dns = await import('dns');
    const { promisify } = await import('util');
    const resolveSrv = promisify(dns.resolveSrv);
    
    return await resolveSrv(srvName);
  }

  /**
   * Perform TXT record lookup
   */
  async _performTXTLookup(txtName) {
    if (typeof window !== 'undefined') {
      return this._browserTXTLookup(txtName);
    } else {
      return this._nodeTXTLookup(txtName);
    }
  }

  /**
   * Browser-compatible TXT lookup using DNS-over-HTTPS
   */
  async _browserTXTLookup(txtName) {
    const dohUrl = `https://cloudflare-dns.com/dns-query?name=${txtName}&type=TXT`;
    
    const response = await fetch(dohUrl, {
      headers: { 'Accept': 'application/dns-json' }
    });
    
    if (!response.ok) {
      throw new Error(`DNS-over-HTTPS query failed: ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data.Status !== 0 || !data.Answer) {
      throw new Error('No TXT records found');
    }
    
    return data.Answer
      .filter(record => record.type === 16) // TXT record type
      .map(record => record.data.replace(/"/g, '')); // Remove quotes
  }

  /**
   * Node.js TXT lookup using dns module
   */
  async _nodeTXTLookup(txtName) {
    const dns = await import('dns');
    const { promisify } = await import('util');
    const resolveTxt = promisify(dns.resolveTxt);
    
    const txtRecords = await resolveTxt(txtName);
    return txtRecords.map(record => record.join(''));
  }

  /**
   * Perform A record lookup
   */
  async _performALookup(hostname) {
    if (typeof window !== 'undefined') {
      return this._browserALookup(hostname);
    } else {
      return this._nodeALookup(hostname);
    }
  }

  /**
   * Browser-compatible A lookup using DNS-over-HTTPS
   */
  async _browserALookup(hostname) {
    const dohUrl = `https://cloudflare-dns.com/dns-query?name=${hostname}&type=A`;
    
    const response = await fetch(dohUrl, {
      headers: { 'Accept': 'application/dns-json' }
    });
    
    if (!response.ok) {
      throw new Error(`DNS-over-HTTPS query failed: ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data.Status !== 0 || !data.Answer) {
      throw new Error('No A records found');
    }
    
    return data.Answer
      .filter(record => record.type === 1) // A record type
      .map(record => record.data);
  }

  /**
   * Node.js A lookup using dns module
   */
  async _nodeALookup(hostname) {
    const dns = await import('dns');
    const { promisify } = await import('util');
    const resolve4 = promisify(dns.resolve4);
    
    return await resolve4(hostname);
  }

  /**
   * Remove duplicates and sort servers by priority and weight
   */
  _deduplicateAndSort(servers) {
    // Remove duplicates by URL
    const unique = servers.filter((server, index, self) => 
      self.findIndex(s => s.url === server.url) === index
    );
    
    // Sort by priority (lower is better), then by weight (higher is better)
    return unique.sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return b.weight - a.weight;
    });
  }

  /**
   * Start periodic DNS refresh
   */
  startDNSRefresh() {
    if (this.dnsRefreshTimer) {
      clearInterval(this.dnsRefreshTimer);
    }
    
    this.dnsRefreshTimer = setInterval(async () => {
      try {
        console.log('🔄 Refreshing DNS bootstrap servers...');
        await this.resolveDNSServers();
      } catch (error) {
        console.warn('⚠️ DNS refresh failed:', error.message);
      }
    }, this.dnsOptions.dnsRefreshInterval);
  }

  /**
   * Stop periodic DNS refresh
   */
  stopDNSRefresh() {
    if (this.dnsRefreshTimer) {
      clearInterval(this.dnsRefreshTimer);
      this.dnsRefreshTimer = null;
    }
  }

  /**
   * Enhanced destroy method
   */
  destroy() {
    this.stopDNSRefresh();
    super.destroy();
  }
}

export default DNSBootstrapClient;