import { createHash } from 'node:crypto';
import { deriveCoreSync, deriveElectrsState } from './status.mjs';
import { publicError } from './errors.mjs';
import { queryAddressIndex } from './electrum-query.mjs';

export class ExplorerError extends Error {
  constructor(message, status = 400, code = 'INVALID_QUERY') { super(message); this.status = status; this.code = code; }
}
const HASH = /^[a-f0-9]{64}$/i;
const PAGE = 25;
const sats = (value) => Number.isFinite(value) ? Math.round(value * 100_000_000) : null;
const safeHash = (value) => { if (!HASH.test(value || '')) throw new ExplorerError('Enter a complete 64-character hash.'); return value.toLowerCase(); };
export function pageNumber(value = 0) {
  if (!/^\d{1,9}$/.test(String(value))) throw new ExplorerError('The page offset must be a non-negative integer.');
  return Number(value);
}
export function scriptHash(script) { return createHash('sha256').update(Buffer.from(script, 'hex')).digest().reverse().toString('hex'); }

export class ExplorerService {
  constructor({ bitcoin, electrum, addressQuery = queryAddressIndex, sample = false, scanLimit = 200 }) {
    Object.assign(this, { bitcoin, electrum, addressQuery, sample, scanLimit });
    this.locations = new Map();
  }
  async chain() {
    const chain = await this.bitcoin.call('getblockchaininfo');
    if (chain.chain !== 'regtest') throw new ExplorerError('This explorer is configured for Regtest. Connect your Regtest node to continue.', 409, 'WRONG_NETWORK');
    return chain;
  }
  remember(block) {
    for (const tx of block.tx || []) this.locations.set(typeof tx === 'string' ? tx : tx.txid, block.hash);
    while (this.locations.size > 10000) this.locations.delete(this.locations.keys().next().value);
  }
  summary(block) {
    return { hash: block.hash, height: block.height, time: block.time, transactions: block.nTx ?? block.tx?.length ?? 0,
      size: block.size, weight: block.weight, confirmations: block.confirmations, previous: block.previousblockhash || null, next: block.nextblockhash || null };
  }
  async overview() {
    const [core, index] = await Promise.allSettled([this.chain(), this.electrum.inspect()]);
    const chain = core.status === 'fulfilled' ? core.value : null;
    const indexed = index.status === 'fulfilled' ? index.value : null;
    const errors = [];
    if (!chain) errors.push(core.reason instanceof ExplorerError ? { message: core.reason.message } : publicError(core.reason));
    let blocks = [], mempool = null;
    if (chain) {
      const results = await Promise.allSettled([this.blocks(null, 12, chain), this.mempool(0, chain)]);
      if (results[0].status === 'fulfilled') blocks = results[0].value.blocks;
      else errors.push(publicError(results[0].reason, 'Recent blocks could not be read.'));
      if (results[1].status === 'fulfilled') mempool = results[1].value;
      else errors.push(publicError(results[1].reason, 'Mempool data could not be read.'));
    }
    return { sample: this.sample, generatedAt: new Date().toISOString(), connected: Boolean(chain),
      chain: chain ? { height: chain.blocks, headers: chain.headers, bestHash: chain.bestblockhash, ibd: chain.initialblockdownload,
        pruned: chain.pruned, diskBytes: chain.size_on_disk, sync: deriveCoreSync(chain) } : null,
      index: { height: indexed?.tipHeight ?? null, ...deriveElectrsState(indexed, chain?.blocks, chain?.initialblockdownload) },
      blocks, mempool, errors };
  }
  async blocks(start = null, limit = 20, knownChain = null) {
    const chain = knownChain || await this.chain();
    const height = start === null || start === '' ? chain.blocks : pageNumber(start);
    if (height > chain.blocks) throw new ExplorerError(`The chain currently ends at block ${chain.blocks}.`, 404, 'NOT_FOUND');
    let hash = await this.bitcoin.call('getblockhash', [height]);
    const blocks = [];
    for (let i = 0; i < Math.min(limit, 20) && hash; i++) {
      const block = await this.bitcoin.call('getblock', [hash, 1]);
      this.remember(block);
      blocks.push(this.summary(block));
      hash = block.previousblockhash;
    }
    return { blocks, tip: chain.blocks, next: blocks.at(-1)?.height > 0 ? blocks.at(-1).height - 1 : null };
  }
  async block(id, offset = 0) {
    const chain = await this.chain();
    offset = pageNumber(offset);
    let hash;
    if (/^\d{1,9}$/.test(id)) {
      const height = Number(id);
      if (height > chain.blocks) throw new ExplorerError(`Block ${height} has not been mined on this chain.`, 404, 'NOT_FOUND');
      hash = await this.bitcoin.call('getblockhash', [height]);
    } else hash = safeHash(id);
    let block;
    try { block = await this.bitcoin.call('getblock', [hash, 1]); }
    catch (error) { if ([-5, -8].includes(error.rpcCode)) throw new ExplorerError('That block is not available on this node.', 404, 'NOT_FOUND'); throw error; }
    this.remember(block);
    return { ...this.summary(block), merkleRoot: block.merkleroot, difficulty: block.difficulty, nonce: block.nonce,
      version: block.versionHex, bits: block.bits, medianTime: block.mediantime,
      txids: (block.tx || []).slice(offset, offset + PAGE), offset, nextOffset: offset + PAGE < block.tx.length ? offset + PAGE : null };
  }
  async transaction(txid, blockHash = null, blockHeight = null) {
    txid = safeHash(txid);
    if (blockHash) blockHash = safeHash(blockHash);
    const chain = await this.chain();
    if (!blockHash && blockHeight !== null) {
      const height = pageNumber(blockHeight);
      if (height > chain.blocks) throw new ExplorerError('The transaction block is not available yet.', 404, 'NOT_FOUND');
      blockHash = await this.bitcoin.call('getblockhash', [height]);
    }
    let located = blockHash || this.locations.get(txid);
    const read = async (hash) => {
      const args = [txid, 2, ...(hash ? [hash] : [])];
      try { return await this.bitcoin.call('getrawtransaction', args); }
      catch (error) {
        // Undo data / verbosity support can be absent; raw data may still exist.
        if (![-1, -8].includes(error.rpcCode)) throw error;
        args[1] = 1;
        return this.bitcoin.call('getrawtransaction', args);
      }
    };
    let tx;
    try { tx = await read(located); }
    catch (error) {
      if (error.rpcCode !== -5) throw error;
      // Old wallet transactions can predate the bounded scan. Read only their
      // block location from already-loaded wallets; never load or rescan one.
      if (!blockHash) {
        blockHash = await this.walletBlock(txid);
        if (blockHash) {
          located = blockHash;
          try { tx = await read(blockHash); }
          catch (walletError) { if (walletError.rpcCode !== -5) throw walletError; }
        }
      }
      if (!tx && blockHash) {
        // Core does not serve the genesis coinbase via getrawtransaction.
        const block = await this.bitcoin.call('getblock', [blockHash, 2]);
        const found = block.tx.find((item) => item.txid === txid);
        if (!found) throw new ExplorerError('This transaction is not available in the selected block.', 404, 'NOT_FOUND');
        tx = { ...found, blockhash: blockHash, confirmations: block.confirmations, blocktime: block.time };
      } else if (!tx) {
      // A small Regtest lab need not enable txindex or reindex existing data.
      let hash = chain.bestblockhash;
      const deadline = Date.now() + 15000;
      located = null;
      for (let i = 0; i < this.scanLimit && hash && Date.now() < deadline; i++) {
        const block = await this.bitcoin.call('getblock', [hash, 1]);
        this.remember(block);
        if (block.tx.includes(txid)) { located = block.hash; break; }
        hash = block.previousblockhash;
      }
      if (!located) throw new ExplorerError(`Transaction not found in the available wallet lookup or recent chain scan. Without Core's transaction index, search checks up to the latest ${this.scanLimit} blocks with a 15-second scan limit. For older transactions, open their block or address history first.`, 404, 'TX_UNAVAILABLE');
      try { tx = await read(located); }
      catch (error) {
        if (error.rpcCode !== -5) throw error;
        // Genesis coinbase is deliberately absent from Core's transaction index.
        const fullBlock = await this.bitcoin.call('getblock', [located, 2]);
        tx = fullBlock.tx.find((item) => item.txid === txid);
        if (!tx) throw new ExplorerError('Transaction data is unavailable on this node.', 404, 'TX_UNAVAILABLE');
        tx = { ...tx, blockhash: located, confirmations: fullBlock.confirmations, blocktime: fullBlock.time };
      }
      }
    }
    let feeSats = sats(tx.fee);
    if (feeSats === null && !(tx.vin || []).some((input) => input.coinbase)) {
      const values = (tx.vin || []).map((input) => sats(input.prevout?.value));
      if (values.length && values.every((value) => value !== null)) feeSats = values.reduce((a, b) => a + b, 0) - tx.vout.reduce((sum, output) => sum + sats(output.value), 0);
      else if (!tx.blockhash) {
        try { feeSats = sats((await this.bitcoin.call('getmempoolentry', [txid])).fees.base); } catch { /* May have just confirmed. */ }
      }
    }
    return { txid: tx.txid, blockHash: tx.blockhash || located || null, confirmations: tx.confirmations ?? 0,
      time: tx.blocktime || tx.time || null, size: tx.size, vsize: tx.vsize, weight: tx.weight, version: tx.version, locktime: tx.locktime,
      feeSats, feeRate: feeSats !== null && tx.vsize ? feeSats / tx.vsize : null,
      coinbase: (tx.vin || []).some((input) => Boolean(input.coinbase)),
      totalOutputSats: tx.vout.reduce((sum, output) => sum + sats(output.value), 0),
      inputs: tx.vin.map((input) => ({ coinbase: input.coinbase || null, txid: input.txid || null, vout: input.vout ?? null,
        address: input.prevout?.scriptPubKey?.address || null, valueSats: sats(input.prevout?.value), sequence: input.sequence })),
      outputs: tx.vout.map((output) => ({ index: output.n, valueSats: sats(output.value), address: output.scriptPubKey?.address || null,
        type: output.scriptPubKey?.type || 'unknown', script: output.scriptPubKey?.hex || '' })) };
  }
  async walletBlock(txid) {
    const deadline = Date.now() + 4000;
    const call = (method, params = [], wallet = null) => this.bitcoin.call(method, params, wallet,
      { timeoutMs: Math.max(1, deadline - Date.now()) });
    try {
      const wallets = await call('listwallets');
      if (!Array.isArray(wallets)) return null;
      for (const wallet of wallets.slice(0, 20)) {
        if (Date.now() >= deadline) break;
        if (typeof wallet !== 'string' || wallet.length > 256 || /[\x00-\x1f]/.test(wallet)) continue;
        try {
          const tx = await call('gettransaction', [txid], wallet);
          if (tx?.txid === txid && tx.confirmations > 0 && HASH.test(tx.blockhash || '')) return tx.blockhash.toLowerCase();
        } catch { /* Wallet may not contain this transaction or may have unloaded. */ }
      }
    } catch { /* Wallet support is optional; the bounded chain scan still works. */ }
    return null;
  }
  async mempool(offset = 0, knownChain = null) {
    if (!knownChain) await this.chain();
    offset = pageNumber(offset);
    const [info, raw] = await Promise.all([this.bitcoin.call('getmempoolinfo'), this.bitcoin.call('getrawmempool', [true])]);
    const entries = Object.entries(raw).map(([txid, entry]) => ({ txid, time: entry.time, vsize: entry.vsize,
      feeSats: sats(entry.fees?.base), feeRate: entry.vsize && Number.isFinite(entry.fees?.base) ? sats(entry.fees.base) / entry.vsize : null }))
      .sort((a, b) => b.time - a.time || a.txid.localeCompare(b.txid));
    return { count: info.size, bytes: info.bytes, totalFeeSats: sats(info.total_fee), entries: entries.slice(offset, offset + PAGE),
      offset, nextOffset: offset + PAGE < entries.length ? offset + PAGE : null };
  }
  async address(address, offset = 0) {
    if (!/^[a-zA-Z0-9]{14,100}$/.test(address || '')) throw new ExplorerError('Enter a valid Regtest Bitcoin address.');
    offset = pageNumber(offset);
    const chain = await this.chain();
    const validation = await this.bitcoin.call('validateaddress', [address]);
    if (!validation.isvalid || !validation.scriptPubKey) throw new ExplorerError('This address is not valid for your Regtest node.');
    let data;
    try { data = await this.addressQuery(this.electrum, scriptHash(validation.scriptPubKey)); }
    catch { throw new ExplorerError('Address history needs electrs to finish indexing and answer Electrum requests. Bitcoin Core alone does not provide a full address index. If Core reports IBD with 0 missing blocks, electrs may still be waiting.', 503, 'INDEX_UNAVAILABLE'); }
    if (!Array.isArray(data.history) || !Array.isArray(data.unspent) || !Number.isSafeInteger(data.balance?.confirmed)
      || !Number.isSafeInteger(data.balance?.unconfirmed) || !Number.isInteger(data.tip?.height)) {
      throw new ExplorerError('The address index returned incomplete data. Try again after electrs is ready.', 503, 'INDEX_UNAVAILABLE');
    }
    const history = [...data.history].sort((a, b) => (b.height <= 0 ? Infinity : b.height) - (a.height <= 0 ? Infinity : a.height));
    const selected = [];
    for (const entry of history.slice(offset, offset + PAGE)) {
      let blockHash = null;
      if (entry.height > 0 && entry.height <= chain.blocks) blockHash = await this.bitcoin.call('getblockhash', [entry.height]);
      selected.push({ txid: entry.tx_hash, height: entry.height, blockHash });
      if (blockHash) this.locations.set(entry.tx_hash, blockHash);
    }
    while (this.locations.size > 10000) this.locations.delete(this.locations.keys().next().value);
    return { address: validation.address || address, script: validation.scriptPubKey, confirmedSats: data.balance.confirmed,
      pendingSats: data.balance.unconfirmed, indexHeight: data.tip.height, coreHeight: chain.blocks, count: history.length,
      history: selected, offset, nextOffset: offset + PAGE < history.length ? offset + PAGE : null,
      unspentCount: data.unspent.length, unspent: data.unspent.slice(0, 50).map((out) => ({ txid: out.tx_hash, index: out.tx_pos, valueSats: out.value, height: out.height })) };
  }
  async search(query) {
    const q = String(query || '').trim();
    if (/^\d{1,9}$/.test(q)) { const block = await this.block(q); return { kind: 'block', id: block.hash }; }
    if (HASH.test(q)) {
      try { const block = await this.block(q); return { kind: 'block', id: block.hash }; }
      catch (error) { if (!(error instanceof ExplorerError && error.status === 404)) throw error; }
      const tx = await this.transaction(q);
      return { kind: 'transaction', id: tx.txid, block: tx.blockHash };
    }
    if (!/^[a-zA-Z0-9]{14,100}$/.test(q)) throw new ExplorerError('Search a block height, full block hash, transaction ID, or Regtest address.');
    await this.chain();
    const validation = await this.bitcoin.call('validateaddress', [q]);
    if (!validation.isvalid) throw new ExplorerError('That address is not valid for Regtest.');
    return { kind: 'address', id: validation.address || q };
  }
}
