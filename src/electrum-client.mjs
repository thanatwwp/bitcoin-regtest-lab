import net from 'node:net';
import { DashboardError } from './errors.mjs';
import { localEndpoint } from './local-endpoint.mjs';

const REQUESTS = Object.freeze([
  { id: 1, method: 'server.version', params: ['Regtest Dashboard', ['1.4', '1.4.2']] },
  { id: 2, method: 'server.ping', params: [] },
  { id: 3, method: 'blockchain.headers.subscribe', params: [] }
]);

export class ElectrumClient {
  constructor({ host, port, timeoutMs = 4_000, connectImpl = net.createConnection }) {
    Object.assign(this, localEndpoint(host, port));
    this.timeoutMs = timeoutMs;
    this.connectImpl = connectImpl;
  }

  get endpointLabel() {
    return `${this.host}:${this.port}`;
  }

  inspect() {
    return new Promise((resolve, reject) => {
      const startedAt = performance.now();
      const responses = new Map();
      let buffer = '';
      let bytes = 0;
      let settled = false;
      let tcpReachable = false;
      const socket = this.connectImpl({ host: this.host, port: this.port });

      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        if (error) reject(error);
        else resolve(result);
      };

      const timeout = setTimeout(() => {
        if (tcpReachable) {
          finish(null, { tcpReachable: true, protocolReady: false, tipHeight: null, latencyMs: null });
          return;
        }
        finish(new DashboardError('REQUEST_TIMEOUT', 'electrs did not respond before the timeout.'));
      }, this.timeoutMs);
      timeout.unref?.();

      socket.setEncoding('utf8');
      socket.once('error', (error) => {
        finish(new DashboardError('ELECTRS_CONNECTION_ERROR', 'Unable to connect to electrs.', { cause: error }));
      });
      socket.once('close', () => {
        if (!settled) finish(new DashboardError('ELECTRS_PROTOCOL_ERROR', 'electrs closed an incomplete response.'));
      });

      socket.once('connect', () => {
        tcpReachable = true;
        for (const request of REQUESTS) socket.write(`${JSON.stringify(request)}\n`);
      });

      socket.on('data', (chunk) => {
        if (settled) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > 65536) {
          finish(new DashboardError('ELECTRS_PROTOCOL_ERROR', 'electrs response exceeded the local limit.'));
          return;
        }
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          let message;
          try {
            message = JSON.parse(line);
          } catch (error) {
            finish(new DashboardError('ELECTRS_PROTOCOL_ERROR', 'electrs returned invalid JSON.', { cause: error }));
            return;
          }

          if (!message || typeof message !== 'object' || Array.isArray(message)) {
            finish(new DashboardError('ELECTRS_PROTOCOL_ERROR', 'electrs returned an invalid response.'));
            return;
          }
          if (REQUESTS.some(({ id }) => id === message.id)) responses.set(message.id, message);
        }

        if (REQUESTS.every(({ id }) => responses.has(id))) {
          const failed = [...responses.values()].find((message) => message.error);
          if (failed) {
            finish(new DashboardError('ELECTRS_PROTOCOL_ERROR', 'electrs rejected the status request.'));
            return;
          }

          const version = responses.get(1).result;
          const tip = responses.get(3).result;
          if (!Array.isArray(version) || version.length < 2 || !version.every((v) => typeof v === 'string' && v.length <= 256)
              || !Number.isSafeInteger(tip?.height) || tip.height < 0 || !Object.hasOwn(responses.get(2), 'result')) {
            finish(new DashboardError('ELECTRS_PROTOCOL_ERROR', 'electrs returned invalid status fields.'));
            return;
          }
          finish(null, {
            tcpReachable: true,
            protocolReady: true,
            serverSoftware: Array.isArray(version) ? version[0] : String(version || 'electrs'),
            protocolVersion: Array.isArray(version) ? version[1] : null,
            tipHeight: Number.isInteger(tip?.height) ? tip.height : null,
            latencyMs: Math.max(1, Math.round(performance.now() - startedAt))
          });
        }
      });
    });
  }
}
