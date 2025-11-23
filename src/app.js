// Load environment variables FIRST before any other imports
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

// Disable socket.io/engine.io debug logging and HTTP logging
process.env.DEBUG = '';
process.env.ENGINE_IO_ENABLE_DEBUG = 'false';
process.env.SOCKET_IO_DEBUG = 'false';

// Debug environment loading
console.log('🔧 Environment check:');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('TRADOVATE_USE_DEMO:', process.env.TRADOVATE_USE_DEMO);
console.log('TRADOVATE_DEMO_URL:', process.env.TRADOVATE_DEMO_URL);
console.log('TRADOVATE_USERNAME exists:', !!process.env.TRADOVATE_USERNAME);

// Now import everything else
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import winston from 'winston';

// Import routes
import webhookRoutes from './routes/webhook.js';
import tradingRoutes from './routes/trading.js';
import accountRoutes from './routes/account.js';
import systemRoutes, { setWebhookRelayService } from './routes/system.js';
import activityRoutes from './routes/activity.js';
import positionSizingRoutes from './routes/positionSizing.js';

// Import services
import WebhookRelayService from './services/webhookRelay.js';
import TradovateDataCollector from './services/tradovateDataCollector.js';
import database from './services/database.js';
import crashLogger from './services/crashLogger.js';
import positionMonitor from './services/positionMonitor.js';

// Initialize logger with filtered HTTP logging
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      // Filter out HTTP request logs
      if (typeof message === 'string' && message.includes('HTTP request') && message.includes('protocol')) {
        return false; // Don't log these messages
      }
      return `${timestamp} [${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      // Filter console output
      format: winston.format.printf(({ timestamp, level, message }) => {
        if (typeof message === 'string' && message.includes('HTTP request') && message.includes('protocol')) {
          return false;
        }
        return `${timestamp} [${level.toUpperCase()}]: ${message}`;
      })
    }),
    new winston.transports.File({ filename: 'logs/app.log' })
  ]
});

// Create Express app
const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production'
      ? process.env.FRONTEND_URL
      : ["http://localhost:3000", "http://localhost:3002"],
    methods: ["GET", "POST"]
  },
  // Disable socket.io request logging
  serveClient: false,
  transports: ['websocket', 'polling']
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request tracking middleware for crash analysis
app.use((req, res, next) => {
  // Track all requests for crash context (especially autotrader signals)
  crashLogger.trackRequest(req.method, req.path, req.body, req.ip);

  // Only log important endpoints to reduce noise
  if (req.path.includes('/autotrader') || req.path.includes('/api/trading') || req.method === 'POST') {
    logger.info(`${req.method} ${req.path} - ${req.ip}`);
  }

  next();
});

// Routes
app.use('/webhook', webhookRoutes);
app.use('/api/trading', tradingRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/system', systemRoutes);
app.use('/api/activity', activityRoutes);
app.use('/api/position-sizing', positionSizingRoutes);

// Legacy autotrader route - direct compatibility with C# application
// This allows /autotrader directly (not /webhook/autotrader)
app.use('/', webhookRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error(`Error: ${err.message}`);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id}`);

  // Send recent activity on connection
  try {
    const recentActivity = database.getRecentActivity(50);
    socket.emit('initial_activity', recentActivity);
  } catch (error) {
    logger.error(`Failed to send initial activity: ${error.message}`);
  }

  socket.on('disconnect', () => {
    logger.info(`Client disconnected: ${socket.id}`);
  });

  socket.on('subscribe_account', (accountId) => {
    socket.join(`account_${accountId}`);
    logger.info(`Client ${socket.id} subscribed to account ${accountId}`);
  });

  // Handle activity filter requests
  socket.on('filter_activity', (filter) => {
    try {
      let activities = database.getRecentActivity(100);
      if (filter && filter !== 'all') {
        activities = activities.filter(a => a.type === filter);
      }
      socket.emit('filtered_activity', activities);
    } catch (error) {
      logger.error(`Failed to filter activity: ${error.message}`);
    }
  });
});

// Make io available globally for other modules
global.io = io;

// Initialize Webhook Relay Service
const webhookRelay = new WebhookRelayService();

// Initialize Tradovate Data Collector
const tradovateDataCollector = new TradovateDataCollector();

// Set up webhook relay event handlers
webhookRelay.on('started', (info) => {
  logger.info(`Webhook relay started successfully: PID ${info.pid}`);
  database.logActivity('relay', `Webhook relay started (PID: ${info.pid})`, info);
  if (global.io) {
    global.io.emit('relay_started', { ...info, timestamp: new Date().toISOString() });
  }
});

webhookRelay.on('connected', () => {
  logger.info('Webhook relay connected to webhookrelay.com');
  if (global.io) {
    global.io.emit('relay_connected', { timestamp: new Date().toISOString() });
  }
});

webhookRelay.on('urlDetected', (url) => {
  logger.info(`Webhook relay URL: ${url}`);
  if (global.io) {
    global.io.emit('relay_url_detected', { url, timestamp: new Date().toISOString() });
  }
});

webhookRelay.on('exit', (info) => {
  logger.warn(`Webhook relay exited: code ${info.code}`);
  if (global.io) {
    global.io.emit('relay_exited', { ...info, timestamp: new Date().toISOString() });
  }
});

webhookRelay.on('error', (error) => {
  logger.error(`Webhook relay error: ${error.message}`);
  if (global.io) {
    global.io.emit('relay_error', { error: error.message, timestamp: new Date().toISOString() });
  }
});

webhookRelay.on('output', (data) => {
  // Forward relay output to connected clients in real-time
  if (global.io) {
    global.io.emit('relay_output', { ...data, timestamp: new Date().toISOString() });
  }
});

// Set up data collector event handlers (for real-time updates after startup)
tradovateDataCollector.on('initialized', (info) => {
  logger.info(`📊 Data collector re-initialized: ${info.accountsCount} accounts`);
  database.logActivity('tradovate', `Data collector re-initialized with ${info.accountsCount} accounts`, info);
  if (global.io) {
    global.io.emit('data_collector_initialized', { ...info, timestamp: new Date().toISOString() });
  }
});

tradovateDataCollector.on('data_updated', (data) => {
  // Forward real-time data updates to connected clients
  if (global.io) {
    global.io.to(`account_${data.accountId}`).emit('account_data_updated', data);
    global.io.emit('account_update', data);
  }
});

tradovateDataCollector.on('polling_mode_changed', (info) => {
  logger.info(`Account ${info.accountId} polling mode: ${info.oldMode || info.mode} → ${info.newMode || info.mode} (${info.reason})`);
  if (global.io) {
    global.io.to(`account_${info.accountId}`).emit('polling_mode_changed', info);
  }
});

tradovateDataCollector.on('poll_error', (error) => {
  logger.warn(`Data collector error for account ${error.accountId}: ${error.error}`);
});

tradovateDataCollector.on('rate_limit_activated', (info) => {
  logger.warn(`Rate limit protection activated for account ${info.accountId}`);
  if (global.io) {
    global.io.emit('rate_limit_warning', info);
  }
});

tradovateDataCollector.on('error', (error) => {
  logger.error(`Data collector error: ${error.message}`);
  if (global.io) {
    global.io.emit('data_collector_error', { error: error.message, timestamp: new Date().toISOString() });
  }
});

// Provide webhook relay service to system routes
setWebhookRelayService(webhookRelay);

// Make data collector available globally for routes
global.tradovateDataCollector = tradovateDataCollector;

// Global startup status
global.startupStatus = {
  isComplete: false,
  currentStep: 'Starting...',
  startTime: new Date().toISOString(),
  error: null
};

const PORT = process.env.PORT || 3000;

/**
 * Synchronous startup process to ensure everything is properly synced
 */
async function startupSequence() {
  try {
    logger.info('🔄 Starting Slingshot Backend - Synchronous Startup');
    logger.info(`🔗 Environment: ${process.env.NODE_ENV || 'development'}`);
    logger.info(`🎯 Tradovate: ${process.env.TRADOVATE_USE_DEMO === 'true' ? 'DEMO' : 'LIVE'} mode`);

    // Step 1: Initialize Database (Required for everything else)
    global.startupStatus.currentStep = 'Initializing database';
    logger.info('📦 Step 1: Initializing database...');
    database.initialize();
    logger.info('✅ Database initialized successfully');

    // Step 2: Check for crash restart
    global.startupStatus.currentStep = 'Checking crash restart';
    logger.info('🔍 Step 2: Checking for crash restart...');
    crashLogger.checkForRestart();
    logger.info('✅ Crash check completed');

    // Step 3: Initialize Tradovate connection and sync data (Critical)
    if (process.env.TRADOVATE_USERNAME && process.env.TRADOVATE_PASSWORD) {
      global.startupStatus.currentStep = 'Connecting to Tradovate';
      logger.info('🔑 Step 3: Initializing Tradovate data collector...');
      await tradovateDataCollector.initialize();
      logger.info('✅ Tradovate data collector initialized and synced');

      // Wait for initial data collection to complete
      global.startupStatus.currentStep = 'Syncing Tradovate data';
      logger.info('📊 Step 3a: Waiting for initial data sync...');
      await waitForDataSync();
      logger.info('✅ Initial Tradovate data sync completed');
    } else {
      logger.warn('⚠️ Tradovate credentials not found - skipping data collector');
    }

    // Step 4: Initialize Position Monitor (Depends on data collector)
    global.startupStatus.currentStep = 'Starting position monitor';
    if (!positionMonitor.isRunning) {
      logger.info('📊 Step 4: Starting position monitor...');
      positionMonitor.start();
      logger.info('✅ Position monitor started');
    }

    // Step 5: Initialize Webhook Relay (Can be last)
    global.startupStatus.currentStep = 'Initializing webhook relay';
    logger.info('🔗 Step 5: Initializing webhook relay...');
    await webhookRelay.initialize();
    logger.info('✅ Webhook relay initialized');

    // Step 6: Log successful startup to database
    global.startupStatus.currentStep = 'Finalizing startup';
    logger.info('📝 Step 6: Logging startup to database...');
    database.logActivity('system', 'Slingshot backend startup completed', {
      port: PORT,
      environment: process.env.NODE_ENV || 'development',
      tradovateMode: process.env.TRADOVATE_USE_DEMO === 'true' ? 'DEMO' : 'LIVE',
      startupTime: new Date().toISOString()
    });

    // Step 7: Start the HTTP server (Only after everything is ready)
    global.startupStatus.currentStep = 'Starting HTTP server';
    logger.info('🚀 Step 7: Starting HTTP server...');
    server.listen(PORT, () => {
      global.startupStatus.isComplete = true;
      global.startupStatus.currentStep = 'Ready';
      global.startupStatus.completedTime = new Date().toISOString();

      logger.info(`✅ Slingshot Backend fully initialized and listening on port ${PORT}`);
      logger.info(`📊 Dashboard available at http://localhost:${PORT}/health`);
      logger.info('🎯 System is ready to handle requests');
    });

  } catch (error) {
    global.startupStatus.error = error.message;
    global.startupStatus.currentStep = 'Failed';

    logger.error(`💥 Startup failed: ${error.message}`);
    logger.error(`Stack: ${error.stack}`);
    process.exit(1);
  }
}

/**
 * Wait for data collector to complete initial sync
 */
async function waitForDataSync(maxWaitMs = 30000) {
  const startTime = Date.now();
  const checkInterval = 1000; // Check every second

  return new Promise((resolve, reject) => {
    const checkSync = () => {
      const elapsed = Date.now() - startTime;

      if (elapsed > maxWaitMs) {
        logger.warn('⚠️ Data sync timeout - continuing anyway');
        resolve();
        return;
      }

      // Check if data collector has synced at least one account
      if (tradovateDataCollector?.dataCache?.isInitialized) {
        const stats = tradovateDataCollector.dataCache.getStats();
        if (stats?.accountsCount > 0) {
          logger.info(`📊 Data sync completed: ${stats.accountsCount} accounts synced`);
          resolve();
          return;
        }
      }

      logger.info(`⏳ Waiting for data sync... (${Math.round(elapsed/1000)}s)`);
      setTimeout(checkSync, checkInterval);
    };

    checkSync();
  });
}

// Start the synchronous startup sequence
startupSequence();

// Enhanced crash logging and error handlers
process.on('uncaughtException', (error) => {
  const crashId = crashLogger.logCrash(error, 'uncaughtException');
  logger.error(`Uncaught Exception logged as ${crashId}: ${error.message}`);

  // Give time for logs to write, then exit gracefully
  setTimeout(() => {
    logger.error('Exiting due to uncaught exception');
    process.exit(1);
  }, 1000);
});

process.on('unhandledRejection', (reason, promise) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  const crashId = crashLogger.logCrash(error, 'unhandledRejection', { promise: String(promise) });
  logger.error(`Unhandled Promise Rejection logged as ${crashId}: ${error.message}`);

  // Give time for logs to write, then exit gracefully
  setTimeout(() => {
    logger.error('Exiting due to unhandled promise rejection');
    process.exit(1);
  }, 1000);
});

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Received SIGINT. Graceful shutdown...');

  // Stop data collector first
  if (tradovateDataCollector) {
    logger.info('Stopping data collector...');
    tradovateDataCollector.stop();
  }

  // Stop webhook relay
  if (webhookRelay) {
    logger.info('Stopping webhook relay...');
    webhookRelay.dispose();
  }

  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

export default app;