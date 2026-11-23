# Build blocks with more transactions

Open the dashboard at **http://127.0.0.1:3000/#block-builder**. In **Build a block**, choose a loaded wallet, enter a total transaction count and fee rate, then select **Review block**. Read the confirmation before choosing **Confirm**. The result links directly to the new block in Chain Atlas.

The count includes the mining-reward transaction (coinbase):

| Total entered | Test transfers | Mining reward |
| --- | --- | --- |
| 7 | 6 | 1 |
| 20 | 19 | 1 |
| 35 | 34 | 1 |
| 125 | 124 | 1 |

Enter a different count for each new block. The presets are shortcuts, not a restriction to 20 or 50 transactions. Bitcoin's block weight limit still applies, and preparation stops after two minutes. A very large request may need a smaller count. Explorer pagination shows 25 transactions at a time; it does not limit a block to 25 transactions.

These are **real transactions on your local Regtest chain**, not Sample chain entries. Existing blocks keep their original transactions. Each confirmed operation creates one new block. It does not reset, replace or reindex your chain.

## Wallet and fees

Use a loaded, unlocked Bitcoin Core wallet with local signing keys. To create test transfers, it needs one confirmed, spendable native SegWit (P2WPKH) output large enough to cover the fees plus 1,000 satoshis. Immature mining rewards cannot fund the transfers. The builder does not load/unlock wallets or mine extra funding blocks automatically. Use your existing Core wallet workflow if the wallet is unloaded or locked.

Every transfer sends the selected output's remaining value back to one new address in the same wallet. This creates visible transaction activity; it is not a payment to another person. The new block's mining reward also goes to that wallet. The displayed count controls the number of transfers, not their BTC amounts.

Each transfer reserves a fee for 110 virtual bytes, rounded up to a whole satoshi. At 1 sat/vB, a 20-transaction block uses 19 × 110 = **2,090 satoshis (0.00002090 BTC)** in transfer fees. The review shows the complete fee total before submission. Treat those fees as spent; do not assume they are returned in the mining reward. Actual signed transaction sizes may be slightly smaller than the fee budget.

Other transactions already in your mempool are left for a later block. Use the existing **Generate blocks** control when you want normal mining that includes pending transactions.

## How it works safely

The backend selects a confirmed native SegWit output, creates an address belonging to the same wallet, and prepares an ordered chain of signed self-transfers. It verifies each transfer's input, destination, amount and weight, checks that the original output remains available, and passes the prepared transactions to Core's `generateblock` method. Core validates them together. Preparing them outside the mempool avoids the usual ancestor-chain policy limit, so counts above 20 are supported without creating extra preparation blocks.

Only the backend handles signatures and RPC credentials. The browser receives a summary and block hash. There is no arbitrary RPC, raw-transaction submission, key-export or shell-command endpoint. The existing local-only binding, Regtest guard, session token, same-origin checks, confirmation, strict fields, single-action lock and duplicate-request protection apply.

A preparation failure submits no block, although a receiving address may already have been created. If the result says the outcome is **uncertain**, inspect the explorer before submitting again: Core may already have mined the block. Never repeat an uncertain request blindly. Completed blocks cannot be undone through this application.

## Start and stop

From PowerShell in the project folder:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Start-Dashboard.ps1
```

Keep the terminal open. Ctrl+C stops the dashboard, not Core or electrs. Restart the launcher after a reboot or WSL shutdown. The dashboard also serves Chain Atlas at **http://127.0.0.1:3000/explorer/**. The dedicated read-only explorer remains at **http://127.0.0.1:3002/explorer/** when its separate launcher is running. GitHub stores the code; it does not run your local node.

## Verification

Run the automated suite with `node --test "test/*.test.mjs"`. Builder tests cover custom counts, ownership and amount checks, insufficient funds, wrong network, locked/watch-only wallets, cancellation, duplicate requests, uncertain outcomes and HTTP protections.

An optional integration check uses an installed `bitcoind` and Node.js inside WSL:

```sh
node qa/verify-block-builder-core.mjs
```

It starts a separate Core process with a fresh, ignored `.runtime/builder-core-*` data directory and temporary loopback RPC port, then stops only that process. It does not use the existing node's credentials, wallet or data directory. The test mines its own funding blocks, then verifies blocks with **7, 20, 35 and 125 transactions**, complete explorer pagination and transaction details, and preservation of an unrelated pending transaction. Test files remain under the ignored runtime directory for inspection.

Implementation references: Bitcoin Core's [generateblock implementation](https://raw.githubusercontent.com/bitcoin/bitcoin/v30.0/src/rpc/mining.cpp), [wallet signing RPC](https://bitcoincore.org/en/doc/30.0.0/rpc/wallet/signrawtransactionwithwallet/), and [block weight limit](https://raw.githubusercontent.com/bitcoin/bitcoin/v30.0/src/consensus/consensus.h).
