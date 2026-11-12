# Architecture and change map

ForeLoom is a desktop app. `src/main.tsx` mounts `src/App.tsx`; components render tree, place, selector, and research views. `src/lib/api.ts` sends Tauri commands and `src/lib/types.ts` holds frontend data shapes. Rust commands in `src-tauri/src/lib.rs` are the boundary between the UI and local data or network calls.

`db.rs` stores a catalog of trees and one SQLite database per tree, with imported and attached media under local app-data storage. `gedcom.rs` previews and imports user exports, validating size and media paths. `issues.rs` derives review issues from saved facts. `places.rs` resolves place names against the offline GeoNames index prepared by `scripts/prepare_gazetteer.py`. `research.rs` searches selected external sources and saves cited captures. Optional AI commands call a local Ollama service.

For a UI change, start in `src/App.tsx` or the relevant component. For a command contract, update `src/lib/api.ts`, `src/lib/types.ts`, and its Rust handler together. For persistent data, inspect `db.rs` migrations and backup/restore behavior before changing tables. For import handling, preserve source facts, path checks, size limits, and rollback behavior. Tests sit beside frontend helpers and in Rust modules.

Native behavior requires `npm run tauri dev`. `npm run dev` alone cannot exercise local storage or file dialogs. Use synthetic records for tests and screenshots.
