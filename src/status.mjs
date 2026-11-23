export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function deriveCoreSync(chain) {
  if (!chain) {
    return {
      state: 'offline',
      label: 'Unavailable',
      blocksBehind: null,
      progressPercent: null,
      explanation: 'Bitcoin Core could not be queried.'
    };
  }

  const blocks = Number(chain.blocks || 0);
  const headers = Number(chain.headers || 0);
  const blocksBehind = Math.max(0, headers - blocks);
  const verification = Number.isFinite(chain.verificationprogress)
    ? Math.round(clamp(chain.verificationprogress * 100, 0, 100) * 10_000) / 10_000
    : null;

  if (chain.initialblockdownload) {
    if (blocksBehind === 0) {
      return {
        state: 'waiting-ibd',
        label: 'IBD flag is still on',
        blocksBehind,
        progressPercent: verification,
        explanation: blocks === 0
          ? 'Core reports initial block download even though headers and blocks match. On a fresh Regtest chain at height 0, this can be normal: electrs waits for the IBD flag to clear, not for a missing block.'
          : 'Core has all known blocks but its IBD flag is still on. After restarting an idle Regtest node, an old latest-block timestamp can cause this. electrs waits for the IBD flag to clear, not for missing blocks. You may generate a new block with an explicit reward address, then check the flag again.'
      };
    }

    return {
      state: 'syncing',
      label: `Syncing · ${blocksBehind} block${blocksBehind === 1 ? '' : 's'} behind`,
      blocksBehind,
      progressPercent: verification,
      explanation: `Core is still in initial block download and has ${blocksBehind} validated block${blocksBehind === 1 ? '' : 's'} left to catch up to its headers.`
    };
  }

  return {
    state: 'synced',
    label: 'Ready',
    blocksBehind,
    progressPercent: verification ?? 100,
    explanation: 'Core has completed initial block download and is ready for Regtest work.'
  };
}

export function deriveElectrsState(electrs, coreHeight, coreIbd = false) {
  if (!electrs) {
    return {
      state: 'offline',
      label: 'Unavailable',
      blocksBehind: null,
      explanation: 'No Electrum response was received from electrs.'
    };
  }

  if (electrs.tcpReachable && electrs.protocolReady === false) {
    return {
      state: coreIbd ? 'waiting-ibd' : 'waiting-service',
      label: coreIbd ? 'Port open · Core in IBD' : 'Port open · no RPC reply',
      blocksBehind: null,
      explanation: coreIbd
        ? 'A TCP connection succeeded, but Electrum requests did not complete. Core still reports IBD, so electrs may be waiting before serving queries. Index height is unknown; Sparrow readiness is not yet confirmed.'
        : 'A TCP connection succeeded, but Electrum requests did not complete. The service may be starting, indexing, or unresponsive. Index height is unknown; Sparrow readiness is not yet confirmed.'
    };
  }

  if (!Number.isInteger(coreHeight) || !Number.isInteger(electrs.tipHeight)) {
    return {
      state: 'connected',
      label: 'Connected',
      blocksBehind: null,
      explanation: 'electrs answered, but a comparable tip height was not available.'
    };
  }

  const blocksBehind = Math.max(0, coreHeight - electrs.tipHeight);
  if (blocksBehind > 0) {
    return {
      state: 'indexing',
      label: `Indexing · ${blocksBehind} behind`,
      blocksBehind,
      explanation: 'electrs is reachable and is still indexing toward the Bitcoin Core tip.'
    };
  }

  return {
    state: 'synced',
    label: 'Indexed',
    blocksBehind: 0,
    explanation: 'electrs is reachable and its reported height matches Bitcoin Core.'
  };
}
