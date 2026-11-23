import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveCoreSync, deriveElectrsState } from '../src/status.mjs';

test('explains the fresh Regtest zero-block IBD state', () => {
  const status = deriveCoreSync({
    blocks: 0,
    headers: 0,
    initialblockdownload: true,
    verificationprogress: 1
  });

  assert.equal(status.state, 'waiting-ibd');
  assert.equal(status.blocksBehind, 0);
  assert.match(status.explanation, /electrs waits for the IBD flag/i);
});

test('reports the number of blocks still syncing', () => {
  const status = deriveCoreSync({
    blocks: 7,
    headers: 12,
    initialblockdownload: true,
    verificationprogress: 0.58
  });

  assert.equal(status.state, 'syncing');
  assert.equal(status.blocksBehind, 5);
  assert.equal(status.progressPercent, 58);
});

test('explains IBD on an existing idle chain without calling it a fresh chain', () => {
  const status = deriveCoreSync({ blocks: 103, headers: 103, initialblockdownload: true, verificationprogress: 0.48 });
  assert.equal(status.blocksBehind, 0);
  assert.equal(status.state, 'waiting-ibd');
  assert.match(status.explanation, /old latest-block timestamp/);
  assert.doesNotMatch(status.explanation, /height 0/);
});

test('marks completed Core sync as ready', () => {
  const status = deriveCoreSync({
    blocks: 101,
    headers: 101,
    initialblockdownload: false,
    verificationprogress: 1
  });

  assert.equal(status.state, 'synced');
  assert.equal(status.label, 'Ready');
});

test('compares the electrs height with the Core height', () => {
  assert.deepEqual(deriveElectrsState({ tipHeight: 99 }, 101), {
    state: 'indexing',
    label: 'Indexing · 2 behind',
    blocksBehind: 2,
    explanation: 'electrs is reachable and is still indexing toward the Bitcoin Core tip.'
  });

  assert.equal(deriveElectrsState({ tipHeight: 101 }, 101).state, 'synced');
});

test('does not label an open port as indexed or ready for Sparrow', () => {
  const openPort = { tcpReachable: true, protocolReady: false };
  assert.equal(deriveElectrsState(openPort, 103, true).state, 'waiting-ibd');
  assert.equal(deriveElectrsState(openPort, 103, false).state, 'waiting-service');
  assert.equal(deriveElectrsState(openPort, 103, true).blocksBehind, null);
  assert.match(deriveElectrsState(openPort, 103, true).explanation, /readiness is not yet confirmed/);
});
