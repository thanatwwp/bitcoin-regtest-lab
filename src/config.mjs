import fs from 'node:fs';
import path from 'node:path';
import { localEndpoint } from './local-endpoint.mjs';

function stripQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

export function loadLocalEnv(filePath = path.join(process.cwd(), '.env')) {
  if (!fs.existsSync(filePath)) return;

  const source = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator < 1) continue;

    const key = line.slice(0, separator).trim();
    const value = stripQuotes(line.slice(separator + 1).trim());
    if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function integer(name, fallback, { min = 1, max = 65_535 } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}

export function readBitcoinCredentials(filePath) {
  if (!filePath) return {};
  let source;
  try { source = fs.readFileSync(filePath, 'utf8'); }
  catch { throw new Error('The configured Bitcoin Core configuration file could not be read. Check BITCOIN_CONFIG_PATH.'); }
  const global = {};
  const regtest = {};
  let section = '';
  for (const raw of source.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) { section = line.slice(1, line.indexOf(']')); continue; }
    const separator = line.indexOf('=');
    const key = line.slice(0, separator).trim();
    if (separator < 1 || !['rpcuser', 'rpcpassword'].includes(key)) continue;
    if (section === '' || section === 'regtest') {
      (section === 'regtest' ? regtest : global)[key] = line.slice(separator + 1).trim();
    }
  }
  const values = { ...global, ...regtest };
  return { username: values.rpcuser, password: values.rpcpassword };
}

export function readConfig() {
  loadLocalEnv();
  const credentials = process.env.BITCOIN_RPC_USER && process.env.BITCOIN_RPC_PASSWORD
    ? {} : readBitcoinCredentials(process.env.BITCOIN_CONFIG_PATH);

  return Object.freeze({
    host: '127.0.0.1',
    actionsEnabled: process.env.DASHBOARD_ACTIONS_ENABLED !== 'false',
    port: integer('DASHBOARD_PORT', 3000),
    autoRefreshMs: integer('AUTO_REFRESH_MS', 10_000, { min: 3_000, max: 300_000 }),
    requestTimeoutMs: integer('REQUEST_TIMEOUT_MS', 4_000, { min: 500, max: 30_000 }),
    bitcoin: Object.freeze({
      ...localEndpoint(process.env.BITCOIN_RPC_HOST || '127.0.0.1', integer('BITCOIN_RPC_PORT', 18_443)),
      username: process.env.BITCOIN_RPC_USER || credentials.username || '',
      password: process.env.BITCOIN_RPC_PASSWORD || credentials.password || ''
    }),
    electrs: Object.freeze({
      ...localEndpoint(process.env.ELECTRS_HOST || '127.0.0.1', integer('ELECTRS_PORT', 60_401))
    })
  });
}
