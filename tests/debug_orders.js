#!/usr/bin/env node

// Load environment variables
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

import TradovateClient from './src/services/tradovateClient.js';

async function debugOrders() {
  console.log('🔍 DIRECT TRADOVATE API ORDER DEBUGGING');
  console.log('=====================================');

  try {
    // Create client and authenticate
    const client = new TradovateClient();
    console.log(`🔐 Authenticating with Tradovate ${process.env.TRADOVATE_USE_DEMO === 'true' ? 'DEMO' : 'LIVE'} environment...`);
    console.log(`🌐 Base URL: ${client.baseUrl}`);
    console.log(`👤 Username: ${process.env.TRADOVATE_USERNAME ? 'SET' : 'NOT SET'}`);

    await client.authenticate();
    console.log('✅ Authentication successful');

    // Get accounts
    console.log('📋 Getting accounts...');
    const accounts = await client.getAccounts();
    console.log(`✅ Found ${accounts.length} accounts:`, accounts.map(a => ({ id: a.id, name: a.name })));

    // For each account, get orders
    for (const account of accounts) {
      console.log(`\n🔍 Getting orders for account ${account.id} (${account.name}):`);
      console.log('================================================');

      try {
        // Test different ways to get orders
        console.log(`🔄 Calling: GET /order/list?accountId=${account.id}`);
        const orders = await client.getOrders(account.id);
        console.log(`📊 Raw API returned ${orders.length} orders`);

        // Also try to call the API directly with different parameters to see if we're missing something
        console.log(`\n🔬 Testing alternative API calls...`);

        try {
          // Try without enrichment (raw API call)
          const rawResponse = await client.api.get(`/order/list?accountId=${account.id}`);
          console.log(`📊 Raw /order/list returned ${rawResponse.data.length} orders`);

          // Show raw order structure
          if (rawResponse.data.length > 0) {
            console.log(`📋 First raw order structure:`, JSON.stringify(rawResponse.data[0], null, 2));
          }
        } catch (rawError) {
          console.error(`❌ Raw API call failed:`, rawError.message);
        }

        if (orders.length === 0) {
          console.log('❌ No orders found for this account');
          continue;
        }

        // Show all orders
        console.log('\n📋 ALL ORDERS:');
        orders.forEach((order, index) => {
          const price = order.price || order.limitPrice || order.stopPrice || order.workingPrice;
          console.log(`  ${index + 1}. Order ${order.id}:`);
          console.log(`     Status: ${order.ordStatus || order.status}`);
          console.log(`     Action: ${order.action}`);
          console.log(`     Type: ${order.orderType}`);
          console.log(`     Price: ${price || 'N/A'}`);
          console.log(`     Qty: ${order.orderQty}`);
          console.log(`     LinkedId: ${order.linkedId || 'None'}`);
          console.log('');
        });

        // Filter for working orders
        const workingOrders = orders.filter(order => {
          const status = order.ordStatus || order.status;
          return status && !['Filled', 'Canceled', 'Rejected'].includes(status);
        });

        console.log(`\n🔥 WORKING/ACTIVE ORDERS (${workingOrders.length}):`);
        if (workingOrders.length > 0) {
          workingOrders.forEach((order, index) => {
            const price = order.price || order.limitPrice || order.stopPrice || order.workingPrice;
            console.log(`  ${index + 1}. Order ${order.id}:`);
            console.log(`     Status: ${order.ordStatus || order.status}`);
            console.log(`     Action: ${order.action}`);
            console.log(`     Type: ${order.orderType}`);
            console.log(`     Price: ${price}`);
            console.log(`     LinkedId: ${order.linkedId || 'None'}`);

            // Check for your specific order
            if (price && price >= 24400 && price <= 24500) {
              console.log('     🎯 *** THIS MIGHT BE YOUR 24409 ORDER! ***');
            }
            console.log('');
          });
        } else {
          console.log('❌ No working orders found');
        }

        // Look specifically for orders around 24409
        const nearTarget = orders.filter(order => {
          const price = order.price || order.limitPrice || order.stopPrice || order.workingPrice;
          return price && price >= 24000 && price <= 25000;
        });

        if (nearTarget.length > 0) {
          console.log(`\n🎯 ORDERS IN 24000-25000 RANGE (${nearTarget.length}):`);
          nearTarget.forEach(order => {
            const price = order.price || order.limitPrice || order.stopPrice || order.workingPrice;
            console.log(`   Order ${order.id}: ${order.action} at ${price} (Status: ${order.ordStatus || order.status})`);
          });
        } else {
          console.log('\n❌ No orders found in 24000-25000 price range');

          // Show all prices to see what's actually there
          const allPrices = orders.map(order => order.price || order.limitPrice || order.stopPrice || order.workingPrice)
                                  .filter(price => price)
                                  .sort((a, b) => a - b);

          console.log('\n📊 All order prices found:', allPrices);
        }

      } catch (error) {
        console.error(`❌ Error getting orders for account ${account.id}:`, error.message);
      }
    }

  } catch (error) {
    console.error('❌ Script failed:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Run the script
debugOrders().then(() => {
  console.log('\n✅ Debug script completed');
  process.exit(0);
}).catch((error) => {
  console.error('💥 Script crashed:', error);
  process.exit(1);
});