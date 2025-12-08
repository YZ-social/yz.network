/**
 * Protocol Version for YZ Network DHT
 *
 * This version is checked when clients connect to the bootstrap server.
 * If the client's version doesn't match the server's version, the connection
 * is rejected and the client is told to refresh their browser.
 *
 * There are TWO version components:
 * 1. PROTOCOL_VERSION - Semantic version for protocol compatibility
 *    - Manually increment when making breaking protocol changes
 *    - Allows backwards compatibility within major.minor versions
 *
 * 2. BUILD_ID - Unique identifier generated at build/startup time
 *    - Automatically changes with each deployment/restart
 *    - Forces all clients to refresh after server restart
 *
 * How it works:
 * 1. Browser loads bundle.js which contains PROTOCOL_VERSION and BUILD_ID
 * 2. Client connects to bootstrap and sends both values in registration
 * 3. Bootstrap checks:
 *    a) Protocol version compatibility (allows patch differences)
 *    b) Build ID match (must be exact for same deployment)
 * 4. If mismatch, sends version_mismatch error with refresh instruction
 * 5. User refreshes → browser fetches new bundle.js with updated BUILD_ID
 * 6. Connection succeeds
 */

// Semantic version for protocol compatibility
export const PROTOCOL_VERSION = '1.0.0';

// Minimum compatible protocol version (for backwards compatibility)
export const MIN_COMPATIBLE_VERSION = '1.0.0';

/**
 * Build ID - Generated at BUILD TIME by webpack/node
 * This changes with every new deployment, forcing clients to refresh
 *
 * In browser: Set by webpack DefinePlugin from build timestamp
 * In Node.js: Set at module load time
 */
export const BUILD_ID = typeof __BUILD_ID__ !== 'undefined'
  ? __BUILD_ID__  // Injected by webpack at build time
  : `node_${Date.now()}`; // Fallback for Node.js (changes each restart)

/**
 * Check if a client version is compatible with the server
 * @param {string} clientProtocolVersion - Client's protocol version (e.g., "1.0.0")
 * @param {string} clientBuildId - Client's build ID
 * @param {string} serverBuildId - Server's build ID (for comparison)
 * @returns {{ compatible: boolean, message?: string }}
 */
export function checkVersionCompatibility(clientProtocolVersion, clientBuildId, serverBuildId) {
  // Check protocol version first (allows patch differences)
  if (!clientProtocolVersion) {
    return {
      compatible: false,
      message: 'No protocol version provided. Please refresh your browser to get the latest version.'
    };
  }

  // Parse protocol versions (Major.Minor.Patch)
  const serverParts = PROTOCOL_VERSION.split('.').map(Number);
  const clientParts = clientProtocolVersion.split('.').map(Number);
  const minParts = MIN_COMPATIBLE_VERSION.split('.').map(Number);

  // Calculate version numbers for comparison
  const clientNum = clientParts[0] * 10000 + (clientParts[1] || 0) * 100 + (clientParts[2] || 0);
  const minNum = minParts[0] * 10000 + (minParts[1] || 0) * 100 + (minParts[2] || 0);

  // Check if client protocol version is below minimum
  if (clientNum < minNum) {
    return {
      compatible: false,
      message: `Your client version (${clientProtocolVersion}) is outdated. Server requires at least ${MIN_COMPATIBLE_VERSION}. Please refresh your browser to update.`
    };
  }

  // Require exact major.minor match for protocol (patch differences are OK)
  if (clientParts[0] !== serverParts[0] || clientParts[1] !== serverParts[1]) {
    return {
      compatible: false,
      message: `Protocol version mismatch. Client: ${clientProtocolVersion}, Server: ${PROTOCOL_VERSION}. Please refresh your browser to update.`
    };
  }

  // BUILD_ID checking is DISABLED for browser↔server communication
  //
  // Why: Browser BUILD_ID (build_XXXX from webpack) and server BUILD_ID (node_XXXX from Node.js)
  // are generated at different times and will NEVER match. This is by design since:
  // 1. Webpack builds bundle.js with content hash (e.g., bundle.2e0c7630.js)
  // 2. Content hash changes force browser to fetch new bundle
  // 3. Node.js server generates node_XXXX at startup
  //
  // Browser cache busting is already handled by webpack's contenthash in the bundle filename.
  // Protocol version checking (above) is sufficient for compatibility.
  //
  // BUILD_ID checking only makes sense for Node.js↔Node.js communication where
  // both sides would have node_ prefix BUILD_IDs from the same deployment.
  const isNodeClient = clientBuildId && clientBuildId.startsWith('node_');
  const isBrowserClient = clientBuildId && clientBuildId.startsWith('build_');
  const isNodeServer = serverBuildId && serverBuildId.startsWith('node_');

  // Only enforce BUILD_ID match for Node.js↔Node.js internal communication
  // Browser clients are exempt since webpack contenthash handles cache busting
  if (serverBuildId && clientBuildId !== serverBuildId && !isNodeClient && !isBrowserClient) {
    return {
      compatible: false,
      message: `Server has been restarted. Please refresh your browser to reconnect with the new deployment.`
    };
  }

  return { compatible: true };
}
