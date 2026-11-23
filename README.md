# Regtest Observatory & Chain Atlas

## New: Chain Atlas Bitcoin explorer

An original, read-only explorer is included alongside the lab dashboard. Browse blocks, follow transaction inputs and outputs, search heights/hashes/addresses, view the mempool, and inspect electrs address history. A clearly labeled sample mode works without a connected node.

Start from PowerShell in this folder:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Start-Explorer.ps1
```

Open **[Chain Atlas](http://127.0.0.1:3002/explorer/)**. Keep the terminal open; Ctrl+C stops only the explorer. It reads your existing WSL Bitcoin configuration. Core and electrs must already be running. Port 3002 allows it to coexist with the dashboard on port 3000. No external packages are required.

See **[Explorer setup, architecture and limitations](docs/EXPLORER.md)** for first-time setup, Windows/WSL details, read-only safeguards, and sample mode. Source code is original; no Esplora code, styles or assets were reused.

Use **Code → Download ZIP** on GitHub for the current complete source of both apps.

A local dashboard for exploring and interacting with your Bitcoin Regtest lab:

- Bitcoin Core connection, block/header height, IBD, verification progress, peers, and chain size
- A plain-language explanation of **“waiting for 0 blocks to download (IBD)”**
- Latest blocks and mempool activity
- Loaded/available Bitcoin Core wallets, balances, and recent transactions
- electrs availability, protocol, latency, indexed height, and progress against Core
- The exact local Sparrow Private Electrum connection settings
- Confirmed actions to create receiving addresses, generate 1–101 blocks, and send test bitcoin
- A reviewed block builder for custom transaction counts, such as 7, 20 or 35, with self-transfers inside a loaded Core wallet

The dashboard keeps RPC credentials in its backend. Every action is checked against the live node's `regtest` network and shown for review before submission.

## Use the lab controls

Open [Lab controls](http://127.0.0.1:3000/#lab-actions) after connecting Core:

1. **Receive:** select an already loaded Core wallet and review creation of a native SegWit address. Copy it or choose **Use for mining**.
2. **Generate blocks:** enter the reward address and choose 1, 10, 101, or a custom count up to 101. Review the destination and confirm. Generating 101 blocks on a fresh chain makes the first reward spendable.
3. **Send test bitcoin:** select the sending Core wallet, enter a recipient Regtest address (for example from Sparrow), amount in BTC, and fee rate in sat/vB. Review and confirm. The sender pays the fee in addition to the amount.
4. **Build a block:** enter a total transaction count and fee rate. For example, 20 means 19 self-transfers plus one mining reward. Review before creating one real Regtest block. See the [block builder guide](docs/BLOCK-BUILDER.md) for wallet requirements, fees and block limits.

Results show the new address, block hash, or transaction ID, then refresh the dashboard. Only loaded Core wallets are selectable. Encrypted wallets must be unlocked through your existing wallet workflow; watch-only wallets cannot sign sends. Mining to an existing address does not need a loaded Core wallet.

Actions use fixed backend methods; there is no generic RPC console. The [architecture guide](docs/ARCHITECTURE.md) lists the complete action surface. See the [Core send RPC reference](https://bitcoincore.org/en/doc/29.0.0/rpc/wallet/sendtoaddress/) and [block-generation reference](https://developer.bitcoin.org/reference/rpc/generatetoaddress.html).

If an action times out, it might have completed. Check the refreshed wallet or chain before submitting a new action. The server deduplicates a request ID for its lifetime, including failed requests; this protection does not survive a restart, and a new confirmation creates a new ID. Actions are never automatically retried.

Set `DASHBOARD_ACTIONS_ENABLED=false` in `.env` and restart to return to read-only mode.

## Start a Windows/WSL lab

Start your existing Regtest node in Ubuntu/WSL and make sure Node.js 20+ is installed **inside WSL**. The runtime is not bundled. If needed, the optional installer below can download a project-local runtime. Run this in PowerShell from the project folder:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Start-Dashboard.ps1
```

Then open [the dashboard](http://127.0.0.1:3000/#lab-actions). Keep the terminal open; **Ctrl+C** stops only the dashboard. Do not start a second copy while port 3000 is in use. To use another port, add `-Port 3004` and open that port instead. The dedicated explorer uses port 3002.

The execution-policy option applies to that process only. Review `Start-Dashboard.ps1` before running it. The launcher runs the backend inside Ubuntu and locates `~/.bitcoin/bitcoin.conf` in the WSL user's home directory. It never prints credentials or starts, stops, resets, or reconfigures Core/electrs. Pass `-Distribution` or `-BitcoinConfigPath` if your existing setup uses different locations.

The optional `.runtime/node-linux` directory is ignored by Git. To install it on a fresh checkout with no Linux Node runtime, use `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-wsl-runtime.ps1`. That installer downloads the official Node.js 24 Linux x64 archive and verifies its SHA-256 against Node.js's HTTPS checksum list before extracting it. It changes no global packages and will not overwrite an installed runtime. Alternatively, use an existing Node.js 20+ installation in WSL.

## Alternative: run Node directly on Windows

Prerequisite: Node.js 20 or newer. Bitcoin Core and electrs can keep running in Ubuntu/WSL as they do today.

1. Open PowerShell in this project folder.
2. Create the ignored local settings file if one does not already exist:

   ```powershell
   if (!(Test-Path .env)) { Copy-Item .env.example .env }
   notepad .env
   ```

3. Leave the credential fields empty and set `BITCOIN_CONFIG_PATH` in `.env` to your existing configuration file. For WSL on Windows, use `\\wsl.localhost\Ubuntu\home\YOUR_LINUX_USER\.bitcoin\bitcoin.conf`, replacing `YOUR_LINUX_USER` and the distribution name as needed. Alternatively, supply both credentials privately in `.env`. Neither the real `.env` nor `bitcoin.conf` belongs in GitHub.
4. Start the dashboard (no package installation is needed):

   ```powershell
   node server.mjs
   ```

5. Open [http://127.0.0.1:3000](http://127.0.0.1:3000).
6. Stop it with **Ctrl+C** in that PowerShell window.

There are no packages to install: the project uses only Node.js built-ins and browser-native JavaScript.

## Run inside Ubuntu/WSL instead

If Windows cannot reach a service bound to WSL loopback, run the dashboard in the same Ubuntu/WSL environment as Bitcoin Core and electrs:

```bash
# From the project folder, with Linux Node.js 20+ installed:
BITCOIN_CONFIG_PATH="$HOME/.bitcoin/bitcoin.conf" node server.mjs
```

The shell expands `$HOME` to your Linux home directory. Use a Linux path inside WSL, not a Windows UNC path. Then open `http://127.0.0.1:3000` in Windows. WSL normally forwards Linux localhost ports to Windows automatically.

If the Windows copy of Node is used, it also normally reaches WSL services through `127.0.0.1`. If that does not work, confirm that WSL localhost forwarding has not been disabled in `%UserProfile%\.wslconfig`, or use the WSL launch option above. Do not change Bitcoin Core or electrs to listen on every interface just to make the dashboard work.

## Expected local services

The dashboard assumes your existing setup remains unchanged:

| Service | Local address | Notes |
| --- | --- | --- |
| Bitcoin Core JSON-RPC | `127.0.0.1:18443` | Regtest, authenticated with the configured RPC user/password |
| electrs Electrum TCP | `127.0.0.1:60401` | Regtest, plaintext TCP because it never leaves localhost |
| Dashboard | `127.0.0.1:3000` | Loopback-only; explicit Regtest actions |
| Explorer | `127.0.0.1:3002/explorer/` | Loopback-only; read-only views |

Useful non-destructive checks in Ubuntu/WSL:

```bash
bitcoin-cli -regtest getblockchaininfo
bitcoin-cli -regtest listwallets
ss -lnt | grep -E '18443|60401'
```

Start Bitcoin Core and electrs using your existing commands/configuration. For a stopped Core installation, `bitcoind -regtest -daemon` starts the existing Regtest data directory. The dashboard does not manage service lifecycles or reset/reindex data. Its mining and wallet changes occur only through confirmed lab actions.

## What “waiting for 0 blocks to download (IBD)” means

electrs checks Bitcoin Core’s `initialblockdownload` field before indexing. A fresh Regtest chain can report:

- `blocks: 0`
- `headers: 0`
- `initialblockdownload: true`

So the number of missing blocks is genuinely zero, but Core still identifies itself as being in **Initial Block Download**. electrs is waiting for that boolean flag to clear; it is not secretly downloading another block. This also happens on an existing idle chain after restarting Core if its latest block is too old. Core checks tip age in addition to block availability ([Core source](https://github.com/bitcoin/bitcoin/blob/v30.0/src/validation.cpp#L1829)). On Regtest a newly generated block can resolve the stale-tip condition; check Core's flag afterward rather than assuming it cleared. The dashboard shows the boolean and numeric block gap separately.

You can use **Lab controls → Generate blocks** with an explicit Regtest reward address to create the first block, then refresh to see whether Core has cleared IBD. An IBD flag does not disable the Regtest block-generation control.

## Sparrow Wallet on Windows

In Sparrow:

1. Select the **Regtest** network/profile.
2. Open **File → Preferences → Server**.
3. Choose **Private Electrum**.
4. Set the host to `127.0.0.1` and port to `60401`.
5. Leave SSL disabled for this local plaintext electrs listener.
6. Test the connection after electrs reports indexed at the Core tip.

If Sparrow cannot connect from Windows but electrs works inside WSL, use the WSL troubleshooting guidance above. Prefer localhost forwarding over exposing port 60401 on the LAN.

## Configuration

Supply RPC credentials using environment variables or the optional existing configuration file:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DASHBOARD_PORT` | `3000` | Local web dashboard port |
| `DASHBOARD_ACTIONS_ENABLED` | `true` | Set exactly `false` to disable actions |
| `BITCOIN_CONFIG_PATH` | — | Absolute path to existing bitcoin.conf; reads global and `[regtest]` RPC credentials only |
| `BITCOIN_RPC_HOST` | `127.0.0.1` | Bitcoin Core RPC host |
| `BITCOIN_RPC_PORT` | `18443` | Bitcoin Core Regtest RPC port |
| `BITCOIN_RPC_USER` | — | Server-only RPC username |
| `BITCOIN_RPC_PASSWORD` | — | Server-only RPC password |
| `ELECTRS_HOST` | `127.0.0.1` | electrs host |
| `ELECTRS_PORT` | `60401` | Electrum TCP port |
| `REQUEST_TIMEOUT_MS` | `4000` | Timeout for each local service check |
| `AUTO_REFRESH_MS` | `10000` | Browser refresh interval, minimum 3 seconds |

The dashboard web server itself always binds to `127.0.0.1`. See [the architecture and safety boundary](docs/ARCHITECTURE.md) for the complete RPC surface and assumptions.

The configuration-file reader supports direct `rpcuser`/`rpcpassword` entries in the global or `[regtest]` section; Regtest entries take priority. It does not follow `includeconf` or resolve `rpcauth`/cookie authentication. Explicit environment credentials override file credentials. Do not leave placeholder environment credentials set when using `BITCOIN_CONFIG_PATH`.

## Test and develop

```powershell
node --test "test/*.test.mjs"
node --check server.mjs
node --check public/app.js
```

If npm is installed, the equivalent shortcuts are `npm test`, `npm run check`, and `npm run dev`. For ordinary use, `node server.mjs` is sufficient.

## Troubleshooting

- **Core unavailable:** confirm Bitcoin Core is running, Regtest is selected, RPC is listening on port 18443, and `.env` matches `bitcoin.conf`.
- **Authentication rejected:** re-check the local `.env` values. The dashboard intentionally does not echo them back.
- **electrs unavailable:** confirm the process is still running and listening on `127.0.0.1:60401`.
- **electrs port open, no RPC reply:** the TCP listener exists, but its Electrum queries have not completed. If Core is in IBD, electrs may be waiting for it; an open port alone does not prove indexing or Sparrow readiness. Some electrs versions print the RPC password in their startup configuration, so do not share or save unredacted startup output.
- **electrs indexing / IBD:** check `bitcoin-cli -regtest getblockchaininfo`. Compare `blocks`, `headers`, and `initialblockdownload` rather than relying on the log sentence alone.
- **No wallets:** this is not an error. Only wallets already loaded by Bitcoin Core appear with balances and transactions.
- **Sparrow fails on Windows:** run the dashboard in WSL as a quick connectivity check, then inspect WSL localhost forwarding. Do not publish the ports to your network.

## Verification and future work

Run `node --test "test/*.test.mjs"` for the RPC boundary, network guards, amount validation, duplicate requests, uncertain outcomes, and local HTTP protections. `node qa/interactive-preview.mjs` starts a clearly marked simulated dashboard on port 3001 for UI testing, using no real Core data. Stop it with Ctrl+C. Chain Atlas provides block and transaction drill-downs; see [the explorer guide](docs/EXPLORER.md).

## Sharing the source

Both apps live in this repository. Keep personal configuration, credentials, wallets, chain data, screenshots, logs and generated archives out of uploads. The checked-in `.env.example` contains empty credential fields, and the WSL launchers discover the Linux home directory automatically. Test credentials and sample-chain data are synthetic.

See [the source-sharing guide](docs/SHARING.md) for the included files, exclusions and review procedure. GitHub stores the source; these local backends are started on your computer, not hosted by GitHub Pages.
