# Slingshot Backend Test Scripts

This directory contains test and debug scripts for the Slingshot backend, particularly for testing Tradovate API integration.

## Test Scripts

### Order Enrichment Tests

- **`debug_order_enrichment.js`** - Targeted debug script for order enrichment process, shows how order versions are selected
- **`test_fixed_enrichment.js`** - Tests the fixed order enrichment logic using the actual TradovateClient
- **`test_updated_enrichment.js`** - Tests the updated enrichment using `/orderVersion/deps` endpoint

### Order Investigation Scripts

- **`debug_orders.js`** - Direct Tradovate API calls to investigate order data, bypassing all caching
- **`debug_price_investigation.js`** - Comprehensive investigation of order price discrepancies
- **`test_rejected_orders.js`** - Analyzes rejected orders and tests enrichment with them

### API Endpoint Tests

- **`test_orderversion_api.js`** - Tests `/orderVersion/list` endpoint parameter behavior
- **`test_orderversion_deps.js`** - Tests `/orderVersion/deps` endpoint with `masterid` parameter

### Verification Scripts

- **`verify_api_with_csv.js`** - Compares API data with TradingView CSV export for validation
- **`test-connection.js`** - Basic connection test for Tradovate API

## Key Findings

1. **Order Version API Behavior**:
   - `/orderVersion/list?orderId=X` - Returns ALL versions, ignores orderId parameter
   - `/orderVersion/deps?masterid=X` - Correctly returns only the version for order X

2. **Order Enrichment Fix**:
   - Changed from using last version to finding matching version by orderId
   - Now uses `/orderVersion/deps?masterid=` for efficient, correct retrieval

## Running Tests

All scripts can be run with:
```bash
node tests/<script-name>.js
```

Make sure you have the `.env` file configured with Tradovate API credentials.