import net from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { queryAddressIndex } from '../src/electrum-query.mjs';

async function mock(t, handler) {
  const sockets = new Set();
  const server = net.createServer((socket) => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); handler(socket); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const s of sockets) s.destroy(); return new Promise((resolve) => server.close(resolve)); });
  return { host: '127.0.0.1', port: server.address().port, timeoutMs: 500 };
}
test('address protocol handles fragmented and out-of-order replies over real TCP', async (t) => {
  const methods = [];
  const config = await mock(t, (socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) if (line) methods.push(JSON.parse(line));
      if (methods.length === 5) {
        const values = [['electrs', '1.4'], { height: 12 }, { confirmed: 4000, unconfirmed: -100 }, [{ tx_hash: 'a'.repeat(64), height: 12 }], [{ value: 4000, tx_pos: 0 }]];
        const reply = [4, 2, 0, 3, 1].map((id) => JSON.stringify({ id, result: values[id] })).join('\n') + '\n';
        socket.write(reply.slice(0, 25)); setImmediate(() => socket.write(reply.slice(25)));
      }
    });
  });
  const data = await queryAddressIndex(config, 'b'.repeat(64));
  assert.equal(data.tip.height, 12);
  assert.equal(data.balance.unconfirmed, -100);
  assert.equal(data.history.length, 1);
  assert.deepEqual(methods[2].params, ['b'.repeat(64)]);
});
test('address protocol rejects early close, oversized replies, errors and silence without leaking details', async (t) => {
  const scenarios = [
    (s) => s.on('data', () => s.end()),
    (s) => s.on('data', () => s.end('x'.repeat(2_000_001))),
    (s) => s.on('data', () => s.end(JSON.stringify({ id: 0, error: { message: 'sensitive detail' } }) + '\n')),
    (s) => s.on('data', () => {})
  ];
  for (const scenario of scenarios) {
    const config = await mock(t, scenario);
    await assert.rejects(queryAddressIndex({ ...config, timeoutMs: 50 }, 'b'.repeat(64)), (error) => !error.message.includes('sensitive detail'));
  }
});
