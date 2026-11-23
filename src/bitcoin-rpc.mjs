import { DashboardError } from './errors.mjs';
import { localEndpoint } from './local-endpoint.mjs';

const METHODS = new Set(['getblockchaininfo', 'getnetworkinfo', 'getblock', 'getblockhash',
  'getmempoolinfo', 'getrawmempool', 'getmempoolentry', 'getrawtransaction', 'validateaddress',
  'listwallets', 'listwalletdir', 'getwalletinfo', 'getbalances', 'listtransactions', 'gettransaction',
  'getnewaddress', 'generatetoaddress', 'sendtoaddress',
  'listunspent', 'getaddressinfo', 'gettxout', 'createrawtransaction',
  'signrawtransactionwithwallet', 'decoderawtransaction', 'generateblock']);
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

async function boundedJson(response) {
  if (Number(response.headers?.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new DashboardError('RPC_RESPONSE_ERROR', 'Bitcoin Core response exceeded the local limit.');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body || []) {
    bytes += chunk.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) throw new DashboardError('RPC_RESPONSE_ERROR', 'Bitcoin Core response exceeded the local limit.');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new DashboardError('RPC_RESPONSE_ERROR', 'Bitcoin Core returned invalid JSON.'); }
}

export class BitcoinRpcClient {
  #id = 0;

  constructor({ host, port, username, password, timeoutMs = 4_000, fetchImpl = globalThis.fetch }) {
    Object.assign(this, localEndpoint(host, port));
    this.username = username;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  get endpointLabel() {
    return `${this.host}:${this.port}`;
  }

  async call(method, params = [], walletName = null, { timeoutMs = this.timeoutMs } = {}) {
    if (!METHODS.has(method)) throw new DashboardError('RPC_RESPONSE_ERROR', 'This RPC method is not allowed.');
    if (!this.username || !this.password) {
      throw new DashboardError('CONFIGURATION_ERROR', 'RPC username and password are required.');
    }

    const walletPath = walletName === null ? '' : `/wallet/${encodeURIComponent(walletName)}`;
    const hostname = this.host.includes(':') ? `[${this.host}]` : this.host;
    const url = `http://${hostname}:${this.port}${walletPath}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();

    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          jsonrpc: '1.0',
          id: `regtest-dashboard-${++this.#id}`,
          method,
          params
        }),
        signal: controller.signal,
        redirect: 'error'
      });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new DashboardError('AUTHENTICATION_ERROR', 'Bitcoin Core rejected RPC authentication.');
      }
      // Core returns JSON-RPC errors with HTTP 500 as well as HTTP 200.
      const payload = await boundedJson(response);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new DashboardError('RPC_RESPONSE_ERROR', 'Unexpected Bitcoin Core response.');
      }
      if (payload?.error) {
        const rpcError = new DashboardError('RPC_RESPONSE_ERROR', 'Bitcoin Core rejected the RPC request.');
        rpcError.rpcCode = Number.isInteger(payload.error.code) ? payload.error.code : undefined;
        throw rpcError;
      }
      if (!response.ok || !payload || !Object.hasOwn(payload, 'result')) {
        throw new DashboardError('RPC_RESPONSE_ERROR', 'Unexpected Bitcoin Core response.');
      }
      return payload.result;
    } catch (error) {
      if (error instanceof DashboardError) throw error;
      if (error?.name === 'AbortError') {
        throw new DashboardError('REQUEST_TIMEOUT', 'Bitcoin Core RPC request timed out.');
      }
      throw new DashboardError('RPC_CONNECTION_ERROR', 'Unable to connect to Bitcoin Core RPC.');
    } finally {
      clearTimeout(timer);
    }

  }
}
