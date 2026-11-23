// In-memory, simulated Regtest for UI and action tests. No real node is used.
import { createHash } from 'node:crypto';
export function createFixtureRpc() {
  let height = 105;
  let addresses = 0;
  const transactions = [];
  const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
  const calls = [];
  const prepared = new Map(), built = new Map();
  let rawCounter = 0;
  const script = '0014' + 'a'.repeat(40);
  const coin = { txid: hash('builder-funding'), vout: 0, amount: 1, confirmations: 101, safe: true, spendable: true, scriptPubKey: script };
  return {
    calls, host: '127.0.0.1', endpointLabel: 'SIMULATED NODE',
    async call(method, params = [], wallet = null) {
      calls.push({ method, params, wallet });
      switch (method) {
        case 'getblockchaininfo': return { chain: 'regtest', blocks: height, headers: height, bestblockhash: hash(height), initialblockdownload: false, verificationprogress: 1, size_on_disk: 1300000, pruned: false };
        case 'getnetworkinfo': return { subversion: 'Simulated Core', connections: 0 };
        case 'getblockhash': return hash(params[0]);
        case 'getblock': {
          if (built.has(params[0])) return structuredClone(built.get(params[0]));
          let n = height;
          while (n > 0 && hash(n) !== params[0]) n--;
          return { hash: hash(n), height: n, time: Math.floor(Date.now() / 1000), nTx: 1, size: 300, weight: 1200, confirmations: height - n + 1, previousblockhash: n > 0 ? hash(n - 1) : null };
        }
        case 'listwallets': return ['practice-wallet'];
        case 'listwalletdir': return { wallets: [{ name: 'practice-wallet' }] };
        case 'getwalletinfo': return { walletname: wallet, format: 'sqlite', txcount: transactions.length, private_keys_enabled: true, descriptors: true };
        case 'getbalances': return { mine: { trusted: 50, immature: 5000, untrusted_pending: 0 } };
        case 'listtransactions': return transactions;
        case 'getmempoolinfo': return { size: transactions.filter((tx) => !tx.confirmations).length, bytes: 141, usage: 736, mempoolminfee: .00001 };
        case 'getrawmempool': return Object.fromEntries(transactions.filter((tx) => !tx.confirmations).map((tx) => [tx.txid, { time: tx.time, vsize: 141, fees: { base: .00000141 } }]));
        case 'getnewaddress': return `bcrt1q${hash(++addresses).slice(0, 38)}`;
        case 'getaddressinfo': return { ismine: true, scriptPubKey: script };
        case 'listunspent': return [structuredClone(coin)];
        case 'gettxout': return { value: coin.amount, confirmations: coin.confirmations, scriptPubKey: { hex: script } };
        case 'createrawtransaction': {
          const hex = (++rawCounter).toString(16).padStart(8, '0');
          prepared.set(hex, { txid: hash(hex), vin: params[0], vout: [{ n: 0, value: Number(Object.values(params[1])[0]), scriptPubKey: { hex: script } }], weight: 438, vsize: 110 });
          return hex;
        }
        case 'signrawtransactionwithwallet': return { complete: true, hex: params[0] };
        case 'decoderawtransaction': return structuredClone(prepared.get(params[0]));
        case 'generateblock': {
          const blockHash = hash(++height);
          const txids = [hash('coinbase-' + height), ...params[1].map((hex) => prepared.get(hex).txid)];
          built.set(blockHash, { hash: blockHash, height, nTx: txids.length, tx: txids, time: Math.floor(Date.now() / 1000),
            previousblockhash: hash(height - 1), confirmations: 1, size: 250 + (txids.length - 1) * 192, weight: 872 + (txids.length - 1) * 438 });
          return { hash: blockHash };
        }
        case 'validateaddress': return { isvalid: params[0].startsWith('bcrt1') };
        case 'generatetoaddress': {
          const hashes = Array.from({ length: params[0] }, () => hash(++height));
          transactions.forEach((tx) => { tx.confirmations += params[0]; });
          return hashes;
        }
        case 'sendtoaddress': {
          const txid = hash(`tx-${transactions.length}`);
          transactions.push({ txid, category: 'send', amount: -Number(params.amount), confirmations: 0, time: Math.floor(Date.now() / 1000) });
          return txid;
        }
        default: throw new Error('Unsupported fixture method');
      }
    }
  };
}
