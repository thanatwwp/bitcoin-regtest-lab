import { ActionError } from './action-error.mjs';

const HASH = /^[a-f0-9]{64}$/;
const P2WPKH = /^0014[a-f0-9]{40}$/;
const BLOCK_WEIGHT = 4_000_000;
const BLOCK_RESERVE = 4_000;
const MAX_MONEY = 2_100_000_000_000_000;
const btc = (sats) => `${Math.floor(sats / 100_000_000)}.${String(sats % 100_000_000).padStart(8, '0')}`;
const sats = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 21_000_000
  ? Math.round(value * 100_000_000) : null;

export function blockPlan(count, feeRate) {
  if (!Number.isSafeInteger(count) || count < 1) throw new ActionError('Choose a whole transaction count of at least 1, including the mining reward.');
  // Even the unsigned base of our one-input/one-output transaction weighs 328 WU.
  // Reject impossible requests before allocating or contacting the node. Actual
  // signed weights are checked below; this is not a preset transaction-count cap.
  if ((count - 1) * 328 + BLOCK_RESERVE > BLOCK_WEIGHT) throw new ActionError('That count cannot fit in one Bitcoin block. Choose fewer transactions.');
  if (typeof feeRate !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]{1,3})?$/.test(feeRate)
      || Number(feeRate) <= 0 || Number(feeRate) > 1000) throw new ActionError('Choose a fee rate above 0 and at most 1000 sat/vB, with up to 3 decimal places.');
  const milliRate = Math.round(Number(feeRate) * 1000);
  // A native SegWit transaction with one input and one output is at most 110 vB.
  const feePerTransfer = Math.ceil(milliRate * 110 / 1000);
  return { count, transfers: count - 1, feePerTransfer, totalFeeSats: (count - 1) * feePerTransfer,
    totalFeeBtc: btc((count - 1) * feePerTransfer) };
}

export async function buildBlock(bitcoin, body, { signal, now = Date.now, budgetMs = 120_000 } = {}) {
  const plan = blockPlan(body.transactions, body.feeRate);
  const deadline = now() + budgetMs;
  let submitted = false;
  let createdHash = null;
  const check = () => {
    if (signal?.aborted) throw new ActionError('The connection closed before mining. No block was submitted; a receiving address may have been created.', 409, 'BUILD_CANCELLED');
    if (now() >= deadline) throw new ActionError('Preparation took too long. No block was submitted. Try a smaller block.', 408, 'BUILD_TIMEOUT');
  };
  const call = async (method, params = [], wallet = null) => {
    check();
    const result = await bitcoin.call(method, params, wallet, { timeoutMs: Math.min(30_000, Math.max(1, deadline - now())) });
    check();
    return result;
  };
  try {
    const info = await call('getwalletinfo', [], body.wallet);
    if (info?.private_keys_enabled !== true || info?.external_signer === true) throw new ActionError('Choose a Core wallet that can sign locally. Watch-only and external-signer wallets cannot build these test transfers.');
    if (info.unlocked_until !== undefined && info.unlocked_until <= Math.floor(now() / 1000)) throw new ActionError('Unlock this wallet through your existing wallet workflow before building a block.');
    let coin = null;
    if (plan.transfers) {
      const unspent = await call('listunspent', [1, 9999999, [], false], body.wallet);
      coin = (Array.isArray(unspent) ? unspent : []).filter((u) => u.spendable === true && u.safe !== false
        && u.confirmations >= 1 && HASH.test(u.txid) && Number.isInteger(u.vout) && u.vout >= 0
        && P2WPKH.test(u.scriptPubKey) && sats(u.amount) !== null && sats(u.amount) >= plan.totalFeeSats + 1000)
        .sort((a, b) => a.amount - b.amount)[0];
      if (!coin) throw new ActionError('This wallet needs one confirmed, spendable native SegWit output that covers the fees plus 1,000 satoshis. Existing mining rewards must be mature. No block was submitted.', 422, 'BUILD_FUNDS_UNAVAILABLE');
    }
    const address = await call('getnewaddress', ['Block builder', 'bech32'], body.wallet);
    if (typeof address !== 'string' || !/^bcrt1q[a-z0-9]{38}$/.test(address)) throw new ActionError('Core did not return a native SegWit Regtest address. No block was submitted.', 502);
    const own = await call('getaddressinfo', [address], body.wallet);
    if (own?.ismine !== true || !P2WPKH.test(own.scriptPubKey)) throw new ActionError('The receiving address could not be verified as belonging to this wallet. No block was submitted.', 502);
    let previous = coin ? { txid: coin.txid, vout: coin.vout, scriptPubKey: coin.scriptPubKey, amount: btc(sats(coin.amount)) } : null;
    let remaining = coin ? sats(coin.amount) : 0;
    let weight = BLOCK_RESERVE;
    const raw = [], txids = [];
    for (let index = 0; index < plan.transfers; index++) {
      check();
      remaining -= plan.feePerTransfer;
      if (!Number.isSafeInteger(remaining) || remaining < 1000 || remaining > MAX_MONEY) throw new ActionError('The remaining output would be too small. No block was submitted.');
      const unsigned = await call('createrawtransaction', [[{ txid: previous.txid, vout: previous.vout, sequence: 4294967294 }],
        { [address]: btc(remaining) }, 0, false]);
      const signed = await call('signrawtransactionwithwallet', [unsigned, [previous], 'ALL'], body.wallet);
      if (signed?.complete !== true || typeof signed.hex !== 'string' || !/^(?:[a-f0-9]{2}){1,1024}$/.test(signed.hex)) {
        throw new ActionError('The wallet could not fully sign a test transfer. No block was submitted.', 422, 'BUILD_SIGNING_FAILED');
      }
      const tx = await call('decoderawtransaction', [signed.hex]);
      if (!HASH.test(tx?.txid) || !Number.isInteger(tx.weight) || tx.weight < 328 || tx.weight > 440
        || !Number.isInteger(tx.vsize) || tx.vsize < 1 || tx.vsize > 110
        || tx.vin?.length !== 1 || tx.vin[0].txid !== previous.txid || tx.vin[0].vout !== previous.vout
        || tx.vout?.length !== 1 || tx.vout[0].n !== 0 || tx.vout[0].scriptPubKey?.hex !== own.scriptPubKey
        || sats(tx.vout[0].value) !== remaining) throw new ActionError('A prepared transfer did not match the reviewed plan. No block was submitted.', 502, 'BUILD_VERIFICATION_FAILED');
      weight += tx.weight;
      if (weight > BLOCK_WEIGHT) throw new ActionError('These signed transactions exceed the Bitcoin block weight budget. No block was submitted. Choose fewer transactions.', 422, 'BLOCK_TOO_LARGE');
      raw.push(signed.hex); txids.push(tx.txid);
      previous = { txid: tx.txid, vout: 0, scriptPubKey: own.scriptPubKey, amount: btc(remaining) };
    }
    const chain = await call('getblockchaininfo');
    if (chain?.chain !== 'regtest') throw new ActionError('The node is no longer verified as Regtest. No block was submitted.', 403, 'WRONG_NETWORK');
    if (coin) {
      const current = await call('gettxout', [coin.txid, coin.vout, true]);
      if (!current || current.confirmations < 1 || sats(current.value) !== sats(coin.amount)
        || current.scriptPubKey?.hex !== coin.scriptPubKey) throw new ActionError('The funding output changed while preparing the block. No block was submitted. Refresh and review again.', 409, 'BUILD_INPUT_CHANGED');
    }
    check();
    submitted = true;
    // Ordered raw transactions avoid a mempool ancestor-chain limit. They are
    // validated by Core together, and become visible only in the new block.
    const mined = await bitcoin.call('generateblock', [address, raw], null, { timeoutMs: 30_000 });
    if (!HASH.test(mined?.hash)) throw new Error('Unexpected block result');
    createdHash = mined.hash;
    const block = await bitcoin.call('getblock', [createdHash, 1]);
    if (block?.hash !== createdHash || block.nTx !== plan.count || block.tx?.length !== plan.count
      || txids.some((id, i) => block.tx[i + 1] !== id)) throw new Error('Unexpected block contents');
    return { action: 'build-block', requestId: body.requestId, wallet: body.wallet, hash: createdHash,
      height: block.height, transactions: block.nTx, transfers: plan.transfers, feeBtc: plan.totalFeeBtc,
      message: `Created block ${block.height} with ${block.nTx} transaction${block.nTx === 1 ? '' : 's'}: ${plan.transfers} test transfers and 1 mining reward.` };
  } catch (error) {
    if (error instanceof ActionError) throw error;
    if (submitted) {
      // Only explicit parameter/decoding/validity errors conclusively precede mining.
      if ([-5, -8, -22, -25, -32601].includes(error?.rpcCode) && !createdHash) {
        throw new ActionError('Core rejected this block or does not support the block builder. No automatic retry was made. Check your wallet funds and Core version.', 422, 'BUILD_REJECTED');
      }
      throw new ActionError(`The block result could not be verified. It may have been mined. ${createdHash ? `Check block ${createdHash}. ` : ''}Refresh the explorer before submitting again; do not repeat blindly.`, 502, 'OUTCOME_UNKNOWN');
    }
    throw new ActionError('Block preparation failed. No block was submitted; a receiving address may have been created. Check that your wallet is loaded, unlocked and able to sign.', 503, 'BUILD_PREPARATION_FAILED');
  }
}
