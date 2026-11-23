import test from 'node:test';
import assert from 'node:assert/strict';
import { DashboardService } from '../src/dashboard-service.mjs';
import { ExplorerService } from '../src/explorer-service.mjs';
import { createExplorerSample } from '../src/explorer-sample.mjs';
import { createFixtureRpc } from '../qa/regtest-fixture.mjs';

test('dashboard keeps the wallet-provided block hash for an older confirmed transaction', async () => {
  const bitcoin = createFixtureRpc(), original = bitcoin.call.bind(bitcoin);
  bitcoin.call = async (method, ...args) => method === 'listtransactions'
    ? [{ txid: 'a'.repeat(64), blockhash: 'B'.repeat(64), confirmations: 203 },
      { txid: 'c'.repeat(64), blockhash: '<untrusted>', confirmations: 0 }]
    : original(method, ...args);
  const data = await new DashboardService({ bitcoin, electrum: { inspect: async () => ({}) } }).snapshot();
  assert.equal(data.wallets.transactions[0].blockHash, 'b'.repeat(64));
  assert.equal(data.wallets.transactions[1].blockHash, null);
});

function walletFixture(wallets = ['lab']) {
  const fixture = createExplorerSample(), original = fixture.bitcoin.call.bind(fixture.bitcoin);
  const calls = [];
  let found;
  return { fixture, calls, async prepare() {
    const block = await original('getblock', [await original('getblockhash', [1]), 1]);
    found = { txid: block.tx[0], blockhash: block.hash, confirmations: 148 };
    fixture.bitcoin.call = async (method, params = [], wallet, options) => {
      calls.push({ method, params, wallet, options });
      if (method === 'listwallets') return wallets;
      if (method === 'gettransaction') return found;
      if (method === 'getrawtransaction' && !params[2]) throw Object.assign(new Error('Not indexed'), { rpcCode: -5 });
      return original(method, params);
    };
    return { found, service: new ExplorerService({ ...fixture, scanLimit: 2 }) };
  } };
}

test('old wallet transaction IDs resolve outside the scan window without scanning or loading wallets', async () => {
  const setup = walletFixture(), { service, found } = await setup.prepare();
  const tx = await service.transaction(found.txid);
  assert.equal(tx.txid, found.txid);
  assert.equal(tx.blockHash, found.blockhash);
  assert.equal(tx.confirmations, 148);
  assert.ok(!setup.calls.some((c) => ['getblock', 'loadwallet', 'rescanblockchain'].includes(c.method)));
  assert.equal(setup.calls.find((c) => c.method === 'gettransaction').wallet, 'lab');
  assert.ok(setup.calls.find((c) => c.method === 'gettransaction').options.timeoutMs <= 4000);
});

test('wallet lookup rejects unrelated or unconfirmed metadata and preserves the bounded chain scan', async () => {
  for (const change of [{ txid: 'e'.repeat(64) }, { confirmations: 0 }, { blockhash: '<invalid>' }]) {
    const setup = walletFixture(), { service, found } = await setup.prepare();
    const requestedId = found.txid;
    Object.assign(found, change);
    await assert.rejects(service.transaction(requestedId), { code: 'TX_UNAVAILABLE' });
    assert.equal(setup.calls.filter((c) => c.method === 'getblock').length, 2);
  }
});

test('wallet fallback is bounded and explicit block links work with no wallet access', async () => {
  const setup = walletFixture(Array.from({ length: 100 }, (_, i) => `wallet-${i}`));
  const { service, found } = await setup.prepare();
  const tx = await service.transaction(found.txid, found.blockhash);
  assert.equal(tx.txid, found.txid);
  assert.ok(!setup.calls.some((c) => ['listwallets', 'gettransaction'].includes(c.method)));
  await assert.rejects(service.transaction('d'.repeat(64)), { code: 'TX_UNAVAILABLE' });
  assert.equal(setup.calls.filter((c) => c.method === 'gettransaction').length, 20);
  assert.equal(setup.calls.filter((c) => c.method === 'getblock').length, 2);
});
