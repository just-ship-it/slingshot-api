import TradovateClient from './tradovateClient.js';
import DataCache from './dataCache.js';
import winston from 'winston';
import { EventEmitter } from 'events';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [DATA-COLLECTOR-${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

/**
 * Background data collector with adaptive polling
 */
class TradovateDataCollector extends EventEmitter {
  constructor() {
    super();

    this.tradovateClient = null;
    this.dataCache = null;
    this.isRunning = false;
    this.accounts = [];

    // Polling intervals by mode (in milliseconds)
    this.pollingIntervals = {
      IDLE: {
        balance: 5 * 60 * 1000,     // 5 minutes
        positions: 2 * 60 * 1000,   // 2 minutes
        orders: 2 * 60 * 1000       // 2 minutes
      },
      ACTIVE: {
        balance: 60 * 1000,         // 1 minute
        positions: 15 * 1000,       // 15 seconds
        orders: 10 * 1000           // 10 seconds
      },
      CRITICAL: {
        balance: 30 * 1000,         // 30 seconds
        positions: 5 * 1000,        // 5 seconds
        orders: 5 * 1000            // 5 seconds
      }
    };

    // Polling timers for each account and data type
    this.timers = new Map(); // accountId -> { balance, positions, orders }

    // Performance tracking
    this.stats = {
      totalPolls: 0,
      successfulPolls: 0,
      errors: 0,
      lastPollTime: null,
      averageResponseTime: 0
    };
  }

  /**
   * Initialize the data collector
   */
  async initialize() {
    try {
      logger.info('Initializing Tradovate Data Collector...');

      // Initialize TradovateClient
      this.tradovateClient = new TradovateClient();
      await this.tradovateClient.authenticate();

      // Initialize DataCache
      this.dataCache = new DataCache();
      this.dataCache.initialize();

      // Load accounts
      await this.loadAccounts();

      // Start collecting data for all accounts
      await this.startDataCollection();

      this.isRunning = true;
      logger.info('✅ Data Collector initialized successfully');

      this.emit('initialized', {
        accountsCount: this.accounts.length,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error(`Failed to initialize data collector: ${error.message}`);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Load and cache account list
   */
  async loadAccounts() {
    try {
      const accounts = await this.tradovateClient.getAccounts();
      this.accounts = accounts.filter(account => account.active); // Only active accounts

      logger.info(`Loaded ${this.accounts.length} active accounts`);

      // Cache account data
      for (const account of this.accounts) {
        if (this.dataCache && this.dataCache.isInitialized) {
          this.dataCache.cacheAccountData(account.id, account);

          // Initialize polling state
          this.dataCache.updatePollingState(account.id, 'IDLE', 'Initial state');
        }
      }

      return this.accounts;
    } catch (error) {
      logger.error(`Failed to load accounts: ${error.message}`);
      throw error;
    }
  }

  /**
   * Start data collection for all accounts
   */
  async startDataCollection() {
    logger.info('Starting data collection for all accounts...');

    for (const account of this.accounts) {
      await this.initializeAccountPolling(account.id);
    }
  }

  /**
   * Initialize polling for a specific account
   */
  async initializeAccountPolling(accountId) {
    // Fetch initial data BEFORE determining polling mode
    logger.info(`🔄 STARTUP: Fetching initial data for account ${accountId}...`);

    try {
      // Get current positions and orders to make informed polling decision
      logger.info(`🔄 STARTUP: Making fresh API call for positions (account ${accountId})`);
      await this.pollDataType(accountId, 'positions');

      logger.info(`🔄 STARTUP: Making fresh API call for orders (account ${accountId})`);
      await this.pollDataType(accountId, 'orders');

      logger.info(`🔄 STARTUP: Initial data fetching completed for account ${accountId}`);
    } catch (error) {
      logger.warn(`⚠️ STARTUP: Failed to fetch initial data for account ${accountId}: ${error.message}`);
    }

    // Now determine polling mode based on actual data
    const pollingInfo = this.dataCache.determinePollingMode(accountId);
    const mode = pollingInfo.mode;

    logger.info(`Initializing polling for account ${accountId} in ${mode} mode`);

    // Update polling state
    this.dataCache.updatePollingState(accountId, mode, pollingInfo.reason);

    // Create timers for this account
    const accountTimers = {
      balance: null,
      positions: null,
      orders: null
    };

    // Start polling for each data type
    this.startPollingTimer(accountId, 'balance', accountTimers);
    this.startPollingTimer(accountId, 'positions', accountTimers);
    this.startPollingTimer(accountId, 'orders', accountTimers);

    this.timers.set(accountId, accountTimers);

    // Emit mode change
    this.emit('polling_mode_changed', {
      accountId,
      mode,
      reason: pollingInfo.reason,
      openPositions: pollingInfo.openPositions,
      workingOrders: pollingInfo.workingOrders,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Start polling timer for specific data type
   */
  startPollingTimer(accountId, dataType, accountTimers) {
    const pollingState = this.dataCache.getPollingState(accountId);
    const mode = pollingState?.current_mode || 'IDLE';
    const interval = this.pollingIntervals[mode][dataType];

    // Clear existing timer
    if (accountTimers[dataType]) {
      clearTimeout(accountTimers[dataType]);
    }

    // Start new timer
    accountTimers[dataType] = setTimeout(async () => {
      await this.pollDataType(accountId, dataType);

      // Schedule next poll
      this.startPollingTimer(accountId, dataType, accountTimers);
    }, interval);

    logger.info(`${dataType} polling for account ${accountId} scheduled every ${interval}ms (${mode} mode)`);
  }

  /**
   * Poll specific data type for an account
   */
  async pollDataType(accountId, dataType) {
    const startTime = Date.now();

    try {
      this.stats.totalPolls++;

      let data = null;
      let cacheMethod = null;

      switch (dataType) {
        case 'balance':
          logger.info(`🔄 Making API call: getAccountBalance(${accountId})`);
          data = await this.tradovateClient.getAccountBalance(accountId);
          cacheMethod = 'cacheAccountBalance';
          break;
        case 'positions':
          logger.info(`🔄 Making API call: getPositions(${accountId})`);
          data = await this.tradovateClient.getPositions(accountId);
          logger.info(`🔄 API Response: Found ${data ? data.length : 0} positions`);
          cacheMethod = 'cachePositions';
          break;
        case 'orders':
          logger.info(`🔄 Making API call: getOrders(${accountId})`);
          data = await this.tradovateClient.getOrders(accountId);
          logger.info(`🔄 API Response: Found ${data ? data.length : 0} orders`);
          // Note: getOrders now handles caching internally, so we skip the cache step
          cacheMethod = null;
          break;
        default:
          throw new Error(`Unknown data type: ${dataType}`);
      }

      // Cache the data (with safety check) - skip if method handles caching internally
      if (cacheMethod && this.dataCache && this.dataCache.isInitialized) {
        // Ensure account exists first to satisfy foreign key constraints
        const existingAccount = this.dataCache.getCachedAccountData(accountId);
        if (!existingAccount) {
          logger.info(`🔑 Caching account ${accountId} first for ${dataType} foreign key constraint`);
          this.dataCache.cacheAccountData(accountId, { id: accountId, name: `Account ${accountId}` });
        }

        this.dataCache[cacheMethod](accountId, data);
      } else if (cacheMethod) {
        logger.warn(`DataCache not ready - skipping cache for ${dataType}`);
      } else {
        logger.info(`Caching handled internally by ${dataType} method`);
      }

      // Update stats
      const responseTime = Date.now() - startTime;
      this.stats.successfulPolls++;
      this.stats.lastPollTime = new Date().toISOString();
      this.updateAverageResponseTime(responseTime);

      // Log successful poll
      this.dataCache.logUpdate(accountId, dataType, true, null, responseTime);

      // Check if polling mode should change
      await this.checkPollingModeChange(accountId);

      // Emit update event
      this.emit('data_updated', {
        accountId,
        dataType,
        data,
        responseTime,
        timestamp: new Date().toISOString()
      });

      logger.debug(`${dataType} updated for account ${accountId} in ${responseTime}ms`);

    } catch (error) {
      this.stats.errors++;

      // Log error
      this.dataCache.logUpdate(accountId, dataType, false, error.message, Date.now() - startTime);

      logger.error(`Failed to poll ${dataType} for account ${accountId}: ${error.message}`);

      // Emit error event
      this.emit('poll_error', {
        accountId,
        dataType,
        error: error.message,
        timestamp: new Date().toISOString()
      });

      // Handle rate limiting
      if (error.message.includes('rate limit') || error.message.includes('429')) {
        logger.warn(`Rate limit detected, slowing down polling for account ${accountId}`);
        await this.handleRateLimit(accountId);
      }
    }
  }

  /**
   * Check if polling mode should change for an account
   */
  async checkPollingModeChange(accountId) {
    const currentState = this.dataCache.getPollingState(accountId);
    const newPollingInfo = this.dataCache.determinePollingMode(accountId);

    if (currentState.current_mode !== newPollingInfo.mode) {
      logger.info(`Polling mode change for account ${accountId}: ${currentState.current_mode} → ${newPollingInfo.mode}`);

      // Update polling state
      this.dataCache.updatePollingState(accountId, newPollingInfo.mode, newPollingInfo.reason);

      // Restart timers with new intervals
      await this.restartAccountPolling(accountId);

      // Emit mode change event
      this.emit('polling_mode_changed', {
        accountId,
        oldMode: currentState.current_mode,
        newMode: newPollingInfo.mode,
        reason: newPollingInfo.reason,
        openPositions: newPollingInfo.openPositions,
        workingOrders: newPollingInfo.workingOrders,
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Restart polling for an account with new intervals
   */
  async restartAccountPolling(accountId) {
    // Clear existing timers
    const accountTimers = this.timers.get(accountId);
    if (accountTimers) {
      Object.values(accountTimers).forEach(timer => {
        if (timer) clearTimeout(timer);
      });
    }

    // Restart polling
    await this.initializeAccountPolling(accountId);
  }

  /**
   * Handle rate limiting by temporarily switching to IDLE mode
   */
  async handleRateLimit(accountId) {
    logger.warn(`Switching account ${accountId} to IDLE mode due to rate limiting`);

    this.dataCache.updatePollingState(accountId, 'IDLE', 'Rate limit protection');
    await this.restartAccountPolling(accountId);

    // Emit rate limit event
    this.emit('rate_limit_activated', {
      accountId,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Force polling mode for an account (user override)
   */
  async forcePollingMode(accountId, mode, reason = 'User override', durationMs = 10 * 60 * 1000) {
    logger.info(`Force setting polling mode to ${mode} for account ${accountId}: ${reason}`);

    this.dataCache.updatePollingState(accountId, mode, reason);
    await this.restartAccountPolling(accountId);

    // Auto-revert after duration
    if (durationMs > 0) {
      setTimeout(async () => {
        const pollingInfo = this.dataCache.determinePollingMode(accountId);
        this.dataCache.updatePollingState(accountId, pollingInfo.mode, 'Auto-revert from forced mode');
        await this.restartAccountPolling(accountId);

        this.emit('forced_mode_reverted', {
          accountId,
          revertedToMode: pollingInfo.mode,
          timestamp: new Date().toISOString()
        });
      }, durationMs);
    }

    this.emit('polling_mode_forced', {
      accountId,
      mode,
      reason,
      duration: durationMs,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Force fresh data refresh for a specific account (bypasses cache)
   */
  async forceDataRefresh(accountId) {
    logger.info(`FORCE REFRESH: Starting for account ${accountId}`);
    console.log(`🔄 FORCE REFRESH: Starting for account ${accountId}`);

    try {
      // Make fresh API calls for all data types
      await this.pollDataType(accountId, 'positions');
      await this.pollDataType(accountId, 'orders');
      await this.pollDataType(accountId, 'balance');

      // Re-evaluate polling mode based on fresh data
      const pollingInfo = this.dataCache.determinePollingMode(accountId);
      const currentMode = this.dataCache.getPollingState(accountId)?.current_mode;

      if (pollingInfo.mode !== currentMode) {
        logger.info(`🔄 FORCE REFRESH: Mode change for account ${accountId}: ${currentMode} → ${pollingInfo.mode}`);
        this.dataCache.updatePollingState(accountId, pollingInfo.mode, pollingInfo.reason);

        // Emit mode change event
        this.emit('polling_mode_changed', {
          accountId,
          oldMode: currentMode,
          newMode: pollingInfo.mode,
          mode: pollingInfo.mode,
          reason: pollingInfo.reason,
          openPositions: pollingInfo.openPositions,
          workingOrders: pollingInfo.workingOrders,
          timestamp: new Date().toISOString()
        });

        // Restart polling timers with new intervals
        const accountTimers = this.timers.get(accountId);
        if (accountTimers) {
          this.startPollingTimer(accountId, 'balance', accountTimers);
          this.startPollingTimer(accountId, 'positions', accountTimers);
          this.startPollingTimer(accountId, 'orders', accountTimers);
        }
      }

      logger.info(`✅ FORCE REFRESH: Completed for account ${accountId}`);

    } catch (error) {
      logger.error(`❌ FORCE REFRESH: Failed for account ${accountId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get current status for all accounts
   */
  getStatus() {
    const status = {
      isRunning: this.isRunning,
      accountsCount: this.accounts.length,
      stats: { ...this.stats },
      accounts: []
    };

    for (const account of this.accounts) {
      const pollingState = this.dataCache.getPollingState(account.id);
      const snapshot = this.dataCache.getAccountSnapshot(account.id);

      status.accounts.push({
        accountId: account.id,
        accountName: account.name,
        pollingMode: pollingState?.current_mode,
        lastModeChange: pollingState?.last_mode_change,
        modeChangeReason: pollingState?.mode_change_reason,
        dataAge: snapshot.dataAge,
        openPositions: snapshot.positions?.filter(p => p.netPos !== 0).length || 0,
        workingOrders: snapshot.orders?.filter(o => o.ordStatus === 'Working').length || 0
      });
    }

    return status;
  }

  /**
   * Update average response time
   */
  updateAverageResponseTime(responseTime) {
    if (this.stats.averageResponseTime === 0) {
      this.stats.averageResponseTime = responseTime;
    } else {
      this.stats.averageResponseTime =
        (this.stats.averageResponseTime * (this.stats.successfulPolls - 1) + responseTime) / this.stats.successfulPolls;
    }
  }

  /**
   * Get data cache reference
   */
  getDataCache() {
    if (!this.dataCache || !this.dataCache.isInitialized) {
      return null;
    }
    return this.dataCache;
  }

  /**
   * Stop data collection
   */
  stop() {
    logger.info('Stopping data collection...');

    this.isRunning = false;

    // Clear all timers
    for (const [accountId, accountTimers] of this.timers) {
      Object.values(accountTimers).forEach(timer => {
        if (timer) clearTimeout(timer);
      });
    }

    this.timers.clear();

    // Close connections
    if (this.tradovateClient) {
      this.tradovateClient.disconnect();
    }

    if (this.dataCache) {
      this.dataCache.close();
    }

    this.emit('stopped', {
      timestamp: new Date().toISOString()
    });

    logger.info('Data collection stopped');
  }
}

export default TradovateDataCollector;