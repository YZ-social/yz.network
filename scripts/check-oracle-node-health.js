#!/usr/bin/env node

/**
 * Oracle Node Health Check
 * 
 * Quick health check of the 15 Oracle nodes to see if they're
 * responding properly and identify any obvious issues.
 */

import { NodeDHTClient } from '../src/NodeDHTClient.js';

class OracleNodeHealthCheck {
  constructor() {
    this.client = null;
    this.healthData = {
      totalNodes: 0,
      responsiveNodes: 0,
      slowNodes: 0,
      timeoutNodes: 0,
      nodeDetails: []
    };
  }

  async start() {
    console.log('🏥 Oracle Node Health Check Starting...');
    
    try {
      // Create a minimal DHT client
      this.client = new NodeDHTClient({
        bootstrapServers: ['wss://imeyouwe.com/bootstrap'],
        // Minimal intervals to reduce noise
        aggressiveRefreshInterval: 300000, // 5 minutes
        findNodeMinInterval: 2000, // 2 seconds
        pingInterval: 300000 // 5 minutes
      });

      await this.client.start();
      console.log('✅ Connected to DHT network');

      // Wait a moment for connections to establish
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Get all connected peers
      const connectedPeers = this.client.dht.getConnectedPeers();
      const allNodes = this.client.dht.routingTable.getAllNodes();
      
      console.log(`📊 Network Status:`);
      console.log(`   Connected peers: ${connectedPeers.length}`);
      console.log(`   Routing table entries: ${allNodes.length}`);
      
      // Test each node's responsiveness
      await this.testNodeResponsiveness(allNodes);
      
      // Generate health report
      this.generateHealthReport();

    } catch (error) {
      console.error('❌ Health check failed:', error);
    } finally {
      if (this.client) {
        await this.client.stop();
      }
    }
  }

  async testNodeResponsiveness(nodes) {
    console.log('\n🧪 Testing node responsiveness...');
    
    this.healthData.totalNodes = nodes.length;
    
    for (const node of nodes) {
      const peerId = node.id.toString();
      const isConnected = this.client.dht.isPeerConnected(peerId);
      
      console.log(`\n🔍 Testing ${peerId.substring(0, 8)}... (connected: ${isConnected})`);
      
      const nodeHealth = {
        peerId: peerId.substring(0, 8),
        connected: isConnected,
        pingTime: null,
        findNodeTime: null,
        errors: []
      };

      if (!isConnected) {
        nodeHealth.errors.push('Not connected');
        this.healthData.nodeDetails.push(nodeHealth);
        continue;
      }

      // Test 1: Ping
      try {
        const pingStart = Date.now();
        await this.client.dht.sendRequestWithResponse(peerId, {
          type: 'ping',
          requestId: this.client.dht.generateRequestId(),
          timestamp: Date.now(),
          nodeId: this.client.dht.localNodeId.toString()
        }, 5000); // 5 second timeout
        
        nodeHealth.pingTime = Date.now() - pingStart;
        console.log(`   ✅ Ping: ${nodeHealth.pingTime}ms`);
        
      } catch (error) {
        nodeHealth.errors.push(`Ping failed: ${error.message}`);
        console.log(`   ❌ Ping failed: ${error.message}`);
      }

      // Test 2: Find Node (only if ping succeeded)
      if (nodeHealth.pingTime !== null) {
        try {
          const findNodeStart = Date.now();
          await this.client.dht.sendFindNode(peerId, this.client.dht.localNodeId, { timeout: 5000 });
          
          nodeHealth.findNodeTime = Date.now() - findNodeStart;
          console.log(`   ✅ Find Node: ${nodeHealth.findNodeTime}ms`);
          
        } catch (error) {
          nodeHealth.errors.push(`Find Node failed: ${error.message}`);
          console.log(`   ❌ Find Node failed: ${error.message}`);
        }
      }

      // Categorize node health
      if (nodeHealth.errors.length === 0) {
        if (nodeHealth.pingTime > 2000 || nodeHealth.findNodeTime > 5000) {
          this.healthData.slowNodes++;
        } else {
          this.healthData.responsiveNodes++;
        }
      } else {
        this.healthData.timeoutNodes++;
      }

      this.healthData.nodeDetails.push(nodeHealth);
      
      // Small delay between tests to avoid overwhelming nodes
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  generateHealthReport() {
    console.log('\n📊 ORACLE NODE HEALTH REPORT');
    console.log('==============================');
    
    console.log(`Total Nodes: ${this.healthData.totalNodes}`);
    console.log(`Responsive Nodes: ${this.healthData.responsiveNodes} (${Math.round(this.healthData.responsiveNodes / this.healthData.totalNodes * 100)}%)`);
    console.log(`Slow Nodes: ${this.healthData.slowNodes} (${Math.round(this.healthData.slowNodes / this.healthData.totalNodes * 100)}%)`);
    console.log(`Timeout/Error Nodes: ${this.healthData.timeoutNodes} (${Math.round(this.healthData.timeoutNodes / this.healthData.totalNodes * 100)}%)`);
    
    console.log('\n📋 DETAILED NODE STATUS:');
    
    // Sort by health (responsive first, then slow, then errors)
    const sortedNodes = this.healthData.nodeDetails.sort((a, b) => {
      if (a.errors.length === 0 && b.errors.length > 0) return -1;
      if (a.errors.length > 0 && b.errors.length === 0) return 1;
      if (a.pingTime && b.pingTime) return a.pingTime - b.pingTime;
      return 0;
    });

    for (const node of sortedNodes) {
      const status = node.errors.length === 0 ? '✅' : '❌';
      const ping = node.pingTime ? `${node.pingTime}ms` : 'N/A';
      const findNode = node.findNodeTime ? `${node.findNodeTime}ms` : 'N/A';
      
      console.log(`   ${status} ${node.peerId}... | Ping: ${ping} | FindNode: ${findNode} | Connected: ${node.connected}`);
      
      if (node.errors.length > 0) {
        for (const error of node.errors) {
          console.log(`      ⚠️ ${error}`);
        }
      }
    }

    console.log('\n💡 ANALYSIS:');
    
    if (this.healthData.timeoutNodes > this.healthData.totalNodes * 0.3) {
      console.log('   🚨 HIGH FAILURE RATE: More than 30% of nodes are unresponsive');
      console.log('      - Check if Oracle server is overloaded');
      console.log('      - Verify network connectivity between nodes');
      console.log('      - Check for resource constraints (CPU, memory, network)');
    }
    
    if (this.healthData.slowNodes > this.healthData.totalNodes * 0.5) {
      console.log('   ⚠️ HIGH LATENCY: More than 50% of nodes are slow to respond');
      console.log('      - Oracle server may be under heavy load');
      console.log('      - Consider reducing DHT maintenance intervals');
      console.log('      - Check for network congestion');
    }
    
    if (this.healthData.responsiveNodes < 5) {
      console.log('   🚨 INSUFFICIENT RESPONSIVE NODES: Less than 5 nodes are responsive');
      console.log('      - DHT operations will be unreliable');
      console.log('      - Channel creation will likely fail');
      console.log('      - Immediate intervention required');
    }

    const avgPingTime = this.healthData.nodeDetails
      .filter(n => n.pingTime !== null)
      .reduce((sum, n) => sum + n.pingTime, 0) / 
      this.healthData.nodeDetails.filter(n => n.pingTime !== null).length;
    
    if (avgPingTime > 1000) {
      console.log(`   ⚠️ HIGH AVERAGE PING TIME: ${Math.round(avgPingTime)}ms`);
      console.log('      - Network or server performance issues likely');
    }

    console.log('\n✅ Health check complete.');
  }
}

// Run the health check
const healthCheck = new OracleNodeHealthCheck();
healthCheck.start().catch(console.error);