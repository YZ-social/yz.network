#!/usr/bin/env node

/**
 * DHT Bottleneck Diagnostic Script
 * 
 * Investigates why DHT find_node operations are timing out
 * with only 15 nodes on the Oracle server.
 * 
 * Potential causes:
 * 1. Message flooding from excessive find_node requests
 * 2. Rate limiting causing artificial delays
 * 3. Connection health issues
 * 4. Routing table inconsistencies
 * 5. Bootstrap/maintenance task conflicts
 */

import { NodeDHTClient } from '../src/NodeDHTClient.js';
import { Logger } from '../src/utils/Logger.js';

// Enable detailed logging
Logger.setLevel('debug');

class DHTBottleneckDiagnostic {
  constructor() {
    this.client = null;
    this.diagnosticData = {
      messageStats: new Map(), // messageType -> count
      peerResponseTimes: new Map(), // peerId -> [responseTimes]
      timeoutPeers: new Set(),
      rateLimitHits: 0,
      connectionIssues: [],
      routingTableChanges: []
    };
    this.startTime = Date.now();
  }

  async start() {
    console.log('🔍 Starting DHT Bottleneck Diagnostic...');
    console.log('📊 This will monitor DHT operations for 60 seconds to identify bottlenecks');
    
    try {
      // Create DHT client with diagnostic hooks
      this.client = new NodeDHTClient({
        bootstrapServers: ['wss://imeyouwe.com/bootstrap'],
        // Reduce aggressive intervals to see if that helps
        aggressiveRefreshInterval: 30000, // 30s instead of 15s
        findNodeMinInterval: 1000, // 1s instead of 500ms
        pingInterval: 120000 // 2 minutes instead of 1 minute
      });

      // Hook into DHT events for monitoring
      this.setupDiagnosticHooks();

      // Start the client
      await this.client.start();
      console.log('✅ DHT client started, monitoring for bottlenecks...');

      // Monitor for 60 seconds
      await this.monitorForBottlenecks();

      // Generate diagnostic report
      this.generateReport();

    } catch (error) {
      console.error('❌ Diagnostic failed:', error);
    } finally {
      if (this.client) {
        await this.client.stop();
      }
    }
  }

  setupDiagnosticHooks() {
    const dht = this.client.dht;
    
    // Hook into message sending to track message volume
    const originalSendMessage = dht.sendMessage.bind(dht);
    dht.sendMessage = async (peerId, message) => {
      const messageType = message.type;
      const currentCount = this.diagnosticData.messageStats.get(messageType) || 0;
      this.diagnosticData.messageStats.set(messageType, currentCount + 1);
      
      console.log(`📤 [${messageType}] -> ${peerId.substring(0, 8)}... (total ${messageType}: ${currentCount + 1})`);
      
      const startTime = Date.now();
      try {
        const result = await originalSendMessage(peerId, message);
        const responseTime = Date.now() - startTime;
        
        // Track response times per peer
        if (!this.diagnosticData.peerResponseTimes.has(peerId)) {
          this.diagnosticData.peerResponseTimes.set(peerId, []);
        }
        this.diagnosticData.peerResponseTimes.get(peerId).push(responseTime);
        
        return result;
      } catch (error) {
        const responseTime = Date.now() - startTime;
        console.log(`❌ [${messageType}] timeout to ${peerId.substring(0, 8)}... after ${responseTime}ms: ${error.message}`);
        
        if (error.message.includes('timeout')) {
          this.diagnosticData.timeoutPeers.add(peerId);
        }
        if (error.message.includes('rate limit')) {
          this.diagnosticData.rateLimitHits++;
        }
        
        throw error;
      }
    };

    // Hook into routing table changes
    const originalAddNode = dht.routingTable.addNode.bind(dht.routingTable);
    dht.routingTable.addNode = (node) => {
      this.diagnosticData.routingTableChanges.push({
        action: 'add',
        nodeId: node.id.toString().substring(0, 8),
        timestamp: Date.now()
      });
      return originalAddNode(node);
    };

    const originalRemoveNode = dht.routingTable.removeNode.bind(dht.routingTable);
    dht.routingTable.removeNode = (peerId) => {
      this.diagnosticData.routingTableChanges.push({
        action: 'remove',
        nodeId: peerId.substring(0, 8),
        timestamp: Date.now()
      });
      return originalRemoveNode(peerId);
    };

    // Hook into connection issues
    dht.on('connectionError', (error) => {
      this.diagnosticData.connectionIssues.push({
        error: error.message,
        timestamp: Date.now()
      });
    });
  }

  async monitorForBottlenecks() {
    console.log('⏱️ Monitoring DHT operations for 60 seconds...');
    
    // Test basic DHT operations every 10 seconds
    const testInterval = setInterval(async () => {
      try {
        console.log('\n🧪 Testing DHT operations...');
        
        // Test 1: Simple find_node for our own ID (should be fast)
        const startTime = Date.now();
        const nodes = await this.client.dht.findNode(this.client.dht.localNodeId);
        const findNodeTime = Date.now() - startTime;
        console.log(`   find_node completed in ${findNodeTime}ms (found ${nodes.length} nodes)`);
        
        // Test 2: Try to store and retrieve a test value
        const testKey = `diagnostic_test_${Date.now()}`;
        const testValue = JSON.stringify({ test: true, timestamp: Date.now() });
        
        const storeStart = Date.now();
        await this.client.dht.store(testKey, testValue);
        const storeTime = Date.now() - storeStart;
        console.log(`   store completed in ${storeTime}ms`);
        
        const getStart = Date.now();
        const retrievedValue = await this.client.dht.getFromNetwork(testKey);
        const getTime = Date.now() - getStart;
        console.log(`   getFromNetwork completed in ${getTime}ms (found: ${!!retrievedValue})`);
        
        // Test 3: Check connection health
        const connectedPeers = this.client.dht.getConnectedPeers();
        const routingTableSize = this.client.dht.routingTable.getAllNodes().length;
        console.log(`   Connected peers: ${connectedPeers.length}, Routing table: ${routingTableSize}`);
        
      } catch (error) {
        console.error(`   ❌ DHT operation failed: ${error.message}`);
      }
    }, 10000);

    // Wait for 60 seconds
    await new Promise(resolve => setTimeout(resolve, 60000));
    clearInterval(testInterval);
  }

  generateReport() {
    console.log('\n📊 DHT BOTTLENECK DIAGNOSTIC REPORT');
    console.log('=====================================');
    
    const duration = Date.now() - this.startTime;
    console.log(`Monitoring Duration: ${Math.round(duration / 1000)}s`);
    
    // Message volume analysis
    console.log('\n📤 MESSAGE VOLUME:');
    let totalMessages = 0;
    for (const [messageType, count] of this.diagnosticData.messageStats.entries()) {
      console.log(`   ${messageType}: ${count} messages`);
      totalMessages += count;
    }
    console.log(`   TOTAL: ${totalMessages} messages (${(totalMessages / (duration / 1000)).toFixed(1)} msg/sec)`);
    
    // Response time analysis
    console.log('\n⏱️ RESPONSE TIMES:');
    for (const [peerId, responseTimes] of this.diagnosticData.peerResponseTimes.entries()) {
      const avg = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
      const max = Math.max(...responseTimes);
      const min = Math.min(...responseTimes);
      console.log(`   ${peerId.substring(0, 8)}...: avg=${Math.round(avg)}ms, min=${min}ms, max=${max}ms (${responseTimes.length} requests)`);
    }
    
    // Timeout analysis
    console.log('\n⏰ TIMEOUT ANALYSIS:');
    console.log(`   Peers with timeouts: ${this.diagnosticData.timeoutPeers.size}`);
    for (const peerId of this.diagnosticData.timeoutPeers) {
      console.log(`     - ${peerId.substring(0, 8)}...`);
    }
    
    // Rate limiting
    console.log('\n🚫 RATE LIMITING:');
    console.log(`   Rate limit hits: ${this.diagnosticData.rateLimitHits}`);
    
    // Connection issues
    console.log('\n🔌 CONNECTION ISSUES:');
    console.log(`   Total connection errors: ${this.diagnosticData.connectionIssues.length}`);
    const recentIssues = this.diagnosticData.connectionIssues.slice(-5);
    for (const issue of recentIssues) {
      console.log(`     - ${issue.error}`);
    }
    
    // Routing table churn
    console.log('\n📋 ROUTING TABLE CHURN:');
    const adds = this.diagnosticData.routingTableChanges.filter(c => c.action === 'add').length;
    const removes = this.diagnosticData.routingTableChanges.filter(c => c.action === 'remove').length;
    console.log(`   Nodes added: ${adds}, Nodes removed: ${removes}`);
    
    // Recommendations
    console.log('\n💡 RECOMMENDATIONS:');
    
    if (totalMessages / (duration / 1000) > 10) {
      console.log('   ⚠️ HIGH MESSAGE VOLUME: Consider increasing rate limiting intervals');
    }
    
    if (this.diagnosticData.timeoutPeers.size > 3) {
      console.log('   ⚠️ MULTIPLE TIMEOUT PEERS: Network may be overloaded or nodes unresponsive');
    }
    
    if (this.diagnosticData.rateLimitHits > 5) {
      console.log('   ⚠️ FREQUENT RATE LIMITING: Reduce find_node frequency or increase intervals');
    }
    
    if (removes > adds * 2) {
      console.log('   ⚠️ HIGH ROUTING TABLE CHURN: Nodes being removed faster than added');
    }
    
    // Check for specific bottleneck patterns
    const findNodeCount = this.diagnosticData.messageStats.get('find_node') || 0;
    const findNodeResponseCount = this.diagnosticData.messageStats.get('find_node_response') || 0;
    
    if (findNodeCount > findNodeResponseCount * 1.5) {
      console.log('   🚨 FIND_NODE BOTTLENECK: Many requests but few responses - nodes may be overloaded');
    }
    
    console.log('\n✅ Diagnostic complete. Check the recommendations above to identify bottlenecks.');
  }
}

// Run the diagnostic
const diagnostic = new DHTBottleneckDiagnostic();
diagnostic.start().catch(console.error);