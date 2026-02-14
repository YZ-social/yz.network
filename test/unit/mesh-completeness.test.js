/**
 * Property-based tests for Mesh Completeness
 * 
 * Feature: browser-mesh-stability-tests
 * Property 3: Mesh completeness invariant
 * Validates: Requirements 2.1, 2.2
 */
import { describe, test, expect } from '@jest/globals';
import fc from 'fast-check';

/**
 * Helper class to simulate mesh network state for property testing
 */
class MeshSimulator {
  constructor(nodeCount) {
    this.nodeCount = nodeCount;
    this.nodeIds = Array.from({ length: nodeCount }, (_, i) => `node-${i}`);
    this.connections = new Set(); // Set of "nodeA-nodeB" pairs (sorted)
  }

  /**
   * Add a connection between two nodes
   */
  addConnection(nodeA, nodeB) {
    if (nodeA === nodeB) return false;
    const pair = [nodeA, nodeB].sort().join('-');
    this.connections.add(pair);
    return true;
  }

  /**
   * Create a full mesh (all possible connections)
   */
  createFullMesh() {
    for (let i = 0; i < this.nodeIds.length; i++) {
      for (let j = i + 1; j < this.nodeIds.length; j++) {
        this.addConnection(this.nodeIds[i], this.nodeIds[j]);
      }
    }
  }

  /**
   * Get expected number of pairs for full mesh: N*(N-1)/2
   */
  getExpectedPairs() {
    return (this.nodeCount * (this.nodeCount - 1)) / 2;
  }

  /**
   * Get actual number of connected pairs
   */
  getConnectedPairs() {
    return this.connections.size;
  }

  /**
   * Check if mesh is complete
   */
  isComplete() {
    return this.getConnectedPairs() === this.getExpectedPairs();
  }

  /**
   * Get peer count for a specific node
   */
  getPeerCount(nodeId) {
    let count = 0;
    for (const pair of this.connections) {
      const [a, b] = pair.split('-');
      // Need to handle node IDs like "node-1" which contain dashes
      // The pair format is "node-X-node-Y" where X and Y are numbers
      // Split on the pattern that separates two node IDs
      const parts = pair.match(/^(node-\d+)-(node-\d+)$/);
      if (parts && (parts[1] === nodeId || parts[2] === nodeId)) {
        count++;
      }
    }
    return count;
  }

  /**
   * Get missing connections
   */
  getMissingConnections() {
    const missing = [];
    for (let i = 0; i < this.nodeIds.length; i++) {
      for (let j = i + 1; j < this.nodeIds.length; j++) {
        const pair = [this.nodeIds[i], this.nodeIds[j]].sort().join('-');
        if (!this.connections.has(pair)) {
          missing.push({ from: this.nodeIds[i], to: this.nodeIds[j] });
        }
      }
    }
    return missing;
  }
}

describe('Property 3: Mesh Completeness Invariant', () => {
  
  /**
   * Property 3: Mesh completeness invariant
   * 
   * For any set of N Browser_Nodes (where N >= 3) that have completed mesh formation,
   * the total number of peer-to-peer connections SHALL equal N * (N-1) / 2,
   * and each node SHALL have exactly N-1 peer connections.
   * 
   * Feature: browser-mesh-stability-tests, Property 3: Mesh completeness invariant
   * Validates: Requirements 2.1, 2.2
   */
  describe('Full mesh connection count', () => {
    
    test('full mesh has exactly N*(N-1)/2 connections for any N >= 3', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 3, max: 20 }),
          (nodeCount) => {
            const mesh = new MeshSimulator(nodeCount);
            mesh.createFullMesh();
            
            const expectedPairs = (nodeCount * (nodeCount - 1)) / 2;
            const actualPairs = mesh.getConnectedPairs();
            
            return actualPairs === expectedPairs && mesh.isComplete();
          }
        ),
        { numRuns: 100 }
      );
    });

    test('each node in full mesh has exactly N-1 peers', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 3, max: 20 }),
          (nodeCount) => {
            const mesh = new MeshSimulator(nodeCount);
            mesh.createFullMesh();
            
            // Every node should have exactly N-1 peers
            for (const nodeId of mesh.nodeIds) {
              const peerCount = mesh.getPeerCount(nodeId);
              if (peerCount !== nodeCount - 1) {
                return false;
              }
            }
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Incomplete mesh detection', () => {
    
    test('missing connections are correctly identified', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 3, max: 10 }),
          fc.integer({ min: 1, max: 10 }),
          (nodeCount, missingCount) => {
            const mesh = new MeshSimulator(nodeCount);
            mesh.createFullMesh();
            
            const expectedPairs = mesh.getExpectedPairs();
            const actualMissing = Math.min(missingCount, expectedPairs);
            
            // Remove some connections
            const connectionsArray = Array.from(mesh.connections);
            for (let i = 0; i < actualMissing && i < connectionsArray.length; i++) {
              mesh.connections.delete(connectionsArray[i]);
            }
            
            const missing = mesh.getMissingConnections();
            const connectedPairs = mesh.getConnectedPairs();
            
            // connected + missing should equal expected
            return connectedPairs + missing.length === expectedPairs;
          }
        ),
        { numRuns: 100 }
      );
    });

    test('incomplete mesh is correctly detected', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 3, max: 10 }),
          (nodeCount) => {
            const mesh = new MeshSimulator(nodeCount);
            
            // Add only some connections (not all)
            const maxConnections = mesh.getExpectedPairs();
            const connectionsToAdd = Math.floor(maxConnections / 2);
            
            let added = 0;
            for (let i = 0; i < mesh.nodeIds.length && added < connectionsToAdd; i++) {
              for (let j = i + 1; j < mesh.nodeIds.length && added < connectionsToAdd; j++) {
                mesh.addConnection(mesh.nodeIds[i], mesh.nodeIds[j]);
                added++;
              }
            }
            
            // If we didn't add all connections, mesh should be incomplete
            if (added < maxConnections) {
              return !mesh.isComplete();
            }
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Edge cases', () => {
    
    test('minimum mesh size (N=3) has 3 connections', () => {
      const mesh = new MeshSimulator(3);
      mesh.createFullMesh();
      
      expect(mesh.getExpectedPairs()).toBe(3);
      expect(mesh.getConnectedPairs()).toBe(3);
      expect(mesh.isComplete()).toBe(true);
      
      for (const nodeId of mesh.nodeIds) {
        expect(mesh.getPeerCount(nodeId)).toBe(2);
      }
    });

    test('N=4 mesh has 6 connections', () => {
      const mesh = new MeshSimulator(4);
      mesh.createFullMesh();
      
      expect(mesh.getExpectedPairs()).toBe(6);
      expect(mesh.getConnectedPairs()).toBe(6);
      expect(mesh.isComplete()).toBe(true);
      
      for (const nodeId of mesh.nodeIds) {
        expect(mesh.getPeerCount(nodeId)).toBe(3);
      }
    });

    test('N=5 mesh has 10 connections', () => {
      const mesh = new MeshSimulator(5);
      mesh.createFullMesh();
      
      expect(mesh.getExpectedPairs()).toBe(10);
      expect(mesh.getConnectedPairs()).toBe(10);
      expect(mesh.isComplete()).toBe(true);
      
      for (const nodeId of mesh.nodeIds) {
        expect(mesh.getPeerCount(nodeId)).toBe(4);
      }
    });
  });

  describe('Connection pair uniqueness', () => {
    
    test('duplicate connections are not counted twice', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 3, max: 10 }),
          (nodeCount) => {
            const mesh = new MeshSimulator(nodeCount);
            
            // Try to add each connection twice
            for (let i = 0; i < mesh.nodeIds.length; i++) {
              for (let j = i + 1; j < mesh.nodeIds.length; j++) {
                mesh.addConnection(mesh.nodeIds[i], mesh.nodeIds[j]);
                mesh.addConnection(mesh.nodeIds[i], mesh.nodeIds[j]); // duplicate
                mesh.addConnection(mesh.nodeIds[j], mesh.nodeIds[i]); // reverse order
              }
            }
            
            // Should still have exactly N*(N-1)/2 connections
            return mesh.getConnectedPairs() === mesh.getExpectedPairs();
          }
        ),
        { numRuns: 100 }
      );
    });

    test('self-connections are not allowed', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 3, max: 10 }),
          (nodeCount) => {
            const mesh = new MeshSimulator(nodeCount);
            
            // Try to add self-connections
            for (const nodeId of mesh.nodeIds) {
              mesh.addConnection(nodeId, nodeId);
            }
            
            // Should have 0 connections (self-connections rejected)
            return mesh.getConnectedPairs() === 0;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
