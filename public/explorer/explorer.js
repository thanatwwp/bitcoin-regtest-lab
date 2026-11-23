const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (value) => Number.isFinite(value) ? new Intl.NumberFormat('en-US').format(value) : '—';
const short = (value, length = 11) => value ? esc(`${String(value).slice(0, length)}…${String(value).slice(-6)}`) : '—';
const date = (value) => value ? new Date(value * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not yet confirmed';
function ago(time) {
  if (!time) return '—';
  const seconds = Math.max(0, Date.now() / 1000 - time);
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
  const days = Math.floor(seconds / 86400);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
const size = (value) => Number.isFinite(value) ? value >= 1000000 ? `${(value / 1000000).toFixed(2)} MB` : value >= 1000 ? `${(value / 1000).toFixed(2)} kB` : `${num(value)} B` : '—';
const route = (kind, id = '', params = {}) => `#/${kind}${id !== '' ? `/${encodeURIComponent(id)}` : ''}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ''}`;
let mode = new URL(location.href).searchParams.get('mode') === 'sample' ? 'sample' : 'local';
let unit = 'BTC', paused = false, epoch = 0, controller, lastRender = null, currentOverview = null, toastTimer;
const amount = (sats) => sats === null || sats === undefined ? 'Unavailable' : unit === 'sats' ? `${num(sats)} sats` : `${(sats / 1e8).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 })} BTC`;
const feeRate = (value) => Number.isFinite(value) ? `${value.toFixed(2)} sat/vB` : 'Unavailable';
const copy = (value) => `<button class="copy-button" data-copy="${esc(value)}" type="button" aria-label="Copy ${esc(value)}">Copy</button>`;
const hashLine = (hash) => `<div class="hash-line"><code>${esc(hash)}</code>${copy(hash)}</div>`;
const empty = (message) => `<div class="empty"><span class="empty-symbol" aria-hidden="true">◇</span>${message}</div>`;
const heading = (label, title, description, extra = '') => `<div class="heading"><div><p class="eyebrow">${label}</p><h1>${title}</h1><p class="subtitle">${description}</p></div>${extra}</div>`;
const notice = (title, text) => `<div class="notice"><strong>${title}</strong><p>${text}</p></div>`;
const metric = (label, value, detail, symbol = '↗') => `<div class="metric"><div class="metric-label">${label}<span aria-hidden="true">${symbol}</span></div><div class="metric-value">${value}</div><p class="metric-foot">${detail}</p></div>`;
const breadcrumb = (label) => `<div class="breadcrumbs"><a href="#/">Overview</a><span>/</span><span>${label}</span></div>`;
const details = (items) => `<dl class="details-grid">${items.map(([key, val]) => `<div><dt>${key}</dt><dd>${val}</dd></div>`).join('')}</dl>`;
const panel = (title, description, body, extra = '', cls = '') => `<section class="panel ${cls}"><div class="panel-head"><div><h2>${title}</h2>${description ? `<p class="caption">${description}</p>` : ''}</div>${extra}</div>${body}</section>`;
const pageLinks = (previous, next, label) => `<div class="pagination"><span>${previous ? `<a href="${previous}">← Previous</a>` : ''}</span><span>${label}</span><span>${next ? `<a href="${next}">Next →</a>` : ''}</span></div>`;

async function api(endpoint, params = {}, signal) {
  const query = new URLSearchParams({ ...params, mode });
  const response = await fetch(`/api/explorer/${endpoint}?${query}`, { signal, cache: 'no-store' });
  let data;
  try { data = await response.json(); } catch { throw new Error('The explorer server did not return a valid reply. Restart it and try again.'); }
  if (!response.ok) throw new Error(data.error || 'The local request could not be completed.');
  return data;
}
function setMode(next) {
  mode = next;
  currentOverview = null;
  const url = new URL(location.href);
  if (mode === 'sample') url.searchParams.set('mode', 'sample'); else url.searchParams.delete('mode');
  url.hash = '#/';
  history.replaceState(null, '', url);
  syncMode();
  load();
}
function syncMode() {
  $('#data-source').value = mode;
  $('#sample-banner').hidden = mode !== 'sample';
  $('#connection-label').textContent = mode === 'sample' ? 'Sample network · Regtest' : 'Connecting to your node';
  $('#connection-dot').classList.remove('connected', 'waiting');
}
function updateConnection(data) {
  currentOverview = data;
  $('#connection-label').textContent = mode === 'sample' ? 'Sample network · Regtest' : data.connected ? data.chain?.ibd ? 'Regtest · Core in IBD' : 'Your node · Regtest' : 'Your node is offline';
  $('#connection-dot').classList.toggle('connected', data.connected && !data.chain?.ibd);
  $('#connection-dot').classList.toggle('waiting', data.connected && Boolean(data.chain?.ibd));
}
function render(html, title, renderAgain) {
  $('#view').innerHTML = html;
  $('#view').setAttribute('aria-busy', 'false');
  document.title = `${title} · Chain Atlas`;
  lastRender = renderAgain;
}
function showError(error) {
  render(`<section class="offline"><div class="offline-icon" aria-hidden="true">⌁</div><p class="eyebrow">LET’S FIND THE CONNECTION</p><h1>This view isn’t available yet.</h1><p>${esc(error.message)}</p><p>Check that Bitcoin Core is running in Regtest. Address history also needs electrs to be ready.</p><div class="button-row"><button class="button primary" data-retry type="button">Try again ↻</button><a class="button" href="#/">Back to overview</a>${mode === 'local' ? '<button class="button" data-sample type="button">Explore the sample chain</button>' : ''}</div></section>`, 'View unavailable');
}
function offline(data) {
  return `<section class="offline"><div class="offline-icon" aria-hidden="true">◎</div><p class="eyebrow">YOUR CHAIN, WHEN YOU’RE READY</p><h1>A home for your<br><em>Bitcoin curiosity.</em></h1><p>The explorer is running. Your Bitcoin node is not connected yet.</p><p>${esc(data.errors[0]?.message || 'Start Bitcoin Core in your Ubuntu Regtest environment, then refresh this page.')}</p><div class="button-row"><button class="button primary" data-retry type="button">Check connection ↻</button><button class="button" data-sample type="button">Explore a sample chain ↗</button><a class="button" href="#/learn">Read the field guide</a></div></section>`;
}
function blockTable(blocks) {
  if (!blocks.length) return empty('No blocks are available.');
  return `<div class="table-wrap"><table><thead><tr><th>HEIGHT</th><th class="hash-column">BLOCK HASH</th><th>TXNS</th><th class="size-column">SIZE</th><th>MINED</th></tr></thead><tbody>${blocks.map((b) => `<tr><td><span class="row-mark" aria-hidden="true"></span><a class="height-link" href="${route('block', b.hash)}">${num(b.height)}</a></td><td class="hash-column"><a class="hash" href="${route('block', b.hash)}" title="${esc(b.hash)}">${short(b.hash, 8)}</a></td><td class="number">${num(b.transactions)}</td><td class="size-column number">${size(b.size)}</td><td class="table-sub" title="${esc(date(b.time))}">${ago(b.time)}</td></tr>`).join('')}</tbody></table></div>`;
}
function overview(data) {
  updateConnection(data);
  if (!data.connected) { render(offline(data), 'Connect your node', () => overview(data)); return; }
  const c = data.chain, m = data.mempool;
  const strip = [...data.blocks.slice(0, 6)].reverse().map((block, i, all) => `<a class="chain-block ${i === all.length - 1 ? 'latest' : ''} ${all.length - i > 4 ? 'older-wide' : all.length - i === 4 ? 'older-mid' : ''}" href="${route('block', block.hash)}" aria-label="Open block ${num(block.height)}"><small>${i === all.length - 1 ? 'CHAIN TIP' : 'CONFIRMED'}<span>◇</span></small><strong>${num(block.height)}</strong><p>${num(block.transactions)} transaction${block.transactions === 1 ? '' : 's'}</p><progress class="capacity" max="4000000" value="${Number.isFinite(block.weight) ? Math.max(0, block.weight) : 0}" aria-label="Block ${num(block.height)} weight usage"></progress></a>`).join('');
  const state = c.ibd ? notice(c.sync.blocksBehind === 0 ? 'Your blocks match. The IBD flag may still be waiting.' : 'Your node is downloading blocks.', esc(c.sync.explanation)) : '';
  const html = `<section class="city-hero"><div class="city-art" aria-hidden="true"><img src="/explorer/cybertown.svg" alt="" width="800" height="340"></div>`
    + heading('BITCOIN / YOUR LOCAL UNIVERSE', 'Your chain.<br><em>Illuminated.</em>', 'Explore the blocks, trace the transactions.<br>Your Bitcoin network comes into view.', `<div class="live-stamp"><span></span><span>${mode === 'sample' ? 'Sample snapshot' : `Updated ${new Date(data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}</span><button id="pause" type="button" aria-label="${paused ? 'Resume' : 'Pause'} automatic refresh">${paused ? '▶' : 'Ⅱ'}</button></div>`)
    + `</section><section class="chain-panel" aria-label="Recent chain timeline"><div class="chain-panel-head"><span>CHAIN TIMELINE</span><a href="#/blocks">Explore all blocks ↗</a></div><div class="chain-track">${strip}<a class="chain-pending" href="#/mempool"><span>UP NEXT</span><strong>${num(m?.count)}</strong><span>pending txns</span></a></div><div class="chain-legend"><span>← EARLIER BLOCKS</span><span>Validated blocks · linked together</span></div></section>`
    + `<section class="metric-grid" aria-label="Network statistics">${metric('Chain height', num(c.height), 'Latest validated block', '▤')}${metric('In the waiting room', num(m?.count), 'Unconfirmed transactions', '⇄')}${metric('Mempool size', m ? size(m.bytes) : '—', 'Virtual size of pending transactions', '◷')}${metric('Address index', num(data.index.height), esc(data.index.label), '◎')}</section>`
    + state + data.errors.map((error) => notice('Some data is unavailable', esc(error.message))).join('')
    + `<div class="overview-grid">${panel('Recent blocks', 'Small discoveries, one block at a time.', blockTable(data.blocks.slice(0, 8)), '<a class="text-link" href="#/blocks">View all ↗</a>')}<aside class="aside-stack"><div class="guide-card"><div class="guide-icon" aria-hidden="true">◎</div><p class="eyebrow">A LITTLE CONTEXT</p><h3>What’s inside<br>a Bitcoin block?</h3><p>A collection of transactions, a link to the past, and a place in the chain. Open one to take a closer look.</p><a href="#/learn">Meet the building blocks <span>↗</span></a></div><div class="network-card"><h3>Your network, quietly working.</h3><div class="network-line"><span>Bitcoin Core</span><strong class="${c.ibd ? 'warn' : ''}">${c.ibd ? 'IBD flagged' : 'Connected'}</strong></div><div class="network-line"><span>electrs</span><strong class="${data.index.state === 'synced' ? '' : 'warn'}">${esc(data.index.label)}</strong></div><div class="network-line"><span>Network</span><strong>Regtest</strong></div><p class="network-foot">${mode === 'sample' ? 'This is an illustrative chain for exploring the interface.' : 'Queries stay between this explorer and your own node.'}</p></div></aside></div>`;
  render(html, 'Overview', () => overview(data));
}
function blocksPage(data, start) {
  render(breadcrumb('Blocks') + heading('THE CHAIN ARCHIVE', 'Built <em>block by block.</em>', `Browse every chapter of your Regtest chain. Current tip: ${num(data.tip)}.`)
    + panel('Blocks', 'Newest first. Select a height to see its transactions.', blockTable(data.blocks) + pageLinks(start !== null && Number(start) < data.tip ? route('blocks', '', { start: Math.min(data.tip, Number(start) + 20) }) : null, data.next !== null ? route('blocks', '', { start: data.next }) : null, `${num(data.blocks.at(-1)?.height)}–${num(data.blocks[0]?.height)}`)), 'Blocks', () => blocksPage(data, start));
}
function blockPage(b) {
  const nav = `<div class="detail-navigation">${b.previous ? `<a class="button" href="${route('block', b.previous)}">← Previous block</a>` : ''}${b.next ? `<a class="button" href="${route('block', b.next)}">Next block →</a>` : ''}</div>`;
  const txs = `<div class="table-wrap"><table><thead><tr><th>#</th><th>TRANSACTION ID</th><th>EXPLORE</th></tr></thead><tbody>${b.txids.map((txid, i) => `<tr><td>${num(b.offset + i + 1)}${b.offset + i === 0 ? ' · Coinbase' : ''}</td><td><a class="hash full-hash" href="${route('transaction', txid, { block: b.hash })}">${esc(txid)}</a></td><td><a href="${route('transaction', txid, { block: b.hash })}" aria-label="Open transaction ${esc(txid)}">↗</a></td></tr>`).join('')}</tbody></table></div>`;
  const html = breadcrumb(`Block ${num(b.height)}`) + heading('A CHAPTER IN THE CHAIN', `<span class="detail-title">Block ${num(b.height)}</span>`, `${esc(date(b.time))} · ${num(b.transactions)} transaction${b.transactions === 1 ? '' : 's'}`, nav) + hashLine(b.hash)
    + (b.confirmations < 0 ? notice('This block is outside the active chain', 'Its transactions may have been confirmed elsewhere or returned to the mempool.') : '')
    + panel('Block details', '', details([['Confirmations', b.confirmations < 0 ? 'Outside active chain' : num(b.confirmations)], ['Size', size(b.size)], ['Weight', `${num(b.weight)} WU`], ['Transactions', num(b.transactions)], ['Mined at', esc(date(b.time))], ['Median time', esc(date(b.medianTime))], ['Version', `<code>${esc(b.version)}</code>`], ['Nonce', num(b.nonce)], ['Difficulty', esc(b.difficulty)], ['Bits', `<code>${esc(b.bits)}</code>`], ['Merkle root', `<code>${esc(b.merkleRoot)}</code>`]]), '<span class="badge">Read-only</span>', 'detail-panel')
    + panel(`Transactions <span class="pill-count">${num(b.transactions)}</span>`, 'The first transaction is the coinbase, which creates the mining reward.', txs + pageLinks(b.offset ? route('block', b.hash, { offset: Math.max(0, b.offset - 25) }) : null, b.nextOffset !== null ? route('block', b.hash, { offset: b.nextOffset }) : null, `Showing ${b.txids.length ? b.offset + 1 : 0}–${b.offset + b.txids.length}`));
  render(html, `Block ${b.height}`, () => blockPage(b));
}
function txPage(tx) {
  const confirmed = tx.confirmations > 0, orphan = tx.confirmations < 0;
  const status = orphan ? '<span class="badge orphan">Outside active chain</span>' : confirmed ? `<span class="badge">✓ ${num(tx.confirmations)} confirmation${tx.confirmations === 1 ? '' : 's'}</span>` : '<span class="badge pending">◷ Unconfirmed</span>';
  const inputs = tx.inputs.slice(0, 100).map((input, index) => `<article class="flow-item"><strong>${input.coinbase ? 'New bitcoin · Coinbase' : `Input ${index + 1}`}</strong>${input.coinbase ? '<span class="tiny">Mining reward; no previous transaction.</span>' : `${input.address ? `<a class="flow-link" href="${route('address', input.address)}">${esc(input.address)}</a>` : '<span class="tiny">Previous address unavailable</span>'}<a class="flow-link" href="${route('transaction', input.txid)}">${short(input.txid, 18)} : ${num(input.vout)} ↗</a><span class="amount">${amount(input.valueSats)}</span>`}</article>`).join('');
  const outputs = tx.outputs.slice(0, 100).map((out) => `<article class="flow-item"><strong>Output ${num(out.index)} <small>· ${esc(out.type.replaceAll('_', ' '))}</small></strong>${out.address ? `<a class="flow-link" href="${route('address', out.address)}">${esc(out.address)} ↗</a>` : '<span class="tiny">Script output · no single address</span>'}<span class="amount">${amount(out.valueSats)}</span><details><summary>View locking script</summary><code>${esc(out.script)}</code></details></article>`).join('');
  const html = breadcrumb('Transaction') + heading('FOLLOW THE VALUE', 'One transaction.<br><em>A new destination.</em>', tx.coinbase ? 'A coinbase transaction introduces the block’s mining reward.' : 'See which previous outputs were spent, and where the value went.', status) + hashLine(tx.txid)
    + `<section class="metric-grid">${metric('Total output', `<small>${amount(tx.totalOutputSats)}</small>`, 'Includes change; not a payment total')}${metric('Transaction fee', `<small>${tx.coinbase ? 'Not applicable' : amount(tx.feeSats)}</small>`, tx.coinbase ? 'Coinbase creates the reward' : 'Paid to the miner')}${metric('Fee rate', `<small>${tx.coinbase ? 'Not applicable' : feeRate(tx.feeRate)}</small>`, 'Fee divided by virtual size')}${metric('Virtual size', `${num(tx.vsize)}<small>vB</small>`, `${num(tx.weight)} weight units`)}</section>`
    + (tx.coinbase ? notice('About coinbase maturity', 'A mining reward needs 100 blocks of maturity before it can be spent. Address balance alone does not tell you how much is spendable. The genesis reward is a special, unspendable case.') : '')
    + panel('The transaction trail', 'Inputs on the left. New outputs on the right.', `<div class="flow-grid"><div><div class="flow-heading"><span>INPUTS</span><span>${num(tx.inputs.length)}</span></div>${inputs}</div><div class="flow-arrow" aria-hidden="true">→</div><div><div class="flow-heading"><span>OUTPUTS</span><span>${num(tx.outputs.length)}</span></div>${outputs}</div></div>${tx.inputs.length > 100 || tx.outputs.length > 100 ? '<p class="partial-note">Displaying the first 100 inputs and outputs of this large transaction.</p>' : ''}`, '', 'detail-panel')
    + panel('A closer look', '', details([['Status', orphan ? 'Outside active chain' : confirmed ? 'Confirmed' : 'Unconfirmed'], ['Block', tx.blockHash ? `<a class="inline-link hash" href="${route('block', tx.blockHash)}">${short(tx.blockHash)}</a>` : 'Not in a block'], ['Timestamp', esc(date(tx.time))], ['Serialized size', size(tx.size)], ['Version', num(tx.version)], ['Lock time', num(tx.locktime)]]))
    + (!tx.coinbase && tx.feeSats === null ? `<p class="tiny">Fee or previous-output information can be unavailable when Core does not have the required undo data. It is shown as unavailable, never assumed to be zero.</p>` : '');
  render(html, 'Transaction', () => txPage(tx));
}
function mempoolPage(m) {
  const body = m.entries.length ? `<div class="table-wrap"><table><thead><tr><th>TRANSACTION ID</th><th>FEE RATE</th><th>VIRTUAL SIZE</th><th>FIRST SEEN</th></tr></thead><tbody>${m.entries.map((tx) => `<tr><td><a class="hash" href="${route('transaction', tx.txid)}">${short(tx.txid, 16)}</a></td><td>${feeRate(tx.feeRate)}</td><td>${num(tx.vsize)} vB</td><td title="${esc(date(tx.time))}">${ago(tx.time)}</td></tr>`).join('')}</tbody></table></div>` : empty('All quiet here. There are no transactions waiting for a block.');
  render(breadcrumb('Mempool') + heading('THE WAITING ROOM', 'On their way <em>to a block.</em>', 'Transactions your node has accepted, waiting to be mined. Regtest blocks arrive when you generate them.') + `<section class="metric-grid">${metric('Pending transactions', num(m.count), 'In your node’s mempool')}${metric('Virtual size', size(m.bytes), 'Total transaction virtual size')}${metric('Total fees', `<small>${amount(m.totalFeeSats)}</small>`, 'Fees across pending transactions')}${metric('Confirmation timing', '<small>On demand</small>', 'Regtest has no automatic block schedule')}</section>`
    + panel('Pending transactions', 'Most recently seen first. This is your node’s view.', body + pageLinks(m.offset ? route('mempool', '', { offset: Math.max(0, m.offset - 25) }) : null, m.nextOffset !== null ? route('mempool', '', { offset: m.nextOffset }) : null, `${num(m.count)} pending`)), 'Mempool', () => mempoolPage(m));
}
function addressPage(a) {
  const history = a.history.length ? `<div class="table-wrap"><table><thead><tr><th>TRANSACTION ID</th><th>STATUS</th><th>BLOCK</th></tr></thead><tbody>${a.history.map((tx) => `<tr><td><a class="hash" href="${route('transaction', tx.txid, tx.blockHash ? { block: tx.blockHash } : {})}">${short(tx.txid, 16)}</a></td><td><span class="badge ${tx.height <= 0 ? 'pending' : ''}">${tx.height <= 0 ? 'Unconfirmed' : 'Confirmed'}</span></td><td>${tx.blockHash ? `<a href="${route('block', tx.blockHash)}">${num(tx.height)}</a>` : '—'}</td></tr>`).join('')}</tbody></table></div>` : empty('No transactions indexed for this address.');
  const unspent = a.unspent.length ? `<div class="table-wrap"><table><thead><tr><th>TRANSACTION : OUTPUT</th><th>VALUE</th><th>BLOCK HEIGHT</th></tr></thead><tbody>${a.unspent.map((out) => `<tr><td><a class="hash" href="${route('transaction', out.txid, out.height > 0 ? { height: out.height } : {})}">${short(out.txid)} : ${num(out.index)}</a></td><td>${amount(out.valueSats)}</td><td>${out.height > 0 ? num(out.height) : 'Pending'}</td></tr>`).join('')}</tbody></table></div>` : empty('No unspent outputs are indexed for this address.');
  render(breadcrumb('Address') + heading('A PLACE ON THE NETWORK', 'Trace <em>an address.</em>', 'History and unspent outputs, as reported by your Electrum index.') + hashLine(a.address)
    + (a.indexHeight !== a.coreHeight ? notice('The address index is catching up', `Indexed height ${num(a.indexHeight)}; Core height ${num(a.coreHeight)}. These balances and transactions may be incomplete.`) : '')
    + `<section class="metric-grid">${metric('Confirmed balance', `<small>${amount(a.confirmedSats)}</small>`, 'May include immature mining rewards')}${metric('Pending change', `<small>${amount(a.pendingSats)}</small>`, 'Net effect of unconfirmed transactions')}${metric('Transactions', num(a.count), 'Indexed address history')}${metric('Unspent outputs', num(a.unspentCount), 'Not a spendable-wallet balance')}</section>`
    + panel('Transaction history', 'Unconfirmed first, then newest block height.', history + pageLinks(a.offset ? route('address', a.address, { offset: Math.max(0, a.offset - 25) }) : null, a.nextOffset !== null ? route('address', a.address, { offset: a.nextOffset }) : null, `${num(a.count)} transactions`), '', 'detail-panel')
    + panel('Unspent outputs', `Showing ${a.unspent.length} of ${num(a.unspentCount)}. Coinbase maturity is not checked in this list.`, unspent), 'Address', () => addressPage(a));
}
function learnPage() {
  const cards = [
    ['01 / BLOCKS', 'A ledger with a memory.', 'Each block links to the previous block through its hash. The height is its position, starting at the genesis block, height 0. Choose a block to see the transactions it contains.', '<a href="#/block/0">Visit the genesis block ↗</a>'],
    ['02 / TRANSACTIONS', 'Follow the trail, not a balance.', 'Bitcoin transactions spend previous outputs and create new ones. An input points back to what was spent. An output locks value to a script, often represented by an address. Change comes back as another output.', 'An output total can include change. It is not necessarily the amount paid to someone else.'],
    ['03 / THE MEMPOOL', 'A waiting room, not a promise.', 'Your node keeps valid, unconfirmed transactions in its mempool. They can be mined, replaced, or removed. Different nodes can have different mempools. On Regtest, you decide when to generate a block.', '<a href="#/mempool">See what is waiting ↗</a>'],
    ['04 / SATOSHIS & FEES', 'Small units. Clear numbers.', 'One bitcoin equals 100,000,000 satoshis. Fees usually equal input value minus output value. The fee rate divides that fee by virtual size, in sat/vB. Use the BTC switch above to change how amounts are shown.', 'This explorer does not estimate confirmation times or recommend transaction fees.'],
    ['05 / YOUR REGTEST NODE', '“0 blocks to download” — yet IBD?', 'Core can have matching block and header heights while still reporting initial block download (IBD), for example after restarting with an old chain tip. electrs may wait for this flag to clear even with no blocks missing.', 'Nothing is reset or mined here. You can review a block-generation action in your existing dashboard when you choose.'],
    ['06 / YOUR ADDRESS INDEX', 'Two services. One clearer picture.', 'Core supplies blocks, mempool data and transaction details. electrs adds address history and balances. If the index is offline or behind Core, the explorer tells you. A balance includes more than just spendable coins.', 'Core transaction searches without txindex cover the latest 200 blocks. Open an older block or indexed address to follow its transactions directly.'],
    ['07 / SAMPLE CHAIN', 'A place to try things out.', 'Choose Sample chain above to explore illustrative blocks, transactions and addresses without connecting to your node. It is labeled throughout. Switch back to Local Regtest to see your own data.', 'All explorer actions are read-only. No mining, wallet creation, signing, or sending.']
  ];
  render(breadcrumb('Field guide') + heading('A LITTLE KNOWLEDGE GOES A LONG WAY', 'Your field guide <em>to Bitcoin.</em>', 'Plain-language notes for the things you’ll discover along the way.') + `<div class="learn-grid">${cards.map(([number, title, body, foot]) => `<article class="learn-card"><span class="learn-number">${number}</span><h2>${title}</h2><p>${body}</p><p>${foot}</p></article>`).join('')}</div>`, 'Field guide', learnPage);
}
function currentRoute() {
  const raw = (location.hash || '#/').slice(1);
  const url = new URL(raw.startsWith('/') ? raw : '/', location.origin);
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  return { kind: parts[0] || 'overview', id: parts[1] || '', params: url.searchParams };
}
async function load(quiet = false) {
  const mine = ++epoch;
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  const searchError = $('#search-error');
  searchError.hidden = true;
  if (!quiet) { $('#view').setAttribute('aria-busy', 'true'); window.scrollTo({ top: 0 }); }
  $('#refresh').disabled = true;
  try {
    const { kind, id, params } = currentRoute();
    document.querySelectorAll('[data-nav]').forEach((a) => {
      const active = a.dataset.nav === (kind === 'block' ? 'blocks' : kind);
      if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    let data;
    switch (kind) {
      case 'overview': data = await api('overview', {}, signal); if (mine === epoch) overview(data); break;
      case 'blocks': data = await api('blocks', params.has('start') ? { start: params.get('start') } : {}, signal); if (mine === epoch) blocksPage(data, params.get('start')); break;
      case 'block': data = await api('block', { id, offset: params.get('offset') || 0 }, signal); if (mine === epoch) blockPage(data); break;
      case 'transaction': data = await api('transaction', { id, ...(params.has('block') ? { block: params.get('block') } : {}), ...(params.has('height') ? { height: params.get('height') } : {}) }, signal); if (mine === epoch) txPage(data); break;
      case 'address': data = await api('address', { id, offset: params.get('offset') || 0 }, signal); if (mine === epoch) addressPage(data); break;
      case 'mempool': data = await api('mempool', { offset: params.get('offset') || 0 }, signal); if (mine === epoch) mempoolPage(data); break;
      case 'learn': learnPage(); break;
      default: throw new Error('This page does not exist. Choose a view from the navigation.');
    }
    if (mine === epoch && !currentOverview && kind !== 'overview') {
      const status = await api('overview', {}, signal);
      if (mine === epoch) updateConnection(status);
    }
  } catch (error) { if (error.name !== 'AbortError' && mine === epoch) showError(error); }
  finally { if (mine === epoch) { $('#refresh').disabled = false; $('#view').setAttribute('aria-busy', 'false'); } }
}
$('#search-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = $('#search').value.trim();
  if (!query) return;
  const requestMode = mode, requestEpoch = epoch;
  $('#search-button').disabled = true;
  $('#search-error').hidden = true;
  try {
    const result = await api('search', { q: query });
    if (requestMode !== mode || requestEpoch !== epoch) return;
    const target = route(result.kind, result.id, result.block ? { block: result.block } : {});
    if (location.hash === target) load(); else location.hash = target;
  } catch (error) {
    if (requestMode === mode && requestEpoch === epoch) { $('#search-error').textContent = error.message; $('#search-error').hidden = false; }
  } finally { $('#search-button').disabled = false; }
});
$('#data-source').addEventListener('change', (event) => setMode(event.target.value));
$('#back-to-local').addEventListener('click', () => setMode('local'));
$('#refresh').addEventListener('click', () => load());
$('#unit-button').addEventListener('click', () => {
  unit = unit === 'BTC' ? 'sats' : 'BTC';
  $('#unit-button').innerHTML = `${unit} <span>⇄</span>`;
  $('#unit-button').setAttribute('aria-label', `Switch amounts to ${unit === 'BTC' ? 'satoshis' : 'bitcoin'}`);
  lastRender?.();
});
document.addEventListener('click', async (event) => {
  if (event.target.closest('.skip')) { event.preventDefault(); $('#content').focus(); $('#content').scrollIntoView(); return; }
  const target = event.target.closest('button');
  if (!target) return;
  if (target.hasAttribute('data-sample')) setMode('sample');
  if (target.hasAttribute('data-retry')) load();
  if (target.id === 'pause') { paused = !paused; lastRender?.(); }
  if (target.dataset.copy) {
    try { await navigator.clipboard.writeText(target.dataset.copy); $('#toast').textContent = 'Copied to clipboard'; }
    catch { $('#toast').textContent = 'Copy unavailable. Select the displayed text and copy it manually.'; }
    $('#toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 2500);
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === '/' && !event.ctrlKey && !event.metaKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) { event.preventDefault(); $('#search').focus(); }
});
window.addEventListener('hashchange', () => load());
setInterval(() => {
  if (!paused && !document.hidden && !$('#refresh').disabled && !$('#search-button').disabled && !$('#view').contains(document.activeElement)) {
    const kind = currentRoute().kind;
    if (kind === 'overview' || kind === 'mempool') load(true);
  }
}, 15000);
syncMode();
load();
