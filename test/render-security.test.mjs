import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const hostile = '<img src=x onerror=alert(1)>';
function element(id) {
  return { id, innerHTML: '', textContent: '', classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, replaceChildren() {} };
}

test('dashboard renders wallet names, transaction metadata and hashes as text', async () => {
  let source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  source = source.replace("import './actions.js';", '').split("elements['refresh-button'].addEventListener")[0];
  const ids = ['wallet-count', 'available-wallet-count', 'wallet-list', 'available-wallet-list', 'blocks-body', 'transactions-body'];
  const nodes = Object.fromEntries(ids.map((id) => [id, element(id)]));
  const sandbox = { document: { querySelectorAll: () => Object.values(nodes) }, hostile };
  vm.runInNewContext(source + `
    renderWallets({ reachable: true, loaded: [{ name: hostile, format: hostile, balances: {} }], available: [{ name: hostile }] });
    renderBlocks([{ hash: hostile, height: 1, time: 1 }]);
    renderTransactions({ transactions: [{ txid: hostile, wallet: hostile, category: hostile, blockHash: hostile }] });
  `, sandbox);
  for (const id of ['wallet-list', 'available-wallet-list', 'blocks-body', 'transactions-body']) {
    assert.doesNotMatch(nodes[id].innerHTML, /<img/i, id);
    assert.match(nodes[id].innerHTML, /&lt;img/, id);
  }
});

test('dashboard transaction links retain block context and leave pending links without it', async () => {
  let source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  source = source.replace("import './actions.js';", '').split("elements['refresh-button'].addEventListener")[0];
  const node = element('transactions-body');
  vm.runInNewContext(source + `renderTransactions({ transactions: [
    { txid: '${'a'.repeat(64)}', blockHash: '${'b'.repeat(64)}', confirmations: 203 },
    { txid: '${'c'.repeat(64)}', blockHash: null, confirmations: 0 }
  ] });`, { document: { querySelectorAll: () => [node] } });
  assert.ok(node.innerHTML.includes(`/explorer/#/transaction/${'a'.repeat(64)}?block=${'b'.repeat(64)}`));
  assert.ok(node.innerHTML.includes(`/explorer/#/transaction/${'c'.repeat(64)}"`));
});

test('explorer escapes shortened hashes and rejects attribute markup in numeric fields', async () => {
  const source = (await readFile(new URL('../public/explorer/explorer.js', import.meta.url), 'utf8')).split("$('#search-form').addEventListener")[0];
  const nodes = new Map();
  const sandbox = { URL, URLSearchParams, location: { href: 'http://localhost:3002/explorer/' },
    document: { querySelector: (id) => { if (!nodes.has(id)) nodes.set(id, element(id)); return nodes.get(id); } }, hostile };
  vm.runInNewContext(source + `
    overview({ connected: true, errors: [], generatedAt: new Date().toISOString(), chain: { height: 1, ibd: false },
      blocks: [{ hash: hostile, height: hostile, weight: '\" onmouseover=\"bad', transactions: 1 }],
      mempool: { count: 0, bytes: 0 }, index: { height: 1, label: hostile, state: 'synced' } });
  `, sandbox);
  const html = nodes.get('#view').innerHTML;
  assert.doesNotMatch(html, /<img src=x|onmouseover=/i);
  assert.match(html, /&lt;img/);
});
