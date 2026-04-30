#!/usr/bin/env node

/**
 * Diagnostic script to analyze pub/sub connectivity issues
 * 
 * This script connects to the production DHT network and diagnoses:
 * 1. Routing table vs actual connections mismatch
 * 2. Connection manager state for each peer
 * 3. Why pings might be failing
 * 4. Pub/sub channel join readiness
 */

import { NodeDHTClient } from '../src/index.js';

const BOOTSTRAP_URL = process.env.BOOTSTRAP_URL || 'wss://imeyouwe.com/ws';

class PubSubConnectivityDiagnostic {
  constructor() {
    this.client = null;
    this.diagnosticData = {
      routingTablePeers: [],
      connectedPeers: [],
      disconnectedPeers: [],
      peerDetails: new Map(),
      connectionManagerIssues: [],
      pingResults: new Map()
    };
  }

  async initialize() {
    console.log('🔍 Initializing DHT client for diagnostics...');
    console.log(`📡 Bootstrap URL: ${BOOTSTRAP_URL}`);
    
    this.client = new NodeDHTClient({
      bootstrapServers: [BOOTSTRAP_URL],
      nodeType: 'nodejs-active'
    });

    await this.client.start();
    console.log(`✅ DHT client started with node ID: ${this.client.dht.localNodeId.toString().substring(0, 8)}...`);
    
    // Wait for network to stabilize
    console.log('⏳ Waiting 10 seconds for network to stabilize...');
    await new Promise(resolve => setTimeout(resolve, 10000));
  }

  async analyzeRoutingTable() {
    console.log('\n📋 ROUTING TABLE ANALYSIS');
    console.log('=' .repeat(60));
    
    const dht = this.client.dht;
    const allNodes = dht.routingTable.getAllNodes();
    const connectedPeers = dht.getConnectedPeers();
    
    console.log(`Total nodes in routing table: ${allNodes.length}`);
    console.log(`Connected peers: ${connectedPeers.length}`);
    
    this.diagnosticData.routingTablePeers = allNodes.map(n => n.id.toString());
    this.diagnosticData.connectedPeers = connectedPeers;
    
    // Analyze each node
    for (const node of allNodes) {
      const peerId = node.id.toString();
      const isConnected = connectedPeers.includes(peerId);
      
      const peerDetail = {
        peerId: peerId.substring(0, 8),
        fullId: peerId,
        isConnected,
        hasConnectionManager: !!node.connectionManager,
        connectionManagerType: node.connectionManager?.constructor.name || 'none',
        connectionState: node.connectionManager?.connectionState || 'no_manager',
        hasConnection: !!node.connectionManager?.connection,
        metadata: node.metadata || {},
        lastSeen: node.lastSeen,
        failureCount: node.failureCount,
        isAlive: node.isAlive
      };
      
      this.diagnosticData.peerDetails.set(peerId, peerDetail);
      
      if (!isConnected) {
        this.diagnosticData.disconnectedPeers.push(peerId);
        
        // Diagnose why not connected
        const issues = [];
        if (!node.connectionManager) {
          issues.push('NO_CONNECTION_MANAGER');
        } else if (!node.connectionManager.connection) {
          issues.push('NO_CONNECTION_OBJECT');
        } else if (node.connectionManager.connectionState !== 'connected') {
          issues.push(`STATE_${node.connectionManager.connectionState?.toUpperCase() || 'UNKNOWN'}`);
        }
        
        if (!node.metadata?.listeningAddress && !node.metadata?.publicWssAddress) {
          issues.push('NO_ADDRESS');
        }
        
        if (node.metadata?.canAcceptConnections === false) {
          issues.push('CANNOT_ACCEPT_CONNECTIONS');
        }
        
        if (issues.length > 0) {
          this.diagnosticData.connectionManagerIssues.push({
            peerId: peerId.substring(0, 8),
            issues
          });
        }
      }
    }
    
    // Print summary
    console.log('\n📊 Peer Status Summary:');
    console.log(`  ✅ Connected: ${connectedPeers.length}`);
    console.log(`  ❌ Disconnected: ${this.diagnosticData.disconnectedPeers.length}`);
    
    if (this.diagnosticData.connectionManagerIssues.length > 0) {
      console.log('\n⚠️ Connection Issues:');
      for (const issue of this.diagnosticData.connectionManagerIssues) {
        console.log(`  ${issue.peerId}...: ${issue.issues.join(', ')}`);
      }
    }
  }

  async testPingConnectivity() {
    console.log('\n🏓 PING CONNECTIVITY TEST');
    console.log('=' .repeat(60));
    
    const dht = this.client.dht;
    const connectedPeers = dht.getConnectedPeers();
    
    console.log(`Testing ping to ${connectedPeers.length} connected peers...`);
    
    let successCount = 0;
    let failCount = 0;
    
    for (const peerId of connectedPeers.slice(0, 10)) { // Test first 10
      try {
        const result = await dht.pingPeer(peerId, 3000);
        this.diagnosticData.pingResults.set(peerId, result);
        
        if (result.success) {
          successCount++;
          console.log(`  ✅ ${peerId.substring(0, 8)}...: ${result.rtt}ms`);
        } else {
          failCount++;
          console.log(`  ❌ ${peerId.substring(0, 8)}...: ${result.error}`);
        }
      } catch (error) {
        failCount++;
        console.log(`  ❌ ${peerId.substring(0, 8)}...: ${error.message}`);
        this.diagnosticData.pingResults.set(peerId, { success: false, error: error.message });
      }
    }
    
    console.log(`\n📊 Ping Results: ${successCount} success, ${failCount} failed`);
  }

  async testPubSubReadiness() {
    console.log('\n📢 PUB/SUB READINESS CHECK');
    console.log('=' .repeat(60));
    
    const dht = this.client.dht;
    const connectedPeers = dht.getConnectedPeers();
    const routingTableSize = dht.routingTable.totalNodes;
    
    const checks = {
      dhtStarted: dht.isStarted,
      hasConnectedPeers: connectedPeers.length > 0,
      minPeersForPubSub: connectedPeers.length >= 3,
      routingTableHealthy: routingTableSize >= 5,
      bootstrapped: dht.isBootstrapped
    };
    
    console.log('Readiness Checks:');
    console.log(`  DHT Started: ${checks.dhtStarted ? '✅' : '❌'}`);
    console.log(`  Has Connected Peers: ${checks.hasConnectedPeers ? '✅' : '❌'} (${connectedPeers.length})`);
    console.log(`  Min Peers for Pub/Sub (3+): ${checks.minPeersForPubSub ? '✅' : '❌'}`);
    console.log(`  Routing Table Healthy (5+): ${checks.routingTableHealthy ? '✅' : '❌'} (${routingTableSize})`);
    console.log(`  Bootstrapped: ${checks.bootstrapped ? '✅' : '❌'}`);
    
    const ready = Object.values(checks).every(v => v);
    console.log(`\n🎯 Pub/Sub Ready: ${ready ? '✅ YES' : '❌ NO'}`);
    
    if (!ready) {
      console.log('\n💡 Recommendations:');
      if (!checks.hasConnectedPeers) {
        console.log('  - Check bootstrap server connectivity');
        console.log('  - Verify firewall allows WebSocket connections');
      }
      if (!checks.minPeersForPubSub) {
        console.log('  - Wait for more peers to connect');
        console.log('  - Check if bridge nodes are running');
      }
      if (!checks.routingTableHealthy) {
        console.log('  - Run find_node queries to discover more peers');
        console.log('  - Check if DHT network has enough nodes');
      }
    }
    
    return ready;
  }

  async analyzeConnectionChurn() {
    console.log('\n🔄 CONNECTION CHURN ANALYSIS');
    console.log('=' .repeat(60));
    
    const dht = this.client.dht;
    
    // Check for peers with connection managers but no actual connections
    const allNodes = dht.routingTable.getAllNodes();
    let churnCandidates = 0;
    
    for (const node of allNodes) {
      if (node.connectionManager && !node.connectionManager.isConnected()) {
        churnCandidates++;
        console.log(`  ⚠️ ${node.id.toString().substring(0, 8)}...: Has manager but not connected`);
        console.log(`     State: ${node.connectionManager.connectionState}`);
        console.log(`     Has connection object: ${!!node.connectionManager.connection}`);
      }
    }
    
    if (churnCandidates === 0) {
      console.log('  ✅ No connection churn detected');
    } else {
      console.log(`\n  ⚠️ Found ${churnCandidates} peers with potential connection churn`);
    }
  }

  async runFullDiagnostic() {
    try {
      await this.initialize();
      await this.analyzeRoutingTable();
      await this.testPingConnectivity();
      await this.analyzeConnectionChurn();
      await this.testPubSubReadiness();
      
      console.log('\n' + '=' .repeat(60));
      console.log('📋 DIAGNOSTIC COMPLETE');
      console.log('=' .repeat(60));
      
    } catch (error) {
      console.error('❌ Diagnostic failed:', error);
    } finally {
      if (this.client) {
        console.log('\n🛑 Stopping DHT client...');
        await this.client.stop();
      }
    }
  }
}

// Run diagnostic
const diagnostic = new PubSubConnectivityDiagnostic();
diagnostic.runFullDiagnostic().catch(console.error);
