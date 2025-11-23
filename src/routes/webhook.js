import express from 'express';
import TradovateClient from '../services/tradovateClient.js';
import { processTradeSignal } from '../services/tradeExecutor.js';
import database from '../services/database.js';
import positionSizingService from '../services/positionSizing.js';
import winston from 'winston';
import crashLogger from '../services/crashLogger.js';

const router = express.Router();

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [WEBHOOK-${level.toUpperCase()}]: ${message}`;
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
 * TradingView Webhook Endpoint
 * Receives trading signals and executes trades
 */
router.post('/tradingview', async (req, res) => {
  try {
    const timestamp = new Date().toISOString();
    logger.info(`📨 Webhook received at ${timestamp}`);

    // Log the incoming signal
    logger.info(`Signal data: ${JSON.stringify(req.body, null, 2)}`);

    // Validate required fields
    const { action, symbol, qty, account } = req.body;

    if (!action || !symbol || !qty) {
      logger.error('Missing required fields: action, symbol, qty');
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: action, symbol, qty'
      });
    }

    // Validate webhook secret if configured
    const webhookSecret = req.headers['x-webhook-secret'] || req.body.secret;
    if (process.env.WEBHOOK_SECRET && webhookSecret !== process.env.WEBHOOK_SECRET) {
      logger.error('Invalid webhook secret');
      return res.status(401).json({
        success: false,
        error: 'Unauthorized'
      });
    }

    // Process the trading signal
    const tradeResult = await processTradeSignal({
      action: action.toUpperCase(),
      symbol: symbol.toUpperCase(),
      quantity: Math.abs(parseInt(qty)),
      account: account || 'default',
      timestamp,
      source: 'TradingView',
      rawData: req.body
    });

    // Emit real-time update to connected clients
    if (global.io) {
      global.io.emit('webhook_received', {
        timestamp,
        action,
        symbol,
        quantity: qty,
        result: tradeResult,
        success: true
      });
    }

    logger.info(`✅ Webhook processed successfully`);

    // Return success response
    res.json({
      success: true,
      message: 'Signal processed',
      timestamp,
      tradeId: tradeResult.tradeId,
      orderId: tradeResult.orderId
    });

  } catch (error) {
    logger.error(`❌ Webhook processing error: ${error.message}`);
    logger.error(`Error stack: ${error.stack}`);

    // Emit error to connected clients
    if (global.io) {
      global.io.emit('webhook_error', {
        timestamp: new Date().toISOString(),
        error: error.message,
        data: req.body
      });
    }

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Autotrader endpoint - handles TradingView webhook signals
 * Expects signals in format: { action, ticker, account, quantity, size, price, orderType }
 */
router.post('/autotrader', async (req, res) => {
  try {
    const timestamp = new Date().toISOString();
    logger.info(`📨 Autotrader webhook received at ${timestamp}`);
    logger.info(`Signal data: ${JSON.stringify(req.body, null, 2)}`);

    // Process the trading signal - handle multiple field name variations
    const {
      action, orderAction, side,
      ticker, symbol, instrument,
      quantity, qty, size, amount,
      account, accountId,
      price, limitPrice,
      orderType, type,
      stop_loss, take_profit,
      strategy,
      reason,
      ...otherFields
    } = req.body;

    // Flexible field mapping to support different naming conventions
    let tradeAction = action || orderAction || side;
    let instrumentSymbol = ticker || symbol || instrument;
    let tradeQuantity = quantity || qty || size || amount;
    const tradeAccount = account || accountId;
    const tradePrice = price || limitPrice;
    const tradeOrderType = orderType || type;

    // Get test balance early for use throughout the function
    const testBalance = req.body.test_account_balance;

    // Check if this is a limit order alert from LDPS strategy
    const isLimitOrderAlert = action && (action === 'place_limit' || action === 'cancel_limit');

    if (isLimitOrderAlert) {
      logger.info(`🎯 Limit order alert detected: ${action} for ${instrumentSymbol}`);

      if (action === 'place_limit') {
        // For place_limit alerts, use the 'side' field as the trading action
        if (side) {
          tradeAction = side.toUpperCase();
          logger.info(`🔄 Using side field for trading action: ${tradeAction}`);
        }

        // Calculate optimal contract and position size for limit orders
        try {
          // TEMPORARILY DISABLED: Get account balance from Tradovate client
          // const client = getTradovateClient();
          // if (!client.accessToken) {
          //   await client.authenticate();
          // }
          // const accounts = await client.getAccounts();
          // const targetAccount = accounts[0]; // Use first account for now
          // const accountBalance = await client.getAccountBalance(targetAccount.id);

          // Use fallback balance for testing without Tradovate connection
          const accountBalance = { balance: testBalance || 1500 }; // Mock $1.5k account for testing

          // Calculate optimal contract selection (handles NQ -> MNQ conversion if needed)
          logger.info(`🔍 DEBUG: About to calculate optimal contract for ${instrumentSymbol} with balance $${accountBalance.balance}`);

          // Prepare signal data for position sizing
          const signalData = {
            entryPrice: parseFloat(tradePrice),
            stopLoss: parseFloat(stop_loss)
          };

          logger.info(`🔍 DEBUG: Signal data for position sizing: entry=${signalData.entryPrice}, stop=${signalData.stopLoss}`);

          const optimalContract = positionSizingService.calculateOptimalContract(
            instrumentSymbol,
            accountBalance.balance || 1500, // Fallback
            null, // Use default settings
            signalData
          );

          logger.info(`🔍 DEBUG: Optimal contract result: ${JSON.stringify(optimalContract, null, 2)}`);

          // Use the optimal contract and calculated quantity
          if (optimalContract.symbol !== instrumentSymbol) {
            logger.info(`🔄 Converting ${instrumentSymbol} to ${optimalContract.symbol} based on available margin`);
            instrumentSymbol = optimalContract.symbol;
          }
          tradeQuantity = optimalContract.quantity;

          logger.info(`🎯 Optimal contract selection (TESTING MODE): ${optimalContract.originalSymbol} -> ${optimalContract.symbol}`);
          logger.info(`💰 Account balance: $${accountBalance.balance}, calculated quantity: ${optimalContract.quantity} contracts`);
          if (optimalContract.converted) {
            logger.info(`🔄 Contract converted: ${optimalContract.reason}`);
          }

          // Log the risk metrics
          const riskMetrics = positionSizingService.calculateRiskMetrics(
            instrumentSymbol,
            tradeQuantity,
            accountBalance.balance || 1500,
            signalData
          );

          if (riskMetrics) {
            logger.info(`📊 Risk metrics: ${riskMetrics.riskPercentage.toFixed(2)}% risk, max loss: $${riskMetrics.totalMaxLoss}`);
          }

        } catch (error) {
          logger.error(`❌ Failed to calculate dynamic position size: ${error.message}`);
          // Fallback to 1 contract if calculation fails
          tradeQuantity = 1;
        }
      } else if (action === 'cancel_limit') {
        // For cancel alerts, we don't need to worry about quantity
        logger.info(`❌ Limit order cancellation: ${reason || 'unknown reason'}`);
      }
    }

    // Log the mapped fields for debugging
    logger.info(`📊 Mapped fields: action="${tradeAction}", symbol="${instrumentSymbol}", quantity="${tradeQuantity}", account="${tradeAccount}", price="${tradePrice}", orderType="${tradeOrderType}"`);

    // Check kill switch early but continue processing to show conversion logic
    const tradingEnabled = database.getSystemStatus('trading_enabled');

    if (!tradeAction || !instrumentSymbol || tradeQuantity === undefined || tradeQuantity === null) {
      logger.error('Missing required fields in webhook. Supported field names:');
      logger.error('- Action: action, orderAction, side');
      logger.error('- Symbol: ticker, symbol, instrument');
      logger.error('- Quantity: quantity, qty, size, amount');
      logger.error('- Account: account, accountId (optional)');
      logger.error('- Price: price, limitPrice (optional)');
      logger.error('- Order Type: orderType, type (optional)');
      return res.status(400).json({
        success: false,
        error: 'Missing required fields. Need: action/orderAction/side, ticker/symbol/instrument, quantity/qty/size/amount'
      });
    }

    // Initialize tradeResult variable
    let tradeResult;

    // Process the trading signal using your existing trading enabled/disabled system
    if (tradingEnabled !== false) {
      // LIVE TRADING MODE - Execute real orders (when your system enables trading)
      logger.info(`🚨 LIVE TRADING MODE: Executing real order for ${tradeAction} ${tradeQuantity} ${instrumentSymbol}`);
      try {
        const signalData = {
          action: tradeAction.toUpperCase(),
          symbol: instrumentSymbol.toUpperCase(),
          quantity: Math.abs(parseInt(tradeQuantity)),
          account: tradeAccount || 'default',
          price: tradePrice || null,
          orderType: tradeOrderType || 'market',
          timestamp,
          source: 'AutoTrader',
          rawData: req.body
        };

        logger.info(`📊 Processing signal data: ${JSON.stringify(signalData, null, 2)}`);

        tradeResult = await processTradeSignal(signalData);
      } catch (error) {
        // Enhanced error logging for crash analysis
        const errorContext = {
          signalData: {
            action: tradeAction,
            symbol: instrumentSymbol,
            quantity: tradeQuantity,
            account: tradeAccount,
            price: tradePrice,
            orderType: tradeOrderType
          },
          rawRequest: req.body,
          errorName: error.name,
          errorCode: error.code || null,
          timestamp
        };

        // Log detailed error with context
        crashLogger.logCrash(error, 'tradeSignalProcessingError', errorContext);
        logger.error(`❌ Live trading error: ${error.message}`);
        logger.error(`📊 Error context: ${JSON.stringify(errorContext, null, 2)}`);

        tradeResult = {
          success: false,
          error: error.message,
          status: 'failed',
          timestamp,
          errorContext
        };
      }
    } else {
      // SIMULATION MODE - Trading is disabled via your kill switch
      logger.info(`🧪 TRADING DISABLED: Simulating trade execution (kill switch active)`);
      tradeResult = {
        success: true,
        tradeId: `test_${Date.now()}`,
        orderId: `order_${Math.random().toString(36).substr(2, 9)}`,
        message: `TRADING DISABLED: Would ${tradeAction.toUpperCase()} ${tradeQuantity} ${instrumentSymbol.toUpperCase()} ${tradeOrderType ? `(${tradeOrderType})` : '(market)'} ${tradePrice ? `@ $${tradePrice}` : ''}`,
        status: 'simulated',
        // Add contract selection details for UI display
        contractSelection: isLimitOrderAlert && action === 'place_limit' ? {
          originalSymbol: req.body.symbol || req.body.ticker || req.body.instrument,
          finalSymbol: instrumentSymbol,
          finalQuantity: tradeQuantity,
          converted: req.body.symbol !== instrumentSymbol,
          reason: req.body.symbol !== instrumentSymbol ? 'margin_optimization' : 'sufficient_margin',
          accountBalance: testBalance || 1500, // Mock balance for testing
          marginUsed: tradeQuantity * (instrumentSymbol.includes('MNQ') ? 100 : instrumentSymbol.includes('NQ') ? 1000 : instrumentSymbol.includes('MES') ? 50 : instrumentSymbol.includes('ES') ? 500 : 0)
        } : null
      };
      logger.info(`📊 Mock trade result: ${JSON.stringify(tradeResult, null, 2)}`);
    }

    // Set final status based on your existing trading enabled system
    // Add safety check in case tradeResult is undefined
    if (!tradeResult) {
      tradeResult = {
        success: false,
        error: 'Trade processing failed',
        status: 'error',
        message: 'Signal processing encountered an unexpected error'
      };
    }

    let finalStatus = tradingEnabled !== false ? (tradeResult.success ? 'executed' : 'failed') : 'disabled';
    let finalResult = { ...tradeResult };

    // Note: Kill switch logic is already handled above in the if/else block

    // Save webhook to database
    const webhookId = database.saveWebhook({
      action: tradeAction,
      symbol: instrumentSymbol,
      quantity: tradeQuantity,
      price: tradePrice,
      orderType: tradeOrderType,
      account: tradeAccount,
      source: 'AutoTrader',
      status: finalStatus,
      result: finalResult,
      rawData: req.body
    });

    // Log activity
    database.logActivity(
      'webhook',
      `${tradeAction.toUpperCase()} ${tradeQuantity} ${instrumentSymbol} ${tradePrice ? `@ $${tradePrice}` : ''}`,
      {
        webhookId,
        action: tradeAction,
        symbol: instrumentSymbol,
        quantity: tradeQuantity,
        price: tradePrice,
        source: 'AutoTrader'
      },
      'info'
    );

    // Emit real-time update to connected clients
    logger.info(`🔌 Checking WebSocket availability: global.io exists = ${!!global.io}`);
    if (global.io) {
      const webhookEvent = {
        timestamp,
        action: tradeAction,
        symbol: instrumentSymbol,
        quantity: tradeQuantity,
        price: tradePrice,
        orderType: tradeOrderType,
        account: tradeAccount,
        result: finalResult,
        success: !finalResult.blocked,
        source: 'AutoTrader',
        rawData: req.body
      };
      const connectedClients = global.io.engine.clientsCount;
      logger.info(`👥 Connected WebSocket clients: ${connectedClients}`);
      logger.info(`📡 Emitting webhook_received event: ${JSON.stringify(webhookEvent, null, 2)}`);
      global.io.emit('webhook_received', webhookEvent);
      logger.info(`✅ WebSocket event emitted to ${connectedClients} clients`);
    } else {
      logger.error(`❌ global.io not available - WebSocket events cannot be sent`);
    }

    logger.info(`✅ Autotrader webhook processed successfully`);

    // Return simple response for compatibility
    res.status(200).send('OK');

  } catch (error) {
    // Enhanced error logging with full crash context
    const errorContext = {
      endpoint: '/autotrader',
      requestBody: req.body,
      userAgent: req.headers['user-agent'],
      clientIP: req.ip,
      timestamp: new Date().toISOString()
    };

    crashLogger.logCrash(error, 'autotraderWebhookError', errorContext);
    logger.error(`❌ Autotrader webhook error: ${error.message}`);
    logger.error(`📊 Full error context: ${JSON.stringify(errorContext, null, 2)}`);

    // Emit error to connected clients
    if (global.io) {
      global.io.emit('webhook_error', {
        timestamp: new Date().toISOString(),
        error: error.message,
        data: req.body,
        source: 'AutoTrader'
      });
    }

    res.status(500).send('ERROR');
  }
});

/**
 * Test webhook endpoint for debugging
 */
router.post('/test', (req, res) => {
  logger.info('🧪 Test webhook received');
  logger.info(`Test data: ${JSON.stringify(req.body, null, 2)}`);

  res.json({
    success: true,
    message: 'Test webhook received',
    timestamp: new Date().toISOString(),
    receivedData: req.body
  });
});

/**
 * Health check for webhook endpoint
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    endpoint: 'webhook',
    timestamp: new Date().toISOString()
  });
});

/**
 * Get webhook statistics
 */
router.get('/stats', (req, res) => {
  // This would integrate with a database to show webhook stats
  res.json({
    totalWebhooks: 0, // TODO: Implement tracking
    successfulTrades: 0,
    failedTrades: 0,
    lastWebhook: null,
    uptime: process.uptime()
  });
});


export default router;