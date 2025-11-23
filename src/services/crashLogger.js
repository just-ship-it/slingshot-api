import fs from 'fs';
import path from 'path';
import winston from 'winston';

class CrashLogger {
  constructor() {
    this.crashLogPath = path.join(process.cwd(), 'logs', 'crashes.log');
    this.requestHistory = [];
    this.maxHistorySize = 50;

    // Ensure crash logs directory exists
    const logsDir = path.dirname(this.crashLogPath);
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    // Create dedicated crash logger
    this.crashLogger = winston.createLogger({
      level: 'error',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, message }) => {
          return `${timestamp} [CRASH]: ${message}`;
        })
      ),
      transports: [
        new winston.transports.File({
          filename: this.crashLogPath,
          handleExceptions: true,
          handleRejections: true
        }),
        new winston.transports.Console()
      ]
    });
  }

  // Track recent requests/signals
  trackRequest(method, url, body = null, source = 'unknown') {
    const request = {
      timestamp: new Date().toISOString(),
      method,
      url,
      body: body ? JSON.stringify(body, null, 2) : null,
      source,
      memoryUsage: process.memoryUsage(),
      uptime: process.uptime()
    };

    this.requestHistory.push(request);

    // Keep only recent history
    if (this.requestHistory.length > this.maxHistorySize) {
      this.requestHistory = this.requestHistory.slice(-this.maxHistorySize);
    }
  }

  // Get system state
  getSystemState() {
    return {
      timestamp: new Date().toISOString(),
      processId: process.pid,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      platform: process.platform,
      nodeVersion: process.version,
      environment: {
        NODE_ENV: process.env.NODE_ENV,
        TRADOVATE_USE_DEMO: process.env.TRADOVATE_USE_DEMO,
        hasCredentials: !!(process.env.TRADOVATE_USERNAME && process.env.TRADOVATE_PASSWORD)
      },
      tradingStatus: global.tradovateDataCollector ? global.tradovateDataCollector.getStatus() : null
    };
  }

  // Log crash with full context
  logCrash(error, type = 'uncaughtException', extraContext = {}) {
    const crashId = `crash_${Date.now()}_${process.pid}`;
    const systemState = this.getSystemState();

    const crashReport = {
      crashId,
      type,
      timestamp: new Date().toISOString(),
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
        code: error.code || null
      },
      systemState,
      recentRequests: this.requestHistory.slice(-10), // Last 10 requests
      extraContext,
      memoryHeap: {
        used: Math.round(systemState.memory.heapUsed / 1024 / 1024) + ' MB',
        total: Math.round(systemState.memory.heapTotal / 1024 / 1024) + ' MB',
        external: Math.round(systemState.memory.external / 1024 / 1024) + ' MB'
      }
    };

    // Log the crash
    this.crashLogger.error('='.repeat(80));
    this.crashLogger.error(`CRASH DETECTED: ${crashId}`);
    this.crashLogger.error('='.repeat(80));
    this.crashLogger.error(JSON.stringify(crashReport, null, 2));
    this.crashLogger.error('='.repeat(80));

    // Also save to separate crash dump file
    const crashDumpPath = path.join(process.cwd(), 'logs', `${crashId}.json`);
    try {
      fs.writeFileSync(crashDumpPath, JSON.stringify(crashReport, null, 2));
      this.crashLogger.error(`Crash dump saved to: ${crashDumpPath}`);
    } catch (writeError) {
      this.crashLogger.error(`Failed to write crash dump: ${writeError.message}`);
    }

    return crashId;
  }

  // Check for restart (called on startup)
  checkForRestart() {
    const restartMarker = path.join(process.cwd(), 'logs', 'restart_marker.json');

    if (fs.existsSync(restartMarker)) {
      try {
        const lastRun = JSON.parse(fs.readFileSync(restartMarker, 'utf8'));
        const timeDiff = Date.now() - lastRun.timestamp;

        if (timeDiff < 60000) { // Less than 1 minute = likely restart after crash
          this.crashLogger.error('='.repeat(50));
          this.crashLogger.error('PROCESS RESTART DETECTED');
          this.crashLogger.error(`Last run ended: ${new Date(lastRun.timestamp).toISOString()}`);
          this.crashLogger.error(`Restart after: ${Math.round(timeDiff / 1000)} seconds`);
          this.crashLogger.error('='.repeat(50));
        }
      } catch (error) {
        this.crashLogger.error(`Failed to read restart marker: ${error.message}`);
      }
    }

    // Update restart marker
    try {
      fs.writeFileSync(restartMarker, JSON.stringify({
        timestamp: Date.now(),
        processId: process.pid,
        startTime: new Date().toISOString()
      }));
    } catch (error) {
      this.crashLogger.error(`Failed to write restart marker: ${error.message}`);
    }
  }

  // Get recent crash history
  getRecentCrashes(limit = 5) {
    try {
      if (!fs.existsSync(this.crashLogPath)) {
        return [];
      }

      const logContent = fs.readFileSync(this.crashLogPath, 'utf8');
      const crashes = [];
      const lines = logContent.split('\n');

      let currentCrash = null;
      for (const line of lines) {
        if (line.includes('CRASH DETECTED:')) {
          if (currentCrash) crashes.push(currentCrash);
          currentCrash = { timestamp: line.split(' ')[0], details: line };
        } else if (currentCrash && line.trim()) {
          currentCrash.details += '\n' + line;
        }
      }

      if (currentCrash) crashes.push(currentCrash);

      return crashes.slice(-limit).reverse(); // Most recent first
    } catch (error) {
      this.crashLogger.error(`Failed to read crash history: ${error.message}`);
      return [];
    }
  }
}

// Create singleton instance
const crashLogger = new CrashLogger();

export default crashLogger;