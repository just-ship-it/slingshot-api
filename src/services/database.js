import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import winston from 'winston';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [DATABASE-${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

class DatabaseService {
  constructor() {
    this.db = null;
    this.dbPath = process.env.DATABASE_PATH || './data/slingshot.db';
    this.maxActivityLogs = 1000;
    this.maxWebhookLogs = 5000;
  }

  initialize() {
    try {
      // Ensure data directory exists
      const dataDir = dirname(this.dbPath);
      if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
        logger.info(`Created data directory: ${dataDir}`);
      }

      // Open database connection
      this.db = new Database(this.dbPath);
      logger.info(`Database connected: ${this.dbPath}`);

      // Enable WAL mode for better concurrency
      this.db.pragma('journal_mode = WAL');

      // Create tables if they don't exist
      this.createTables();

      // Clean up old logs on startup
      this.cleanupOldLogs();

      return true;
    } catch (error) {
      logger.error(`Failed to initialize database: ${error.message}`);
      throw error;
    }
  }

  createTables() {
    // Webhooks table - stores all incoming webhook signals
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        action TEXT NOT NULL,
        symbol TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        price REAL,
        order_type TEXT,
        account TEXT,
        source TEXT,
        status TEXT,
        result TEXT,
        raw_data TEXT
      )
    `);

    // Activity log table - stores all system activity
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        data TEXT,
        level TEXT DEFAULT 'info'
      )
    `);

    // System status table - stores key-value pairs for system state
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS system_status (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Trade executions table - stores actual trade results
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        webhook_id INTEGER,
        order_id TEXT,
        trade_id TEXT,
        symbol TEXT NOT NULL,
        action TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        price REAL,
        status TEXT,
        account TEXT,
        error_message TEXT,
        FOREIGN KEY (webhook_id) REFERENCES webhooks (id)
      )
    `);

    // Create indexes for better query performance
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_webhooks_timestamp ON webhooks (timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity_log (timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades (timestamp DESC);
    `);

    logger.info('Database tables created/verified');
  }

  // Webhook methods
  saveWebhook(webhook) {
    const stmt = this.db.prepare(`
      INSERT INTO webhooks (action, symbol, quantity, price, order_type, account, source, status, result, raw_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      webhook.action,
      webhook.symbol,
      webhook.quantity,
      webhook.price || null,
      webhook.orderType || 'market',
      webhook.account || 'default',
      webhook.source || 'unknown',
      webhook.status || 'received',
      webhook.result ? JSON.stringify(webhook.result) : null,
      webhook.rawData ? JSON.stringify(webhook.rawData) : null
    );

    return result.lastInsertRowid;
  }

  getRecentWebhooks(limit = 50) {
    const stmt = this.db.prepare(`
      SELECT * FROM webhooks
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    return stmt.all(limit);
  }

  // Activity log methods
  logActivity(type, message, data = null, level = 'info') {
    const stmt = this.db.prepare(`
      INSERT INTO activity_log (type, message, data, level)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run(
      type,
      message,
      data ? JSON.stringify(data) : null,
      level
    );
  }

  getRecentActivity(limit = 100) {
    const stmt = this.db.prepare(`
      SELECT * FROM activity_log
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const results = stmt.all(limit);

    // Parse JSON data fields
    return results.map(row => ({
      ...row,
      data: row.data ? JSON.parse(row.data) : null
    }));
  }

  // System status methods
  setSystemStatus(key, value) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO system_status (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
    `);

    // Convert boolean to string for SQLite storage
    let storedValue;
    if (typeof value === 'boolean') {
      storedValue = value ? 'true' : 'false';
    } else if (typeof value === 'object') {
      storedValue = JSON.stringify(value);
    } else {
      storedValue = value;
    }

    stmt.run(key, storedValue);
  }

  getSystemStatus(key) {
    const stmt = this.db.prepare(`
      SELECT value FROM system_status WHERE key = ?
    `);

    const row = stmt.get(key);
    if (!row) return null;

    // Handle boolean strings
    if (row.value === 'true') return true;
    if (row.value === 'false') return false;

    // Try to parse as JSON, otherwise return as string
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  }

  getAllSystemStatus() {
    const stmt = this.db.prepare(`
      SELECT * FROM system_status ORDER BY key
    `);

    return stmt.all().map(row => ({
      ...row,
      value: this.parseValue(row.value)
    }));
  }

  // Trade methods
  saveTrade(trade) {
    const stmt = this.db.prepare(`
      INSERT INTO trades (webhook_id, order_id, trade_id, symbol, action, quantity, price, status, account, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      trade.webhookId || null,
      trade.orderId || null,
      trade.tradeId || null,
      trade.symbol,
      trade.action,
      trade.quantity,
      trade.price || null,
      trade.status || 'pending',
      trade.account || 'default',
      trade.errorMessage || null
    );

    return result.lastInsertRowid;
  }

  getRecentTrades(limit = 50) {
    const stmt = this.db.prepare(`
      SELECT * FROM trades
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    return stmt.all(limit);
  }

  // Stats methods
  getWebhookStats() {
    const totalStmt = this.db.prepare('SELECT COUNT(*) as total FROM webhooks');
    const todayStmt = this.db.prepare(`
      SELECT COUNT(*) as today FROM webhooks
      WHERE date(timestamp) = date('now')
    `);
    const bySourceStmt = this.db.prepare(`
      SELECT source, COUNT(*) as count
      FROM webhooks
      GROUP BY source
    `);
    const bySymbolStmt = this.db.prepare(`
      SELECT symbol, COUNT(*) as count
      FROM webhooks
      GROUP BY symbol
      ORDER BY count DESC
      LIMIT 10
    `);

    return {
      total: totalStmt.get().total,
      today: todayStmt.get().today,
      bySource: bySourceStmt.all(),
      topSymbols: bySymbolStmt.all()
    };
  }

  // Cleanup methods
  cleanupOldLogs() {
    // Keep only the most recent activity logs
    const activityCleanup = this.db.prepare(`
      DELETE FROM activity_log
      WHERE id NOT IN (
        SELECT id FROM activity_log
        ORDER BY timestamp DESC
        LIMIT ?
      )
    `);
    const activityResult = activityCleanup.run(this.maxActivityLogs);

    // Keep only the most recent webhook logs
    const webhookCleanup = this.db.prepare(`
      DELETE FROM webhooks
      WHERE id NOT IN (
        SELECT id FROM webhooks
        ORDER BY timestamp DESC
        LIMIT ?
      )
    `);
    const webhookResult = webhookCleanup.run(this.maxWebhookLogs);

    if (activityResult.changes > 0 || webhookResult.changes > 0) {
      logger.info(`Cleaned up old logs: ${activityResult.changes} activity, ${webhookResult.changes} webhooks`);
    }
  }

  // Helper methods
  parseValue(value) {
    // Handle boolean strings
    if (value === 'true') return true;
    if (value === 'false') return false;

    // Try to parse as JSON
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  // Close database connection
  close() {
    if (this.db) {
      this.db.close();
      logger.info('Database connection closed');
    }
  }
}

// Create singleton instance
const database = new DatabaseService();

export default database;