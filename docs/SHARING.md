# Share the Explorer and Dashboard source

The repository contains both **Regtest Observatory** (dashboard) and **Chain Atlas** (explorer). A checkout needs source code and generic setup instructions, not the author's node data or credentials.

## Include

- `public/`: local HTML, JavaScript, CSS and original SVG artwork for both apps.
- `src/` and `server.mjs`: the local backend and fixed RPC clients.
- `test/` and `qa/`: automated tests and clearly synthetic fixtures. The optional Core integration test creates its own isolated test data only when run.
- `Start-Dashboard.ps1`, `Start-Explorer.ps1`, `scripts/install-wsl-runtime.ps1` and `package.json`.
- `.gitignore`, the empty-credential `.env.example`, `README.md`, `LICENSE`, `SECURITY.md`, and the guides in `docs/`.

## Exclude

Never upload the real `.env`, `bitcoin.conf`, `.cookie`, RPC credentials, private keys, recovery words, wallet databases/exports, chain or electrs databases, `.runtime/`, application logs, local screenshots, backups, generated archives, or the generated `GitHub-Upload/` directory. The ignore file blocks these common categories; an explicit file list is still required when uploading through a browser or API.

The setup example leaves RPC credentials blank. The recommended WSL launchers find the Linux user's existing configuration automatically. The actual credentials stay on the user's computer and are read only by the local backend. No real wallet or transaction data is needed to run the automated tests.

## Before an upload

1. Review every proposed path, including hidden files. Use the source categories above; do not select the entire working folder.
2. Inspect changes for pasted passwords, tokens, keys, personal home paths, real wallet records and screenshots. Test values must be clearly synthetic.
3. Run `node --test "test/*.test.mjs"` from the proposed source copy. This avoids discovering duplicate tests in ignored local export folders.
4. Check existing Git history and any older archive separately. Removing a file in a new commit does not remove its previous versions. Do not rewrite shared history without coordinating with the repository owner.
5. Verify the GitHub file list and commit after uploading. Keep the existing repository visibility unless the owner explicitly changes it.

For an exported source folder, run the same tests inside that folder before upload. A clean current folder is not proof that every historical commit, other branch, release attachment, or external log is free of sensitive data. A targeted review lowers the risk; it does not replace careful handling of future changes.

See [SECURITY.md](../SECURITY.md) for the application's local-only security boundary. Uploading source does not expose a running Core RPC service or turn the dashboard into an internet-hosted website.
