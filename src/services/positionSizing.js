import winston from 'winston';
import database from './database.js';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [POSITION-SIZING-${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

/**
 * Position Sizing Service
 * Handles dynamic position sizing based on account risk and contract specifications
 */
class PositionSizingService {
  constructor() {
    this.marginsLoaded = false;

    // Contract specifications for different symbols
    this.contractSpecs = {
      'MNQ': {
        pointValue: 2.0,
        maxLoss: 52, // Strategy max loss in points
        dayMargin: 100, // Day trading margin requirement
        fullSizeEquivalent: 'NQ',
        contractType: 'micro',
        description: 'Micro E-mini NASDAQ-100'
      },
      'MNQ!': {
        pointValue: 2.0,
        maxLoss: 52,
        dayMargin: 100,
        fullSizeEquivalent: 'NQ!',
        contractType: 'micro',
        description: 'Micro E-mini NASDAQ-100 Continuous'
      },
      'NQ': {
        pointValue: 20.0,
        maxLoss: 52,
        dayMargin: 1000, // Day trading margin requirement
        microEquivalent: 'MNQ',
        contractType: 'full',
        description: 'E-mini NASDAQ-100'
      },
      'NQ!': {
        pointValue: 20.0,
        maxLoss: 52,
        dayMargin: 1000,
        microEquivalent: 'MNQ!',
        contractType: 'full',
        description: 'E-mini NASDAQ-100 Continuous'
      },
      'MES': {
        pointValue: 5.0,
        maxLoss: 20,
        dayMargin: 50, // Day trading margin requirement
        fullSizeEquivalent: 'ES',
        contractType: 'micro',
        description: 'Micro E-mini S&P 500'
      },
      'MES!': {
        pointValue: 5.0,
        maxLoss: 20,
        dayMargin: 50,
        fullSizeEquivalent: 'ES!',
        contractType: 'micro',
        description: 'Micro E-mini S&P 500 Continuous'
      },
      'ES': {
        pointValue: 50.0,
        maxLoss: 20,
        dayMargin: 500, // Day trading margin requirement
        microEquivalent: 'MES',
        contractType: 'full',
        description: 'E-mini S&P 500'
      },
      'ES!': {
        pointValue: 50.0,
        maxLoss: 20,
        dayMargin: 500,
        microEquivalent: 'MES!',
        contractType: 'full',
        description: 'E-mini S&P 500 Continuous'
      }
    };
  }

  /**
   * Get position sizing settings from database
   */
  getPositionSizingSettings() {
    const sizingMethod = database.getSystemStatus('position_sizing_method') || 'fixed';
    const fixedQuantity = database.getSystemStatus('position_sizing_fixed_quantity') || 1;
    const riskPercentage = database.getSystemStatus('position_sizing_risk_percentage') || 10;
    const maxContracts = database.getSystemStatus('position_sizing_max_contracts') || 10;
    const marginUtilization = database.getSystemStatus('position_sizing_margin_utilization') || 0.5;

    return {
      method: sizingMethod, // 'fixed' or 'risk_based'
      fixedQuantity: parseInt(fixedQuantity),
      riskPercentage: parseFloat(riskPercentage),
      maxContracts: parseInt(maxContracts),
      marginUtilization: parseFloat(marginUtilization)
    };
  }

  /**
   * Save position sizing settings to database
   */
  savePositionSizingSettings(settings) {
    database.setSystemStatus('position_sizing_method', settings.method);
    database.setSystemStatus('position_sizing_fixed_quantity', settings.fixedQuantity);
    database.setSystemStatus('position_sizing_risk_percentage', settings.riskPercentage);
    database.setSystemStatus('position_sizing_max_contracts', settings.maxContracts);
    if (settings.marginUtilization !== undefined) {
      database.setSystemStatus('position_sizing_margin_utilization', settings.marginUtilization);
    }

    database.logActivity(
      'position_sizing',
      `Position sizing updated: ${settings.method} method`,
      settings,
      'info'
    );

    logger.info(`Position sizing settings saved: ${JSON.stringify(settings)}`);
  }

  /**
   * Calculate optimal contract selection based on account balance and margin requirements
   */
  calculateOptimalContract(symbol, accountBalance, settings = null, signalData = null) {
    try {
      // Ensure margin requirements are loaded
      this.loadMarginRequirements();

      // Use provided settings or get from database
      const sizingSettings = settings || this.getPositionSizingSettings();

      // Get contract specifications for requested symbol
      const contractSpec = this.getContractSpec(symbol);
      if (!contractSpec) {
        logger.error(`Unknown symbol for optimal contract calculation: ${symbol}`);
        return { symbol, quantity: 1, originalSymbol: symbol, converted: false };
      }

      // Calculate available trading capital (accounting for margin utilization)
      const marginUtilization = sizingSettings.marginUtilization || 0.5; // Default 50%
      const availableCapital = accountBalance * marginUtilization;

      logger.info(`Optimal contract selection for ${symbol}: Available capital = $${availableCapital} (${marginUtilization * 100}% of $${accountBalance})`);

      // Check if we can afford the requested contract's day margin
      if (availableCapital >= contractSpec.dayMargin) {
        logger.info(`Account can afford ${symbol} (margin: $${contractSpec.dayMargin})`);

        // Calculate position size for the requested contract
        const quantity = this.calculatePositionSize(symbol, accountBalance, settings, signalData);

        return {
          symbol,
          quantity,
          originalSymbol: symbol,
          converted: false,
          marginUsed: contractSpec.dayMargin * quantity,
          reason: 'sufficient_margin'
        };
      }

      // If can't afford full-size contract, try to convert to micro equivalent
      if (contractSpec.contractType === 'full' && contractSpec.microEquivalent) {
        const microSymbol = contractSpec.microEquivalent;
        const microSpec = this.getContractSpec(microSymbol);

        if (microSpec && availableCapital >= microSpec.dayMargin) {
          logger.info(`Converting ${symbol} to ${microSymbol} (margin: $${microSpec.dayMargin})`);

          // Calculate position size for micro contracts
          const microQuantity = this.calculatePositionSize(microSymbol, accountBalance, settings, signalData);

          return {
            symbol: microSymbol,
            quantity: microQuantity,
            originalSymbol: symbol,
            converted: true,
            marginUsed: microSpec.dayMargin * microQuantity,
            reason: 'converted_to_micro'
          };
        }
      }

      // If can't afford either, return minimal position
      logger.warn(`Account cannot afford any contracts for ${symbol} (available: $${availableCapital})`);

      return {
        symbol,
        quantity: 0,
        originalSymbol: symbol,
        converted: false,
        marginUsed: 0,
        reason: 'insufficient_margin'
      };

    } catch (error) {
      logger.error(`Error in optimal contract calculation: ${error.message}`);
      return { symbol, quantity: 1, originalSymbol: symbol, converted: false, reason: 'error' };
    }
  }

  /**
   * Calculate position size based on settings and account balance
   */
  calculatePositionSize(symbol, accountBalance, settings = null, signalData = null) {
    try {
      // Use provided settings or get from database
      const sizingSettings = settings || this.getPositionSizingSettings();

      // Get contract specifications
      const contractSpec = this.getContractSpec(symbol);
      if (!contractSpec) {
        logger.error(`Unknown symbol for position sizing: ${symbol}`);
        return 1; // Default fallback
      }

      // Calculate max loss per contract in dollars
      let maxLossPerContract;

      // If signal data with stop loss is provided, calculate actual risk
      if (signalData && signalData.entryPrice && signalData.stopLoss) {
        const stopLossPoints = Math.abs(signalData.entryPrice - signalData.stopLoss);
        maxLossPerContract = stopLossPoints * contractSpec.pointValue;
        logger.info(`Using signal stop loss: ${stopLossPoints} points = $${maxLossPerContract} per contract`);
      } else {
        // Fallback to contract specification max loss
        maxLossPerContract = contractSpec.maxLoss * contractSpec.pointValue;
        logger.info(`Using contract spec max loss: ${contractSpec.maxLoss} points = $${maxLossPerContract} per contract`);
      }

      logger.info(`Position sizing for ${symbol}: Max loss per contract = $${maxLossPerContract}`);
      logger.info(`Account balance: $${accountBalance}, Settings: ${JSON.stringify(sizingSettings)}`);

      let quantity = 1;

      if (sizingSettings.method === 'fixed') {
        quantity = sizingSettings.fixedQuantity;
        logger.info(`Using fixed quantity: ${quantity} contracts`);
      } else if (sizingSettings.method === 'risk_based') {
        // Calculate risk-based position size
        const riskAmount = accountBalance * (sizingSettings.riskPercentage / 100);
        const calculatedQuantity = Math.floor(riskAmount / maxLossPerContract);

        quantity = Math.max(0, calculatedQuantity); // Ensure non-negative

        logger.info(`Risk-based sizing: $${riskAmount} risk (${sizingSettings.riskPercentage}%) / $${maxLossPerContract} per contract = ${quantity} contracts`);
      }

      // Apply maximum contract limit
      if (quantity > sizingSettings.maxContracts) {
        logger.warn(`Calculated quantity ${quantity} exceeds max limit ${sizingSettings.maxContracts}, using max`);
        quantity = sizingSettings.maxContracts;
      }

      // Ensure minimum of 0 contracts (insufficient account balance)
      if (quantity < 0) {
        logger.warn(`Insufficient account balance for any contracts, using 0`);
        quantity = 0;
      }

      return quantity;

    } catch (error) {
      logger.error(`Error calculating position size: ${error.message}`);
      return 1; // Safe fallback
    }
  }

  /**
   * Get contract specifications for a symbol
   */
  getContractSpec(symbol) {
    // Clean up symbol (remove exchange prefixes, etc.)
    const cleanSymbol = this.cleanSymbol(symbol);
    return this.contractSpecs[cleanSymbol];
  }

  /**
   * Clean symbol name to match our contract specs
   */
  cleanSymbol(symbol) {
    if (!symbol) return 'MNQ';

    // Remove common exchange prefixes and suffixes
    let cleaned = symbol.toUpperCase()
      .replace(/^NASDAQ:|^CME:|^CBOT:|^NYMEX:/i, '') // Exchange prefixes
      .replace(/\s+/g, '') // Whitespace
      .trim();

    // Map common variations
    const symbolMappings = {
      'MNQU2024': 'MNQ',
      'MNQU24': 'MNQ',
      'NQU2024': 'NQ',
      'NQU24': 'NQ',
      'NQ1!': 'NQ!',
      'MESU2024': 'MES',
      'MESU24': 'MES',
      'ESU2024': 'ES',
      'ESU24': 'ES'
    };

    if (symbolMappings[cleaned]) {
      cleaned = symbolMappings[cleaned];
    }

    return cleaned;
  }

  /**
   * Get available contract specifications
   */
  getAvailableContracts() {
    return Object.keys(this.contractSpecs).map(symbol => ({
      symbol,
      ...this.contractSpecs[symbol],
      maxLossDollar: this.contractSpecs[symbol].maxLoss * this.contractSpecs[symbol].pointValue
    }));
  }

  /**
   * Calculate risk metrics for a given position size
   */
  calculateRiskMetrics(symbol, quantity, accountBalance, signalData = null) {
    const contractSpec = this.getContractSpec(symbol);
    if (!contractSpec) {
      return null;
    }

    // Calculate max loss per contract (use signal stop loss if available)
    let maxLossPerContract;
    if (signalData && signalData.entryPrice && signalData.stopLoss) {
      const stopLossPoints = Math.abs(signalData.entryPrice - signalData.stopLoss);
      maxLossPerContract = stopLossPoints * contractSpec.pointValue;
    } else {
      maxLossPerContract = contractSpec.maxLoss * contractSpec.pointValue;
    }

    const totalMaxLoss = maxLossPerContract * quantity;
    const riskPercentage = accountBalance > 0 ? (totalMaxLoss / accountBalance) * 100 : 0;

    return {
      quantity,
      maxLossPerContract,
      totalMaxLoss,
      riskPercentage,
      accountBalance
    };
  }

  /**
   * Update margin requirements for contracts
   */
  updateMarginRequirements(marginSettings) {
    try {
      for (const [symbol, settings] of Object.entries(marginSettings)) {
        if (this.contractSpecs[symbol]) {
          this.contractSpecs[symbol].dayMargin = settings.dayMargin;

          // Save to database for persistence
          database.setSystemStatus(`margin_${symbol.toLowerCase()}_day`, settings.dayMargin);

          logger.info(`Updated day margin for ${symbol}: $${settings.dayMargin}`);
        } else {
          logger.warn(`Unknown symbol ${symbol} in margin settings update`);
        }
      }

      database.logActivity(
        'margin_settings',
        'Day margin requirements updated',
        marginSettings,
        'info'
      );

    } catch (error) {
      logger.error(`Error updating margin requirements: ${error.message}`);
      throw error;
    }
  }

  /**
   * Load margin requirements from database (called lazily when first needed)
   */
  loadMarginRequirements() {
    if (this.marginsLoaded) {
      return; // Already loaded
    }

    try {
      // Check if database is available
      if (!database || !database.db) {
        logger.warn('Database not ready, skipping margin requirements load');
        return;
      }

      for (const symbol of Object.keys(this.contractSpecs)) {
        const savedMargin = database.getSystemStatus(`margin_${symbol.toLowerCase()}_day`);
        if (savedMargin && !isNaN(parseFloat(savedMargin))) {
          this.contractSpecs[symbol].dayMargin = parseFloat(savedMargin);
          logger.info(`Loaded saved day margin for ${symbol}: $${savedMargin}`);
        }
      }

      this.marginsLoaded = true;
      logger.info('Margin requirements loaded successfully');
    } catch (error) {
      logger.warn(`Failed to load saved margin requirements: ${error.message}`);
    }
  }
}

// Create singleton instance
const positionSizingService = new PositionSizingService();

export default positionSizingService;