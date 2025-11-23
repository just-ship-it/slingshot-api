import express from 'express';
import positionSizingService from '../services/positionSizing.js';
import TradovateClient from '../services/tradovateClient.js';
import winston from 'winston';

const router = express.Router();

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [POSITION-SIZING-API-${level.toUpperCase()}]: ${message}`;
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
 * Get current position sizing settings
 */
router.get('/settings', (req, res) => {
  try {
    const settings = positionSizingService.getPositionSizingSettings();
    res.json({
      success: true,
      settings
    });
  } catch (error) {
    logger.error(`Failed to get position sizing settings: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Update position sizing settings
 */
router.post('/settings', (req, res) => {
  try {
    const { method, fixedQuantity, riskPercentage, maxContracts } = req.body;

    // Validate settings
    if (!['fixed', 'risk_based'].includes(method)) {
      return res.status(400).json({
        success: false,
        error: 'Method must be "fixed" or "risk_based"'
      });
    }

    if (method === 'fixed' && (!fixedQuantity || fixedQuantity < 1)) {
      return res.status(400).json({
        success: false,
        error: 'Fixed quantity must be at least 1'
      });
    }

    if (method === 'risk_based' && (!riskPercentage || riskPercentage <= 0 || riskPercentage > 100)) {
      return res.status(400).json({
        success: false,
        error: 'Risk percentage must be between 0.1 and 100'
      });
    }

    if (maxContracts && maxContracts < 1) {
      return res.status(400).json({
        success: false,
        error: 'Max contracts must be at least 1'
      });
    }

    const settings = {
      method,
      fixedQuantity: parseInt(fixedQuantity) || 1,
      riskPercentage: parseFloat(riskPercentage) || 10,
      maxContracts: parseInt(maxContracts) || 10
    };

    positionSizingService.savePositionSizingSettings(settings);

    logger.info(`Position sizing settings updated: ${JSON.stringify(settings)}`);

    res.json({
      success: true,
      settings,
      message: 'Position sizing settings updated'
    });

  } catch (error) {
    logger.error(`Failed to update position sizing settings: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Calculate position size for a given symbol and account balance
 */
router.post('/calculate', async (req, res) => {
  try {
    const { symbol, accountBalance, settings } = req.body;

    if (!symbol) {
      return res.status(400).json({
        success: false,
        error: 'Symbol is required'
      });
    }

    let balance = accountBalance;

    // If no balance provided, use fallback (Tradovate connection temporarily disabled)
    if (!balance) {
      // TEMPORARILY DISABLED: try to get from Tradovate
      // try {
      //   const client = getTradovateClient();
      //   if (!client.accessToken) {
      //     await client.authenticate();
      //   }
      //   const accounts = await client.getAccounts();
      //   const accountInfo = await client.getAccountBalance(accounts[0].id);
      //   balance = accountInfo.balance || accountInfo.netLiquidatingValue || 10000;
      // } catch (error) {
      //   logger.warn(`Could not fetch account balance: ${error.message}`);
      //   balance = 10000; // Fallback
      // }

      balance = 10000; // Mock $10k account for testing
      logger.info(`Using mock account balance: $${balance} (Tradovate connection disabled)`);
    }

    const quantity = positionSizingService.calculatePositionSize(symbol, balance, settings);
    const riskMetrics = positionSizingService.calculateRiskMetrics(symbol, quantity, balance);
    const contractSpec = positionSizingService.getContractSpec(symbol);

    res.json({
      success: true,
      symbol,
      accountBalance: balance,
      calculatedQuantity: quantity,
      riskMetrics,
      contractSpec
    });

  } catch (error) {
    logger.error(`Failed to calculate position size: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get available contract specifications
 */
router.get('/contracts', (req, res) => {
  try {
    const contracts = positionSizingService.getAvailableContracts();
    res.json({
      success: true,
      contracts
    });
  } catch (error) {
    logger.error(`Failed to get contract specifications: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get margin requirements for all contracts
 */
router.get('/margins', (req, res) => {
  try {
    const contracts = positionSizingService.getAvailableContracts();
    const marginSettings = contracts.reduce((acc, contract) => {
      acc[contract.symbol] = {
        dayMargin: contract.dayMargin,
        pointValue: contract.pointValue,
        contractType: contract.contractType,
        description: contract.description
      };
      return acc;
    }, {});

    res.json({
      success: true,
      marginSettings
    });
  } catch (error) {
    logger.error(`Failed to get margin settings: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Update margin requirements for specific contracts
 */
router.post('/margins', (req, res) => {
  try {
    const { marginSettings } = req.body;

    if (!marginSettings || typeof marginSettings !== 'object') {
      return res.status(400).json({
        success: false,
        error: 'marginSettings object is required'
      });
    }

    // Validate margin settings
    for (const [symbol, settings] of Object.entries(marginSettings)) {
      if (!settings.dayMargin || settings.dayMargin <= 0) {
        return res.status(400).json({
          success: false,
          error: `Day margin for ${symbol} must be greater than 0`
        });
      }
    }

    // Update contract specifications with new margin requirements
    positionSizingService.updateMarginRequirements(marginSettings);

    logger.info(`Margin requirements updated: ${JSON.stringify(marginSettings)}`);

    res.json({
      success: true,
      marginSettings,
      message: 'Margin requirements updated successfully'
    });

  } catch (error) {
    logger.error(`Failed to update margin requirements: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Calculate optimal contract selection for account balance
 */
router.post('/optimal', async (req, res) => {
  try {
    const { symbol, accountBalance, settings } = req.body;

    if (!symbol) {
      return res.status(400).json({
        success: false,
        error: 'Symbol is required'
      });
    }

    let balance = accountBalance;

    // If no balance provided, use fallback (Tradovate connection temporarily disabled)
    if (!balance) {
      balance = 10000; // Mock $10k account for testing
      logger.info(`Using mock account balance: $${balance} (Tradovate connection disabled)`);
    }

    const optimalContract = positionSizingService.calculateOptimalContract(symbol, balance, settings);

    res.json({
      success: true,
      requestedSymbol: symbol,
      accountBalance: balance,
      optimalContract
    });

  } catch (error) {
    logger.error(`Failed to calculate optimal contract: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Test position sizing with various scenarios
 */
router.post('/test', (req, res) => {
  try {
    const { symbol = 'MNQ' } = req.body;

    const testScenarios = [
      { balance: 1000, risk: 10 },
      { balance: 1000, risk: 25 },
      { balance: 1000, risk: 50 },
      { balance: 5000, risk: 10 },
      { balance: 5000, risk: 20 },
      { balance: 10000, risk: 10 },
      { balance: 25000, risk: 15 }
    ];

    const results = testScenarios.map(scenario => {
      const settings = {
        method: 'risk_based',
        riskPercentage: scenario.risk,
        maxContracts: 20
      };

      const quantity = positionSizingService.calculatePositionSize(symbol, scenario.balance, settings);
      const riskMetrics = positionSizingService.calculateRiskMetrics(symbol, quantity, scenario.balance);

      return {
        accountBalance: scenario.balance,
        riskPercentage: scenario.risk,
        calculatedQuantity: quantity,
        actualRisk: riskMetrics ? riskMetrics.riskPercentage.toFixed(2) + '%' : 'N/A',
        maxLoss: riskMetrics ? '$' + riskMetrics.totalMaxLoss.toFixed(2) : 'N/A'
      };
    });

    res.json({
      success: true,
      symbol,
      testResults: results,
      contractSpec: positionSizingService.getContractSpec(symbol)
    });

  } catch (error) {
    logger.error(`Failed to run position sizing tests: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;