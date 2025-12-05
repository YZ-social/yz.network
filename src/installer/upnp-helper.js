/**
 * UPnP Helper - Automatic port forwarding for home networks
 *
 * Uses UPnP/NAT-PMP to automatically configure router port forwarding,
 * allowing external peers to connect to local DHT nodes.
 *
 * NOTE: nat-upnp is NOT installed by default due to security vulnerabilities.
 * If you need UPnP functionality, manually install: npm install nat-upnp
 * Be aware of security risks: https://github.com/advisories/GHSA-fjxv-7rqg-78g4
 *
 * COMMUNITY NODES STATUS: ON HOLD due to WSS domain requirement.
 * See: docs/proposals/community-nodes-proposal.md
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let upnpClient = null;
let natPmpClient = null;

// Try to load nat-upnp if available (optional dependency)
try {
  const natUpnp = require('nat-upnp');
  upnpClient = natUpnp.createClient();
  console.log('✅ UPnP client initialized');
} catch (error) {
  console.warn('⚠️  nat-upnp package not found - install with: npm install nat-upnp');
}

export class UPnPHelper {
  constructor() {
    this.mappings = [];
  }

  /**
   * Open a port using UPnP
   * @param {number} port - Port number to open
   * @param {string} description - Description for the mapping
   * @returns {Promise<boolean>} Success status
   */
  async openPort(port, description = 'YZ Network Node') {
    if (!upnpClient) {
      console.warn(`⚠️  UPnP not available - skipping port ${port}`);
      return false;
    }

    try {
      console.log(`🔌 Opening port ${port} via UPnP...`);

      // Create port mapping (internal port = external port)
      await upnpClient.portMapping({
        public: port,
        private: port,
        protocol: 'TCP',
        description: description,
        ttl: 0 // Permanent mapping (until router reboot)
      });

      this.mappings.push({ port, description });
      console.log(`✅ Port ${port} opened successfully`);
      return true;

    } catch (error) {
      console.error(`❌ Failed to open port ${port}:`, error.message);

      // Check if it's because UPnP is disabled on router
      if (error.message.includes('UPnP') || error.message.includes('disabled')) {
        console.warn('⚠️  UPnP may be disabled on your router. Please:');
        console.warn('   1. Log into your router admin panel');
        console.warn('   2. Enable UPnP/NAT-PMP');
        console.warn('   3. Or manually forward the ports');
      }

      return false;
    }
  }

  /**
   * Close a port mapping
   * @param {number} port - Port number to close
   * @returns {Promise<boolean>} Success status
   */
  async closePort(port) {
    if (!upnpClient) {
      return false;
    }

    try {
      console.log(`🔌 Closing port ${port}...`);

      await upnpClient.portUnmapping({
        public: port,
        protocol: 'TCP'
      });

      this.mappings = this.mappings.filter(m => m.port !== port);
      console.log(`✅ Port ${port} closed`);
      return true;

    } catch (error) {
      console.error(`❌ Failed to close port ${port}:`, error.message);
      return false;
    }
  }

  /**
   * Get external IP address via UPnP
   * @returns {Promise<string|null>} External IP or null
   */
  async getExternalIP() {
    if (!upnpClient) {
      return null;
    }

    try {
      const ip = await upnpClient.externalIp();
      return ip;
    } catch (error) {
      console.error('Failed to get external IP via UPnP:', error.message);
      return null;
    }
  }

  /**
   * Close all open port mappings
   * @returns {Promise<void>}
   */
  async closeAllPorts() {
    console.log(`🔌 Closing ${this.mappings.length} port mapping(s)...`);

    for (const mapping of [...this.mappings]) {
      await this.closePort(mapping.port);
    }
  }

  /**
   * Check if UPnP is available
   * @returns {boolean}
   */
  isAvailable() {
    return !!upnpClient;
  }

  /**
   * Get list of current mappings
   * @returns {Array}
   */
  getMappings() {
    return [...this.mappings];
  }
}

/**
 * Fallback: Detect external IP without UPnP
 */
export async function detectExternalIP() {
  const https = await import('https');

  const services = [
    'https://api.ipify.org',
    'https://icanhazip.com',
    'https://ifconfig.me/ip',
    'https://api.my-ip.io/ip'
  ];

  for (const service of services) {
    try {
      const ip = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout')), 5000);

        https.get(service, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            clearTimeout(timeout);
            resolve(data.trim());
          });
          res.on('error', reject);
        }).on('error', reject);
      });

      // Basic IPv4 validation
      if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
        const octets = ip.split('.').map(Number);
        if (octets.every(octet => octet >= 0 && octet <= 255)) {
          return ip;
        }
      }
    } catch (error) {
      continue; // Try next service
    }
  }

  throw new Error('Could not detect external IP from any service');
}

export default UPnPHelper;
