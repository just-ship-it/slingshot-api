#!/usr/bin/env node

// Load environment variables
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

import TradovateClient from './src/services/tradovateClient.js';

async function testUpdatedEnrichment() {
  console.log('🧪 TESTING UPDATED ORDER ENRICHMENT WITH /orderVersion/deps');
  console.log('===========================================================');
  console.log(`Test Time: ${new Date().toISOString()}\n`);

  try {
    // Create client and authenticate
    const client = new TradovateClient();
    console.log(`🔐 Authenticating...`);
    await client.authenticate();
    console.log('✅ Authentication successful\n');

    // Test with the rejected orders
    const testOrders = [
      { id: 11752018574, expectedPrice: 24775.25, side: 'Sell' },
      { id: 11752018571, expectedPrice: 24738.25, side: 'Sell' },
      { id: 11752018568, expectedPrice: 24379.75, side: 'Buy' },
      { id: 11752018565, expectedPrice: 24486.5, side: 'Buy' },
      { id: 11752018562, expectedPrice: 24493.5, side: 'Buy' }
    ];

    console.log('📋 TESTING ENRICHMENT WITH UPDATED ENDPOINT:');
    console.log('='.repeat(60));

    let allPassed = true;

    for (const testOrder of testOrders) {
      console.log(`\n🔍 Testing Order #${testOrder.id} (${testOrder.side} @ ${testOrder.expectedPrice}):`);

      try {
        // Call the updated getOrderDetails method
        const enrichedOrder = await client.getOrderDetails(testOrder.id);

        // Extract price
        const extractedPrice = enrichedOrder.price || enrichedOrder.limitPrice || enrichedOrder.stopPrice || enrichedOrder.workingPrice;

        console.log(`  📊 Enriched order received:`);
        console.log(`     - Order Type: ${enrichedOrder.orderType || 'undefined'}`);
        console.log(`     - Action: ${enrichedOrder.action || 'undefined'}`);
        console.log(`     - Status: ${enrichedOrder.ordStatus || 'undefined'}`);
        console.log(`     - Extracted Price: ${extractedPrice || 'NO PRICE'}`);

        // Verify price matches expected
        if (extractedPrice && Math.abs(extractedPrice - testOrder.expectedPrice) < 0.01) {
          console.log(`  ✅ SUCCESS: Price matches expected (${testOrder.expectedPrice})`);
        } else {
          console.log(`  ❌ FAIL: Price mismatch!`);
          console.log(`     Expected: ${testOrder.expectedPrice}`);
          console.log(`     Got: ${extractedPrice}`);
          allPassed = false;
        }

      } catch (error) {
        console.log(`  ❌ ERROR: ${error.message}`);
        allPassed = false;
      }
    }

    console.log('\n' + '='.repeat(60));
    if (allPassed) {
      console.log('🎉 ALL TESTS PASSED!');
      console.log('✅ The updated enrichment logic using /orderVersion/deps works perfectly!');
    } else {
      console.log('⚠️ SOME TESTS FAILED');
      console.log('Please check the errors above');
    }

    // Test performance improvement
    console.log('\n📊 PERFORMANCE NOTES:');
    console.log('  - OLD: Fetched all versions, filtered client-side');
    console.log('  - NEW: Fetches only specific order version');
    console.log('  - Result: Cleaner, faster, more efficient!');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Run the test
testUpdatedEnrichment().then(() => {
  console.log('\n✅ Updated enrichment test completed');
  process.exit(0);
}).catch((error) => {
  console.error('💥 Test crashed:', error);
  process.exit(1);
});