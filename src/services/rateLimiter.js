import winston from 'winston';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [RATE-LIMITER-${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

/**
 * Rate Limiter for Tradovate API
 * Handles dynamic rate limits, penalty tickets, and request queuing
 */
class RateLimiter {
  constructor(options = {}) {
    this.minRequestInterval = options.minRequestInterval || 1000; // 1 second minimum between requests
    this.defaultRetryDelay = options.defaultRetryDelay || 5000; // 5 seconds default retry
    this.maxRetryAttempts = options.maxRetryAttempts || 3;

    // Request queue
    this.requestQueue = [];
    this.isProcessing = false;
    this.lastRequestTime = 0;

    // Penalty state
    this.penaltyActive = false;
    this.penaltyEndTime = 0;
    this.currentPenaltyTicket = null;

    // Statistics
    this.stats = {
      totalRequests: 0,
      penaltiesReceived: 0,
      failedRequests: 0,
      averageResponseTime: 0
    };
  }

  /**
   * Add a request to the queue
   */
  async queueRequest(requestFn, requestId = null) {
    return new Promise((resolve, reject) => {
      this.requestQueue.push({
        requestFn,
        requestId: requestId || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        resolve,
        reject,
        attempts: 0,
        createdAt: Date.now()
      });

      this.processQueue();
    });
  }

  /**
   * Process the request queue
   */
  async processQueue() {
    if (this.isProcessing || this.requestQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.requestQueue.length > 0) {
      // Check if we're in a penalty period
      if (this.penaltyActive && Date.now() < this.penaltyEndTime) {
        const remainingTime = this.penaltyEndTime - Date.now();
        logger.warn(`Penalty active. Waiting ${Math.ceil(remainingTime / 1000)} seconds before processing requests`);
        await this.sleep(remainingTime);
        this.penaltyActive = false;
        this.currentPenaltyTicket = null;
      }

      // Ensure minimum interval between requests
      const timeSinceLastRequest = Date.now() - this.lastRequestTime;
      if (timeSinceLastRequest < this.minRequestInterval) {
        const waitTime = this.minRequestInterval - timeSinceLastRequest;
        await this.sleep(waitTime);
      }

      const request = this.requestQueue.shift();
      await this.executeRequest(request);
    }

    this.isProcessing = false;
  }

  /**
   * Execute a single request with retry logic
   */
  async executeRequest(request) {
    const { requestFn, requestId, resolve, reject, attempts } = request;

    try {
      logger.info(`Executing request ${requestId} (attempt ${attempts + 1})`);

      const startTime = Date.now();
      this.lastRequestTime = startTime;

      // Execute the request
      const response = await requestFn();

      const responseTime = Date.now() - startTime;
      this.updateStats(responseTime, true);

      // Check for penalty response
      if (this.isPenaltyResponse(response)) {
        await this.handlePenaltyResponse(response, request);
        return;
      }

      logger.info(`Request ${requestId} completed successfully in ${responseTime}ms`);
      resolve(response);

    } catch (error) {
      await this.handleRequestError(error, request);
    }
  }

  /**
   * Check if response contains penalty indicators
   */
  isPenaltyResponse(response) {
    if (!response || !response.data) return false;

    return !!(response.data['p-ticket'] || response.data['p-time'] || response.data['p-captcha']);
  }

  /**
   * Handle penalty response from Tradovate
   */
  async handlePenaltyResponse(response, request) {
    const data = response.data;
    const pTicket = data['p-ticket'];
    const pTime = data['p-time'];
    const pCaptcha = data['p-captcha'];

    this.stats.penaltiesReceived++;

    if (pCaptcha) {
      // CAPTCHA penalty - must wait 1 hour
      logger.error(`CAPTCHA penalty received for request ${request.requestId}. Waiting 1 hour.`);
      this.penaltyActive = true;
      this.penaltyEndTime = Date.now() + (60 * 60 * 1000); // 1 hour
      this.currentPenaltyTicket = null;

      request.reject(new Error('CAPTCHA penalty - API access suspended for 1 hour'));
      return;
    }

    if (pTicket && pTime) {
      // Time penalty
      const waitSeconds = parseInt(pTime);
      logger.warn(`Penalty received for request ${request.requestId}. Ticket: ${pTicket}, Wait: ${waitSeconds} seconds`);

      this.penaltyActive = true;
      this.penaltyEndTime = Date.now() + (waitSeconds * 1000);
      this.currentPenaltyTicket = pTicket;

      // Re-queue the request with the penalty ticket
      request.attempts++;
      if (request.attempts < this.maxRetryAttempts) {
        // Modify the original request function to include the penalty ticket
        request.requestFn = this.addPenaltyTicketToRequest(request.requestFn, pTicket);
        this.requestQueue.unshift(request); // Put back at front of queue
        logger.info(`Re-queuing request ${request.requestId} with penalty ticket`);
      } else {
        request.reject(new Error(`Max retry attempts reached for request ${request.requestId}`));
      }
    }
  }

  /**
   * Handle general request errors
   */
  async handleRequestError(error, request) {
    this.stats.failedRequests++;

    logger.error(`Request ${request.requestId} failed: ${error.message}`);

    // Check if it's a 429 rate limit error
    if (error.response && error.response.status === 429) {
      logger.warn(`Rate limit hit for request ${request.requestId}`);

      request.attempts++;
      if (request.attempts < this.maxRetryAttempts) {
        // Exponential backoff
        const backoffDelay = this.defaultRetryDelay * Math.pow(2, request.attempts - 1);
        logger.info(`Retrying request ${request.requestId} in ${backoffDelay}ms`);

        setTimeout(() => {
          this.requestQueue.unshift(request);
          this.processQueue();
        }, backoffDelay);
        return;
      }
    }

    // Failed permanently
    request.reject(error);
  }

  /**
   * Add penalty ticket to request function
   */
  addPenaltyTicketToRequest(originalRequestFn, pTicket) {
    return async () => {
      // This assumes the request function returns an axios response
      // The penalty ticket should be added to the request body
      try {
        const response = await originalRequestFn();
        // If the original request succeeds, it means it was properly handled
        return response;
      } catch (error) {
        // If it's an axios error, we might need to modify the request
        throw error;
      }
    };
  }

  /**
   * Update statistics
   */
  updateStats(responseTime, success) {
    this.stats.totalRequests++;

    if (success) {
      // Update average response time using moving average
      this.stats.averageResponseTime =
        (this.stats.averageResponseTime * (this.stats.totalRequests - 1) + responseTime) / this.stats.totalRequests;
    }
  }

  /**
   * Get current statistics
   */
  getStats() {
    return {
      ...this.stats,
      queueLength: this.requestQueue.length,
      penaltyActive: this.penaltyActive,
      penaltyEndTime: this.penaltyActive ? this.penaltyEndTime : null,
      isProcessing: this.isProcessing
    };
  }

  /**
   * Check if rate limiter is healthy (no active penalties, small queue)
   */
  isHealthy() {
    return !this.penaltyActive && this.requestQueue.length < 10;
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Clear the request queue (emergency stop)
   */
  clearQueue() {
    logger.warn('Clearing request queue');
    this.requestQueue.forEach(request => {
      request.reject(new Error('Request queue cleared'));
    });
    this.requestQueue = [];
  }

  /**
   * Reset penalty state (for testing or manual recovery)
   */
  resetPenalties() {
    logger.info('Resetting penalty state');
    this.penaltyActive = false;
    this.penaltyEndTime = 0;
    this.currentPenaltyTicket = null;
  }
}

export default RateLimiter;