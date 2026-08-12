# Changelog

All notable changes to GifStudio will be documented in this file.

## [Unreleased]

- Changed: Vendored codecs now refresh from exact package payloads with generated provenance, licenses, and drift checks; pako 3.0.1 passed APNG byte/round-trip parity in Node, Chromium, Firefox, and WebKit.
- Added: PWA manifest colors now match the graphite token palette, with validated 192- and 512-pixel any/maskable icons cached for offline installation.
- Testing: CI now compares deterministic Chromium screenshots for the empty workspace, loaded editor, recovery banner, export modal, and 390-pixel drawer; baseline refreshes require an explicit review command.
- Accessibility: Sidebar edit sections are keyboard-operated disclosures with persisted open state, and choosing Crop or Redact reveals its controls automatically.
- Added: Recovery diagnostics now report storage usage, quota, and durability; users can request persistent storage, and denial or unsupported APIs leave best-effort autosave running.
- Fixed: Quota failures retain the last committed recovery and provide export-first site-storage guidance.
- Changed: Platform-fit guidance now distinguishes Discord messages, Discord emoji, X web GIFs, and X mobile GIFs using limits reviewed on 2026-07-29, then replaces estimates with validated final bytes after export.
- Testing: The complete editor contract now runs in Chromium, Firefox, and WebKit with explicit capability annotations, and every native pixel decode first passes the strict GIF structural parser.
- Security: The GIF parser now caps input and accumulated sub-block bytes and is covered by deterministic truncation, malformed-structure, LZW, interlace/disposal, multi-frame, and byte-mutation tests.
- Performance: Undo/redo now shares unchanged frame canvases, trims history by measured bytes, and reports its byte budget instead of deep-copying every frame for every edit.
- Performance: Recovery autosave retains immutable frame references and PNG-encodes only changed canvases while preserving complete session records.
- Fixed: Recovery records are isolated per browser tab, active-tab conflicts are visible, stale tabs cannot delete another tab's session, and abandoned recoveries can be reclaimed safely.
- Accessibility: Loaded projects make the hidden import surface inert and remove it from the accessibility tree and keyboard focus order.
- Changed: Reimagined the editor as a warm graphite motion workbench with a high-contrast orange action system, technical-grid canvas, denser inspector, and filmstrip styling.
- Changed: The empty workspace now offers a direct Choose files action, supported-format cues, and explicit local-processing reassurance.
- Fixed: The saved-session recovery banner now adapts cleanly to 390 px mobile layouts without narrow text wrapping or horizontal overflow.

## [v0.6.0] - 2026-07-25

- Security: Reject truncated or structurally invalid GIF blocks, invalid LZW parameters, out-of-bounds frames, missing trailers, and palette overreads with actionable errors.
- Security: Enforce the same 8192×8192, 500-frame, and 256 MiB decoded-frame budget on native and JavaScript GIF decoding.
- Added: Node regression tests and a GitHub Actions release check for the shipped inline scripts, parser fixtures, manifest, CSP, service worker, assets, and version badge.
- Fixed: GIF, image-sequence, paste, and recovery imports now build candidate projects off-state and commit atomically; failures preserve the active project and replaced canvases are released.
- Fixed: Destructive edits now stop playback and refuse to race active imports or exports.
- Added: GIF, APNG, and optimizer jobs use immutable frame snapshots, shared cancellation/generation guards, monotonic progress, guaranteed cleanup, control locking, and main-thread block profiling.
- Added: Playwright coverage runs against the shipped `index.html` for failed-import rollback, GIF signature validation, and export cancellation recovery.
- Added: CI now verifies GIF centisecond rounding, APNG structure, autosave recovery, timeline keyboard behavior, and a 24-frame export performance budget using pinned test dependencies.
- Changed: Timing controls are format-aware: GIF edits use centiseconds with deterministic output rounding and FPS, while APNG edits use milliseconds.
- Added: Source, edited, and encoded durations are reported separately with viewer compatibility warnings; size estimates now include the encoded duration model.
- Fixed: Autosave now aborts superseded writes and atomically stores a versioned session with source timing plus playback and export settings.
- Added: Recovery migrates legacy records, rejects corrupt data, retains records from newer schema versions, restores editor state, awaits deletion, and reports storage/quota failures with export guidance.
- Changed: Recovery data is retained locally until the user dismisses it or it reaches the seven-day expiry.
- Security: Optional pako, UPNG.js, and gifsicle-wasm code is now same-origin, versioned, SRI-checked, hash-verified by the release gate, and shipped with upstream license texts; mutable CDN execution was removed from CSP.
- Added: The service worker caches the complete app shell and optional codecs, serves an offline fallback, removes old versioned caches, reports failures, and offers an explicit reload notice when an update is waiting.
- Accessibility: Timeline options now expose position/count and multi-selection, support arrow/Home/End/Delete navigation with roving focus, and label per-frame delete controls.
- Accessibility: The mobile drawer and export modal expose state, manage focus, support Escape and modal focus trapping, and return focus to their launch controls.
- Accessibility: Playback and reduced-motion navigation avoid smooth timeline scrolling; automated 390 px overflow and keyboard checks cover the shipped page.
- Added: The frame inspector now distinguishes decoded source properties from unavailable raw GIF metadata and reports validated GIF/APNG output dimensions, frames, duration, and size.
- Fixed: Export success and download are withheld when the encoded output fails structural, dimension, frame, or timing validation.
- Fixed: The bundled UPNG.js output allocation now reserves APNG frame, palette, filter, and compression overhead instead of truncating small animations.
- Added: Shared memory preflights now estimate raw-frame, resident-history, and temporary-buffer peaks before native/fallback decode, edits, recovery, autosave, and export.
- Added: Device-aware default budgets offer a one-operation override below a hard 1 GiB ceiling, while unsafe work stops before allocation with export/reload recovery guidance.
- Added: The inspector records the latest and highest estimated memory peaks; automated coverage verifies cancellation, override, decoder parity, and pre-clone edit/export stops.
- Changed: GIF export intentionally retains full-canvas frame descriptors; the former delta path could not safely clear opaque pixels back to transparency without look-ahead disposal handling.
- Added: A fixed full-frame benchmark now gates encoded bytes, pixel equivalence, frame timing, internal parsing, and native `ImageDecoder` compatibility.
- Documentation: Added a verified capability/limits matrix covering local versus hosted operation, offline caching, decoder fallbacks, memory ceilings, timing units, output validation, browser API fallbacks, and recovery.
- Added: Release coverage now includes a clean shipped-page boot with no console or uncaught errors, completing the static and browser release contract.
- Fixed: Split-frame ZIP export now uses immutable export jobs with memory/size/count preflights, progress, cancellation, null-PNG recovery, basename normalization, chunked CRC/copy work, and a 512 MiB ZIP32 limit.
- Added: ZIP regression coverage validates entry names, PNG signatures, CRCs, end records, cancellation cleanup, serialization failure recovery, and oversized preflight rejection.
- Added: A sidebar diagnostics action copies app version, project shape, selected format, memory/export profiles, capability fallbacks, service-worker/storage/codec state, and the last sanitized error.
- Privacy: Diagnostics explicitly exclude frame pixels, thumbnails, filenames, URLs, user-agent data, and telemetry; clipboard fallback and mobile-drawer focus are covered by browser tests.
- Developer experience: Decoder, encoder, and application runtime code now live in linted/tested `src/` boundaries while deterministic generation keeps `index.html` as the zero-install artifact.
- Added: Artifact generation/check commands, source-versus-embedded release validation, and LF normalization make clean-checkout `index.html` reproduction byte-for-byte across supported development platforms.
- CI: Updated checkout and Node setup actions to their Node 24-based v7 releases after the v0.6.0 gate exposed the Node 20 action-runtime deprecation.

## [v0.5.2] - 2026-06-27

- Fixed: GIF disposal method 3 now restores the compositor to the pre-draw state instead of copying the previous rendered frame.
- Fixed: Concurrent GIF/image imports are guarded so overlapping loads cannot clear undo history or overwrite editor state mid-decode.
- Fixed: Export quality and Floyd-Steinberg dithering controls now affect gifenc output.
- Fixed: Autosave now snapshots frames before async PNG serialization and ignores stale saves after newer edits.
- Fixed: GIF export progress now repaints while frames are added to the encoder.
- Fixed: Crop resize handles clamp against the opposite edge so NW/NE/SW drags cannot invert the crop rectangle.

## [v0.4.0] - 2026-06-20

- Fixed: Playback mode buttons (Normal/Ping-pong/Boomerang) now functional — were visible but had no click handlers
- Fixed: GIF encoder minCodeSize derived from actual palette size instead of hardcoded to 8 — smaller output for low-color exports
- Fixed: og:image meta tag now references existing icon.png instead of missing banner.png
- Fixed: File size estimate now factors in color count and updates when color dropdown changes
- Added: Color count and dither dropdowns now trigger live size estimate updates
- Changed: Vendored Google Fonts (Plus Jakarta Sans + JetBrains Mono) as inline base64 woff2 — zero external requests, works offline
- Changed: CSP updated to remove Google Fonts CDN, add font-src data: and wasm-unsafe-eval
- Changed: Replaced custom GIF encoder with gifenc v1.0.3 (MIT, mattdesl) — PNN quantizer, faster LZW, better color quality
- Added: Social platform resize presets — Discord Emoji, Telegram Sticker, Twitter/X, Full HD, and more
- Improved: Timeline performance with CSS content-visibility for off-screen frame thumbnails
- Added: Canvas Expand tool — add padding/margins without scaling content, with 9-point anchor and color picker
- Added: Split Frames to PNGs — export all frames as numbered PNG files in a ZIP archive
- Added: Redaction/obfuscation tool — pixelate, blur, or black-fill regions across current, selected, or all frames
- Improved: GIF import uses native ImageDecoder API on Chrome/Firefox for faster decoding, falls back to JS parser on Safari
- Added: Background Layer tool — burn a solid color or image behind all frames (useful for transparent GIF compositing)

## [v0.5.0] - 2026-06-20

- Added: Export format dropdown — GIF or APNG
- Added: APNG export via UPNG.js (MIT) with per-frame delays, alpha transparency, and lossy palette option — loaded on demand from CDN
- Added: PWA support — manifest.json + coi-serviceworker for installability, offline capability, and SharedArrayBuffer (COOP/COEP)
- Changed: CSP updated with manifest-src, worker-src 'self', img-src 'self' for PWA compliance
- Added: Session autosave to IndexedDB — debounced save after each edit, recovery banner on reload with restore/dismiss options, 7-day expiry

## [v0.5.1] - 2026-06-20

### Bug fixes
- Fixed: ReferenceError crash when loading GIF via native ImageDecoder (used block-scoped `frames` instead of `this.frames`)
- Fixed: GIF decoder `readSubBlocks` infinite loop on truncated/corrupt GIF files
- Fixed: LZW decoder infinite loop on corrupt GIF data — added pixel count and data bounds guards
- Fixed: `goToFrame` crash when called with empty frames array
- Fixed: Playback not stopped before destructive frame operations (delete/duplicate/reorder/reverse/export) — prevented state corruption
- Fixed: Playback crash when frames deleted mid-animation — added length guard in `playNextFrame`
- Fixed: Stale frame selections not cleared when loading a new GIF file
- Fixed: Autosave `saveSession` crash when canvas.toBlob returns null — added null guard
- Fixed: Crop using fractional coordinates causing blurry output — now rounds to integer pixels
- Fixed: `handleResizeInput` divide-by-zero when no file loaded

### Accessibility & visual quality
- Fixed: `--text-muted` color failed WCAG AA contrast — lightened from #71717a to #8b8b94 (~5.3:1 ratio)
- Fixed: Disabled `.tool-btn` and `.btn-secondary` had no visual distinction — added opacity + cursor styles
- Fixed: Playback mode buttons (Normal/Ping-pong/Boomerang) had no active visual state — added accent highlight
- Fixed: No `:active` press feedback on any button — added scale transforms
- Fixed: `prefers-reduced-motion` only covered 3 elements — now disables all animations/transitions globally
- Fixed: Duplicate `.sidebar-overlay` CSS rules inside mobile media query — removed redundant copy
- Fixed: `.drop-icon` used hardcoded 20px radius — changed to `var(--radius-lg)` token
- Fixed: `.btn-danger` used bare `white` instead of design token

### Responsive
- Fixed: Canvas toolbar overflowed on mobile — added flex-wrap
- Fixed: Timeline header overflowed on narrow screens — added flex-wrap + gap
- Fixed: Canvas container 40px padding wasted space on mobile — reduced to 16px
- Fixed: Touch targets too small on mobile — added min-height 40px for buttons
- Fixed: Sidebar could overflow narrow viewports — added max-width 85vw

## [v0.3.0] - 2026-06-15

- Fixed: File input now resets after import — same file can be re-imported consecutively
- Fixed: Web Share API is now opt-in via a Share button instead of auto-triggering after every export
- Fixed: README "Effects" claim now accurately says "Transforms" to match actual features
- Added: Filter effects — brightness, contrast, saturation, hue-rotate with live preview and apply-to-all
- Added: Frame Inspector panel showing internal GIF structure per frame (dimensions, offsets, delays, disposal, palette size, transparency)
- Added: Image sequence import — drag-drop or select multiple JPG/PNG/WebP files to create a GIF from scratch
- Improved: Timeline uses IntersectionObserver for lazy thumbnail rendering — only visible frames are drawn, DocumentFragment for batch DOM insertion
- Added: GIF optimization via gifsicle-wasm — lossy LZW compression with O1/O2/O3 levels, loaded on demand from CDN

## [v0.2.0] - 2026-06-15

- Changed: Replace gif.js and gifuct-js CDN dependencies with self-contained inline GIF decoder and encoder — zero external scripts, works offline
- Added: GIF input validation — reject >8192×8192, warn on >4096×4096 and >500 frames
- Fixed: Safari canvas memory leak — explicitly release canvas elements when replacing them
- Added: Blob URL cleanup helper for memory management
- Added: Export cancel button with encoder abort support
- Added: Custom export filename (defaults to original name + "-edited")
- Added: prefers-reduced-motion CSS — disables UI animations for users with motion sensitivity
- Added: Loading spinner during GIF parse
- Added: Floyd-Steinberg dithering in the new self-contained encoder
- Added: ARIA roles for screen reader support (canvas, timeline, modal, toast, sidebar)
- Added: Keyboard delete confirmation — requires double-press within 2 seconds
- Added: File size estimation in export panel with Discord/Slack/Twitter badges
- Added: Escape key closes export modal
- Added: Mobile sidebar drawer with hamburger menu toggle
- Added: Multi-frame selection — Shift+click for range, Ctrl+click to toggle
- Added: Frame delta encoding on export — only encode changed regions for smaller files (superseded by the full-frame gifenc encoder in v0.4.0)
- Added: Content Security Policy meta tag blocking remote scripts
- Added: Color count control (16-256) in export settings
- Added: Web Share API integration for one-tap sharing on supported devices
- Added: File System Access API for direct-to-disk export on Chromium browsers

## [v0.1.0] - %Y->- (HEAD -> main, origin/main, origin/HEAD)

- Added: Add comprehensive README
- Added: Add files via upload

## Roadmap archive — 2026-08-10 — ROADMAP.md

<details>
<summary>Original roadmap snapshot</summary>

```markdown
# ROADMAP

Backlog for GifStudio — single-file browser GIF editor. Stays 100% client-side, no backend.

## Research-Driven Additions

### P0

### P1

### P2

- [ ] P2 — Repair PWA colors and install icon coverage
  Why: The manifest still carries pre-redesign colors and only one 256-pixel `purpose: "any"` icon, weakening installability and installed-app presentation.
  Evidence: `manifest.json`; `src/index.template.html`; Web App Manifest; MDN installable-PWA and app-color guidance.
  Touches: `manifest.json`; `src/index.template.html`; existing icons/assets; release checks.
  Acceptance: Manifest and HTML theme colors match the current token palette; 192- and 512-pixel `any` and `maskable` icons pass manifest validation; an installed-app smoke check confirms icon, splash/background, name, start URL, and offline launch.
  Complexity: M

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
```

</details>
