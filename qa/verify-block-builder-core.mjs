// Optional integration check. Creates and stops its OWN isolated Regtest node.
// Never reads ~/.bitcoin or connects to the user's RPC port. No keys are printed.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BitcoinRpcClient } from '../src/bitcoin-rpc.mjs';
import { ActionService } from '../src/actions.mjs';
import { ExplorerService } from '../src/explorer-service.mjs';

const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url));
await mkdir(runtime, { recursive: true });
const directory = await mkdtemp(path.join(runtime, 'builder-core-'));
const probe = net.createServer();
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const node = spawn('bitcoind', [`-datadir=${directory}`, '-regtest', '-server', '-listen=0', '-connect=0', '-dnsseed=0',
  '-rpcbind=127.0.0.1', `-rpcport=${port}`, '-rpcallowip=127.0.0.1', '-discover=0', '-printtoconsole=0',
  '-fallbackfee=0.00001'], { stdio: 'ignore' });
let launchError = false;
node.on('error', () => { launchError = true; });
let client, cookie;
try {
  for (let i = 0; i < 80; i++) {
    if (launchError || node.exitCode !== null) throw new Error('The isolated Bitcoin Core process could not start.');
    try {
      cookie = (await readFile(path.join(directory, 'regtest', '.cookie'), 'utf8')).trim();
      const separator = cookie.indexOf(':');
      client = new BitcoinRpcClient({ host: '127.0.0.1', port, username: cookie.slice(0, separator), password: cookie.slice(separator + 1) });
      if ((await client.call('getblockchaininfo')).chain === 'regtest') break;
      client = null;
    } catch { client = null; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(client, 'Isolated Core did not become ready');
  const bootstrap = async (method, params) => {
    const response = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', headers: {
      authorization: `Basic ${Buffer.from(cookie).toString('base64')}`, 'content-type': 'application/json'
    }, body: JSON.stringify({ jsonrpc: '1.0', id: 'isolated-bootstrap', method, params }), signal: AbortSignal.timeout(15_000), redirect: 'error' });
    const data = await response.json();
    if (data.error) throw new Error(`Isolated setup failed for ${method} (RPC ${data.error.code}).`);
    return data.result;
  };
  const wallet = 'builder-verification';
  await bootstrap('createwallet', { wallet_name: wallet, load_on_startup: false });
  const reward = await client.call('getnewaddress', ['', 'bech32'], wallet);
  await client.call('generatetoaddress', [105, reward], null, { timeoutMs: 30_000 });
  const pending = await client.call('sendtoaddress', { address: reward, amount: '0.01', fee_rate: '1' }, wallet);
  const actions = new ActionService({ bitcoin: client });
  const explorer = new ExplorerService({ bitcoin: client, electrum: { inspect: async () => ({}) } });
  const results = [];
  for (const count of [7, 20, 35, 125]) {
    const result = await actions.execute('build-block', { wallet, transactions: count, feeRate: '1', requestId: randomUUID(), confirmed: true });
    const block = await client.call('getblock', [result.hash, 2]);
    assert.equal(block.tx.length, count);
    assert.ok(block.tx[0].vin[0].coinbase);
    assert.ok(block.tx.slice(1).every((tx) => !tx.vin[0].coinbase));
    const ids = [];
    let offset = 0;
    do {
      const page = await explorer.block(result.hash, offset);
      assert.equal(page.transactions, count);
      ids.push(...page.txids); offset = page.nextOffset;
    } while (offset !== null);
    assert.deepEqual(ids, block.tx.map((tx) => tx.txid));
    assert.equal(new Set(ids).size, count);
    const detail = await explorer.transaction(ids.at(-1), result.hash);
    assert.equal(detail.feeSats, 110);
    const mempool = await client.call('getrawmempool');
    assert.ok(mempool.includes(pending), 'Unrelated pending transaction was unexpectedly mined');
    results.push({ transactions: count, transfers: count - 1, paginatedTransactions: ids.length, weight: block.weight });
  }
  console.log(JSON.stringify({ isolatedCore: 'passed', blocks: results, unrelatedMempoolTransactionPreserved: true, realUserChainTouched: false }));
} catch (error) {
  console.error(error instanceof assert.AssertionError ? error.message : `Isolated verification failed: ${error.code || error.message}`);
  process.exitCode = 1;
} finally {
  if (!launchError && node.exitCode === null) {
    const closed = once(node, 'exit');
    node.kill('SIGTERM');
    await closed;
  }
}
