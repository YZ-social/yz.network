/**
 * ChannelJoinManager - Enhanced channel join experience and reliability
 *
 * Implements task 1.6 requirements:
 * - 5-second timeout for channel join operations with progress feedback
 * - Automatic retry with exponential backoff for failed joins
 * - Clear error messages and remediation suggestions for join failures
 * - Concurrent join handling to ensure multiple users can join simultaneously
 *
 * Features:
 * - Progress feedback during join operations
 * - Exponential backoff retry strategy
 * - Detailed error reporting with remediation suggestions
 * - Concurrent join coordination
 * - Connection health validation
 */

export class ChannelJoinManager {
  /**
   * Default timeout for channel join operations (5 seconds)
   */
  static DEFAULT_JOIN_TIMEOUT = 5000;

  /**
   * Maximum retry attempts for failed joins
   */
  static MAX_RETRY_ATTEMPTS = 3;

  /**
   * Base delay for exponential backoff (milliseconds)
   */
  static BASE_RETRY_DELAY = 500;

  /**
   * Create new ChannelJoinManager
   * @param {PubSubClient} pubsubClient - PubSub client instance
   * @param {KademliaDHT} dht - DHT instance for connection health checks
   */
  constructor(pubsubClient, dht) {
    if (!pubsubClient) throw new Error('ChannelJoinManager requires PubSubClient instance');
    if (!dht) throw new Error('ChannelJoinManager requires DHT instance');

    this.pubsubClient = pubsubClient;
    this.dht = dht;

    // Track ongoing join operations to handle concurrency
    this.ongoingJoins = new Map(); // channelId -> Promise

    // Statistics
    this.stats = {
      totalJoins: 0,
      successfulJoins: 0,
      failedJoins: 0,
      retriedJoins: 0,
      timeoutJoins: 0,
      concurrentJoins: 0
    };
  }

  /**
   * Enhanced channel join with timeout, retry, and progress feedback
   * @param {string} channelId - Channel ID to join
   * @param {Object} options - Join options
   * @param {number} [options.timeout] - Join timeout in milliseconds
   * @param {number} [options.maxRetries] - Maximum retry attempts
   * @param {Function} [options.onProgress] - Progress callback: (stage, details) => void
   * @param {Object} [options.subscribeOptions] - Options to pass to subscribe()
   * @returns {Promise<{success: boolean, coordinatorNode: number, historicalMessages: number, attempts: number, duration: number}>}
   */
  async joinChannel(channelId, options = {}) {
    const {
      timeout = ChannelJoinManager.DEFAULT_JOIN_TIMEOUT,
      maxRetries = ChannelJoinManager.MAX_RETRY_ATTEMPTS,
      onProgress = () => {},
      subscribeOptions = {}
    } = options;

    const startTime = Date.now();
    this.stats.totalJoins++;

    // Check for concurrent join to same channel
    if (this.ongoingJoins.has(channelId)) {
      this.stats.concurrentJoins++;
      onProgress('concurrent', { message: 'Waiting for ongoing join to complete...' });
      
      try {
        // Wait for the ongoing join to complete
        const result = await this.ongoingJoins.get(channelId);
        onProgress('completed', { message: 'Joined via concurrent operation', concurrent: true });
        return {
          success: true,
          ...result,
          concurrent: true,
          duration: Date.now() - startTime
        };
      } catch (error) {
        // If concurrent join failed, we'll try our own join
        onProgress('concurrent_failed', { message: 'Concurrent join failed, starting new attempt...' });
      }
    }

    // Create join promise and track it
    const joinPromise = this._performJoinWithRetry(channelId, {
      timeout,
      maxRetries,
      onProgress,
      subscribeOptions,
      startTime
    });

    this.ongoingJoins.set(channelId, joinPromise);

    try {
      const result = await joinPromise;
      this.stats.successfulJoins++;
      return result;
    } catch (error) {
      this.stats.failedJoins++;
      throw error;
    } finally {
      // Clean up ongoing join tracking
      this.ongoingJoins.delete(channelId);
    }
  }

  /**
   * Perform channel join with retry logic
   * @private
   */
  async _performJoinWithRetry(channelId, options) {
    const { timeout, maxRetries, onProgress, subscribeOptions, startTime } = options;
    let lastError = null;
    let attempt = 0;

    while (attempt <= maxRetries) {
      try {
        onProgress('attempting', {
          attempt: attempt + 1,
          maxAttempts: maxRetries + 1,
          message: attempt === 0 ? 'Starting channel join...' : `Retry attempt ${attempt}...`
        });

        // Validate connection health before attempting join
        await this._validateConnectionHealth(onProgress);

        // Perform the actual join with timeout
        const result = await this._joinWithTimeout(channelId, timeout, onProgress, subscribeOptions);

        // Success!
        const duration = Date.now() - startTime;
        onProgress('completed', {
          message: 'Successfully joined channel',
          attempts: attempt + 1,
          duration
        });

        if (attempt > 0) {
          this.stats.retriedJoins++;
        }

        return {
          success: true,
          ...result,
          attempts: attempt + 1,
          duration
        };

      } catch (error) {
        lastError = error;
        attempt++;

        // Check if we should retry
        if (attempt <= maxRetries && this._shouldRetry(error)) {
          const delay = this._calculateRetryDelay(attempt);
          
          onProgress('retrying', {
            attempt,
            maxAttempts: maxRetries + 1,
            error: error.message,
            retryDelay: delay,
            message: `Join failed: ${error.message}. Retrying in ${delay}ms...`
          });

          await this._delay(delay);
          continue;
        }

        // Max retries reached or non-retryable error
        break;
      }
    }

    // All attempts failed
    const duration = Date.now() - startTime;
    const enhancedError = this._enhanceError(lastError, channelId, attempt, duration);
    
    onProgress('failed', {
      error: enhancedError.message,
      attempts: attempt,
      duration,
      remediation: enhancedError.remediation
    });

    throw enhancedError;
  }

  /**
   * Perform channel join with timeout
   * @private
   */
  async _joinWithTimeout(channelId, timeout, onProgress, subscribeOptions) {
    onProgress('connecting', { message: 'Connecting to channel...' });

    // Create timeout promise
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        this.stats.timeoutJoins++;
        reject(new Error(`Channel join timeout after ${timeout}ms`));
      }, timeout);
    });

    // Create join promise
    const joinPromise = this.pubsubClient.subscribe(channelId, subscribeOptions);

    // Race between join and timeout
    const result = await Promise.race([joinPromise, timeoutPromise]);

    onProgress('validating', { message: 'Validating channel connection...' });

    // Additional validation: ensure we can actually communicate with the channel
    await this._validateChannelConnection(channelId, onProgress);

    return result;
  }

  /**
   * Validate connection health before attempting join
   * @private
   */
  async _validateConnectionHealth(onProgress) {
    onProgress('health_check', { message: 'Checking connection health...' });

    // Check if DHT is started
    if (!this.dht || !this.dht.isStarted) {
      throw new Error('DHT not started - cannot join channel');
    }

    // Check connected peers
    const connectedPeers = this.dht.getConnectedPeers?.() || [];
    if (connectedPeers.length === 0) {
      throw new Error('No connected peers - network isolation detected');
    }

    // Check routing table health
    const routingTableSize = this.dht.routingTable?.getAllNodes()?.length || 0;
    if (routingTableSize < 3) {
      console.warn(`⚠️ Low routing table size: ${routingTableSize} nodes`);
    }

    onProgress('health_check_passed', {
      message: `Connection healthy: ${connectedPeers.length} peers, ${routingTableSize} routing entries`
    });
  }

  /**
   * Validate channel connection after join
   * @private
   */
  async _validateChannelConnection(channelId, onProgress) {
    try {
      // Check if we're actually subscribed
      if (!this.pubsubClient.isSubscribed(channelId)) {
        throw new Error('Subscription not confirmed');
      }

      // Try to get topic info to verify coordinator access
      const topicInfo = await this.pubsubClient.getTopicInfo(channelId);
      if (!topicInfo) {
        console.warn(`⚠️ Could not retrieve topic info for ${channelId.substring(0, 8)}...`);
      }

      onProgress('validation_passed', {
        message: 'Channel connection validated',
        topicInfo: topicInfo ? {
          version: topicInfo.version,
          subscribers: topicInfo.subscribers,
          messages: topicInfo.messages
        } : null
      });

    } catch (error) {
      throw new Error(`Channel validation failed: ${error.message}`);
    }
  }

  /**
   * Determine if an error should trigger a retry
   * @private
   */
  _shouldRetry(error) {
    const retryableErrors = [
      'timeout',
      'connection failed',
      'no connection to peer',
      'network error',
      'dht not started',
      'coordinator not found',
      'failed to load',
      'version conflict'
    ];

    const errorMessage = error.message.toLowerCase();
    return retryableErrors.some(retryable => errorMessage.includes(retryable));
  }

  /**
   * Calculate exponential backoff delay with jitter
   * @private
   */
  _calculateRetryDelay(attempt) {
    const baseDelay = ChannelJoinManager.BASE_RETRY_DELAY;
    const exponentialDelay = baseDelay * Math.pow(2, attempt - 1);
    
    // Add jitter (±25%) to prevent thundering herd
    const jitter = exponentialDelay * 0.25 * (Math.random() - 0.5);
    
    return Math.floor(exponentialDelay + jitter);
  }

  /**
   * Enhance error with detailed information and remediation suggestions
   * @private
   */
  _enhanceError(originalError, channelId, attempts, duration) {
    const error = new Error(originalError.message);
    error.originalError = originalError;
    error.channelId = channelId;
    error.attempts = attempts;
    error.duration = duration;

    // Determine error category and provide remediation
    const errorMessage = originalError.message.toLowerCase();

    if (errorMessage.includes('timeout')) {
      error.category = 'timeout';
      error.remediation = [
        'Check network connectivity',
        'Verify DHT bootstrap servers are reachable',
        'Try joining a different channel to test connectivity',
        'Wait a moment and try again - network may be congested'
      ];
    } else if (errorMessage.includes('no connected peers') || errorMessage.includes('network isolation')) {
      error.category = 'network_isolation';
      error.remediation = [
        'Check internet connection',
        'Verify firewall settings allow WebRTC connections',
        'Try refreshing the page to reconnect to bootstrap servers',
        'Check if other network applications are working'
      ];
    } else if (errorMessage.includes('dht not started')) {
      error.category = 'dht_not_ready';
      error.remediation = [
        'Wait for DHT to fully initialize',
        'Check DHT connection status',
        'Try refreshing the page if DHT seems stuck',
        'Verify bootstrap server configuration'
      ];
    } else if (errorMessage.includes('coordinator') || errorMessage.includes('version conflict')) {
      error.category = 'coordination_failure';
      error.remediation = [
        'Channel may be experiencing high activity - try again',
        'Check if channel ID is correct',
        'Try creating a new channel if this persists',
        'Wait a moment for network coordination to stabilize'
      ];
    } else {
      error.category = 'unknown';
      error.remediation = [
        'Check network connectivity',
        'Try refreshing the page',
        'Verify channel ID is correct',
        'Contact support if problem persists'
      ];
    }

    return error;
  }

  /**
   * Delay utility for retry backoff
   * @private
   */
  async _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Check if a channel join is currently in progress
   * @param {string} channelId - Channel ID to check
   * @returns {boolean} - True if join is in progress
   */
  isJoinInProgress(channelId) {
    return this.ongoingJoins.has(channelId);
  }

  /**
   * Get list of channels currently being joined
   * @returns {Array<string>} - Array of channel IDs
   */
  getOngoingJoins() {
    return Array.from(this.ongoingJoins.keys());
  }

  /**
   * Get join statistics
   * @returns {Object} - Join statistics
   */
  getStats() {
    const total = this.stats.totalJoins;
    return {
      ...this.stats,
      successRate: total > 0 ? ((this.stats.successfulJoins / total) * 100).toFixed(1) + '%' : 'N/A',
      retryRate: total > 0 ? ((this.stats.retriedJoins / total) * 100).toFixed(1) + '%' : 'N/A',
      timeoutRate: total > 0 ? ((this.stats.timeoutJoins / total) * 100).toFixed(1) + '%' : 'N/A'
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      totalJoins: 0,
      successfulJoins: 0,
      failedJoins: 0,
      retriedJoins: 0,
      timeoutJoins: 0,
      concurrentJoins: 0
    };
  }
}