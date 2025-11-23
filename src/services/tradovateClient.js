import axios from 'axios';
import WebSocket from 'ws';
import winston from 'winston';
import RateLimiter from './rateLimiter.js';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [TRADOVATE-${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

class TradovateClient {
  constructor() {
    this.baseUrl = process.env.TRADOVATE_USE_DEMO === 'true'
      ? process.env.TRADOVATE_DEMO_URL
      : process.env.TRADOVATE_LIVE_URL;

    this.wsUrl = process.env.TRADOVATE_USE_DEMO === 'true'
      ? process.env.TRADOVATE_WS_DEMO
      : process.env.TRADOVATE_WS_LIVE;

    this.accessToken = null;
    this.mdAccessToken = null;
    this.websocket = null;
    this.isConnected = false;

    // Initialize rate limiter
    this.rateLimiter = new RateLimiter({
      minRequestInterval: 1500, // 1.5 seconds between requests (conservative)
      defaultRetryDelay: 5000,
      maxRetryAttempts: 3
    });

    // Create axios instance with base configuration
    this.api = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'Content-Type': 'application/json'
      }
    });

    // Add request interceptor to include auth token
    this.api.interceptors.request.use((config) => {
      if (this.accessToken) {
        config.headers.Authorization = `Bearer ${this.accessToken}`;
      }
      return config;
    });

    // Add response interceptor for error handling
    this.api.interceptors.response.use(
      (response) => response,
      (error) => {
        logger.error(`API Error: ${error.response?.status} - ${error.response?.data?.errorText || error.message}`);
        return Promise.reject(error);
      }
    );

    // Contract resolution cache
    this.contractCache = new Map();
    this.cacheTimestamp = null;
    this.cacheExpiryHours = 24; // Cache for 24 hours
  }

  /**
   * Rate-limited request wrapper
   */
  async makeRateLimitedRequest(requestFn, requestId = null) {
    return this.rateLimiter.queueRequest(requestFn, requestId);
  }

  /**
   * Get rate limiter statistics
   */
  getRateLimiterStats() {
    return this.rateLimiter.getStats();
  }

  /**
   * Check if API is healthy (no rate limiting issues)
   */
  isApiHealthy() {
    return this.rateLimiter.isHealthy();
  }

  /**
   * Authenticate with Tradovate API
   */
  async authenticate() {
    try {
      logger.info(`Authenticating with Tradovate ${process.env.TRADOVATE_USE_DEMO === 'true' ? 'DEMO' : 'LIVE'}`);

      if (!this.baseUrl) {
        throw new Error('Invalid Tradovate API URL - check environment configuration');
      }

      // Build authentication request (Tradovate expects all params in one request)
      if (!process.env.TRADOVATE_USERNAME || !process.env.TRADOVATE_PASSWORD) {
        throw new Error('Missing Tradovate username/password in environment variables');
      }

      const authRequest = {
        name: process.env.TRADOVATE_USERNAME,
        password: process.env.TRADOVATE_PASSWORD,
        appId: process.env.TRADOVATE_APP_ID || 'Ereptor',
        appVersion: process.env.TRADOVATE_APP_VERSION || '0.0.1',
        deviceId: process.env.TRADOVATE_DEVICE_ID || '8e5a7004-f96c-10a0-260f-252bd531d78a'
      };

      // Add CID and Secret if available (as per Tradovate example)
      if (process.env.TRADOVATE_CID && process.env.TRADOVATE_SECRET) {
        authRequest.cid = process.env.TRADOVATE_CID;
        authRequest.sec = process.env.TRADOVATE_SECRET;
        logger.info('Authenticating with username/password + CID/Secret...');
      } else {
        logger.info('Authenticating with username/password only...');
      }
      const response = await this.api.post('/auth/accesstokenrequest', authRequest);

      // Handle CAPTCHA challenge if present
      if (response.data['p-ticket']) {
        const ticket = response.data['p-ticket'];
        const waitTime = response.data['p-time'];

        logger.warn(`CAPTCHA challenge received. Waiting ${waitTime} seconds...`);
        await new Promise(resolve => setTimeout(resolve, waitTime * 1000));

        // Retry with ticket
        authRequest.p_ticket = ticket;
        const retryResponse = await this.api.post('/auth/accesstokenrequest', authRequest);

        if (!retryResponse.data.accessToken) {
          throw new Error('CAPTCHA challenge failed - app registration required');
        }

        this.accessToken = retryResponse.data.accessToken;
        this.mdAccessToken = retryResponse.data.mdAccessToken;
      } else if (response.data.accessToken) {
        this.accessToken = response.data.accessToken;
        this.mdAccessToken = response.data.mdAccessToken;
      } else {
        throw new Error(response.data.errorText || 'Authentication failed');
      }

      logger.info('✅ Successfully authenticated with Tradovate');
      return true;
    } catch (error) {
      logger.error(`❌ Authentication failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get account information
   */
  async getAccounts() {
    try {
      if (!this.accessToken) {
        await this.authenticate();
      }

      const response = await this.makeRateLimitedRequest(
        () => this.api.get('/account/list'),
        'get-accounts'
      );
      logger.info(`Retrieved ${response.data.length} accounts`);
      return response.data;
    } catch (error) {
      logger.error(`Failed to get accounts: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get account positions
   */
  async getPositions(accountId) {
    try {
      const response = await this.makeRateLimitedRequest(
        () => this.api.get(`/position/list?accountId=${accountId}`),
        `get-positions-${accountId}`
      );
      return response.data;
    } catch (error) {
      logger.error(`Failed to get positions: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get contract details by contract ID
   */
  async getContractDetails(contractId) {
    try {
      const response = await this.makeRateLimitedRequest(
        () => this.api.get(`/contract/item?id=${contractId}`),
        `get-contract-details-${contractId}`
      );

      logger.info(`📋 Contract ${contractId} details: ${JSON.stringify(response.data, null, 2)}`);
      return response.data;
    } catch (error) {
      logger.warn(`Failed to get contract details for ${contractId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get detailed order information by order ID
   */
  async getOrderDetails(orderId) {
    try {
      const response = await this.makeRateLimitedRequest(
        () => this.api.get(`/order/item?id=${orderId}`),
        `get-order-details-${orderId}`
      );

      logger.info(`📋 Order ${orderId} details: ${JSON.stringify(response.data, null, 2)}`);

      // Get order version details using the correct endpoint that filters by order ID
      const orderVersionResponse = await this.makeRateLimitedRequest(
        () => this.api.get(`/orderVersion/deps?masterid=${orderId}`),
        `get-order-version-${orderId}`
      );

      if (orderVersionResponse.data && orderVersionResponse.data.length > 0) {
        // The deps endpoint returns only the version for this specific order
        const orderVersion = orderVersionResponse.data[0];
        logger.info(`📋 Order ${orderId} version details: ${JSON.stringify(orderVersion, null, 2)}`);

        // Merge the detailed version data with basic order data
        const enrichedOrder = {
          ...response.data,
          ...orderVersion,
          // Keep original fields that might be overwritten
          id: response.data.id,
          ordStatus: response.data.ordStatus
        };

        return enrichedOrder;
      }

      return response.data;
    } catch (error) {
      logger.warn(`Failed to get order details for ${orderId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get account orders with progressive enrichment
   */
  async getOrders(accountId) {
    try {
      // Step 1: Get basic order data from API
      const response = await this.makeRateLimitedRequest(
        () => this.api.get(`/order/list?accountId=${accountId}`),
        `get-orders-${accountId}`
      );

      const rawOrders = response.data;
      logger.info(`📋 Retrieved ${rawOrders.length} raw orders from Tradovate API`);

      // Debug: Log the first raw order to see actual field names
      if (rawOrders.length > 0) {
        logger.info(`🔬 First raw order fields: ${JSON.stringify(rawOrders[0], null, 2)}`);
        logger.info(`🔬 Available fields: ${Object.keys(rawOrders[0]).join(', ')}`);

        // Look for time-related fields
        const timeFields = Object.keys(rawOrders[0]).filter(key =>
          key.toLowerCase().includes('time') ||
          key.toLowerCase().includes('date') ||
          key.toLowerCase().includes('created') ||
          key.toLowerCase().includes('updated') ||
          key.toLowerCase().includes('filled') ||
          key.toLowerCase().includes('submitted')
        );
        logger.info(`🕐 Time-related fields found: ${timeFields.join(', ')}`);
      }

      // Step 2: Apply basic field standardization and cache immediately
      const basicOrders = rawOrders.map(order => ({
        ...order,
        // Standardize field names for frontend compatibility
        status: order.ordStatus || order.status,
        limitPrice: order.price || order.limitPrice,
        qty: order.orderQty,
        // Use contractName as symbol (most reliable for display)
        symbol: order.contractName || order.contractDesc || order.symbol || 'Unknown'
      }));

      // Step 3: Cache basic orders only if we don't already have enriched data
      if (global.tradovateDataCollector?.dataCache?.isInitialized) {
        // Cache account data if it doesn't exist (to satisfy foreign key constraint)
        const existingAccount = global.tradovateDataCollector.dataCache.getCachedAccountData(accountId);
        if (!existingAccount) {
          logger.info(`🔑 Caching account ${accountId} to satisfy foreign key constraint`);
          global.tradovateDataCollector.dataCache.cacheAccountData(accountId, { id: accountId, name: `Account ${accountId}` });
        }

        // Check if we already have enriched data in cache
        const existingOrders = global.tradovateDataCollector.dataCache.getCachedOrders(accountId);
        const hasEnrichedData = existingOrders?.data?.some(o => o.limitPrice && o.orderType);

        if (!hasEnrichedData) {
          global.tradovateDataCollector.dataCache.cacheOrders(accountId, basicOrders);
          logger.info(`💾 Cached ${basicOrders.length} basic orders (no enriched data exists)`);
        } else {
          logger.info(`🔒 Skipping basic cache - enriched orders already exist`);
        }
      }

      // Step 4: Enrich in background and update cache
      this.enrichOrdersInBackground(accountId, basicOrders);

      return basicOrders;
    } catch (error) {
      logger.error(`Failed to get orders: ${error.message}`);
      throw error;
    }
  }

  /**
   * Enrich orders in background and update cache
   */
  async enrichOrdersInBackground(accountId, basicOrders) {
    try {
      logger.info(`🔄 Starting background enrichment for ${basicOrders.length} orders`);

      const enrichedOrders = [];

      for (const order of basicOrders) {
        let enrichedOrder = { ...order };

        // Get full order details using orderVersion/deps API (this has the correct prices!)
        try {
          logger.info(`🔬 Getting order version details for order ${order.id}...`);
          const orderVersionResponse = await this.makeRateLimitedRequest(
            () => this.api.get(`/orderVersion/deps?masterid=${order.id}`),
            `get-order-version-${order.id}`
          );

          const orderVersions = orderVersionResponse.data;
          logger.info(`🔬 Order versions for ${order.id}:`, orderVersions);

          // Find the version that matches this order ID
          const matchingVersion = orderVersions.find(v => v.orderId === order.id);
          if (matchingVersion) {
            logger.info(`🔬 Found matching version for order ${order.id}:`, matchingVersion);

            // Look for time-related fields in version data
            const versionTimeFields = Object.keys(matchingVersion).filter(key =>
              key.toLowerCase().includes('time') ||
              key.toLowerCase().includes('date') ||
              key.toLowerCase().includes('created') ||
              key.toLowerCase().includes('updated') ||
              key.toLowerCase().includes('filled') ||
              key.toLowerCase().includes('submitted')
            );
            logger.info(`🕐 Version time fields: ${versionTimeFields.join(', ')}`);

            // Extract price from the version (this is where the correct prices are!)
            const versionPrice = matchingVersion.price || matchingVersion.limitPrice || matchingVersion.stopPrice;

            // Update the enriched order with version data
            enrichedOrder = {
              ...enrichedOrder,
              // Price information from order version (CRITICAL!)
              limitPrice: versionPrice,
              price: versionPrice,
              // Order type from version
              orderType: matchingVersion.orderType || order.orderType || 'Market',
              // Quantity (just the number, not "Buy 1" or "Sell 1")
              qty: matchingVersion.orderQty || order.orderQty,
              orderQty: matchingVersion.orderQty || order.orderQty,
              // Keep the action separate (Buy/Sell)
              action: order.action || matchingVersion.action
            };

            logger.info(`🔬 Enriched order ${order.id} with version data:`);
            logger.info(`   - Price: ${versionPrice}`);
            logger.info(`   - Type: ${enrichedOrder.orderType}`);
            logger.info(`   - Qty: ${enrichedOrder.qty}`);
            logger.info(`   - Action: ${enrichedOrder.action}`);
          } else {
            logger.warn(`No matching version found for order ${order.id}`);
          }
        } catch (error) {
          logger.warn(`Failed to get order version for order ${order.id}: ${error.message}`);
        }

        // Get contract details for symbol information
        if (order.contractId) {
          try {
            const contractInfo = await this.getContractDetails(order.contractId);
            enrichedOrder = {
              ...enrichedOrder,
              // Use contract name as symbol for frontend display
              symbol: contractInfo?.name || contractInfo?.masterSymbol || enrichedOrder.symbol,
              contractName: contractInfo?.name || enrichedOrder.contractName,
              contractDesc: contractInfo?.name || enrichedOrder.contractDesc
            };
          } catch (error) {
            logger.warn(`Failed to get contract for order ${order.id}: ${error.message}`);
          }
        }

        enrichedOrders.push(enrichedOrder);
      }

      // Update cache with enriched data
      if (global.tradovateDataCollector?.dataCache?.isInitialized) {
        // Ensure account exists (should already exist from initial cache, but double-check)
        const existingAccount = global.tradovateDataCollector.dataCache.getCachedAccountData(accountId);
        if (!existingAccount) {
          logger.info(`🔑 Re-caching account ${accountId} for enriched data`);
          global.tradovateDataCollector.dataCache.cacheAccountData(accountId, { id: accountId, name: `Account ${accountId}` });
        }

        global.tradovateDataCollector.dataCache.cacheOrders(accountId, enrichedOrders);
        logger.info(`✨ Updated cache with ${enrichedOrders.length} enriched orders`);
      }

      // Emit WebSocket update to frontend
      if (global.io) {
        global.io.to(`account_${accountId}`).emit('account_data_updated', {
          dataType: 'orders',
          accountId,
          data: enrichedOrders,
          timestamp: new Date().toISOString()
        });
        logger.info(`📡 Sent enriched orders update via WebSocket`);
      }

    } catch (error) {
      logger.error(`Background enrichment failed: ${error.message}`);
    }
  }

  /**
   * Place a trade order
   */
  async placeOrder(orderData) {
    try {
      logger.info(`Placing order: ${orderData.action} ${orderData.orderQty} ${orderData.symbol}`);
      logger.info(`📤 Order payload: ${JSON.stringify(orderData, null, 2)}`);

      const response = await this.api.post('/order/placeorder', orderData);

      logger.info(`📥 Tradovate API response: ${JSON.stringify(response.data, null, 2)}`);

      if (response.data && response.data.orderId) {
        logger.info(`✅ Order placed successfully. ID: ${response.data.orderId}`);

        // Emit real-time update to connected clients
        if (global.io) {
          global.io.to(`account_${orderData.accountId}`).emit('order_placed', {
            orderId: response.data.orderId,
            ...orderData,
            timestamp: new Date().toISOString()
          });
        }

        return response.data;
      } else {
        // Order was not actually placed successfully
        const errorMsg = response.data?.errorText || 'Order placement failed - no orderId returned';
        logger.error(`❌ Order placement failed: ${errorMsg}`);
        logger.error(`❌ Full response: ${JSON.stringify(response.data, null, 2)}`);
        throw new Error(errorMsg);
      }

    } catch (error) {
      logger.error(`Failed to place order: ${error.message}`);
      if (error.response?.data) {
        logger.error(`API Error Response: ${JSON.stringify(error.response.data, null, 2)}`);
      }
      throw error;
    }
  }

  /**
   * Place a bracket order (One-Sends-Other) with stop loss and take profit
   */
  async placeBracketOrder(orderData) {
    try {
      logger.info(`Placing bracket order: ${orderData.action} ${orderData.orderQty} ${orderData.symbol}`);
      logger.info(`📤 Bracket order payload: ${JSON.stringify(orderData, null, 2)}`);

      const response = await this.api.post('/order/placeOSO', orderData);

      logger.info(`📥 Tradovate OSO API response: ${JSON.stringify(response.data, null, 2)}`);

      if (response.data && response.data.orderId) {
        logger.info(`✅ Bracket order placed successfully. Primary ID: ${response.data.orderId}`);

        // Log bracket order IDs if available
        if (response.data.bracket1OrderId) {
          logger.info(`📊 Stop loss order ID: ${response.data.bracket1OrderId}`);
        }
        if (response.data.bracket2OrderId) {
          logger.info(`📊 Take profit order ID: ${response.data.bracket2OrderId}`);
        }

        // Emit real-time update to connected clients
        if (global.io) {
          global.io.to(`account_${orderData.accountId}`).emit('bracket_order_placed', {
            primaryOrderId: response.data.orderId,
            stopOrderId: response.data.bracket1OrderId,
            profitOrderId: response.data.bracket2OrderId,
            ...orderData,
            timestamp: new Date().toISOString()
          });
        }

        return response.data;
      } else {
        // Bracket order was not placed successfully
        const errorMsg = response.data?.errorText || 'Bracket order placement failed - no orderId returned';
        logger.error(`❌ Bracket order placement failed: ${errorMsg}`);
        logger.error(`❌ Full response: ${JSON.stringify(response.data, null, 2)}`);
        throw new Error(errorMsg);
      }

    } catch (error) {
      logger.error(`Failed to place bracket order: ${error.message}`);
      if (error.response?.data) {
        logger.error(`API Error Response: ${JSON.stringify(error.response.data, null, 2)}`);
      }
      throw error;
    }
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId) {
    try {
      logger.info(`Cancelling order: ${orderId}`);

      const response = await this.api.post('/order/cancelorder', { orderId });

      logger.info(`✅ Order cancelled successfully: ${orderId}`);
      return response.data;
    } catch (error) {
      logger.error(`Failed to cancel order: ${error.message}`);
      throw error;
    }
  }

  /**
   * Modify an existing order (for trailing stop activation)
   */
  async modifyOrder(orderModification) {
    try {
      logger.info(`🔧 Modifying order ${orderModification.orderId}`);
      logger.info(`📤 Modification payload: ${JSON.stringify(orderModification, null, 2)}`);

      const response = await this.api.post('/order/modifyorder', orderModification);

      logger.info(`📥 Order modification response: ${JSON.stringify(response.data, null, 2)}`);

      if (response.data && (response.data.orderId || response.data.success)) {
        logger.info(`✅ Order modified successfully: ${orderModification.orderId}`);
        return response.data;
      } else {
        const errorMsg = response.data?.errorText || 'Order modification failed';
        logger.error(`❌ Order modification failed: ${errorMsg}`);
        throw new Error(errorMsg);
      }

    } catch (error) {
      logger.error(`Failed to modify order: ${error.message}`);
      if (error.response?.data) {
        logger.error(`API Error Response: ${JSON.stringify(error.response.data, null, 2)}`);
      }
      throw error;
    }
  }

  /**
   * Connect to WebSocket for real-time data
   */
  connectWebSocket() {
    if (this.websocket) {
      this.websocket.close();
    }

    logger.info(`Connecting to WebSocket: ${this.wsUrl}`);

    this.websocket = new WebSocket(this.wsUrl);

    this.websocket.on('open', () => {
      logger.info('✅ WebSocket connected');
      this.isConnected = true;

      // Authenticate WebSocket connection
      if (this.mdAccessToken) {
        this.websocket.send(JSON.stringify({
          i: 0,
          d: {
            url: 'auth/accesstokenrequest',
            body: { accessToken: this.mdAccessToken }
          }
        }));
      }
    });

    this.websocket.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        this.handleWebSocketMessage(message);
      } catch (error) {
        logger.error(`WebSocket message parse error: ${error.message}`);
      }
    });

    this.websocket.on('close', () => {
      logger.warn('WebSocket disconnected');
      this.isConnected = false;

      // Attempt to reconnect after 5 seconds
      setTimeout(() => {
        if (!this.isConnected) {
          logger.info('Attempting WebSocket reconnection...');
          this.connectWebSocket();
        }
      }, 5000);
    });

    this.websocket.on('error', (error) => {
      logger.error(`WebSocket error: ${error.message}`);
    });
  }

  /**
   * Handle incoming WebSocket messages
   */
  handleWebSocketMessage(message) {
    // Forward real-time data to connected clients
    if (global.io && message.d) {
      global.io.emit('market_data', message.d);
    }
  }

  /**
   * Subscribe to market data
   */
  subscribeToQuote(symbol) {
    if (this.websocket && this.isConnected) {
      this.websocket.send(JSON.stringify({
        i: Date.now(),
        d: {
          url: 'md/subscribequote',
          body: { symbol }
        }
      }));
      logger.info(`Subscribed to quotes for ${symbol}`);
    }
  }

  /**
   * Get current account balance and equity
   */
  async getAccountBalance(accountId) {
    try {
      // Use cash balance snapshot for actual balance data
      const cashBalanceResponse = await this.makeRateLimitedRequest(
        () => this.api.get(`/cashBalance/getcashbalancesnapshot?accountId=${accountId}`),
        `get-cash-balance-${accountId}`
      );
      logger.info(`Cash balance response: ${JSON.stringify(cashBalanceResponse.data, null, 2)}`);

      // Also get account details for metadata
      const accountResponse = await this.makeRateLimitedRequest(
        () => this.api.get(`/account/item?id=${accountId}`),
        `get-account-details-${accountId}`
      );
      logger.info(`Account details response: ${JSON.stringify(accountResponse.data, null, 2)}`);

      const cashData = cashBalanceResponse.data;
      return {
        balance: cashData.totalCashValue || cashData.cashUSD || 0,
        equity: cashData.netLiq || 0,
        margin: cashData.initialMargin || 0,
        availableFunds: cashData.currencyCashAvailWithdrawalUSD || cashData.totalCashValue || 0,
        dayPnL: cashData.realizedPnL || 0,
        weekPnL: cashData.weekRealizedPnL || 0,
        openPnL: cashData.openPnL || 0,
        startOfDayBalance: cashData.netLiqSOD || 0
      };
    } catch (error) {
      logger.error(`Failed to get account balance: ${error.message}`);
      throw error;
    }
  }


  /**
   * Get margin snapshot for an account
   */
  async getMarginSnapshot(accountId) {
    try {
      // Try different margin endpoints
      let response;
      try {
        response = await this.api.get(`/marginSnapshot/item?accountId=${accountId}`);
      } catch (firstError) {
        // Fallback to different endpoint format
        try {
          response = await this.api.get(`/marginSnapshot/list?accountId=${accountId}`);
        } catch (secondError) {
          // Last fallback
          response = await this.api.get(`/account/marginSnapshot?accountId=${accountId}`);
        }
      }
      logger.info(`Margin snapshot response: ${JSON.stringify(response.data, null, 2)}`);
      return response.data;
    } catch (error) {
      logger.warn(`Margin snapshot not available: ${error.message}`);
      return null; // Return null instead of throwing to allow other data to load
    }
  }

  /**
   * Get cash balance snapshot
   */
  async getCashBalanceSnapshot(accountId) {
    try {
      const response = await this.api.get(`/cashBalance/getcashbalancesnapshot?accountId=${accountId}`);
      return response.data;
    } catch (error) {
      logger.error(`Failed to get cash balance snapshot: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get fills (executed trades) for an account
   */
  async getFills(accountId, limit = 100) {
    try {
      const response = await this.api.get(`/fill/list?accountId=${accountId}&limit=${limit}`);
      return response.data;
    } catch (error) {
      logger.error(`Failed to get fills: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get contract details by symbol
   */
  async getContractBySymbol(symbol) {
    try {
      const response = await this.api.get(`/contract/find?name=${symbol}`);
      return response.data;
    } catch (error) {
      logger.error(`Failed to get contract details for ${symbol}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Check if contract cache is valid
   */
  isCacheValid() {
    if (!this.cacheTimestamp) return false;
    const cacheAge = Date.now() - this.cacheTimestamp;
    const cacheMaxAge = this.cacheExpiryHours * 60 * 60 * 1000; // Convert hours to milliseconds
    return cacheAge < cacheMaxAge;
  }

  /**
   * Get cached contract resolution
   */
  getCachedContract(baseSymbol) {
    if (!this.isCacheValid()) {
      logger.info(`📋 Contract cache expired or missing, will refresh`);
      return null;
    }

    const cached = this.contractCache.get(baseSymbol);
    if (cached) {
      logger.info(`🗄️ Using cached contract for ${baseSymbol}: ${cached.contractName}`);
      return cached;
    }

    return null;
  }

  /**
   * Cache contract resolution
   */
  cacheContract(baseSymbol, contractInfo) {
    this.contractCache.set(baseSymbol, contractInfo);
    this.cacheTimestamp = Date.now();
    logger.info(`💾 Cached contract resolution: ${baseSymbol} -> ${contractInfo.contractName}`);
  }

  /**
   * Populate contract cache for common symbols
   */
  async populateContractCache() {
    const commonSymbols = ['MNQ', 'NQ', 'MES', 'ES', 'RTY', 'M2K'];
    logger.info(`🔄 Populating contract cache for symbols: ${commonSymbols.join(', ')}`);

    for (const symbol of commonSymbols) {
      try {
        const contract = await this.getCurrentContractInternal(symbol);
        this.cacheContract(symbol, contract);
        // Add small delay between requests to be respectful to API
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        logger.warn(`⚠️ Failed to cache contract for ${symbol}: ${error.message}`);
      }
    }

    logger.info(`✅ Contract cache populated with ${this.contractCache.size} symbols`);
  }

  /**
   * Get current active contract for a base symbol with caching (Public API)
   */
  async getCurrentContract(baseSymbol) {
    // Try cache first
    const cached = this.getCachedContract(baseSymbol);
    if (cached) {
      return cached;
    }

    // Cache miss or expired, fetch fresh data
    logger.info(`🔍 Cache miss for ${baseSymbol}, fetching from API`);
    const contract = await this.getCurrentContractInternal(baseSymbol);
    this.cacheContract(baseSymbol, contract);

    return contract;
  }

  /**
   * Get the current active (front month) contract for a futures symbol (Internal)
   * Maps base symbols like "MNQ", "ES" to current contracts like "MNQZ24", "ESZ24"
   */
  async getCurrentContractInternal(baseSymbol) {
    try {
      logger.info(`🔍 Looking up current contract for ${baseSymbol}`);

      // Try multiple API approaches to find contracts
      let response = null;
      let contracts = null;

      try {
        // Method 1: Try contract/suggest endpoint (commonly used for search)
        response = await this.api.get(`/contract/suggest?t=${baseSymbol}&l=20`);
        contracts = response.data;
        logger.info(`📋 Method 1 (suggest): Found ${contracts?.length || 0} contracts for ${baseSymbol}`);
      } catch (error1) {
        logger.info(`📋 Method 1 (suggest) failed: ${error1.message}`);

        try {
          // Method 2: Try contract/find as POST request with payload
          response = await this.api.post('/contract/find', { name: baseSymbol });
          contracts = response.data;
          logger.info(`📋 Method 2 (POST find): Found ${contracts?.length || 0} contracts for ${baseSymbol}`);
        } catch (error2) {
          logger.info(`📋 Method 2 (POST find) failed: ${error2.message}`);

          try {
            // Method 3: Try contract/find as GET with query parameter
            response = await this.api.get(`/contract/find?name=${baseSymbol}`);
            contracts = response.data;
            logger.info(`📋 Method 3 (GET find): Found ${contracts?.length || 0} contracts for ${baseSymbol}`);
          } catch (error3) {
            logger.info(`📋 Method 3 (GET find) failed: ${error3.message}`);

            try {
              // Method 4: Try broader search using contract/deps endpoint
              response = await this.api.get(`/contract/deps`);
              if (response.data && Array.isArray(response.data)) {
                // Filter contracts that start with base symbol
                contracts = response.data.filter(contract =>
                  contract.name && contract.name.startsWith(baseSymbol)
                );
                logger.info(`📋 Method 4 (deps): Found ${contracts?.length || 0} contracts for ${baseSymbol}`);
              }
            } catch (error4) {
              logger.info(`📋 Method 4 (deps) failed: ${error4.message}`);

              try {
                // Method 5: Try contract/items endpoint
                response = await this.api.get(`/contract/items`);
                if (response.data && Array.isArray(response.data)) {
                  contracts = response.data.filter(contract =>
                    contract.name && contract.name.startsWith(baseSymbol)
                  );
                  logger.info(`📋 Method 5 (items): Found ${contracts?.length || 0} contracts for ${baseSymbol}`);
                }
              } catch (error5) {
                logger.error(`📋 All contract lookup methods failed: ${error5.message}`);
                throw new Error(`Could not find contracts for ${baseSymbol}: API endpoints unavailable`);
              }
            }
          }
        }
      }

      if (!contracts || contracts.length === 0) {
        throw new Error(`No contracts found for symbol ${baseSymbol}`);
      }

      logger.info(`📋 All contracts found: ${contracts.map(c => c.name).join(', ')}`);

      // Filter for contracts that match the base symbol
      let activeContracts = contracts.filter(contract => {
        return contract.name && contract.name.startsWith(baseSymbol);
      });

      if (activeContracts.length === 0) {
        logger.warn(`⚠️ No contracts found for ${baseSymbol}. Available: ${contracts.map(c => c.name).join(', ')}`);
        throw new Error(`No contracts found for symbol ${baseSymbol}`);
      }

      logger.info(`📋 Found ${activeContracts.length} contracts: ${activeContracts.map(c => c.name).join(', ')}`);

      // Try to get the current/front month contract
      // For futures, the current contract is typically the one with the nearest expiration
      // If expiration dates are available, use them; otherwise use naming convention
      let currentContract;

      if (activeContracts.some(c => c.expirationDate)) {
        // Filter out expired contracts if expiration dates are available
        const now = new Date();
        const validContracts = activeContracts.filter(contract => {
          if (!contract.expirationDate) return true; // Keep if no expiration date
          const expirationDate = new Date(contract.expirationDate);
          return expirationDate > now;
        });

        if (validContracts.length > 0) {
          // Sort by expiration date to get front month (earliest expiration)
          validContracts.sort((a, b) => {
            if (!a.expirationDate) return 1;
            if (!b.expirationDate) return -1;
            return new Date(a.expirationDate) - new Date(b.expirationDate);
          });
          currentContract = validContracts[0];
        } else {
          currentContract = activeContracts[0];
        }
      } else {
        // No expiration dates available, use contract naming convention
        // For MNQ futures, we want the front month contract (nearest expiration)
        // Contracts are typically listed with year suffix: 5=2025, 6=2026, etc.

        // Sort contracts by year and month to find the nearest one
        const sortedContracts = activeContracts.slice().sort((a, b) => {
          // Extract year and month code from contract name (e.g., MNQZ5 -> Z5)
          const extractYearMonth = (name) => {
            const match = name.match(/([A-Z])(\d)$/);
            if (!match) return { year: 9999, monthIndex: 99 };

            const monthCode = match[1];
            const year = 2020 + parseInt(match[2]); // 5 = 2025, 6 = 2026

            // Map month codes to numeric values for sorting
            const monthMap = { F: 1, G: 2, H: 3, J: 4, K: 5, M: 6, N: 7, Q: 8, U: 9, V: 10, X: 11, Z: 12 };
            const monthIndex = monthMap[monthCode] || 99;

            return { year, monthIndex };
          };

          const aData = extractYearMonth(a.name);
          const bData = extractYearMonth(b.name);

          // Sort by year first, then by month
          if (aData.year !== bData.year) {
            return aData.year - bData.year;
          }
          return aData.monthIndex - bData.monthIndex;
        });

        logger.info(`📋 Sorted contracts by date: ${sortedContracts.map(c => c.name).join(', ')}`);

        // The front month is the first contract in the sorted list that hasn't expired
        // For now, we'll take the first one since we can't verify expiration without dates
        currentContract = sortedContracts[0];

        logger.info(`📋 Selected front month contract: ${currentContract.name}`);
      }
      logger.info(`✅ Selected current contract for ${baseSymbol}: ${currentContract.name}${currentContract.expirationDate ? ` (expires: ${currentContract.expirationDate})` : ' (no expiration date)'}`);

      return {
        baseSymbol: baseSymbol,
        contractName: currentContract.name,
        contractId: currentContract.id,
        expirationDate: currentContract.expirationDate,
        tickSize: currentContract.tickSize,
        contractSize: currentContract.contractSize,
        fullContract: currentContract
      };

    } catch (error) {
      logger.error(`Failed to get current contract for ${baseSymbol}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get contract details by ID
   */
  async getContract(contractId) {
    try {
      const response = await this.api.get(`/contract/item?id=${contractId}`);
      return response.data;
    } catch (error) {
      logger.error(`Failed to get contract details: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get execution reports
   */
  async getExecutionReports(accountId, limit = 100) {
    try {
      const response = await this.api.get(`/executionReport/list?accountId=${accountId}&limit=${limit}`);
      return response.data;
    } catch (error) {
      logger.error(`Failed to get execution reports: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get complete account items with all details
   */
  async getAccountItems() {
    try {
      const response = await this.api.get('/account/items');
      return response.data;
    } catch (error) {
      logger.error(`Failed to get account items: ${error.message}`);
      throw error;
    }
  }

  /**
   * Cleanup and close connections
   */
  disconnect() {
    if (this.websocket) {
      this.websocket.close();
    }
    this.accessToken = null;
    this.mdAccessToken = null;
    logger.info('Disconnected from Tradovate');
  }
}

export default TradovateClient;