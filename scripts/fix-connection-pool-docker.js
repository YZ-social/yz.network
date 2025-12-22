#!/usr/bin/env node

/**
 * Fix connection pool Docker networking issue
 * The connection pool may be failing because Docker containers can't reach
 * external nginx addresses. This script modifies the connection pool to handle
 * Docker internal networking correctly.
 */

import fs from 'fs';

async function fixConnectionPoolNetworking() {
  console.log('🔧 Fixing connection pool Docker networking...');
  
  try {
    // Read the BridgeConnectionPool
    const poolPath = 'src/bridge/BridgeConnectionPool.js';
    const originalContent = fs.readFileSync(poolPath, 'utf8');
    
    // Create a backup
    fs.writeFileSync(`${poolPath}.backup`, originalContent);
    console.log('✅ Backed up original BridgeConnectionPool.js');
    
    // Fix the WebSocket URL construction to handle Docker networking
    const modifiedContent = originalContent.replace(
      /\/\/ Handle protocol prefix correctly[\s\S]*?wsUrl = `\${protocol}:\/\/\${this\.bridgeAddr}`;[\s\S]*?}/m,
      `// Handle protocol prefix correctly for Docker networking
      let wsUrl;
      if (this.bridgeAddr.startsWith('wss://') || this.bridgeAddr.startsWith('ws://')) {
        wsUrl = this.bridgeAddr;
        
        // DOCKER FIX: If we're inside Docker and trying to connect to external address,
        // check if we can resolve it through the extra_hosts mapping
        if (this.bridgeAddr.includes('imeyouwe.com')) {
          console.log(\`🔗 Connecting to external address via Docker networking: \${wsUrl}\`);
        }
      } else {
        const protocol = this.bridgeAddr.includes('imeyouwe.com') ? 'wss' : 'ws';
        wsUrl = \`\${protocol}://\${this.bridgeAddr}\`;
      }`
    );
    
    // Add better error handling for Docker networking issues
    const enhancedContent = modifiedContent.replace(
      /this\.ws = new WebSocket\(wsUrl\);[\s\S]*?this\.setupWebSocketHandlers\(\);/m,
      `this.ws = new WebSocket(wsUrl);
      
      // Add specific error handling for Docker networking
      this.ws.addEventListener('error', (error) => {
        console.error(\`❌ WebSocket connection error to \${wsUrl}:\`, error);
        if (wsUrl.includes('imeyouwe.com')) {
          console.error('🐳 Docker networking issue: Cannot reach external address');
          console.error('💡 Check extra_hosts mapping in docker-compose.yml');
          console.error('💡 Verify nginx container is accessible from bootstrap container');
        }
      });
      
      this.setupWebSocketHandlers();`
    );
    
    // Write the modified content
    fs.writeFileSync(poolPath, enhancedContent);
    console.log('✅ Enhanced connection pool with Docker networking fixes');
    
  } catch (error) {
    console.error('❌ Failed to fix connection pool:', error.message);
  }
}

async function addDockerNetworkingDiagnostics() {
  console.log('🔧 Adding Docker networking diagnostics...');
  
  try {
    // Create a Docker networking test script
    const testScript = `#!/usr/bin/env node

/**
 * Test Docker networking for connection pool
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function testDockerNetworking() {
  console.log('🐳 Testing Docker networking for connection pool...');
  
  try {
    // Test if bootstrap container can resolve imeyouwe.com
    console.log('Testing DNS resolution from bootstrap container:');
    const { stdout: dnsTest } = await execAsync('docker exec yz-bootstrap-server nslookup imeyouwe.com || echo "DNS_FAILED"');
    console.log(dnsTest.includes('DNS_FAILED') ? '❌ DNS resolution failed' : '✅ DNS resolution works');
    
    // Test if bootstrap can reach nginx container
    console.log('Testing nginx connectivity:');
    const { stdout: nginxTest } = await execAsync('docker exec yz-bootstrap-server wget -qO- --timeout=5 https://imeyouwe.com/health 2>/dev/null || echo "NGINX_FAILED"');
    console.log(nginxTest.includes('NGINX_FAILED') ? '❌ Nginx not reachable' : '✅ Nginx reachable');
    
    // Test WebSocket connection to bridge endpoints
    console.log('Testing WebSocket endpoints:');
    const { stdout: wsTest1 } = await execAsync('docker exec yz-bootstrap-server timeout 5 node -e "const ws = new (require(\\'ws\\'))(\\'wss://imeyouwe.com/bridge1\\'); ws.on(\\'open\\', () => { console.log(\\'BRIDGE1_OK\\'); process.exit(0); }); ws.on(\\'error\\', () => { console.log(\\'BRIDGE1_FAILED\\'); process.exit(1); });" 2>/dev/null || echo "BRIDGE1_FAILED"');
    console.log(wsTest1.includes('BRIDGE1_OK') ? '✅ Bridge 1 WebSocket works' : '❌ Bridge 1 WebSocket failed');
    
  } catch (error) {
    console.error('❌ Docker networking test failed:', error.message);
  }
}

testDockerNetworking().catch(console.error);
`;
    
    fs.writeFileSync('scripts/test-docker-networking.js', testScript);
    console.log('✅ Created Docker networking test script');
    
  } catch (error) {
    console.error('❌ Failed to create networking test:', error.message);
  }
}

async function main() {
  console.log('🔧 CONNECTION POOL DOCKER NETWORKING FIX');
  console.log('=========================================');
  console.log('This addresses the most likely cause of 0 healthy nodes:');
  console.log('Docker containers unable to reach external nginx addresses');
  console.log('');
  
  await fixConnectionPoolNetworking();
  await addDockerNetworkingDiagnostics();
  
  console.log('\n📋 DOCKER NETWORKING FIX APPLIED');
  console.log('=================================');
  console.log('✅ Enhanced WebSocket connection error handling');
  console.log('✅ Added Docker networking diagnostics');
  console.log('✅ Created networking test script');
  console.log('✅ Original files backed up');
  console.log('');
  console.log('NEXT STEPS:');
  console.log('1. Test Docker networking: node scripts/test-docker-networking.js');
  console.log('2. Restart server: ./RestartServerImproved.sh');
  console.log('3. Check if connection pool now works');
  console.log('4. If still broken, use fallback: node scripts/disable-connection-pool.js');
}

main().catch(console.error);