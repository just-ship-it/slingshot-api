#!/usr/bin/env node

// Load environment variables
import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

import TradovateClient from '../src/services/tradovateClient.js';

async function testOrderVersionDeps() {
  console.log('🔬 TESTING /orderVersion/deps ENDPOINT');
  console.log('=======================================');
  console.log(`Test Time: ${new Date().toISOString()}\n`);
  console.log('📝 Based on Tradovate forum suggestion:');
  console.log('   Use /orderVersion/deps?masterid=orderId\n');

  try {
    // Create client and authenticate
    const client = new TradovateClient();
    console.log(`🔐 Authenticating...`);
    await client.authenticate();
    console.log('✅ Authentication successful\n');

    // Test order IDs from your rejected orders
    const testOrderIds = [11752018574, 11752018571, 11752018568, 11752018565, 11752018562];

    console.log('🧪 TEST 1: Compare /orderVersion/list vs /orderVersion/deps');
    console.log('-'.repeat(60));

    for (const orderId of testOrderIds) {
      console.log(`\n📋 Order #${orderId}:`);

      // Test the current approach
      console.log(`\n  A) /orderVersion/list?orderId=${orderId}`);
      try {
        const listResponse = await client.api.get(`/orderVersion/list?orderId=${orderId}`);
        const listVersions = listResponse.data;

        console.log(`     Received ${listVersions.length} versions`);
        const matchingList = listVersions.filter(v => v.orderId === orderId);
        const otherList = listVersions.filter(v => v.orderId !== orderId);
        console.log(`     - Matching orderId: ${matchingList.length}`);
        console.log(`     - Other orderIds: ${otherList.length}`);

        if (matchingList.length > 0) {
          const price = matchingList[0].price || matchingList[0].limitPrice || matchingList[0].stopPrice;
          console.log(`     - Price for this order: ${price}`);
        }
      } catch (error) {
        console.log(`     ❌ Error: ${error.message}`);
      }

      // Test the new deps approach
      console.log(`\n  B) /orderVersion/deps?masterid=${orderId}`);
      try {
        const depsResponse = await client.api.get(`/orderVersion/deps?masterid=${orderId}`);
        const depsVersions = depsResponse.data;

        console.log(`     Received ${depsVersions.length} versions`);

        if (depsVersions.length > 0) {
          // Check if these are actually for our order
          const uniqueOrderIds = [...new Set(depsVersions.map(v => v.orderId))];
          console.log(`     Order IDs in response: ${uniqueOrderIds.join(', ')}`);

          // Check for price data
          depsVersions.forEach((version, idx) => {
            const price = version.price || version.limitPrice || version.stopPrice;
            console.log(`     Version ${idx}: orderId=${version.orderId}, price=${price || 'none'}`);
          });
        }
      } catch (error) {
        console.log(`     ❌ Error: ${error.message}`);
      }

      // Test the deps approach with different parameter names
      console.log(`\n  C) /orderVersion/deps?masterId=${orderId} (capital I)`);
      try {
        const depsResponse = await client.api.get(`/orderVersion/deps?masterId=${orderId}`);
        const depsVersions = depsResponse.data;

        console.log(`     Received ${depsVersions.length} versions`);

        if (depsVersions.length > 0) {
          const uniqueOrderIds = [...new Set(depsVersions.map(v => v.orderId))];
          console.log(`     Order IDs in response: ${uniqueOrderIds.join(', ')}`);
        }
      } catch (error) {
        console.log(`     ❌ Error: ${error.message}`);
      }
    }

    console.log('\n🧪 TEST 2: Test with invalid orderId');
    console.log('-'.repeat(60));

    const invalidOrderId = 9999999999;

    console.log(`\n  /orderVersion/deps?masterid=${invalidOrderId}`);
    try {
      const response = await client.api.get(`/orderVersion/deps?masterid=${invalidOrderId}`);
      console.log(`  Received ${response.data.length} versions`);

      if (response.data.length > 0) {
        console.log(`  ⚠️ Still got versions for invalid ID!`);
        const uniqueOrderIds = [...new Set(response.data.map(v => v.orderId))];
        console.log(`  Order IDs: ${uniqueOrderIds.join(', ')}`);
      } else {
        console.log(`  ✅ Empty response for invalid ID`);
      }
    } catch (error) {
      console.log(`  Response: ${error.message}`);
    }

    console.log('\n📊 CONCLUSION:');
    console.log('='.repeat(60));
    console.log('Determine if /orderVersion/deps properly filters by order ID');
    console.log('and returns only the versions for the specified order.');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Run the test
testOrderVersionDeps().then(() => {
  console.log('\n✅ orderVersion/deps test completed');
  process.exit(0);
}).catch((error) => {
  console.error('💥 Test crashed:', error);
  process.exit(1);
});