import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const BASIC_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');

function gifFile(name = 'pixel.gif') {
  return { name, mimeType: 'image/gif', buffer: BASIC_GIF };
}

async function readRecoveryRecord(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('GifStudioSession', 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction('session').objectStore('session').get('current');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: undefined
    });
  });
  await page.goto('/');
});

test('shipped page boots without console or uncaught errors', async ({ page }) => {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', error => errors.push(error.message));

  await page.reload({ waitUntil: 'networkidle' });

  expect(errors).toEqual([]);
  await expect(page.getByRole('heading', { name: 'Drop files here' })).toBeVisible();
});

test('failed replacement import preserves the active project', async ({ page }) => {
  const input = page.locator('#fileInput');
  await input.setInputFiles(gifFile());
  await expect(page.locator('#totalFrames')).toHaveText('1');
  await expect(page.locator('#infoDimensions')).toHaveText('1×1');

  await input.setInputFiles({
    name: 'truncated.gif',
    mimeType: 'image/gif',
    buffer: BASIC_GIF.subarray(0, BASIC_GIF.length - 2)
  });

  await expect(page.locator('.toast.error')).toContainText(/Failed to load GIF|Invalid GIF/);
  await expect(page.locator('#totalFrames')).toHaveText('1');
  await expect(page.locator('#infoDimensions')).toHaveText('1×1');
  await expect(page.locator('#exportBtn')).toBeEnabled();
});

test('memory budget cancellation preserves the active project before allocation', async ({ page }) => {
  const input = page.locator('#fileInput');
  await input.setInputFiles(gifFile('active.gif'));
  await expect(page.locator('#totalFrames')).toHaveText('1');
  await page.evaluate(() => {
    editor.getMemoryLimits = () => ({
      defaultBytes: 1,
      safeCeilingBytes: 1024,
      deviceMemory: 1
    });
  });

  page.once('dialog', dialog => dialog.dismiss());
  await input.setInputFiles(gifFile('replacement.gif'));

  await expect(page.locator('.toast.error')).toContainText('GIF import cancelled before allocation');
  await expect(page.locator('#totalFrames')).toHaveText('1');
  await expect(page.locator('#exportFilename')).toHaveValue('active-edited');
});

test('memory override is shared by native and JavaScript GIF decode paths', async ({ page }) => {
  await page.evaluate(() => {
    editor.getMemoryLimits = () => ({
      defaultBytes: 1,
      safeCeilingBytes: 1024,
      deviceMemory: 1
    });
  });

  page.once('dialog', dialog => dialog.accept());
  await page.locator('#fileInput').setInputFiles(gifFile('native.gif'));
  await expect(page.locator('#analyzerContent')).toContainText('user override accepted');
  await expect(page.locator('#analyzerContent')).toContainText('Raw GIF block metadata unavailable');

  await page.evaluate(() => {
    window.ImageDecoder = undefined;
  });
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#fileInput').setInputFiles(gifFile('fallback.gif'));

  await expect(page.locator('#analyzerContent')).toContainText('Raw GIF block metadata available');
  expect(await page.evaluate(() => editor.memoryTelemetry.overrideCount)).toBe(2);
});

test('edit and export memory ceilings stop work before cloning frames', async ({ page }) => {
  await page.locator('#fileInput').setInputFiles(gifFile());
  await page.evaluate(() => {
    editor.getMemoryLimits = () => ({
      defaultBytes: 1,
      safeCeilingBytes: 1,
      deviceMemory: 1
    });
  });

  await page.locator('#duplicateFrame').click();
  await expect(page.locator('.toast.error')).toContainText('Duplicate frame stopped before allocation');
  await expect(page.locator('#totalFrames')).toHaveText('1');

  let downloads = 0;
  page.on('download', () => downloads++);
  await page.locator('#exportBtn').click();
  await expect(page.locator('.toast.error').last()).toContainText('Could not start export: GIF export stopped before allocation');
  expect(downloads).toBe(0);
});

test('GIF export emits a valid signature from the shipped page', async ({ page }) => {
  await page.locator('#fileInput').setInputFiles(gifFile());
  await expect(page.locator('#exportBtn')).toBeEnabled();

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#exportBtn').click();
  const download = await downloadPromise;
  const path = await download.path();
  const bytes = await import('node:fs/promises').then(fs => fs.readFile(path));

  expect(bytes.subarray(0, 6).toString('ascii')).toBe('GIF89a');
  await expect(page.locator('#exportModal')).not.toHaveClass(/active/);
  await expect(page.locator('#exportBtn')).toBeEnabled();
  await expect(page.locator('#analyzerContent')).toContainText('Validated GIF output · 1×1 · 1 frame');
});

test('full-frame GIF baseline preserves pixels, timing, size, and decoder compatibility', async ({ page }) => {
  const benchmark = await page.evaluate(async () => {
    const width = 16;
    const height = 16;
    const sources = [];
    const encoder = new GifEncoder(width, height, {
      quality: 1,
      dither: false,
      repeat: 0,
      maxColors: 16
    });

    for (const [x, y] of [[1, 1], [6, 1], [6, 6]]) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.fillStyle = '#000';
      context.fillRect(0, 0, width, height);
      context.fillStyle = '#f00';
      context.fillRect(x, y, 4, 4);
      sources.push(new Uint8Array(context.getImageData(0, 0, width, height).data));
      encoder.addFrame(canvas, 100);
    }

    const blob = await encoder.render();
    const buffer = await blob.arrayBuffer();
    const parsed = GifDecoder.parseGIF(buffer);
    const decoded = GifDecoder.decompressFrames(parsed, true);
    let maxChannelDiff = 0;
    decoded.forEach((frame, frameIndex) => {
      frame.patch.forEach((value, index) => {
        maxChannelDiff = Math.max(maxChannelDiff, Math.abs(value - sources[frameIndex][index]));
      });
    });

    let nativeFrameCount = null;
    if (typeof ImageDecoder !== 'undefined') {
      const nativeDecoder = new ImageDecoder({ data: buffer, type: 'image/gif' });
      await nativeDecoder.tracks.ready;
      nativeFrameCount = nativeDecoder.tracks.selectedTrack?.frameCount ?? null;
      for (let frameIndex = 0; frameIndex < nativeFrameCount; frameIndex++) {
        const result = await nativeDecoder.decode({ frameIndex, completeFramesOnly: true });
        result.image.close();
      }
      nativeDecoder.close();
    }

    return {
      bytes: blob.size,
      maxChannelDiff,
      nativeFrameCount,
      delays: parsed.frames.map(frame => (frame.graphicControl?.delay || 0) * 10),
      descriptors: parsed.frames.map(frame => ({
        left: frame.left,
        top: frame.top,
        width: frame.width,
        height: frame.height
      }))
    };
  });

  expect(benchmark.bytes).toBeLessThan(1200);
  expect(benchmark.maxChannelDiff).toBe(0);
  expect(benchmark.nativeFrameCount).toBe(3);
  expect(benchmark.delays).toEqual([100, 100, 100]);
  expect(benchmark.descriptors).toEqual([
    { left: 0, top: 0, width: 16, height: 16 },
    { left: 0, top: 0, width: 16, height: 16 },
    { left: 0, top: 0, width: 16, height: 16 }
  ]);
});

test('GIF export rounds millisecond delays to centiseconds deterministically', async ({ page }) => {
  await page.locator('#fileInput').setInputFiles(gifFile());
  await page.locator('#exportFormat').selectOption('apng');
  await page.locator('#frameDelay').fill('15');
  await page.locator('#applyDelayAll').click();
  await page.locator('#exportFormat').selectOption('gif');
  await expect(page.locator('#frameDelayLabel')).toHaveText('Delay (centiseconds)');
  await expect(page.locator('#timingSummary')).toContainText('selected 2 cs (50.00 FPS)');
  await expect(page.locator('#timingWarning')).toContainText('rounds 15ms → 20ms');

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#exportBtn').click();
  const download = await downloadPromise;
  const bytes = await readFile(await download.path());
  const gce = bytes.indexOf(Buffer.from([0x21, 0xF9, 0x04]));

  expect(gce).toBeGreaterThanOrEqual(0);
  expect(bytes.readUInt16LE(gce + 4)).toBe(2);
});

test('APNG export emits PNG and animation control signatures', async ({ page }) => {
  await page.locator('#fileInput').setInputFiles([
    gifFile('first.gif'),
    gifFile('second.gif')
  ]);
  await page.locator('#exportFormat').selectOption('apng');

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#exportBtn').click();
  const download = await downloadPromise;
  const bytes = await readFile(await download.path());

  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(bytes.includes(Buffer.from('acTL', 'ascii'))).toBe(true);
  await expect(page.locator('#analyzerContent')).toContainText('Image sequence · decoded frames');
  await expect(page.locator('#analyzerContent')).toContainText('Raw GIF block metadata unavailable');
  await expect(page.locator('#analyzerContent')).toContainText('Validated APNG output · 1×1 · 2 frames');
  await expect(page.locator('script[src="vendor/pako-2.1.0.min.js"]')).toHaveAttribute(
    'integrity',
    'sha256-7eJpOkpqUSa501ZpBis1jsq2rnubhqHPMC/rRahRSQc='
  );
  await expect(page.locator('script[src="vendor/upng-2.1.0.js"]')).toHaveAttribute(
    'integrity',
    'sha256-aXU5RmOscgzQUVIsdzzmpU41GPc3rl8v3kmD9fz7U+U='
  );
  await expect(page.locator('#exportModal')).not.toHaveClass(/active/);
});

test('invalid encoded output is rejected before download or success', async ({ page }) => {
  await page.locator('#fileInput').setInputFiles(gifFile());
  await page.evaluate(() => {
    GifEncoder.prototype.render = async () => new Blob(['not-a-gif'], { type: 'image/gif' });
  });
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.locator('#exportBtn').click();

  await expect(page.locator('.toast.error')).toContainText('Output validation failed');
  await expect(page.locator('#exportModal')).toHaveAttribute('aria-hidden', 'true');
  expect(downloads).toBe(0);
  await expect(page.locator('#analyzerContent')).toContainText('No exported output has been validated');
});

test('optional codecs make no cross-origin runtime requests', async ({ page }) => {
  const externalRequests = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:18766') externalRequests.push(url.href);
  });
  await page.reload();
  await page.locator('#fileInput').setInputFiles([gifFile('one.gif'), gifFile('two.gif')]);
  await page.locator('#exportFormat').selectOption('apng');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#exportBtn').click();
  await downloadPromise;

  expect(externalRequests).toEqual([]);
});

test('missing optional assets fail safely without disabling core GIF export', async ({ page }) => {
  await page.evaluate(async () => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map(registration => registration.unregister()));
    const names = await caches.keys();
    await Promise.all(names.map(name => caches.delete(name)));
  });
  await page.addInitScript(() => {
    navigator.serviceWorker.register = () => Promise.reject(new Error('Service worker disabled for fallback test'));
  });
  await page.route('**/vendor/upng-2.1.0.js', route => route.abort());
  await page.reload();
  await page.locator('#fileInput').setInputFiles(gifFile());
  await page.locator('#exportFormat').selectOption('apng');
  await page.locator('#exportBtn').click();
  await expect(page.locator('.toast.error')).toContainText('Bundled upng asset is unavailable');
  await expect(page.locator('#exportBtn')).toBeEnabled();

  await page.locator('#exportFormat').selectOption('gif');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#exportBtn').click();
  const download = await downloadPromise;
  const bytes = await readFile(await download.path());
  expect(bytes.subarray(0, 6).toString('ascii')).toBe('GIF89a');
});

test('service worker caches the app shell for offline reload and exposes update UI', async ({ page, context }) => {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) {
    await page.reload();
  }
  const cachedPaths = await page.evaluate(async () => {
    const cache = await caches.open('gifstudio-v0.5.2');
    return (await cache.keys()).map(request => new URL(request.url).pathname);
  });
  expect(cachedPaths).toEqual(expect.arrayContaining([
    '/index.html',
    '/manifest.json',
    '/icon.png',
    '/vendor/pako-2.1.0.min.js',
    '/vendor/upng-2.1.0.js',
    '/vendor/gifsicle-wasm-browser-1.5.19.min.js'
  ]));

  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Drop files here' })).toBeVisible();
  await context.setOffline(false);

  await page.evaluate(() => {
    window.__gifStudioUpdateMessage = null;
    showUpdateNotice({
      waiting: {
        postMessage(message) {
          window.__gifStudioUpdateMessage = message;
        }
      }
    });
  });
  await expect(page.locator('#updateNotice')).toContainText('verified GifStudio update');
  await page.locator('#updateNotice').getByRole('button', { name: 'Reload' }).click();
  await expect.poll(() => page.evaluate(() => window.__gifStudioUpdateMessage)).toEqual({
    type: 'GIFSTUDIO_SKIP_WAITING'
  });
});

test('cancelling export ignores late work and restores editor controls', async ({ page }) => {
  const files = Array.from({ length: 40 }, (_, index) => gifFile(`frame-${index + 1}.gif`));
  await page.locator('#fileInput').setInputFiles(files);
  await expect(page.locator('#totalFrames')).toHaveText('40');

  await page.locator('#exportBtn').click();
  await expect(page.locator('#exportModal')).toHaveClass(/active/);
  await page.locator('#cancelExportBtn').click();

  await expect(page.locator('.toast.warning')).toContainText('Export cancelled');
  await expect(page.locator('#exportModal')).not.toHaveClass(/active/);
  await expect(page.locator('#exportBtn')).toBeEnabled();
  await expect(page.locator('#totalFrames')).toHaveText('40');
  await expect.poll(() => page.evaluate(() => editor.lastExportProfile)).toMatchObject({
    kind: 'GIF export',
    cancelled: true
  });
});

test('autosave recovery restores frame state after reload', async ({ page }) => {
  await page.locator('#fileInput').setInputFiles(gifFile('recovery.gif'));
  await page.locator('#exportFormat').selectOption('apng');
  await page.locator('#frameDelay').fill('110');
  await page.locator('#applyDelayAll').click();
  await page.locator('#frameDelay').fill('230');
  await page.locator('#applyDelayAll').click();
  await page.locator('#exportFilename').fill('recover-me');
  await page.locator('#speedSlider').fill('1.5');
  await page.waitForTimeout(2_500);

  const record = await readRecoveryRecord(page);
  expect(record.schemaVersion).toBe(2);
  expect(record.appVersion).toBe('0.5.2');
  expect(record.frames[0].delay).toBe(230);
  expect(record.editorState.exportFormat).toBe('apng');
  expect(record.editorState.exportFilename).toBe('recover-me');
  expect(record.editorState.playbackSpeed).toBe(1.5);

  await page.reload();
  await expect(page.getByRole('region', { name: 'Saved session recovery' })).toBeVisible();
  await page.getByRole('button', { name: 'Restore' }).click();

  await expect(page.locator('#totalFrames')).toHaveText('1');
  await expect(page.locator('#currentDelay')).toHaveText('230');
  await expect(page.locator('#exportFormat')).toHaveValue('apng');
  await expect(page.locator('#exportFilename')).toHaveValue('recover-me');
  await expect(page.locator('#speedDisplay')).toHaveText('1.5x');
  await expect(page.locator('#exportBtn')).toBeEnabled();
  await expect(page.locator('#exportBtn')).toBeFocused();
});

test('legacy recovery records migrate and corrupt records are removed', async ({ page }) => {
  await page.locator('#fileInput').setInputFiles(gifFile('legacy.gif'));
  await page.waitForTimeout(2_500);
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('GifStudioSession', 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const existing = await new Promise((resolve, reject) => {
      const request = db.transaction('session').objectStore('session').get('current');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    delete existing.schemaVersion;
    delete existing.appVersion;
    delete existing.editorState;
    delete existing.sourceTiming;
    await new Promise((resolve, reject) => {
      const tx = db.transaction('session', 'readwrite');
      tx.objectStore('session').put(existing, 'current');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });

  await page.reload();
  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(page.locator('#totalFrames')).toHaveText('1');
  await expect(page.locator('#timingSummary')).toContainText('Source (Migrated recovery)');

  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('GifStudioSession', 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('session', 'readwrite');
      tx.objectStore('session').put({
        schemaVersion: 2,
        width: 1,
        height: 1,
        frames: [{ png: null, delay: 100 }],
        savedAt: Date.now()
      }, 'current');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload();
  await expect(page.locator('.toast.error')).toContainText('Saved recovery was invalid and has been removed');
  await expect(page.locator('#recoveryBanner')).toHaveCount(0);
  await expect.poll(() => readRecoveryRecord(page)).toBeUndefined();
});

test('timeline keyboard navigation and confirmed deletion update frame state', async ({ page }) => {
  await page.locator('#fileInput').setInputFiles([
    gifFile('one.gif'),
    gifFile('two.gif'),
    gifFile('three.gif')
  ]);
  const firstFrame = page.locator('.frame-item').first();
  await expect(firstFrame).toHaveAttribute('aria-posinset', '1');
  await expect(firstFrame).toHaveAttribute('aria-setsize', '3');
  await expect(firstFrame.locator('.frame-delete')).toHaveAttribute('aria-label', 'Delete frame 1');
  await firstFrame.focus();
  await firstFrame.press('End');
  await expect(page.locator('#currentFrameNum')).toHaveText('3');
  await expect(page.locator('#frame-option-2')).toBeFocused();
  await page.locator('#frame-option-2').press('Home');
  await expect(page.locator('#currentFrameNum')).toHaveText('1');
  await expect(page.locator('#frame-option-0')).toBeFocused();
  await page.locator('#frame-option-0').press('ArrowRight');
  await expect(page.locator('#currentFrameNum')).toHaveText('2');
  await expect(page.locator('#framesContainer')).toHaveAttribute('aria-activedescendant', 'frame-option-1');

  await page.locator('.frame-item.selected').press('Delete');
  await page.locator('.frame-item.selected').press('Delete');
  await expect(page.locator('#totalFrames')).toHaveText('2');
});

test('export modal traps focus, cancels with Escape, and returns focus', async ({ page }) => {
  const files = Array.from({ length: 20 }, (_, index) => gifFile(`modal-${index + 1}.gif`));
  await page.locator('#fileInput').setInputFiles(files);
  const exportButton = page.locator('#exportBtn');
  await exportButton.focus();
  await exportButton.click();

  await expect(page.locator('#exportModal')).toHaveAttribute('aria-hidden', 'false');
  await expect(page.locator('#cancelExportBtn')).toBeFocused();
  await page.locator('#cancelExportBtn').press('Tab');
  await expect(page.locator('#cancelExportBtn')).toBeFocused();
  await page.keyboard.press('Escape');

  await expect(page.locator('#exportModal')).toHaveAttribute('aria-hidden', 'true');
  await expect(exportButton).toBeFocused();
});

test('mobile drawer reports state, restores focus, and fits 390px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const menu = page.locator('#mobileMenuBtn');
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#sidebar')).toHaveClass(/open/);
  await expect(page.locator('#sidebar')).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(menu).toBeFocused();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('playback and reduced-motion timeline updates never smooth-scroll', async ({ page }) => {
  await page.locator('#fileInput').setInputFiles([
    gifFile('motion-one.gif'),
    gifFile('motion-two.gif'),
    gifFile('motion-three.gif')
  ]);
  await page.evaluate(() => {
    window.__scrollBehaviors = [];
    Element.prototype.scrollIntoView = function scrollIntoView(options) {
      window.__scrollBehaviors.push(options?.behavior || 'auto');
    };
  });
  await page.locator('#playPause').click();
  await page.waitForTimeout(250);
  await page.locator('#playPause').click();
  expect(await page.evaluate(() => window.__scrollBehaviors)).not.toContain('smooth');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => {
    window.__scrollBehaviors = [];
  });
  await page.locator('.frame-item.selected').press('ArrowRight');
  expect(await page.evaluate(() => window.__scrollBehaviors)).toEqual(['auto']);
});

test('multi-frame export stays within the release performance budget', async ({ page }) => {
  test.setTimeout(30_000);
  const files = Array.from({ length: 24 }, (_, index) => {
    const hue = (index * 47) % 360;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="hsl(${hue} 80% 50%)"/></svg>`;
    return {
      name: `perf-${index + 1}.svg`,
      mimeType: 'image/svg+xml',
      buffer: Buffer.from(svg)
    };
  });
  await page.locator('#fileInput').setInputFiles(files);
  await expect(page.locator('#totalFrames')).toHaveText('24');

  const startedAt = Date.now();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#exportBtn').click();
  await downloadPromise;
  const elapsedMs = Date.now() - startedAt;
  const profile = await page.evaluate(() => editor.lastExportProfile);

  expect(elapsedMs).toBeLessThan(20_000);
  expect(profile.durationMs).toBeLessThan(15_000);
  expect(profile.maxFrameBlockMs).toBeLessThan(1_500);
  expect(profile.cancelled).toBe(false);
});
