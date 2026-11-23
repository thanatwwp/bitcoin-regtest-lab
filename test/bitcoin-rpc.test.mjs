import test from 'node:test';
import assert from 'node:assert/strict';
import { BitcoinRpcClient } from '../src/bitcoin-rpc.mjs';

test('keeps RPC authentication in the backend request and encodes wallet names', async () => {
  let observed;
  const client = new BitcoinRpcClient({
    host: '127.0.0.1',
    port: 18_443,
    username: 'synthetic-rpc-user',
    password: 'a secret with spaces',
    fetchImpl: async (url, options) => {
      observed = { url, options };
      return Response.json({ result: { trusted: 1 }, error: null });
    }
  });

  const result = await client.call('getbalances', [], 'lab/wallet 1');

  assert.deepEqual(result, { trusted: 1 });
  assert.equal(observed.url, 'http://127.0.0.1:18443/wallet/lab%2Fwallet%201');
  assert.equal(observed.options.headers.authorization, `Basic ${Buffer.from('synthetic-rpc-user:a secret with spaces').toString('base64')}`);
  assert.doesNotMatch(observed.options.body, /secret|synthetic-rpc-user/u);
});

test('fails safely when RPC credentials are absent', async () => {
  const client = new BitcoinRpcClient({
    host: '127.0.0.1',
    port: 18_443,
    username: '',
    password: ''
  });

  await assert.rejects(client.call('getblockchaininfo'), { code: 'CONFIGURATION_ERROR' });
});

test('maps an HTTP 401 response to an authentication error', async () => {
  const client = new BitcoinRpcClient({
    host: '127.0.0.1',
    port: 18_443,
    username: 'user',
    password: 'password',
    fetchImpl: async () => ({ ok: false, status: 401 })
  });

  await assert.rejects(client.call('getblockchaininfo'), { code: 'AUTHENTICATION_ERROR' });
});

test('reads Core HTTP 500 JSON-RPC error codes without retaining server messages', async () => {
  const client = new BitcoinRpcClient({ host: '127.0.0.1', port: 18443, username: 'user', password: 'password',
    fetchImpl: async () => Response.json({ error: { code: -6, message: 'sensitive upstream details' } }, { status: 500 }) });
  await assert.rejects(client.call('sendtoaddress'), (error) => error.rpcCode === -6 && !error.message.includes('sensitive'));
});
