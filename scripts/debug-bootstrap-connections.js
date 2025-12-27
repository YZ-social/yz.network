#!/usr/bin/env node

/**
 * Debug Bootstrap Server Connection Failures
 * 
 * This script diagnoses the "Unexpected server response: 200" error and other
 * bootstrap connection issues by testing:
 * 1. HTTP vs WebSocket endpoint behavior
 * 2. WebSocket upgrade header handling
 * 3. Bootstrap server response patterns
 * 4. Internal Docker vs external client connectivity
 * 
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
 */

import http from 'http';
import https from 'https';
import { execSync } from 'child_process';

// Run npm build first to ensure bundle-hash.json exists
console.log('🔨 Running npm run build to generate bundle-hash.json...');
try {
  execSync('npm run build', { stdio: 'inherit' });
  console.log('✅ Build complete\n');
} catch (error) {
  console.log('⚠️ Build failed, continuing with fallback BUILD_ID\n');
}

// Dynamic import for ws module
const WebSocket = (await import('ws')).default;

// Import version info for proper registration (after build)
const { PROTOCOL_VERSION, BUILD_ID } = await import('../src/version.js');

console.log('🔍 DEBUG: Bootstrap Server Connection Failures');
console.log('==============================================\n');
console.log(`📦 Using PROTOCOL_VERSION: ${PROTOCOL_VERSION}`);
console.log(`📦 Using BUILD_ID: ${BUILD_ID}\n`);

// Test endpoints
const ENDPOINTS = {
  // External endpoints (via nginx proxy)
  external: {
    bootstrap: 'wss://imeyouwe.com/ws',
    bridge1: 'wss://imeyouwe.com/bridge1',
    bridge2: 'wss://imeyouwe.com/bridge2',
    genesis: 'wss://imeyouwe.com/genesis',
    node1: 'wss://imeyouwe.com/node1'
  },
  // Internal Docker endpoints (direct container access)
  internal: {
    bootstrap: 'ws://localhost:8080',
    bridge1: 'ws://localhost:8083',
    bridge2: 'ws://localhost:8084',
    genesis: 'ws://localhost:8085',
    node1: 'ws://localhost:8086'
  }
};

const results = {
  httpTests: [],
  websocketTests: [],
  headerTests: [],
  coordinationTests: [],
  summary: {
    passed: 0,
    failed: 0,
    warnings: 0
  }
};

/**
 * Test 1: HTTP Request to WebSocket Endpoint
 * This tests if the endpoint returns HTTP 200 instead of upgrading to WebSocket
 */
async function testHttpToWebSocketEndpoint(name, url) {
  console.log(`\n📡 Testing HTTP request to ${name}: ${url}`);
  
  return new Promise((resolve) => {
    const isSecure = url.startsWith('wss://') || url.startsWith('https://');
    const httpUrl = url.replace('wss://', 'https://').replace('ws://', 'http://');
    
    const urlObj = new URL(httpUrl);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isSecure ? 443 : 80),
      path: urlObj.pathname || '/',
      method: 'GET',
      headers: {
        'Host': urlObj.hostname,
        'User-Agent': 'DHT-Debug-Script/1.0'
      },
      rejectUnauthorized: false // Allow self-signed certs for testing
    };

    const protocol = isSecure ? https : http;
    const req = protocol.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const result = {
          name,
          url,
          statusCode: res.statusCode,
          headers: res.headers,
          bodyPreview: body.substring(0, 200),
          issue: null
        };

        if (res.statusCode === 200) {
          // This is the "Unexpected server response: 200" scenario
          result.issue = 'HTTP_200_INSTEAD_OF_WEBSOCKET';
          console.log(`   ⚠️ Got HTTP 200 - this causes "Unexpected server response: 200" error`);
          console.log(`   📄 Response type: ${res.headers['content-type'] || 'unknown'}`);
          
          // Check if it's returning HTML (landing page) instead of WebSocket
          if (body.includes('<!DOCTYPE html>') || body.includes('<html>')) {
            result.issue = 'SERVING_HTML_LANDING_PAGE';
            console.log(`   ❌ Server is serving HTML landing page instead of WebSocket`);
            console.log(`   💡 This happens when nginx routes to HTTP handler instead of WebSocket`);
          }
          results.summary.warnings++;
        } else if (res.statusCode === 101) {
          console.log(`   ✅ Got 101 Switching Protocols (correct WebSocket upgrade)`);
          results.summary.passed++;
        } else if (res.statusCode === 426) {
          console.log(`   ℹ️ Got 426 Upgrade Required - server requires WebSocket upgrade`);
          results.summary.passed++;
        } else {
          console.log(`   ❓ Got HTTP ${res.statusCode}`);
          result.issue = `UNEXPECTED_STATUS_${res.statusCode}`;
        }

        results.httpTests.push(result);
        resolve(result);
      });
    });

    req.on('error', (error) => {
      console.log(`   ❌ HTTP request failed: ${error.message}`);
      results.httpTests.push({
        name,
        url,
        error: error.message,
        issue: 'CONNECTION_FAILED'
      });
      results.summary.failed++;
      resolve({ error: error.message });
    });

    req.setTimeout(10000, () => {
      req.destroy();
      console.log(`   ⏰ HTTP request timeout`);
      results.httpTests.push({
        name,
        url,
        error: 'Timeout',
        issue: 'TIMEOUT'
      });
      results.summary.failed++;
      resolve({ error: 'Timeout' });
    });

    req.end();
  });
}

/**
 * Test 2: WebSocket Connection with Proper Headers
 * Tests if WebSocket upgrade works correctly
 */
async function testWebSocketConnection(name, url, sendRegistration = false) {
  console.log(`\n🔌 Testing WebSocket connection to ${name}: ${url}`);
  
  return new Promise((resolve) => {
    let resolved = false;
    const startTime = Date.now();
    
    const ws = new WebSocket(url, {
      rejectUnauthorized: false, // Allow self-signed certs
      headers: {
        'User-Agent': 'DHT-Debug-Script/1.0'
      }
    });

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ws.close();
        console.log(`   ⏰ WebSocket connection timeout after ${Date.now() - startTime}ms`);
        results.websocketTests.push({
          name,
          url,
          error: 'Connection timeout',
          issue: 'WEBSOCKET_TIMEOUT'
        });
        results.summary.failed++;
        resolve({ error: 'Timeout' });
      }
    }, 15000);

    ws.on('open', () => {
      const connectTime = Date.now() - startTime;
      console.log(`   ✅ WebSocket connected in ${connectTime}ms`);
      
      if (sendRegistration) {
        // Send registration message to test bootstrap coordination
        console.log(`   📤 Sending registration message...`);
        ws.send(JSON.stringify({
          type: 'register',
          nodeId: 'debug_test_' + Date.now(),
          protocolVersion: PROTOCOL_VERSION,
          buildId: BUILD_ID,
          timestamp: Date.now(),
          metadata: {
            nodeType: 'debug',
            testMode: true
          }
        }));
      }
    });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        console.log(`   📥 Received message type: ${message.type}`);
        
        if (message.type === 'registered') {
          console.log(`   ✅ Registration successful!`);
          results.coordinationTests.push({
            name,
            url,
            registrationSuccess: true,
            message: message
          });
          results.summary.passed++;
        } else if (message.type === 'version_mismatch') {
          console.log(`   ⚠️ Version mismatch detected!`);
          console.log(`      Client version: ${message.clientVersion}`);
          console.log(`      Server version: ${message.serverVersion}`);
          results.coordinationTests.push({
            name,
            url,
            versionMismatch: true,
            clientVersion: message.clientVersion,
            serverVersion: message.serverVersion
          });
          results.summary.warnings++;
        } else if (message.type === 'error') {
          console.log(`   ❌ Server error: ${message.error || message.message}`);
          results.coordinationTests.push({
            name,
            url,
            serverError: message.error || message.message
          });
          results.summary.failed++;
        }
        
        // Close after receiving first message
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          ws.close();
          resolve({ success: true, message });
        }
      } catch (error) {
        console.log(`   ⚠️ Non-JSON message received: ${data.toString().substring(0, 100)}`);
      }
    });

    ws.on('error', (error) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        
        // Parse the error message for specific issues
        const errorMsg = error.message || error.toString();
        let issue = 'WEBSOCKET_ERROR';
        
        if (errorMsg.includes('Unexpected server response: 200')) {
          issue = 'HTTP_200_NOT_WEBSOCKET';
          console.log(`   ❌ "Unexpected server response: 200" - Server returned HTTP 200 instead of WebSocket upgrade`);
          console.log(`   💡 ROOT CAUSE: The endpoint is serving HTTP content (likely HTML) instead of accepting WebSocket connections`);
          console.log(`   💡 POSSIBLE FIXES:`);
          console.log(`      1. Check nginx proxy_pass configuration for WebSocket upgrade headers`);
          console.log(`      2. Verify the backend server is running and listening for WebSocket connections`);
          console.log(`      3. Ensure the URL path matches the WebSocket endpoint, not the HTTP endpoint`);
        } else if (errorMsg.includes('ECONNREFUSED')) {
          issue = 'CONNECTION_REFUSED';
          console.log(`   ❌ Connection refused - server not listening on this port`);
        } else if (errorMsg.includes('ETIMEDOUT')) {
          issue = 'CONNECTION_TIMEOUT';
          console.log(`   ❌ Connection timeout - server not responding`);
        } else if (errorMsg.includes('certificate')) {
          issue = 'SSL_CERTIFICATE_ERROR';
          console.log(`   ❌ SSL certificate error: ${errorMsg}`);
        } else {
          console.log(`   ❌ WebSocket error: ${errorMsg}`);
        }
        
        results.websocketTests.push({
          name,
          url,
          error: errorMsg,
          issue
        });
        results.summary.failed++;
        resolve({ error: errorMsg, issue });
      }
    });

    ws.on('close', (code, reason) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        
        const reasonStr = reason ? reason.toString() : '';
        console.log(`   🔌 WebSocket closed: ${code} ${reasonStr}`);
        
        if (code === 1000) {
          results.websocketTests.push({
            name,
            url,
            success: true,
            closeCode: code
          });
          results.summary.passed++;
        } else {
          results.websocketTests.push({
            name,
            url,
            closeCode: code,
            closeReason: reasonStr,
            issue: `UNEXPECTED_CLOSE_${code}`
          });
          if (code !== 1006) { // 1006 is abnormal closure, often from our timeout
            results.summary.warnings++;
          }
        }
        resolve({ closeCode: code, closeReason: reasonStr });
      }
    });
  });
}

/**
 * Test 3: Check WebSocket Upgrade Headers
 * Verifies that the server properly handles WebSocket upgrade requests
 */
async function testWebSocketUpgradeHeaders(name, url) {
  console.log(`\n🔧 Testing WebSocket upgrade headers for ${name}: ${url}`);
  
  return new Promise((resolve) => {
    const isSecure = url.startsWith('wss://');
    const httpUrl = url.replace('wss://', 'https://').replace('ws://', 'http://');
    
    const urlObj = new URL(httpUrl);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isSecure ? 443 : 80),
      path: urlObj.pathname || '/',
      method: 'GET',
      headers: {
        'Host': urlObj.hostname,
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
        'User-Agent': 'DHT-Debug-Script/1.0'
      },
      rejectUnauthorized: false
    };

    const protocol = isSecure ? https : http;
    const req = protocol.request(options, (res) => {
      const result = {
        name,
        url,
        statusCode: res.statusCode,
        upgradeHeader: res.headers['upgrade'],
        connectionHeader: res.headers['connection'],
        secWebSocketAccept: res.headers['sec-websocket-accept']
      };

      if (res.statusCode === 101) {
        console.log(`   ✅ Got 101 Switching Protocols - WebSocket upgrade successful`);
        console.log(`      Upgrade: ${res.headers['upgrade']}`);
        console.log(`      Connection: ${res.headers['connection']}`);
        console.log(`      Sec-WebSocket-Accept: ${res.headers['sec-websocket-accept']}`);
        result.success = true;
        results.summary.passed++;
      } else if (res.statusCode === 200) {
        console.log(`   ❌ Got HTTP 200 instead of 101 - WebSocket upgrade FAILED`);
        console.log(`   💡 The server is not properly handling WebSocket upgrade requests`);
        console.log(`   💡 Check if:`);
        console.log(`      1. nginx is forwarding Upgrade and Connection headers`);
        console.log(`      2. The backend WebSocket server is running`);
        console.log(`      3. The URL path is correct for WebSocket endpoint`);
        result.issue = 'UPGRADE_FAILED_HTTP_200';
        results.summary.failed++;
      } else {
        console.log(`   ❓ Got HTTP ${res.statusCode} - unexpected response`);
        result.issue = `UNEXPECTED_STATUS_${res.statusCode}`;
        results.summary.warnings++;
      }

      results.headerTests.push(result);
      resolve(result);
    });

    req.on('error', (error) => {
      console.log(`   ❌ Request failed: ${error.message}`);
      results.headerTests.push({
        name,
        url,
        error: error.message,
        issue: 'REQUEST_FAILED'
      });
      results.summary.failed++;
      resolve({ error: error.message });
    });

    req.setTimeout(10000, () => {
      req.destroy();
      console.log(`   ⏰ Request timeout`);
      results.headerTests.push({
        name,
        url,
        error: 'Timeout',
        issue: 'TIMEOUT'
      });
      results.summary.failed++;
      resolve({ error: 'Timeout' });
    });

    req.end();
  });
}

/**
 * Test 4: Bootstrap Coordination Test
 * Tests if bootstrap server can coordinate peer introductions
 */
async function testBootstrapCoordination(url) {
  console.log(`\n🤝 Testing bootstrap coordination at: ${url}`);
  
  return new Promise((resolve) => {
    let resolved = false;
    const testNodeId = 'debug_coord_test_' + Date.now();
    
    const ws = new WebSocket(url, {
      rejectUnauthorized: false
    });

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ws.close();
        console.log(`   ⏰ Coordination test timeout`);
        resolve({ error: 'Timeout' });
      }
    }, 20000);

    let registrationReceived = false;
    let peersReceived = false;

    ws.on('open', () => {
      console.log(`   ✅ Connected to bootstrap server`);
      
      // Step 1: Register
      console.log(`   📤 Sending registration...`);
      ws.send(JSON.stringify({
        type: 'register',
        nodeId: testNodeId,
        protocolVersion: PROTOCOL_VERSION,
        buildId: BUILD_ID,
        timestamp: Date.now(),
        metadata: {
          nodeType: 'debug',
          testMode: true
        }
      }));
    });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        console.log(`   📥 Received: ${message.type}`);
        
        if (message.type === 'registered') {
          registrationReceived = true;
          console.log(`   ✅ Registration confirmed`);
          
          // Step 2: Request peers
          console.log(`   📤 Requesting peers/genesis...`);
          ws.send(JSON.stringify({
            type: 'get_peers_or_genesis',
            nodeId: testNodeId,
            maxPeers: 10,
            requestId: 'debug_req_' + Date.now(),
            metadata: {
              nodeType: 'debug',
              testMode: true
            }
          }));
        } else if (message.type === 'response') {
          peersReceived = true;
          console.log(`   ✅ Got response:`);
          console.log(`      Success: ${message.success}`);
          console.log(`      Is Genesis: ${message.data?.isGenesis || false}`);
          console.log(`      Peers: ${message.data?.peers?.length || 0}`);
          
          if (message.data?.peers?.length > 0) {
            console.log(`   📋 Peer list:`);
            message.data.peers.forEach((peer, i) => {
              console.log(`      ${i + 1}. ${peer.nodeId?.substring(0, 16)}... (${peer.metadata?.nodeType || 'unknown'})`);
            });
          }
          
          results.coordinationTests.push({
            url,
            registrationSuccess: registrationReceived,
            peersReceived: true,
            isGenesis: message.data?.isGenesis,
            peerCount: message.data?.peers?.length || 0
          });
          
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            ws.close();
            results.summary.passed++;
            resolve({ success: true, data: message.data });
          }
        } else if (message.type === 'version_mismatch') {
          console.log(`   ⚠️ Version mismatch - coordination may fail`);
          results.coordinationTests.push({
            url,
            versionMismatch: true,
            clientVersion: message.clientVersion,
            serverVersion: message.serverVersion
          });
          
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            ws.close();
            results.summary.warnings++;
            resolve({ versionMismatch: true });
          }
        } else if (message.type === 'error') {
          console.log(`   ❌ Server error: ${message.error}`);
          
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            ws.close();
            results.summary.failed++;
            resolve({ error: message.error });
          }
        }
      } catch (error) {
        console.log(`   ⚠️ Parse error: ${error.message}`);
      }
    });

    ws.on('error', (error) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        console.log(`   ❌ WebSocket error: ${error.message}`);
        results.summary.failed++;
        resolve({ error: error.message });
      }
    });

    ws.on('close', (code, reason) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        console.log(`   🔌 Connection closed: ${code} ${reason}`);
        resolve({ closeCode: code });
      }
    });
  });
}

/**
 * Main diagnostic function
 */
async function runDiagnostics() {
  console.log('📋 DIAGNOSTIC PLAN:');
  console.log('1. Test HTTP requests to WebSocket endpoints (detect HTTP 200 issue)');
  console.log('2. Test WebSocket connections with proper upgrade');
  console.log('3. Test WebSocket upgrade header handling');
  console.log('4. Test bootstrap coordination flow');
  console.log('');

  // Test 1: HTTP to WebSocket endpoints
  console.log('\n' + '='.repeat(60));
  console.log('TEST 1: HTTP REQUESTS TO WEBSOCKET ENDPOINTS');
  console.log('='.repeat(60));
  
  for (const [name, url] of Object.entries(ENDPOINTS.external)) {
    await testHttpToWebSocketEndpoint(`External ${name}`, url);
  }

  // Test 2: WebSocket connections
  console.log('\n' + '='.repeat(60));
  console.log('TEST 2: WEBSOCKET CONNECTIONS');
  console.log('='.repeat(60));
  
  for (const [name, url] of Object.entries(ENDPOINTS.external)) {
    await testWebSocketConnection(`External ${name}`, url, name === 'bootstrap');
  }

  // Test 3: WebSocket upgrade headers
  console.log('\n' + '='.repeat(60));
  console.log('TEST 3: WEBSOCKET UPGRADE HEADERS');
  console.log('='.repeat(60));
  
  await testWebSocketUpgradeHeaders('External bootstrap', ENDPOINTS.external.bootstrap);

  // Test 4: Bootstrap coordination
  console.log('\n' + '='.repeat(60));
  console.log('TEST 4: BOOTSTRAP COORDINATION');
  console.log('='.repeat(60));
  
  await testBootstrapCoordination(ENDPOINTS.external.bootstrap);

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('DIAGNOSTIC SUMMARY');
  console.log('='.repeat(60));
  
  console.log(`\n📊 Results:`);
  console.log(`   ✅ Passed: ${results.summary.passed}`);
  console.log(`   ⚠️ Warnings: ${results.summary.warnings}`);
  console.log(`   ❌ Failed: ${results.summary.failed}`);

  // Identify root causes
  console.log(`\n🔍 ROOT CAUSE ANALYSIS:`);
  
  const http200Issues = results.httpTests.filter(t => t.issue === 'HTTP_200_INSTEAD_OF_WEBSOCKET' || t.issue === 'SERVING_HTML_LANDING_PAGE');
  if (http200Issues.length > 0) {
    console.log(`\n❌ ISSUE: "Unexpected server response: 200" detected`);
    console.log(`   Affected endpoints:`);
    http200Issues.forEach(t => console.log(`      - ${t.name}: ${t.url}`));
    console.log(`\n   ROOT CAUSE: The server is returning HTTP 200 with HTML content instead of`);
    console.log(`   accepting WebSocket upgrade. This typically happens when:`);
    console.log(`   1. nginx is not forwarding WebSocket upgrade headers properly`);
    console.log(`   2. The backend WebSocket server is not running`);
    console.log(`   3. The URL path doesn't match the WebSocket endpoint`);
    console.log(`\n   RECOMMENDED FIXES:`);
    console.log(`   1. Verify nginx config has: proxy_set_header Upgrade $http_upgrade;`);
    console.log(`   2. Verify nginx config has: proxy_set_header Connection "upgrade";`);
    console.log(`   3. Check if backend containers are running: docker ps`);
    console.log(`   4. Check backend logs: docker logs yz-bootstrap-server`);
  }

  const connectionRefused = results.websocketTests.filter(t => t.issue === 'CONNECTION_REFUSED');
  if (connectionRefused.length > 0) {
    console.log(`\n❌ ISSUE: Connection refused`);
    console.log(`   Affected endpoints:`);
    connectionRefused.forEach(t => console.log(`      - ${t.name}: ${t.url}`));
    console.log(`\n   ROOT CAUSE: The backend server is not listening on the expected port.`);
    console.log(`   RECOMMENDED FIXES:`);
    console.log(`   1. Check if containers are running: docker ps`);
    console.log(`   2. Restart containers: docker-compose restart`);
  }

  const versionMismatches = results.coordinationTests.filter(t => t.versionMismatch);
  if (versionMismatches.length > 0) {
    console.log(`\n⚠️ ISSUE: Version mismatch detected`);
    console.log(`   This can cause connection rejections.`);
    console.log(`   RECOMMENDED FIXES:`);
    console.log(`   1. Rebuild the application: npm run build`);
    console.log(`   2. Redeploy containers with new build`);
  }

  // Check if coordination is working
  const coordSuccess = results.coordinationTests.filter(t => t.registrationSuccess && t.peersReceived);
  if (coordSuccess.length > 0) {
    console.log(`\n✅ Bootstrap coordination is WORKING`);
    coordSuccess.forEach(t => {
      console.log(`   - ${t.url}: ${t.peerCount} peers available, isGenesis: ${t.isGenesis}`);
    });
  } else {
    console.log(`\n❌ Bootstrap coordination is NOT WORKING`);
    console.log(`   Nodes cannot join the DHT network without working bootstrap coordination.`);
  }

  console.log(`\n📋 DETAILED RESULTS:`);
  console.log(JSON.stringify(results, null, 2));

  return results;
}

// Run diagnostics
runDiagnostics().then(results => {
  console.log('\n✅ Diagnostic complete');
  process.exit(results.summary.failed > 0 ? 1 : 0);
}).catch(error => {
  console.error('❌ Diagnostic failed:', error);
  process.exit(1);
});
