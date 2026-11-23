import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBitcoinCredentials } from '../src/config.mjs';

test('reads explicit Regtest credentials without mixing another network or changing the file', (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'regtest-config-test-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, 'bitcoin.conf');
  writeFileSync(file, '# Synthetic test credentials only\nrpcuser=global-test\nrpcpassword=global-test\n[regtest]\nrpcuser=lab-test\nrpcpassword=synthetic=with#symbols\n[main]\nrpcpassword=wrong-network\n');
  assert.deepEqual(readBitcoinCredentials(file), { username: 'lab-test', password: 'synthetic=with#symbols' });
  assert.deepEqual(readBitcoinCredentials(), {});
  assert.throws(() => readBitcoinCredentials(join(folder, 'missing')), /could not be read/);
});
