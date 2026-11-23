import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from './src/config.mjs';
import { BitcoinRpcClient } from './src/bitcoin-rpc.mjs';
import { ElectrumClient } from './src/electrum-client.mjs';
import { DashboardService } from './src/dashboard-service.mjs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ActionService, ActionError } from './src/actions.mjs';
import { ExplorerService, ExplorerError } from './src/explorer-service.mjs';
import { createExplorerSample } from './src/explorer-sample.mjs';
import { publicError } from './src/errors.mjs';

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(rootDirectory, 'public');
// Only reviewed browser assets are public. A backup, configuration, or upload
// accidentally placed in public/ must not become downloadable.
const PUBLIC_ASSETS = new Set(['index.html', 'styles.css', 'polish.css', 'app.js', 'actions.js', 'favicon.svg',
  'explorer/index.html', 'explorer/explorer.css', 'explorer/cybertown.css', 'explorer/explorer.js',
  'explorer/mark.svg', 'explorer/cybertown.svg']);

const CONTENT_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8'
});

function securityHeaders(contentType, noStore = false) {
  return {
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'content-type': contentType,
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'x-dns-prefetch-control': 'off',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY'
  };
}

function json(response, status, payload) {
  response.writeHead(status, securityHeaders(CONTENT_TYPES['.json'], true));
  response.end(JSON.stringify(payload));
}

async function serveStatic(response, pathname, method, assetDirectory = publicDirectory) {
  const requested = pathname === '/' ? 'index.html' : pathname === '/explorer/' || pathname === '/explorer' ? 'explorer/index.html' : pathname.replace(/^\/+/, '');
  if (!PUBLIC_ASSETS.has(requested)) {
    json(response, 404, { error: 'Not found.' });
    return;
  }

  try {
    const filePath = path.join(assetDirectory, requested);
    const canonicalRoot = await fs.realpath(assetDirectory);
    const canonicalFile = await fs.realpath(filePath);
    if (canonicalFile !== path.join(canonicalRoot, requested)) {
      json(response, 404, { error: 'Not found.' });
      return;
    }
    const stat = await fs.stat(canonicalFile);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) {
      json(response, 404, { error: 'Not found.' });
      return;
    }
    const extension = path.extname(filePath).toLowerCase();
    const body = await fs.readFile(filePath);
    response.writeHead(200, securityHeaders(CONTENT_TYPES[extension] || 'application/octet-stream', extension === '.html'));
    response.end(method === 'HEAD' ? undefined : body);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EISDIR') {
      json(response, 404, { error: 'Not found.' });
      return;
    }
    json(response, 500, { error: 'The local dashboard could not read a static asset.' });
  }
}

async function readJson(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ActionError('Send JSON for this action.', 415);
  }
  if (Number(request.headers['content-length']) > 4096) throw new ActionError('Request is too large.', 413);
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4096) throw new ActionError('Request is too large.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ActionError('Invalid JSON request.'); }
}

export function createAppServer({ dashboard, actions = null, explorer = null, explorerOnly = false, assetDirectory = publicDirectory }) {
  const sessionToken = randomBytes(32).toString('hex');
  const sample = new ExplorerService(createExplorerSample());
  let explorerRequests = 0;
  let dashboardRequests = 0;
  let actionRequests = 0;
  const handle = async (request, response) => {
    const method = request.method || 'GET';
    // Restrict Host as well as the listening interface to block DNS rebinding.
    const allowedHosts = [`127.0.0.1:${request.socket.localPort}`, `localhost:${request.socket.localPort}`];
    const host = request.headers.host;
    if (!allowedHosts.includes(host) || request.headers['sec-fetch-site'] === 'cross-site'
      || (request.headers.origin && request.headers.origin !== `http://${host}`)) {
      json(response, 403, { error: 'Open the dashboard directly on localhost.' });
      return;
    }
    let url;
    if ((request.url || '').length > 2048) { json(response, 414, { error: 'Request URL is too long.' }); return; }
    try { url = new URL(request.url || '/', `http://${host}`); }
    catch { json(response, 400, { error: 'Invalid URL.' }); return; }
    // Other localhost ports are same-site but are separate, untrusted apps.
    if (url.pathname.startsWith('/api/') && request.headers['sec-fetch-site']
        && request.headers['sec-fetch-site'] !== 'same-origin'
        && request.headers['sec-fetch-site'] !== 'none') {
      json(response, 403, { error: 'Open this app directly to read its local data.' }); return;
    }
    const actionMatch = /^\/api\/actions\/(address|mine|send|build-block)$/.exec(url.pathname);

    if (method === 'POST' && actionMatch) {
      if (actionRequests >= 2) { json(response, 429, { error: 'An action request is already waiting. Try again shortly.' }); return; }
      actionRequests++;
      try {
        if (!actions?.enabled) throw new ActionError('Actions are disabled in the server settings.', 403);
        const supplied = request.headers['x-dashboard-token'];
        if (request.headers.origin !== `http://${host}` || typeof supplied !== 'string'
          || !/^[a-f0-9]{64}$/.test(supplied)
          || !timingSafeEqual(Buffer.from(supplied), Buffer.from(sessionToken))) {
          throw new ActionError('Reload the dashboard to establish a local session.', 403, 'INVALID_SESSION');
        }
        const cancellation = new AbortController();
        response.once('close', () => { if (!response.writableEnded) cancellation.abort(); });
        const result = await actions.execute(actionMatch[1], await readJson(request), { signal: cancellation.signal });
        json(response, 200, { ok: true, result });
      } catch (error) {
        json(response, error instanceof ActionError ? error.status : 500, {
          ok: false,
          code: error instanceof ActionError ? error.code : 'ACTION_FAILED',
          error: error instanceof ActionError ? error.message : 'The action could not be completed.'
        });
      } finally { actionRequests--; }
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD', ...securityHeaders(CONTENT_TYPES['.json'], true) });
      response.end(JSON.stringify({ error: 'This endpoint is read-only.' }));
      return;
    }

    if (url.pathname === '/api/health') {
      json(response, 200, { status: 'ok', readOnly: !actions?.enabled });
      return;
    }

    if (url.pathname === '/api/session') {
      json(response, 200, { token: actions?.enabled ? sessionToken : null, actionsEnabled: Boolean(actions?.enabled) });
      return;
    }

    if (url.pathname.startsWith('/api/explorer/')) {
      if (explorerRequests >= 4) { json(response, 429, { error: 'The explorer is busy. Please try again shortly.' }); return; }
      explorerRequests++;
      try {
        const service = url.searchParams.get('mode') === 'sample' ? sample : explorer;
        if (!service) throw new ExplorerError('The local explorer service is not available.', 503);
        const get = (name) => url.searchParams.get(name);
        let result;
        switch (url.pathname.slice('/api/explorer/'.length)) {
          case 'overview': result = await service.overview(); break;
          case 'blocks': result = await service.blocks(get('start')); break;
          case 'block': result = await service.block(get('id') || '', get('offset') || 0); break;
          case 'transaction': result = await service.transaction(get('id'), get('block'), get('height')); break;
          case 'address': result = await service.address(get('id'), get('offset') || 0); break;
          case 'mempool': result = await service.mempool(get('offset') || 0); break;
          case 'search': result = await service.search(get('q')); break;
          default: throw new ExplorerError('Explorer endpoint not found.', 404);
        }
        json(response, 200, result);
      } catch (error) {
        json(response, error instanceof ExplorerError ? error.status : 503, {
          error: error instanceof ExplorerError ? error.message : publicError(error).message,
          code: error instanceof ExplorerError ? error.code : publicError(error).code
        });
      } finally { explorerRequests--; }
      return;
    }

    if (url.pathname === '/api/dashboard' && dashboard) {
      if (dashboardRequests >= 2) { json(response, 429, { error: 'The dashboard is busy. Try again shortly.' }); return; }
      dashboardRequests++;
      try {
        const snapshot = await dashboard.snapshot();
        const enabled = Boolean(actions?.enabled);
        json(response, 200, {
          ...snapshot,
          readOnly: !enabled,
          interactions: {
            enabled,
            available: enabled && snapshot.core?.connected === true && snapshot.core?.network === 'regtest',
            reason: !enabled ? 'Actions are disabled in the server settings.'
              : !snapshot.core?.connected ? 'Connect Bitcoin Core using the server settings to enable actions.'
                : snapshot.core.network !== 'regtest' ? 'Actions are available only on Regtest.' : null
          }
        });
      } catch {
        json(response, 500, { error: 'The dashboard snapshot could not be assembled.' });
      } finally { dashboardRequests--; }
      return;
    }

    await serveStatic(response, explorerOnly && url.pathname === '/' ? '/explorer/' : url.pathname, method, assetDirectory);
  };
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000,
    keepAliveTimeout: 5000 }, (request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent && !response.destroyed) json(response, 500, { error: 'The local request could not be completed.' });
      else response.destroy();
    });
  });
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 100;
  return server;
}

function main() {
  const config = readConfig();
  const bitcoin = new BitcoinRpcClient({
    ...config.bitcoin,
    timeoutMs: config.requestTimeoutMs
  });
  const electrum = new ElectrumClient({
    ...config.electrs,
    timeoutMs: config.requestTimeoutMs
  });
  const dashboard = new DashboardService({
    bitcoin,
    electrum,
    autoRefreshMs: config.autoRefreshMs
  });
  const explorerOnly = process.argv.includes('--explorer');
  const actions = explorerOnly ? null : new ActionService({ bitcoin, enabled: config.actionsEnabled });
  const explorer = new ExplorerService({ bitcoin, electrum });
  const server = createAppServer({ dashboard: explorerOnly ? null : dashboard, actions, explorer, explorerOnly });

  server.once('error', (error) => {
    if (error?.code === 'EADDRINUSE') {
      console.error(`Port ${config.port} is already in use. Stop the other local process or choose another DASHBOARD_PORT.`);
    } else {
      console.error('The local dashboard server could not start.');
    }
    process.exitCode = 1;
  });

  server.listen(config.port, config.host, () => {
    console.log(`Regtest ${explorerOnly ? 'explorer' : 'dashboard'} ready at http://${config.host}:${config.port}${explorerOnly ? '/explorer/' : ''}`);
    if (!config.bitcoin.username || !config.bitcoin.password) {
      console.log('Bitcoin RPC credentials are not configured. Copy .env.example to .env and add the local RPC values.');
    }
  });

  const stop = (signal) => {
    console.log(`\n${signal} received. Closing the local dashboard.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch { console.error('The dashboard configuration could not be loaded. Check local .env settings and any BITCOIN_CONFIG_PATH file access.'); process.exitCode = 1; }
}
