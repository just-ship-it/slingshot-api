#!/usr/bin/env node

// Load environment variables
import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

import TradovateClient from '../src/services/tradovateClient.js';

async function investigatePriceDiscrepancy() {
  console.log('🕵️  COMPREHENSIVE ORDER PRICE INVESTIGATION');
  console.log('==========================================');
  console.log(`Target Order: #11752018536 (should be 24409, API shows 23600)`);
  console.log(`Investigation Time: ${new Date().toISOString()}\n`);

  try {
    // Create client and authenticate
    const client = new TradovateClient();
    console.log(`🔐 Authenticating with Tradovate ${process.env.TRADOVATE_USE_DEMO === 'true' ? 'DEMO' : 'LIVE'} environment...`);
    await client.authenticate();
    console.log('✅ Authentication successful\n');

    // Get accounts
    const accounts = await client.getAccounts();
    console.log(`📋 Found ${accounts.length} accounts:`, accounts.map(a => ({ id: a.id, name: a.name })));

    for (const account of accounts) {
      console.log(`\n🔍 INVESTIGATING ACCOUNT ${account.id} (${account.name})`);
      console.log('='.repeat(60));

      try {
        // STEP 1: Get ALL orders (not just active ones)
        console.log(`\n📋 STEP 1: Getting ALL orders for last 24 hours...`);
        const allOrders = await client.getOrders(account.id);
        console.log(`📊 Total orders found: ${allOrders.length}`);

        // Filter orders from last 24 hours
        const last24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const recentOrders = allOrders.filter(order => {
          const orderTime = new Date(order.timestamp || order.created || 0);
          return orderTime > last24Hours;
        });

        console.log(`⏰ Orders from last 24 hours: ${recentOrders.length}`);

        // Show all recent orders with basic info
        if (recentOrders.length > 0) {
          console.log(`\n📋 RECENT ORDERS SUMMARY:`);
          recentOrders.forEach((order, index) => {
            const price = order.price || order.limitPrice || order.stopPrice || order.workingPrice;
            const timestamp = order.timestamp || order.created || 'N/A';
            console.log(`  ${index + 1}. Order ${order.id}: ${order.action} ${order.orderType || 'Unknown'} at ${price || 'N/A'} (${order.ordStatus || order.status}) - ${timestamp}`);
          });
        }

        // STEP 2: Deep dive into our target order #11752018536
        console.log(`\n🎯 STEP 2: DEEP DIVE INTO TARGET ORDER #11752018536`);
        console.log('-'.repeat(50));

        const targetOrder = allOrders.find(order => order.id === 11752018536);
        if (targetOrder) {
          console.log(`✅ Found target order in order list!`);
          console.log(`📋 Basic order data:`, JSON.stringify(targetOrder, null, 2));

          // Get detailed order information using direct API calls
          console.log(`\n🔍 Getting detailed order information via API...`);

          try {
            // Call the order details endpoint directly
            const orderDetailsResponse = await client.api.get(`/order/item?id=11752018536`);
            console.log(`\n📋 RAW ORDER DETAILS API RESPONSE:`);
            console.log(JSON.stringify(orderDetailsResponse.data, null, 2));

            // Call the order versions endpoint directly
            const orderVersionsResponse = await client.api.get(`/orderVersion/list?orderId=11752018536`);
            console.log(`\n📋 RAW ORDER VERSIONS API RESPONSE:`);
            console.log(JSON.stringify(orderVersionsResponse.data, null, 2));

            // Extract ALL possible price fields
            console.log(`\n💰 PRICE FIELD ANALYSIS:`);
            const orderData = orderDetailsResponse.data;
            const versionData = orderVersionsResponse.data;

            console.log(`Order Details Price Fields:`);
            console.log(`  - price: ${orderData.price || 'N/A'}`);
            console.log(`  - limitPrice: ${orderData.limitPrice || 'N/A'}`);
            console.log(`  - stopPrice: ${orderData.stopPrice || 'N/A'}`);
            console.log(`  - workingPrice: ${orderData.workingPrice || 'N/A'}`);
            console.log(`  - avgFillPrice: ${orderData.avgFillPrice || 'N/A'}`);

            if (versionData && versionData.length > 0) {
              console.log(`\nOrder Versions Price Fields (${versionData.length} versions):`);
              versionData.forEach((version, idx) => {
                console.log(`  Version ${idx + 1}:`);
                console.log(`    - price: ${version.price || 'N/A'}`);
                console.log(`    - limitPrice: ${version.limitPrice || 'N/A'}`);
                console.log(`    - stopPrice: ${version.stopPrice || 'N/A'}`);
                console.log(`    - workingPrice: ${version.workingPrice || 'N/A'}`);
                console.log(`    - timestamp: ${version.timestamp || version.created || 'N/A'}`);
              });
            }

          } catch (apiError) {
            console.error(`❌ Error getting detailed order info: ${apiError.message}`);
          }

        } else {
          console.log(`❌ Target order #11752018536 NOT found in order list`);

          // Try to get it directly via API
          console.log(`🔍 Attempting direct API call for order #11752018536...`);
          try {
            const directOrderResponse = await client.api.get(`/order/item?id=11752018536`);
            console.log(`✅ Direct API call successful:`);
            console.log(JSON.stringify(directOrderResponse.data, null, 2));
          } catch (directError) {
            console.error(`❌ Direct API call failed: ${directError.message}`);
          }
        }

        // STEP 3: Check bracket orders (stop and target)
        console.log(`\n🎯 STEP 3: CHECKING BRACKET ORDERS`);
        console.log('-'.repeat(50));

        const bracketOrders = [11752018537, 11752018538]; // Stop and Target
        for (const bracketOrderId of bracketOrders) {
          console.log(`\n🔍 Checking bracket order #${bracketOrderId}:`);

          const bracketOrder = allOrders.find(order => order.id === bracketOrderId);
          if (bracketOrder) {
            console.log(`✅ Found in order list:`);
            console.log(`  Price: ${bracketOrder.price || bracketOrder.limitPrice || bracketOrder.stopPrice || 'N/A'}`);
            console.log(`  Status: ${bracketOrder.ordStatus || bracketOrder.status}`);
            console.log(`  Type: ${bracketOrder.orderType}`);
          } else {
            console.log(`❌ Not found in order list, trying direct API...`);
            try {
              const directResponse = await client.api.get(`/order/item?id=${bracketOrderId}`);
              console.log(`✅ Direct API response:`);
              console.log(JSON.stringify(directResponse.data, null, 2));
            } catch (error) {
              console.error(`❌ Direct API failed: ${error.message}`);
            }
          }
        }

        // STEP 4: Show all price fields for all recent orders
        console.log(`\n📊 STEP 4: PRICE FIELD COMPARISON FOR ALL RECENT ORDERS`);
        console.log('-'.repeat(60));

        recentOrders.forEach(order => {
          console.log(`\nOrder ${order.id}:`);
          console.log(`  Raw object price fields:`);
          Object.keys(order).filter(key => key.toLowerCase().includes('price')).forEach(key => {
            console.log(`    ${key}: ${order[key]}`);
          });

          // Show our current price extraction logic
          const extractedPrice = order.price || order.limitPrice || order.stopPrice || order.workingPrice;
          console.log(`  Extracted price (current logic): ${extractedPrice}`);
        });

      } catch (error) {
        console.error(`❌ Error investigating account ${account.id}:`, error.message);
      }
    }

  } catch (error) {
    console.error('❌ Investigation failed:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Run the investigation
investigatePriceDiscrepancy().then(() => {
  console.log('\n✅ Price investigation completed');
  console.log('\n🎯 NEXT STEPS:');
  console.log('1. Compare API price fields with Tradovate UI');
  console.log('2. Identify which field contains the correct price (24409)');
  console.log('3. Update slingshot code to use correct price field');
  process.exit(0);
}).catch((error) => {
  console.error('💥 Investigation crashed:', error);
  process.exit(1);
});