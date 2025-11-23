import dotenv from 'dotenv';
import TradovateClient from './src/services/tradovateClient.js';

// Load environment variables
dotenv.config({ path: '.env' });

console.log('=====================================');
console.log('Tradovate API Connection Test');
console.log('=====================================\n');

console.log('Configuration:');
console.log(`- Environment: ${process.env.TRADOVATE_USE_DEMO === 'true' ? 'DEMO' : 'LIVE'}`);
console.log(`- API URL: ${process.env.TRADOVATE_USE_DEMO === 'true' ? process.env.TRADOVATE_DEMO_URL : process.env.TRADOVATE_LIVE_URL}`);
console.log(`- CID: ${process.env.TRADOVATE_CID}`);
console.log(`- App ID: ${process.env.TRADOVATE_APP_ID}`);
console.log(`- Device ID: ${process.env.TRADOVATE_DEVICE_ID}`);
console.log('\n=====================================\n');

async function testConnection() {
  const client = new TradovateClient();

  try {
    // Step 1: Authenticate
    console.log('📡 Step 1: Authenticating with Tradovate API...');
    await client.authenticate();
    console.log('✅ Authentication successful!\n');

    // Step 2: Get accounts
    console.log('📊 Step 2: Fetching accounts...');
    const accounts = await client.getAccounts();
    console.log(`✅ Found ${accounts.length} account(s):\n`);

    for (const account of accounts) {
      console.log(`\nAccount: ${account.name} (ID: ${account.id})`);
      console.log(`- Nickname: ${account.nickname || 'N/A'}`);
      console.log(`- Active: ${account.active}`);
      console.log(`- Risk Category: ${account.riskCategoryId}`);

      // Step 3: Get account balance
      console.log('\n💰 Getting account balance...');
      try {
        const balance = await client.getAccountBalance(account.id);
        console.log(`- Balance: $${balance.balance?.toFixed(2) || 'N/A'}`);
        console.log(`- Equity: $${balance.equity?.toFixed(2) || 'N/A'}`);
        console.log(`- Available Funds: $${balance.availableFunds?.toFixed(2) || 'N/A'}`);
        console.log(`- Day P&L: $${balance.dayPnL?.toFixed(2) || '0.00'}`);
        console.log(`- Margin Used: $${balance.margin?.toFixed(2) || '0.00'}`);
      } catch (balanceError) {
        console.log(`⚠️ Could not fetch balance: ${balanceError.message}`);
      }

      // Step 4: Get margin snapshot
      console.log('\n📈 Getting margin snapshot...');
      try {
        const marginSnapshot = await client.getMarginSnapshot(account.id);
        if (marginSnapshot) {
          console.log(`- Initial Margin: $${marginSnapshot.initialMargin?.toFixed(2) || 'N/A'}`);
          console.log(`- Maintenance Margin: $${marginSnapshot.maintenanceMargin?.toFixed(2) || 'N/A'}`);
          console.log(`- Available Margin: $${marginSnapshot.availableMargin?.toFixed(2) || 'N/A'}`);
        }
      } catch (marginError) {
        console.log(`⚠️ Could not fetch margin snapshot: ${marginError.message}`);
      }

      // Step 5: Get positions
      console.log('\n📋 Getting positions...');
      try {
        const positions = await client.getPositions(account.id);
        console.log(`Raw positions data: ${JSON.stringify(positions, null, 2)}`);
        if (positions && positions.length > 0) {
          console.log(`Found ${positions.length} position(s):`);
          for (const position of positions) {
            // Get contract details
            let contractName = 'Unknown';
            try {
              const contract = await client.getContract(position.contractId);
              console.log(`Contract details: ${JSON.stringify(contract, null, 2)}`);
              contractName = contract.name;
            } catch (e) {
              console.log(`Could not get contract for ID ${position.contractId}: ${e.message}`);
            }
            console.log(`  - ${contractName}: ${position.netPos} @ ${position.netPrice || position.avgPrice || 'N/A'}`);
            console.log(`    Position details: ${JSON.stringify(position, null, 2)}`);
          }
        } else {
          console.log('No open positions');
        }
      } catch (posError) {
        console.log(`⚠️ Could not fetch positions: ${posError.message}`);
      }

      // Step 6: Get active orders
      console.log('\n📝 Getting active orders...');
      try {
        const orders = await client.getOrders(account.id);
        const activeOrders = orders.filter(o => o.ordStatus === 'Working');
        if (activeOrders.length > 0) {
          console.log(`Found ${activeOrders.length} active order(s):`);
          for (const order of activeOrders) {
            console.log(`  - Order ID: ${order.id}, Type: ${order.ordType}, Side: ${order.action}`);
          }
        } else {
          console.log('No active orders');
        }
      } catch (orderError) {
        console.log(`⚠️ Could not fetch orders: ${orderError.message}`);
      }

      // Step 7: Get recent fills
      console.log('\n💹 Getting recent fills (last 10)...');
      try {
        const fills = await client.getFills(account.id, 10);
        if (fills && fills.length > 0) {
          console.log(`Found ${fills.length} recent fill(s):`);
          for (const fill of fills.slice(0, 3)) {
            console.log(`  - ${fill.action} ${fill.qty} @ ${fill.price} (${new Date(fill.timestamp).toLocaleString()})`);
          }
        } else {
          console.log('No recent fills');
        }
      } catch (fillError) {
        console.log(`⚠️ Could not fetch fills: ${fillError.message}`);
      }
    }

    console.log('\n=====================================');
    console.log('✅ Connection test completed successfully!');
    console.log('=====================================\n');

  } catch (error) {
    console.error('\n❌ Connection test failed:');
    console.error(error.message);
    if (error.response?.data) {
      console.error('Server response:', error.response.data);
    }
    process.exit(1);
  } finally {
    client.disconnect();
  }
}

// Run the test
testConnection().then(() => {
  console.log('Test completed. Exiting...');
  process.exit(0);
}).catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});