import { EventEmitter } from 'events';

/**
 * Request Queue Manager
 * Handles queuing and processing of multiple concurrent requests
 */
export class RequestQueue extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.maxQueueSize = options.maxQueueSize || 100;
    this.maxConcurrent = options.maxConcurrent || 10;
    this.requestTimeout = options.requestTimeout || 10000;
    
    // Queue management
    this.queue = [];
    this.processing = new Map(); // requestId -> request info
    this.completed = new Map(); // requestId -> result (for deduplication)
    
    // Statistics
    this.stats = {
      queued: 0,
      processed: 0,
      failed: 0,
      timeouts: 0,
      duplicates: 0
    };
  }

  /**
   * Add request to queue
   */
  enqueue(request, priority = 0) {
    if (this.queue.length >= this.maxQueueSize) {
      throw new Error('Request queue full');
    }

    const queueItem = {
      ...request,
      priority,
      queuedAt: Date.now(),
      attempts: 0
    };

    // Insert based on priority (higher priority first)
    let insertIndex = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i].priority < priority) {
        insertIndex = i;
        break;
      }
    }

    this.queue.splice(insertIndex, 0, queueItem);
    this.stats.queued++;
    
    this.emit('queued', queueItem);
    return queueItem.requestId;
  }

  /**
   * Get next request from queue
   */
  dequeue() {
    if (this.queue.length === 0 || this.processing.size >= this.maxConcurrent) {
      return null;
    }

    const request = this.queue.shift();
    this.processing.set(request.requestId, {
      ...request,
      startedAt: Date.now()
    });

    return request;
  }

  /**
   * Mark request as completed
   */
  complete(requestId, result, error = null) {
    const request = this.processing.get(requestId);
    if (!request) {
      return false;
    }

    this.processing.delete(requestId);
    
    if (error) {
      this.stats.failed++;
      this.emit('failed', { requestId, error, request });
    } else {
      this.stats.processed++;
      this.completed.set(requestId, { result, completedAt: Date.now() });
      this.emit('completed', { requestId, result, request });
    }

    // Clean up old completed requests (keep for 5 minutes for deduplication)
    this.cleanupCompleted();
    
    return true;
  }

  /**
   * Mark request as timed out
   */
  timeout(requestId) {
    const request = this.processing.get(requestId);
    if (request) {
      this.processing.delete(requestId);
      this.stats.timeouts++;
      this.emit('timeout', { requestId, request });
    }
  }

  /**
   * Check if request was recently completed (deduplication)
   */
  isRecentlyCompleted(requestId) {
    return this.completed.has(requestId);
  }

  /**
   * Get recently completed result
   */
  getCompletedResult(requestId) {
    const completed = this.completed.get(requestId);
    if (completed) {
      this.stats.duplicates++;
      return completed.result;
    }
    return null;
  }

  /**
   * Clean up old completed requests
   */
  cleanupCompleted() {
    const fiveMinutesAgo = Date.now() - 300000;
    for (const [requestId, completed] of this.completed) {
      if (completed.completedAt < fiveMinutesAgo) {
        this.completed.delete(requestId);
      }
    }
  }

  /**
   * Get queue statistics
   */
  getStats() {
    return {
      ...this.stats,
      queueLength: this.queue.length,
      processing: this.processing.size,
      completed: this.completed.size,
      maxConcurrent: this.maxConcurrent,
      maxQueueSize: this.maxQueueSize
    };
  }

  /**
   * Clear all queues
   */
  clear() {
    this.queue = [];
    this.processing.clear();
    this.completed.clear();
  }
}

/**
 * Response Matcher
 * Correlates responses with pending requests using request IDs
 */
export class ResponseMatcher extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.defaultTimeout = options.defaultTimeout || 10000;
    this.pendingRequests = new Map(); // requestId -> { resolve, reject, timeout, metadata, state }
  }

  /**
   * Register a pending request
   */
  registerRequest(requestId, resolve, reject, timeout = this.defaultTimeout, metadata = {}) {
    // Clear any existing timeout
    if (this.pendingRequests.has(requestId)) {
      const existing = this.pendingRequests.get(requestId);
      clearTimeout(existing.timeout);
    }

    // Set up new timeout
    const timeoutHandle = setTimeout(() => {
      const request = this.pendingRequests.get(requestId);
      if (request && request.state === 'pending') {
        request.state = 'timeout';
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request timeout: ${requestId}`));
        this.emit('timeout', { requestId, metadata });
      }
    }, timeout);

    this.pendingRequests.set(requestId, {
      resolve,
      reject,
      timeout: timeoutHandle,
      metadata,
      registeredAt: Date.now(),
      state: 'pending'
    });

    this.emit('registered', { requestId, metadata });
  }

  /**
   * Handle incoming response
   */
  handleResponse(message) {
    const { requestId } = message;
    
    if (!requestId || !this.pendingRequests.has(requestId)) {
      this.emit('unmatched', message);
      return false;
    }

    const request = this.pendingRequests.get(requestId);
    if (request.state !== 'pending') {
      // Request already resolved/rejected
      return false;
    }

    const { resolve, reject, timeout, metadata } = request;
    clearTimeout(timeout);
    this.pendingRequests.delete(requestId);

    if (message.type === 'onboarding_peer_response') {
      if (message.success) {
        request.state = 'resolved';
        resolve(message.data);
        this.emit('success', { requestId, data: message.data, metadata });
      } else {
        request.state = 'rejected';
        reject(new Error(message.error || 'Request failed'));
        this.emit('error', { requestId, error: message.error, metadata });
      }
    } else if (message.type === 'error') {
      request.state = 'rejected';
      reject(new Error(message.message || 'Request failed'));
      this.emit('error', { requestId, error: message.message, metadata });
    } else {
      // Unknown response type, resolve with raw message
      request.state = 'resolved';
      resolve(message);
      this.emit('success', { requestId, data: message, metadata });
    }

    return true;
  }

  /**
   * Cancel a pending request
   */
  cancelRequest(requestId) {
    const pending = this.pendingRequests.get(requestId);
    if (pending && pending.state === 'pending') {
      clearTimeout(pending.timeout);
      pending.state = 'cancelled';
      this.pendingRequests.delete(requestId);
      pending.reject(new Error('Request cancelled'));
      this.emit('cancelled', { requestId, metadata: pending.metadata });
      return true;
    }
    return false;
  }

  /**
   * Cancel all pending requests
   */
  cancelAll(reason = 'Connection lost') {
    const pendingCount = this.pendingRequests.size;
    
    // Just clear timeouts and emit events, don't reject promises during shutdown
    for (const [requestId, request] of this.pendingRequests) {
      if (request.state === 'pending') {
        clearTimeout(request.timeout);
        request.state = 'cancelled';
        this.emit('cancelled', { requestId, metadata: request.metadata, reason });
      }
    }
    
    // Clear all requests
    this.pendingRequests.clear();
    
    if (pendingCount > 0) {
      console.log(`🚫 Cancelled ${pendingCount} pending requests: ${reason}`);
    }
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      pendingRequests: this.pendingRequests.size,
      oldestRequest: this.getOldestRequestAge()
    };
  }

  /**
   * Get age of oldest pending request
   */
  getOldestRequestAge() {
    let oldest = 0;
    const now = Date.now();
    
    for (const { registeredAt } of this.pendingRequests.values()) {
      const age = now - registeredAt;
      if (age > oldest) {
        oldest = age;
      }
    }
    
    return oldest;
  }
}

/**
 * Request ID Generator
 * Generates unique, collision-resistant request IDs
 */
export class RequestIdGenerator {
  constructor(nodeId = 'unknown') {
    this.nodeId = nodeId.substring(0, 8); // Use first 8 chars of node ID
    this.counter = 0;
    this.startTime = Date.now();
  }

  /**
   * Generate unique request ID
   */
  generate(prefix = 'req') {
    this.counter++;
    const timestamp = Date.now() - this.startTime; // Relative timestamp for shorter IDs
    const random = Math.random().toString(36).substr(2, 6);
    
    return `${prefix}_${this.nodeId}_${timestamp}_${this.counter}_${random}`;
  }

  /**
   * Parse request ID components
   */
  parse(requestId) {
    const parts = requestId.split('_');
    if (parts.length >= 5) {
      return {
        prefix: parts[0],
        nodeId: parts[1],
        timestamp: parseInt(parts[2]) + this.startTime,
        counter: parseInt(parts[3]),
        random: parts[4]
      };
    }
    return null;
  }

  /**
   * Check if request ID was generated by this generator
   */
  isOwnRequest(requestId) {
    const parsed = this.parse(requestId);
    return parsed && parsed.nodeId === this.nodeId;
  }
}

/**
 * Enhanced Request Multiplexer
 * Combines queue management, response matching, and request ID generation
 */
export class RequestMultiplexer extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = options;
    this.nodeId = options.nodeId || 'bootstrap';
    
    // Components
    this.queue = new RequestQueue(options.queue);
    this.responseMatcher = new ResponseMatcher(options.response);
    this.idGenerator = new RequestIdGenerator(this.nodeId);
    
    // Set up event forwarding
    this.setupEventForwarding();
  }

  /**
   * Set up event forwarding from components
   */
  setupEventForwarding() {
    // Forward queue events
    this.queue.on('queued', (data) => this.emit('queued', data));
    this.queue.on('completed', (data) => this.emit('completed', data));
    this.queue.on('failed', (data) => this.emit('failed', data));
    this.queue.on('timeout', (data) => this.emit('queueTimeout', data));

    // Forward response matcher events
    this.responseMatcher.on('success', (data) => this.emit('success', data));
    this.responseMatcher.on('error', (data) => this.emit('error', data));
    this.responseMatcher.on('timeout', (data) => this.emit('responseTimeout', data));
    this.responseMatcher.on('unmatched', (data) => this.emit('unmatched', data));
  }

  /**
   * Create and queue a request
   */
  async createRequest(requestData, options = {}) {
    const requestId = this.idGenerator.generate(options.prefix);
    const priority = options.priority || 0;
    const timeout = options.timeout || this.options.defaultTimeout || 10000;

    // Check for recent duplicate
    if (this.queue.isRecentlyCompleted(requestId)) {
      return this.queue.getCompletedResult(requestId);
    }

    const request = {
      requestId,
      ...requestData,
      createdAt: Date.now()
    };

    // Queue the request
    this.queue.enqueue(request, priority);

    // Return promise that resolves when response is received
    return new Promise((resolve, reject) => {
      this.responseMatcher.registerRequest(
        requestId,
        resolve,
        reject,
        timeout,
        { request, options }
      );
    });
  }

  /**
   * Process next request from queue
   */
  processNext() {
    return this.queue.dequeue();
  }

  /**
   * Handle incoming response message
   */
  handleResponse(message) {
    const handled = this.responseMatcher.handleResponse(message);
    
    if (handled && message.requestId) {
      // Mark as completed in queue
      this.queue.complete(message.requestId, message.data || message, message.error);
    }
    
    return handled;
  }

  /**
   * Get comprehensive statistics
   */
  getStats() {
    return {
      queue: this.queue.getStats(),
      responses: this.responseMatcher.getStats(),
      nodeId: this.nodeId
    };
  }

  /**
   * Shutdown and cleanup
   */
  shutdown() {
    this.responseMatcher.cancelAll('Multiplexer shutdown');
    this.queue.clear();
  }
}