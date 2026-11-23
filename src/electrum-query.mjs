import net from 'node:net';
import { DashboardError } from './errors.mjs';
import { localEndpoint } from './local-endpoint.mjs';

// One short-lived connection, fixed read-only methods, bounded replies.
export function queryAddressIndex({ host, port, timeoutMs = 4000 }, scriptHash) {
  ({ host, port } = localEndpoint(host, port));
  if (!/^[a-f0-9]{64}$/.test(scriptHash)) throw new DashboardError('ELECTRS_PROTOCOL_ERROR', 'Invalid script hash.');
  const requests = [
    ['server.version', ['Chain Atlas', ['1.4', '1.4.2']]],
    ['blockchain.headers.subscribe', []],
    ['blockchain.scripthash.get_balance', [scriptHash]],
    ['blockchain.scripthash.get_history', [scriptHash]],
    ['blockchain.scripthash.listunspent', [scriptHash]]
  ];
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const replies = new Map();
    let buffer = '', bytes = 0, done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve({ tip: replies.get(1), balance: replies.get(2), history: replies.get(3), unspent: replies.get(4) });
    };
    const fail = () => finish(new DashboardError('ELECTRS_PROTOCOL_ERROR', 'Address index unavailable.'));
    const timer = setTimeout(() => finish(new DashboardError('REQUEST_TIMEOUT', 'Address index timed out.')), timeoutMs);
    timer.unref?.();
    socket.setEncoding('utf8');
    socket.once('error', () => finish(new DashboardError('ELECTRS_CONNECTION_ERROR', 'Address index unavailable.')));
    socket.once('close', () => { if (!done) fail(); });
    socket.once('connect', () => requests.forEach(([method, params], id) => socket.write(`${JSON.stringify({ id, method, params })}\n`)));
    socket.on('data', (chunk) => {
      if (done) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 2_000_000) return fail();
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { return fail(); }
        if (!message || typeof message !== 'object' || Array.isArray(message)) return fail();
        if (!Number.isInteger(message.id) || message.id < 0 || message.id >= requests.length) continue;
        if (message.error || !Object.hasOwn(message, 'result')) return fail();
        replies.set(message.id, message.result);
      }
      if (replies.size === requests.length) finish();
    });
  });
}
