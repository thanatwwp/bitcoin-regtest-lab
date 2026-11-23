import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppServer } from '../server.mjs';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('serves a read-only dashboard API with restrictive browser headers', async (t) => {
  const dashboard = {
    snapshot: async () => ({ readOnly: true, core: { connected: true } })
  };
  const server = createAppServer({ dashboard });
  const origin = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`${origin}/api/dashboard`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/u);
  const snapshot = await response.json();
  assert.equal(snapshot.readOnly, true);
  assert.equal(snapshot.core.connected, true);
  assert.equal(snapshot.interactions.available, false);

  const writeAttempt = await fetch(`${origin}/api/dashboard`, { method: 'POST' });
  assert.equal(writeAttempt.status, 405);
  assert.deepEqual(await writeAttempt.json(), { error: 'This endpoint is read-only.' });
});

test('does not serve dotfiles', async (t) => {
  const server = createAppServer({ dashboard: { snapshot: async () => ({}) } });
  const origin = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(`${origin}/.env`);
  assert.equal(response.status, 404);
});
