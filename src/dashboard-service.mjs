import { publicError } from './errors.mjs';
import { deriveCoreSync, deriveElectrsState } from './status.mjs';

function fulfilled(result) {
  return result.status === 'fulfilled' ? result.value : null;
}

function recordError(errors, scope, result) {
  if (result.status === 'rejected') errors.push({ scope, ...publicError(result.reason) });
}

function satoshisPerVbyte(entry) {
  const baseBtc = entry?.fees?.base;
  if (!Number.isFinite(baseBtc) || !Number.isFinite(entry?.vsize) || entry.vsize <= 0) return null;
  return (baseBtc * 100_000_000) / entry.vsize;
}

export class DashboardService {
  constructor({ bitcoin, electrum, autoRefreshMs = 10_000, blockLimit = 6, transactionLimit = 8 }) {
    this.bitcoin = bitcoin;
    this.electrum = electrum;
    this.autoRefreshMs = autoRefreshMs;
    this.blockLimit = blockLimit;
    this.transactionLimit = transactionLimit;
  }

  async snapshot() {
    const errors = [];
    const [chainResult, electrsResult] = await Promise.allSettled([
      this.bitcoin.call('getblockchaininfo'),
      this.electrum.inspect()
    ]);
    recordError(errors, 'bitcoin-core', chainResult);
    recordError(errors, 'electrs', electrsResult);

    const chain = fulfilled(chainResult);
    const electrsInfo = fulfilled(electrsResult);
    let network = null;
    let mempoolInfo = null;
    let mempoolEntries = [];
    let blocks = [];
    let wallets = { loaded: [], available: [], transactions: [], reachable: false };

    if (chain?.chain === 'regtest') {
      const secondary = await Promise.allSettled([
        this.bitcoin.call('getnetworkinfo'),
        this.bitcoin.call('getmempoolinfo'),
        this.bitcoin.call('getrawmempool', [true]),
        this.#latestBlocks(chain.bestblockhash),
        this.#wallets()
      ]);
      const scopes = ['network', 'mempool', 'mempool-transactions', 'blocks', 'wallets'];
      secondary.forEach((result, index) => recordError(errors, scopes[index], result));
      network = fulfilled(secondary[0]);
      mempoolInfo = fulfilled(secondary[1]);
      mempoolEntries = this.#mapMempool(fulfilled(secondary[2]));
      blocks = fulfilled(secondary[3]) || [];
      wallets = fulfilled(secondary[4]) || wallets;
    } else if (chain) {
      errors.push({ scope: 'network', message: 'This dashboard expects Regtest. Wallet details and activity are hidden for other networks.' });
    }

    const coreSync = deriveCoreSync(chain);
    const electrsState = deriveElectrsState(electrsInfo, chain?.blocks, chain?.initialblockdownload === true);

    return {
      generatedAt: new Date().toISOString(),
      refreshAfterMs: this.autoRefreshMs,
      readOnly: true,
      core: {
        connected: Boolean(chain),
        endpoint: this.bitcoin.endpointLabel,
        network: chain?.chain || 'regtest',
        blocks: chain?.blocks ?? null,
        headers: chain?.headers ?? null,
        bestBlockHash: chain?.bestblockhash || null,
        initialBlockDownload: chain?.initialblockdownload ?? null,
        verificationProgress: chain?.verificationprogress ?? null,
        sizeOnDisk: chain?.size_on_disk ?? null,
        pruned: chain?.pruned ?? null,
        connections: network?.connections ?? null,
        version: network?.subversion || null,
        relayFee: network?.relayfee ?? null,
        sync: coreSync
      },
      blocks,
      mempool: {
        available: Boolean(mempoolInfo),
        size: mempoolInfo?.size ?? null,
        bytes: mempoolInfo?.bytes ?? null,
        usage: mempoolInfo?.usage ?? null,
        totalFee: mempoolInfo?.total_fee ?? null,
        maxMempoolMb: Number.isFinite(mempoolInfo?.maxmempool) ? mempoolInfo.maxmempool / 1_000_000 : null,
        minRelayFee: mempoolInfo?.mempoolminfee ?? null,
        entries: mempoolEntries
      },
      wallets,
      electrs: {
        connected: Boolean(electrsInfo) && electrsInfo.protocolReady !== false,
        tcpReachable: Boolean(electrsInfo),
        endpoint: this.electrum.endpointLabel,
        transport: 'TCP (unencrypted, local only)',
        serverSoftware: electrsInfo?.serverSoftware || null,
        protocolVersion: electrsInfo?.protocolVersion || null,
        tipHeight: electrsInfo?.tipHeight ?? null,
        latencyMs: electrsInfo?.latencyMs ?? null,
        status: electrsState
      },
      sparrow: {
        serverType: 'Private Electrum',
        url: `tcp://${this.electrum.endpointLabel}`,
        host: this.electrum.host,
        port: this.electrum.port,
        network: 'Regtest',
        ssl: false
      },
      errors
    };
  }

  async #latestBlocks(startHash) {
    const blocks = [];
    let hash = startHash;

    for (let index = 0; index < this.blockLimit && hash; index += 1) {
      const block = await this.bitcoin.call('getblock', [hash, 1]);
      blocks.push({
        hash: block.hash,
        height: block.height,
        time: block.time,
        medianTime: block.mediantime,
        transactions: block.nTx,
        size: block.size,
        weight: block.weight,
        confirmations: block.confirmations
      });
      hash = block.previousblockhash;
    }

    return blocks;
  }

  #mapMempool(raw) {
    if (!raw || typeof raw !== 'object') return [];
    return Object.entries(raw)
      .map(([txid, entry]) => ({
        txid,
        time: entry.time,
        vsize: entry.vsize,
        weight: entry.weight,
        fee: entry.fees?.base ?? null,
        feeRateSatVb: satoshisPerVbyte(entry),
        ancestorCount: entry.ancestorcount ?? null
      }))
      .sort((a, b) => (b.time || 0) - (a.time || 0))
      .slice(0, this.transactionLimit);
  }

  async #wallets() {
    const [loaded, directory] = await Promise.all([
      this.bitcoin.call('listwallets'),
      this.bitcoin.call('listwalletdir')
    ]);
    const loadedNames = Array.isArray(loaded) ? loaded : [];
    const available = Array.isArray(directory?.wallets)
      ? directory.wallets.map(({ name }) => ({ name, loaded: loadedNames.includes(name) }))
      : [];

    const walletDetails = await Promise.all(loadedNames.map(async (walletName) => {
      const [info, balances, transactions] = await Promise.all([
        this.bitcoin.call('getwalletinfo', [], walletName),
        this.bitcoin.call('getbalances', [], walletName),
        this.bitcoin.call('listtransactions', ['*', this.transactionLimit, 0, true], walletName)
      ]);
      return {
        name: info?.walletname ?? walletName,
        format: info?.format || null,
        descriptors: info?.descriptors ?? null,
        privateKeysEnabled: info?.private_keys_enabled ?? null,
        transactionCount: info?.txcount ?? 0,
        scanning: info?.scanning || false,
        balances: {
          trusted: balances?.mine?.trusted ?? 0,
          pending: balances?.mine?.untrusted_pending ?? 0,
          immature: balances?.mine?.immature ?? 0,
          watchOnly: balances?.watchonly?.trusted ?? null
        },
        transactions: (transactions || []).map((transaction) => ({
          txid: transaction.txid,
          blockHash: /^[a-f0-9]{64}$/i.test(transaction.blockhash || '') ? transaction.blockhash.toLowerCase() : null,
          category: transaction.category,
          amount: transaction.amount,
          fee: transaction.fee ?? null,
          confirmations: transaction.confirmations,
          time: transaction.time,
          address: transaction.address || null,
          label: transaction.label || null,
          abandoned: transaction.abandoned ?? false
        }))
      };
    }));

    return {
      reachable: true,
      loaded: walletDetails,
      available,
      transactions: walletDetails
        .flatMap((wallet) => wallet.transactions.map((transaction) => ({ ...transaction, wallet: wallet.name })))
        .sort((a, b) => (b.time || 0) - (a.time || 0))
        .slice(0, this.transactionLimit)
    };
  }
}
