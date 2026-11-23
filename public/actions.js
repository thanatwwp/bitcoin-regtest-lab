const el = (id) => document.getElementById(id);
let snapshot = null;
let token = null;
let busy = false;
let pending = null;
let walletsKey = '';

async function session() {
  const response = await fetch('/api/session', { cache: 'no-store' });
  if (!response.ok) throw new Error('Reload the dashboard to reconnect your local session.');
  token = (await response.json()).token;
}

function syncControls() {
  const available = Boolean(snapshot?.interactions?.available);
  const wallets = snapshot?.wallets?.loaded || [];
  el('mine-fields').disabled = busy || !available;
  el('address-fields').disabled = busy || !available || !wallets.length;
  el('send-fields').disabled = busy || !available || !wallets.length;
  el('builder-fields').disabled = busy || !available || !wallets.length;
  el('mode-label').textContent = snapshot?.testing ? 'SIMULATED TEST DATA' : snapshot?.readOnly ? 'Local · read-only' : 'Local · interactive';
  el('action-availability').textContent = busy ? 'Action submitted. Waiting for Bitcoin Core…'
    : snapshot?.interactions?.reason || (wallets.length ? 'Connected to Regtest. Review each action before it runs.'
      : 'Load a wallet in Bitcoin Core to receive, send or build a block. You can still generate blocks to an existing address.');
  const nextKey = JSON.stringify(wallets.map((wallet) => wallet.name));
  if (nextKey !== walletsKey) {
    for (const id of ['receive-wallet', 'send-wallet', 'builder-wallet']) {
      const select = el(id);
      const previous = select.value;
      select.replaceChildren();
      if (!wallets.length) select.add(new Option('No loaded wallets', ''));
      for (const wallet of wallets) select.add(new Option(wallet.name || '(default wallet)', wallet.name));
      if (wallets.some((wallet) => wallet.name === previous)) select.value = previous;
    }
    walletsKey = nextKey;
  }
}

document.addEventListener('dashboard-updated', (event) => {
  snapshot = event.detail;
  syncControls();
});
document.addEventListener('dashboard-unavailable', () => {
  snapshot = { ...snapshot, interactions: { available: false, reason: 'Dashboard connection lost. Refresh to reconnect.' } };
  syncControls();
});

function review(action, data, title, details, note) {
  if (busy || !snapshot?.interactions?.available) return;
  pending = { action, body: { ...data, confirmed: true, requestId: crypto.randomUUID() } };
  el('confirm-title').textContent = title;
  el('confirm-note').textContent = note;
  el('confirm-details').replaceChildren();
  for (const [name, value] of details) {
    const row = document.createElement('div');
    const term = document.createElement('dt');
    const definition = document.createElement('dd');
    term.textContent = name;
    definition.textContent = value;
    row.append(term, definition);
    el('confirm-details').append(row);
  }
  el('action-dialog').showModal();
  el('cancel-action').focus();
}

el('address-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const wallet = el('receive-wallet').value;
  review('address', { wallet }, 'Create a receiving address?', [['Wallet', wallet || '(default wallet)'], ['Type', 'Native SegWit · Regtest']], 'This adds a new receiving address to the selected wallet.');
});
el('mine-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const address = el('mining-address').value.trim();
  const blocks = Number(el('mining-count').value);
  review('mine', { address, blocks }, `Generate ${blocks} block${blocks === 1 ? '' : 's'}?`, [['Network', 'Regtest'], ['Blocks', String(blocks)], ['Reward destination', address]], 'This advances your local chain and can confirm pending transactions. New mining rewards mature after 100 additional blocks.');
});
el('send-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const wallet = el('send-wallet').value;
  const address = el('send-address').value.trim();
  const amount = el('send-amount').value.trim();
  const feeRate = el('send-fee').value;
  review('send', { wallet, address, amount, feeRate }, 'Send test bitcoin?', [['Network', 'Regtest'], ['From wallet', wallet || '(default wallet)'], ['Recipient', address], ['Amount', `${amount} BTC`], ['Fee rate', `${feeRate} sat/vB · paid by sender`]], 'This broadcasts a transaction on your local Regtest chain. Review the recipient and amount before confirming.');
});
el('builder-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const wallet = el('builder-wallet').value;
  const transactions = Number(el('builder-count').value);
  const feeRate = el('builder-fee').value;
  if (!Number.isSafeInteger(transactions) || transactions < 1) {
    showResult('Choose a whole transaction count of at least 1.', [], true); return;
  }
  const transfers = transactions - 1;
  const feeSats = transfers * Math.ceil(Math.round(Number(feeRate) * 1000) * 110 / 1000);
  review('build-block', { wallet, transactions, feeRate }, `Build a block with ${transactions.toLocaleString()} transactions?`,
    [['Network', 'Regtest'], ['Wallet', wallet || '(default wallet)'], ['New blocks', '1'],
      ['Contents', `${transfers.toLocaleString()} test transfers + 1 mining reward`], ['Fee rate', `${feeRate} sat/vB`],
      ['Total transfer fees', `${(feeSats / 1e8).toFixed(8)} BTC (${feeSats.toLocaleString()} sats)`]],
    'Creates one receiving address in this wallet, prepares transfers back to that address, and mines them together. Fees reduce your balance. Other pending transactions are left for a later block. Large builds can take up to two minutes to prepare.');
});

el('cancel-action').addEventListener('click', () => { pending = null; el('action-dialog').close(); });
el('action-dialog').addEventListener('cancel', () => { pending = null; });
for (const button of document.querySelectorAll('[data-blocks]')) {
  button.addEventListener('click', () => { el('mining-count').value = button.dataset.blocks; });
}
for (const button of document.querySelectorAll('[data-transactions]')) {
  button.addEventListener('click', () => { el('builder-count').value = button.dataset.transactions; });
}
el('use-mining-address').addEventListener('click', () => {
  el('mining-address').value = el('receiving-address').textContent;
  el('mining-address').focus();
});

function showResult(message, details = [], failed = false) {
  const box = el('action-result');
  box.classList.remove('is-hidden');
  box.classList.toggle('has-error', failed);
  box.replaceChildren();
  const heading = document.createElement('strong');
  heading.textContent = message;
  box.append(heading);
  for (const detail of details) {
    const line = document.createElement('p');
    line.textContent = detail;
    box.append(line);
  }
}

el('confirm-action').addEventListener('click', async () => {
  if (!pending || busy) return;
  const request = pending;
  pending = null;
  busy = true;
  el('action-dialog').close();
  syncControls();
  let submitted = false;
  try {
    if (!token) await session();
    showResult(request.action === 'build-block' ? 'Preparing your block…' : 'Working…',
      [request.action === 'build-block' ? 'Signing the test transfers, then mining one block. Keep this page open. Large builds may take up to two minutes to prepare.' : 'Waiting for Bitcoin Core to confirm the result.']);
    submitted = true;
    const response = await fetch(`/api/actions/${request.action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dashboard-token': token },
      body: JSON.stringify(request.body)
    });
    const payload = await response.json();
    if (!response.ok) {
      if (payload.code === 'INVALID_SESSION') token = null;
      showResult(payload.error || 'The action could not be completed.', [`Request: ${request.body.requestId}`], true);
      return;
    }
    const result = payload.result;
    if (request.action === 'address') {
      el('receiving-address').textContent = result.address;
      el('address-output').classList.remove('is-hidden');
    }
    const details = result.hash ? [`Block: ${result.hash}`, `Transfer fees: ${result.feeBtc} BTC`]
      : result.txid ? [`Transaction ID: ${result.txid}`]
      : result.hashes ? [`Last block: ${result.hashes.at(-1) || 'No block generated'}`]
        : [`Wallet: ${result.wallet || '(default wallet)'}`];
    showResult(result.message, [...details, `Request: ${result.requestId}`]);
    if (/^[a-f0-9]{64}$/.test(result.hash || '')) {
      const link = document.createElement('a');
      link.href = `/explorer/#/block/${result.hash}`;
      link.className = 'data-link';
      link.textContent = 'Open this block in Chain Atlas →';
      el('action-result').append(link);
    }
  } catch {
    showResult(submitted ? 'Connection interrupted. The action may have completed.' : 'Could not establish a local session.',
      [submitted ? 'Refresh and check your wallet or chain before submitting again.' : 'Refresh the page and try again.', `Request: ${request.body.requestId}`], true);
  } finally {
    busy = false;
    syncControls();
    document.dispatchEvent(new Event('dashboard-refresh'));
  }
});
