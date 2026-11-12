# ForeLoom agent guide

ForeLoom is a Tauri 2 desktop genealogy prototype: React 19 and TypeScript in `src/`, Rust and SQLite in `src-tauri/`, and Python scripts for the offline place index.

## Find the change

- `src/main.tsx` mounts the app; `src/App.tsx` coordinates most UI workflows; `src/components/` holds focused views.
- `src/lib/api.ts` is the typed frontend command client; `src/lib/types.ts` defines shared frontend shapes. Update both when a Tauri command's interface changes.
- `src-tauri/src/lib.rs` registers commands. `db.rs` owns storage and migrations; `gedcom.rs` import; `issues.rs` deterministic review; `places.rs` place matching; `research.rs` source search and capture.
- `scripts/prepare_gazetteer.py` verifies the bundled index; `scripts/build_gazetteer.py` describes how it is built.

Read [architecture](docs/architecture.md) and nearby tests before changing a workflow. Preserve existing validation, error handling, and data provenance when moving code.

## Work and verify

1. Use Node 22, Python 3, the pinned rustup toolchain, and Tauri 2 OS prerequisites.
2. Run `npm ci` and `python3 scripts/prepare_gazetteer.py`; use `npm run tauri dev` for native behavior.
3. Make a focused change and add a small test for new nontrivial logic.
4. Run `npm test`, `npm run build`, and `cd src-tauri && cargo test --locked` as applicable. For native packaging, run `npm run tauri build`.
5. Update user documentation if behavior or setup changes; report checks performed and remaining risks.

Never commit credentials, real family exports, local databases, media, or backups. Never delete user data, change production infrastructure, publish, or rewrite history without approval. Do not invent API behavior or bypass a failing check. `npm run dev` is frontend-only; native features need Tauri. The optional `KINFOLK_GEDCOM_FILE` test uses a private export and stays ignored by default.
