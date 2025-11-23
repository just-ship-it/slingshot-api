#!/usr/bin/env node

// Load environment variables
import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

import TradovateClient from '../src/services/tradovateClient.js';

async function testRejectedOrders() {
  console.log('🧪 TESTING REJECTED ORDERS DATA RETRIEVAL');
  console.log('=========================================');
  console.log(`Test Time: ${new Date().toISOString()}\n`);

  try {
    // Create client and authenticate
    const client = new TradovateClient();
    console.log(`🔐 Authenticating...`);
    await client.authenticate();
    console.log('✅ Authentication successful\n');

    // Get accounts
    const accounts = await client.getAccounts();
    console.log(`📋 Found ${accounts.length} accounts\n`);

    for (const account of accounts) {
      console.log(`\n🔍 CHECKING ACCOUNT ${account.id} (${account.name})`);
      console.log('='.repeat(60));

      try {
        // Get ALL orders for the account
        console.log(`\n📋 Getting all orders for account ${account.id}...`);
        const allOrders = await client.getOrders(account.id);
        console.log(`📊 Total orders found: ${allOrders.length}`);

        // Filter for rejected orders
        const rejectedOrders = allOrders.filter(o =>
          o.ordStatus === 'Rejected' ||
          o.rejectReason ||
          o.ordRejReason
        );

        console.log(`\n🚫 REJECTED ORDERS: ${rejectedOrders.length}`);

        if (rejectedOrders.length > 0) {
          console.log('\n📝 REJECTED ORDER DETAILS:');
          console.log('='.repeat(60));

          for (const order of rejectedOrders) {
            console.log(`\n📌 Order #${order.id}:`);
            console.log(`  Status: ${order.ordStatus}`);
            console.log(`  Type: ${order.orderType}`);
            console.log(`  Action: ${order.action}`);
            console.log(`  Reject Reason: ${order.rejectReason || order.ordRejReason || 'Not specified'}`);

            // Show all price fields from basic order
            console.log(`\n  📊 Price fields from basic order:`);
            console.log(`    - price: ${order.price || 'undefined'}`);
            console.log(`    - limitPrice: ${order.limitPrice || 'undefined'}`);
            console.log(`    - stopPrice: ${order.stopPrice || 'undefined'}`);
            console.log(`    - workingPrice: ${order.workingPrice || 'undefined'}`);

            // Now test our ENRICHMENT logic
            console.log(`\n  🔬 Testing Order Enrichment for #${order.id}:`);
            console.log('  ' + '-'.repeat(40));

            try {
              // Get enriched order details using our fixed logic
              const enrichedOrder = await client.getOrderDetails(order.id);

              console.log(`  ✅ Enriched order received`);
              console.log(`\n  📊 Price fields after enrichment:`);
              console.log(`    - price: ${enrichedOrder.price || 'undefined'}`);
              console.log(`    - limitPrice: ${enrichedOrder.limitPrice || 'undefined'}`);
              console.log(`    - stopPrice: ${enrichedOrder.stopPrice || 'undefined'}`);
              console.log(`    - workingPrice: ${enrichedOrder.workingPrice || 'undefined'}`);
              console.log(`    - orderType: ${enrichedOrder.orderType}`);

              // Extract the price
              const extractedPrice = enrichedOrder.price || enrichedOrder.limitPrice || enrichedOrder.stopPrice || enrichedOrder.workingPrice;
              console.log(`\n  💰 Extracted price: ${extractedPrice || 'NO PRICE FOUND'}`);

              // Check for bracket orders
              if (enrichedOrder.linkedId) {
                console.log(`\n  🔗 Has linked order: #${enrichedOrder.linkedId}`);

                // Try to get the linked order details
                try {
                  const linkedOrder = await client.getOrderDetails(enrichedOrder.linkedId);
                  const linkedPrice = linkedOrder.price || linkedOrder.limitPrice || linkedOrder.stopPrice || linkedOrder.workingPrice;
                  console.log(`    Linked order type: ${linkedOrder.orderType}`);
                  console.log(`    Linked order price: ${linkedPrice || 'undefined'}`);
                } catch (linkError) {
                  console.log(`    ❌ Could not fetch linked order: ${linkError.message}`);
                }
              }

              // Test order versions directly
              console.log(`\n  📋 Testing Order Versions API:`);
              const versionsResponse = await client.api.get(`/orderVersion/list?orderId=${order.id}`);
              const versions = versionsResponse.data;
              console.log(`    Found ${versions.length} version(s)`);

              if (versions.length > 0) {
                // Show what OLD logic would select
                const oldLogicVersion = versions[versions.length - 1];
                console.log(`\n    🔴 OLD LOGIC (last version):`);
                console.log(`      Would select version ID: ${oldLogicVersion.id}`);
                console.log(`      Price: ${oldLogicVersion.price || oldLogicVersion.limitPrice || oldLogicVersion.stopPrice || 'undefined'}`);

                // Show what NEW logic selects
                const newLogicVersion = versions.find(v => v.orderId === order.id);
                if (newLogicVersion) {
                  console.log(`\n    🟢 NEW LOGIC (matching orderId):`);
                  console.log(`      Selected version ID: ${newLogicVersion.id}`);
                  console.log(`      Price: ${newLogicVersion.price || newLogicVersion.limitPrice || newLogicVersion.stopPrice || 'undefined'}`);

                  if (oldLogicVersion.id !== newLogicVersion.id) {
                    console.log(`\n    ⚠️  DIFFERENT VERSIONS SELECTED!`);
                    console.log(`      Old would pick: ${oldLogicVersion.price || 'no price'}`);
                    console.log(`      New picks: ${newLogicVersion.price || 'no price'}`);
                  }
                } else {
                  console.log(`\n    ⚠️  No version found with orderId=${order.id}`);
                }

                // List all versions for debugging
                console.log(`\n    📜 All versions:`);
                versions.forEach((v, idx) => {
                  const vPrice = v.price || v.limitPrice || v.stopPrice;
                  console.log(`      [${idx}] ID: ${v.id}, OrderID: ${v.orderId}, Price: ${vPrice || 'none'}`);
                });
              }

            } catch (enrichError) {
              console.log(`  ❌ Enrichment failed: ${enrichError.message}`);
            }
          }
        }

        // Also show any recent orders (last 10)
        console.log(`\n📋 MOST RECENT ORDERS (for context):`);
        console.log('='.repeat(60));
        const recentOrders = allOrders.slice(-10);
        recentOrders.forEach(order => {
          const price = order.price || order.limitPrice || order.stopPrice || order.workingPrice;
          console.log(`  #${order.id}: ${order.action} ${order.orderType} @ ${price || 'N/A'} - ${order.ordStatus}`);
        });

      } catch (error) {
        console.error(`❌ Error checking account ${account.id}:`, error.message);
      }
    }

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Run the test
testRejectedOrders().then(() => {
  console.log('\n✅ Rejected orders test completed');
  console.log('\n💡 Check the output above to verify:');
  console.log('  1. Rejected orders are being found');
  console.log('  2. Order enrichment is working correctly');
  console.log('  3. The correct price is being extracted');
  console.log('  4. NEW logic selects the right version (matching orderId)');
  process.exit(0);
}).catch((error) => {
  console.error('💥 Test crashed:', error);
  process.exit(1);
});