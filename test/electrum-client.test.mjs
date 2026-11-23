import net from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ElectrumClient } from '../src/electrum-client.mjs';

test('reads the electrs version and subscribed header height', async (t) => {
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line) continue;
        const request = JSON.parse(line);
        const results = {
          'server.version': ['electrs 0.12.0', '1.4'],
          'server.ping': null,
          'blockchain.headers.subscribe': { height: 42, hex: '00' }
        };
        socket.write(`${JSON.stringify({ id: request.id, result: results[request.method], error: null })}\n`);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const client = new ElectrumClient({ host: '127.0.0.1', port: address.port, timeoutMs: 1_000 });
  const result = await client.inspect();

  assert.equal(result.serverSoftware, 'electrs 0.12.0');
  assert.equal(result.protocolVersion, '1.4');
  assert.equal(result.tipHeight, 42);
  assert.equal(result.protocolReady, true);
  assert.ok(result.latencyMs >= 1);
});

test('distinguishes an open TCP port from a complete Electrum response', async (t) => {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('data', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const result = await new ElectrumClient({ host: '127.0.0.1', port: server.address().port, timeoutMs: 100 }).inspect();
  assert.equal(result.tcpReachable, true);
  assert.equal(result.protocolReady, false);
  assert.equal(result.tipHeight, null);
  assert.equal(result.latencyMs, null);
});
