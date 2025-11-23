#!/usr/bin/env node

// Load environment variables
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

import TradovateClient from './src/services/tradovateClient.js';

async function testOrderVersionAPI() {
  console.log('🔬 TESTING /orderVersion/list API PARAMETER BEHAVIOR');
  console.log('===================================================');
  console.log(`Test Time: ${new Date().toISOString()}\n`);

  try {
    // Create client and authenticate
    const client = new TradovateClient();
    console.log(`🔐 Authenticating...`);
    await client.authenticate();
    console.log('✅ Authentication successful\n');

    // Test order IDs from your rejected orders
    const testOrderIds = [11752018574, 11752018571, 11752018568];

    console.log('🧪 TEST 1: Does orderId parameter filter results?');
    console.log('-'.repeat(50));

    for (const orderId of testOrderIds) {
      console.log(`\n📋 Calling /orderVersion/list?orderId=${orderId}`);

      const response = await client.api.get(`/orderVersion/list?orderId=${orderId}`);
      const versions = response.data;

      console.log(`  Received ${versions.length} versions`);

      // Check if all versions are for the requested orderId
      const matchingVersions = versions.filter(v => v.orderId === orderId);
      const otherVersions = versions.filter(v => v.orderId !== orderId);

      console.log(`  - Versions for order ${orderId}: ${matchingVersions.length}`);
      console.log(`  - Versions for OTHER orders: ${otherVersions.length}`);

      if (otherVersions.length > 0) {
        console.log(`  ⚠️ API returned versions for OTHER orders too!`);
        const uniqueOrderIds = [...new Set(versions.map(v => v.orderId))];
        console.log(`  Order IDs in response: ${uniqueOrderIds.join(', ')}`);
      } else {
        console.log(`  ✅ API only returned versions for requested order`);
      }
    }

    console.log('\n🧪 TEST 2: What happens with invalid orderId?');
    console.log('-'.repeat(50));

    const invalidOrderId = 9999999999;
    console.log(`\n📋 Calling /orderVersion/list?orderId=${invalidOrderId}`);

    try {
      const response = await client.api.get(`/orderVersion/list?orderId=${invalidOrderId}`);
      const versions = response.data;

      console.log(`  Received ${versions.length} versions`);

      if (versions.length > 0) {
        console.log(`  ⚠️ API returned ${versions.length} versions even for invalid orderId!`);
        const uniqueOrderIds = [...new Set(versions.map(v => v.orderId))];
        console.log(`  Order IDs in response: ${uniqueOrderIds.join(', ')}`);
      } else {
        console.log(`  ✅ API returned empty array for invalid orderId`);
      }
    } catch (error) {
      console.log(`  ❌ API error: ${error.message}`);
    }

    console.log('\n🧪 TEST 3: What happens with NO orderId parameter?');
    console.log('-'.repeat(50));

    console.log(`\n📋 Calling /orderVersion/list (no parameters)`);

    try {
      const response = await client.api.get(`/orderVersion/list`);
      const versions = response.data;

      console.log(`  Received ${versions.length} versions`);

      if (versions.length > 0) {
        const uniqueOrderIds = [...new Set(versions.map(v => v.orderId))];
        console.log(`  Order IDs in response: ${uniqueOrderIds.join(', ')}`);
      }
    } catch (error) {
      console.log(`  ❌ API error: ${error.message}`);
    }

    console.log('\n🧪 TEST 4: What about accountId parameter?');
    console.log('-'.repeat(50));

    // Get account ID
    const accounts = await client.getAccounts();
    if (accounts.length > 0) {
      const accountId = accounts[0].id;

      console.log(`\n📋 Calling /orderVersion/list?accountId=${accountId}`);

      try {
        const response = await client.api.get(`/orderVersion/list?accountId=${accountId}`);
        const versions = response.data;

        console.log(`  Received ${versions.length} versions`);

        if (versions.length > 0) {
          const uniqueOrderIds = [...new Set(versions.map(v => v.orderId))];
          console.log(`  Order IDs in response: ${uniqueOrderIds.join(', ')}`);
        }
      } catch (error) {
        console.log(`  ❌ API error: ${error.message}`);
      }
    }

    console.log('\n📊 CONCLUSION:');
    console.log('='.repeat(50));
    console.log('Based on the tests above, we can determine:');
    console.log('1. Whether orderId parameter actually filters results');
    console.log('2. Whether we need the parameter at all');
    console.log('3. If there are other parameters we should be using');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Run the test
testOrderVersionAPI().then(() => {
  console.log('\n✅ API parameter test completed');
  process.exit(0);
}).catch((error) => {
  console.error('💥 Test crashed:', error);
  process.exit(1);
});