# Chain Atlas

An original personal Bitcoin explorer for the existing Regtest lab. The Cybertown theme uses midnight surfaces, Bitcoin orange highlights balanced by cyan and violet accents, an original geometric skyline, a glowing chain timeline, and linked transaction trails. It lives beside Regtest Observatory, in the same repository, and reuses only this project's secure local RPC client. All graphics and fonts are local; reduced-motion preferences are respected.

## Start and stop

Requirements: Windows with Ubuntu/WSL; Bitcoin Core configured for Regtest; Node.js 20+ in WSL or this project's ignored `.runtime/node-linux/bin/node`. Address pages additionally require electrs serving Electrum protocol on port 60401.

From PowerShell **in the project folder**:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Start-Explorer.ps1
```

Open **http://127.0.0.1:3002/explorer/** in a Windows browser. Keep the terminal open. **Ctrl+C** stops the explorer; it does not stop or change Core/electrs. Reopen the launcher after rebooting. If port 3002 is occupied, pass `-Port 3004` and open the same path on that port.

The launcher starts the web backend inside Ubuntu and finds the Linux user's existing `~/.bitcoin/bitcoin.conf`. It only reads `rpcuser`/`rpcpassword` using the existing backend configuration reader. Credentials never go into browser JavaScript, command arguments, or application logs. A different setup can use:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Start-Explorer.ps1 -Distribution Ubuntu -BitcoinConfigPath /home/YOUR_LINUX_USER/.bitcoin/bitcoin.conf -Port 3002
```

On a fresh checkout without Node in WSL, the existing optional installer is `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-wsl-runtime.ps1`. The runtime is deliberately excluded from Git. The execution-policy option applies only to that PowerShell process.

Alternatively, from the project folder inside Ubuntu, with Node available:

```sh
BITCOIN_CONFIG_PATH="$HOME/.bitcoin/bitcoin.conf" DASHBOARD_PORT=3002 node server.mjs --explorer
```

The regular dashboard server also serves the explorer at `/explorer/` on its own port after restarting it with the updated source. The dedicated launcher uses `--explorer`, disables all wallet/mining/send actions in that server, and makes the explorer its home page. Your existing dashboard launcher and settings remain available separately.

## Windows and WSL

Core and electrs stay on loopback **inside WSL**; the backend runs beside them. The Windows browser reaches the web server through WSL localhost forwarding. `localhost` means this PC, not a shareable internet address. If a Windows browser cannot connect, verify that the launcher is still running, then try `http://127.0.0.1:3002/explorer/` from WSL to isolate forwarding from server startup. Use your normal WSL network troubleshooting if only the Windows side fails. This project does not change firewall rules or expose Bitcoin RPC to the network.

GitHub stores the source. GitHub Pages cannot run this Node/TCP backend or connect to your private WSL services. No hosted deployment, public port, or repository visibility change is part of this implementation.

## Explore

- **Overview:** chain timeline, block height, mempool count/virtual size, index height and service status. Auto-refresh every 15 seconds while visible; use the pause control to pause it.
- **Search:** a block height, complete block hash, transaction ID, or valid Regtest address. Press `/` to focus search.
- **Blocks:** browse older blocks, open metadata and paginated transaction IDs, and navigate to adjacent blocks. Genesis is supported.
- **Build a block in your lab:** opens the dashboard's reviewed [block builder](BLOCK-BUILDER.md). Choose a custom transaction count for a new real Regtest block. The explorer itself remains read-only; 25-row pagination does not cap the number of transactions in a block.
- **Transactions:** follow previous outpoints and output addresses; inspect fees, virtual size, weight, locking scripts and confirmation state. Missing prevout/fee data is labeled unavailable. Orphaned blocks/transactions are distinguished from confirmed ones.
- **Addresses:** confirmed balance, net pending change, paginated history and up to 50 unspent outputs from electrs. Every list explicitly identifies its limits. Amounts include immature coinbase outputs and are not wallet spendable balances.
- **Mempool:** newest pending transactions, fee rates and virtual sizes. This node's mempool is not a promise of confirmation.
- **Units:** toggle BTC/satoshis without making a node call. Copy hashes and addresses with the Copy buttons.
- **Field guide:** beginner explanations of chain, transaction and indexing concepts.
- **Sample chain:** choose it from the top bar, or open `/explorer/?mode=sample`. Illustrative data stays separate from real RPC. There is no silent fallback from real data to samples. Sample hashes and transactions are educational fixtures, not a serialized, consensus-validated chain.

## Assumptions and limits

- This version explicitly supports **Regtest**, based on the existing setup. It rejects another Core network rather than labeling it Regtest. It is not a Mainnet service.
- Existing Core RPC is on `127.0.0.1:18443`; electrs is on `127.0.0.1:60401`. The existing `.env` variables can override ports and select a loopback address only. It uses standard Electrum protocol 1.4 methods, not Esplora's HTTP API.
- Core can report IBD even with equal blocks and headers, for example when its chain tip is old. electrs can wait for that flag to clear. The explorer explains this and never mines or reindexes to fix it automatically.
- No `txindex` or reindex is required. Core handles ordinary raw transaction lookups. If an ID is unavailable, the explorer checks already-loaded wallets for its block reference (up to 20 wallets within four seconds), then searches up to 200 recent blocks with a 15-second scan budget plus an in-flight RPC timeout. Open an older block or indexed address history to locate other older transactions directly. Dashboard wallet links and explorer block/address links carry block context. No wallets are loaded or rescanned automatically. Previous input links may still need an index or a known block.
- Pruned blocks and missing undo data can limit historical details. Results show unavailable/error states rather than guessing values or balances.
- Address replies use a short-lived Electrum connection, a timeout, a 2 MB total reply limit, and fixed read-only methods. Oversized replies fail visibly. Address history is fetched from electrs then paginated in the backend; this is intended for a local lab, not large public-service workloads.
- A header-height comparison is an indexing readiness indicator, not an independent proof of index correctness. Core and electrs should be pointed at the same Regtest chain. Chain/index data can change between reads during a reorganization; refresh after the services settle.
- Blocks are listed 20 per page; block transactions, address history and mempool entries 25 per page. Transaction pages render at most 100 inputs and 100 outputs, with an explicit truncation notice. Address output lists show at most 50 entries. No raw-transaction broadcast or downloadable private wallet information is offered.

## Backend and security

`src/explorer-service.mjs` maps explicit explorer queries to read-only Core RPC. `src/electrum-query.mjs` queries electrs using reversed SHA256 script hashes derived from Core's validated scriptPubKey. `src/explorer-sample.mjs` provides isolated illustrative fixtures. `public/explorer/` contains independent HTML/CSS/JavaScript and an original SVG mark.

The browser calls only named `GET /api/explorer/*` endpoints: overview, blocks, block, transaction, address, search and mempool. There is no generic RPC endpoint. The dedicated explorer has no enabled mutation service. The backend binds only `127.0.0.1`, checks Host/Origin, rejects cross-site requests, uses restrictive CSP/no-store headers, returns sanitized errors, and caps concurrent explorer requests at four. Configuration and non-public source files are never served. It loads no third-party fonts, scripts, analytics, or image assets.

Keep `.env`, `bitcoin.conf`, cookies, node databases, wallet files and local screenshots out of Git. Existing `.gitignore` rules cover configuration/data. The explorer does not alter Core configuration, wallets, the chain, or electrs databases.

See [the security review](../SECURITY.md) for the public-asset allowlist, escaping of upstream strings, bounded Core/Electrum replies, browser isolation, test coverage and limits of local-only protection. Core replies larger than 16 MiB fail safely rather than consuming unbounded memory.

## Validation

Run `node --test "test/*.test.mjs"` (no install step). Tests exercise routing, search, pagination, transaction lookup without txindex, genesis coinbase fallback, missing undo data, address hashing, lag/offline states, read-only enforcement, Host/Origin guards and sample isolation. Real TCP mocks cover split/out-of-order Electrum messages, early disconnect, errors, oversized replies and timeouts. Existing dashboard tests are retained.

Live verification is read-only: overview → block → transaction → indexed address. It does not create a wallet/address, send bitcoin, mine, import, rescan, or reindex. No RPC credentials are included in test fixtures.

## References and originality

The user supplied [Esplora](https://github.com/Blockstream/esplora) as a feature reference. Its repository overview was reviewed; none of its implementation, visual assets or styling was copied or installed.

The integration follows the [Bitcoin Core getblock documentation](https://bitcoincore.org/en/doc/31.0.0/rpc/blockchain/getblock/), [getrawtransaction documentation](https://bitcoincore.org/en/doc/31.0.0/rpc/rawtransactions/getrawtransaction/), [validateaddress documentation](https://bitcoincore.org/en/doc/31.0.0/rpc/util/validateaddress/), [wallet transaction lookup](https://bitcoincore.org/en/doc/30.0.0/rpc/wallet/gettransaction/) / [wallet transaction block references](https://bitcoincore.org/en/doc/30.0.0/rpc/wallet/listtransactions/), and [Electrum protocol methods](https://electrumx.readthedocs.io/en/latest/protocol-methods.html) / [script-hash encoding](https://electrumx.readthedocs.io/en/latest/protocol-basics.html#script-hashes).
