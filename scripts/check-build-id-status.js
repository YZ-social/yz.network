#!/usr/bin/env node
/**
 * Quick diagnostic to check BUILD_ID status across the network
 */

import WebSocket from 'ws';
import https from 'https';

const BOOTSTRAP_URL = 'wss://imeyouwe.com/ws';

async function checkBootstrapBuildId() {
    return new Promise((resolve) => {
        console.log('🔍 Checking Bootstrap Server BUILD_ID...\n');
        
        const ws = new WebSocket(BOOTSTRAP_URL, {
            rejectUnauthorized: false,
            headers: {
                'Origin': 'https://imeyouwe.com'
            }
        });
        
        const timeout = setTimeout(() => {
            ws.close();
            resolve({ error: 'timeout' });
        }, 10000);
        
        ws.on('open', () => {
            // Send a registration message to trigger version check
            ws.send(JSON.stringify({
                type: 'register',
                nodeId: 'build-id-check-' + Date.now(),
                version: '1.0.0',
                buildId: 'diagnostic-check',
                address: 'diagnostic://check',
                capabilities: ['dht']
            }));
        });
        
        ws.on('message', (data) => {
            clearTimeout(timeout);
            try {
                const msg = JSON.parse(data.toString());
                console.log('📨 Response from bootstrap:', JSON.stringify(msg, null, 2));
                
                if (msg.type === 'version_mismatch') {
                    console.log('\n❌ VERSION MISMATCH DETECTED!');
                    console.log(`   Server BUILD_ID: ${msg.serverBuildId}`);
                    console.log(`   Our BUILD_ID:    diagnostic-check`);
                    resolve({ mismatch: true, serverBuildId: msg.serverBuildId });
                } else if (msg.type === 'registered' || msg.type === 'welcome') {
                    console.log('\n✅ Registration accepted (no version mismatch)');
                    resolve({ mismatch: false, serverBuildId: msg.buildId || 'unknown' });
                } else {
                    resolve({ response: msg });
                }
            } catch (e) {
                resolve({ error: 'parse error', raw: data.toString() });
            }
            ws.close();
        });
        
        ws.on('error', (err) => {
            clearTimeout(timeout);
            console.log('❌ WebSocket error:', err.message);
            resolve({ error: err.message });
        });
    });
}

async function checkNodeHealth(nodePath, nodeName) {
    return new Promise((resolve) => {
        const url = `https://imeyouwe.com/${nodePath}/health`;
        
        https.get(url, { rejectUnauthorized: false }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const health = JSON.parse(data);
                    resolve({
                        name: nodeName,
                        healthy: health.healthy,
                        peers: health.connectedPeers || 0,
                        bootstrap: health.bootstrapConnected,
                        buildId: health.buildId || 'not-reported'
                    });
                } catch (e) {
                    resolve({ name: nodeName, error: 'parse error' });
                }
            });
        }).on('error', (err) => {
            resolve({ name: nodeName, error: err.message });
        });
    });
}

async function main() {
    console.log('🔧 BUILD_ID Status Checker');
    console.log('==========================\n');
    
    // Check bootstrap
    const bootstrapResult = await checkBootstrapBuildId();
    
    console.log('\n📊 Checking Node Health Status...\n');
    
    // Check a few nodes
    const nodes = [
        { path: 'genesis', name: 'genesis' },
        { path: 'bridge1', name: 'bridge-1' },
        { path: 'bridge2', name: 'bridge-2' },
        { path: 'node1', name: 'node-1' },
        { path: 'node5', name: 'node-5' },
        { path: 'node10', name: 'node-10' },
    ];
    
    for (const node of nodes) {
        const result = await checkNodeHealth(node.path, node.name);
        if (result.error) {
            console.log(`   ${result.name}: ❌ ${result.error}`);
        } else {
            const status = result.healthy ? '✅' : '❌';
            const bootstrap = result.bootstrap ? '✓' : '✗';
            console.log(`   ${result.name}: ${status} peers=${result.peers}, bootstrap=${bootstrap}, buildId=${result.buildId}`);
        }
    }
    
    console.log('\n💡 ANALYSIS:');
    console.log('============');
    
    if (bootstrapResult.mismatch) {
        console.log('❌ The bootstrap server is rejecting connections due to BUILD_ID mismatch.');
        console.log('   This means nodes cannot register with the bootstrap server.');
        console.log('\n   SOLUTION: Ensure dist/bundle-hash.json is mounted in all containers');
        console.log('   and that all containers are using the SAME bundle-hash.json file.');
    } else if (bootstrapResult.error) {
        console.log(`⚠️ Could not connect to bootstrap: ${bootstrapResult.error}`);
    } else {
        console.log('✅ Bootstrap server is accepting connections.');
        console.log('   If nodes still show 0 peers, the issue is elsewhere:');
        console.log('   - Check if nodes can reach each other internally');
        console.log('   - Check Docker networking');
        console.log('   - Check nginx proxy configuration');
    }
}

main().catch(console.error);
