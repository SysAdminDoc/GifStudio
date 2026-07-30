# GifStudio

![Version](https://img.shields.io/badge/version-v0.6.0-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Platform](https://img.shields.io/badge/platform-Browser-blueviolet)
![Language](https://img.shields.io/badge/language-JavaScript-yellow)
![Type](https://img.shields.io/badge/type-Web%20App-brightgreen)

Browser-based GIF creation and editing studio. Create, edit, optimize, and export GIFs with frame manipulation, filters, and timing controls — 100% client-side and zero install.

**[Launch GifStudio](https://sysadmindoc.github.io/GifStudio/)**

## Features

### Import
- **GIF Import** — Extract and edit GIFs within the documented dimension, frame-count, and decoded-memory limits
- **Image Sequence** — Drag-drop or select multiple JPG, PNG, or WebP files to create a new GIF
- **Frame Inspector** — View decoded dimensions/timing for every source, raw block details when the JS GIF parser is used, memory estimates, and validated output summaries

### Edit
- **Frame Editor** — Add, remove, reorder, duplicate, and reverse frames with copy-on-write, byte-budgeted undo/redo
- **Multi-Select** — Shift+click for range selection, Ctrl/Cmd+click to toggle individual frames
- **Timing Control** — Edit GIF delays in centiseconds or APNG delays in milliseconds, with encoded duration and FPS diagnostics
- **Playback Modes** — Normal, Ping-pong, and Boomerang playback
- **Transforms** — Resize, crop, canvas expand (padding), flip horizontal/vertical, and rotate 90°
- **Resize Presets** — Discord Emoji, Telegram Sticker, Twitter/X, Full HD, and more
- **Filters** — Brightness, contrast, saturation, and hue-rotate with live canvas preview
- **Redaction** — Pixelate, blur, or black-fill regions across selected frames
- **Background Layer** — Burn a solid color or image behind all frames

### Export & Optimize
- **GIF Export** — gifenc PNN quantizer, quality, Floyd-Steinberg dithering, configurable color count (16–256), loop control
- **APNG Export** — Millisecond timing, alpha support, and optional palette reduction through the bundled UPNG.js codec
- **GIF Optimization** — Lossy LZW compression via gifsicle-wasm (O1/O2/O3 levels)
- **Split Frames** — Export all frames as numbered PNGs in a ZIP archive
- **File Size Estimation** — Live estimated size with Discord, Slack, and Twitter limit badges
- **Custom Filename** — Defaults to original filename + "-edited"
- **Direct Save** — File System Access API for save-to-disk on Chromium; standard download elsewhere
- **Share** — Web Share API button for one-tap sharing on supported devices

### Privacy & Performance
- **100% Client-Side** — Nothing is uploaded. All processing happens in your browser.
- **Zero Install** — The core GIF editor runs from `index.html`; the repository and hosted PWA include local optional APNG/optimization assets.
- **Inline Codecs** — Self-contained GIF decoder + gifenc PNN encoder with no external dependencies
- **Offline PWA** — When served over HTTP(S), the service worker caches the app shell and optional codecs, reports update readiness, and falls back to the cache when offline
- **Native Decoding** — Uses the browser `ImageDecoder` API when available and the same-budget JavaScript parser everywhere else
- **Lazy Thumbnails** — Timeline uses IntersectionObserver + CSS content-visibility for smooth scrolling
- **Safari Memory Safety** — Explicit canvas cleanup prevents memory leaks on WebKit browsers
- **Vendored Fonts** — All fonts inlined as base64 woff2; zero external requests
- **Local Diagnostics** — Copy app/capability/fallback, memory, export-profile, and sanitized error text without frames, filenames, URLs, user-agent data, or telemetry

### Accessibility & Mobile
- **ARIA Support** — Screen reader roles on canvas, timeline, modal, toast, and sidebar; hidden import controls become inert while a project is loaded
- **Keyboard Navigation** — Focus-visible outlines, proper label associations, Escape to close modals
- **Reduced Motion** — Respects `prefers-reduced-motion` for UI animations
- **Mobile Drawer** — Sidebar slides out on small screens via hamburger toggle
- **Dark Theme** — Professional dark interface with `color-scheme: dark` for native controls

## Capabilities and Limits

| Area | Verified behavior |
|---|---|
| Processing and privacy | Frames, recovery data, and exports stay in the browser. GifStudio has no backend or telemetry. |
| Core GIF editing | Works from a local `index.html`. APNG export, optimization, installability, updates, and complete offline use require the repository/hosted app so the vendored assets and service worker are present. |
| Offline behavior | After one successful HTTP(S) load, the service worker caches `index.html`, the manifest, icon, and all optional codecs. A local `file://` page cannot register that service worker. |
| Decoder fallback | `ImageDecoder` is preferred when the browser exposes it; malformed/unsupported native decodes fall back to the strict JavaScript parser. Both paths enforce 8192×8192, 500-frame, and 256 MiB decoded-frame limits. |
| Memory guard | Import, restore, edits, autosave, and export estimate unique resident canvases and temporary RGBA buffers before allocation. Undo/redo shares unchanged canvases and is capped at one quarter of the device-aware budget. The default peak budget is 256 MiB on devices reporting ≤2 GiB, 384 MiB at ≤4 GiB, and 512 MiB otherwise. A deliberate one-operation override is offered only below the device-aware ceiling, never above 1 GiB. |
| Timing | GIF controls and output use centiseconds; values are rounded deterministically to 10 ms units. APNG controls and output use milliseconds. Source, edited, and encoded durations are shown separately. |
| Output validation | GIF/APNG downloads and success messages occur only after structural, dimension, frame-control, and encoded-timing checks pass. |
| Split-frame ZIP | PNG splitting uses the shared progress/cancel flow, checks serialization and CRCs, and stops before allocation above 500 entries or a 512 MiB estimated/actual ZIP. Output basenames are normalized for cross-platform filesystems. |
| Browser APIs | Direct Save uses the File System Access API when present and downloads otherwise. Share appears only when the Web Share API accepts files. |
| Recovery | Versioned IndexedDB sessions are isolated per browser tab and retained for up to seven days or until dismissed. Autosave reuses cached PNG data for unchanged canvases, superseded saves are aborted, stale tabs cannot delete active records, abandoned sessions can be reclaimed, and storage failures advise exporting before leaving the tab. |
| Diagnostics | The sidebar report identifies decoder/save/share/clipboard/service-worker/storage/codec fallbacks and the last sanitized error. It contains project dimensions/count but excludes media, filenames, URLs, user-agent data, and telemetry. |

GIF export intentionally uses full-canvas frame descriptors. The older v0.2.0 changed-region encoder was superseded by gifenc in v0.4.0 because safe local-frame encoding needs look-ahead disposal handling for opaque-to-transparent transitions. The bundled optimizer remains the supported size-reduction path.

## Usage

1. **[Open GifStudio in your browser](https://sysadmindoc.github.io/GifStudio/)** — or download `index.html` for core GIF editing; clone/download the repository to use optional codecs locally
2. Drop a GIF to edit, or drop multiple images to create a new GIF
3. Edit frames, apply filters, adjust timing
4. Export or optimize and download

## Development and Release Checks

```powershell
npm ci
npx playwright install chromium
npm run build:artifact
npm test
npm run lint
npm run build
```

JavaScript source is maintained in three boundaries:

- `src/gif-decoder.js` — strict GIF parser/decompressor, loaded directly by Node unit tests
- `src/gif-encoder.js` — bundled gifenc core and the GifStudio encoder wrapper
- `src/app.js` — editor state, storage, operations, exporters, and UI behavior

`src/index.template.html` owns the document/CSS shell. `npm run build:artifact` normalizes line endings and embeds those boundaries to generate the zero-install `index.html`; do not hand-edit the generated scripts. `npm run check:artifact` fails on any byte drift, and `.gitattributes` pins text files to LF so a clean checkout reproduces the same artifact across platforms.

`npm test` first checks artifact reproducibility, then runs strict parser fixtures directly against `src/gif-decoder.js` and Playwright against the shipped `index.html`. The static release check parses both source and embedded scripts and also verifies version consistency, CSP, manifest/icon references, service-worker registration, vendored codec hashes/SRI, and the README badge. CI runs the same commands on every push and pull request.

## License

MIT License

Bundled optional codecs retain their upstream licenses: pako 2.1.0 (MIT and Zlib), UPNG.js 2.1.0 (MIT), and gifsicle-wasm-browser 1.5.19 (MIT). Exact source hashes and license texts are under `vendor/`.
