#!/usr/bin/env node

import dotenv from 'dotenv';
import TradovateClient from '../src/services/tradovateClient.js';

dotenv.config({ path: '../.env' });

console.log('🔍 SIMPLE API ACCESS TEST');
console.log('=========================\n');

async function testSimpleAuth() {
  const client = new TradovateClient();

  try {
    console.log('🔐 Authentication test...');
    await client.authenticate();
    console.log('✅ Authentication successful!\n');

    // Test different endpoints to see what we have access to
    const testEndpoints = [
      { name: 'User Profile', endpoint: '/user/me' },
      { name: 'Account List', endpoint: '/account/list' },
      { name: 'Contract List', endpoint: '/contract/list' },
      { name: 'User Info', endpoint: '/userAccountAutoLiq/list' }
    ];

    for (const test of testEndpoints) {
      try {
        console.log(`📋 Testing ${test.name} (${test.endpoint})...`);
        const response = await client.api.get(test.endpoint);
        console.log(`✅ ${test.name}: SUCCESS - Got ${Array.isArray(response.data) ? response.data.length + ' items' : 'data'}`);
        if (test.endpoint === '/user/me') {
          console.log(`   User data: ${JSON.stringify(response.data, null, 2)}`);
        }
      } catch (error) {
        console.log(`❌ ${test.name}: FAILED - ${error.response?.status || error.message}`);
        if (error.response?.data) {
          console.log(`   Error details: ${JSON.stringify(error.response.data, null, 2)}`);
        }
      }
      console.log('');
    }

  } catch (error) {
    console.error('❌ Authentication failed:', error.message);
  } finally {
    client.disconnect();
  }
}

testSimpleAuth().catch(console.error);