# Architecture and safety boundary

```text
Sparrow Wallet ── Electrum TCP ──> electrs :60401 ── REST/RPC ──> Bitcoin Core :18443

Browser ── same-origin HTTP ──> Dashboard server ── authenticated JSON-RPC ──> Bitcoin Core
                                  │
                                  └── Electrum TCP health/index check ──> electrs
```

The browser never talks to Bitcoin Core or electrs directly. It reads telemetry at `/api/dashboard` and submits confirmed actions to four named POST endpoints. The local server reads RPC credentials from environment variables or an explicitly configured bitcoin.conf path.

## Read-only RPC surface

Telemetry calls:

- `getblockchaininfo`, `getnetworkinfo`, `getblock`, `getmempoolinfo`, and `getrawmempool`
- `listwallets`, `listwalletdir`, `getwalletinfo`, `getbalances`, and `listtransactions`

Dashboard transaction links preserve Core's `blockhash`. When an explorer transaction ID has no block context and raw lookup fails, it can use `gettransaction` in already-loaded wallets to locate the block (at most 20 wallets and four seconds), then read the transaction from that block. This is read-only; wallet loading, scanning, private metadata and raw wallet replies are not exposed. Unknown transactions still use the bounded recent-chain scan.

Dashboard Electrum checks use `server.version`, `server.ping`, and `blockchain.headers.subscribe`. The explorer also uses `blockchain.scripthash.get_balance`, `blockchain.scripthash.get_history`, and `blockchain.scripthash.listunspent`. Explorer Core reads additionally use `getblockhash`, `getmempoolentry`, `getrawtransaction`, and `validateaddress`. There is no generic RPC passthrough; the RPC client independently enforces the fixed method list.

TCP reachability and Electrum readiness are separate. An open port that does not finish the protocol checks is reported as waiting, never as indexed. If Core reports IBD, the page explains that electrs may be waiting on Core without claiming that this alone proves the cause. Index height stays unknown until electrs answers.

## Confirmed Regtest actions

| HTTP endpoint | Core write method | Inputs |
| --- | --- | --- |
| `POST /api/actions/address` | `getnewaddress` | Loaded wallet |
| `POST /api/actions/mine` | `generatetoaddress` | Explicit validated address, 1–101 blocks |
| `POST /api/actions/send` | `sendtoaddress` | Loaded wallet, validated address, exact decimal BTC amount, fee in sat/vB |
| `POST /api/actions/build-block` | `getnewaddress`, `createrawtransaction`, `signrawtransactionwithwallet`, `generateblock` | Loaded wallet, total transaction count including coinbase, fee in sat/vB |

The [block builder](BLOCK-BUILDER.md) also reads `listunspent`, `getaddressinfo`, `gettxout` and `decoderawtransaction`. These methods are in the backend's fixed allowlist, not exposed as browser RPC calls. It verifies a locally signing wallet, confirmed native SegWit funding, wallet-owned destination, every prepared input/output/amount, total block weight and final block contents. Raw signed transactions never leave the backend except to the local Core RPC. Preparation has a two-minute budget and cancels before submission if the client disconnects. Mining is never retried automatically.

Each request requires JSON, `confirmed: true`, a request ID, the same origin, and a random session token from `/api/session`. That token is separate from Core credentials. Host checks reject non-local names to prevent DNS rebinding; the backend rechecks Core's network before every write and validates addresses with `validateaddress`. Unknown fields and methods are rejected.

The UI presents all inputs in a modal before dispatch. Amounts stay decimal strings through JSON-RPC to avoid client rounding. One action can run at a time. Repeated IDs return the same promise/result; conflicting reuse is rejected. The cache has a 1,000-action limit with no eviction and lasts until shutdown. No automatic retries occur. A lost response after dispatch is explicitly reported as uncertain; the user must inspect the chain/wallet before creating a new request.

Actions default to enabled following the user's request to make this lab interactive. `DASHBOARD_ACTIONS_ENABLED=false` disables them at the server boundary. There are no reset, wallet deletion, export, or arbitrary-command controls.

## Local security choices

- The web server always binds to `127.0.0.1`; an environment variable cannot accidentally make it public.
- Real credentials remain in the existing bitcoin.conf when `BITCOIN_CONFIG_PATH` is supplied, or in ignored `.env` settings. Only the backend constructs the Authorization header. The config reader never writes the original file.
- API responses contain a host/port label but never the username, password, Authorization header, request body, or raw internal exception.
- Browser responses use a restrictive Content Security Policy, deny framing, disable referrers, and mark telemetry as `no-store`.
- Static serving allows only explicitly named browser assets in `public/` and rejects unexpected files, dotfiles, path traversal and symlinks.
- The application intentionally logs only startup/shutdown state, never RPC request data.

See [the security review](../SECURITY.md) for loopback destination enforcement, browser isolation, response/concurrency limits, test coverage and the local-only threat boundary.

## Assumptions

- Bitcoin Core is already running in Regtest mode and accepting authenticated RPC on `127.0.0.1:18443`.
- electrs 0.12.0 is already configured for Regtest and listening without TLS on `127.0.0.1:60401`.
- The recommended launcher runs the backend in WSL beside Core/electrs. Windows needs working localhost forwarding for the dashboard's web port. Running the backend directly on Windows additionally requires forwarding for the Core and electrs ports.
- Wallet RPC support is enabled in the installed Bitcoin Core build. An empty loaded-wallet list is a valid state.
- Recent block and transaction lists are intentionally capped to keep refreshes light.

## Verification scope

Action flows are exercised through isolated in-memory fixtures and HTTP security tests, plus browser confirmation/result checks. The optional `qa/verify-block-builder-core.mjs` check runs a separate temporary Core node and validates 7-, 20-, 35- and 125-transaction blocks, pagination and preservation of unrelated mempool entries. Verification does not mine or send against the user's existing chain. A real-node read-only connection check is separate from these tests.
