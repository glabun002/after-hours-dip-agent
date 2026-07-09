// Generates a FRESH facilitator key for production and prints it to stdout.
// Nothing is written to disk: paste the key into your hosting platform's
// environment variables, fund the address with a little ETH, and forget it here.
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const pk = generatePrivateKey();
const account = privateKeyToAccount(pk);

console.log('Fresh production facilitator wallet (NOT saved anywhere):\n');
console.log(`  FACILITATOR_PRIVATE_KEY=${pk}`);
console.log(`  address: ${account.address}\n`);
console.log('Next steps:');
console.log('  1. Set FACILITATOR_PRIVATE_KEY on your hosting platform (env var, not a file).');
console.log('  2. Fund the address above with ~0.002 ETH on Robinhood Chain (settlement gas).');
console.log('  3. Also set TREASURY_ADDRESS (receives USDG; its key never goes on the server)');
console.log('     and RPC_URL (an Alchemy endpoint for chain 4663).');
