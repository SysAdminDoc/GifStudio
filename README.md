# GifStudio

![License](https://img.shields.io/badge/license-MIT-blue)
![Language](https://img.shields.io/badge/language-JavaScript-yellow)
![Type](https://img.shields.io/badge/type-Web%20App-brightgreen)

Browser-based GIF creation and editing studio. Create, edit, optimize, and export GIFs with frame manipulation, filters, and timing controls — 100% client-side, single HTML file, zero install.

**[Launch GifStudio](https://sysadmindoc.github.io/GifStudio/)**

## Features

### Import
- **GIF Import** — Open any GIF for editing with full frame extraction
- **Image Sequence** — Drag-drop or select multiple JPG, PNG, or WebP files to create a new GIF
- **Frame Inspector** — View internal GIF structure: per-frame dimensions, offsets, delays, disposal methods, palette sizes

### Edit
- **Frame Editor** — Add, remove, reorder, duplicate, and reverse frames
- **Multi-Select** — Shift+click for range selection, Ctrl/Cmd+click to toggle individual frames
- **Timing Control** — Set per-frame delay (10ms precision) and global playback speed
- **Transforms** — Resize, crop, flip horizontal/vertical, and rotate 90°
- **Filters** — Brightness, contrast, saturation, and hue-rotate with live canvas preview

### Export & Optimize
- **GIF Export** — Configurable quality, color count (16–256), Floyd-Steinberg dithering, loop control
- **GIF Optimization** — Lossy LZW compression via gifsicle-wasm (O1/O2/O3 levels, 27–75% size reduction)
- **Frame Delta Encoding** — Only encode changed regions for smaller output files
- **File Size Estimation** — Live estimated size with Discord, Slack, and Twitter limit badges
- **Custom Filename** — Defaults to original filename + "-edited"
- **Direct Save** — File System Access API for save-to-disk on Chromium; standard download elsewhere
- **Share** — Web Share API button for one-tap sharing on supported devices

### Privacy & Performance
- **100% Client-Side** — Nothing is uploaded. All processing happens in your browser.
- **Zero Install** — Single HTML file, no server, no build step
- **Inline Codecs** — Self-contained GIF decoder and encoder with no external dependencies
- **Lazy Thumbnails** — Timeline uses IntersectionObserver for smooth scrolling with large GIFs
- **Safari Memory Safety** — Explicit canvas cleanup prevents memory leaks on WebKit browsers

### Accessibility & Mobile
- **ARIA Support** — Screen reader roles on canvas, timeline, modal, toast, and sidebar
- **Keyboard Navigation** — Focus-visible outlines, proper label associations, Escape to close modals
- **Reduced Motion** — Respects `prefers-reduced-motion` for UI animations
- **Mobile Drawer** — Sidebar slides out on small screens via hamburger toggle
- **Dark Theme** — Professional dark interface with `color-scheme: dark` for native controls

## Usage

1. **[Open GifStudio in your browser](https://sysadmindoc.github.io/GifStudio/)** — or download `index.html` and open it locally
2. Drop a GIF to edit, or drop multiple images to create a new GIF
3. Edit frames, apply filters, adjust timing
4. Export or optimize and download

## License

MIT License
