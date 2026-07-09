// Generates the three demo wallets and writes .env (refuses to overwrite).
import { writeFileSync, existsSync } from 'node:fs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const envPath = new URL('../.env', import.meta.url).pathname;
if (existsSync(envPath)) {
  console.error('.env already exists; refusing to overwrite existing keys.');
  process.exit(1);
}

const agentPk = generatePrivateKey();
const facilitatorPk = generatePrivateKey();
const treasuryPk = generatePrivateKey();
const agent = privateKeyToAccount(agentPk);
const facilitator = privateKeyToAccount(facilitatorPk);
const treasury = privateKeyToAccount(treasuryPk);

writeFileSync(envPath, `# after-hours-dip-agent wallets (generated ${new Date().toISOString()})
# MAINNET KEYS - fund only with small demo amounts. Never commit this file.
AGENT_PRIVATE_KEY=${agentPk}
FACILITATOR_PRIVATE_KEY=${facilitatorPk}
TREASURY_PRIVATE_KEY=${treasuryPk}
TREASURY_ADDRESS=${treasury.address}
`);

console.log('.env written. Fund these on Robinhood Chain (chain 4663):\n');
console.log(`  agent       ${agent.address}`);
console.log('              needs: ~20 USDG (oracle fees + dip buys) + ~0.001 ETH (swap gas)');
console.log(`  facilitator ${facilitator.address}`);
console.log('              needs: ~0.001 ETH (settlement gas)');
console.log(`  treasury    ${treasury.address}`);
console.log('              needs: nothing (receives oracle revenue)');
