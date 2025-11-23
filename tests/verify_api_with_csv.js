#!/usr/bin/env node

// Load environment variables
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

import TradovateClient from './src/services/tradovateClient.js';
import fs from 'fs';
import path from 'path';

// Parse CSV data from TradingView export
function parseCSV(csvContent) {
  const lines = csvContent.trim().split('\n');
  const headers = lines[0].split(',');
  const orders = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    const order = {};
    headers.forEach((header, index) => {
      order[header] = values[index];
    });
    orders.push(order);
  }

  return orders;
}

async function verifyAPIWithCSV() {
  console.log('🔬 VERIFYING API DATA AGAINST TRADINGVIEW CSV EXPORT');
  console.log('=====================================================');
  console.log(`Verification Time: ${new Date().toISOString()}\n`);

  // Read the CSV file
  const csvPath = path.join(process.cwd(), 'logs', 'tradovate orders.csv');
  console.log(`📄 Reading CSV from: ${csvPath}`);

  const csvContent = fs.readFileSync(csvPath, 'utf8');
  const csvOrders = parseCSV(csvContent);

  console.log(`✅ Found ${csvOrders.length} orders in CSV\n`);
  console.log('📊 CSV ORDERS (Ground Truth):');
  console.log('='.repeat(60));

  csvOrders.forEach(order => {
    console.log(`  Order #${order['Order ID']}: ${order.Side} ${order.Type} @ ${order['Limit Price']} - ${order.Status}`);
  });

  try {
    // Create client and authenticate
    const client = new TradovateClient();
    console.log(`\n🔐 Authenticating with Tradovate API...`);
    await client.authenticate();
    console.log('✅ Authentication successful\n');

    // Get accounts
    const accounts = await client.getAccounts();
    console.log(`📋 Found ${accounts.length} accounts\n`);

    // Create a map for CSV orders for easy lookup
    const csvOrderMap = new Map();
    csvOrders.forEach(order => {
      csvOrderMap.set(order['Order ID'], order);
    });

    for (const account of accounts) {
      console.log(`\n🔍 CHECKING ACCOUNT ${account.id} (${account.name})`);
      console.log('='.repeat(60));

      try {
        // Get ALL orders from API
        console.log(`\n📋 Getting all orders from API...`);
        const apiOrders = await client.getOrders(account.id);
        console.log(`📊 Total orders from API: ${apiOrders.length}`);

        // Filter for our test order IDs from CSV
        const testOrderIds = csvOrders.map(o => parseInt(o['Order ID']));
        const matchingOrders = apiOrders.filter(o => testOrderIds.includes(o.id));

        console.log(`\n✅ Found ${matchingOrders.length} matching orders in API\n`);

        console.log('🔍 DETAILED COMPARISON:');
        console.log('='.repeat(60));

        // For each CSV order, check if we can find it in API
        for (const csvOrder of csvOrders) {
          const orderId = parseInt(csvOrder['Order ID']);
          const apiOrder = matchingOrders.find(o => o.id === orderId);

          console.log(`\n📌 Order #${orderId}:`);
          console.log('  CSV Data:');
          console.log(`    - Side: ${csvOrder.Side}`);
          console.log(`    - Type: ${csvOrder.Type}`);
          console.log(`    - Limit Price: ${csvOrder['Limit Price']}`);
          console.log(`    - Status: ${csvOrder.Status}`);

          if (apiOrder) {
            console.log('  API Basic Order:');
            console.log(`    - Action: ${apiOrder.action || 'undefined'}`);
            console.log(`    - Type: ${apiOrder.orderType || 'undefined'}`);
            console.log(`    - Status: ${apiOrder.ordStatus || 'undefined'}`);
            console.log(`    - Price fields:`);
            console.log(`      • price: ${apiOrder.price || 'undefined'}`);
            console.log(`      • limitPrice: ${apiOrder.limitPrice || 'undefined'}`);
            console.log(`      • stopPrice: ${apiOrder.stopPrice || 'undefined'}`);
            console.log(`      • workingPrice: ${apiOrder.workingPrice || 'undefined'}`);

            // Test enrichment
            console.log(`\n  🔬 Testing Enrichment for #${orderId}:`);
            try {
              const enrichedOrder = await client.getOrderDetails(orderId);

              console.log('  Enriched Order:');
              console.log(`    - Type: ${enrichedOrder.orderType}`);
              console.log(`    - Price: ${enrichedOrder.price || 'undefined'}`);
              console.log(`    - Limit Price: ${enrichedOrder.limitPrice || 'undefined'}`);
              console.log(`    - Stop Price: ${enrichedOrder.stopPrice || 'undefined'}`);

              // Extract price and compare with CSV
              const extractedPrice = enrichedOrder.price || enrichedOrder.limitPrice || enrichedOrder.stopPrice || enrichedOrder.workingPrice;
              const csvPrice = parseFloat(csvOrder['Limit Price']);

              console.log(`\n  💰 Price Comparison:`);
              console.log(`    CSV Price: ${csvPrice}`);
              console.log(`    API Extracted: ${extractedPrice || 'NO PRICE'}`);

              if (extractedPrice && Math.abs(extractedPrice - csvPrice) < 0.01) {
                console.log(`    ✅ MATCH! Prices are identical`);
              } else if (extractedPrice) {
                console.log(`    ⚠️ MISMATCH! Difference: ${Math.abs(extractedPrice - csvPrice)}`);
              } else {
                console.log(`    ❌ NO PRICE found in API data`);
              }

              // Check order versions
              console.log(`\n  📋 Order Versions Analysis:`);
              const versionsResponse = await client.api.get(`/orderVersion/list?orderId=${orderId}`);
              const versions = versionsResponse.data;
              console.log(`    Total versions: ${versions.length}`);

              if (versions.length > 0) {
                // Find matching version
                const matchingVersion = versions.find(v => v.orderId === orderId);
                if (matchingVersion) {
                  const versionPrice = matchingVersion.price || matchingVersion.limitPrice || matchingVersion.stopPrice;
                  console.log(`    Matching version found:`);
                  console.log(`      - Version ID: ${matchingVersion.id}`);
                  console.log(`      - Price: ${versionPrice || 'undefined'}`);

                  if (versionPrice && Math.abs(versionPrice - csvPrice) < 0.01) {
                    console.log(`      ✅ Version price matches CSV!`);
                  }
                } else {
                  console.log(`    ⚠️ No version with orderId=${orderId}`);
                }

                // Show all versions for debugging
                console.log(`\n    All versions (for debugging):`);
                versions.forEach((v, idx) => {
                  const vPrice = v.price || v.limitPrice || v.stopPrice;
                  console.log(`      [${idx}] OrderID: ${v.orderId}, Price: ${vPrice || 'none'}`);
                });
              }

            } catch (enrichError) {
              console.log(`  ❌ Enrichment failed: ${enrichError.message}`);
            }

          } else {
            console.log(`  ❌ NOT FOUND in API response!`);
          }
        }

        // Summary
        console.log(`\n📊 VERIFICATION SUMMARY:`);
        console.log('='.repeat(60));
        console.log(`  CSV Orders: ${csvOrders.length}`);
        console.log(`  Found in API: ${matchingOrders.length}`);
        console.log(`  Missing: ${csvOrders.length - matchingOrders.length}`);

        if (matchingOrders.length < csvOrders.length) {
          const missingIds = csvOrders
            .filter(csvOrder => !matchingOrders.find(apiOrder => apiOrder.id === parseInt(csvOrder['Order ID'])))
            .map(o => o['Order ID']);
          console.log(`  Missing Order IDs: ${missingIds.join(', ')}`);
        }

      } catch (error) {
        console.error(`❌ Error checking account ${account.id}:`, error.message);
      }
    }

  } catch (error) {
    console.error('❌ Verification failed:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Run the verification
verifyAPIWithCSV().then(() => {
  console.log('\n✅ API verification completed');
  console.log('\n🎯 Key things to check:');
  console.log('  1. Are all CSV orders found in the API?');
  console.log('  2. Do the prices match between CSV and API?');
  console.log('  3. Is the enrichment logic working correctly?');
  console.log('  4. Are order versions being retrieved properly?');
  process.exit(0);
}).catch((error) => {
  console.error('💥 Verification crashed:', error);
  process.exit(1);
});