#!/usr/bin/env node

// Load environment variables
import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

import TradovateClient from '../src/services/tradovateClient.js';

async function testFixedEnrichment() {
  console.log('🧪 TESTING FIXED ORDER ENRICHMENT LOGIC');
  console.log('=======================================');
  console.log(`Target Order: #11752018536`);
  console.log(`Expected Price: 24409`);
  console.log(`Test Time: ${new Date().toISOString()}\n`);

  try {
    // Create client and authenticate
    const client = new TradovateClient();
    console.log(`🔐 Authenticating...`);
    await client.authenticate();
    console.log('✅ Authentication successful\n');

    // Test the fixed enrichment logic
    console.log(`🔬 TESTING ENRICHED ORDER DETAILS`);
    console.log('================================');

    const enrichedOrder = await client.getOrderDetails(11752018536);

    console.log(`✅ Enriched order received:`);
    console.log(JSON.stringify(enrichedOrder, null, 2));

    console.log(`\n💰 Price extraction test:`);
    const extractedPrice = enrichedOrder.price || enrichedOrder.limitPrice || enrichedOrder.stopPrice || enrichedOrder.workingPrice;
    console.log(`  Extracted price: ${extractedPrice}`);

    if (extractedPrice == 24409) {
      console.log(`\n🎉 SUCCESS! Fixed enrichment logic correctly extracted price: ${extractedPrice}`);
    } else if (extractedPrice == 23600) {
      console.log(`\n❌ STILL BROKEN: Still extracting wrong price: ${extractedPrice}`);
    } else {
      console.log(`\n⚠️  UNEXPECTED: Extracted unexpected price: ${extractedPrice}`);
    }

    // Test with a few other recent orders to make sure we didn't break anything
    console.log(`\n🔍 Testing other bracket orders for completeness:`);

    const bracketOrderIds = [11752018537, 11752018538]; // Stop and target
    for (const bracketOrderId of bracketOrderIds) {
      try {
        const bracketOrder = await client.getOrderDetails(bracketOrderId);
        const bracketPrice = bracketOrder.price || bracketOrder.limitPrice || bracketOrder.stopPrice || bracketOrder.workingPrice;
        console.log(`  Order #${bracketOrderId}: ${bracketOrder.orderType} at ${bracketPrice}`);
      } catch (error) {
        console.log(`  Order #${bracketOrderId}: Error - ${error.message}`);
      }
    }

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Run the test
testFixedEnrichment().then(() => {
  console.log('\n✅ Fixed enrichment test completed');
  console.log('\n🎯 If the price is now 24409, the fix is successful!');
  process.exit(0);
}).catch((error) => {
  console.error('💥 Test crashed:', error);
  process.exit(1);
});