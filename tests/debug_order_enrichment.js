#!/usr/bin/env node

// Load environment variables
import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

import TradovateClient from '../src/services/tradovateClient.js';

async function debugOrderEnrichment() {
  console.log('🎯 TARGETED ORDER ENRICHMENT DEBUG');
  console.log('==================================');
  console.log(`Target Order: #11752018536`);
  console.log(`Expected Price: 24409`);
  console.log(`Reported Price: 23600`);
  console.log(`Debug Time: ${new Date().toISOString()}\n`);

  try {
    // Create client and authenticate
    const client = new TradovateClient();
    console.log(`🔐 Authenticating...`);
    await client.authenticate();
    console.log('✅ Authentication successful\n');

    const targetOrderId = 11752018536;

    // STEP 1: Get basic order details (should have no price)
    console.log(`📋 STEP 1: Basic Order Details API Call`);
    console.log(`🔄 GET /order/item?id=${targetOrderId}`);

    let basicOrderDetails = null;
    try {
      const response = await client.api.get(`/order/item?id=${targetOrderId}`);
      basicOrderDetails = response.data;
      console.log(`✅ Basic order details received:`);
      console.log(JSON.stringify(basicOrderDetails, null, 2));

      console.log(`\n📊 Price fields in basic details:`);
      console.log(`  - price: ${basicOrderDetails.price || 'undefined'}`);
      console.log(`  - limitPrice: ${basicOrderDetails.limitPrice || 'undefined'}`);
      console.log(`  - stopPrice: ${basicOrderDetails.stopPrice || 'undefined'}`);
      console.log(`  - workingPrice: ${basicOrderDetails.workingPrice || 'undefined'}`);
      console.log(`  - avgFillPrice: ${basicOrderDetails.avgFillPrice || 'undefined'}`);

    } catch (error) {
      console.error(`⚠️ Basic order details failed: ${error.message}`);
      console.log(`📝 Note: Order may be archived/cancelled. Will try order versions anyway...`);
      // Create a minimal order object for testing
      basicOrderDetails = {
        id: targetOrderId,
        ordStatus: 'Unknown (failed to fetch)'
      };
    }

    // STEP 2: Get order versions (should have prices)
    console.log(`\n📋 STEP 2: Order Versions API Call`);
    console.log(`🔄 GET /orderVersion/list?orderId=${targetOrderId}`);

    let orderVersions = null;
    try {
      const response = await client.api.get(`/orderVersion/list?orderId=${targetOrderId}`);
      orderVersions = response.data;
      console.log(`✅ Order versions received: ${orderVersions.length} versions`);

      console.log(`\n📊 ALL ORDER VERSIONS:`);
      orderVersions.forEach((version, index) => {
        console.log(`\n  Version ${index + 1}:`);
        console.log(`    - id: ${version.id}`);
        console.log(`    - orderId: ${version.orderId}`);
        console.log(`    - price: ${version.price || 'undefined'}`);
        console.log(`    - limitPrice: ${version.limitPrice || 'undefined'}`);
        console.log(`    - stopPrice: ${version.stopPrice || 'undefined'}`);
        console.log(`    - workingPrice: ${version.workingPrice || 'undefined'}`);
        console.log(`    - orderType: ${version.orderType || 'undefined'}`);
        console.log(`    - timestamp: ${version.timestamp || version.created || 'undefined'}`);
        console.log(`    - timeInForce: ${version.timeInForce || 'undefined'}`);
      });

    } catch (error) {
      console.error(`❌ Order versions failed: ${error.message}`);
      return;
    }

    // STEP 3: Simulate OLD slingshot logic (BEFORE FIX)
    console.log(`\n📋 STEP 3: Simulating OLD Slingshot Logic (BEFORE FIX)`);
    console.log(`🔄 Old logic: orderVersions[orderVersions.length - 1]`);

    if (orderVersions && orderVersions.length > 0) {
      const latestVersion = orderVersions[orderVersions.length - 1];
      console.log(`\n📊 "Latest" version selected (array index ${orderVersions.length - 1}):`);
      console.log(JSON.stringify(latestVersion, null, 2));

      console.log(`\n💰 Price from "latest" version:`);
      console.log(`  - price: ${latestVersion.price || 'undefined'}`);
      console.log(`  - limitPrice: ${latestVersion.limitPrice || 'undefined'}`);
      console.log(`  - stopPrice: ${latestVersion.stopPrice || 'undefined'}`);

      // Simulate the merge operation
      const enrichedOrderOld = {
        ...basicOrderDetails,     // Basic order data
        ...latestVersion,        // Latest version data
        // Keep original fields that might be overwritten
        id: basicOrderDetails.id,
        ordStatus: basicOrderDetails.ordStatus
      };

      console.log(`\n💰 OLD LOGIC extracted price:`);
      const extractedPriceOld = enrichedOrderOld.price || enrichedOrderOld.limitPrice || enrichedOrderOld.stopPrice || enrichedOrderOld.workingPrice;
      console.log(`  Extracted price: ${extractedPriceOld}`);

      // STEP 4: Simulate NEW FIXED slingshot logic
      console.log(`\n📋 STEP 4: Simulating NEW FIXED Slingshot Logic`);
      console.log(`🔄 New logic: orderVersions.find(version => version.orderId === ${targetOrderId})`);

      const matchingVersion = orderVersions.find(version => version.orderId === targetOrderId);

      if (matchingVersion) {
        console.log(`\n✅ Found matching version for order ${targetOrderId}:`);
        console.log(JSON.stringify(matchingVersion, null, 2));

        console.log(`\n💰 Price from matching version:`);
        console.log(`  - price: ${matchingVersion.price || 'undefined'}`);
        console.log(`  - limitPrice: ${matchingVersion.limitPrice || 'undefined'}`);
        console.log(`  - stopPrice: ${matchingVersion.stopPrice || 'undefined'}`);

        const enrichedOrderNew = {
          ...basicOrderDetails,     // Basic order data
          ...matchingVersion,       // Matching version data
          // Keep original fields that might be overwritten
          id: basicOrderDetails.id,
          ordStatus: basicOrderDetails.ordStatus
        };

        console.log(`\n📊 Final enriched order (after NEW fix):`);
        console.log(JSON.stringify(enrichedOrderNew, null, 2));

        console.log(`\n💰 NEW LOGIC extracted price:`);
        const extractedPriceNew = enrichedOrderNew.price || enrichedOrderNew.limitPrice || enrichedOrderNew.stopPrice || enrichedOrderNew.workingPrice;
        console.log(`  Extracted price: ${extractedPriceNew}`);

        // STEP 5: Analysis and recommendations
        console.log(`\n📋 STEP 5: Analysis & Diagnosis`);
        console.log('='.repeat(40));

        console.log(`\n🔍 COMPARISON OF OLD vs NEW LOGIC:`);
        console.log(`  OLD LOGIC (last version): ${extractedPriceOld}`);
        console.log(`  NEW LOGIC (matching version): ${extractedPriceNew}`);
        console.log(`  EXPECTED PRICE: 24409`);

        if (extractedPriceNew == 24409) {
          console.log(`\n🎉 SUCCESS! NEW LOGIC correctly extracts price: ${extractedPriceNew}`);
          if (extractedPriceOld != 24409) {
            console.log(`✅ This FIXES the issue! Old logic gave ${extractedPriceOld}, new logic gives ${extractedPriceNew}`);
          }
        } else if (extractedPriceNew == 23600) {
          console.log(`\n❌ NEW LOGIC still extracts wrong price: ${extractedPriceNew}`);
        } else {
          console.log(`\n⚠️  UNEXPECTED: NEW LOGIC extracted unexpected price: ${extractedPriceNew}`);
        }

        // Show all versions with the target order ID
        const versionsWithTargetId = orderVersions.filter(v => v.orderId === targetOrderId);
        console.log(`\n📊 Versions with orderId=${targetOrderId}: ${versionsWithTargetId.length}`);
        if (versionsWithTargetId.length > 0) {
          versionsWithTargetId.forEach((version, idx) => {
            const versionIndex = orderVersions.findIndex(v => v.id === version.id);
            console.log(`  Version at index ${versionIndex}: price=${version.price}, orderType=${version.orderType}`);
          });
        }

      } else {
        console.log(`\n⚠️ No matching version found for orderId ${targetOrderId}`);
      }

    } else {
      console.log(`❌ No order versions found`);
    }

  } catch (error) {
    console.error('❌ Debug failed:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Run the debug
debugOrderEnrichment().then(() => {
  console.log('\n✅ Order enrichment debug completed');
  console.log('\n🎯 Use the analysis above to fix the version selection logic in tradovateClient.js');
  process.exit(0);
}).catch((error) => {
  console.error('💥 Debug crashed:', error);
  process.exit(1);
});