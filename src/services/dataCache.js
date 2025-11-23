import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import winston from 'winston';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [DATA-CACHE-${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

class DataCache {
  constructor(dbPath = null) {
    this.dbPath = dbPath || path.resolve(process.cwd(), 'data', 'tradovate_cache.db');
    this.db = null;
    this.isInitialized = false;
  }

  /**
   * Check if cache is ready for operations
   */
  _checkInitialized(methodName = 'operation') {
    if (!this.isInitialized) {
      logger.debug(`DataCache not initialized - skipping ${methodName}`);
      return false;
    }
    return true;
  }

  /**
   * Initialize the database and create tables
   */
  initialize() {
    try {
      // Ensure the data directory exists
      const dataDir = path.dirname(this.dbPath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
        logger.info(`Created data directory: ${dataDir}`);
      }

      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');

      this.createTables();
      this.isInitialized = true;

      logger.info(`Data cache initialized at ${this.dbPath}`);
    } catch (error) {
      logger.error(`Failed to initialize data cache: ${error.message}`);
      this.isInitialized = false;
      throw error;
    }
  }

  /**
   * Create all required tables
   */
  createTables() {
    // Accounts cache
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts_cache (
        account_id TEXT PRIMARY KEY,
        account_data TEXT NOT NULL,
        last_updated INTEGER NOT NULL,
        polling_mode TEXT DEFAULT 'IDLE'
      )
    `);

    // Account balances cache
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS account_balances (
        account_id TEXT PRIMARY KEY,
        balance_data TEXT NOT NULL,
        last_updated INTEGER NOT NULL,
        FOREIGN KEY (account_id) REFERENCES accounts_cache (account_id)
      )
    `);

    // Positions cache
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS positions_cache (
        account_id TEXT PRIMARY KEY,
        positions_data TEXT NOT NULL,
        last_updated INTEGER NOT NULL,
        open_positions_count INTEGER DEFAULT 0,
        FOREIGN KEY (account_id) REFERENCES accounts_cache (account_id)
      )
    `);

    // Orders cache
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders_cache (
        account_id TEXT PRIMARY KEY,
        orders_data TEXT NOT NULL,
        last_updated INTEGER NOT NULL,
        working_orders_count INTEGER DEFAULT 0,
        FOREIGN KEY (account_id) REFERENCES accounts_cache (account_id)
      )
    `);

    // Polling state tracking
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS polling_state (
        account_id TEXT PRIMARY KEY,
        current_mode TEXT NOT NULL DEFAULT 'IDLE',
        last_mode_change INTEGER NOT NULL DEFAULT 0,
        mode_change_reason TEXT,
        last_poll_timestamp INTEGER DEFAULT 0,
        consecutive_errors INTEGER DEFAULT 0,
        FOREIGN KEY (account_id) REFERENCES accounts_cache (account_id)
      )
    `);

    // Data update log for debugging
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS update_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT,
        data_type TEXT NOT NULL,
        update_timestamp INTEGER NOT NULL,
        success INTEGER NOT NULL,
        error_message TEXT,
        response_time_ms INTEGER
      )
    `);

    // Create index separately
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_account_timestamp
      ON update_log (account_id, update_timestamp)
    `);

    logger.info('Database tables created successfully');
  }

  /**
   * Cache account data
   */
  cacheAccountData(accountId, accountData) {
    if (!this._checkInitialized('cacheAccountData')) return;

    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO accounts_cache (account_id, account_data, last_updated)
        VALUES (?, ?, ?)
      `);

      stmt.run(accountId, JSON.stringify(accountData), Date.now());
      this.logUpdate(accountId, 'account_data', true);
    } catch (error) {
      logger.error(`Failed to cache account data for ${accountId}: ${error.message}`);
    }
  }

  /**
   * Cache account balance data
   */
  cacheAccountBalance(accountId, balanceData) {
    if (!this._checkInitialized('cacheAccountBalance')) return;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO account_balances (account_id, balance_data, last_updated)
      VALUES (?, ?, ?)
    `);

    stmt.run(accountId, JSON.stringify(balanceData), Date.now());
    this.logUpdate(accountId, 'balance', true);
  }

  /**
   * Cache positions data
   */
  cachePositions(accountId, positionsData) {
    if (!this._checkInitialized('cachePositions')) return;

    const openPositions = positionsData.filter(p => p.netPos !== 0).length;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO positions_cache (account_id, positions_data, last_updated, open_positions_count)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run(accountId, JSON.stringify(positionsData), Date.now(), openPositions);
    this.logUpdate(accountId, 'positions', true);
  }

  /**
   * Cache orders data
   */
  cacheOrders(accountId, ordersData) {
    if (!this._checkInitialized('cacheOrders')) return;

    // Handle both raw API data (ordStatus) and enriched data (status)
    const workingOrders = ordersData.filter(o => {
      const status = o.status || o.ordStatus;
      return status === 'Working';
    }).length;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO orders_cache (account_id, orders_data, last_updated, working_orders_count)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run(accountId, JSON.stringify(ordersData), Date.now(), workingOrders);
    this.logUpdate(accountId, 'orders', true);
  }

  /**
   * Get cached account data
   */
  getCachedAccountData(accountId) {
    if (!this._checkInitialized('getCachedAccountData')) return null;

    const stmt = this.db.prepare('SELECT * FROM accounts_cache WHERE account_id = ?');
    const result = stmt.get(accountId);

    if (result) {
      return {
        data: JSON.parse(result.account_data),
        lastUpdated: result.last_updated,
        age: Date.now() - result.last_updated
      };
    }

    return null;
  }

  /**
   * Get cached account balance
   */
  getCachedAccountBalance(accountId) {
    if (!this._checkInitialized('getCachedAccountBalance')) return null;

    const stmt = this.db.prepare('SELECT * FROM account_balances WHERE account_id = ?');
    const result = stmt.get(accountId);

    if (result) {
      return {
        data: JSON.parse(result.balance_data),
        lastUpdated: result.last_updated,
        age: Date.now() - result.last_updated
      };
    }

    return null;
  }

  /**
   * Get cached positions
   */
  getCachedPositions(accountId) {
    if (!this._checkInitialized('getCachedPositions')) return null;

    const stmt = this.db.prepare('SELECT * FROM positions_cache WHERE account_id = ?');
    const result = stmt.get(accountId);

    if (result) {
      return {
        data: JSON.parse(result.positions_data),
        lastUpdated: result.last_updated,
        age: Date.now() - result.last_updated,
        openPositionsCount: result.open_positions_count
      };
    }

    return null;
  }

  /**
   * Get cached orders
   */
  getCachedOrders(accountId) {
    if (!this._checkInitialized('getCachedOrders')) return null;

    const stmt = this.db.prepare('SELECT * FROM orders_cache WHERE account_id = ?');
    const result = stmt.get(accountId);

    if (result) {
      return {
        data: JSON.parse(result.orders_data),
        lastUpdated: result.last_updated,
        age: Date.now() - result.last_updated,
        workingOrdersCount: result.working_orders_count
      };
    }

    return null;
  }

  /**
   * Update polling state
   */
  updatePollingState(accountId, mode, reason = null) {
    if (!this._checkInitialized('updatePollingState')) return;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO polling_state
      (account_id, current_mode, last_mode_change, mode_change_reason, last_poll_timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(accountId, mode, Date.now(), reason, Date.now());
    logger.info(`Polling mode changed to ${mode} for account ${accountId}: ${reason}`);
  }

  /**
   * Get current polling state
   */
  getPollingState(accountId) {
    if (!this._checkInitialized('getPollingState')) return null;

    const stmt = this.db.prepare('SELECT * FROM polling_state WHERE account_id = ?');
    return stmt.get(accountId);
  }

  /**
   * Determine optimal polling mode based on cached data
   */
  determinePollingMode(accountId) {
    const positions = this.getCachedPositions(accountId);
    const orders = this.getCachedOrders(accountId);

    const openPositions = positions?.openPositionsCount || 0;
    const workingOrders = orders?.workingOrdersCount || 0;

    let mode = 'IDLE';
    let reason = 'No open positions or working orders';

    if (openPositions === 0 && workingOrders === 0) {
      mode = 'IDLE';
      reason = 'No trading activity';
    } else if (openPositions > 2 || workingOrders > 3) {
      mode = 'CRITICAL';
      reason = `High activity: ${openPositions} positions, ${workingOrders} orders`;
    } else {
      mode = 'ACTIVE';
      reason = `Active trading: ${openPositions} positions, ${workingOrders} orders`;
    }

    return { mode, reason, openPositions, workingOrders };
  }

  /**
   * Get complete account snapshot from cache
   */
  getAccountSnapshot(accountId) {
    const account = this.getCachedAccountData(accountId);
    const balance = this.getCachedAccountBalance(accountId);
    const positions = this.getCachedPositions(accountId);
    const orders = this.getCachedOrders(accountId);
    const pollingState = this.getPollingState(accountId);

    return {
      account: account?.data,
      balance: balance?.data,
      positions: positions?.data,
      orders: orders?.data,
      pollingState,
      lastUpdated: {
        account: account?.lastUpdated,
        balance: balance?.lastUpdated,
        positions: positions?.lastUpdated,
        orders: orders?.lastUpdated
      },
      dataAge: {
        account: account?.age,
        balance: balance?.age,
        positions: positions?.age,
        orders: orders?.age
      }
    };
  }

  /**
   * Log update for debugging
   */
  logUpdate(accountId, dataType, success, errorMessage = null, responseTime = null) {
    if (!this.isInitialized) return;

    try {
      const stmt = this.db.prepare(`
        INSERT INTO update_log (account_id, data_type, update_timestamp, success, error_message, response_time_ms)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      stmt.run(accountId, dataType, Date.now(), success ? 1 : 0, errorMessage, responseTime);
    } catch (error) {
      logger.error(`Failed to log update: ${error.message}`);
    }
  }

  /**
   * Get recent update logs
   */
  getRecentLogs(limit = 100) {
    if (!this.isInitialized) return [];

    const stmt = this.db.prepare(`
      SELECT * FROM update_log
      ORDER BY update_timestamp DESC
      LIMIT ?
    `);

    return stmt.all(limit);
  }

  /**
   * Clean up old data
   */
  cleanup(maxAgeMs = 24 * 60 * 60 * 1000) { // 24 hours default
    if (!this.isInitialized) return;

    const cutoff = Date.now() - maxAgeMs;

    this.db.prepare('DELETE FROM update_log WHERE update_timestamp < ?').run(cutoff);

    logger.info('Cache cleanup completed');
  }

  /**
   * Get cache statistics
   */
  getStats() {
    if (!this.isInitialized) return null;

    const accountsCount = this.db.prepare('SELECT COUNT(*) as count FROM accounts_cache').get().count;
    const logsCount = this.db.prepare('SELECT COUNT(*) as count FROM update_log').get().count;

    return {
      accountsCount,
      logsCount,
      dbPath: this.dbPath,
      isInitialized: this.isInitialized
    };
  }

  /**
   * Close the database connection
   */
  close() {
    if (this.db) {
      this.db.close();
      this.isInitialized = false;
      logger.info('Database connection closed');
    }
  }
}

export default DataCache;