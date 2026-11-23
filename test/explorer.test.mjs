import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ExplorerService, ExplorerError, scriptHash } from '../src/explorer-service.mjs';
import { createExplorerSample } from '../src/explorer-sample.mjs';
import { createAppServer } from '../server.mjs';

function setup() { const fixture = createExplorerSample(); return { fixture, service: new ExplorerService(fixture) }; }

test('explorer follows blocks, confirmed transactions, prevouts, addresses and mempool without writes', async () => {
  const { fixture, service } = setup();
  const overview = await service.overview();
  assert.equal(overview.connected, true);
  assert.equal(overview.chain.height, 148);
  assert.equal(overview.index.height, 148);
  assert.equal(overview.mempool.count, 9);
  const block = await service.block('148');
  const tx = await service.transaction(block.txids[1], block.hash);
  assert.equal(tx.confirmations, 1);
  assert.equal(tx.inputs[0].valueSats, 5000000000);
  assert.equal(tx.feeSats, tx.inputs[0].valueSats - tx.totalOutputSats);
  const address = await service.address(tx.outputs[0].address);
  assert.ok(address.history.some((entry) => entry.txid === tx.txid));
  assert.equal(address.indexHeight, address.coreHeight);
  assert.ok(address.confirmedSats > 0);
  const allowed = ['getblockchaininfo', 'getblockhash', 'getblock', 'getrawtransaction', 'getmempoolinfo', 'getrawmempool', 'validateaddress'];
  assert.ok(fixture.bitcoin.calls.every((call) => allowed.includes(call.method)));
});

test('block pagination traverses to genesis, with no gaps or repeats', async () => {
  const { service } = setup();
  let start = null;
  const heights = [];
  do { const page = await service.blocks(start); heights.push(...page.blocks.map((b) => b.height)); start = page.next; } while (start !== null);
  assert.deepEqual(heights, Array.from({ length: 149 }, (_, i) => 148 - i));
});

test('search resolves heights, block hashes, transaction IDs and valid addresses', async () => {
  const { service, fixture } = setup();
  const b = await service.block('148');
  assert.deepEqual(await service.search('148'), { kind: 'block', id: b.hash });
  assert.equal((await service.search(b.hash)).kind, 'block');
  assert.equal((await service.search(b.txids[1])).kind, 'transaction');
  assert.equal((await service.search(fixture.addresses[1])).kind, 'address');
  await assert.rejects(service.search('<script>alert(1)</script>'), ExplorerError);
  await assert.rejects(service.block('9999999'), /not been mined/);
  await assert.rejects(service.block('1', '-1'), /non-negative/);
  await assert.rejects(service.transaction('../bitcoin.conf'), /64-character/);
});

test('confirmed transaction lookup works without txindex and stops at the scan bound', async () => {
  const { service, fixture } = setup();
  const original = fixture.bitcoin.call.bind(fixture.bitcoin);
  const b = await original('getblock', [await original('getblockhash', [143]), 1]);
  fixture.bitcoin.call = async (method, params = []) => {
    if (method === 'getrawtransaction' && !params[2]) { const error = new Error('No txindex'); error.rpcCode = -5; throw error; }
    return original(method, params);
  };
  const tx = await service.transaction(b.tx[1]);
  assert.equal(tx.blockHash, b.hash);
  const bounded = new ExplorerService({ ...fixture, scanLimit: 2 });
  const before = fixture.bitcoin.calls.filter((c) => c.method === 'getblock').length;
  await assert.rejects(bounded.transaction('f'.repeat(64)), /latest 2 blocks/);
  const after = fixture.bitcoin.calls.filter((c) => c.method === 'getblock').length;
  assert.equal(after - before, 2);
});

test('genesis transaction is readable through its block when Core rejects raw lookup', async () => {
  const { service, fixture } = setup();
  const genesis = await service.block('0');
  const original = fixture.bitcoin.call.bind(fixture.bitcoin);
  fixture.bitcoin.call = async (method, params = []) => {
    if (method === 'getrawtransaction') { const error = new Error('Genesis not indexed'); error.rpcCode = -5; throw error; }
    return original(method, params);
  };
  const tx = await service.transaction(genesis.txids[0], genesis.hash);
  assert.equal(tx.coinbase, true);
  assert.equal(tx.blockHash, genesis.hash);
});

test('missing undo data produces unavailable input values and fees, never fabricated zero', async () => {
  const { service, fixture } = setup();
  const original = fixture.bitcoin.call.bind(fixture.bitcoin);
  const block = await service.block('148');
  fixture.bitcoin.call = async (method, params = []) => {
    if (method === 'getrawtransaction' && params[1] === 2) { const error = new Error('Undo unavailable'); error.rpcCode = -1; throw error; }
    const result = await original(method, params);
    if (method === 'getrawtransaction') { delete result.fee; result.vin.forEach((input) => { delete input.prevout; }); }
    return result;
  };
  const tx = await service.transaction(block.txids[1], block.hash);
  assert.equal(tx.feeSats, null);
  assert.equal(tx.inputs[0].valueSats, null);
});

test('address uses Electrum reversed SHA256 and distinguishes lag, pending delta and pagination', async () => {
  assert.equal(scriptHash('76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac'), '8b01df4e368ea28f8dc0423bcf7a4923e3a12d307c875e47a0cfbf90b5c39161');
  const { fixture } = setup();
  const service = new ExplorerService({ ...fixture, addressQuery: async () => ({ tip: { height: 147 }, balance: { confirmed: 100, unconfirmed: -20 }, history: Array.from({ length: 26 }, (_, i) => ({ tx_hash: i.toString(16).padStart(64, '0'), height: 100 })), unspent: [] }) });
  const page = await service.address(fixture.addresses[0]);
  assert.equal(page.indexHeight, 147);
  assert.equal(page.pendingSats, -20);
  assert.equal(page.nextOffset, 25);
  assert.equal(page.history.length, 25);
  assert.equal((await service.address(fixture.addresses[0], 25)).history.length, 1);
});

test('offline electrs is an explicit error, not a zero address balance', async () => {
  const { fixture } = setup();
  const service = new ExplorerService({ ...fixture, addressQuery: async () => { throw new Error('private internal message'); } });
  await assert.rejects(service.address(fixture.addresses[0]), (error) => error.code === 'INDEX_UNAVAILABLE' && !error.message.includes('private internal'));
});

test('offline or wrong-network Core is not represented as a healthy empty chain', async () => {
  const { fixture } = setup();
  fixture.bitcoin.call = async () => { throw new Error('secret credential should not appear'); };
  const offline = await new ExplorerService(fixture).overview();
  assert.equal(offline.connected, false);
  assert.equal(offline.mempool, null);
  assert.ok(!JSON.stringify(offline).includes('secret credential'));
  fixture.bitcoin.call = async () => ({ chain: 'main' });
  await assert.rejects(new ExplorerService(fixture).block('1'), /configured for Regtest/);
});

test('explorer HTTP routes are read-only, local-only and do not expose config files or errors', async (t) => {
  const { service } = setup();
  const server = createAppServer({ explorer: service, explorerOnly: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/explorer/overview`);
  assert.equal((await response.json()).chain.height, 148);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
  for (const endpoint of ['overview', 'block', 'transaction', 'address', 'search']) {
    assert.equal((await fetch(`${base}/api/explorer/${endpoint}`, { method: 'POST' })).status, 405);
  }
  assert.equal((await fetch(`${base}/api/explorer/overview`, { headers: { origin: 'https://evil.invalid' } })).status, 403);
  const reboundStatus = await new Promise((resolve, reject) => {
    http.get(`${base}/api/explorer/overview`, { headers: { host: 'evil.invalid' } }, (response) => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(reboundStatus, 403);
  for (const path of ['/.env', '/bitcoin.conf', '/src/config.mjs']) assert.equal((await fetch(`${base}${path}`)).status, 404);
  assert.equal((await fetch(`${base}/api/explorer/stop`)).status, 404);
  assert.equal((await fetch(`${base}/api/explorer/block?id=1&offset=-1`)).status, 400);
  assert.equal((await fetch(`${base}/api/actions/mine`, { method: 'POST' })).status, 403);
  assert.match(await (await fetch(base)).text(), /Chain Atlas/);
  assert.equal((await (await fetch(`${base}/api/health`)).json()).readOnly, true);
});

test('sample HTTP queries remain isolated when the real node is unavailable', async (t) => {
  let touched = false;
  const server = createAppServer({ explorer: { overview() { touched = true; throw new Error('No real node'); } }, explorerOnly: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/explorer/overview?mode=sample`);
  const data = await response.json();
  assert.equal(data.sample, true);
  assert.equal(data.chain.height, 148);
  assert.equal(touched, false);
});
