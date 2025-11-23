import express from 'express';
import { getAllPositions, getAllOrders, calculateDailyPnL, getCriticalTradingStatus } from '../services/tradeExecutor.js';
import TradovateClient from '../services/tradovateClient.js';
import database from '../services/database.js';
import winston from 'winston';

const router = express.Router();

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [TRADING-API-${level.toUpperCase()}]: ${message}`;
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

/**
 * Get all current positions across accounts (using cached data)
 */
router.get('/positions', async (req, res) => {
  try {
    logger.info('📍 Fetching all positions from cached data');

    // Try to use cached data first
    if (global.tradovateDataCollector) {
      const status = global.tradovateDataCollector.getStatus();
      const dataCache = global.tradovateDataCollector.getDataCache();

      if (dataCache) {
        const allPositions = [];

        for (const accountInfo of status.accounts || []) {
          const accountSnapshot = dataCache.getAccountSnapshot(accountInfo.accountId);
          if (accountSnapshot.positions) {
            const positionsWithAccount = accountSnapshot.positions.map(pos => ({
              ...pos,
              accountId: accountInfo.accountId,
              accountName: accountInfo.accountName
            }));
            allPositions.push(...positionsWithAccount);
          }
        }

        return res.json({
          success: true,
          cached: true,
          positions: allPositions,
          count: allPositions.length,
          timestamp: new Date().toISOString()
        });
      }
    }

    // Fallback to direct API call
    const positions = await getAllPositions();

    res.json({
      success: true,
      cached: false,
      positions,
      count: positions.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error(`Failed to fetch positions: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get all current orders across accounts (using cached data)
 */
router.get('/orders', async (req, res) => {
  try {
    logger.info('📋 Fetching all orders from cached data');

    // Try to use cached data first
    if (global.tradovateDataCollector) {
      const status = global.tradovateDataCollector.getStatus();
      const dataCache = global.tradovateDataCollector.getDataCache();

      if (dataCache) {
        const allOrders = [];

        for (const accountInfo of status.accounts || []) {
          const accountSnapshot = dataCache.getAccountSnapshot(accountInfo.accountId);
          if (accountSnapshot.orders) {
            const ordersWithAccount = accountSnapshot.orders.map(order => ({
              ...order,
              accountId: accountInfo.accountId,
              accountName: accountInfo.accountName
            }));
            allOrders.push(...ordersWithAccount);
          }
        }

        return res.json({
          success: true,
          cached: true,
          orders: allOrders,
          count: allOrders.length,
          timestamp: new Date().toISOString()
        });
      }
    }

    // Fallback to direct API call
    const orders = await getAllOrders();

    res.json({
      success: true,
      cached: false,
      orders,
      count: orders.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error(`Failed to fetch orders: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get daily P&L across all accounts (using cached data)
 */
router.get('/pnl', async (req, res) => {
  try {
    logger.info('💰 Calculating daily P&L from cached data');

    // Get data collector status to access cached account data
    if (!global.tradovateDataCollector) {
      // Fallback to direct calculation if data collector not available
      const pnlData = await calculateDailyPnL();
      return res.json({
        success: true,
        cached: false,
        ...pnlData
      });
    }

    const status = global.tradovateDataCollector.getStatus();
    const dataCache = global.tradovateDataCollector.getDataCache();

    if (!dataCache) {
      // Fallback to direct calculation
      const pnlData = await calculateDailyPnL();
      return res.json({
        success: true,
        cached: false,
        ...pnlData
      });
    }

    let totalDayPnL = 0;
    const accountPnL = [];

    // Calculate from cached data
    for (const accountInfo of status.accounts || []) {
      const accountSnapshot = dataCache.getAccountSnapshot(accountInfo.accountId);
      if (accountSnapshot.balance) {
        const dayPnL = accountSnapshot.balance.dayPnL || 0;
        totalDayPnL += dayPnL;

        accountPnL.push({
          accountId: accountInfo.accountId,
          accountName: accountInfo.accountName,
          dayPnL: dayPnL,
          balance: accountSnapshot.balance.balance,
          equity: accountSnapshot.balance.equity,
          margin: accountSnapshot.balance.margin
        });
      }
    }

    res.json({
      success: true,
      cached: true,
      totalDayPnL,
      accountPnL,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error(`Failed to calculate P&L: ${error.message}`);

    // Fallback to direct calculation on error
    try {
      const pnlData = await calculateDailyPnL();
      res.json({
        success: true,
        cached: false,
        fallback: true,
        ...pnlData
      });
    } catch (fallbackError) {
      res.status(500).json({
        success: false,
        error: fallbackError.message
      });
    }
  }
});

/**
 * Get kill switch status
 */
router.get('/kill-switch', async (req, res) => {
  try {
    const tradingEnabled = database.getSystemStatus('trading_enabled');
    const lastChanged = database.getSystemStatus('trading_enabled_changed_at');
    const changedBy = database.getSystemStatus('trading_enabled_changed_by');

    res.json({
      success: true,
      tradingEnabled: tradingEnabled !== false, // Default to false if not set
      lastChanged,
      changedBy,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error(`Failed to get kill switch status: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Set kill switch status
 */
router.post('/kill-switch', async (req, res) => {
  try {
    const { enabled, reason } = req.body;
    const currentStatus = database.getSystemStatus('trading_enabled');

    // Set the new status
    database.setSystemStatus('trading_enabled', enabled);
    database.setSystemStatus('trading_enabled_changed_at', new Date().toISOString());
    database.setSystemStatus('trading_enabled_changed_by', req.ip || 'unknown');

    // Log the change
    const message = enabled
      ? `🟢 Trading ENABLED${reason ? `: ${reason}` : ''}`
      : `🔴 Trading DISABLED (Kill Switch)${reason ? `: ${reason}` : ''}`;

    logger.warn(message);
    database.logActivity(
      'kill_switch',
      message,
      {
        previousState: currentStatus,
        newState: enabled,
        reason,
        changedBy: req.ip
      },
      enabled ? 'warning' : 'error'
    );

    // Emit WebSocket event
    if (global.io) {
      global.io.emit('kill_switch_changed', {
        enabled,
        reason,
        timestamp: new Date().toISOString()
      });
    }

    res.json({
      success: true,
      tradingEnabled: enabled,
      message: enabled ? 'Trading enabled' : 'Trading disabled',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error(`Failed to set kill switch: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Manually place a trade order
 */
router.post('/order', async (req, res) => {
  try {
    // Check kill switch first
    const tradingEnabled = database.getSystemStatus('trading_enabled');
    if (tradingEnabled === false) {
      return res.status(403).json({
        success: false,
        error: 'Trading is disabled (kill switch active)'
      });
    }

    const { accountId, symbol, action, quantity, orderType = 'Market' } = req.body;

    if (!accountId || !symbol || !action || !quantity) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: accountId, symbol, action, quantity'
      });
    }

    logger.info(`📊 Manual order: ${action} ${quantity} ${symbol}`);

    const client = getTradovateClient();

    // Ensure authentication
    if (!client.accessToken) {
      await client.authenticate();
    }

    const orderData = {
      accountId,
      symbol: symbol.toUpperCase(),
      orderQty: Math.abs(parseInt(quantity)),
      action: action.charAt(0).toUpperCase() + action.slice(1).toLowerCase(),
      orderType,
      timeInForce: 'Day',
      isAutomated: false
    };

    const result = await client.placeOrder(orderData);

    res.json({
      success: true,
      orderId: result.orderId,
      message: 'Order placed successfully',
      orderData,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error(`Failed to place manual order: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Cancel an order
 */
router.delete('/order/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;

    logger.info(`❌ Cancelling order: ${orderId}`);

    const client = getTradovateClient();

    // Ensure authentication
    if (!client.accessToken) {
      await client.authenticate();
    }

    await client.cancelOrder(parseInt(orderId));

    res.json({
      success: true,
      message: 'Order cancelled successfully',
      orderId,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error(`Failed to cancel order: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get trading statistics (using cached data)
 */
router.get('/stats', async (req, res) => {
  try {
    logger.info('📈 Fetching trading statistics from cached data');

    // Get data collector status to access cached data
    if (!global.tradovateDataCollector) {
      // Fallback to direct calculation if data collector not available
      const [positions, orders, pnlData] = await Promise.all([
        getAllPositions(),
        getAllOrders(),
        calculateDailyPnL()
      ]);

      const stats = {
        totalPositions: positions.length,
        totalOrders: orders.length,
        totalDayPnL: pnlData.totalDayPnL,
        longPositions: positions.filter(p => p.qty > 0).length,
        shortPositions: positions.filter(p => p.qty < 0).length,
        pendingOrders: orders.filter(o => o.status === 'Working').length,
        filledOrders: orders.filter(o => o.status === 'Filled').length,
        timestamp: new Date().toISOString()
      };

      return res.json({
        success: true,
        cached: false,
        stats
      });
    }

    const status = global.tradovateDataCollector.getStatus();
    const dataCache = global.tradovateDataCollector.getDataCache();

    if (!dataCache) {
      // Fallback to direct calculation
      const [positions, orders, pnlData] = await Promise.all([
        getAllPositions(),
        getAllOrders(),
        calculateDailyPnL()
      ]);

      const stats = {
        totalPositions: positions.length,
        totalOrders: orders.length,
        totalDayPnL: pnlData.totalDayPnL,
        longPositions: positions.filter(p => p.qty > 0).length,
        shortPositions: positions.filter(p => p.qty < 0).length,
        pendingOrders: orders.filter(o => o.status === 'Working').length,
        filledOrders: orders.filter(o => o.status === 'Filled').length,
        timestamp: new Date().toISOString()
      };

      return res.json({
        success: true,
        cached: false,
        stats
      });
    }

    // Calculate stats from cached data
    let totalPositions = 0;
    let totalOrders = 0;
    let totalDayPnL = 0;
    let longPositions = 0;
    let shortPositions = 0;
    let pendingOrders = 0;
    let filledOrders = 0;

    for (const accountInfo of status.accounts || []) {
      const accountSnapshot = dataCache.getAccountSnapshot(accountInfo.accountId);

      // Calculate position stats
      if (accountSnapshot.positions) {
        const positions = accountSnapshot.positions;
        totalPositions += positions.length;
        longPositions += positions.filter(p => (p.qty || p.netPos || 0) > 0).length;
        shortPositions += positions.filter(p => (p.qty || p.netPos || 0) < 0).length;
      }

      // Calculate order stats
      if (accountSnapshot.orders) {
        const orders = accountSnapshot.orders;
        totalOrders += orders.length;
        pendingOrders += orders.filter(o => (o.status || o.ordStatus) === 'Working').length;
        filledOrders += orders.filter(o => (o.status || o.ordStatus) === 'Filled').length;
      }

      // Calculate P&L
      if (accountSnapshot.balance) {
        totalDayPnL += accountSnapshot.balance.dayPnL || 0;
      }
    }

    const stats = {
      totalPositions,
      totalOrders,
      totalDayPnL,
      longPositions,
      shortPositions,
      pendingOrders,
      filledOrders,
      timestamp: new Date().toISOString()
    };

    res.json({
      success: true,
      cached: true,
      stats
    });

  } catch (error) {
    logger.error(`Failed to fetch trading stats: ${error.message}`);

    // Fallback to direct calculation on error
    try {
      const [positions, orders, pnlData] = await Promise.all([
        getAllPositions(),
        getAllOrders(),
        calculateDailyPnL()
      ]);

      const stats = {
        totalPositions: positions.length,
        totalOrders: orders.length,
        totalDayPnL: pnlData.totalDayPnL,
        longPositions: positions.filter(p => p.qty > 0).length,
        shortPositions: positions.filter(p => p.qty < 0).length,
        pendingOrders: orders.filter(o => o.status === 'Working').length,
        filledOrders: orders.filter(o => o.status === 'Filled').length,
        timestamp: new Date().toISOString()
      };

      res.json({
        success: true,
        cached: false,
        fallback: true,
        stats
      });
    } catch (fallbackError) {
      res.status(500).json({
        success: false,
        error: fallbackError.message
      });
    }
  }
});

/**
 * Get live market data for a symbol
 */
router.get('/quote/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;

    logger.info(`📊 Getting quote for: ${symbol}`);

    const client = getTradovateClient();

    // Subscribe to real-time quotes
    client.subscribeToQuote(symbol.toUpperCase());

    res.json({
      success: true,
      message: `Subscribed to ${symbol} quotes`,
      symbol: symbol.toUpperCase(),
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error(`Failed to get quote: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get critical trading dashboard information
 */
router.get('/critical-status', async (req, res) => {
  try {
    logger.info('🎯 Fetching critical trading status for dashboard');

    // Add timeout to prevent hanging
    const criticalData = await Promise.race([
      getCriticalTradingStatus(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Critical status request timeout')), 8000)
      )
    ]);

    res.json({
      success: true,
      ...criticalData
    });
  } catch (error) {
    logger.error(`Failed to get critical status: ${error.message}`);

    // Return minimal fallback data instead of 500 error
    res.json({
      success: false,
      error: error.message,
      openOrders: [],
      openPositions: [],
      totalDayPnL: 0,
      lastUpdate: new Date().toISOString(),
      positionMonitorStats: { isRunning: false, monitoredPositions: 0 }
    });
  }
});

/**
 * Health check for trading API
 */
router.get('/health', async (req, res) => {
  try {
    // Test authentication status
    let authStatus = 'unknown';
    let authError = null;

    try {
      const client = getTradovateClient();
      if (!client.accessToken) {
        logger.info('No access token, attempting authentication...');
        await client.authenticate();
        authStatus = 'connected';
      } else {
        authStatus = 'connected';
      }
    } catch (authErr) {
      authStatus = 'failed';
      authError = authErr.message;
      logger.warn(`Authentication failed: ${authErr.message}`);
    }

    const client = getTradovateClient();
    const isWebSocketConnected = client.isConnected;

    const healthData = {
      status: authStatus === 'connected' ? 'healthy' : 'degraded',
      authenticated: authStatus === 'connected',
      authenticationStatus: authStatus,
      authenticationError: authError,
      websocketConnected: isWebSocketConnected,
      environment: process.env.TRADOVATE_USE_DEMO === 'true' ? 'demo' : 'live',
      timestamp: new Date().toISOString(),
      credentials: {
        hasUsername: !!process.env.TRADOVATE_USERNAME,
        hasPassword: !!process.env.TRADOVATE_PASSWORD,
        appId: process.env.TRADOVATE_APP_ID || 'Sample App'
      }
    };

    // Return 200 even if authentication failed - we want to report the status
    res.json(healthData);

  } catch (error) {
    logger.error(`Health check failed: ${error.message}`);
    res.status(500).json({
      status: 'unhealthy',
      authenticated: false,
      authenticationStatus: 'error',
      authenticationError: error.message,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Force re-sync with Tradovate to get fresh data
 */
router.post('/re-sync', async (req, res) => {
  try {
    logger.info('Manual re-sync requested - forcing fresh data collection');
    console.log('🔄 RE-SYNC: Starting manual re-sync operation');

    if (!global.tradovateDataCollector) {
      return res.status(503).json({
        success: false,
        error: 'Data collector not available'
      });
    }

    const status = global.tradovateDataCollector.getStatus();
    if (!status.isRunning) {
      return res.status(503).json({
        success: false,
        error: 'Data collector not running'
      });
    }

    // Force fresh data collection for all accounts
    const results = [];
    for (const accountInfo of status.accounts || []) {
      try {
        logger.info(`🔄 Re-syncing account ${accountInfo.accountId}...`);

        // Force fresh API calls (bypassing any cache)
        await global.tradovateDataCollector.forceDataRefresh(accountInfo.accountId);

        results.push({
          accountId: accountInfo.accountId,
          success: true
        });

        logger.info(`✅ Re-sync completed for account ${accountInfo.accountId}`);
      } catch (error) {
        logger.error(`❌ Re-sync failed for account ${accountInfo.accountId}: ${error.message}`);
        results.push({
          accountId: accountInfo.accountId,
          success: false,
          error: error.message
        });
      }
    }

    res.json({
      success: true,
      message: 'Re-sync completed',
      results,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error(`Re-sync failed: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;