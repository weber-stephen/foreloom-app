# Contributing

ForeLoom is a portfolio prototype. Issues that include a reproducible GEDCOM example made from synthetic people, an expected result, and the actual result are especially useful. Do not attach real family records or credentials.

Set up the app using the [README](README.md). For a code change, read [AGENTS.md](AGENTS.md), keep the change focused, and add a test when behavior changes. Run `npm test`, `npm run build`, and `cd src-tauri && cargo test --locked` for relevant changes. Include the commands and results in a pull request. Document setup or user-facing changes in the README or [architecture guide](docs/architecture.md).

For a vulnerability, use the private reporting instructions in [SECURITY.md](SECURITY.md) instead of a public issue.
