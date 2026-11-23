import './actions.js';

const elements = Object.fromEntries(
  [...document.querySelectorAll('[id]')].map((element) => [element.id, element])
);

let activeRequest = null;
let refreshTimer = null;
let toastTimer = null;
let updatesPaused = false;

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

function setText(id, value) {
  if (elements[id]) elements[id].textContent = value;
}

function number(value, fallback = '—') {
  return Number.isFinite(value) ? new Intl.NumberFormat().format(value) : fallback;
}

function decimal(value, digits = 8) {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits
  }).format(value);
}

function btc(value, signed = false) {
  if (!Number.isFinite(value)) return '— BTC';
  const prefix = signed && value > 0 ? '+' : '';
  return `${prefix}${decimal(value, 8)} BTC`;
}

function bytes(value) {
  if (!Number.isFinite(value)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let index = 0;
  while (amount >= 1000 && index < units.length - 1) {
    amount /= 1000;
    index += 1;
  }
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function shortHash(hash, leading = 10, trailing = 8) {
  if (!hash) return '—';
  if (hash.length <= leading + trailing + 1) return hash;
  return `${hash.slice(0, leading)}…${hash.slice(-trailing)}`;
}

function relativeTime(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const elapsed = Math.max(0, Math.floor(Date.now() / 1000 - seconds));
  if (elapsed < 5) return 'just now';
  if (elapsed < 60) return `${elapsed}s ago`;
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`;
  if (elapsed < 86_400) return `${Math.floor(elapsed / 3600)}h ago`;
  return `${Math.floor(elapsed / 86_400)}d ago`;
}

function localDateTime(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(seconds * 1000));
}

function statusClass(state) {
  if (['synced', 'connected'].includes(state)) return 'is-online';
  if (['syncing', 'indexing', 'waiting-ibd', 'waiting-service'].includes(state)) return 'is-warning';
  return 'is-offline';
}

function setStatus(element, state) {
  element?.classList.remove('is-loading', 'is-online', 'is-warning', 'is-offline');
  element?.classList.add(statusClass(state));
}

function renderCore(core) {
  const state = core?.connected ? core.sync.state : 'offline';
  setStatus(elements['core-status-dot'], state);
  setStatus(elements['node-connection-light'], state);
  elements['node-connection-light']?.setAttribute('aria-label', core?.connected ? 'Connected' : 'Unavailable');
  setText('core-status-label', core?.connected ? core.sync.label : 'Unavailable');

  setText('hero-block-height', number(core?.blocks));
  setText('hero-best-hash', core?.bestBlockHash ? shortHash(core.bestBlockHash, 15, 10) : 'Waiting for Core…');
  setText('metric-blocks', number(core?.blocks));
  setText('metric-blocks-detail', core?.connected ? `${number(core.sync.blocksBehind, '0')} behind known headers` : 'Bitcoin Core is unavailable');
  setText('metric-headers', number(core?.headers));
  setText('metric-headers-detail', core?.connected ? `${decimal((core.verificationProgress || 0) * 100, 2)}% verified` : 'Chain announcements');
  setText('metric-sync', core?.connected ? core.sync.label : 'Offline');
  setText('metric-sync-detail', core?.initialBlockDownload === null ? 'Initial block download unknown' : core?.initialBlockDownload ? 'Initial block download is active' : 'Initial block download is complete');

  setText('node-endpoint', core?.endpoint || '127.0.0.1:18443');
  setText('node-network', core?.network || 'regtest');
  setText('node-version', core?.version || '—');
  setText('node-peers', number(core?.connections));
  setText('node-size', bytes(core?.sizeOnDisk));
  setText('node-pruned', core?.pruned === null ? '—' : core?.pruned ? 'Yes' : 'No');
  setText('blocks-chain-chip', String(core?.network || 'regtest').toUpperCase());

  const showIbd = Boolean(core?.connected && core.initialBlockDownload);
  elements['ibd-callout']?.classList.toggle('is-hidden', !showIbd);
  if (showIbd) {
    setText('ibd-title', core.sync.state === 'waiting-ibd'
      ? 'Zero missing blocks can still mean Core is in IBD.'
      : 'Bitcoin Core is still catching up.');
    setText('ibd-explanation', core.sync.explanation);
    setText('ibd-blocks-behind', number(core.sync.blocksBehind, '0'));
  }
}

function renderBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    elements['blocks-body'].innerHTML = '<tr><td colspan="5"><div class="empty-row">No blocks available yet. A brand-new Regtest chain starts at height 0.</div></td></tr>';
    return;
  }
  elements['blocks-body'].innerHTML = blocks.map((block) => `
    <tr>
      <td><a class="data-link" href="/explorer/#/block/${encodeURIComponent(block.hash)}"><strong>#${escapeHtml(number(block.height))}</strong></a></td>
      <td><div class="hash-cell"><span class="hash-icon">◆</span><code title="${escapeHtml(block.hash)}">${escapeHtml(shortHash(block.hash))}</code></div></td>
      <td title="${escapeHtml(localDateTime(block.time))}">${escapeHtml(relativeTime(block.time))}</td>
      <td>${escapeHtml(number(block.transactions))}</td>
      <td>${escapeHtml(bytes(block.size))}</td>
    </tr>
  `).join('');
}

function renderMempool(mempool) {
  if (!mempool?.available) {
    for (const id of ['metric-mempool', 'mempool-usage', 'mempool-fees', 'mempool-minfee']) setText(id, '—');
    setText('metric-mempool-detail', 'Mempool data unavailable');
    setText('mempool-count', 'Unavailable');
    elements['mempool-list'].innerHTML = '<div class="empty-state"><span class="empty-icon">◇</span><strong>Mempool unavailable</strong><p>Reconnect your Regtest node to see pending transactions.</p></div>';
    return;
  }
  const count = mempool?.size || 0;
  setText('metric-mempool', number(count, '0'));
  setText('metric-mempool-detail', `${bytes(mempool?.bytes || 0)} waiting to confirm`);
  setText('mempool-count', `${number(count, '0')} tx`);
  setText('mempool-usage', bytes(mempool?.usage));
  setText('mempool-fees', btc(mempool?.totalFee));
  setText('mempool-minfee', Number.isFinite(mempool?.minRelayFee) ? `${decimal(mempool.minRelayFee * 100_000, 2)} sat/vB` : '—');

  const entries = mempool?.entries || [];
  if (entries.length === 0) {
    elements['mempool-list'].innerHTML = '<div class="empty-state"><span class="empty-icon">◇</span><strong>No mempool activity yet</strong><p>Broadcast a Regtest transaction and it will appear here.</p></div>';
    return;
  }

  elements['mempool-list'].innerHTML = entries.map((entry) => `
    <div class="activity-item">
      <code title="${escapeHtml(entry.txid)}">${escapeHtml(shortHash(entry.txid, 12, 10))}</code>
      <strong>${escapeHtml(Number.isFinite(entry.feeRateSatVb) ? `${decimal(entry.feeRateSatVb, 2)} sat/vB` : '—')}</strong>
      <span>${escapeHtml(relativeTime(entry.time))} · ${escapeHtml(number(entry.vsize))} vB</span>
      <span class="activity-meta">${escapeHtml(btc(entry.fee))}</span>
    </div>
  `).join('');
}

function renderWallets(wallets) {
  if (!wallets?.reachable) {
    setText('wallet-count', 'Unavailable');
    setText('available-wallet-count', '—');
    elements['wallet-list'].innerHTML = '<div class="empty-state"><span class="empty-icon">◫</span><strong>Wallet data unavailable</strong><p>Balances will appear when your Regtest wallets can be read.</p></div>';
    elements['available-wallet-list'].replaceChildren();
    return;
  }
  const loaded = wallets?.loaded || [];
  const available = wallets?.available || [];
  setText('wallet-count', `${number(loaded.length, '0')} loaded`);
  setText('available-wallet-count', number(available.length, '0'));

  if (loaded.length === 0) {
    elements['wallet-list'].innerHTML = '<div class="empty-state"><span class="empty-icon">◫</span><strong>No loaded wallet found</strong><p>The dashboard will list wallets after Core loads one.</p></div>';
  } else {
    elements['wallet-list'].innerHTML = loaded.map((wallet) => `
      <article class="wallet-card">
        <div class="wallet-card-top">
          <div><span class="wallet-glyph">◫</span><div><h3>${escapeHtml(wallet.name || '(default wallet)')}</h3><span class="wallet-format">${escapeHtml(wallet.format || (wallet.descriptors ? 'descriptor' : 'wallet'))} · ${escapeHtml(number(wallet.transactionCount, '0'))} tx</span></div></div>
          <span class="status-badge is-online">Loaded</span>
        </div>
        <div class="wallet-balance"><strong>${escapeHtml(decimal(wallet.balances?.trusted || 0, 8))}</strong><span>BTC</span></div>
        <div class="wallet-breakdown"><span>Pending ${escapeHtml(decimal(wallet.balances?.pending || 0, 8))}</span><span>Immature ${escapeHtml(decimal(wallet.balances?.immature || 0, 8))}</span>${Number.isFinite(wallet.balances?.watchOnly) ? `<span>Watch-only ${escapeHtml(decimal(wallet.balances.watchOnly, 8))}</span>` : ''}</div>
      </article>
    `).join('');
  }

  elements['available-wallet-list'].innerHTML = available.length
    ? available.map((wallet) => `<span class="disk-wallet ${wallet.loaded ? 'is-loaded' : ''}">${escapeHtml(wallet.name || '(default wallet)')}${wallet.loaded ? ' · loaded' : ''}</span>`).join('')
    : '<span class="disk-wallet">None reported</span>';
}

function renderTransactions(wallets) {
  if (wallets?.reachable === false) {
    elements['transactions-body'].innerHTML = '<tr><td colspan="6"><div class="empty-row">Wallet activity is temporarily unavailable.</div></td></tr>';
    return;
  }
  const transactions = wallets?.transactions || [];
  if (transactions.length === 0) {
    elements['transactions-body'].innerHTML = '<tr><td colspan="6"><div class="empty-row">No wallet transactions to show.</div></td></tr>';
    return;
  }

  elements['transactions-body'].innerHTML = transactions.map((transaction) => {
    const amountClass = transaction.amount >= 0 ? 'amount-positive' : 'amount-negative';
    const blockQuery = /^[a-f0-9]{64}$/i.test(transaction.blockHash || '') ? `?block=${transaction.blockHash.toLowerCase()}` : '';
    return `
      <tr>
        <td><a class="data-link" href="/explorer/#/transaction/${encodeURIComponent(transaction.txid)}${blockQuery}"><code title="${escapeHtml(transaction.txid)}">${escapeHtml(shortHash(transaction.txid))}</code></a></td>
        <td>${escapeHtml(transaction.wallet || '(default wallet)')}</td>
        <td><span class="type-pill">${escapeHtml(transaction.category || 'unknown')}</span></td>
        <td><span class="${amountClass}">${escapeHtml(btc(transaction.amount, true))}</span></td>
        <td>${escapeHtml(number(transaction.confirmations, '0'))}</td>
        <td title="${escapeHtml(localDateTime(transaction.time))}">${escapeHtml(relativeTime(transaction.time))}</td>
      </tr>
    `;
  }).join('');
}

function renderElectrs(electrs, sparrow) {
  const state = electrs?.status?.state || 'offline';
  setStatus(elements['electrs-status-dot'], state);
  setText('electrs-status-label', electrs?.status?.label || 'Unavailable');
  elements['electrs-badge'].className = `status-badge ${statusClass(state)}`;
  setText('electrs-badge', electrs?.status?.label || 'Unavailable');
  setText('electrs-description', electrs?.status?.explanation || 'The local Electrum service could not be reached.');
  setText('electrs-endpoint', electrs?.endpoint || '127.0.0.1:60401');
  setText('electrs-height', number(electrs?.tipHeight));
  setText('electrs-protocol', electrs?.protocolVersion || '—');
  setText('electrs-latency', Number.isFinite(electrs?.latencyMs) ? `${electrs.latencyMs} ms` : '—');
  setText('sparrow-url', sparrow?.url || 'tcp://127.0.0.1:60401');
}

function renderErrors(errors) {
  const hasErrors = Array.isArray(errors) && errors.length > 0;
  elements['error-panel']?.classList.toggle('is-hidden', !hasErrors);
  if (!hasErrors) return;
  elements['error-list'].innerHTML = errors.map((error) => `<li><strong>${escapeHtml(error.scope)}</strong> — ${escapeHtml(error.message)}</li>`).join('');
}

function render(snapshot) {
  elements['connection-banner'].classList.add('is-hidden');
  renderCore(snapshot.core);
  renderBlocks(snapshot.blocks);
  renderMempool(snapshot.mempool);
  renderWallets(snapshot.wallets);
  renderTransactions(snapshot.wallets);
  renderElectrs(snapshot.electrs, snapshot.sparrow);
  renderErrors(snapshot.errors);
  document.dispatchEvent(new CustomEvent('dashboard-updated', { detail: snapshot }));
  const generatedAt = new Date(snapshot.generatedAt);
  setText('updated-at', Number.isNaN(generatedAt.getTime()) ? 'Updated just now' : `Updated ${generatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);
}

function renderFetchFailure() {
  elements['connection-banner'].classList.remove('is-hidden');
  document.dispatchEvent(new Event('dashboard-unavailable'));
  renderCore({ connected: false, sync: { state: 'offline', label: 'Unavailable' } });
  renderElectrs({ connected: false, status: { state: 'offline', label: 'Unavailable' } }, null);
  renderErrors([{ scope: 'dashboard', message: 'The local dashboard server could not be reached. Is it still running?' }]);
  setText('updated-at', 'Refresh failed');
}

function scheduleRefresh(milliseconds = 10_000) {
  clearTimeout(refreshTimer);
  if (updatesPaused) return;
  refreshTimer = setTimeout(() => {
    if (document.visibilityState === 'visible') refresh();
    else scheduleRefresh(milliseconds);
  }, Math.max(3_000, milliseconds));
}

async function refresh() {
  activeRequest?.abort();
  const request = new AbortController();
  activeRequest = request;
  elements['refresh-button'].disabled = true;
  elements['refresh-button'].classList.add('is-spinning');

  try {
    const response = await fetch('/api/dashboard', {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: request.signal
    });
    if (!response.ok) throw new Error(`Dashboard returned ${response.status}`);
    const snapshot = await response.json();
    if (request !== activeRequest) return;
    render(snapshot);
    scheduleRefresh(snapshot.refreshAfterMs);
  } catch (error) {
    if (error.name !== 'AbortError' && request === activeRequest) {
      renderFetchFailure();
      scheduleRefresh(10_000);
    }
  } finally {
    if (request === activeRequest) {
      elements['refresh-button'].disabled = false;
      elements['refresh-button'].classList.remove('is-spinning');
    }
  }
}

function showToast(message) {
  setText('toast', message);
  elements.toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove('is-visible'), 1_700);
}

elements['refresh-button'].addEventListener('click', refresh);
elements['pause-button'].addEventListener('click', () => {
  updatesPaused = !updatesPaused;
  elements['pause-button'].setAttribute('aria-pressed', String(updatesPaused));
  elements['pause-button'].textContent = updatesPaused ? 'Resume updates' : 'Pause updates';
  clearTimeout(refreshTimer);
  if (!updatesPaused) refresh();
});
document.addEventListener('dashboard-refresh', refresh);
document.addEventListener('visibilitychange', () => {
  if (!updatesPaused && document.visibilityState === 'visible') refresh();
});
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-copy-target]');
  if (!button) return;
  const target = document.getElementById(button.dataset.copyTarget);
  try {
    await navigator.clipboard.writeText(target?.textContent || '');
    showToast('Copied to clipboard');
  } catch {
    showToast('Copy was not available');
  }
});

refresh();
