import TradovateClient from './tradovateClient.js';
import positionMonitor from './positionMonitor.js';
import winston from 'winston';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [EXECUTOR-${level.toUpperCase()}]: ${message}`;
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
 * Resolve base symbol to current contract using cache
 */
async function resolveSymbolToContract(symbol) {
  const client = getTradovateClient();

  // Check if this is a base futures symbol that needs contract resolution
  const baseFuturesSymbols = ['MNQ', 'NQ', 'MES', 'ES', 'RTY', 'M2K'];

  // Handle TradingView format symbols (e.g., NQ1! -> NQ)
  let baseSymbol = symbol.toUpperCase();
  if (baseSymbol.endsWith('1!')) {
    baseSymbol = baseSymbol.replace('1!', '');
  }

  if (baseFuturesSymbols.includes(baseSymbol)) {
    try {
      const contractInfo = await client.getCurrentContract(baseSymbol);
      const resolvedSymbol = contractInfo.contractName;
      const contractId = contractInfo.contractId;
      logger.info(`📋 Resolved ${symbol} → ${resolvedSymbol} (ID: ${contractId}) (cached: ${client.getCachedContract(baseSymbol) ? 'yes' : 'no'})`);
      return { resolvedSymbol, contractInfo, baseSymbol, contractId };
    } catch (error) {
      logger.warn(`⚠️ Could not resolve contract for ${symbol}, using original symbol: ${error.message}`);
      return { resolvedSymbol: symbol, contractInfo: null, baseSymbol, contractId: null };
    }
  }

  return { resolvedSymbol: symbol, contractInfo: null, baseSymbol, contractId: null };
}

// Account mapping (could be moved to database/config)
const ACCOUNT_MAPPING = {
  'default': null, // Will use first available account
  'demo': null,
  'live': null
  // Add your specific account mappings here
};

/**
 * Group related OSO orders (bracket orders) into logical trading units
 * A bracket order consists of: Entry order + Stop Loss (OSO) + Take Profit (OSO)
 */
function groupRelatedOrders(orders) {
  logger.info(`🔗 Starting bracket grouping for ${orders.length} orders`);

  const groupedOrders = [];
  const processedOrderIds = new Set();

  for (const order of orders) {
    const orderId = order.id || order.orderId;

    if (processedOrderIds.has(orderId)) {
      logger.info(`🔗 Skipping order ${orderId} - already processed`);
      continue; // Already processed as part of another group
    }

    logger.info(`🔗 Processing order ${orderId} for bracket grouping`);

    // Check if this is a main entry order with OSO relationships
    const relatedOrders = findRelatedOrders(order, orders);

    if (relatedOrders.length > 1) {
      logger.info(`🔗 Order ${orderId} has ${relatedOrders.length} related orders - creating bracket group`);

      // This is a bracket order with multiple related orders
      const bracketGroup = createBracketOrderGroup(relatedOrders);
      groupedOrders.push(bracketGroup);

      // Mark all related orders as processed
      relatedOrders.forEach(o => {
        const relatedId = o.id || o.orderId;
        processedOrderIds.add(relatedId);
        logger.info(`🔗 Marked order ${relatedId} as processed`);
      });
    } else {
      logger.info(`🔗 Order ${orderId} is standalone - no bracket relationships found`);

      // Single standalone order
      const standalone = {
        ...order,
        orderType: order.orderType || 'Single',
        isGroup: false
      };
      groupedOrders.push(standalone);
      processedOrderIds.add(orderId);
    }
  }

  logger.info(`🔗 Bracket grouping complete: ${groupedOrders.length} final groups created`);
  return groupedOrders;
}

/**
 * Find orders related to a given order through OSO relationships
 */
function findRelatedOrders(mainOrder, allOrders) {
  const related = [mainOrder];
  const mainOrderId = mainOrder.id || mainOrder.orderId;

  logger.info(`🔍 Finding related orders for main order ${mainOrderId}:`, {
    orderType: mainOrder.orderType,
    action: mainOrder.action,
    price: mainOrder.price || mainOrder.limitPrice || mainOrder.stopPrice,
    linkedId: mainOrder.linkedId,
    parentId: mainOrder.parentId,
    ocoId: mainOrder.ocoId
  });

  // Look for orders using Tradovate's actual relationship fields
  for (const order of allOrders) {
    const orderId = order.id || order.orderId;
    if (orderId === mainOrderId) continue;

    const linkedRelation = order.linkedId === mainOrderId || mainOrder.linkedId === orderId;
    const ocoRelation = order.ocoId === orderId || order.ocoId === mainOrderId;
    const parentChildRelation = order.parentId === mainOrderId || mainOrder.parentId === orderId;
    const siblingRelation = order.parentId && mainOrder.parentId && order.parentId === mainOrder.parentId;

    // Additional check for shared linkedId values (orders that are linked to the same order)
    const sharedLinkedId = mainOrder.linkedId && order.linkedId === mainOrder.linkedId;
    const linkedBySharedId = mainOrder.linkedId && orderId === mainOrder.linkedId;

    const isRelated = linkedRelation || ocoRelation || parentChildRelation || siblingRelation || sharedLinkedId || linkedBySharedId;

    logger.info(`🔗 Checking order ${orderId} for relationships:`, {
      orderType: order.orderType,
      action: order.action,
      ordStatus: order.ordStatus || order.status,
      price: order.price || order.limitPrice || order.stopPrice,
      linkedId: order.linkedId,
      parentId: order.parentId,
      ocoId: order.ocoId,
      mainOrderLinkedId: mainOrder.linkedId,
      relationshipResults: {
        linked: linkedRelation,
        oco: ocoRelation,
        parentChild: parentChildRelation,
        sibling: siblingRelation,
        sharedLinkedId: sharedLinkedId,
        linkedBySharedId: linkedBySharedId,
        isRelated: isRelated
      }
    });

    if (isRelated) {
      logger.info(`🔗 ✅ Found related order ${orderId} - adding to bracket group`);
      related.push(order);
    } else {
      logger.info(`🔗 ❌ Order ${orderId} not related - skipping`);
    }
  }

  logger.info(`🔗 Found ${related.length} related orders for order ${mainOrderId}:`,
    related.map(o => ({
      id: o.id,
      action: o.action,
      ordStatus: o.ordStatus,
      price: o.price || o.limitPrice || o.stopPrice,
      role: getOrderRole(o)
    })));

  return related;
}

/**
 * Create a display-friendly bracket order group
 */
function createBracketOrderGroup(relatedOrders) {
  // Sort orders by likely type (entry first, then stops/targets)
  const sortedOrders = relatedOrders.sort((a, b) => {
    const aType = getOrderRole(a);
    const bType = getOrderRole(b);
    const roleOrder = { 'entry': 0, 'stop': 1, 'target': 2, 'other': 3 };
    return (roleOrder[aType] || 3) - (roleOrder[bType] || 3);
  });

  const entryOrder = sortedOrders.find(o => getOrderRole(o) === 'entry') || sortedOrders[0];
  const stopOrder = sortedOrders.find(o => getOrderRole(o) === 'stop');
  const targetOrder = sortedOrders.find(o => getOrderRole(o) === 'target');

  // Helper function to extract price from an order
  const extractOrderPrice = (order) => {
    if (!order) return null;
    // Try different price fields that Tradovate uses
    return order.price || order.limitPrice || order.stopPrice || order.workingPrice || null;
  };

  const bracketOrder = {
    // Use entry order as base
    ...entryOrder,
    orderType: 'Bracket',
    isGroup: true,
    groupSize: relatedOrders.length,
    // Add bracket-specific fields
    bracketDetails: {
      entry: entryOrder ? {
        action: entryOrder.action,
        qty: entryOrder.orderQty,
        price: extractOrderPrice(entryOrder),
        orderId: entryOrder.orderId || entryOrder.id,
        status: entryOrder.ordStatus || entryOrder.status
      } : null,
      stopLoss: stopOrder ? {
        price: extractOrderPrice(stopOrder),
        orderId: stopOrder.orderId || stopOrder.id,
        status: stopOrder.ordStatus || stopOrder.status,
        orderType: stopOrder.orderType
      } : null,
      takeProfit: targetOrder ? {
        price: extractOrderPrice(targetOrder),
        orderId: targetOrder.orderId || targetOrder.id,
        status: targetOrder.ordStatus || targetOrder.status,
        orderType: targetOrder.orderType
      } : null
    }
  };

  logger.info(`📊 Created bracket order:`, {
    entryPrice: extractOrderPrice(entryOrder),
    stopPrice: extractOrderPrice(stopOrder),
    targetPrice: extractOrderPrice(targetOrder),
    entryRole: entryOrder ? getOrderRole(entryOrder) : 'none',
    stopRole: stopOrder ? getOrderRole(stopOrder) : 'none',
    targetRole: targetOrder ? getOrderRole(targetOrder) : 'none',
    bracketDetails: bracketOrder.bracketDetails
  });

  return bracketOrder;
}

/**
 * Determine the role of an order (entry, stop, target, other)
 */
function getOrderRole(order) {
  const orderType = (order.orderType || '').toLowerCase();
  const text = (order.text || '').toLowerCase();

  // Check for stop orders using Tradovate API fields
  if (orderType.includes('stop') ||
      order.stopPrice !== undefined ||
      text.includes('stop') ||
      text.includes('sl') ||
      orderType === 'stoplimit') {
    return 'stop';
  }

  // Check for take profit orders - usually limit orders with profit-related text
  // or orders that have both linkedId and are limit orders (common for OSO profit targets)
  if ((orderType.includes('limit') &&
       (text.includes('profit') || text.includes('target') || text.includes('tp'))) ||
      (orderType === 'limit' && order.linkedId && !order.stopPrice)) {
    return 'target';
  }

  // Entry orders - market or limit orders that aren't stop/profit
  if (orderType.includes('market') ||
      (orderType.includes('limit') && !order.linkedId && !order.stopPrice)) {
    return 'entry';
  }

  return 'other';
}

/**
 * Process incoming trading signal from TradingView
 */
export async function processTradeSignal(signal) {
  try {
    logger.info(`🎯 Processing signal: ${signal.action} ${signal.quantity} ${signal.symbol}`);

    const client = getTradovateClient();

    // Ensure we're authenticated
    if (!client.accessToken) {
      await client.authenticate();
    }

    // Get account information
    const accounts = await client.getAccounts();
    if (!accounts || accounts.length === 0) {
      throw new Error('No trading accounts available');
    }

    // Select target account
    const targetAccount = selectTradingAccount(accounts, signal.account);
    logger.info(`Using account: ${targetAccount.name} (ID: ${targetAccount.id})`);

    // Determine order details based on signal
    const orderData = await buildOrderFromSignal(signal, targetAccount.id);

    // Handle case where only order cancellations were performed (no position to close)
    if (!orderData) {
      const tradeRecord = {
        tradeId: generateTradeId(),
        orderId: null,
        accountId: targetAccount.id,
        symbol: signal.symbol,
        action: signal.action,
        quantity: signal.quantity,
        timestamp: signal.timestamp,
        status: 'orders_cancelled',
        source: signal.source,
        rawSignal: signal.rawData
      };

      logger.info(`✅ Close position completed (orders cancelled only): ID ${tradeRecord.tradeId}`);
      return tradeRecord;
    }

    // Execute the trade (choose between regular or bracket order)
    const orderResult = orderData.isBracketOrder
      ? await client.placeBracketOrder(orderData)
      : await client.placeOrder(orderData);

    // Store trade record (TODO: implement database storage)
    const tradeRecord = {
      tradeId: generateTradeId(),
      orderId: orderResult.orderId,
      accountId: targetAccount.id,
      symbol: signal.symbol,
      action: signal.action,
      quantity: signal.quantity,
      timestamp: signal.timestamp,
      status: 'submitted',
      source: signal.source,
      rawSignal: signal.rawData,
      // Bracket order information
      isBracketOrder: orderData.isBracketOrder || false,
      stopOrderId: orderResult.bracket1OrderId || null,
      profitOrderId: orderResult.bracket2OrderId || null,
      trailingConfig: orderData.trailingConfig || null
    };

    logger.info(`✅ Trade executed successfully: ID ${tradeRecord.tradeId}`);

    // Add position to trailing monitor if it has trailing configuration
    if (tradeRecord.trailingConfig) {
      positionMonitor.addPosition(tradeRecord);
    }

    // Start position monitoring if not already running
    if (!positionMonitor.isRunning) {
      positionMonitor.start();
    }

    // Emit critical status update via WebSocket (with delay and cache invalidation)
    setTimeout(() => {
      // Invalidate cache so WebSocket gets fresh data
      criticalStatusCache = null;
      criticalStatusCacheTime = null;
      emitCriticalStatusUpdate();
    }, 2000);

    return tradeRecord;

  } catch (error) {
    logger.error(`❌ Trade execution failed: ${error.message}`);
    throw error;
  }
}

/**
 * Select the appropriate trading account
 */
function selectTradingAccount(accounts, accountPreference) {
  // If specific account requested, try to find it
  if (accountPreference && accountPreference !== 'default') {
    // Convert accountPreference to string to handle both string and number inputs
    const accountPref = accountPreference.toString();

    const preferredAccount = accounts.find(acc =>
      acc.name.toLowerCase().includes(accountPref.toLowerCase()) ||
      acc.id.toString() === accountPref
    );

    if (preferredAccount) {
      return preferredAccount;
    }

    logger.warn(`Requested account '${accountPreference}' not found, using default`);
  }

  // Use first available account (you can add more sophisticated logic here)
  return accounts[0];
}

/**
 * Build order data from trading signal
 */
async function buildOrderFromSignal(signal, accountId) {
  const { action, symbol, quantity } = signal;

  // Get TradovateClient instance
  const client = getTradovateClient();

  // Ensure contract cache is populated (async, non-blocking for first few requests)
  if (!client.isCacheValid()) {
    // Don't await - let it populate in background for future requests
    client.populateContractCache().catch(error =>
      logger.warn(`⚠️ Background contract cache population failed: ${error.message}`)
    );
  }

  // Resolve base symbol to current active contract
  let resolvedSymbol = symbol;
  let contractInfo = null;

  // Check if this is a base futures symbol that needs contract resolution
  const baseFuturesSymbols = ['MNQ', 'NQ', 'MES', 'ES', 'RTY', 'M2K'];

  // Handle TradingView format symbols (e.g., NQ1! -> NQ)
  let baseSymbol = symbol.toUpperCase();
  if (baseSymbol.endsWith('1!')) {
    baseSymbol = baseSymbol.replace('1!', '');
  }

  if (baseFuturesSymbols.includes(baseSymbol)) {
    try {
      contractInfo = await client.getCurrentContract(baseSymbol);
      resolvedSymbol = contractInfo.contractName;
      logger.info(`📋 Resolved ${symbol} → ${resolvedSymbol} (expires: ${contractInfo.expirationDate})`);
    } catch (error) {
      logger.warn(`⚠️ Could not resolve contract for ${symbol}, using original symbol: ${error.message}`);
      // Continue with original symbol if lookup fails
    }
  }

  // Map TradingView actions to Tradovate order types
  const orderAction = mapActionToOrderType(action);

  // Determine order type based on signal action and available price data
  let orderType = 'Market'; // Default to market orders
  let limitPrice = null;

  // Check if this is a limit order signal
  if (signal.rawData?.action === 'place_limit' || action === 'PLACE_LIMIT') {
    orderType = 'Limit';
    // For limit orders, use the provided price as the limit price
    if (signal.rawData?.price) {
      limitPrice = parseFloat(signal.rawData.price);
    } else if (signal.price) {
      limitPrice = parseFloat(signal.price);
    }
  }

  // Base order structure
  const orderData = {
    accountId: accountId,
    symbol: resolvedSymbol, // Use resolved contract name
    orderQty: quantity,
    action: orderAction,
    orderType: orderType,
    timeInForce: 'Day',
    isAutomated: true
  };

  // Add limit price if this is a limit order
  if (orderType === 'Limit' && limitPrice) {
    orderData.price = limitPrice; // Tradovate uses 'price' field for limit orders
    logger.info(`📊 Limit order: ${orderAction} ${quantity} ${resolvedSymbol} @ $${limitPrice}`);
  }

  // Handle cancel limit orders (just cancel orders, don't close positions)
  if (action === 'CANCEL_LIMIT') {
    logger.info(`❌ Processing cancel limit orders signal for ${symbol}`);

    // Resolve symbol using cached resolution
    const { resolvedSymbol, baseSymbol, contractId } = await resolveSymbolToContract(symbol);

    // Get the side (buy/sell) to cancel specific orders
    const cancelSide = signal.rawData?.side || signal.side;
    logger.info(`🔍 Cancel side specified: "${cancelSide}"`);
    logger.info(`🔍 Symbol resolution: ${symbol} → ${resolvedSymbol} (contractId: ${contractId})`);

    try {
      const orders = await client.getOrders(accountId);
      logger.info(`📋 Total orders retrieved: ${orders.length}`);

      const symbolOrders = orders.filter(order => {
        // Match by contractId (most reliable) or fallback to symbol matching
        const contractMatch = contractId && order.contractId === contractId;
        const symbolMatch = order.symbol === symbol ||
                          order.symbol === resolvedSymbol ||
                          order.symbol === baseSymbol ||
                          (order.symbol && (order.symbol.startsWith(symbol) || order.symbol.startsWith(resolvedSymbol?.substring(0, 3))));

        const overallSymbolMatch = contractMatch || symbolMatch;

        // Match side if specified
        const sideMatch = !cancelSide ||
                         (cancelSide.toLowerCase() === 'buy' && order.action === 'Buy') ||
                         (cancelSide.toLowerCase() === 'sell' && order.action === 'Sell');

        // Only consider active orders (not filled or canceled)
        const statusMatch = order.ordStatus && !['Filled', 'Canceled', 'Rejected'].includes(order.ordStatus);

        return overallSymbolMatch && sideMatch && statusMatch;
      });

      logger.info(`🎯 Filtered orders to cancel: ${symbolOrders.length}`);

      if (symbolOrders.length > 0) {
        logger.info(`📋 Found ${symbolOrders.length} orders to cancel for ${symbol} (${cancelSide || 'all sides'}):`);
        for (const order of symbolOrders) {
          logger.info(`  - Order ${order.id}: ${order.action} ${order.orderQty} ${order.symbol} @ ${order.limitPrice || order.stopPrice || 'Market'}`);
          try {
            await client.cancelOrder(order.id);
            logger.info(`✅ Cancelled order ${order.id}`);
          } catch (cancelError) {
            logger.warn(`⚠️ Failed to cancel order ${order.id}: ${cancelError.message}`);
          }
        }
      } else {
        logger.info(`📋 No orders found to cancel for ${symbol}/${resolvedSymbol}/${baseSymbol} (${cancelSide || 'all sides'})`);
      }

      // Return null to indicate no position order needed, just cancellation
      return null;
    } catch (error) {
      logger.warn(`⚠️ Failed to cancel orders: ${error.message}`);
      return null;
    }
  }

  // Handle different signal types
  if (action === 'CLOSE' || action === 'FLAT' || action === 'CLOSE_POSITION' || action === 'POSITION_CLOSED') {
    logger.info(`🔄 Processing close position signal for ${symbol}`);

    // Resolve symbol using cached resolution
    const { resolvedSymbol, baseSymbol, contractId } = await resolveSymbolToContract(symbol);
    logger.info(`🔍 Symbol resolution: ${symbol} → ${resolvedSymbol} (contractId: ${contractId})`);

    // Step 1: Cancel any open orders for this symbol (contractId and symbol variations)
    try {
      const orders = await client.getOrders(accountId);
      const symbolOrders = orders.filter(order => {
        const contractMatch = contractId && order.contractId === contractId;
        const symbolMatch = order.symbol === symbol ||
                          order.symbol === resolvedSymbol ||
                          order.symbol === baseSymbol ||
                          (order.symbol && (order.symbol.startsWith(symbol) || order.symbol.startsWith(resolvedSymbol?.substring(0, 3))));

        const overallMatch = contractMatch || symbolMatch;
        const statusMatch = order.ordStatus && !['Filled', 'Canceled', 'Rejected'].includes(order.ordStatus);

        return overallMatch && statusMatch;
      });

      if (symbolOrders.length > 0) {
        logger.info(`📋 Found ${symbolOrders.length} open orders to cancel for ${symbol}:`);
        for (const order of symbolOrders) {
          logger.info(`  - Order ${order.id}: ${order.action} ${order.orderQty} ${order.symbol} @ ${order.limitPrice || order.stopPrice || 'Market'}`);
          try {
            await client.cancelOrder(order.id);
            logger.info(`✅ Cancelled order ${order.id}`);
          } catch (cancelError) {
            logger.warn(`⚠️ Failed to cancel order ${order.id}: ${cancelError.message}`);
          }
        }
      } else {
        logger.info(`📋 No open orders found for ${symbol}/${resolvedSymbol}`);
      }
    } catch (orderError) {
      logger.warn(`⚠️ Failed to get orders for cancellation: ${orderError.message}`);
    }

    // Step 2: Close any existing positions for this symbol
    try {
      const positions = await client.getPositions(accountId);
      const symbolPosition = positions.find(pos =>
        pos.symbol === symbol ||
        pos.symbol === resolvedSymbol ||
        (pos.symbol && (pos.symbol.startsWith(symbol) || pos.symbol.startsWith(resolvedSymbol.substring(0, 3))))
      );

      if (symbolPosition) {
        orderData.orderQty = Math.abs(symbolPosition.qty);
        orderData.action = symbolPosition.qty > 0 ? 'Sell' : 'Buy';
        orderData.symbol = symbolPosition.symbol; // Use the exact symbol from the position
        logger.info(`📈 Closing position: ${symbolPosition.qty} contracts of ${symbolPosition.symbol}`);

        // For close positions, always use market orders for immediate execution
        orderData.orderType = 'Market';

        // Remove any limit pricing for immediate market close
        if (orderData.price) {
          delete orderData.price;
        }
      } else {
        logger.info(`📋 No open position found for ${symbol}/${resolvedSymbol} - orders cancelled only`);
        // Return null to indicate no closing order needed, just order cancellations
        return null;
      }
    } catch (positionError) {
      logger.warn(`⚠️ Failed to get positions: ${positionError.message}`);
      return null;
    }
  }

  // Handle stop loss and take profit for bracket orders
  let stopLossPrice = null;
  let takeProfitPrice = null;
  let trailingTrigger = null;
  let trailingOffset = null;

  if (signal.rawData?.stopLoss || signal.rawData?.stop_loss) {
    stopLossPrice = parseFloat(signal.rawData.stopLoss || signal.rawData.stop_loss);
    logger.info(`📊 Stop loss price: $${stopLossPrice}`);
  }

  if (signal.rawData?.takeProfit || signal.rawData?.take_profit) {
    takeProfitPrice = parseFloat(signal.rawData.takeProfit || signal.rawData.take_profit);
    logger.info(`📊 Take profit price: $${takeProfitPrice}`);
  }

  if (signal.rawData?.trailing_trigger || signal.rawData?.trailingTrigger) {
    trailingTrigger = parseFloat(signal.rawData.trailing_trigger || signal.rawData.trailingTrigger);
    logger.info(`📊 Trailing trigger: ${trailingTrigger} points`);
  }

  if (signal.rawData?.trailing_offset || signal.rawData?.trailingOffset) {
    trailingOffset = parseFloat(signal.rawData.trailing_offset || signal.rawData.trailingOffset);
    logger.info(`📊 Trailing offset: ${trailingOffset} points`);
  }

  // Determine if this should be a bracket order
  const hasBracketData = stopLossPrice || takeProfitPrice;

  if (hasBracketData) {
    logger.info(`📊 Creating bracket order with stop/profit exits`);

    // Convert to bracket order structure
    orderData.isBracketOrder = true;

    // Add bracket1 (stop loss) if provided
    if (stopLossPrice) {
      orderData.bracket1 = {
        action: orderAction === 'Buy' ? 'Sell' : 'Buy',
        orderType: 'Stop',
        stopPrice: stopLossPrice
      };
    }

    // Add bracket2 (take profit) if provided
    if (takeProfitPrice) {
      orderData.bracket2 = {
        action: orderAction === 'Buy' ? 'Sell' : 'Buy',
        orderType: 'Limit',
        price: takeProfitPrice
      };
    }

    // Store trailing info for later activation (Phase 2)
    if (trailingTrigger && trailingOffset) {
      orderData.trailingConfig = {
        trigger: trailingTrigger,
        offset: trailingOffset
      };
    }
  }

  logger.info(`Order data: ${JSON.stringify(orderData, null, 2)}`);
  return orderData;
}

/**
 * Map TradingView actions to Tradovate order actions
 */
function mapActionToOrderType(action) {
  const actionMap = {
    'BUY': 'Buy',
    'LONG': 'Buy',
    'SELL': 'Sell',
    'SHORT': 'Sell',
    'CANCEL_LIMIT': 'Cancel', // Will be handled specially
    'CLOSE': 'Close', // Will be handled specially
    'FLAT': 'Close',   // Will be handled specially
    'CLOSE_POSITION': 'Close', // Will be handled specially
    'POSITION_CLOSED': 'Close' // Will be handled specially
  };

  const mappedAction = actionMap[action.toUpperCase()];

  if (!mappedAction) {
    throw new Error(`Unknown action: ${action}`);
  }

  return mappedAction;
}

/**
 * Generate unique trade ID
 */
function generateTradeId() {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `TRADE_${timestamp}_${random}`;
}

/**
 * Get current positions for all accounts
 */
export async function getAllPositions() {
  try {
    const client = getTradovateClient();

    if (!client.accessToken) {
      await client.authenticate();
    }

    const accounts = await client.getAccounts();
    const allPositions = [];

    for (const account of accounts) {
      try {
        const positions = await client.getPositions(account.id);
        const positionsWithAccount = positions.map(pos => ({
          ...pos,
          accountId: account.id,
          accountName: account.name
        }));
        allPositions.push(...positionsWithAccount);
      } catch (error) {
        logger.warn(`Failed to get positions for account ${account.id}: ${error.message}`);
      }
    }

    return allPositions;
  } catch (error) {
    logger.error(`Failed to get all positions: ${error.message}`);
    throw error;
  }
}

/**
 * Get current orders for all accounts
 */
export async function getAllOrders() {
  try {
    const client = getTradovateClient();

    if (!client.accessToken) {
      await client.authenticate();
    }

    const accounts = await client.getAccounts();
    const allOrders = [];

    for (const account of accounts) {
      try {
        const orders = await client.getOrders(account.id);
        const ordersWithAccount = orders.map(order => ({
          ...order,
          accountId: account.id,
          accountName: account.name
        }));
        allOrders.push(...ordersWithAccount);
      } catch (error) {
        logger.warn(`Failed to get orders for account ${account.id}: ${error.message}`);
      }
    }

    return allOrders;
  } catch (error) {
    logger.error(`Failed to get all orders: ${error.message}`);
    throw error;
  }
}

// Cache for critical status to avoid expensive repeated calculations
let criticalStatusCache = null;
let criticalStatusCacheTime = null;
const CACHE_DURATION_MS = 5000; // Cache for 5 seconds

/**
 * Emit critical status update via WebSocket
 */
async function emitCriticalStatusUpdate() {
  if (global.io) {
    try {
      const criticalData = await getCriticalTradingStatus();
      global.io.emit('critical_status_update', criticalData);
      logger.info('🎯 Emitted critical status update via WebSocket');
    } catch (error) {
      logger.error(`Failed to emit critical status: ${error.message}`);
    }
  }
}

/**
 * Get critical trading status (open orders + positions) for dashboard
 */
export async function getCriticalTradingStatus() {
  // Check cache first
  const now = Date.now();
  if (criticalStatusCache && criticalStatusCacheTime && (now - criticalStatusCacheTime < CACHE_DURATION_MS)) {
    logger.info('🎯 Returning cached critical status');
    return criticalStatusCache;
  }

  try {
    logger.info('🎯 Building critical status from cached data');

    // Use cached data from background collector if available
    if (global.tradovateDataCollector) {
      const status = global.tradovateDataCollector.getStatus();
      const dataCache = global.tradovateDataCollector.getDataCache();

      if (dataCache && status.accounts) {
        logger.info('🎯 Using background collector cached data');
        const criticalData = {
          openOrders: [],
          openPositions: [],
          totalDayPnL: 0,
          lastUpdate: new Date().toISOString(),
          positionMonitorStats: positionMonitor.getStats()
        };

        for (const accountInfo of status.accounts) {
          try {
            const accountSnapshot = dataCache.getAccountSnapshot(accountInfo.accountId);

            // Get active orders from cache
            if (accountSnapshot.orders) {
              logger.info(`📋 Processing ${accountSnapshot.orders.length} orders from cache for account ${accountInfo.accountId}`);

              // Log all raw orders first
              accountSnapshot.orders.forEach((order, idx) => {
                logger.info(`📋 Raw order ${idx + 1}:`, {
                  id: order.id,
                  orderId: order.orderId,
                  action: order.action,
                  ordStatus: order.ordStatus || order.status,
                  price: order.price,
                  limitPrice: order.limitPrice,
                  stopPrice: order.stopPrice,
                  workingPrice: order.workingPrice,
                  orderType: order.orderType,
                  linkedId: order.linkedId,
                  parentId: order.parentId,
                  ocoId: order.ocoId
                });
              });

              const activeOrders = accountSnapshot.orders.filter(order => {
                const status = order.ordStatus || order.status;
                const isActive = status && !['Filled', 'Canceled', 'Rejected'].includes(status);
                logger.info(`📋 Order ${order.id} status check: ${status} -> ${isActive ? 'ACTIVE' : 'FILTERED OUT'}`);
                return isActive;
              });

              logger.info(`📋 Found ${activeOrders.length} active orders after filtering`);

              // Group related OSO orders together
              const groupedOrders = groupRelatedOrders(activeOrders);

              logger.info(`📋 Created ${groupedOrders.length} order groups after bracket grouping`);

              for (const orderGroup of groupedOrders) {
                criticalData.openOrders.push({
                  ...orderGroup,
                  accountId: accountInfo.accountId,
                  accountName: accountInfo.accountName
                });
              }
            }

            // Get open positions from cache
            if (accountSnapshot.positions) {
              const openPositions = accountSnapshot.positions.filter(pos => {
                const netPos = pos.netPos || pos.qty || 0;
                return netPos !== 0;
              });

              for (const position of openPositions) {
                criticalData.openPositions.push({
                  ...position,
                  accountId: accountInfo.accountId,
                  accountName: accountInfo.accountName
                });
              }
            }

            // Add to total P&L from cache
            if (accountSnapshot.balance) {
              criticalData.totalDayPnL += accountSnapshot.balance.dayPnL || 0;
            }

          } catch (error) {
            logger.warn(`Failed to get cached data for account ${accountInfo.accountId}: ${error.message}`);
          }
        }

        logger.info(`📊 Critical status (cached): ${criticalData.openOrders.length} orders, ${criticalData.openPositions.length} positions, $${criticalData.totalDayPnL.toFixed(2)} P&L`);

        // Cache the result
        criticalStatusCache = criticalData;
        criticalStatusCacheTime = Date.now();

        return criticalData;
      }
    }

    // Fallback if background collector not available
    logger.warn('🎯 Background collector not available, returning empty data');
    const fallbackData = {
      openOrders: [],
      openPositions: [],
      totalDayPnL: 0,
      lastUpdate: new Date().toISOString(),
      positionMonitorStats: positionMonitor.getStats(),
      error: 'Background data collector not available'
    };

    return fallbackData;

  } catch (error) {
    logger.error(`Failed to get critical trading status: ${error.message}`);
    return {
      openOrders: [],
      openPositions: [],
      totalDayPnL: 0,
      lastUpdate: new Date().toISOString(),
      positionMonitorStats: positionMonitor.getStats(),
      error: error.message
    };
  }
}

/**
 * Calculate daily P&L across all accounts
 */
export async function calculateDailyPnL() {
  try {
    const client = getTradovateClient();

    if (!client.accessToken) {
      await client.authenticate();
    }

    const accounts = await client.getAccounts();
    let totalDayPnL = 0;
    const accountPnL = [];

    for (const account of accounts) {
      try {
        const balance = await client.getAccountBalance(account.id);
        totalDayPnL += balance.dayPnL || 0;

        accountPnL.push({
          accountId: account.id,
          accountName: account.name,
          dayPnL: balance.dayPnL || 0,
          balance: balance.balance,
          equity: balance.equity,
          margin: balance.margin
        });
      } catch (error) {
        logger.warn(`Failed to get balance for account ${account.id}: ${error.message}`);
      }
    }

    return {
      totalDayPnL,
      accountPnL,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    logger.error(`Failed to calculate daily P&L: ${error.message}`);
    throw error;
  }
}

export default {
  processTradeSignal,
  getAllPositions,
  getAllOrders,
  calculateDailyPnL
};