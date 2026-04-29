import { EventEmitter } from 'events';

/**
 * ConnectionProfileDetector - Detects NAT type and connection capabilities
 * 
 * Uses ICE candidate analysis and dual-STUN method to determine:
 * - IPv6 availability
 * - NAT type (open, easy/cone, hard/symmetric)
 * - Port allocation pattern (sequential vs random)
 * 
 * See: .kiro/specs/symmetric-nat-relay/design.md for detailed rationale
 */
export class ConnectionProfileDetector extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      // STUN servers for NAT discovery
      stunServers: options.stunServers || [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
        'stun:stun3.l.google.com:19302'
      ],
      // Timeout for STUN queries
      stunTimeout: options.stunTimeout || 5000,
      // Timeout for ICE gathering
      gatheringTimeout: options.gatheringTimeout || 10000,
      ...options
    };
    
    // Cached profile (detection is expensive)
    this._cachedProfile = null;
    this._cacheTimestamp = null;
    this._cacheMaxAge = options.cacheMaxAge || 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Get the connection profile for this browser
   * Uses cached result if available and not expired
   * 
   * @returns {Promise<ConnectionProfile>} The detected connection profile
   */
  async getConnectionProfile() {
    // Return cached profile if still valid
    if (this._cachedProfile && this._cacheTimestamp) {
      const age = Date.now() - this._cacheTimestamp;
      if (age < this._cacheMaxAge) {
        console.log(`📊 Using cached connection profile (age: ${Math.round(age / 1000)}s)`);
        return this._cachedProfile;
      }
    }
    
    console.log('🔍 Detecting connection profile...');
    
    // Task 6.2: Detect platform/user agent for IPv6 tracking by platform
    const platformInfo = this._detectPlatform();
    
    const profile = {
      hasIPv6: false,
      ipv6Addresses: [],
      ipv4External: null,
      ipv4Host: [],
      natType: 'unknown',
      portPattern: 'unknown',
      portIncrement: null,
      needsRelay: false,
      isIPv6Only: false,        // Task 6.1: True if no native IPv4 connectivity
      hasNAT64: false,          // Task 6.1: True if NAT64 is available for IPv4 access
      nat64Prefix: null,        // Task 6.1: The NAT64 prefix (e.g., '64:ff9b::')
      detectedAt: new Date().toISOString(),
      // Task 6.2: Platform information for IPv6 tracking by user agent/platform
      platform: platformInfo.platform,      // 'windows', 'macos', 'linux', 'android', 'ios', 'unknown'
      browser: platformInfo.browser,        // 'chrome', 'firefox', 'safari', 'edge', 'unknown'
      browserVersion: platformInfo.browserVersion,  // Major version number
      isMobile: platformInfo.isMobile,      // true if mobile device
      userAgent: platformInfo.userAgent     // Raw user agent string (truncated for privacy)
    };
    
    try {
      // Step 1: Gather ICE candidates to detect IPv6 and host addresses
      const candidates = await this._gatherIceCandidates();
      
      // Step 2: Analyze candidates for IPv6 and host addresses
      this._analyzeHostCandidates(candidates, profile);
      
      // Step 3: Analyze srflx candidates for NAT type
      await this._analyzeNatType(candidates, profile);
      
      // Step 4: Detect port allocation pattern
      await this._detectPortPattern(profile);
      
      // Step 5: Detect IPv6-only network with NAT64 (Task 6.1)
      await this._detectNAT64(profile);
      
      // Step 6: Determine if relay is needed
      profile.needsRelay = profile.natType === 'hard' || profile.natType === 'unknown';
      
      // Cache the result
      this._cachedProfile = profile;
      this._cacheTimestamp = Date.now();
      
      console.log('📊 Connection profile detected:', {
        hasIPv6: profile.hasIPv6,
        natType: profile.natType,
        portPattern: profile.portPattern,
        needsRelay: profile.needsRelay,
        isIPv6Only: profile.isIPv6Only,
        hasNAT64: profile.hasNAT64
      });
      
      this.emit('profileDetected', profile);
      return profile;
      
    } catch (error) {
      console.error('❌ Failed to detect connection profile:', error);
      profile.error = error.message;
      return profile;
    }
  }


  /**
   * Gather ICE candidates using a temporary RTCPeerConnection
   * @private
   */
  async _gatherIceCandidates() {
    return new Promise((resolve, reject) => {
      const candidates = [];
      
      // Check if RTCPeerConnection is available (browser environment)
      if (typeof RTCPeerConnection === 'undefined') {
        console.log('📊 RTCPeerConnection not available (Node.js environment)');
        resolve(candidates);
        return;
      }
      
      const pc = new RTCPeerConnection({
        iceServers: this.options.stunServers.map(url => ({ urls: url })),
        iceTransportPolicy: 'all',
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
        iceCandidatePoolSize: 10
      });
      
      const timeout = setTimeout(() => {
        pc.close();
        resolve(candidates);
      }, this.options.gatheringTimeout);
      
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          candidates.push(event.candidate);
          console.log(`🧊 ICE candidate: ${event.candidate.type} - ${event.candidate.address}:${event.candidate.port}`);
        } else {
          // ICE gathering complete
          clearTimeout(timeout);
          pc.close();
          console.log(`🏁 ICE gathering complete: ${candidates.length} candidates`);
          resolve(candidates);
        }
      };
      
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timeout);
          pc.close();
          resolve(candidates);
        }
      };
      
      // Create a data channel to trigger ICE gathering
      pc.createDataChannel('profile-detection');
      
      // Create offer to start ICE gathering
      pc.createOffer()
        .then(offer => pc.setLocalDescription(offer))
        .catch(error => {
          clearTimeout(timeout);
          pc.close();
          reject(error);
        });
    });
  }

  /**
   * Analyze host candidates for IPv6 and local addresses
   * @private
   */
  _analyzeHostCandidates(candidates, profile) {
    for (const candidate of candidates) {
      if (candidate.type !== 'host') continue;
      
      const address = candidate.address;
      if (!address) continue;
      
      // Check for IPv6 global addresses (2xxx: prefix)
      if (this._isGlobalIPv6(address)) {
        profile.hasIPv6 = true;
        if (!profile.ipv6Addresses.includes(address)) {
          profile.ipv6Addresses.push(address);
        }
        console.log(`🌐 Found global IPv6: ${address}`);
      }
      
      // Track IPv4 host addresses
      if (this._isIPv4(address) && !this._isPrivateIPv4(address)) {
        // Public IPv4 as host candidate means no NAT (open)
        profile.natType = 'open';
        profile.ipv4External = address;
        console.log(`🌐 Found public IPv4 host: ${address} (no NAT)`);
      } else if (this._isIPv4(address)) {
        profile.ipv4Host.push(address);
      }
    }
  }

  /**
   * Analyze NAT type using the dual-STUN method (Tailscale technique)
   * 
   * The key insight: When a browser queries multiple STUN servers from the SAME socket,
   * the NAT will assign external ports. The pattern reveals the NAT type:
   * 
   * - Endpoint-Independent Mapping (Easy/Cone NAT): Same external port for all destinations
   *   → Direct WebRTC connections usually work
   * 
   * - Endpoint-Dependent Mapping (Hard/Symmetric NAT): Different external port per destination
   *   → Direct connections often fail, may need relay
   * 
   * WebRTC's ICE gathering queries all configured STUN servers from the same socket,
   * so we can analyze the srflx candidates to detect the NAT behavior.
   * 
   * @private
   */
  async _analyzeNatType(candidates, profile) {
    // If already detected as open (public IP), skip NAT analysis
    if (profile.natType === 'open') return;
    
    // Collect srflx (server reflexive) candidates - these come from STUN responses
    const srflxCandidates = candidates.filter(c => c.type === 'srflx');
    
    if (srflxCandidates.length === 0) {
      console.log('⚠️ No srflx candidates found - NAT type unknown (may be behind strict firewall)');
      profile.natType = 'unknown';
      return;
    }
    
    console.log(`🔍 Analyzing ${srflxCandidates.length} srflx candidates for NAT type detection...`);
    
    // Extract external IP:port pairs with their local (related) addresses
    const externalEndpoints = srflxCandidates.map(c => ({
      address: c.address,
      port: c.port,
      relatedAddress: c.relatedAddress,
      relatedPort: c.relatedPort,
      protocol: c.protocol || 'udp',
      // The foundation string encodes the STUN server used (different foundation = different server)
      foundation: c.foundation
    }));
    
    // Set external IPv4 from first srflx candidate
    const ipv4Srflx = externalEndpoints.find(e => this._isIPv4(e.address));
    if (ipv4Srflx) {
      profile.ipv4External = ipv4Srflx.address;
    }
    
    // DUAL-STUN METHOD:
    // Group srflx candidates by their local socket (relatedAddress:relatedPort + protocol)
    // If the same local socket maps to different external ports when querying different STUN servers,
    // it's a symmetric NAT (endpoint-dependent mapping)
    const byLocalSocket = new Map();
    
    for (const endpoint of externalEndpoints) {
      // Create a key that identifies the local socket
      const localSocketKey = `${endpoint.relatedAddress || 'unknown'}:${endpoint.relatedPort || 'unknown'}:${endpoint.protocol}`;
      
      if (!byLocalSocket.has(localSocketKey)) {
        byLocalSocket.set(localSocketKey, {
          localAddress: endpoint.relatedAddress,
          localPort: endpoint.relatedPort,
          protocol: endpoint.protocol,
          externalMappings: []
        });
      }
      
      byLocalSocket.get(localSocketKey).externalMappings.push({
        externalAddress: endpoint.address,
        externalPort: endpoint.port,
        foundation: endpoint.foundation
      });
    }
    
    // Analyze each local socket's mappings
    let isSymmetric = false;
    let analysisDetails = [];
    
    for (const [localSocketKey, socketData] of byLocalSocket) {
      const mappings = socketData.externalMappings;
      const uniqueExternalPorts = [...new Set(mappings.map(m => m.externalPort))];
      const uniqueFoundations = [...new Set(mappings.map(m => m.foundation))];
      
      // Log the mapping details for debugging
      console.log(`📊 Local socket ${localSocketKey}:`);
      console.log(`   → ${mappings.length} STUN responses from ${uniqueFoundations.length} different servers`);
      console.log(`   → External ports: ${uniqueExternalPorts.join(', ')}`);
      
      analysisDetails.push({
        localSocket: localSocketKey,
        stunServerCount: uniqueFoundations.length,
        externalPorts: uniqueExternalPorts
      });
      
      // DUAL-STUN DETECTION:
      // If we got responses from multiple STUN servers (different foundations)
      // AND they returned different external ports, it's symmetric NAT
      if (uniqueFoundations.length > 1 && uniqueExternalPorts.length > 1) {
        console.log(`🔒 SYMMETRIC NAT DETECTED: Same local socket (${localSocketKey}) mapped to different external ports`);
        console.log(`   → This indicates endpoint-dependent mapping (hard NAT)`);
        isSymmetric = true;
      }
    }
    
    // Store analysis details in profile for debugging
    profile._natAnalysis = {
      method: 'dual-stun',
      srflxCount: srflxCandidates.length,
      localSockets: analysisDetails,
      conclusion: isSymmetric ? 'endpoint-dependent' : 'endpoint-independent'
    };
    
    if (isSymmetric) {
      profile.natType = 'hard';
      console.log('🔒 NAT Type: HARD (symmetric/endpoint-dependent mapping)');
      console.log('   → Direct browser-to-browser connections may fail');
      console.log('   → WebSocket relay recommended as fallback');
    } else if (byLocalSocket.size > 0) {
      profile.natType = 'easy';
      console.log('🔓 NAT Type: EASY (cone/endpoint-independent mapping)');
      console.log('   → Direct browser-to-browser connections should work');
    } else {
      profile.natType = 'unknown';
      console.log('⚠️ NAT Type: UNKNOWN (insufficient data for analysis)');
    }
  }


  /**
   * Detect port allocation pattern by querying multiple STUN servers
   * Sequential allocation (port+1, port+2) is common and can be exploited for prediction
   * @private
   */
  async _detectPortPattern(profile) {
    // Skip if no NAT or already determined to be open
    if (profile.natType === 'open') {
      profile.portPattern = 'none';
      return;
    }
    
    // Check if RTCPeerConnection is available
    if (typeof RTCPeerConnection === 'undefined') {
      profile.portPattern = 'unknown';
      return;
    }
    
    try {
      // Query 3 different STUN servers rapidly to detect port allocation pattern
      const ports = await Promise.all([
        this._queryStunPort(this.options.stunServers[0]),
        this._queryStunPort(this.options.stunServers[1]),
        this._queryStunPort(this.options.stunServers[2])
      ]);
      
      // Filter out failed queries
      const validPorts = ports.filter(p => p !== null);
      
      if (validPorts.length < 2) {
        console.log('⚠️ Not enough STUN responses to detect port pattern');
        profile.portPattern = 'unknown';
        return;
      }
      
      // Sort ports to analyze pattern
      validPorts.sort((a, b) => a - b);
      
      // Calculate differences between consecutive ports
      const diffs = [];
      for (let i = 1; i < validPorts.length; i++) {
        diffs.push(validPorts[i] - validPorts[i - 1]);
      }
      
      // Check if sequential (differences are small and consistent)
      const isSequential = diffs.every(d => d >= 1 && d <= 10);
      
      if (isSequential) {
        const avgIncrement = Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length);
        profile.portPattern = 'sequential';
        profile.portIncrement = avgIncrement;
        console.log(`📊 Sequential port allocation detected (avg increment: ${avgIncrement})`);
      } else {
        profile.portPattern = 'random';
        console.log('📊 Random port allocation detected');
      }
      
    } catch (error) {
      console.warn('⚠️ Failed to detect port pattern:', error.message);
      profile.portPattern = 'unknown';
    }
  }

  /**
   * Query a single STUN server to get the external port
   * @private
   */
  async _queryStunPort(stunServer) {
    return new Promise((resolve) => {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: stunServer }],
        iceTransportPolicy: 'all',
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require'
      });
      
      const timeout = setTimeout(() => {
        pc.close();
        resolve(null);
      }, this.options.stunTimeout);
      
      let resolved = false;
      
      pc.onicecandidate = (event) => {
        if (resolved) return;
        
        if (event.candidate && event.candidate.type === 'srflx') {
          resolved = true;
          clearTimeout(timeout);
          pc.close();
          resolve(event.candidate.port);
        }
      };
      
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete' && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          pc.close();
          resolve(null);
        }
      };
      
      // Create data channel and offer to trigger ICE
      pc.createDataChannel('stun-query');
      pc.createOffer()
        .then(offer => pc.setLocalDescription(offer))
        .catch(() => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            pc.close();
            resolve(null);
          }
        });
    });
  }

  /**
   * Detect IPv6-only network with NAT64 (Task 6.1)
   * 
   * NAT64 allows IPv6-only clients to communicate with IPv4-only servers by
   * translating IPv6 addresses to IPv4 addresses. Detection uses the standard
   * method of querying 'ipv4only.arpa' DNS name:
   * 
   * - On dual-stack networks: resolves to 192.0.0.170 and 192.0.0.171 (IPv4)
   * - On IPv6-only with NAT64: resolves to synthesized IPv6 addresses like
   *   64:ff9b::192.0.0.170 (the prefix reveals the NAT64 prefix)
   * 
   * This is the IETF-standard method defined in RFC 7050.
   * 
   * @private
   */
  async _detectNAT64(profile) {
    // Only relevant if we have IPv6 but no native IPv4
    // If we have IPv4 host candidates or external IPv4, we're not IPv6-only
    if (profile.ipv4Host.length > 0 || profile.ipv4External) {
      console.log('📊 Native IPv4 available - not an IPv6-only network');
      profile.isIPv6Only = false;
      profile.hasNAT64 = false;
      return;
    }
    
    // If we don't have IPv6 either, we can't detect NAT64
    if (!profile.hasIPv6) {
      console.log('📊 No IPv6 available - cannot detect NAT64');
      profile.isIPv6Only = false;
      profile.hasNAT64 = false;
      return;
    }
    
    // We have IPv6 but no IPv4 - this might be an IPv6-only network
    profile.isIPv6Only = true;
    console.log('🔍 Detected IPv6-only network, checking for NAT64...');
    
    try {
      // Use DNS-over-HTTPS to query ipv4only.arpa
      // This is the standard NAT64 detection method (RFC 7050)
      const nat64Result = await this._queryNAT64DNS();
      
      if (nat64Result.hasNAT64) {
        profile.hasNAT64 = true;
        profile.nat64Prefix = nat64Result.prefix;
        console.log(`🌐 NAT64 detected! Prefix: ${nat64Result.prefix}`);
        console.log('   → IPv4 connectivity available via NAT64 translation');
      } else {
        profile.hasNAT64 = false;
        console.log('⚠️ IPv6-only network WITHOUT NAT64 - limited IPv4 connectivity');
      }
    } catch (error) {
      console.warn('⚠️ NAT64 detection failed:', error.message);
      profile.hasNAT64 = false;
    }
  }

  /**
   * Query DNS for ipv4only.arpa to detect NAT64
   * 
   * The ipv4only.arpa domain is specifically designed for NAT64 detection:
   * - It has A records pointing to 192.0.0.170 and 192.0.0.171
   * - On IPv6-only networks with NAT64, DNS64 synthesizes AAAA records
   * - The synthesized IPv6 addresses reveal the NAT64 prefix
   * 
   * We use DNS-over-HTTPS (DoH) because browsers don't have direct DNS access.
   * 
   * @private
   * @returns {Promise<{hasNAT64: boolean, prefix: string|null}>}
   */
  async _queryNAT64DNS() {
    // Well-known IPv4 addresses for ipv4only.arpa (RFC 7050)
    const EXPECTED_IPV4 = ['192.0.0.170', '192.0.0.171'];
    
    try {
      // Use Cloudflare's DNS-over-HTTPS to query AAAA records for ipv4only.arpa
      // This is the standard way to detect NAT64 from a browser
      const response = await fetch(
        'https://cloudflare-dns.com/dns-query?name=ipv4only.arpa&type=AAAA',
        {
          headers: {
            'Accept': 'application/dns-json'
          }
        }
      );
      
      if (!response.ok) {
        throw new Error(`DNS query failed: ${response.status}`);
      }
      
      const data = await response.json();
      
      // Check if we got AAAA records (IPv6 addresses)
      if (!data.Answer || data.Answer.length === 0) {
        // No AAAA records - either no NAT64 or DNS64 not configured
        console.log('📊 No AAAA records for ipv4only.arpa - no NAT64 detected');
        return { hasNAT64: false, prefix: null };
      }
      
      // Extract IPv6 addresses from the response
      const ipv6Addresses = data.Answer
        .filter(record => record.type === 28) // Type 28 = AAAA
        .map(record => record.data);
      
      if (ipv6Addresses.length === 0) {
        return { hasNAT64: false, prefix: null };
      }
      
      console.log(`📊 Got AAAA records for ipv4only.arpa: ${ipv6Addresses.join(', ')}`);
      
      // Extract the NAT64 prefix from the synthesized IPv6 address
      // The format is typically: <prefix>::<ipv4-in-hex> or <prefix>::ffff:<ipv4>
      // Common prefixes: 64:ff9b::/96 (well-known), or operator-specific
      const prefix = this._extractNAT64Prefix(ipv6Addresses[0], EXPECTED_IPV4[0]);
      
      if (prefix) {
        return { hasNAT64: true, prefix };
      }
      
      // If we got AAAA records but couldn't extract prefix, NAT64 is likely present
      // but with an unusual configuration
      console.log('⚠️ Got AAAA records but could not extract NAT64 prefix');
      return { hasNAT64: true, prefix: 'unknown' };
      
    } catch (error) {
      // If DoH fails, try an alternative method using fetch to a known IPv4-only service
      console.log('📊 DoH query failed, trying alternative NAT64 detection...');
      return this._detectNAT64Alternative();
    }
  }

  /**
   * Extract the NAT64 prefix from a synthesized IPv6 address
   * 
   * NAT64 prefixes can be in several formats (RFC 6052):
   * - /96 prefix: prefix::<ipv4> (most common, e.g., 64:ff9b::192.0.0.170)
   * - /64 prefix: prefix:<ipv4-high>::<ipv4-low>
   * - /56, /48, /40, /32 prefixes with various IPv4 embedding positions
   * 
   * We focus on the most common /96 prefix format.
   * 
   * @private
   * @param {string} ipv6Address - The synthesized IPv6 address
   * @param {string} expectedIPv4 - The expected IPv4 address (192.0.0.170)
   * @returns {string|null} The NAT64 prefix or null if not detected
   */
  _extractNAT64Prefix(ipv6Address, expectedIPv4) {
    if (!ipv6Address || !expectedIPv4) return null;
    
    // Check for well-known prefix 64:ff9b::/96 first (most common)
    if (ipv6Address.toLowerCase().startsWith('64:ff9b::')) {
      return '64:ff9b::/96';
    }
    
    // Normalize the IPv6 address (expand :: notation)
    const normalizedIPv6 = this._normalizeIPv6(ipv6Address);
    if (!normalizedIPv6) return null;
    
    // Convert expected IPv4 to hex representation
    const ipv4Parts = expectedIPv4.split('.').map(Number);
    const ipv4Hex = ipv4Parts.map(p => p.toString(16).padStart(2, '0')).join('');
    // 192.0.0.170 -> c00000aa
    
    // For /96 prefix, the IPv4 is in the last 32 bits
    // IPv6 format: xxxx:xxxx:xxxx:xxxx:xxxx:xxxx:AABB:CCDD
    // where AABBCCDD is the IPv4 address in hex
    const ipv6Parts = normalizedIPv6.split(':');
    if (ipv6Parts.length !== 8) return null;
    
    // Check if the last two groups contain the IPv4 address
    const lastTwoGroups = ipv6Parts.slice(-2).join('').toLowerCase();
    const expectedLastTwo = ipv4Hex.toLowerCase();
    
    if (lastTwoGroups === expectedLastTwo) {
      // /96 prefix - first 6 groups are the prefix
      const prefix = ipv6Parts.slice(0, 6).join(':') + '::/96';
      console.log(`📊 Extracted NAT64 /96 prefix: ${prefix}`);
      return prefix;
    }
    
    // Could not determine prefix format
    return null;
  }

  /**
   * Normalize an IPv6 address by expanding :: notation
   * @private
   */
  _normalizeIPv6(address) {
    if (!address) return null;
    
    // Handle :: expansion
    if (address.includes('::')) {
      const parts = address.split('::');
      if (parts.length > 2) return null; // Invalid: multiple ::
      
      const left = parts[0] ? parts[0].split(':') : [];
      const right = parts[1] ? parts[1].split(':') : [];
      
      // Calculate how many zero groups to insert
      const missingGroups = 8 - left.length - right.length;
      if (missingGroups < 0) return null;
      
      const zeros = Array(missingGroups).fill('0000');
      const allParts = [...left, ...zeros, ...right];
      
      // Pad each part to 4 characters
      return allParts.map(p => p.padStart(4, '0')).join(':');
    }
    
    // Already fully expanded
    const parts = address.split(':');
    if (parts.length !== 8) return null;
    
    return parts.map(p => p.padStart(4, '0')).join(':');
  }

  /**
   * Alternative NAT64 detection method using fetch
   * 
   * If DNS-over-HTTPS fails, we can try to detect NAT64 by attempting
   * to connect to a known IPv4-only service. If the connection succeeds
   * on an IPv6-only network, NAT64 must be present.
   * 
   * @private
   * @returns {Promise<{hasNAT64: boolean, prefix: string|null}>}
   */
  async _detectNAT64Alternative() {
    try {
      // Try to fetch from a service that's known to be IPv4-only
      // If this succeeds on an IPv6-only network, NAT64 is working
      // We use a simple connectivity check with a short timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      
      // Use a well-known IPv4-only endpoint
      // Note: This is a heuristic - the endpoint might add IPv6 support later
      const response = await fetch('https://ipv4.google.com/generate_204', {
        method: 'HEAD',
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (response.ok || response.status === 204) {
        // Successfully connected to IPv4-only service from IPv6-only network
        // This means NAT64 is working, but we don't know the prefix
        console.log('📊 NAT64 detected via connectivity test (prefix unknown)');
        return { hasNAT64: true, prefix: 'detected-via-connectivity' };
      }
      
      return { hasNAT64: false, prefix: null };
      
    } catch (error) {
      // Connection failed - either no NAT64 or network issue
      console.log('📊 NAT64 alternative detection failed:', error.message);
      return { hasNAT64: false, prefix: null };
    }
  }

  /**
   * Check if address is a global IPv6 address (2xxx: prefix)
   * @private
   */
  _isGlobalIPv6(address) {
    if (!address) return false;
    // Global unicast addresses start with 2 or 3
    return /^[23][0-9a-f]{3}:/i.test(address);
  }

  /**
   * Check if address is IPv4
   * @private
   */
  _isIPv4(address) {
    if (!address) return false;
    return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address);
  }

  /**
   * Check if address is private IPv4 (RFC 1918)
   * @private
   */
  _isPrivateIPv4(address) {
    if (!this._isIPv4(address)) return false;
    
    const parts = address.split('.').map(Number);
    
    // 10.0.0.0/8
    if (parts[0] === 10) return true;
    
    // 172.16.0.0/12
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    
    // 192.168.0.0/16
    if (parts[0] === 192 && parts[1] === 168) return true;
    
    // 127.0.0.0/8 (loopback)
    if (parts[0] === 127) return true;
    
    // 169.254.0.0/16 (link-local)
    if (parts[0] === 169 && parts[1] === 254) return true;
    
    return false;
  }

  /**
   * Clear the cached profile (force re-detection on next call)
   */
  clearCache() {
    this._cachedProfile = null;
    this._cacheTimestamp = null;
    console.log('📊 Connection profile cache cleared');
  }

  /**
   * Get a summary string for logging
   */
  getProfileSummary(profile) {
    if (!profile) return 'No profile';
    
    const parts = [];
    
    if (profile.hasIPv6) {
      parts.push(`IPv6: ${profile.ipv6Addresses.length} addr`);
    }
    
    if (profile.ipv4External) {
      parts.push(`IPv4: ${profile.ipv4External}`);
    }
    
    parts.push(`NAT: ${profile.natType}`);
    
    if (profile.portPattern !== 'none' && profile.portPattern !== 'unknown') {
      parts.push(`Ports: ${profile.portPattern}${profile.portIncrement ? `(+${profile.portIncrement})` : ''}`);
    }
    
    // Task 6.1: Include IPv6-only and NAT64 status
    if (profile.isIPv6Only) {
      if (profile.hasNAT64) {
        parts.push(`IPv6-only+NAT64${profile.nat64Prefix ? ` (${profile.nat64Prefix})` : ''}`);
      } else {
        parts.push('IPv6-only (no NAT64!)');
      }
    }
    
    if (profile.needsRelay) {
      parts.push('⚠️ NEEDS RELAY');
    }
    
    return parts.join(' | ');
  }

  /**
   * Determine if a direct connection attempt is worth trying based on connection profiles
   * 
   * This uses the port allocation pattern and NAT type to make routing decisions:
   * - Sequential port allocation on symmetric NAT is more predictable
   * - Random port allocation makes direct connections nearly impossible
   * - Easy NAT (cone) should always try direct first
   * - IPv6 on both peers bypasses NAT entirely - skip relay, go direct
   * - IPv6-only networks with NAT64 can still reach IPv4 peers via translation
   * 
   * @param {ConnectionProfile} localProfile - This peer's connection profile
   * @param {ConnectionProfile} [remoteProfile] - Remote peer's profile (if known)
   * @returns {Object} Connection recommendation
   */
  shouldAttemptDirectConnection(localProfile, remoteProfile = null) {
    const result = {
      shouldTryDirect: true,
      confidence: 'high',
      reason: '',
      recommendedStrategy: 'direct-first',
      estimatedSuccessRate: 0.8,
      skipRelay: false,  // Task 6.1: Flag to skip relay entirely for IPv6-capable peers
      useNAT64: false    // Task 6.1: Flag indicating NAT64 translation may be needed
    };

    // No profile means we should try direct (optimistic)
    if (!localProfile) {
      result.reason = 'No local profile available, attempting direct';
      return result;
    }

    // Task 6.1: IPv6 on BOTH peers - skip NAT traversal entirely
    // IPv6 addresses are globally routable, so no NAT hole-punching needed
    // This is the best case scenario - go direct without relay fallback
    if (localProfile.hasIPv6 && remoteProfile && remoteProfile.hasIPv6) {
      result.reason = 'Both peers have IPv6 - NAT traversal not needed, skipping relay';
      result.estimatedSuccessRate = 0.95;
      result.recommendedStrategy = 'ipv6-direct-only';
      result.skipRelay = true;
      console.log('🌐 IPv6 detected on both peers - using direct-only strategy (no relay)');
      return result;
    }

    // Task 6.1: Handle IPv6-only network with NAT64
    // If local is IPv6-only but has NAT64, we can still reach IPv4 peers
    if (localProfile.isIPv6Only && localProfile.hasNAT64) {
      if (remoteProfile && !remoteProfile.hasIPv6) {
        // Remote is IPv4-only, we need NAT64 translation
        result.useNAT64 = true;
        result.reason = 'Local is IPv6-only with NAT64, remote is IPv4 - using NAT64 translation';
        result.estimatedSuccessRate = 0.7; // NAT64 adds some complexity
        result.recommendedStrategy = 'direct-first';
        console.log('🌐 IPv6-only network with NAT64 - can reach IPv4 peer via translation');
        return result;
      }
    }

    // Task 6.1: IPv6-only WITHOUT NAT64 trying to reach IPv4-only peer
    // This is problematic - no direct path possible
    if (localProfile.isIPv6Only && !localProfile.hasNAT64) {
      if (remoteProfile && !remoteProfile.hasIPv6) {
        result.shouldTryDirect = false;
        result.confidence = 'high';
        result.reason = 'Local is IPv6-only without NAT64, remote is IPv4-only - no direct path possible';
        result.recommendedStrategy = 'relay-only';
        result.estimatedSuccessRate = 0.0;
        console.log('⚠️ IPv6-only network without NAT64 cannot reach IPv4-only peer directly');
        return result;
      }
    }

    // Open NAT - always try direct
    if (localProfile.natType === 'open') {
      result.reason = 'Local peer has open NAT (public IP)';
      result.estimatedSuccessRate = 0.95;
      return result;
    }

    // IPv6 available locally - direct connection should work (no NAT)
    // But we don't know if remote has IPv6, so use relay as backup
    if (localProfile.hasIPv6) {
      result.reason = 'Local IPv6 available, NAT traversal not needed (remote IPv6 unknown)';
      result.estimatedSuccessRate = 0.9;
      return result;
    }

    // Easy NAT (cone) - direct usually works
    if (localProfile.natType === 'easy') {
      result.reason = 'Easy NAT (cone) detected, direct connection likely to succeed';
      result.estimatedSuccessRate = 0.85;
      return result;
    }

    // Hard NAT (symmetric) - depends on port pattern and remote peer
    if (localProfile.natType === 'hard') {
      // Check remote peer's NAT type if available
      if (remoteProfile) {
        // Both hard NAT - very difficult
        if (remoteProfile.natType === 'hard') {
          // Sequential ports on both sides gives some hope
          if (localProfile.portPattern === 'sequential' && remoteProfile.portPattern === 'sequential') {
            result.shouldTryDirect = true;
            result.confidence = 'low';
            result.reason = 'Both peers have hard NAT but sequential port allocation - worth trying';
            result.recommendedStrategy = 'relay-first-probe-parallel';
            result.estimatedSuccessRate = 0.3;
            return result;
          }
          
          // Random ports on either side - very unlikely to work
          if (localProfile.portPattern === 'random' || remoteProfile.portPattern === 'random') {
            result.shouldTryDirect = false;
            result.confidence = 'high';
            result.reason = 'Both peers have hard NAT with random port allocation - use relay';
            result.recommendedStrategy = 'relay-only';
            result.estimatedSuccessRate = 0.05;
            return result;
          }
          
          // Unknown pattern - try but expect failure
          result.shouldTryDirect = true;
          result.confidence = 'low';
          result.reason = 'Both peers have hard NAT - direct unlikely but worth trying';
          result.recommendedStrategy = 'relay-first-probe-parallel';
          result.estimatedSuccessRate = 0.2;
          return result;
        }
        
        // Remote has easy NAT - good chance
        if (remoteProfile.natType === 'easy' || remoteProfile.natType === 'open') {
          result.reason = 'Local hard NAT but remote has easy/open NAT - direct may work';
          result.estimatedSuccessRate = 0.6;
          return result;
        }
      }
      
      // No remote profile - use local port pattern to decide
      if (localProfile.portPattern === 'sequential') {
        result.shouldTryDirect = true;
        result.confidence = 'medium';
        result.reason = 'Hard NAT with sequential ports - direct worth attempting';
        result.recommendedStrategy = 'direct-first';
        result.estimatedSuccessRate = 0.5;
        return result;
      }
      
      if (localProfile.portPattern === 'random') {
        result.shouldTryDirect = true;
        result.confidence = 'low';
        result.reason = 'Hard NAT with random ports - direct unlikely, use relay as primary';
        result.recommendedStrategy = 'relay-first-probe-parallel';
        result.estimatedSuccessRate = 0.2;
        return result;
      }
      
      // Unknown pattern
      result.shouldTryDirect = true;
      result.confidence = 'low';
      result.reason = 'Hard NAT with unknown port pattern - try direct but prepare relay';
      result.recommendedStrategy = 'relay-first-probe-parallel';
      result.estimatedSuccessRate = 0.3;
      return result;
    }

    // Unknown NAT type - be optimistic
    result.confidence = 'low';
    result.reason = 'Unknown NAT type - attempting direct';
    result.estimatedSuccessRate = 0.5;
    return result;
  }

  /**
   * Get the recommended connection strategy based on two peers' profiles
   * 
   * Strategies:
   * - 'direct-first': Try WebRTC direct, fall back to relay if it fails
   * - 'relay-first-probe-parallel': Start relay immediately, probe direct in parallel
   * - 'relay-only': Don't bother with direct, use relay exclusively
   * 
   * @param {ConnectionProfile} localProfile - This peer's connection profile
   * @param {ConnectionProfile} remoteProfile - Remote peer's connection profile
   * @returns {string} Recommended strategy
   */
  getRecommendedStrategy(localProfile, remoteProfile) {
    const recommendation = this.shouldAttemptDirectConnection(localProfile, remoteProfile);
    return recommendation.recommendedStrategy;
  }

  /**
   * Detect if both peers have hard NAT (symmetric NAT) from their connection profiles
   * Task 4.3: This is a static helper method that can be used by other components
   * 
   * @param {ConnectionProfile} profileA - Connection profile of peer A
   * @param {ConnectionProfile} profileB - Connection profile of peer B
   * @returns {Object} Detection result with flags and recommendation
   */
  static detectHardNatPair(profileA, profileB) {
    const result = {
      bothHardNat: false,
      peerAHardNat: false,
      peerBHardNat: false,
      shouldAttemptCoordinatedRestart: false,
      estimatedSuccessRate: 0.8,
      reason: ''
    };

    // Check if profiles are available
    if (!profileA || !profileB) {
      result.reason = 'Missing connection profile(s)';
      return result;
    }

    // Detect hard NAT for each peer
    // Hard NAT = symmetric NAT with endpoint-dependent mapping
    result.peerAHardNat = profileA.natType === 'hard';
    result.peerBHardNat = profileB.natType === 'hard';
    result.bothHardNat = result.peerAHardNat && result.peerBHardNat;

    if (result.bothHardNat) {
      // Both peers have hard NAT - direct connection is very difficult
      // Check port allocation patterns to estimate success rate
      const peerASequential = profileA.portPattern === 'sequential';
      const peerBSequential = profileB.portPattern === 'sequential';

      if (peerASequential && peerBSequential) {
        // Sequential port allocation on both sides gives some hope
        result.shouldAttemptCoordinatedRestart = true;
        result.estimatedSuccessRate = 0.3;
        result.reason = 'Both hard NAT with sequential ports - coordinated restart recommended';
      } else if (profileA.portPattern === 'random' || profileB.portPattern === 'random') {
        // Random port allocation makes direct connection nearly impossible
        result.shouldAttemptCoordinatedRestart = true;
        result.estimatedSuccessRate = 0.05;
        result.reason = 'Both hard NAT with random ports - relay strongly recommended';
      } else {
        // Unknown port pattern - try coordinated restart
        result.shouldAttemptCoordinatedRestart = true;
        result.estimatedSuccessRate = 0.2;
        result.reason = 'Both hard NAT with unknown port pattern - coordinated restart may help';
      }
    } else if (result.peerAHardNat || result.peerBHardNat) {
      // One peer has hard NAT, the other has easy/open NAT
      result.estimatedSuccessRate = 0.6;
      result.reason = 'One hard NAT, one easy/open NAT - direct connection may work';
    } else {
      // Neither peer has hard NAT - direct connection should work
      result.estimatedSuccessRate = 0.85;
      result.reason = 'No hard NAT detected - direct connection likely';
    }

    // Check for IPv6 availability which bypasses NAT entirely
    if (profileA.hasIPv6 && profileB.hasIPv6) {
      result.estimatedSuccessRate = Math.max(result.estimatedSuccessRate, 0.9);
      result.reason += ' (IPv6 available on both peers)';
    }

    return result;
  }

  /**
   * Detect platform and browser information from user agent
   * Task 6.2: Track IPv6 availability by user agent / platform
   * 
   * @private
   * @returns {Object} Platform information
   */
  _detectPlatform() {
    const result = {
      platform: 'unknown',
      browser: 'unknown',
      browserVersion: null,
      isMobile: false,
      userAgent: null
    };

    // Check if we're in a browser environment
    if (typeof navigator === 'undefined') {
      result.platform = 'nodejs';
      result.browser = 'nodejs';
      return result;
    }

    const ua = navigator.userAgent || '';
    // Truncate user agent for privacy (keep first 200 chars)
    result.userAgent = ua.length > 200 ? ua.substring(0, 200) + '...' : ua;

    // Detect mobile first (affects platform detection)
    result.isMobile = /Android|iPhone|iPad|iPod|Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);

    // Detect platform/OS
    if (/Windows/i.test(ua)) {
      result.platform = 'windows';
    } else if (/Macintosh|Mac OS X/i.test(ua)) {
      result.platform = 'macos';
    } else if (/Linux/i.test(ua) && !/Android/i.test(ua)) {
      result.platform = 'linux';
    } else if (/Android/i.test(ua)) {
      result.platform = 'android';
    } else if (/iPhone|iPad|iPod/i.test(ua)) {
      result.platform = 'ios';
    } else if (/CrOS/i.test(ua)) {
      result.platform = 'chromeos';
    }

    // Detect browser and version
    // Order matters - check more specific patterns first
    if (/Edg\//i.test(ua)) {
      result.browser = 'edge';
      const match = ua.match(/Edg\/(\d+)/);
      if (match) result.browserVersion = parseInt(match[1], 10);
    } else if (/OPR\//i.test(ua) || /Opera/i.test(ua)) {
      result.browser = 'opera';
      const match = ua.match(/(?:OPR|Opera)\/(\d+)/);
      if (match) result.browserVersion = parseInt(match[1], 10);
    } else if (/Firefox\//i.test(ua)) {
      result.browser = 'firefox';
      const match = ua.match(/Firefox\/(\d+)/);
      if (match) result.browserVersion = parseInt(match[1], 10);
    } else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) {
      result.browser = 'safari';
      const match = ua.match(/Version\/(\d+)/);
      if (match) result.browserVersion = parseInt(match[1], 10);
    } else if (/Chrome\//i.test(ua)) {
      result.browser = 'chrome';
      const match = ua.match(/Chrome\/(\d+)/);
      if (match) result.browserVersion = parseInt(match[1], 10);
    } else if (/MSIE|Trident/i.test(ua)) {
      result.browser = 'ie';
      const match = ua.match(/(?:MSIE |rv:)(\d+)/);
      if (match) result.browserVersion = parseInt(match[1], 10);
    }

    return result;
  }

  /**
   * Get platform category for aggregated metrics
   * Groups similar platforms together for cleaner reporting
   * 
   * @param {string} platform - The detected platform
   * @param {boolean} isMobile - Whether the device is mobile
   * @returns {string} Platform category
   */
  static getPlatformCategory(platform, isMobile) {
    if (isMobile) {
      if (platform === 'android') return 'mobile-android';
      if (platform === 'ios') return 'mobile-ios';
      return 'mobile-other';
    }
    
    if (platform === 'windows') return 'desktop-windows';
    if (platform === 'macos') return 'desktop-macos';
    if (platform === 'linux') return 'desktop-linux';
    if (platform === 'chromeos') return 'desktop-chromeos';
    if (platform === 'nodejs') return 'server-nodejs';
    
    return 'unknown';
  }
}

/**
 * @typedef {Object} ConnectionProfile
 * @property {boolean} hasIPv6 - Whether global IPv6 addresses are available
 * @property {string[]} ipv6Addresses - List of global IPv6 addresses
 * @property {string|null} ipv4External - External IPv4 address from STUN
 * @property {string[]} ipv4Host - Local IPv4 host addresses
 * @property {'open'|'easy'|'hard'|'unknown'} natType - Detected NAT type
 *   - 'open': No NAT (public IP as host candidate)
 *   - 'easy': Endpoint-Independent Mapping (cone NAT) - direct connections usually work
 *   - 'hard': Endpoint-Dependent Mapping (symmetric NAT) - may need relay
 *   - 'unknown': Could not determine NAT type
 * @property {'none'|'sequential'|'random'|'unknown'} portPattern - Port allocation pattern
 * @property {number|null} portIncrement - Average port increment if sequential
 * @property {boolean} needsRelay - Whether this peer likely needs relay for browser-to-browser
 * @property {boolean} isIPv6Only - Task 6.1: True if no native IPv4 connectivity (IPv6-only network)
 * @property {boolean} hasNAT64 - Task 6.1: True if NAT64 is available for IPv4 access on IPv6-only network
 * @property {string|null} nat64Prefix - Task 6.1: The NAT64 prefix (e.g., '64:ff9b::/96') if detected
 * @property {string} detectedAt - ISO timestamp of detection
 * @property {string} platform - Task 6.2: Platform/OS ('windows', 'macos', 'linux', 'android', 'ios', 'chromeos', 'nodejs', 'unknown')
 * @property {string} browser - Task 6.2: Browser name ('chrome', 'firefox', 'safari', 'edge', 'opera', 'ie', 'nodejs', 'unknown')
 * @property {number|null} browserVersion - Task 6.2: Major browser version number
 * @property {boolean} isMobile - Task 6.2: Whether the device is mobile
 * @property {string|null} userAgent - Task 6.2: Truncated user agent string (for debugging)
 * @property {Object} [_natAnalysis] - Internal debugging info about NAT detection
 * @property {string} _natAnalysis.method - Detection method used ('dual-stun')
 * @property {number} _natAnalysis.srflxCount - Number of srflx candidates analyzed
 * @property {Array} _natAnalysis.localSockets - Per-socket analysis details
 * @property {string} _natAnalysis.conclusion - 'endpoint-dependent' or 'endpoint-independent'
 * @property {string} [error] - Error message if detection failed
 */

/**
 * @typedef {Object} ConnectionRecommendation
 * @property {boolean} shouldTryDirect - Whether to attempt direct WebRTC connection
 * @property {'high'|'medium'|'low'} confidence - Confidence level in the recommendation
 * @property {string} reason - Human-readable explanation for the recommendation
 * @property {'direct-first'|'relay-first-probe-parallel'|'relay-only'|'ipv6-direct-only'} recommendedStrategy - Recommended connection strategy
 *   - 'direct-first': Try WebRTC direct, fall back to relay if it fails
 *   - 'relay-first-probe-parallel': Start relay immediately, probe direct in parallel
 *   - 'relay-only': Don't bother with direct, use relay exclusively
 *   - 'ipv6-direct-only': Both peers have IPv6, skip relay entirely (Task 6.1)
 * @property {number} estimatedSuccessRate - Estimated probability of direct connection success (0-1)
 * @property {boolean} [skipRelay] - Task 6.1: If true, skip relay entirely (IPv6-capable peers)
 * @property {boolean} [useNAT64] - Task 6.1: If true, NAT64 translation may be needed for IPv4 connectivity
 */

// Export singleton instance for convenience
export const connectionProfileDetector = new ConnectionProfileDetector();

export default ConnectionProfileDetector;
