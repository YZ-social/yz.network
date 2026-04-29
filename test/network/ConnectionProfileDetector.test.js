import { ConnectionProfileDetector } from '../../src/network/ConnectionProfileDetector.js';

describe('ConnectionProfileDetector', () => {
  let detector;

  beforeEach(() => {
    detector = new ConnectionProfileDetector();
  });

  describe('Port Pattern Detection Logic', () => {
    it('should detect sequential port allocation', () => {
      // Simulate sequential ports (typical increment of 1-10)
      const ports = [54481, 54482, 54483];
      const validPorts = ports.filter(p => p !== null);
      validPorts.sort((a, b) => a - b);
      
      const diffs = [];
      for (let i = 1; i < validPorts.length; i++) {
        diffs.push(validPorts[i] - validPorts[i - 1]);
      }
      
      const isSequential = diffs.every(d => d >= 1 && d <= 10);
      expect(isSequential).toBe(true);
      
      const avgIncrement = Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length);
      expect(avgIncrement).toBe(1);
    });

    it('should detect random port allocation', () => {
      // Simulate random ports (large differences)
      const ports = [54481, 61234, 49876];
      const validPorts = ports.filter(p => p !== null);
      validPorts.sort((a, b) => a - b);
      
      const diffs = [];
      for (let i = 1; i < validPorts.length; i++) {
        diffs.push(validPorts[i] - validPorts[i - 1]);
      }
      
      const isSequential = diffs.every(d => d >= 1 && d <= 10);
      expect(isSequential).toBe(false);
    });

    it('should handle sequential ports with larger increments', () => {
      // Some NATs use increments of 2-5
      const ports = [54480, 54485, 54490];
      const validPorts = ports.filter(p => p !== null);
      validPorts.sort((a, b) => a - b);
      
      const diffs = [];
      for (let i = 1; i < validPorts.length; i++) {
        diffs.push(validPorts[i] - validPorts[i - 1]);
      }
      
      const isSequential = diffs.every(d => d >= 1 && d <= 10);
      expect(isSequential).toBe(true);
      
      const avgIncrement = Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length);
      expect(avgIncrement).toBe(5);
    });
  });

  describe('shouldAttemptDirectConnection', () => {
    it('should recommend direct for open NAT', () => {
      const profile = { natType: 'open', portPattern: 'none' };
      const result = detector.shouldAttemptDirectConnection(profile);
      
      expect(result.shouldTryDirect).toBe(true);
      expect(result.confidence).toBe('high');
      expect(result.estimatedSuccessRate).toBeGreaterThan(0.9);
    });

    it('should recommend direct for IPv6 availability', () => {
      const profile = { natType: 'hard', hasIPv6: true, portPattern: 'random' };
      const result = detector.shouldAttemptDirectConnection(profile);
      
      expect(result.shouldTryDirect).toBe(true);
      expect(result.estimatedSuccessRate).toBeGreaterThan(0.8);
    });

    it('should recommend ipv6-direct-only when both peers have IPv6 (Task 6.1)', () => {
      const localProfile = { natType: 'hard', hasIPv6: true, portPattern: 'random', ipv6Addresses: ['2001:db8::1'] };
      const remoteProfile = { natType: 'hard', hasIPv6: true, portPattern: 'random', ipv6Addresses: ['2001:db8::2'] };
      const result = detector.shouldAttemptDirectConnection(localProfile, remoteProfile);
      
      expect(result.shouldTryDirect).toBe(true);
      expect(result.recommendedStrategy).toBe('ipv6-direct-only');
      expect(result.skipRelay).toBe(true);
      expect(result.estimatedSuccessRate).toBeGreaterThan(0.9);
      expect(result.reason).toContain('Both peers have IPv6');
    });

    it('should not use ipv6-direct-only when only local has IPv6', () => {
      const localProfile = { natType: 'hard', hasIPv6: true, portPattern: 'random' };
      const remoteProfile = { natType: 'hard', hasIPv6: false, portPattern: 'random' };
      const result = detector.shouldAttemptDirectConnection(localProfile, remoteProfile);
      
      // Should fall through to hard NAT handling, not ipv6-direct-only
      expect(result.recommendedStrategy).not.toBe('ipv6-direct-only');
      expect(result.skipRelay).toBeFalsy();
    });

    it('should not use ipv6-direct-only when only remote has IPv6', () => {
      const localProfile = { natType: 'hard', hasIPv6: false, portPattern: 'random' };
      const remoteProfile = { natType: 'hard', hasIPv6: true, portPattern: 'random' };
      const result = detector.shouldAttemptDirectConnection(localProfile, remoteProfile);
      
      // Should fall through to hard NAT handling, not ipv6-direct-only
      expect(result.recommendedStrategy).not.toBe('ipv6-direct-only');
      expect(result.skipRelay).toBeFalsy();
    });

    it('should recommend direct for easy NAT', () => {
      const profile = { natType: 'easy', portPattern: 'sequential' };
      const result = detector.shouldAttemptDirectConnection(profile);
      
      expect(result.shouldTryDirect).toBe(true);
      expect(result.confidence).toBe('high');
      expect(result.estimatedSuccessRate).toBeGreaterThan(0.8);
    });

    it('should recommend relay-first for hard NAT with random ports', () => {
      const localProfile = { natType: 'hard', portPattern: 'random', hasIPv6: false };
      const remoteProfile = { natType: 'hard', portPattern: 'random' };
      const result = detector.shouldAttemptDirectConnection(localProfile, remoteProfile);
      
      expect(result.shouldTryDirect).toBe(false);
      expect(result.recommendedStrategy).toBe('relay-only');
      expect(result.estimatedSuccessRate).toBeLessThan(0.1);
    });

    it('should give some hope for hard NAT with sequential ports on both sides', () => {
      const localProfile = { natType: 'hard', portPattern: 'sequential', hasIPv6: false };
      const remoteProfile = { natType: 'hard', portPattern: 'sequential' };
      const result = detector.shouldAttemptDirectConnection(localProfile, remoteProfile);
      
      expect(result.shouldTryDirect).toBe(true);
      expect(result.confidence).toBe('low');
      expect(result.recommendedStrategy).toBe('relay-first-probe-parallel');
      expect(result.estimatedSuccessRate).toBeGreaterThan(0.2);
    });

    it('should recommend direct when local hard NAT but remote easy', () => {
      const localProfile = { natType: 'hard', portPattern: 'random', hasIPv6: false };
      const remoteProfile = { natType: 'easy', portPattern: 'sequential' };
      const result = detector.shouldAttemptDirectConnection(localProfile, remoteProfile);
      
      expect(result.shouldTryDirect).toBe(true);
      expect(result.estimatedSuccessRate).toBeGreaterThan(0.5);
    });

    it('should handle null profile gracefully', () => {
      const result = detector.shouldAttemptDirectConnection(null);
      
      expect(result.shouldTryDirect).toBe(true);
      expect(result.reason).toContain('No local profile');
    });

    it('should handle unknown NAT type', () => {
      const profile = { natType: 'unknown', portPattern: 'unknown', hasIPv6: false };
      const result = detector.shouldAttemptDirectConnection(profile);
      
      expect(result.shouldTryDirect).toBe(true);
      expect(result.confidence).toBe('low');
    });
  });

  describe('getRecommendedStrategy', () => {
    it('should return direct-first for easy NAT pairs', () => {
      const local = { natType: 'easy', portPattern: 'sequential', hasIPv6: false };
      const remote = { natType: 'easy', portPattern: 'sequential' };
      
      const strategy = detector.getRecommendedStrategy(local, remote);
      expect(strategy).toBe('direct-first');
    });

    it('should return relay-only for hard NAT with random ports', () => {
      const local = { natType: 'hard', portPattern: 'random', hasIPv6: false };
      const remote = { natType: 'hard', portPattern: 'random' };
      
      const strategy = detector.getRecommendedStrategy(local, remote);
      expect(strategy).toBe('relay-only');
    });

    it('should return relay-first-probe-parallel for hard NAT with sequential ports', () => {
      const local = { natType: 'hard', portPattern: 'sequential', hasIPv6: false };
      const remote = { natType: 'hard', portPattern: 'sequential' };
      
      const strategy = detector.getRecommendedStrategy(local, remote);
      expect(strategy).toBe('relay-first-probe-parallel');
    });
  });

  describe('getProfileSummary', () => {
    it('should format profile with all fields', () => {
      const profile = {
        hasIPv6: true,
        ipv6Addresses: ['2001:db8::1', '2001:db8::2'],
        ipv4External: '203.0.113.1',
        natType: 'easy',
        portPattern: 'sequential',
        portIncrement: 2,
        needsRelay: false
      };
      
      const summary = detector.getProfileSummary(profile);
      
      expect(summary).toContain('IPv6: 2 addr');
      expect(summary).toContain('IPv4: 203.0.113.1');
      expect(summary).toContain('NAT: easy');
      expect(summary).toContain('Ports: sequential(+2)');
      expect(summary).not.toContain('NEEDS RELAY');
    });

    it('should indicate when relay is needed', () => {
      const profile = {
        hasIPv6: false,
        ipv6Addresses: [],
        ipv4External: '203.0.113.1',
        natType: 'hard',
        portPattern: 'random',
        needsRelay: true
      };
      
      const summary = detector.getProfileSummary(profile);
      
      expect(summary).toContain('NAT: hard');
      expect(summary).toContain('NEEDS RELAY');
    });

    it('should handle null profile', () => {
      const summary = detector.getProfileSummary(null);
      expect(summary).toBe('No profile');
    });
  });

  describe('IPv6 Detection', () => {
    it('should identify global IPv6 addresses', () => {
      expect(detector._isGlobalIPv6('2001:db8::1')).toBe(true);
      expect(detector._isGlobalIPv6('2607:f8b0:4004:800::200e')).toBe(true);
      expect(detector._isGlobalIPv6('3ffe:1900:4545:3::200:f8ff:fe21:67cf')).toBe(true);
    });

    it('should reject non-global IPv6 addresses', () => {
      expect(detector._isGlobalIPv6('fe80::1')).toBe(false); // Link-local
      expect(detector._isGlobalIPv6('::1')).toBe(false); // Loopback
      expect(detector._isGlobalIPv6('fc00::1')).toBe(false); // Unique local
    });

    it('should reject IPv4 addresses', () => {
      expect(detector._isGlobalIPv6('192.168.1.1')).toBe(false);
      expect(detector._isGlobalIPv6('10.0.0.1')).toBe(false);
    });
  });

  describe('IPv4 Detection', () => {
    it('should identify IPv4 addresses', () => {
      expect(detector._isIPv4('192.168.1.1')).toBe(true);
      expect(detector._isIPv4('10.0.0.1')).toBe(true);
      expect(detector._isIPv4('203.0.113.1')).toBe(true);
    });

    it('should reject IPv6 addresses', () => {
      expect(detector._isIPv4('2001:db8::1')).toBe(false);
      expect(detector._isIPv4('::1')).toBe(false);
    });

    it('should identify private IPv4 addresses', () => {
      expect(detector._isPrivateIPv4('10.0.0.1')).toBe(true);
      expect(detector._isPrivateIPv4('10.255.255.255')).toBe(true);
      expect(detector._isPrivateIPv4('172.16.0.1')).toBe(true);
      expect(detector._isPrivateIPv4('172.31.255.255')).toBe(true);
      expect(detector._isPrivateIPv4('192.168.0.1')).toBe(true);
      expect(detector._isPrivateIPv4('192.168.255.255')).toBe(true);
      expect(detector._isPrivateIPv4('127.0.0.1')).toBe(true);
      expect(detector._isPrivateIPv4('169.254.1.1')).toBe(true);
    });

    it('should identify public IPv4 addresses', () => {
      expect(detector._isPrivateIPv4('203.0.113.1')).toBe(false);
      expect(detector._isPrivateIPv4('8.8.8.8')).toBe(false);
      expect(detector._isPrivateIPv4('1.1.1.1')).toBe(false);
    });
  });

  describe('Cache Management', () => {
    it('should clear cache', () => {
      detector._cachedProfile = { natType: 'easy' };
      detector._cacheTimestamp = Date.now();
      
      detector.clearCache();
      
      expect(detector._cachedProfile).toBeNull();
      expect(detector._cacheTimestamp).toBeNull();
    });
  });

  describe('NAT64 Detection (Task 6.1)', () => {
    describe('IPv6 Normalization', () => {
      it('should normalize fully expanded IPv6 addresses', () => {
        const result = detector._normalizeIPv6('2001:0db8:0000:0000:0000:0000:0000:0001');
        expect(result).toBe('2001:0db8:0000:0000:0000:0000:0000:0001');
      });

      it('should expand :: notation at the end', () => {
        const result = detector._normalizeIPv6('2001:db8::1');
        expect(result).toBe('2001:0db8:0000:0000:0000:0000:0000:0001');
      });

      it('should expand :: notation in the middle', () => {
        const result = detector._normalizeIPv6('2001:db8::1:2');
        expect(result).toBe('2001:0db8:0000:0000:0000:0000:0001:0002');
      });

      it('should expand :: notation at the start', () => {
        const result = detector._normalizeIPv6('::1');
        expect(result).toBe('0000:0000:0000:0000:0000:0000:0000:0001');
      });

      it('should handle well-known NAT64 prefix', () => {
        // 64:ff9b::192.0.0.170 in hex is 64:ff9b::c000:00aa
        const result = detector._normalizeIPv6('64:ff9b::c000:aa');
        expect(result).toBe('0064:ff9b:0000:0000:0000:0000:c000:00aa');
      });

      it('should return null for invalid addresses', () => {
        expect(detector._normalizeIPv6(null)).toBeNull();
        expect(detector._normalizeIPv6('')).toBeNull();
        expect(detector._normalizeIPv6('invalid')).toBeNull();
      });

      it('should reject addresses with multiple ::', () => {
        expect(detector._normalizeIPv6('2001::db8::1')).toBeNull();
      });
    });

    describe('NAT64 Prefix Extraction', () => {
      it('should extract /96 prefix from synthesized address', () => {
        // 192.0.0.170 = 0xc0.0x00.0x00.0xaa = c00000aa
        // With 64:ff9b::/96 prefix: 64:ff9b::c000:00aa
        const prefix = detector._extractNAT64Prefix('64:ff9b::c000:aa', '192.0.0.170');
        expect(prefix).toBe('64:ff9b::/96');
      });

      it('should extract custom /96 prefix', () => {
        // Custom prefix 2001:db8:64::/96 with 192.0.0.170
        // Full address: 2001:db8:64::c000:00aa
        const prefix = detector._extractNAT64Prefix('2001:db8:64::c000:aa', '192.0.0.170');
        expect(prefix).toBe('2001:0db8:0064:0000:0000:0000::/96');
      });

      it('should return null for non-matching addresses', () => {
        const prefix = detector._extractNAT64Prefix('2001:db8::1', '192.0.0.170');
        expect(prefix).toBeNull();
      });

      it('should handle null inputs', () => {
        expect(detector._extractNAT64Prefix(null, '192.0.0.170')).toBeNull();
        expect(detector._extractNAT64Prefix('64:ff9b::c000:aa', null)).toBeNull();
      });
    });

    describe('shouldAttemptDirectConnection with NAT64', () => {
      it('should use NAT64 when local is IPv6-only with NAT64 and remote is IPv4-only', () => {
        const localProfile = {
          natType: 'unknown',
          hasIPv6: true,
          isIPv6Only: true,
          hasNAT64: true,
          nat64Prefix: '64:ff9b::/96',
          ipv4Host: [],
          ipv4External: null
        };
        const remoteProfile = {
          natType: 'easy',
          hasIPv6: false,
          isIPv6Only: false,
          ipv4External: '203.0.113.1'
        };
        
        const result = detector.shouldAttemptDirectConnection(localProfile, remoteProfile);
        
        expect(result.useNAT64).toBe(true);
        expect(result.shouldTryDirect).toBe(true);
        expect(result.reason).toContain('NAT64');
        expect(result.estimatedSuccessRate).toBe(0.7);
      });

      it('should recommend relay-only when IPv6-only without NAT64 trying to reach IPv4-only', () => {
        const localProfile = {
          natType: 'unknown',
          hasIPv6: true,
          isIPv6Only: true,
          hasNAT64: false,
          ipv4Host: [],
          ipv4External: null
        };
        const remoteProfile = {
          natType: 'easy',
          hasIPv6: false,
          isIPv6Only: false,
          ipv4External: '203.0.113.1'
        };
        
        const result = detector.shouldAttemptDirectConnection(localProfile, remoteProfile);
        
        expect(result.shouldTryDirect).toBe(false);
        expect(result.recommendedStrategy).toBe('relay-only');
        expect(result.estimatedSuccessRate).toBe(0.0);
        expect(result.reason).toContain('no direct path');
      });

      it('should use ipv6-direct-only when both peers have IPv6 even if local is IPv6-only', () => {
        const localProfile = {
          natType: 'unknown',
          hasIPv6: true,
          isIPv6Only: true,
          hasNAT64: true,
          ipv6Addresses: ['2001:db8::1']
        };
        const remoteProfile = {
          natType: 'easy',
          hasIPv6: true,
          isIPv6Only: false,
          ipv6Addresses: ['2001:db8::2']
        };
        
        const result = detector.shouldAttemptDirectConnection(localProfile, remoteProfile);
        
        // IPv6 on both peers takes precedence over NAT64 handling
        expect(result.recommendedStrategy).toBe('ipv6-direct-only');
        expect(result.skipRelay).toBe(true);
      });
    });

    describe('getProfileSummary with NAT64', () => {
      it('should include IPv6-only with NAT64 status', () => {
        const profile = {
          hasIPv6: true,
          ipv6Addresses: ['2001:db8::1'],
          natType: 'unknown',
          isIPv6Only: true,
          hasNAT64: true,
          nat64Prefix: '64:ff9b::/96',
          needsRelay: false
        };
        
        const summary = detector.getProfileSummary(profile);
        
        expect(summary).toContain('IPv6-only+NAT64');
        expect(summary).toContain('64:ff9b::/96');
      });

      it('should warn about IPv6-only without NAT64', () => {
        const profile = {
          hasIPv6: true,
          ipv6Addresses: ['2001:db8::1'],
          natType: 'unknown',
          isIPv6Only: true,
          hasNAT64: false,
          needsRelay: true
        };
        
        const summary = detector.getProfileSummary(profile);
        
        expect(summary).toContain('IPv6-only (no NAT64!)');
      });

      it('should not include IPv6-only info for dual-stack networks', () => {
        const profile = {
          hasIPv6: true,
          ipv6Addresses: ['2001:db8::1'],
          ipv4External: '203.0.113.1',
          natType: 'easy',
          isIPv6Only: false,
          hasNAT64: false,
          needsRelay: false
        };
        
        const summary = detector.getProfileSummary(profile);
        
        expect(summary).not.toContain('IPv6-only');
        expect(summary).not.toContain('NAT64');
      });
    });
  });
});


describe('NAT Type Detection (_analyzeNatType)', () => {
  let detector;

  beforeEach(() => {
    detector = new ConnectionProfileDetector();
  });

  describe('Dual-STUN Method for NAT Type Detection', () => {
    it('should detect symmetric NAT (hard) when same local socket maps to different external ports', async () => {
      // Simulate ICE candidates from a symmetric NAT
      // Same local socket (192.168.1.100:54321) maps to different external ports
      // when querying different STUN servers (different foundations)
      const candidates = [
        {
          type: 'srflx',
          address: '203.0.113.50',
          port: 54481,
          relatedAddress: '192.168.1.100',
          relatedPort: 54321,
          protocol: 'udp',
          foundation: 'foundation1' // STUN server 1
        },
        {
          type: 'srflx',
          address: '203.0.113.50',
          port: 54482, // Different external port!
          relatedAddress: '192.168.1.100',
          relatedPort: 54321, // Same local socket
          protocol: 'udp',
          foundation: 'foundation2' // STUN server 2
        }
      ];

      const profile = { natType: 'unknown' };
      await detector._analyzeNatType(candidates, profile);

      expect(profile.natType).toBe('hard');
      expect(profile._natAnalysis).toBeDefined();
      expect(profile._natAnalysis.method).toBe('dual-stun');
      expect(profile._natAnalysis.conclusion).toBe('endpoint-dependent');
    });

    it('should detect cone NAT (easy) when same local socket maps to same external port', async () => {
      // Simulate ICE candidates from a cone NAT
      // Same local socket maps to the SAME external port regardless of STUN server
      const candidates = [
        {
          type: 'srflx',
          address: '203.0.113.50',
          port: 54481,
          relatedAddress: '192.168.1.100',
          relatedPort: 54321,
          protocol: 'udp',
          foundation: 'foundation1' // STUN server 1
        },
        {
          type: 'srflx',
          address: '203.0.113.50',
          port: 54481, // Same external port!
          relatedAddress: '192.168.1.100',
          relatedPort: 54321, // Same local socket
          protocol: 'udp',
          foundation: 'foundation2' // STUN server 2
        }
      ];

      const profile = { natType: 'unknown' };
      await detector._analyzeNatType(candidates, profile);

      expect(profile.natType).toBe('easy');
      expect(profile._natAnalysis).toBeDefined();
      expect(profile._natAnalysis.method).toBe('dual-stun');
      expect(profile._natAnalysis.conclusion).toBe('endpoint-independent');
    });

    it('should set NAT type to unknown when no srflx candidates', async () => {
      // Only host candidates, no STUN responses
      const candidates = [
        {
          type: 'host',
          address: '192.168.1.100',
          port: 54321,
          protocol: 'udp'
        }
      ];

      const profile = { natType: 'unknown' };
      await detector._analyzeNatType(candidates, profile);

      expect(profile.natType).toBe('unknown');
    });

    it('should skip NAT analysis if already detected as open', async () => {
      const candidates = [
        {
          type: 'srflx',
          address: '203.0.113.50',
          port: 54481,
          relatedAddress: '192.168.1.100',
          relatedPort: 54321,
          protocol: 'udp',
          foundation: 'foundation1'
        }
      ];

      const profile = { natType: 'open' }; // Already detected as open
      await detector._analyzeNatType(candidates, profile);

      // Should remain 'open', not be overwritten
      expect(profile.natType).toBe('open');
      expect(profile._natAnalysis).toBeUndefined();
    });

    it('should set external IPv4 from srflx candidate', async () => {
      const candidates = [
        {
          type: 'srflx',
          address: '203.0.113.50',
          port: 54481,
          relatedAddress: '192.168.1.100',
          relatedPort: 54321,
          protocol: 'udp',
          foundation: 'foundation1'
        }
      ];

      const profile = { natType: 'unknown', ipv4External: null };
      await detector._analyzeNatType(candidates, profile);

      expect(profile.ipv4External).toBe('203.0.113.50');
    });

    it('should handle multiple local sockets correctly', async () => {
      // Two different local sockets, each with consistent mapping (easy NAT)
      const candidates = [
        // Local socket 1
        {
          type: 'srflx',
          address: '203.0.113.50',
          port: 54481,
          relatedAddress: '192.168.1.100',
          relatedPort: 54321,
          protocol: 'udp',
          foundation: 'foundation1'
        },
        {
          type: 'srflx',
          address: '203.0.113.50',
          port: 54481, // Same port
          relatedAddress: '192.168.1.100',
          relatedPort: 54321,
          protocol: 'udp',
          foundation: 'foundation2'
        },
        // Local socket 2
        {
          type: 'srflx',
          address: '203.0.113.50',
          port: 54500,
          relatedAddress: '192.168.1.100',
          relatedPort: 54400, // Different local port
          protocol: 'udp',
          foundation: 'foundation1'
        },
        {
          type: 'srflx',
          address: '203.0.113.50',
          port: 54500, // Same port for this socket
          relatedAddress: '192.168.1.100',
          relatedPort: 54400,
          protocol: 'udp',
          foundation: 'foundation2'
        }
      ];

      const profile = { natType: 'unknown' };
      await detector._analyzeNatType(candidates, profile);

      expect(profile.natType).toBe('easy');
      expect(profile._natAnalysis.localSockets.length).toBe(2);
    });

    it('should detect symmetric NAT even if only one local socket has different ports', async () => {
      // One local socket with consistent mapping, another with different ports
      const candidates = [
        // Local socket 1 - consistent (easy)
        {
          type: 'srflx',
          address: '203.0.113.50',
          port: 54481,
          relatedAddress: '192.168.1.100',
          relatedPort: 54321,
          protocol: 'udp',
          foundation: 'foundation1'
        },
        {
          type: 'srflx',
          address: '203.0.113.50',
          port: 54481,
          relatedAddress: '192.168.1.100',
          relatedPort: 54321,
          protocol: 'udp',
          foundation: 'foundation2'
        },
        // Local socket 2 - different ports (symmetric)
        {
          type: 'srflx',
          address: '203.0.113.50',
          port: 54500,
          relatedAddress: '192.168.1.100',
          relatedPort: 54400,
          protocol: 'udp',
          foundation: 'foundation1'
        },
        {
          type: 'srflx',
          address: '203.0.113.50',
          port: 54501, // Different port!
          relatedAddress: '192.168.1.100',
          relatedPort: 54400,
          protocol: 'udp',
          foundation: 'foundation2'
        }
      ];

      const profile = { natType: 'unknown' };
      await detector._analyzeNatType(candidates, profile);

      // Should be hard because at least one socket shows symmetric behavior
      expect(profile.natType).toBe('hard');
    });

    it('should handle single STUN server response (cannot determine NAT type definitively)', async () => {
      // Only one STUN server responded (same foundation)
      const candidates = [
        {
          type: 'srflx',
          address: '203.0.113.50',
          port: 54481,
          relatedAddress: '192.168.1.100',
          relatedPort: 54321,
          protocol: 'udp',
          foundation: 'foundation1'
        },
        {
          type: 'srflx',
          address: '203.0.113.50',
          port: 54482, // Different port but same foundation
          relatedAddress: '192.168.1.100',
          relatedPort: 54321,
          protocol: 'udp',
          foundation: 'foundation1' // Same STUN server
        }
      ];

      const profile = { natType: 'unknown' };
      await detector._analyzeNatType(candidates, profile);

      // With only one STUN server, we can't definitively detect symmetric NAT
      // The algorithm requires different foundations (different STUN servers)
      expect(profile.natType).toBe('easy');
      expect(profile._natAnalysis.localSockets[0].stunServerCount).toBe(1);
    });

    it('should handle missing relatedAddress/relatedPort gracefully', async () => {
      const candidates = [
        {
          type: 'srflx',
          address: '203.0.113.50',
          port: 54481,
          relatedAddress: null, // Missing
          relatedPort: null,    // Missing
          protocol: 'udp',
          foundation: 'foundation1'
        },
        {
          type: 'srflx',
          address: '203.0.113.50',
          port: 54482,
          relatedAddress: null,
          relatedPort: null,
          protocol: 'udp',
          foundation: 'foundation2'
        }
      ];

      const profile = { natType: 'unknown' };
      await detector._analyzeNatType(candidates, profile);

      // Should still work, grouping by 'unknown:unknown:udp'
      expect(profile.natType).toBe('hard'); // Different ports from different servers
    });

    it('should handle TCP and UDP candidates separately', async () => {
      const candidates = [
        // UDP socket - consistent
        {
          type: 'srflx',
          address: '203.0.113.50',
          port: 54481,
          relatedAddress: '192.168.1.100',
          relatedPort: 54321,
          protocol: 'udp',
          foundation: 'foundation1'
        },
        {
          type: 'srflx',
          address: '203.0.113.50',
          port: 54481,
          relatedAddress: '192.168.1.100',
          relatedPort: 54321,
          protocol: 'udp',
          foundation: 'foundation2'
        },
        // TCP socket - different ports (but this is a different socket)
        {
          type: 'srflx',
          address: '203.0.113.50',
          port: 54500,
          relatedAddress: '192.168.1.100',
          relatedPort: 54321, // Same local port but TCP
          protocol: 'tcp',
          foundation: 'foundation1'
        },
        {
          type: 'srflx',
          address: '203.0.113.50',
          port: 54501,
          relatedAddress: '192.168.1.100',
          relatedPort: 54321,
          protocol: 'tcp',
          foundation: 'foundation2'
        }
      ];

      const profile = { natType: 'unknown' };
      await detector._analyzeNatType(candidates, profile);

      // TCP socket shows symmetric behavior
      expect(profile.natType).toBe('hard');
    });

    it('should store detailed analysis in profile._natAnalysis', async () => {
      const candidates = [
        {
          type: 'srflx',
          address: '203.0.113.50',
          port: 54481,
          relatedAddress: '192.168.1.100',
          relatedPort: 54321,
          protocol: 'udp',
          foundation: 'foundation1'
        },
        {
          type: 'srflx',
          address: '203.0.113.50',
          port: 54482,
          relatedAddress: '192.168.1.100',
          relatedPort: 54321,
          protocol: 'udp',
          foundation: 'foundation2'
        }
      ];

      const profile = { natType: 'unknown' };
      await detector._analyzeNatType(candidates, profile);

      expect(profile._natAnalysis).toEqual({
        method: 'dual-stun',
        srflxCount: 2,
        localSockets: [
          {
            localSocket: '192.168.1.100:54321:udp',
            stunServerCount: 2,
            externalPorts: [54481, 54482]
          }
        ],
        conclusion: 'endpoint-dependent'
      });
    });
  });

  describe('Host Candidate Analysis (_analyzeHostCandidates)', () => {
    it('should detect public IPv4 as open NAT', () => {
      const candidates = [
        {
          type: 'host',
          address: '203.0.113.50', // Public IP
          port: 54321
        }
      ];

      const profile = { 
        natType: 'unknown', 
        hasIPv6: false, 
        ipv6Addresses: [],
        ipv4Host: [],
        ipv4External: null
      };
      detector._analyzeHostCandidates(candidates, profile);

      expect(profile.natType).toBe('open');
      expect(profile.ipv4External).toBe('203.0.113.50');
    });

    it('should detect global IPv6 addresses', () => {
      const candidates = [
        {
          type: 'host',
          address: '2001:db8::1', // Global IPv6
          port: 54321
        },
        {
          type: 'host',
          address: '2607:f8b0:4004:800::200e', // Another global IPv6
          port: 54322
        }
      ];

      const profile = { 
        natType: 'unknown', 
        hasIPv6: false, 
        ipv6Addresses: [],
        ipv4Host: []
      };
      detector._analyzeHostCandidates(candidates, profile);

      expect(profile.hasIPv6).toBe(true);
      expect(profile.ipv6Addresses).toContain('2001:db8::1');
      expect(profile.ipv6Addresses).toContain('2607:f8b0:4004:800::200e');
    });

    it('should track private IPv4 host addresses', () => {
      const candidates = [
        {
          type: 'host',
          address: '192.168.1.100', // Private IP
          port: 54321
        },
        {
          type: 'host',
          address: '10.0.0.5', // Another private IP
          port: 54322
        }
      ];

      const profile = { 
        natType: 'unknown', 
        hasIPv6: false, 
        ipv6Addresses: [],
        ipv4Host: []
      };
      detector._analyzeHostCandidates(candidates, profile);

      expect(profile.ipv4Host).toContain('192.168.1.100');
      expect(profile.ipv4Host).toContain('10.0.0.5');
      expect(profile.natType).toBe('unknown'); // Not open, still behind NAT
    });

    it('should not add duplicate IPv6 addresses', () => {
      const candidates = [
        {
          type: 'host',
          address: '2001:db8::1',
          port: 54321
        },
        {
          type: 'host',
          address: '2001:db8::1', // Duplicate
          port: 54322
        }
      ];

      const profile = { 
        natType: 'unknown', 
        hasIPv6: false, 
        ipv6Addresses: [],
        ipv4Host: []
      };
      detector._analyzeHostCandidates(candidates, profile);

      expect(profile.ipv6Addresses.length).toBe(1);
    });

    it('should ignore non-host candidates', () => {
      const candidates = [
        {
          type: 'srflx', // Not a host candidate
          address: '203.0.113.50',
          port: 54321
        }
      ];

      const profile = { 
        natType: 'unknown', 
        hasIPv6: false, 
        ipv6Addresses: [],
        ipv4Host: []
      };
      detector._analyzeHostCandidates(candidates, profile);

      expect(profile.natType).toBe('unknown');
      expect(profile.ipv4Host.length).toBe(0);
    });

    it('should handle candidates with null address', () => {
      const candidates = [
        {
          type: 'host',
          address: null,
          port: 54321
        }
      ];

      const profile = { 
        natType: 'unknown', 
        hasIPv6: false, 
        ipv6Addresses: [],
        ipv4Host: []
      };
      
      // Should not throw
      expect(() => detector._analyzeHostCandidates(candidates, profile)).not.toThrow();
      expect(profile.natType).toBe('unknown');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty candidate list', async () => {
      const profile = { natType: 'unknown' };
      await detector._analyzeNatType([], profile);

      expect(profile.natType).toBe('unknown');
    });

    it('should handle candidates with default protocol', async () => {
      const candidates = [
        {
          type: 'srflx',
          address: '203.0.113.50',
          port: 54481,
          relatedAddress: '192.168.1.100',
          relatedPort: 54321,
          // No protocol specified - should default to 'udp'
          foundation: 'foundation1'
        },
        {
          type: 'srflx',
          address: '203.0.113.50',
          port: 54482,
          relatedAddress: '192.168.1.100',
          relatedPort: 54321,
          foundation: 'foundation2'
        }
      ];

      const profile = { natType: 'unknown' };
      await detector._analyzeNatType(candidates, profile);

      expect(profile.natType).toBe('hard');
      expect(profile._natAnalysis.localSockets[0].localSocket).toContain('udp');
    });

    it('should handle IPv6 srflx candidates', async () => {
      const candidates = [
        {
          type: 'srflx',
          address: '2001:db8::50', // IPv6 external
          port: 54481,
          relatedAddress: '2001:db8::100',
          relatedPort: 54321,
          protocol: 'udp',
          foundation: 'foundation1'
        }
      ];

      const profile = { natType: 'unknown', ipv4External: null };
      await detector._analyzeNatType(candidates, profile);

      // Should not set ipv4External for IPv6 address
      expect(profile.ipv4External).toBeNull();
      expect(profile.natType).toBe('easy');
    });

    it('should handle mixed IPv4 and IPv6 srflx candidates', async () => {
      const candidates = [
        {
          type: 'srflx',
          address: '203.0.113.50', // IPv4
          port: 54481,
          relatedAddress: '192.168.1.100',
          relatedPort: 54321,
          protocol: 'udp',
          foundation: 'foundation1'
        },
        {
          type: 'srflx',
          address: '2001:db8::50', // IPv6
          port: 54500,
          relatedAddress: '2001:db8::100',
          relatedPort: 54400,
          protocol: 'udp',
          foundation: 'foundation1'
        }
      ];

      const profile = { natType: 'unknown', ipv4External: null };
      await detector._analyzeNatType(candidates, profile);

      expect(profile.ipv4External).toBe('203.0.113.50');
    });
  });
});

describe('detectHardNatPair (static method)', () => {
  describe('Task 4.3: Hard NAT pair detection', () => {
    it('should detect when both peers have hard NAT', () => {
      const profileA = { natType: 'hard', portPattern: 'sequential', hasIPv6: false };
      const profileB = { natType: 'hard', portPattern: 'sequential', hasIPv6: false };
      
      const result = ConnectionProfileDetector.detectHardNatPair(profileA, profileB);
      
      expect(result.bothHardNat).toBe(true);
      expect(result.peerAHardNat).toBe(true);
      expect(result.peerBHardNat).toBe(true);
      expect(result.shouldAttemptCoordinatedRestart).toBe(true);
    });

    it('should detect when only one peer has hard NAT', () => {
      const profileA = { natType: 'hard', portPattern: 'random', hasIPv6: false };
      const profileB = { natType: 'easy', portPattern: 'sequential', hasIPv6: false };
      
      const result = ConnectionProfileDetector.detectHardNatPair(profileA, profileB);
      
      expect(result.bothHardNat).toBe(false);
      expect(result.peerAHardNat).toBe(true);
      expect(result.peerBHardNat).toBe(false);
      expect(result.shouldAttemptCoordinatedRestart).toBe(false);
      expect(result.estimatedSuccessRate).toBe(0.6);
    });

    it('should detect when neither peer has hard NAT', () => {
      const profileA = { natType: 'easy', portPattern: 'sequential', hasIPv6: false };
      const profileB = { natType: 'open', portPattern: 'none', hasIPv6: false };
      
      const result = ConnectionProfileDetector.detectHardNatPair(profileA, profileB);
      
      expect(result.bothHardNat).toBe(false);
      expect(result.peerAHardNat).toBe(false);
      expect(result.peerBHardNat).toBe(false);
      expect(result.shouldAttemptCoordinatedRestart).toBe(false);
      expect(result.estimatedSuccessRate).toBe(0.85);
    });

    it('should give higher success rate for sequential ports on both hard NAT peers', () => {
      const profileA = { natType: 'hard', portPattern: 'sequential', hasIPv6: false };
      const profileB = { natType: 'hard', portPattern: 'sequential', hasIPv6: false };
      
      const result = ConnectionProfileDetector.detectHardNatPair(profileA, profileB);
      
      expect(result.bothHardNat).toBe(true);
      expect(result.estimatedSuccessRate).toBe(0.3);
      expect(result.reason).toContain('sequential');
    });

    it('should give very low success rate for random ports on hard NAT peers', () => {
      const profileA = { natType: 'hard', portPattern: 'random', hasIPv6: false };
      const profileB = { natType: 'hard', portPattern: 'random', hasIPv6: false };
      
      const result = ConnectionProfileDetector.detectHardNatPair(profileA, profileB);
      
      expect(result.bothHardNat).toBe(true);
      expect(result.estimatedSuccessRate).toBe(0.05);
      expect(result.reason).toContain('random');
      expect(result.reason).toContain('relay');
    });

    it('should give moderate success rate for unknown port pattern on hard NAT peers', () => {
      const profileA = { natType: 'hard', portPattern: 'unknown', hasIPv6: false };
      const profileB = { natType: 'hard', portPattern: 'unknown', hasIPv6: false };
      
      const result = ConnectionProfileDetector.detectHardNatPair(profileA, profileB);
      
      expect(result.bothHardNat).toBe(true);
      expect(result.estimatedSuccessRate).toBe(0.2);
      expect(result.shouldAttemptCoordinatedRestart).toBe(true);
    });

    it('should boost success rate when IPv6 is available on both peers', () => {
      const profileA = { natType: 'hard', portPattern: 'random', hasIPv6: true };
      const profileB = { natType: 'hard', portPattern: 'random', hasIPv6: true };
      
      const result = ConnectionProfileDetector.detectHardNatPair(profileA, profileB);
      
      expect(result.bothHardNat).toBe(true);
      expect(result.estimatedSuccessRate).toBe(0.9); // Boosted from 0.05 to 0.9
      expect(result.reason).toContain('IPv6');
    });

    it('should handle missing profiles gracefully', () => {
      const result1 = ConnectionProfileDetector.detectHardNatPair(null, { natType: 'hard' });
      expect(result1.bothHardNat).toBe(false);
      expect(result1.reason).toContain('Missing');

      const result2 = ConnectionProfileDetector.detectHardNatPair({ natType: 'hard' }, null);
      expect(result2.bothHardNat).toBe(false);
      expect(result2.reason).toContain('Missing');

      const result3 = ConnectionProfileDetector.detectHardNatPair(null, null);
      expect(result3.bothHardNat).toBe(false);
      expect(result3.reason).toContain('Missing');
    });

    it('should handle mixed random/sequential port patterns', () => {
      const profileA = { natType: 'hard', portPattern: 'sequential', hasIPv6: false };
      const profileB = { natType: 'hard', portPattern: 'random', hasIPv6: false };
      
      const result = ConnectionProfileDetector.detectHardNatPair(profileA, profileB);
      
      expect(result.bothHardNat).toBe(true);
      // Random on one side means very low success rate
      expect(result.estimatedSuccessRate).toBe(0.05);
      expect(result.reason).toContain('random');
    });
  });
});
