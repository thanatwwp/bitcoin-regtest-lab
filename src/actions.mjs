import { DashboardError, publicError } from './errors.mjs';
import { ActionError } from './action-error.mjs';
import { blockPlan, buildBlock } from './block-builder.mjs';
export { ActionError } from './action-error.mjs';

const fields = {
  address: ['wallet'],
  mine: ['address', 'blocks'],
  send: ['wallet', 'address', 'amount', 'feeRate'],
  'build-block': ['wallet', 'transactions', 'feeRate']
};

function decimal(value, digits, max, label) {
  if (typeof value !== 'string' || !new RegExp(`^(0|[1-9][0-9]*)(\\.[0-9]{1,${digits}})?$`).test(value)
    || Number(value) <= 0 || Number(value) > max) {
    throw new ActionError(`${label} must be a positive decimal, at most ${max}, with up to ${digits} decimal places.`);
  }
  return value;
}

export function validateAction(action, body) {
  if (!Object.hasOwn(fields, action)) throw new ActionError('Unknown action.', 404);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ActionError('A JSON object is required.');
  const allowed = [...fields[action], 'confirmed', 'requestId'];
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new ActionError('Unexpected action fields.');
  if (body.confirmed !== true) throw new ActionError('Review and confirm the action first.');
  if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(body.requestId)) {
    throw new ActionError('A valid request ID is required.');
  }
  const result = { requestId: body.requestId, confirmed: true };
  if (fields[action].includes('wallet')) {
    if (typeof body.wallet !== 'string' || body.wallet.length > 256 || /[\x00-\x1f]/.test(body.wallet)) {
      throw new ActionError('Select a loaded Bitcoin Core wallet.');
    }
    result.wallet = body.wallet;
  }
  if (fields[action].includes('address')) {
    if (typeof body.address !== 'string' || !/^[A-Za-z0-9]{14,100}$/.test(body.address)) {
      throw new ActionError('Enter a Bitcoin address without spaces.');
    }
    result.address = body.address;
  }
  if (action === 'mine') {
    if (!Number.isInteger(body.blocks) || body.blocks < 1 || body.blocks > 101) {
      throw new ActionError('Generate between 1 and 101 blocks at a time.');
    }
    result.blocks = body.blocks;
  }
  if (action === 'send') {
    result.amount = decimal(body.amount, 8, 21_000_000, 'Amount in BTC');
    result.feeRate = decimal(body.feeRate, 3, 1_000, 'Fee rate in sat/vB');
  }
  if (action === 'build-block') {
    blockPlan(body.transactions, body.feeRate);
    result.transactions = body.transactions;
    result.feeRate = body.feeRate;
  }
  return result;
}

export class ActionService {
  #records = new Map();
  #busy = false;
  constructor({ bitcoin, enabled = true }) {
    this.bitcoin = bitcoin;
    this.enabled = enabled;
  }

  async execute(action, input, options = {}) {
    if (!this.enabled) throw new ActionError('Actions are disabled in the server settings.', 403, 'ACTIONS_DISABLED');
    const body = validateAction(action, input);
    const fingerprint = JSON.stringify({ action, ...body });
    const previous = this.#records.get(body.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new ActionError('This request ID belongs to a different action.', 409);
      return previous.promise;
    }
    if (this.#busy) throw new ActionError('Another action is in progress. Wait for its result.', 409, 'ACTION_BUSY');
    // Keep results, including uncertain failures, until server shutdown. Never
    // evict an ID and silently allow a repeated send to execute again.
    if (this.#records.size >= 1_000) throw new ActionError('This server session has reached its action limit. Restart after checking all results.', 429);
    this.#busy = true;
    const promise = this.#perform(action, body, options).finally(() => { this.#busy = false; });
    this.#records.set(body.requestId, { fingerprint, promise });
    return promise;
  }

  async #perform(action, body, options) {
    let dispatched = false;
    try {
      const chain = await this.bitcoin.call('getblockchaininfo');
      if (chain?.chain !== 'regtest') throw new ActionError('Actions require a verified Regtest node.', 403, 'WRONG_NETWORK');
      if (body.wallet !== undefined) {
        const loaded = await this.bitcoin.call('listwallets');
        if (!Array.isArray(loaded) || !loaded.includes(body.wallet)) throw new ActionError('The selected wallet is no longer loaded. Refresh and select a wallet.', 409);
      }
      if (body.address) {
        const validity = await this.bitcoin.call('validateaddress', [body.address]);
        if (!validity?.isvalid) throw new ActionError('Bitcoin Core does not recognize this as a valid address for its Regtest network.');
      }

      if (action === 'build-block') return await buildBlock(this.bitcoin, body, options);
      dispatched = true;
      if (action === 'address') {
        const address = await this.bitcoin.call('getnewaddress', ['', 'bech32'], body.wallet, { timeoutMs: 30_000 });
        if (typeof address !== 'string' || !address.startsWith('bcrt1')) throw new Error('Unexpected address result');
        return { action, requestId: body.requestId, address, wallet: body.wallet, message: 'Receiving address created.' };
      }
      if (action === 'mine') {
        const hashes = await this.bitcoin.call('generatetoaddress', [body.blocks, body.address], null, { timeoutMs: 30_000 });
        if (!Array.isArray(hashes) || hashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) throw new Error('Unexpected mining result');
        return { action, requestId: body.requestId, hashes, blocks: hashes.length, address: body.address, message: `Generated ${hashes.length} of ${body.blocks} requested blocks.` };
      }
      const txid = await this.bitcoin.call('sendtoaddress', {
        address: body.address,
        amount: body.amount,
        subtractfeefromamount: false,
        replaceable: true,
        fee_rate: body.feeRate
      }, body.wallet, { timeoutMs: 30_000 });
      if (typeof txid !== 'string' || !/^[a-f0-9]{64}$/.test(txid)) throw new Error('Unexpected send result');
      return { action, requestId: body.requestId, txid, amount: body.amount, wallet: body.wallet, message: 'Regtest transaction broadcast.' };
    } catch (error) {
      if (error instanceof ActionError) throw error;
      const rpcMessages = {
        '-6': 'Insufficient spendable balance. Newly mined rewards need to mature before spending.',
        '-13': 'This wallet is locked. Unlock it in your existing wallet workflow, then try again.',
        '-18': 'The selected wallet is not loaded.',
        '-5': 'Bitcoin Core rejected the destination address.',
        '-4': 'The wallet could not create this transaction or address. Check its signing capability and balance.',
        '-8': 'Bitcoin Core rejected an action parameter.',
        '-32601': 'This Bitcoin Core version does not support the requested action.'
      };
      if (Number.isInteger(error?.rpcCode)) throw new ActionError(rpcMessages[error.rpcCode] || 'Bitcoin Core rejected the action. Check your wallet and node configuration.', 422, 'RPC_ACTION_REJECTED');
      if (dispatched) throw new ActionError('The result could not be confirmed. The action may have completed. Refresh and check the wallet or chain before submitting a new action; do not repeat it blindly.', 502, 'OUTCOME_UNKNOWN');
      throw new ActionError(publicError(error).message, error instanceof DashboardError ? 503 : 500, 'ACTION_UNAVAILABLE');
    }
  }
}
