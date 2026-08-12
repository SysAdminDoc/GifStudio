# ROADMAP

Actionable work only. Historical and completed roadmap material is archived in CHANGELOG.md; blocked work is kept in Roadmap_Blocked.md.

## Actionable Items

- [ ] P2 — Automate vendored codec refresh and evaluate pako 3
  Why: Runtime assets, licenses, and integrity hashes are staged manually while pako 3.0.1 introduces module/API changes and UPNG.js has limited upstream activity.
  Evidence: `package.json`; `scripts/build-artifact.mjs`; `vendor/`; pako 2.1.0...3.0.1 comparison; UPNG.js and gifsicle-wasm-browser package histories.
  Touches: `package.json`; lockfile; `scripts/`; `vendor/`; integrity/license manifests; APNG and release tests.
  Acceptance: One documented command stages exact package payloads, licenses, and generated integrity metadata; CI detects drift; pako 3 is adopted only if APNG byte/round-trip parity and browser lanes pass, otherwise the pinned deferral reason is encoded in the refresh check.
  Complexity: M

- [ ] P2 — Extract history, recovery, and export controllers from `GIFEditor`
  Why: The approximately 3,800-line class couples state ownership, canvas mutation, persistence, encoding, diagnostics, and DOM coordination, limiting focused tests and safe evolution.
  Evidence: `src/app.js`; existing codec boundaries in `src/gif-decoder.js` and `src/gif-encoder.js`.
  Touches: `src/app.js`; new JavaScript modules in `src/`; `scripts/build-artifact.mjs`; unit and E2E tests.
  Acceptance: After the frame-store task lands, history, recovery, and export each expose an explicit dependency-injected interface with focused unit tests; generated `index.html`, offline behavior, keyboard commands, diagnostics, and export bytes retain existing behavior.
  Complexity: L
