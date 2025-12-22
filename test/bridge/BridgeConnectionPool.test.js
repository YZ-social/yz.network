import { BridgeConnectionPool, ConnectionState } from '../../src/bridge/BridgeConnectionPool.js';

describe('BridgeConnectionPool', () => {
  let pool;
  let mockBridgeNodes;
  let mockAuthToken;

  beforeEach(() => {
    mockBridgeNodes = ['wss://bridge1.example.com', 'wss://bridge2.example.com'];
    mockAuthToken = 'test-auth-token';
    
    pool = new BridgeConnectionPool(mockBridgeNodes, mockAuthToken, {
      idleTimeout: 1000, // 1 second for testing
      healthCheckInterval: 500, // 0.5 seconds for testing
      requestTimeout: 2000 // 2 seconds for testing
    });
  });

  afterEach(async () => {
    if (pool) {
      await pool.shutdown();
    }
  });

  describe('initialization', () => {
    test('should create connections for all bridge nodes', () => {
      expect(pool.connections.size).toBe(2);
      expect(pool.connections.has('wss://bridge1.example.com')).toBe(true);
      expect(pool.connections.has('wss://bridge2.example.com')).toBe(true);
    });

    test('should initialize with correct configuration', () => {
      expect(pool.bridgeNodes).toEqual(mockBridgeNodes);
      expect(pool.authToken).toBe(mockAuthToken);
      expect(pool.totalRequests).toBe(0);
      expect(pool.successfulRequests).toBe(0);
      expect(pool.failedRequests).toBe(0);
    });
  });

  describe('connection management', () => {
    test('should track connection states correctly', () => {
      const connection = pool.connections.get('wss://bridge1.example.com');
      expect(connection.state).toBe(ConnectionState.DISCONNECTED);
      expect(connection.bridgeAddr).toBe('wss://bridge1.example.com');
      expect(connection.authToken).toBe(mockAuthToken);
    });

    test('should handle single bridge node input', () => {
      const singlePool = new BridgeConnectionPool('wss://single.example.com', mockAuthToken);
      expect(singlePool.bridgeNodes).toEqual(['wss://single.example.com']);
      expect(singlePool.connections.size).toBe(1);
    });
  });

  describe('connection selection', () => {
    test('should throw error when no connections are ready', () => {
      expect(() => pool.getConnection()).toThrow('No bridge connections available');
    });

    test('should return ready connections in round-robin fashion', () => {
      // Mock connections as ready
      const conn1 = pool.connections.get('wss://bridge1.example.com');
      const conn2 = pool.connections.get('wss://bridge2.example.com');
      conn1.state = ConnectionState.READY;
      conn2.state = ConnectionState.READY;

      const firstConnection = pool.getConnection();
      const secondConnection = pool.getConnection();
      const thirdConnection = pool.getConnection();

      expect(firstConnection).toBe(conn1);
      expect(secondConnection).toBe(conn2);
      expect(thirdConnection).toBe(conn1); // Round-robin back to first
    });
  });

  describe('statistics', () => {
    test('should provide accurate statistics', () => {
      const stats = pool.getStats();
      
      expect(stats.totalBridges).toBe(2);
      expect(stats.readyConnections).toBe(0);
      expect(stats.requests.total).toBe(0);
      expect(stats.requests.successful).toBe(0);
      expect(stats.requests.failed).toBe(0);
      expect(stats.requests.successRate).toBe(0);
      expect(stats.connectionStats).toBeDefined();
    });

    test('should calculate success rate correctly', () => {
      pool.totalRequests = 10;
      pool.successfulRequests = 8;
      pool.failedRequests = 2;

      const stats = pool.getStats();
      expect(stats.requests.successRate).toBe(0.8);
    });
  });

  describe('shutdown', () => {
    test('should clear connections on shutdown', async () => {
      expect(pool.connections.size).toBe(2);
      
      await pool.shutdown();
      
      expect(pool.connections.size).toBe(0);
    });
  });
});