import winston from 'winston';
import TradovateClient from './tradovateClient.js';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [POSITION-MONITOR-${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

class PositionMonitor {
  constructor() {
    this.client = null;
    this.isRunning = false;
    this.monitorInterval = null;
    this.checkIntervalMs = 30000; // Check every 30 seconds
    this.activePositions = new Map(); // Track positions and their trailing configs
  }

  /**
   * Get or create Tradovate client instance
   */
  getTradovateClient() {
    if (!this.client) {
      this.client = new TradovateClient();
    }
    return this.client;
  }

  /**
   * Start monitoring positions for trailing stop activation
   */
  start() {
    if (this.isRunning) {
      logger.warn('Position monitor is already running');
      return;
    }

    logger.info(`🔄 Starting position monitor (check interval: ${this.checkIntervalMs / 1000}s)`);
    this.isRunning = true;

    this.monitorInterval = setInterval(() => {
      this.checkPositions().catch(error => {
        logger.error(`❌ Position monitoring error: ${error.message}`);
      });
    }, this.checkIntervalMs);
  }

  /**
   * Stop monitoring positions
   */
  stop() {
    if (!this.isRunning) {
      return;
    }

    logger.info('⏹️ Stopping position monitor');
    this.isRunning = false;

    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }

  /**
   * Register a new position for trailing stop monitoring
   */
  addPosition(tradeRecord) {
    if (!tradeRecord.trailingConfig) {
      return; // No trailing configuration
    }

    const positionKey = `${tradeRecord.accountId}-${tradeRecord.symbol}`;
    const monitorData = {
      tradeId: tradeRecord.tradeId,
      orderId: tradeRecord.orderId,
      stopOrderId: tradeRecord.stopOrderId,
      profitOrderId: tradeRecord.profitOrderId,
      accountId: tradeRecord.accountId,
      symbol: tradeRecord.symbol,
      action: tradeRecord.action,
      quantity: tradeRecord.quantity,
      trailingConfig: tradeRecord.trailingConfig,
      trailingActivated: false,
      highWaterMark: null, // Track peak profit for longs
      lowWaterMark: null,  // Track lowest point for shorts
      addedAt: new Date()
    };

    this.activePositions.set(positionKey, monitorData);
    logger.info(`📊 Added position to trailing monitor: ${positionKey} (trigger: ${tradeRecord.trailingConfig.trigger} pts)`);
  }

  /**
   * Remove a position from monitoring
   */
  removePosition(accountId, symbol) {
    const positionKey = `${accountId}-${symbol}`;
    const removed = this.activePositions.delete(positionKey);

    if (removed) {
      logger.info(`📊 Removed position from trailing monitor: ${positionKey}`);
    }
  }

  /**
   * Check all monitored positions for trailing stop activation
   */
  async checkPositions() {
    if (this.activePositions.size === 0) {
      return; // No positions to monitor
    }

    logger.info(`🔍 Checking ${this.activePositions.size} positions for trailing activation`);

    try {
      const client = this.getTradovateClient();

      // Ensure authenticated
      if (!client.accessToken) {
        await client.authenticate();
      }

      // Get all accounts
      const accounts = await client.getAccounts();

      for (const account of accounts) {
        await this.checkAccountPositions(account.id);
      }

    } catch (error) {
      logger.error(`❌ Failed to check positions: ${error.message}`);
    }
  }

  /**
   * Check positions for a specific account
   */
  async checkAccountPositions(accountId) {
    try {
      const client = this.getTradovateClient();
      const positions = await client.getPositions(accountId);

      // Filter monitored positions for this account
      const monitoredForAccount = Array.from(this.activePositions.entries())
        .filter(([key, data]) => data.accountId === accountId);

      for (const [positionKey, monitorData] of monitoredForAccount) {
        // Find corresponding live position
        const livePosition = positions.find(pos =>
          pos.symbol === monitorData.symbol ||
          (pos.symbol && pos.symbol.includes(monitorData.symbol.substring(0, 3)))
        );

        if (!livePosition) {
          // Position was closed, remove from monitoring
          logger.info(`📊 Position closed, removing from monitor: ${positionKey}`);
          this.activePositions.delete(positionKey);
          continue;
        }

        // Check if trailing stop should be activated
        await this.checkTrailingActivation(monitorData, livePosition);
      }

    } catch (error) {
      logger.error(`❌ Failed to check positions for account ${accountId}: ${error.message}`);
    }
  }

  /**
   * Check if a position should have its trailing stop activated
   */
  async checkTrailingActivation(monitorData, livePosition) {
    try {
      // Calculate current profit in points (simplified - would need to get entry price from order history)
      const currentPrice = livePosition.netPrice || 0;
      const quantity = livePosition.netPos || 0;
      const unrealizedPnL = livePosition.unrealizedPnL || 0;

      // Estimate profit per contract in points (rough calculation)
      const profitPerContract = quantity !== 0 ? unrealizedPnL / Math.abs(quantity) : 0;

      // Convert dollar profit to points (assuming $1 = 0.25 points for NQ/MNQ)
      const profitInPoints = profitPerContract / 0.25;

      logger.info(`📊 Position ${monitorData.symbol}: ${profitInPoints.toFixed(2)} pts profit, trigger: ${monitorData.trailingConfig.trigger} pts`);

      // Check if trailing should be activated
      if (!monitorData.trailingActivated && profitInPoints >= monitorData.trailingConfig.trigger) {
        logger.info(`🎯 Activating trailing stop for ${monitorData.symbol} at ${profitInPoints.toFixed(2)} pts profit`);
        await this.activateTrailingStop(monitorData, currentPrice);
      }

    } catch (error) {
      logger.error(`❌ Failed to check trailing activation for ${monitorData.symbol}: ${error.message}`);
    }
  }

  /**
   * Activate trailing stop for a position
   */
  async activateTrailingStop(monitorData, currentPrice) {
    try {
      const client = this.getTradovateClient();

      if (!monitorData.stopOrderId) {
        logger.warn(`⚠️ No stop order ID found for ${monitorData.symbol}, cannot activate trailing`);
        return;
      }

      // Convert trailing offset from points to price
      const trailingOffsetPrice = monitorData.trailingConfig.offset * 0.25; // 0.25 = point value

      // Prepare trailing stop modification
      const trailingModification = {
        orderId: monitorData.stopOrderId,
        autoTrail: {
          trigger: monitorData.trailingConfig.trigger * 0.25, // Convert points to price
          offset: trailingOffsetPrice,
          freq: 0.25 // Update frequency
        }
      };

      logger.info(`📊 Modifying stop order ${monitorData.stopOrderId} to trailing: ${JSON.stringify(trailingModification, null, 2)}`);

      // Modify the order to add trailing stop functionality
      await client.modifyOrder(trailingModification);

      monitorData.trailingActivated = true;
      monitorData.activatedAt = new Date();

      logger.info(`✅ Trailing stop activated for ${monitorData.symbol}`);

    } catch (error) {
      logger.error(`❌ Failed to activate trailing stop for ${monitorData.symbol}: ${error.message}`);
    }
  }

  /**
   * Get current monitoring statistics
   */
  getStats() {
    const stats = {
      isRunning: this.isRunning,
      monitoredPositions: this.activePositions.size,
      checkInterval: this.checkIntervalMs,
      positions: []
    };

    for (const [key, data] of this.activePositions) {
      stats.positions.push({
        key,
        symbol: data.symbol,
        trailingActivated: data.trailingActivated,
        trigger: data.trailingConfig.trigger,
        offset: data.trailingConfig.offset,
        addedAt: data.addedAt
      });
    }

    return stats;
  }
}

// Create singleton instance
const positionMonitor = new PositionMonitor();

export default positionMonitor;