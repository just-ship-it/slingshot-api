import express from 'express';
import TradovateClient from '../services/tradovateClient.js';
import winston from 'winston';

const router = express.Router();

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [ACCOUNT-API-${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

// Lazy initialization of TradovateClient
let tradovateClient = null;

function getTradovateClient() {
  if (!tradovateClient) {
    tradovateClient = new TradovateClient();
  }
  return tradovateClient;
}

// Helper function to get data cache with safety checks
function getDataCache() {
  try {
    if (!global.tradovateDataCollector) {
      return null;
    }
    const cache = global.tradovateDataCollector.getDataCache();
    if (!cache || !cache.isInitialized) {
      return null;
    }
    return cache;
  } catch (error) {
    logger.warn('Failed to get data cache:', error.message);
    return null;
  }
}

// Helper function to add rate limit headers
function addRateLimitHeaders(res, client) {
  if (client && client.getRateLimiterStats) {
    const stats = client.getRateLimiterStats();
    res.set({
      'X-RateLimit-Healthy': client.isApiHealthy() ? 'true' : 'false',
      'X-RateLimit-Queue-Length': stats.queueLength.toString(),
      'X-RateLimit-Total-Requests': stats.totalRequests.toString(),
      'X-RateLimit-Penalties': stats.penaltiesReceived.toString(),
      'X-RateLimit-Penalty-Active': stats.penaltyActive ? 'true' : 'false'
    });
  }
}

/**
 * Get all accounts
 */
router.get('/list', async (req, res) => {
  try {
    logger.info('👤 Fetching all accounts from cache');

    const dataCache = getDataCache();

    if (dataCache) {
      // Try to get cached accounts first
      const cachedAccounts = [];
      const stats = dataCache.getStats();

      if (stats && stats.accountsCount > 0) {
        // If we have cached accounts, return them
        for (let i = 1; i <= stats.accountsCount; i++) {
          const cached = dataCache.getCachedAccountData(`account_${i}`); // This needs to be adjusted
        }

        // For now, get account list from data collector status
        if (global.tradovateDataCollector) {
          const status = global.tradovateDataCollector.getStatus();
          if (status.accounts && status.accounts.length > 0) {
            const accounts = status.accounts.map(acc => ({
              id: acc.accountId,
              name: acc.accountName || acc.accountId,
              active: true
            }));

            return res.json({
              success: true,
              accounts,
              count: accounts.length,
              cached: true,
              timestamp: new Date().toISOString()
            });
          }
        }
      }
    }

    // Fallback to direct API call if cache is not available
    const client = getTradovateClient();

    // Ensure authentication
    if (!client.accessToken) {
      await client.authenticate();
    }

    const accounts = await client.getAccounts();

    // Add rate limit headers
    addRateLimitHeaders(res, client);

    res.json({
      success: true,
      accounts,
      count: accounts.length,
      cached: false,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error(`Failed to fetch accounts: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get specific account details
 */
router.get('/:accountId', async (req, res) => {
  try {
    const { accountId } = req.params;
    logger.info(`👤 Fetching account details: ${accountId}`);

    const client = getTradovateClient();

    // Ensure authentication
    if (!client.accessToken) {
      await client.authenticate();
    }

    const balance = await client.getAccountBalance(accountId);
    const positions = await client.getPositions(accountId);
    const orders = await client.getOrders(accountId);

    const accountDetails = {
      accountId,
      balance: balance.balance,
      equity: balance.equity,
      margin: balance.margin,
      availableFunds: balance.availableFunds,
      dayPnL: balance.dayPnL,
      positions: positions.length,
      activeOrders: orders.filter(order => order.status === 'Working').length,
      timestamp: new Date().toISOString()
    };

    res.json({
      success: true,
      account: accountDetails
    });

  } catch (error) {
    logger.error(`Failed to fetch account details: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get account balance and equity information
 */
router.get('/:accountId/balance', async (req, res) => {
  try {
    const { accountId } = req.params;
    logger.info(`💰 Fetching balance for account: ${accountId} from cache`);

    const dataCache = getDataCache();

    if (dataCache) {
      const cachedBalance = dataCache.getCachedAccountBalance(accountId);

      if (cachedBalance && cachedBalance.age < 10 * 60 * 1000) { // 10 minutes max age (more lenient)
        return res.json({
          success: true,
          accountId,
          balance: cachedBalance.data,
          cached: true,
          age: cachedBalance.age,
          lastUpdated: cachedBalance.lastUpdated,
          timestamp: new Date().toISOString()
        });
      } else if (cachedBalance) {
        // Even if stale, return it rather than making slow API call
        return res.json({
          success: true,
          accountId,
          balance: cachedBalance.data,
          cached: true,
          stale: true,
          age: cachedBalance.age,
          lastUpdated: cachedBalance.lastUpdated,
          timestamp: new Date().toISOString()
        });
      } else {
        // No cache data yet, return empty rather than timeout
        return res.status(503).json({
          success: false,
          error: 'No cached balance data available yet, background collection in progress',
          accountId,
          cached: false,
          empty: true,
          timestamp: new Date().toISOString()
        });
      }
    }

    // Fallback to direct API call
    const client = getTradovateClient();

    // Ensure authentication
    if (!client.accessToken) {
      await client.authenticate();
    }

    const balance = await client.getAccountBalance(accountId);

    res.json({
      success: true,
      accountId,
      balance,
      cached: false,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error(`Failed to fetch account balance: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get account positions
 */
router.get('/:accountId/positions', async (req, res) => {
  try {
    const { accountId } = req.params;
    logger.info(`📍 Fetching positions for account: ${accountId} from cache`);

    const dataCache = getDataCache();

    if (dataCache) {
      const cachedPositions = dataCache.getCachedPositions(accountId);

      if (cachedPositions && cachedPositions.age < 10 * 60 * 1000) { // 10 minutes max age (more lenient)
        return res.json({
          success: true,
          accountId,
          positions: cachedPositions.data,
          count: cachedPositions.data.length,
          openPositions: cachedPositions.openPositionsCount,
          cached: true,
          age: cachedPositions.age,
          lastUpdated: cachedPositions.lastUpdated,
          timestamp: new Date().toISOString()
        });
      } else if (cachedPositions) {
        // Even if stale, return it rather than making slow API call
        return res.json({
          success: true,
          accountId,
          positions: cachedPositions.data,
          count: cachedPositions.data.length,
          openPositions: cachedPositions.openPositionsCount,
          cached: true,
          stale: true,
          age: cachedPositions.age,
          lastUpdated: cachedPositions.lastUpdated,
          timestamp: new Date().toISOString()
        });
      } else {
        // No cache data yet, return empty rather than timeout
        return res.json({
          success: true,
          accountId,
          positions: [],
          count: 0,
          openPositions: 0,
          cached: false,
          empty: true,
          message: 'No cached data available yet, background collection in progress',
          timestamp: new Date().toISOString()
        });
      }
    }

    // Fallback to direct API call
    const client = getTradovateClient();

    // Ensure authentication
    if (!client.accessToken) {
      await client.authenticate();
    }

    const positions = await client.getPositions(accountId);

    res.json({
      success: true,
      accountId,
      positions,
      count: positions.length,
      cached: false,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error(`Failed to fetch account positions: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get account orders
 */
router.get('/:accountId/orders', async (req, res) => {
  try {
    const { accountId } = req.params;
    logger.info(`📋 Fetching orders for account: ${accountId} from cache`);

    const dataCache = getDataCache();

    if (dataCache) {
      const cachedOrders = dataCache.getCachedOrders(accountId);

      if (cachedOrders && cachedOrders.age < 10 * 60 * 1000) { // 10 minutes max age (more lenient)
        return res.json({
          success: true,
          accountId,
          orders: cachedOrders.data,
          count: cachedOrders.data.length,
          workingOrders: cachedOrders.workingOrdersCount,
          cached: true,
          age: cachedOrders.age,
          lastUpdated: cachedOrders.lastUpdated,
          timestamp: new Date().toISOString()
        });
      } else if (cachedOrders) {
        // Even if stale, return it rather than making slow API call
        return res.json({
          success: true,
          accountId,
          orders: cachedOrders.data,
          count: cachedOrders.data.length,
          workingOrders: cachedOrders.workingOrdersCount,
          cached: true,
          stale: true,
          age: cachedOrders.age,
          lastUpdated: cachedOrders.lastUpdated,
          timestamp: new Date().toISOString()
        });
      } else {
        // No cache data yet, return empty rather than timeout
        return res.json({
          success: true,
          accountId,
          orders: [],
          count: 0,
          workingOrders: 0,
          cached: false,
          empty: true,
          message: 'No cached data available yet, background collection in progress',
          timestamp: new Date().toISOString()
        });
      }
    }

    // Fallback to direct API call
    const client = getTradovateClient();

    // Ensure authentication
    if (!client.accessToken) {
      await client.authenticate();
    }

    const orders = await client.getOrders(accountId);

    res.json({
      success: true,
      accountId,
      orders,
      count: orders.length,
      cached: false,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error(`Failed to fetch account orders: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get comprehensive account summary
 */
router.get('/:accountId/summary', async (req, res) => {
  try {
    const { accountId } = req.params;
    logger.info(`📊 Fetching account summary: ${accountId} from cache`);

    const dataCache = getDataCache();

    if (dataCache) {
      // Get snapshot from cache
      const snapshot = dataCache.getAccountSnapshot(accountId);

      // If we have at least balance data, use cached data (even if partial)
      if (snapshot.balance) {
        // Check if balance data is fresh enough (max 10 minutes, very lenient)
        const maxAge = 10 * 60 * 1000; // 10 minutes
        const balanceAge = snapshot.dataAge.balance || 0;
        const positionsAge = snapshot.dataAge.positions || 0;
        const ordersAge = snapshot.dataAge.orders || 0;

        if (balanceAge < maxAge) {
          const balance = snapshot.balance;
          const positions = snapshot.positions || [];
          const orders = snapshot.orders || [];

          // Calculate summary statistics from cached data
          const openPositions = positions.filter(pos => pos.netPos !== 0);
          const workingOrders = orders.filter(order => order.ordStatus === 'Working');
          const filledOrdersToday = orders.filter(order =>
            order.ordStatus === 'Filled' &&
            new Date(order.timestamp).toDateString() === new Date().toDateString()
          );

          const summary = {
            accountId,
            balance: balance.balance,
            equity: balance.equity,
            margin: balance.margin,
            availableFunds: balance.availableFunds,
            dayPnL: balance.dayPnL,
            dayPnLPercent: balance.balance > 0 ? (balance.dayPnL / balance.balance * 100) : 0,
            totalPositions: openPositions.length,
            longPositions: openPositions.filter(pos => pos.netPos > 0).length,
            shortPositions: openPositions.filter(pos => pos.netPos < 0).length,
            workingOrders: workingOrders.length,
            tradesExecutedToday: filledOrdersToday.length,
            cached: true,
            dataAge: Math.max(balanceAge, positionsAge, ordersAge),
            timestamp: new Date().toISOString()
          };

          return res.json({
            success: true,
            summary
          });
        } else if (snapshot.balance) {
          // Even if stale, return cached data rather than making slow API call
          const balance = snapshot.balance;
          const positions = snapshot.positions || [];
          const orders = snapshot.orders || [];

          // Calculate summary statistics from cached data
          const openPositions = positions.filter(pos => pos.netPos !== 0);
          const workingOrders = orders.filter(order => order.ordStatus === 'Working');
          const filledOrdersToday = orders.filter(order =>
            order.ordStatus === 'Filled' &&
            new Date(order.timestamp).toDateString() === new Date().toDateString()
          );

          const summary = {
            accountId,
            balance: balance.balance,
            equity: balance.equity,
            margin: balance.margin,
            availableFunds: balance.availableFunds,
            dayPnL: balance.dayPnL,
            dayPnLPercent: balance.balance > 0 ? (balance.dayPnL / balance.balance * 100) : 0,
            totalPositions: openPositions.length,
            longPositions: openPositions.filter(pos => pos.netPos > 0).length,
            shortPositions: openPositions.filter(pos => pos.netPos < 0).length,
            workingOrders: workingOrders.length,
            tradesExecutedToday: filledOrdersToday.length,
            cached: true,
            stale: true,
            dataAge: balanceAge,
            timestamp: new Date().toISOString()
          };

          return res.json({
            success: true,
            summary
          });
        } else {
          // No balance data available yet
          return res.status(503).json({
            success: false,
            error: 'No cached account data available yet, background collection in progress',
            accountId,
            cached: false,
            empty: true,
            timestamp: new Date().toISOString()
          });
        }
      }
    }

    // Fallback to direct API call (should rarely be reached now)
    const client = getTradovateClient();

    // Ensure authentication
    if (!client.accessToken) {
      await client.authenticate();
    }

    // Fetch all account data in parallel
    const [balance, positions, orders] = await Promise.all([
      client.getAccountBalance(accountId),
      client.getPositions(accountId),
      client.getOrders(accountId)
    ]);

    // Calculate summary statistics
    const openPositions = positions.filter(pos => pos.qty !== 0);
    const workingOrders = orders.filter(order => order.status === 'Working');
    const filledOrdersToday = orders.filter(order =>
      order.status === 'Filled' &&
      new Date(order.timestamp).toDateString() === new Date().toDateString()
    );

    const summary = {
      accountId,
      balance: balance.balance,
      equity: balance.equity,
      margin: balance.margin,
      availableFunds: balance.availableFunds,
      dayPnL: balance.dayPnL,
      dayPnLPercent: balance.balance > 0 ? (balance.dayPnL / balance.balance * 100) : 0,
      totalPositions: openPositions.length,
      longPositions: openPositions.filter(pos => pos.qty > 0).length,
      shortPositions: openPositions.filter(pos => pos.qty < 0).length,
      workingOrders: workingOrders.length,
      tradesExecutedToday: filledOrdersToday.length,
      cached: false,
      timestamp: new Date().toISOString()
    };

    res.json({
      success: true,
      summary
    });

  } catch (error) {
    logger.error(`Failed to fetch account summary: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get margin snapshot for an account
 */
router.get('/:accountId/margin', async (req, res) => {
  try {
    const { accountId } = req.params;
    logger.info(`📈 Fetching margin snapshot for account: ${accountId}`);

    const client = getTradovateClient();

    // Ensure authentication
    if (!client.accessToken) {
      await client.authenticate();
    }

    const marginSnapshot = await client.getMarginSnapshot(accountId);

    res.json({
      success: true,
      accountId,
      margin: marginSnapshot,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error(`Failed to fetch margin snapshot: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get cash balance snapshot
 */
router.get('/:accountId/cash-balance', async (req, res) => {
  try {
    const { accountId } = req.params;
    logger.info(`💵 Fetching cash balance snapshot for account: ${accountId}`);

    const client = getTradovateClient();

    // Ensure authentication
    if (!client.accessToken) {
      await client.authenticate();
    }

    const cashBalance = await client.getCashBalanceSnapshot(accountId);

    res.json({
      success: true,
      accountId,
      cashBalance,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error(`Failed to fetch cash balance snapshot: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get fills (executed trades) for an account
 */
router.get('/:accountId/fills', async (req, res) => {
  try {
    const { accountId } = req.params;
    const { limit = 100 } = req.query;
    logger.info(`💹 Fetching fills for account: ${accountId}`);

    const client = getTradovateClient();

    // Ensure authentication
    if (!client.accessToken) {
      await client.authenticate();
    }

    const fills = await client.getFills(accountId, parseInt(limit));

    res.json({
      success: true,
      accountId,
      fills,
      count: fills.length,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error(`Failed to fetch fills: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get complete account snapshot with all details
 */
router.get('/:accountId/snapshot', async (req, res) => {
  try {
    const { accountId } = req.params;
    logger.info(`📸 Fetching complete snapshot for account: ${accountId}`);

    const client = getTradovateClient();

    // Ensure authentication
    if (!client.accessToken) {
      await client.authenticate();
    }

    // Fetch all account data in parallel
    const [balance, positions, orders, marginSnapshot, fills] = await Promise.all([
      client.getAccountBalance(accountId),
      client.getPositions(accountId),
      client.getOrders(accountId),
      client.getMarginSnapshot(accountId).catch(() => null),
      client.getFills(accountId, 20)
    ]);

    // Get contract details for positions
    const positionsWithDetails = [];
    for (const position of positions) {
      try {
        const contract = await client.getContract(position.contractId);
        positionsWithDetails.push({
          ...position,
          contractName: contract.name,
          contractDescription: contract.description
        });
      } catch (error) {
        positionsWithDetails.push(position);
      }
    }

    const snapshot = {
      accountId,
      balance: {
        ...balance,
        marginUsagePercent: marginSnapshot && marginSnapshot.maintenanceMargin && balance.equity
          ? (marginSnapshot.maintenanceMargin / balance.equity * 100).toFixed(2)
          : 0
      },
      margin: marginSnapshot,
      positions: {
        list: positionsWithDetails,
        count: positionsWithDetails.length,
        long: positionsWithDetails.filter(p => p.netPos > 0).length,
        short: positionsWithDetails.filter(p => p.netPos < 0).length
      },
      orders: {
        list: orders,
        working: orders.filter(o => o.ordStatus === 'Working'),
        filled: orders.filter(o => o.ordStatus === 'Filled'),
        cancelled: orders.filter(o => o.ordStatus === 'Cancelled')
      },
      recentFills: fills,
      timestamp: new Date().toISOString()
    };

    // Add rate limit headers
    addRateLimitHeaders(res, client);

    res.json({
      success: true,
      snapshot
    });

  } catch (error) {
    logger.error(`Failed to fetch account snapshot: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get data collector status for accounts
 */
router.get('/collector/status', async (req, res) => {
  try {
    logger.info('📊 Fetching data collector status');

    if (!global.tradovateDataCollector) {
      return res.json({
        success: false,
        error: 'Data collector not initialized'
      });
    }

    const status = global.tradovateDataCollector.getStatus();
    const dataCache = getDataCache();

    let cacheStats = null;
    if (dataCache) {
      cacheStats = dataCache.getStats();
    }

    res.json({
      success: true,
      collector: status,
      cache: cacheStats,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error(`Failed to fetch collector status: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Force polling mode for an account
 */
router.post('/:accountId/polling/force', async (req, res) => {
  try {
    const { accountId } = req.params;
    const { mode, reason, duration } = req.body;

    if (!['IDLE', 'ACTIVE', 'CRITICAL'].includes(mode)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid polling mode. Must be IDLE, ACTIVE, or CRITICAL'
      });
    }

    if (!global.tradovateDataCollector) {
      return res.status(400).json({
        success: false,
        error: 'Data collector not initialized'
      });
    }

    await global.tradovateDataCollector.forcePollingMode(
      accountId,
      mode,
      reason || 'User override via API',
      duration || 10 * 60 * 1000 // 10 minutes default
    );

    logger.info(`Forced polling mode ${mode} for account ${accountId}`);

    res.json({
      success: true,
      message: `Polling mode set to ${mode} for account ${accountId}`,
      mode,
      duration: duration || 10 * 60 * 1000,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error(`Failed to force polling mode: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get all accounts summary (overview of all accounts)
 */
router.get('/overview/all', async (req, res) => {
  try {
    logger.info('📊 Fetching overview of all accounts');

    const client = getTradovateClient();

    // Ensure authentication
    if (!client.accessToken) {
      await client.authenticate();
    }

    const accounts = await client.getAccounts();
    const accountSummaries = [];

    for (const account of accounts) {
      try {
        const [balance, positions, orders] = await Promise.all([
          client.getAccountBalance(account.id),
          client.getPositions(account.id),
          client.getOrders(account.id)
        ]);

        const openPositions = positions.filter(pos => pos.qty !== 0);
        const workingOrders = orders.filter(order => order.status === 'Working');

        accountSummaries.push({
          accountId: account.id,
          accountName: account.name,
          balance: balance.balance,
          equity: balance.equity,
          dayPnL: balance.dayPnL,
          totalPositions: openPositions.length,
          workingOrders: workingOrders.length
        });
      } catch (error) {
        logger.warn(`Failed to get summary for account ${account.id}: ${error.message}`);
        accountSummaries.push({
          accountId: account.id,
          accountName: account.name,
          error: error.message
        });
      }
    }

    // Calculate totals
    const totals = {
      totalBalance: accountSummaries.reduce((sum, acc) => sum + (acc.balance || 0), 0),
      totalEquity: accountSummaries.reduce((sum, acc) => sum + (acc.equity || 0), 0),
      totalDayPnL: accountSummaries.reduce((sum, acc) => sum + (acc.dayPnL || 0), 0),
      totalPositions: accountSummaries.reduce((sum, acc) => sum + (acc.totalPositions || 0), 0),
      totalWorkingOrders: accountSummaries.reduce((sum, acc) => sum + (acc.workingOrders || 0), 0)
    };

    res.json({
      success: true,
      accounts: accountSummaries,
      totals,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error(`Failed to fetch accounts overview: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Debug endpoint to check cache data for specific account
 */
router.get('/:accountId/cache-debug', async (req, res) => {
  try {
    const { accountId } = req.params;
    logger.info(`🔍 Debug cache data for account: ${accountId}`);

    const dataCache = getDataCache();

    if (!dataCache) {
      return res.status(503).json({
        success: false,
        error: 'DataCache not available',
        accountId
      });
    }

    // Get raw cache data
    const snapshot = dataCache.getAccountSnapshot(accountId);
    const balance = dataCache.getCachedAccountBalance(accountId);
    const positions = dataCache.getCachedPositions(accountId);
    const orders = dataCache.getCachedOrders(accountId);
    const pollingState = dataCache.getPollingState(accountId);

    // Get data collector status
    const collectorStatus = global.tradovateDataCollector ?
      global.tradovateDataCollector.getStatus() : null;

    res.json({
      success: true,
      accountId,
      debug: {
        cacheAvailable: !!dataCache,
        collectorAvailable: !!global.tradovateDataCollector,
        snapshot: {
          hasBalance: !!snapshot.balance,
          hasPositions: !!snapshot.positions,
          hasOrders: !!snapshot.orders,
          dataAge: snapshot.dataAge
        },
        balance: balance ? {
          hasData: !!balance.data,
          age: balance.age,
          lastUpdated: balance.lastUpdated
        } : null,
        positions: positions ? {
          hasData: !!positions.data,
          count: positions.data?.length || 0,
          age: positions.age,
          lastUpdated: positions.lastUpdated
        } : null,
        orders: orders ? {
          hasData: !!orders.data,
          count: orders.data?.length || 0,
          age: orders.age,
          lastUpdated: orders.lastUpdated
        } : null,
        pollingState: pollingState,
        collectorStatus: collectorStatus ? {
          isRunning: collectorStatus.isRunning,
          accountCount: collectorStatus.accounts?.length || 0,
          accountsTracked: collectorStatus.accounts?.map(a => a.accountId) || []
        } : null
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error(`Failed to debug cache data: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;