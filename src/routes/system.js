import express from 'express';
import winston from 'winston';

const router = express.Router();

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [SYSTEM-API-${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

// Global reference to webhook relay service (will be set by app.js)
let webhookRelayService = null;

/**
 * Set the webhook relay service instance
 */
export function setWebhookRelayService(service) {
  webhookRelayService = service;
}

/**
 * Get system health information
 */
router.get('/health', (req, res) => {
  try {
    // Check if system is fully started up
    const startupStatus = global.startupStatus || { isComplete: false, currentStep: 'Unknown' };
    const isReady = startupStatus.isComplete && !startupStatus.error;

    const systemInfo = {
      status: isReady ? 'healthy' : (startupStatus.error ? 'failed' : 'starting'),
      startup: {
        complete: startupStatus.isComplete,
        currentStep: startupStatus.currentStep,
        startTime: startupStatus.startTime,
        completedTime: startupStatus.completedTime,
        error: startupStatus.error
      },
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      memory: {
        used: process.memoryUsage(),
        free: require('os').freemem(),
        total: require('os').totalmem()
      },
      relay: webhookRelayService ? webhookRelayService.getStatus() : { available: false },
      tradovate: global.tradovateDataCollector ? {
        initialized: global.tradovateDataCollector.isRunning,
        dataCache: global.tradovateDataCollector.dataCache?.isInitialized || false,
        stats: global.tradovateDataCollector.dataCache?.getStats() || {}
      } : { available: false }
    };

    // Return 503 if not ready yet
    const statusCode = isReady ? 200 : (startupStatus.error ? 500 : 503);
    res.status(statusCode).json(systemInfo);

  } catch (error) {
    logger.error(`System health check failed: ${error.message}`);
    res.status(500).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Get webhook relay status
 */
router.get('/relay/status', (req, res) => {
  try {
    if (!webhookRelayService) {
      return res.status(503).json({
        success: false,
        error: 'Webhook relay service not available'
      });
    }

    const status = webhookRelayService.getStatus();

    res.json({
      success: true,
      status,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error(`Failed to get relay status: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Start webhook relay
 */
router.post('/relay/start', async (req, res) => {
  try {
    if (!webhookRelayService) {
      return res.status(503).json({
        success: false,
        error: 'Webhook relay service not available'
      });
    }

    logger.info('API request to start webhook relay');

    const result = await webhookRelayService.start();

    // Emit real-time update to connected clients
    if (global.io) {
      global.io.emit('relay_status_change', {
        action: 'start',
        result,
        status: webhookRelayService.getStatus(),
        timestamp: new Date().toISOString()
      });
    }

    res.json({
      success: result.success,
      message: result.message,
      status: webhookRelayService.getStatus(),
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error(`Failed to start relay: ${error.message}`);

    if (global.io) {
      global.io.emit('relay_error', {
        action: 'start',
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Stop webhook relay
 */
router.post('/relay/stop', async (req, res) => {
  try {
    if (!webhookRelayService) {
      return res.status(503).json({
        success: false,
        error: 'Webhook relay service not available'
      });
    }

    const { force = false } = req.body;

    logger.info(`API request to stop webhook relay${force ? ' (forced)' : ''}`);

    const result = await webhookRelayService.stop(force);

    // Emit real-time update to connected clients
    if (global.io) {
      global.io.emit('relay_status_change', {
        action: 'stop',
        result,
        status: webhookRelayService.getStatus(),
        timestamp: new Date().toISOString()
      });
    }

    res.json({
      success: result.success,
      message: result.message,
      status: webhookRelayService.getStatus(),
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error(`Failed to stop relay: ${error.message}`);

    if (global.io) {
      global.io.emit('relay_error', {
        action: 'stop',
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Restart webhook relay
 */
router.post('/relay/restart', async (req, res) => {
  try {
    if (!webhookRelayService) {
      return res.status(503).json({
        success: false,
        error: 'Webhook relay service not available'
      });
    }

    logger.info('API request to restart webhook relay');

    const result = await webhookRelayService.restart();

    // Emit real-time update to connected clients
    if (global.io) {
      global.io.emit('relay_status_change', {
        action: 'restart',
        result,
        status: webhookRelayService.getStatus(),
        timestamp: new Date().toISOString()
      });
    }

    res.json({
      success: result.success,
      message: result.message,
      status: webhookRelayService.getStatus(),
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error(`Failed to restart relay: ${error.message}`);

    if (global.io) {
      global.io.emit('relay_error', {
        action: 'restart',
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get webhook relay logs
 */
router.get('/relay/logs', (req, res) => {
  try {
    if (!webhookRelayService) {
      return res.status(503).json({
        success: false,
        error: 'Webhook relay service not available'
      });
    }

    const { lines = 50 } = req.query;
    const logs = webhookRelayService.getLogs(parseInt(lines));

    res.json({
      success: true,
      logs,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error(`Failed to get relay logs: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Update webhook relay configuration
 */
router.post('/relay/config', async (req, res) => {
  try {
    if (!webhookRelayService) {
      return res.status(503).json({
        success: false,
        error: 'Webhook relay service not available'
      });
    }

    const config = req.body;

    logger.info('API request to update relay configuration');

    // Validate configuration
    if (config.relayName && typeof config.relayName !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'relayName must be a string'
      });
    }

    if (config.destination && typeof config.destination !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'destination must be a string'
      });
    }

    if (config.destination && !config.destination.startsWith('http')) {
      return res.status(400).json({
        success: false,
        error: 'destination must be a valid HTTP URL'
      });
    }

    // Check if relay is running
    const status = webhookRelayService.getStatus();
    if (status.isRunning) {
      return res.status(409).json({
        success: false,
        error: 'Cannot update configuration while relay is running. Stop the relay first.'
      });
    }

    // Update configuration
    webhookRelayService.updateConfig(config);

    // Emit real-time update to connected clients
    if (global.io) {
      global.io.emit('relay_config_updated', {
        config,
        status: webhookRelayService.getStatus(),
        timestamp: new Date().toISOString()
      });
    }

    res.json({
      success: true,
      message: 'Configuration updated successfully',
      status: webhookRelayService.getStatus(),
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error(`Failed to update relay config: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Test webhook relay command availability
 */
router.get('/relay/test', async (req, res) => {
  try {
    if (!webhookRelayService) {
      return res.status(503).json({
        success: false,
        error: 'Webhook relay service not available'
      });
    }

    logger.info('API request to test relay command');

    // This would use the checkRelayCommand method
    const isAvailable = await webhookRelayService.checkRelayCommand();

    res.json({
      success: true,
      commandAvailable: isAvailable,
      message: isAvailable ? 'Relay command is available' : 'Relay command not found',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    logger.error(`Failed to test relay command: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;