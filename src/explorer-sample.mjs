// An isolated, deterministic illustration. Never connects to a node or wallet.
import { createHash } from 'node:crypto';
const hash = (text) => createHash('sha256').update(String(text)).digest('hex');
function sampleAddress(index) {
  const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const program = Buffer.from(hash(`sample-address-${index}`).slice(0, 40), 'hex');
  let acc = 0, bits = 0;
  const data = [0];
  for (const byte of program) { acc = (acc << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; data.push((acc >>> bits) & 31); } }
  if (bits) data.push((acc << (5 - bits)) & 31);
  const hrp = 'bcrt', expanded = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat(0, [...hrp].map((c) => c.charCodeAt(0) & 31));
  let checksum = 1;
  for (const value of [...expanded, ...data, 0, 0, 0, 0, 0, 0]) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3].forEach((g, i) => { if ((top >>> i) & 1) checksum ^= g; });
  }
  checksum ^= 1;
  return { address: `${hrp}1${data.map((n) => alphabet[n]).join('')}${Array.from({ length: 6 }, (_, i) => alphabet[(checksum >>> (5 * (5 - i))) & 31]).join('')}`, script: `0014${program.toString('hex')}` };
}
export function createExplorerSample() {
  const height = 148, now = Math.floor(Date.now() / 1000) - 125;
  const addresses = [sampleAddress(1), sampleAddress(2), sampleAddress(3)];
  const blocks = [], transactions = new Map(), mempool = {}, calls = [];
  const spent = new Set();
  const output = (n, value, owner) => ({ n, value, scriptPubKey: { address: addresses[owner].address, hex: addresses[owner].script, type: 'witness_v0_keyhash' } });
  const fail = (code) => { const error = new Error('Simulated RPC unavailable'); error.rpcCode = code; throw error; };
  for (let n = 0; n <= height; n++) {
    const txid = hash(`atlas-coinbase-${n}`), blockHash = hash(`atlas-block-${n}`), time = now - (height - n) * 600;
    const tx = { txid, hash: txid, version: 2, locktime: 0, size: 164, vsize: 137, weight: 548,
      blockhash: blockHash, confirmations: height - n + 1, blocktime: time,
      vin: [{ coinbase: '03abcd01', sequence: 4294967295 }], vout: [output(0, 50, 0)] };
    transactions.set(txid, tx);
    blocks.push({ hash: blockHash, height: n, time, mediantime: time - 3000, confirmations: height - n + 1,
      versionHex: '20000000', merkleroot: hash(`merkle-${n}`), difficulty: 0.000000004656542373906925,
      bits: '207fffff', nonce: n % 3, previousblockhash: n > 0 ? hash(`atlas-block-${n - 1}`) : undefined,
      nextblockhash: n < height ? hash(`atlas-block-${n + 1}`) : undefined, size: 245, weight: 872, nTx: 1, tx: [txid] });
  }
  for (let i = 0; i < 30; i++) {
    const pending = i >= 21, n = 142 + Math.floor(i / 3), fee = 280 + i * 41;
    const txid = hash(`atlas-payment-${i}`), prev = hash(`atlas-coinbase-${i + 1}`), amount = (i + 1) / 20;
    const source = transactions.get(prev);
    spent.add(`${prev}:0`);
    const tx = { txid, hash: txid, version: 2, locktime: 0, size: 223, vsize: 141, weight: 562,
      confirmations: pending ? 0 : height - n + 1, fee: fee / 1e8,
      ...(pending ? {} : { blockhash: blocks[n].hash, blocktime: blocks[n].time }),
      vin: [{ txid: prev, vout: 0, sequence: 4294967293, prevout: { value: 50, scriptPubKey: source.vout[0].scriptPubKey } }],
      vout: [output(0, amount, 1 + (i % 2)), output(1, Math.round((50 - amount) * 1e8 - fee) / 1e8, 0)] };
    transactions.set(txid, tx);
    if (pending) mempool[txid] = { vsize: 141, time: now + (i - 21) * 9, fees: { base: fee / 1e8 } };
    else { blocks[n].tx.push(txid); blocks[n].nTx++; blocks[n].size += 223; blocks[n].weight += 562; }
  }
  const bitcoin = { endpointLabel: 'Sample chain', calls, async call(method, params = []) {
    calls.push({ method, params });
    if (calls.length > 1000) calls.shift();
    switch (method) {
      case 'getblockchaininfo': return { chain: 'regtest', blocks: height, headers: height, initialblockdownload: false, verificationprogress: 1, bestblockhash: blocks[height].hash, size_on_disk: 1456789, pruned: false };
      case 'getblockhash': return blocks[params[0]]?.hash || fail(-8);
      case 'getblock': { const b = blocks.find((item) => item.hash === params[0]); if (!b) return fail(-5); return { ...b, tx: params[1] >= 2 ? b.tx.map((id) => transactions.get(id)) : [...b.tx] }; }
      case 'getrawtransaction': { const tx = transactions.get(params[0]); if (!tx || (params[2] && tx.blockhash !== params[2])) return fail(-5); return structuredClone(tx); }
      case 'getmempoolinfo': return { size: Object.keys(mempool).length, bytes: Object.keys(mempool).length * 141, total_fee: Object.values(mempool).reduce((sum, tx) => sum + tx.fees.base, 0) };
      case 'getrawmempool': return structuredClone(mempool);
      case 'getmempoolentry': return mempool[params[0]] || fail(-5);
      case 'validateaddress': { const a = addresses.find((item) => item.address === params[0]); return a ? { isvalid: true, address: a.address, scriptPubKey: a.script } : { isvalid: false }; }
      default: throw new Error('Sample chain is read-only.');
    }
  } };
  const electrum = { async inspect() { return { tipHeight: height, protocolReady: true, tcpReachable: true }; } };
  const addressQuery = async (_, sh) => {
    const a = addresses.find((item) => createHash('sha256').update(Buffer.from(item.script, 'hex')).digest().reverse().toString('hex') === sh);
    const history = [], unspent = [];
    let confirmed = 0, unconfirmed = 0;
    for (const tx of transactions.values()) {
      const ins = tx.vin.filter((input) => input.prevout?.scriptPubKey?.address === a.address);
      const outs = tx.vout.filter((out) => out.scriptPubKey.address === a.address);
      if (ins.length || outs.length) history.push({ tx_hash: tx.txid, height: tx.blockhash ? blocks.find((b) => b.hash === tx.blockhash).height : 0 });
      const delta = Math.round((outs.reduce((sum, out) => sum + out.value, 0) - ins.reduce((sum, input) => sum + input.prevout.value, 0)) * 1e8);
      if (tx.blockhash) confirmed += delta; else unconfirmed += delta;
      for (const out of outs) if (!spent.has(`${tx.txid}:${out.n}`)) unspent.push({ tx_hash: tx.txid, tx_pos: out.n, value: Math.round(out.value * 1e8), height: tx.blockhash ? blocks.find((b) => b.hash === tx.blockhash).height : 0 });
    }
    return { tip: { height }, balance: { confirmed, unconfirmed }, history, unspent };
  };
  return { bitcoin, electrum, addressQuery, sample: true, addresses: addresses.map((a) => a.address) };
}
