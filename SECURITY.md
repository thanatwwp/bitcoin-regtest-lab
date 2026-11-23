# Local security boundary

Regtest Observatory and Chain Atlas are personal, local applications. This review hardens their Node.js backend and browser pages; it is not a guarantee of zero vulnerabilities or an audit of the computer, Bitcoin Core, electrs, Sparrow, or repository history.

## What the application protects

- **Local connections only.** The web server binds to `127.0.0.1`. Core and Electrum destinations must be `127.0.0.1`, `localhost`, or IPv6 loopback. `localhost` is normalized to a literal address before connecting, and Core HTTP redirects are rejected. Run the backend in the same WSL distribution as Core/electrs if forwarding is unavailable; do not expose RPC to the LAN.
- **Server-only credentials.** RPC credentials are read from environment settings or the existing Bitcoin configuration. They are used only for the local backend's Authorization header. Responses and application logs exclude credentials, raw upstream errors and request bodies. No wallet key export or general RPC endpoint exists.
- **A fixed public file list.** Only named HTML, CSS, JavaScript and SVG assets can be downloaded. Configuration files, source files, backups, PHP files and unexpected files remain inaccessible even if accidentally placed under `public/`. Symlinked assets are rejected. Add new browser assets deliberately to `PUBLIC_ASSETS` in `server.mjs`.
- **Browser request isolation.** Host and Origin checks restrict requests to the current local server. API calls from another localhost port are rejected using Fetch Metadata where available. Cross-origin CORS access is not enabled. CSP blocks inline/evaluated scripts, plugins, external connections and framing; other headers disable MIME sniffing, referrers and unnecessary device permissions. Application data is not cached.
- **Safe rendering.** Upstream strings, including wallet names and shortened hashes, are escaped before insertion into HTML; numeric values are formatted instead of inserted into attributes directly. The app loads no external scripts, fonts, analytics or images.
- **Explicit actions.** The explorer launcher disables mutations. Dashboard actions retain their review dialog, same-origin POST requirement, session token, strict input validation, live Regtest check, bounded amounts/counts and duplicate-request protection. The block builder accepts custom counts within block-weight and preparation-time budgets; signing stays server-side, with every prepared input, output and amount checked against the reviewed self-transfer plan. It never accepts raw transactions or external destinations from the browser. Set `DASHBOARD_ACTIONS_ENABLED=false` and restart for a read-only dashboard. A session token is a browser request safeguard, not a user login.
- **Bounded work.** Core replies are capped at 16 MiB, Electrum status replies at 64 KiB, and address-index replies at 2,000,000 bytes. Malformed or oversized replies fail safely. The server limits headers to 8 KiB, URLs to 2,048 characters, action bodies to 4 KiB, connections to 64, and concurrent dashboard/explorer/action HTTP requests to 2/4/2. Only one wallet/mining action executes at a time. Timeouts and list limits further bound work. These are resource limits, not public-service DDoS protection.

There is no PHP runtime, file-upload route, shell-command route or web-request code that starts a subprocess. The PowerShell launchers are local startup tools, not HTTP endpoints.

## Limits and safe operation

This application has no multi-user authentication or public-hosting security design. Other processes or people with access to this OS account can reach localhost, read accessible configuration files, or control the browser. A compromised local service, browser extension or operating system remains outside this boundary. Do not expose the web ports through tunnels, reverse proxies or firewall forwarding. Do not use real funds or point this lab at Mainnet.

Keep Node.js, Windows/WSL, Core, electrs and the browser on supported security updates. Keep `.env`, `bitcoin.conf`, `.cookie`, wallet files, databases, runtime logs and screenshots out of Git. Review the exact file list before uploading; `.gitignore` does not remove secrets that were already committed. A source review cannot establish that older commits, archives or external logs contain no secrets. If a real credential is exposed, rotate it through your normal node administration workflow and remove the exposed copy.

The 16 MiB Core reply limit can reject unusually large decoded blocks. The 2 MB address limit can reject large histories. These errors do not indicate a zero balance. Wallets and mempool data also show unavailable rather than zero when the service cannot be read. Stale dashboard data is visibly marked after a failed refresh.

Startup and shutdown remain local: see [dashboard instructions](README.md) and [explorer instructions](docs/EXPLORER.md). Stopping either web server leaves Core, electrs and wallet data intact. GitHub stores the source; GitHub Pages cannot run this private Node/TCP backend.

## Verification — 2026-11-10

Run from the project root with Node.js; no package installation is needed:

```sh
node --test "test/*.test.mjs"
node --check server.mjs
node --check public/app.js
node --check public/actions.js
node --check public/explorer/explorer.js
```

The 59 tests cover existing explorer and dashboard behavior, forbidden RPC methods, credential handling, wrong-network guards, confirmation and duplicate requests, Host/Origin/Fetch Metadata rejection, static-file and symlink isolation, response limits, malformed Electrum packets, concurrency limits, unavailable data and hostile HTML in upstream fields. Transaction lookup coverage includes preserved block references, bounded loaded-wallet fallback and untrusted metadata. Builder coverage includes custom counts, ownership/amount checks, insufficient funds, locked/watch-only wallets, cancellation and uncertain outcomes. HTTP/TCP fixtures and rendering tests use synthetic data. No test mines blocks, sends bitcoin or creates an address on the user's existing node. The optional [isolated Core check](docs/BLOCK-BUILDER.md#verification) creates test transactions only in its own temporary data directory and stops its own process afterward.

This is application-level verification, not an independent penetration test. Report a suspected issue privately to the repository owner with reproduction steps and redacted output; never include RPC credentials, wallet files or private keys.

Design references: [OWASP command injection prevention](https://cheatsheetseries.owasp.org/cheatsheets/OS_Command_Injection_Defense_Cheat_Sheet.html), [OWASP CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html), [OWASP SSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html), and [MDN Fetch Metadata](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Fetch_metadata).
