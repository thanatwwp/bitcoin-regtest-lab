import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import net from 'node:net';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAppServer } from '../server.mjs';
import { BitcoinRpcClient } from '../src/bitcoin-rpc.mjs';
import { ElectrumClient } from '../src/electrum-client.mjs';
import { queryAddressIndex } from '../src/electrum-query.mjs';
import { DashboardService } from '../src/dashboard-service.mjs';
import { publicError } from '../src/errors.mjs';

async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
function raw(origin, resource, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(origin + resource, { headers }, (response) => {
      let body = '';
      response.setEncoding('utf8'); response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on('error', reject); request.end();
  });
}
const rpcOptions = { host: '127.0.0.1', port: 18443, username: 'synthetic-user', password: 'synthetic-secret' };

test('static allowlist blocks accidental secrets, PHP, backups and encoded paths', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'atlas-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'index.html'), '<h1>Allowed</h1>');
  for (const name of ['wallet.json', 'bitcoin.conf', 'backup.txt', 'shell.php', 'index.html.bak']) await writeFile(path.join(root, name), 'SYNTHETIC-SECRET');
  const origin = await listen(t, createAppServer({ assetDirectory: root }));
  assert.equal((await fetch(origin)).status, 200);
  for (const resource of ['/wallet.json', '/bitcoin.conf', '/backup.txt', '/shell.php', '/index.html.bak', '/.env', '/.git/config', '/src/config.mjs', '/%2e%2e/.env', '/%2eenv', '/..%5c.env']) {
    const response = await raw(origin, resource);
    assert.equal(response.status, 404, resource);
    assert.doesNotMatch(response.body, /SYNTHETIC-SECRET/);
  }
});

test('an allowed asset cannot follow a directory symlink outside public', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'atlas-symlink-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = path.join(root, 'public'), outside = path.join(root, 'private');
  await mkdir(assets); await mkdir(outside);
  await writeFile(path.join(outside, 'index.html'), 'SYNTHETIC-SECRET');
  await symlink(outside, path.join(assets, 'explorer'), process.platform === 'win32' ? 'junction' : 'dir');
  const origin = await listen(t, createAppServer({ assetDirectory: assets }));
  const response = await fetch(origin + '/explorer/');
  assert.equal(response.status, 404);
  assert.doesNotMatch(await response.text(), /SYNTHETIC-SECRET/);
});

test('API rejects sibling localhost sites, forged origins and DNS rebinding', async (t) => {
  let reads = 0;
  const origin = await listen(t, createAppServer({ dashboard: { snapshot: async () => { reads++; return {}; } } }));
  for (const headers of [{ 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' }, { origin: 'null' }, { origin: 'http://localhost:9999' }, { host: 'attacker.example' }]) {
    assert.equal((await raw(origin, '/api/dashboard', headers)).status, 403);
    assert.equal((await raw(origin, '/api/session', headers)).status, 403);
  }
  assert.equal(reads, 0);
  const response = await fetch(origin + '/api/dashboard');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /object-src 'none'/);
  assert.match(response.headers.get('permissions-policy'), /camera=\(\)/);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal((await (await fetch(origin + '/api/session')).json()).token, null);
  assert.equal((await raw(origin, '/api/dashboard?q=' + 'a'.repeat(2050))).status, 414);
});

test('concurrent dashboard reads have a fixed ceiling', async (t) => {
  let release, active = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const origin = await listen(t, createAppServer({ dashboard: { snapshot: async () => { active++; await gate; return {}; } } }));
  const first = fetch(origin + '/api/dashboard'), second = fetch(origin + '/api/dashboard');
  while (active < 2) await new Promise((resolve) => setImmediate(resolve));
  const rejected = await fetch(origin + '/api/dashboard');
  assert.equal(rejected.status, 429);
  assert.equal(active, 2);
  release();
  assert.deepEqual((await Promise.all([first, second])).map((r) => r.status), [200, 200]);
});

test('RPC and Electrum reject remote or ambiguous destinations before connecting', () => {
  for (const host of ['evil.example', '0.0.0.0', '127.0.0.1@evil.example', '127.0.0.1/path', '127.1', '192.168.1.20']) {
    assert.throws(() => new BitcoinRpcClient({ ...rpcOptions, host }), { code: 'CONFIGURATION_ERROR' });
    assert.throws(() => new ElectrumClient({ host, port: 60401 }), { code: 'CONFIGURATION_ERROR' });
    assert.throws(() => queryAddressIndex({ host, port: 60401 }, 'a'.repeat(64)), { code: 'CONFIGURATION_ERROR' });
  }
  assert.equal(new BitcoinRpcClient({ ...rpcOptions, host: 'localhost' }).host, '127.0.0.1');
});

test('RPC methods cannot export keys, stop services, or execute injected commands', async () => {
  let called = 0;
  const client = new BitcoinRpcClient({ ...rpcOptions, fetchImpl: () => { called++; } });
  for (const method of ['dumpprivkey', 'dumpwallet', 'walletpassphrase', 'stop', 'getblock; whoami', 'eval', '__proto__']) {
    await assert.rejects(client.call(method), { code: 'RPC_RESPONSE_ERROR' });
  }
  assert.equal(called, 0);
});

test('RPC bounds declared and streamed replies and sanitizes malformed replies', async () => {
  let cancelled = false;
  const responses = [
    new Response('small', { headers: { 'content-length': '17000000' } }),
    new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } })),
    new Response('SYNTHETIC-SECRET: invalid JSON')
  ];
  for (const response of responses) {
    const client = new BitcoinRpcClient({ ...rpcOptions, fetchImpl: async () => response });
    await assert.rejects(client.call('getblockchaininfo'), (error) => error.code === 'RPC_RESPONSE_ERROR'
      && error.cause === undefined && !JSON.stringify(publicError(error)).includes('SYNTHETIC-SECRET'));
  }
  assert.equal(cancelled, true);
});

test('Electrum status and address readers safely reject malformed envelopes', async (t) => {
  for (const payload of ['null\n', '[]\n', 'false\n', '{broken\n', 'x'.repeat(2_000_001)]) {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
      socket.once('data', () => socket.end(payload));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const config = { host: '127.0.0.1', port: server.address().port, timeoutMs: 500 };
    await assert.rejects(new ElectrumClient(config).inspect(), { code: 'ELECTRS_PROTOCOL_ERROR' });
    await assert.rejects(queryAddressIndex(config, 'a'.repeat(64)), { code: 'ELECTRS_PROTOCOL_ERROR' });
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('dashboard distinguishes unavailable balances from zero and avoids other-network wallets', async () => {
  const calls = [];
  const bitcoin = { endpointLabel: 'local', call: async (method) => { calls.push(method); return { chain: 'main', blocks: 10 }; } };
  const electrum = { inspect: async () => { throw new Error('offline'); } };
  const data = await new DashboardService({ bitcoin, electrum }).snapshot();
  assert.deepEqual(calls, ['getblockchaininfo']);
  assert.equal(data.wallets.reachable, false);
  assert.equal(data.mempool.size, null);
  assert.equal(data.mempool.available, false);
  assert.ok(data.errors.some((error) => error.scope === 'network'));
});
