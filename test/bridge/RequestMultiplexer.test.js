import { RequestQueue, ResponseMatcher, RequestIdGenerator, RequestMultiplexer } from '../../src/bridge/RequestMultiplexer.js';

describe('RequestMultiplexer', () => {
  describe('RequestIdGenerator', () => {
    let generator;

    beforeEach(() => {
      generator = new RequestIdGenerator('test-node');
    });

    test('should generate unique request IDs', () => {
      const id1 = generator.generate();
      const id2 = generator.generate();
      
      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^req_test-nod_\d+_\d+_[a-z0-9]+$/);
    });

    test('should parse request ID components', () => {
      const id = generator.generate('test');
      const parsed = generator.parse(id);
      
      expect(parsed).toBeDefined();
      expect(parsed.prefix).toBe('test');
      expect(parsed.nodeId).toBe('test-nod');
      expect(parsed.counter).toBeGreaterThan(0);
    });

    test('should identify own requests', () => {
      const ownId = generator.generate();
      const foreignId = 'req_other-no_123_1_abc123';
      
      expect(generator.isOwnRequest(ownId)).toBe(true);
      expect(generator.isOwnRequest(foreignId)).toBe(false);
    });
  });

  describe('RequestQueue', () => {
    let queue;

    beforeEach(() => {
      queue = new RequestQueue({
        maxQueueSize: 5,
        maxConcurrent: 2
      });
    });

    test('should enqueue requests with priority', () => {
      const lowPriority = { requestId: 'req1', data: 'low' };
      const highPriority = { requestId: 'req2', data: 'high' };
      
      queue.enqueue(lowPriority, 1);
      queue.enqueue(highPriority, 5);
      
      const stats = queue.getStats();
      expect(stats.queueLength).toBe(2);
      expect(stats.queued).toBe(2);
      
      // High priority should be first
      const first = queue.dequeue();
      expect(first.data).toBe('high');
    });

    test('should respect max queue size', () => {
      // Fill queue to capacity
      for (let i = 0; i < 5; i++) {
        queue.enqueue({ requestId: `req${i}` });
      }
      
      // Should throw when exceeding capacity
      expect(() => {
        queue.enqueue({ requestId: 'req6' });
      }).toThrow('Request queue full');
    });

    test('should respect max concurrent processing', () => {
      // Add 3 requests
      queue.enqueue({ requestId: 'req1' });
      queue.enqueue({ requestId: 'req2' });
      queue.enqueue({ requestId: 'req3' });
      
      // Should be able to dequeue 2 (max concurrent)
      const first = queue.dequeue();
      const second = queue.dequeue();
      const third = queue.dequeue(); // Should be null
      
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(third).toBeNull();
      
      const stats = queue.getStats();
      expect(stats.processing).toBe(2);
      expect(stats.queueLength).toBe(1);
    });

    test('should complete requests and update statistics', () => {
      queue.enqueue({ requestId: 'req1' });
      const request = queue.dequeue();
      
      queue.complete('req1', { success: true });
      
      const stats = queue.getStats();
      expect(stats.processed).toBe(1);
      expect(stats.processing).toBe(0);
    });
  });

  describe('ResponseMatcher', () => {
    let matcher;

    beforeEach(() => {
      matcher = new ResponseMatcher({ defaultTimeout: 1000 });
      
      // Add error event listener to prevent unhandled error events during tests
      matcher.on('error', () => {
        // Errors are expected in tests, just prevent unhandled events
      });
    });

    afterEach(() => {
      // Clean up any pending timeouts
      matcher.cancelAll();
    });

    test('should register and match responses', async () => {
      const promise = new Promise((resolve, reject) => {
        matcher.registerRequest('req1', resolve, reject);
      });

      // Simulate response
      const handled = matcher.handleResponse({
        requestId: 'req1',
        type: 'onboarding_peer_response',
        success: true,
        data: { result: 'success' }
      });

      expect(handled).toBe(true);
      const result = await promise;
      expect(result).toEqual({ result: 'success' });
    });

    test('should handle error responses', async () => {
      const promise = new Promise((resolve, reject) => {
        matcher.registerRequest('req1', resolve, reject);
      });

      matcher.handleResponse({
        requestId: 'req1',
        type: 'onboarding_peer_response',
        success: false,
        error: 'Test error'
      });

      await expect(promise).rejects.toThrow('Test error');
    });

    test('should timeout unmatched requests', (done) => {
      const promise = new Promise((resolve, reject) => {
        matcher.registerRequest('req1', resolve, reject, 100); // 100ms timeout
      });

      promise.catch((error) => {
        expect(error.message).toMatch(/Request timeout/);
        done();
      });
    });

    test('should handle unmatched responses', () => {
      let unmatchedMessage = null;
      matcher.on('unmatched', (message) => {
        unmatchedMessage = message;
      });

      const handled = matcher.handleResponse({
        requestId: 'unknown',
        type: 'onboarding_peer_response',
        data: 'test'
      });

      expect(handled).toBe(false);
      expect(unmatchedMessage).toBeDefined();
    });
  });

  describe('RequestMultiplexer Integration', () => {
    let multiplexer;

    beforeEach(() => {
      multiplexer = new RequestMultiplexer({
        nodeId: 'test-bootstrap',
        defaultTimeout: 1000,
        queue: {
          maxQueueSize: 10,
          maxConcurrent: 3
        }
      });
    });

    afterEach(() => {
      if (multiplexer) {
        multiplexer.shutdown();
      }
    });

    test('should create and process requests', async () => {
      // Create a request (this will queue it and return a promise)
      const requestPromise = multiplexer.createRequest({
        type: 'get_onboarding_peer',
        newNodeId: 'test-node',
        newNodeMetadata: { nodeType: 'test' }
      });

      // Process the request from queue
      const queuedRequest = multiplexer.processNext();
      expect(queuedRequest).toBeDefined();
      expect(queuedRequest.type).toBe('get_onboarding_peer');
      expect(queuedRequest.requestId).toBeDefined();

      // Simulate response
      const handled = multiplexer.handleResponse({
        requestId: queuedRequest.requestId,
        type: 'onboarding_peer_response',
        success: true,
        data: { inviterPeerId: 'helper-node' }
      });

      expect(handled).toBe(true);
      const result = await requestPromise;
      expect(result).toEqual({ inviterPeerId: 'helper-node' });
    });

    test('should provide comprehensive statistics', () => {
      multiplexer.createRequest({ type: 'test' });
      
      const stats = multiplexer.getStats();
      expect(stats.queue).toBeDefined();
      expect(stats.responses).toBeDefined();
      expect(stats.nodeId).toBe('test-bootstrap');
      expect(stats.queue.queueLength).toBe(1);
    });

    test('should handle multiple concurrent requests', async () => {
      // Create multiple requests
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(multiplexer.createRequest({
          type: 'get_onboarding_peer',
          newNodeId: `node-${i}`
        }));
      }

      // Process and respond to each
      for (let i = 0; i < 5; i++) {
        const request = multiplexer.processNext();
        if (request) {
          multiplexer.handleResponse({
            requestId: request.requestId,
            type: 'onboarding_peer_response',
            success: true,
            data: { result: `response-${i}` }
          });
        }
      }

      const results = await Promise.all(promises);
      expect(results).toHaveLength(5);
      results.forEach((result, i) => {
        expect(result).toEqual({ result: `response-${i}` });
      });
    });
  });
});