import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { ActionService } from '../src/actions.mjs';
import { DashboardError } from '../src/errors.mjs';
import { createAppServer } from '../server.mjs';
import { createFixtureRpc } from '../qa/regtest-fixture.mjs';

const address = 'bcrt1q' + 'a'.repeat(38);
const body = (values = {}) => ({ requestId: randomUUID(), confirmed: true, ...values });
const writes = (rpc) => rpc.calls.filter(({ method }) => ['getnewaddress', 'generatetoaddress', 'sendtoaddress'].includes(method));

test('creates addresses, generates blocks, and broadcasts an exact amount with a chosen fee', async () => {
  const bitcoin = createFixtureRpc();
  const actions = new ActionService({ bitcoin });
  const receiving = await actions.execute('address', body({ wallet: 'practice-wallet' }));
  const mined = await actions.execute('mine', body({ address: receiving.address, blocks: 101 }));
  const sent = await actions.execute('send', body({ wallet: 'practice-wallet', address, amount: '0.00000001', feeRate: '1.125' }));
  assert.equal(mined.blocks, 101);
  assert.equal((await bitcoin.call('getblockchaininfo')).blocks, 206);
  assert.match(sent.txid, /^[a-f0-9]{64}$/);
  const send = writes(bitcoin).at(-1);
  assert.equal(send.wallet, 'practice-wallet');
  assert.equal(send.params.amount, '0.00000001');
  assert.equal(send.params.fee_rate, '1.125');
  assert.equal(send.params.subtractfeefromamount, false);
});

test('rejects unconfirmed, excessive, unsupported, and imprecise actions before making RPC calls', async () => {
  const bitcoin = createFixtureRpc();
  const actions = new ActionService({ bitcoin });
  const bad = [
    ['mine', body({ address, blocks: 102 })],
    ['mine', body({ address, blocks: 1, confirmed: false })],
    ['mine', body({ address, blocks: -1 })],
    ['mine', body({ address, blocks: 1, rpc: 'stop' })],
    ['stop', body()],
    ['send', body({ wallet: 'practice-wallet', address, amount: '1e-8', feeRate: '1' })],
    ['send', body({ wallet: 'practice-wallet', address, amount: '0.000000001', feeRate: '1' })],
    ['send', body({ wallet: 'practice-wallet', address, amount: '0', feeRate: '1' })]
  ];
  for (const [action, input] of bad) await assert.rejects(actions.execute(action, input));
  assert.equal(bitcoin.calls.length, 0);
});

test('never mutates mainnet, unloaded wallets, invalid destinations, or disabled actions', async () => {
  for (const chain of ['main', 'test', 'signet', undefined]) {
    const calls = [];
    const actions = new ActionService({ bitcoin: { call: async (method) => { calls.push(method); return { chain }; } } });
    await assert.rejects(actions.execute('mine', body({ address, blocks: 1 })), { code: 'WRONG_NETWORK' });
    assert.deepEqual(calls, ['getblockchaininfo']);
  }
  const bitcoin = createFixtureRpc();
  const actions = new ActionService({ bitcoin });
  await assert.rejects(actions.execute('address', body({ wallet: 'missing' })));
  await assert.rejects(actions.execute('mine', body({ address: 'bc1q' + 'a'.repeat(38), blocks: 1 })));
  await assert.rejects(new ActionService({ bitcoin, enabled: false }).execute('mine', body({ address, blocks: 1 })), { code: 'ACTIONS_DISABLED' });
  assert.equal(writes(bitcoin).length, 0);
});

test('deduplicates concurrent and repeated requests and rejects reuse with different data', async () => {
  const bitcoin = createFixtureRpc();
  const actions = new ActionService({ bitcoin });
  const input = body({ address, blocks: 1 });
  const [a, b] = await Promise.all([actions.execute('mine', input), actions.execute('mine', input)]);
  assert.deepEqual(a, b);
  assert.deepEqual(await actions.execute('mine', input), a);
  await assert.rejects(actions.execute('mine', { ...input, blocks: 2 }), { status: 409 });
  assert.equal(writes(bitcoin).length, 1);
});

test('preserves uncertain outcomes and never retries a timed-out mutation', async () => {
  const bitcoin = createFixtureRpc();
  const original = bitcoin.call.bind(bitcoin);
  let dispatched = 0;
  bitcoin.call = async (...args) => {
    if (args[0] === 'generatetoaddress') { dispatched++; throw new DashboardError('REQUEST_TIMEOUT', 'secret-internal-details'); }
    return original(...args);
  };
  const actions = new ActionService({ bitcoin });
  const input = body({ address, blocks: 1 });
  for (let i = 0; i < 2; i++) await assert.rejects(actions.execute('mine', input), (error) => error.code === 'OUTCOME_UNKNOWN' && !error.message.includes('secret'));
  assert.equal(dispatched, 1);
});

test('maps Core wallet errors to useful messages without leaking internal details', async () => {
  const bitcoin = createFixtureRpc();
  const original = bitcoin.call.bind(bitcoin);
  bitcoin.call = async (...args) => {
    if (args[0] === 'sendtoaddress') {
      const error = new DashboardError('RPC_RESPONSE_ERROR', 'secret-internal-details');
      error.rpcCode = -6;
      throw error;
    }
    return original(...args);
  };
  await assert.rejects(new ActionService({ bitcoin }).execute('send', body({ wallet: 'practice-wallet', address, amount: '1', feeRate: '1' })), (error) => /Insufficient/.test(error.message) && !error.message.includes('secret'));
});

test('HTTP actions require a valid local Host, Origin, token, JSON content type, and confirmation', async (t) => {
  const bitcoin = createFixtureRpc();
  const server = createAppServer({ dashboard: { snapshot: async () => ({ core: { connected: true, network: 'regtest' } }) }, actions: new ActionService({ bitcoin }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${origin}/api/session`)).json();
  const headers = { origin, 'content-type': 'application/json', 'x-dashboard-token': token };
  const input = body({ address, blocks: 1 });
  for (const changed of [
    { ...headers, origin: 'http://evil.example' },
    { ...headers, host: `evil.example:${server.address().port}` },
    { ...headers, 'x-dashboard-token': 'a'.repeat(64) },
    { ...headers, 'content-type': 'text/plain' },
    { ...headers, 'sec-fetch-site': 'cross-site' }
  ]) {
    // Native fetch normalizes forbidden Host/Sec-Fetch headers. Use raw HTTP
    // here to exercise the actual DNS-rebinding and cross-site boundary.
    const status = await new Promise((resolve, reject) => {
      const request = httpRequest(`${origin}/api/actions/mine`, { method: 'POST', headers: changed }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.end(JSON.stringify(input));
    });
    assert.ok([403, 415].includes(status), `Expected rejection, got ${status}`);
  }
  assert.equal(writes(bitcoin).length, 0);
  const response = await fetch(`${origin}/api/actions/mine`, { method: 'POST', headers, body: JSON.stringify(input) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.blocks, 1);
  assert.equal(writes(bitcoin).length, 1);
  const unknown = await fetch(`${origin}/api/rpc`, { method: 'POST', headers, body: '{}' });
  assert.equal(unknown.status, 405);
  const oversized = await fetch(`${origin}/api/actions/mine`, { method: 'POST', headers, body: JSON.stringify({ large: 'x'.repeat(5000) }) });
  assert.equal(oversized.status, 413);
});
