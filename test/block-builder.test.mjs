import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ActionService } from '../src/actions.mjs';
import { blockPlan } from '../src/block-builder.mjs';
import { createFixtureRpc } from '../qa/regtest-fixture.mjs';
import { createAppServer } from '../server.mjs';

const input = (transactions = 20, extra = {}) => ({ wallet: 'practice-wallet', transactions, feeRate: '1', confirmed: true, requestId: randomUUID(), ...extra });
const mined = (rpc) => rpc.calls.filter((c) => c.method === 'generateblock');
const wrap = (rpc, replace) => { const original = rpc.call.bind(rpc); rpc.call = async (...args) => replace(original, ...args); return rpc; };

test('builds real-shaped blocks below, at and above 20 total transactions without a count preset cap', async () => {
  const rpc = createFixtureRpc(), actions = new ActionService({ bitcoin: rpc });
  for (const count of [1, 7, 20, 35, 125]) {
    const result = await actions.execute('build-block', input(count, { feeRate: '1.125' }));
    assert.equal(result.transactions, count);
    assert.equal(result.transfers, count - 1);
    assert.equal(mined(rpc).at(-1).params[1].length, count - 1);
    const block = await rpc.call('getblock', [result.hash, 1]);
    assert.equal(block.tx.length, count);
    assert.equal(result.feeBtc, ((count - 1) * 124 / 1e8).toFixed(8));
  }
  assert.equal(rpc.calls.some((c) => ['sendtoaddress', 'sendrawtransaction', 'generatetoaddress'].includes(c.method)), false);
  assert.ok(rpc.calls.filter((c) => c.method === 'signrawtransactionwithwallet').every((c) => c.wallet === 'practice-wallet' && c.params[2] === 'ALL'));
});

test('rejects unconfirmed, injected, fractional, impossible or invalid-fee plans before calling RPC', async () => {
  const rpc = createFixtureRpc(), actions = new ActionService({ bitcoin: rpc });
  for (const invalid of [input(0), input(-1), input(1.1), input('20'), input(Number.MAX_SAFE_INTEGER), input(20, { confirmed: false }),
    input(20, { feeRate: '0' }), input(20, { feeRate: '1e2' }), input(20, { feeRate: '1001' }), input(20, { address: 'external-recipient' })]) {
    await assert.rejects(actions.execute('build-block', invalid));
  }
  assert.equal(rpc.calls.length, 0);
  assert.equal(blockPlan(20, '1').totalFeeBtc, '0.00002090');
});

test('wrong network, disabled actions and unloaded wallets cannot start the block builder', async () => {
  for (const mode of ['main', 'disabled', 'unloaded']) {
    const rpc = wrap(createFixtureRpc(), (original, method, ...args) => {
      if (mode === 'main' && method === 'getblockchaininfo') return { chain: 'main' };
      if (mode === 'unloaded' && method === 'listwallets') return [];
      return original(method, ...args);
    });
    await assert.rejects(new ActionService({ bitcoin: rpc, enabled: mode !== 'disabled' }).execute('build-block', input()));
    assert.equal(rpc.calls.some((c) => c.method === 'getnewaddress'), false);
    assert.equal(mined(rpc).length, 0);
  }
});

test('watch-only, locked and unfunded wallets stop before creating an address', async () => {
  for (const mode of ['watch-only', 'locked', 'unfunded']) {
    const rpc = wrap(createFixtureRpc(), async (original, method, ...args) => {
      const result = await original(method, ...args);
      if (method === 'getwalletinfo' && mode === 'watch-only') result.private_keys_enabled = false;
      if (method === 'getwalletinfo' && mode === 'locked') result.unlocked_until = 0;
      if (method === 'listunspent' && mode === 'unfunded') return [];
      return result;
    });
    await assert.rejects(new ActionService({ bitcoin: rpc }).execute('build-block', input()));
    assert.equal(rpc.calls.some((c) => c.method === 'getnewaddress'), false);
  }
});

test('wrong destination, incomplete signatures, changed inputs and altered outputs never reach mining', async () => {
  for (const mode of ['address', 'signature', 'input', 'output']) {
    const rpc = wrap(createFixtureRpc(), async (original, method, ...args) => {
      const result = await original(method, ...args);
      if (method === 'getaddressinfo' && mode === 'address') result.ismine = false;
      if (method === 'signrawtransactionwithwallet' && mode === 'signature') result.complete = false;
      if (method === 'gettxout' && mode === 'input') return null;
      if (method === 'decoderawtransaction' && mode === 'output') result.vout[0].value = 9;
      return result;
    });
    await assert.rejects(new ActionService({ bitcoin: rpc }).execute('build-block', input()));
    assert.equal(mined(rpc).length, 0);
  }
});

test('time budget and disconnected requests stop preparation without mining', async () => {
  const rpc = createFixtureRpc(), abort = new AbortController(); abort.abort();
  await assert.rejects(new ActionService({ bitcoin: rpc }).execute('build-block', input(), { signal: abort.signal }), { code: 'BUILD_CANCELLED' });
  let time = 0;
  await assert.rejects(new ActionService({ bitcoin: rpc }).execute('build-block', input(), { now: () => ++time, budgetMs: 8 }), { code: 'BUILD_TIMEOUT' });
  assert.equal(mined(rpc).length, 0);
});

test('deduplicates block creation and preserves uncertain results without retrying', async () => {
  const rpc = createFixtureRpc(), actions = new ActionService({ bitcoin: rpc }), plan = input();
  const [a, b] = await Promise.all([actions.execute('build-block', plan), actions.execute('build-block', plan)]);
  assert.deepEqual(a, b); assert.equal(mined(rpc).length, 1);
  let attempts = 0;
  const failed = wrap(createFixtureRpc(), (original, method, ...args) => {
    if (method === 'generateblock') { attempts++; throw new Error('SYNTHETIC PRIVATE CONTENT'); }
    return original(method, ...args);
  });
  const uncertain = new ActionService({ bitcoin: failed }), same = input();
  for (let i = 0; i < 2; i++) await assert.rejects(uncertain.execute('build-block', same), (e) => e.code === 'OUTCOME_UNKNOWN' && !e.message.includes('PRIVATE'));
  assert.equal(attempts, 1);
});

test('block builder HTTP endpoint requires the existing origin, token and confirmation protections', async (t) => {
  const rpc = createFixtureRpc();
  const server = createAppServer({ actions: new ActionService({ bitcoin: rpc }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(origin + '/api/session')).json();
  const headers = { origin, 'content-type': 'application/json', 'x-dashboard-token': token };
  for (const h of [{ ...headers, origin: 'http://evil.example' }, { ...headers, 'x-dashboard-token': 'bad' }]) {
    assert.equal((await fetch(origin + '/api/actions/build-block', { method: 'POST', headers: h, body: JSON.stringify(input()) })).status, 403);
  }
  assert.equal((await fetch(origin + '/api/actions/build-block', { method: 'POST', headers, body: JSON.stringify(input(20, { confirmed: false })) })).status, 400);
  assert.equal(mined(rpc).length, 0);
  const response = await fetch(origin + '/api/actions/build-block', { method: 'POST', headers, body: JSON.stringify(input(35)) });
  assert.equal(response.status, 200); assert.equal((await response.json()).result.transactions, 35);
});
