import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const BASIC_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
const pageRuntimeErrors = new WeakMap();

function gifFile(name = 'pixel.gif') {
  return { name, mimeType: 'image/gif', buffer: BASIC_GIF };
}

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (const value of buffer) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function parseStoredZip(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const expectedCrc = buffer.readUInt32LE(offset + 14);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const data = buffer.subarray(dataStart, dataStart + size);
    entries.push({
      name: buffer.subarray(nameStart, nameStart + nameLength).toString('utf8'),
      data,
      expectedCrc
    });
    offset = dataStart + size;
  }
  return entries;
}

async function readRecoveryEntries(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('GifStudioSession', 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const transaction = db.transaction('session');
      const store = transaction.objectStore('session');
      const keysRequest = store.getAllKeys();
      const valuesRequest = store.getAll();
      const [keys, values] = await Promise.all([
        new Promise((resolve, reject) => {
          keysRequest.onsuccess = () => resolve(keysRequest.result);
          keysRequest.onerror = () => reject(keysRequest.error);
        }),
        new Promise((resolve, reject) => {
          valuesRequest.onsuccess = () => resolve(valuesRequest.result);
          valuesRequest.onerror = () => reject(valuesRequest.error);
        })
      ]);
      return keys.map((key, index) => ({ key, record: values[index] }));
    } finally {
      db.close();
    }
  });
}

async function readRecoveryRecord(page) {
  const entries = await readRecoveryEntries(page);
  return entries
    .map(entry => entry.record)
    .sort((a, b) => (b?.savedAt || 0) - (a?.savedAt || 0))[0];
}

async function expandSidebarSection(page, sectionId) {
  const toggle = page.locator(`#${sectionId}Toggle`);
  if (await toggle.getAttribute('aria-expanded') !== 'true') {
    await toggle.click();
  }
}

test.beforeEach(async ({ page }) => {
  const errors = [];
  pageRuntimeErrors.set(page, errors);
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: undefined
    });
  });
  await page.goto('/');
});

test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.editor?.disposeRuntime()).catch(() => {});
});

test('shipped page boots without console or uncaught errors', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Drop a GIF or image sequence' })).toBeVisible();
  expect(pageRuntimeErrors.get(page)).toEqual([]);
});

test('loaded projects remove the import surface from focus and accessibility navigation', async ({ page }) => {
  const dropZone = page.locator('#dropZone');
  const chooseFiles = page.locator('#chooseFilesBtn');

  await expect(dropZone).not.toHaveAttribute('aria-hidden');
  await expect(dropZone).not.toHaveAttribute('inert');
  await chooseFiles.focus();
  await expect(chooseFiles).toBeFocused();

  await page.locator('#fileInput').setInputFiles(gifFile('focus.gif'));
  await expect(dropZone).toHaveAttribute('aria-hidden', 'true');
  await expect(dropZone).toHaveAttribute('inert', '');
  await expect(page.getByRole('button', { name: 'Choose files' })).toHaveCount(0);
  expect(await page.evaluate(() => {
    const button = document.getElementById('chooseFilesBtn');
    button.focus();
    return document.activeElement === button;
  })).toBe(false);

  await page.evaluate(() => editor.setDropZoneActive(true));
  await expect(dropZone).not.toHaveAttribute('aria-hidden');
  await expect(dropZone).not.toHaveAttribute('inert');
  await chooseFiles.focus();
  await expect(chooseFiles).toBeFocused();
});

test('diagnostics copy capability state and sanitized errors without media identifiers', async ({ page }) => {
  await page.locator('#fileInput').setInputFiles(gifFile('private-source.gif'));
  await expect(page.locator('#totalFrames')).toHaveText('1');
  await page.locator('#fileInput').setInputFiles({
    name: 'patient-secret.png',
    mimeType: 'image/png',
    buffer: Buffer.from('not a png')
  });
  await expect(page.locator('.toast.error')).toContainText('Failed to load patient-secret.png');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async text => {
          window.__copiedDiagnostics = text;
        }
      }
    });
  });

  await page.locator('#copyDiagnosticsBtn').click();
  await expect(page.locator('.toast.success').last()).toContainText('Diagnostics copied without media or filenames');
  const report = await page.evaluate(() => window.__copiedDiagnostics);

  expect(report).toContain('App version: 0.6.0');
  expect(report).toContain('Dimensions: 1x1');
  expect(report).toContain('Frame count: 1');
  expect(report).toContain('Selected format: GIF');
  expect(report).toContain('Capabilities and fallbacks');
  expect(report).toContain('Last error: application');
  expect(report).toContain('Failed to load [file]');
  expect(report).toContain('report excludes frame pixels');
  expect(report).not.toContain('patient-secret.png');
  expect(report).not.toContain('private-source.gif');
  expect(report).not.toContain(BASIC_GIF.toString('base64'));
});

test('sidebar sections expose persistent keyboard-operated disclosure state', async ({ page }) => {
  const diagnosticsToggle = page.getByRole('button', { name: 'Diagnostics', exact: true });
  await expect(diagnosticsToggle).toHaveAttribute('aria-controls', 'diagnosticsSectionPanel');
  await expect(diagnosticsToggle).toHaveAttribute('aria-expanded', 'true');
  await diagnosticsToggle.focus();
  await page.keyboard.press('Enter');
  await expect(diagnosticsToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#diagnosticsSectionPanel')).toBeHidden();

  await page.locator('#fileInput').setInputFiles(gifFile('accordion.gif'));
  const exportToggle = page.getByRole('button', { name: 'Export Settings' });
  await expect(exportToggle).toBeVisible();
  await expect(exportToggle).toHaveAttribute('aria-expanded', 'true');
  await exportToggle.focus();
  await page.keyboard.press('Enter');
  await expect(exportToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#exportSectionPanel')).toBeHidden();
  await expect(page.locator('#exportBtn')).toBeVisible();
  await expect(page.locator('#exportBtn')).toBeEnabled();

  await page.reload();
  await expect(page.getByRole('button', { name: 'Diagnostics', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#exportSectionToggle')).toHaveAttribute('aria-expanded', 'false');
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

test('memory override is shared by native and JavaScript GIF decode paths', async ({ page, browserName }) => {
  const nativeDecoderAvailable = await page.evaluate(() => typeof ImageDecoder !== 'undefined');
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
  await expect(page.locator('#analyzerContent')).toContainText('Raw GIF block metadata available');
  expect(await page.evaluate(() => editor.lastDecoderPath)).toBe(
    nativeDecoderAvailable ? 'native ImageDecoder' : 'strict JavaScript parser'
  );
  if (!nativeDecoderAvailable) {
    test.info().annotations.push({
      type: 'capability',
      description: `${browserName}: ImageDecoder unavailable; first import used the strict JavaScript fallback`
    });
  }

  await page.evaluate(() => {
    window.ImageDecoder = undefined;
  });
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#fileInput').setInputFiles(gifFile('fallback.gif'));

  await expect(page.locator('#analyzerContent')).toContainText('Raw GIF block metadata available');
  expect(await page.evaluate(() => editor.lastDecoderPath)).toBe('strict JavaScript parser');
  expect(await page.evaluate(() => editor.memoryTelemetry.overrideCount)).toBe(2);
});

test('edit and export memory ceilings stop work before cloning frames', async ({ page }) => {
  await page.locator('#fileInput').setInputFiles(gifFile());
  await expect(page.locator('#totalFrames')).toHaveText('1');
  await page.evaluate(() => {
    editor.getMemoryLimits = () => ({
      defaultBytes: 1,
      safeCeilingBytes: 1,
      deviceMemory: 1
    });
  });

  await page.evaluate(() => editor.duplicateFrame());
  await expect(page.locator('.toast.error')).toContainText('Duplicate frame stopped before allocation');
  await expect(page.locator('#totalFrames')).toHaveText('1');

  let downloads = 0;
  page.on('download', () => downloads++);
  await page.locator('#exportBtn').click();
  await expect(page.locator('.toast.error').last()).toContainText('Could not start export: GIF export stopped before allocation');
  expect(downloads).toBe(0);
});

test('history shares unchanged canvases and recovery encodes only dirty frames', async ({ page }) => {
  await page.evaluate(() => {
    window.ImageDecoder = undefined;
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    window.__pngSerializations = 0;
    HTMLCanvasElement.prototype.toBlob = function(callback, type, quality) {
      if (!type || type === 'image/png') window.__pngSerializations++;
      return originalToBlob.call(this, callback, type, quality);
    };
  });

  const files = Array.from({ length: 100 }, (_, index) => gifFile(`shared-${index + 1}.gif`));
  await page.locator('#fileInput').setInputFiles(files);
  await expect(page.locator('#totalFrames')).toHaveText('100');
  await expect.poll(() => page.evaluate(() => window.__pngSerializations)).toBe(100);
  await expect.poll(async () => (await readRecoveryRecord(page))?.frames.length).toBe(100);

  await page.evaluate(() => {
    window.__baselineCanvases = editor.frames.map(frame => frame.canvas);
    window.__pngSerializations = 0;
    editor.maxUndoBytes = 500;
  });
  await expandSidebarSection(page, 'timingSection');
  await page.locator('#frameDelay').fill('12');
  await page.locator('#applyDelayAll').click();
  await expect.poll(async () => (await readRecoveryRecord(page))?.frames[0].delay).toBe(120);
  expect(await page.evaluate(() => window.__pngSerializations)).toBe(0);
  expect(await page.evaluate(() =>
    editor.frames.every((frame, index) =>
      frame.canvas === window.__baselineCanvases[index] &&
      editor.undoStack[0].frames[index].canvas === frame.canvas
    )
  )).toBe(true);

  await page.evaluate(() => editor.duplicateFrame());
  await expect.poll(async () => (await readRecoveryRecord(page))?.frames.length).toBe(101);
  expect(await page.evaluate(() => window.__pngSerializations)).toBe(1);

  await page.evaluate(() => {
    editor.flipHorizontal();
    editor.flipHorizontal();
  });
  expect(await page.evaluate(() => ({
    levels: editor.undoStack.length,
    bytes: editor.estimateHistoryBytes(),
    limit: editor.maxUndoBytes
  }))).toEqual({ levels: 1, bytes: 404, limit: 500 });

  await page.evaluate(() => editor.undo());
  expect(await page.evaluate(() =>
    editor.frames.every(frame => frame.canvas.getContext('2d').getImageData(0, 0, 1, 1).data[3] === 255)
  )).toBe(true);
  await page.evaluate(() => editor.redo());
  expect(await page.evaluate(() =>
    editor.frames.every(frame => frame.canvas.getContext('2d').getImageData(0, 0, 1, 1).data[3] === 255)
  )).toBe(true);
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

test('platform guidance uses purpose-specific boundaries and final export bytes', async ({ page }) => {
  await page.locator('#fileInput').setInputFiles(gifFile());

  const boundaries = await page.evaluate(() => editor.getPlatformFitProfiles().map(profile => ({
    name: profile.name,
    exact: editor.evaluatePlatformFit(profile.maxBytes)
      .find(candidate => candidate.name === profile.name).fits,
    over: editor.evaluatePlatformFit(profile.maxBytes + 1)
      .find(candidate => candidate.name === profile.name).fits
  })));
  expect(boundaries).toEqual([
    { name: 'Discord message', exact: true, over: false },
    { name: 'Discord emoji', exact: true, over: false },
    { name: 'X web GIF', exact: true, over: false },
    { name: 'X mobile GIF', exact: true, over: false }
  ]);

  await expect(page.locator('#sizeEstimate')).toContainText('Estimated ~');
  await expect(page.locator('#platformBadges')).toContainText('Discord message (10 MiB)');
  await expect(page.locator('#platformBadges')).toContainText('Discord emoji (256 KiB)');
  await expect(page.locator('#platformBadges')).toContainText('X web GIF (15 MB)');
  await expect(page.locator('#platformBadges')).toContainText('X mobile GIF (5 MB)');
  await expect(page.getByText('Limits reviewed 2026-07-29')).toBeVisible();
  await expect(page.locator('#platformBadges')).not.toContainText('Slack');

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#exportBtn').click();
  const download = await downloadPromise;
  await download.path();
  await expect(page.locator('#sizeEstimate')).toContainText('Final ');
  const validationBytes = await page.evaluate(() => editor.lastOutputValidation.bytes);
  await expect(page.locator('#sizeEstimate')).toContainText(
    await page.evaluate(bytes => editor.formatBytes(bytes), validationBytes)
  );
});

test('optional ImageDecoder accepts a valid GIF when the engine exposes it', async ({ page, browserName }) => {
  const available = await page.evaluate(() => typeof ImageDecoder !== 'undefined');
  test.skip(!available, `${browserName}: ImageDecoder unavailable; strict JavaScript fallback remains covered`);

  const decoded = await page.evaluate(async encoded => {
    const binary = atob(encoded);
    const data = Uint8Array.from(binary, character => character.charCodeAt(0));
    const decoder = new ImageDecoder({ data, type: 'image/gif' });
    try {
      await decoder.tracks.ready;
      const result = await decoder.decode({ frameIndex: 0 });
      const shape = {
        width: result.image.displayWidth,
        height: result.image.displayHeight,
        frames: decoder.tracks.selectedTrack?.frameCount
      };
      result.image.close();
      return shape;
    } finally {
      decoder.close();
    }
  }, BASIC_GIF.toString('base64'));

  expect(decoded).toEqual({ width: 1, height: 1, frames: 1 });
});

test('full-frame GIF baseline preserves pixels, timing, size, and decoder compatibility', async ({ page, browserName }) => {
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
  if (benchmark.nativeFrameCount === null) {
    test.info().annotations.push({
      type: 'capability',
      description: `${browserName}: ImageDecoder unavailable; internal decoder pixel/timing contract verified`
    });
  } else {
    expect(benchmark.nativeFrameCount).toBe(3);
  }
  expect(benchmark.delays).toEqual([100, 100, 100]);
  expect(benchmark.descriptors).toEqual([
    { left: 0, top: 0, width: 16, height: 16 },
    { left: 0, top: 0, width: 16, height: 16 },
    { left: 0, top: 0, width: 16, height: 16 }
  ]);
});

test('GIF export rounds millisecond delays to centiseconds deterministically', async ({ page }) => {
  await page.locator('#fileInput').setInputFiles(gifFile());
  await expandSidebarSection(page, 'timingSection');
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
  await expect(page.locator('script[src="vendor/pako-3.0.1.min.js"]')).toHaveAttribute(
    'integrity',
    'sha256-thEzOhpy7FmIersTzNEDVCGfSY1fIRwACdXr1KNW3eg='
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

test('split-frame ZIP is valid, progress-driven, and basename-safe', async ({ page }) => {
  await page.locator('#fileInput').setInputFiles([gifFile('one.gif'), gifFile('two.gif')]);
  await page.evaluate(() => {
    editor.originalFilename = '..\\CON<>:unsafe/name';
  });

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#splitFramesBtn').click();
  const download = await downloadPromise;
  const bytes = await readFile(await download.path());
  const entries = parseStoredZip(bytes);

  expect(download.suggestedFilename()).toMatch(/^[^<>:"/\\|?*]+-frames\.zip$/);
  expect(entries).toHaveLength(2);
  for (const entry of entries) {
    expect(entry.name).toMatch(/^[^<>:"/\\|?*]+-frame-[12]\.png$/);
    expect(entry.data.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(crc32(entry.data)).toBe(entry.expectedCrc);
  }
  expect(bytes.includes(Buffer.from([0x50, 0x4B, 0x05, 0x06]))).toBe(true);
  await expect(page.locator('.toast.success').last()).toContainText('Exported 2 frames as PNG');
  await expect(page.locator('#exportModal')).toHaveAttribute('aria-hidden', 'true');
});

test('split-frame ZIP handles null PNG serialization and cancellation', async ({ page }) => {
  await page.locator('#fileInput').setInputFiles([gifFile('one.gif'), gifFile('two.gif')]);
  await page.evaluate(() => {
    HTMLCanvasElement.prototype.toBlob = function toBlob(callback) {
      callback(null);
    };
  });
  await page.locator('#splitFramesBtn').click();
  await expect(page.locator('.toast.error')).toContainText('Browser could not serialize frame 1 as PNG');
  await expect(page.locator('#exportBtn')).toBeEnabled();
  await expect(page.locator('#exportModal')).toHaveAttribute('aria-hidden', 'true');

  await page.reload();
  await page.locator('#fileInput').setInputFiles([gifFile('one.gif'), gifFile('two.gif')]);
  await page.evaluate(() => {
    HTMLCanvasElement.prototype.toBlob = function pendingToBlob() {
      window.__pendingPngSerialization = true;
    };
  });
  await page.locator('#splitFramesBtn').click();
  await expect(page.locator('#exportModal')).toHaveAttribute('aria-hidden', 'false');
  await expect.poll(() => page.evaluate(() => window.__pendingPngSerialization)).toBe(true);
  await page.locator('#cancelExportBtn').click();
  await expect(page.locator('.toast.warning')).toContainText('PNG split cancelled');
  await expect(page.locator('#exportBtn')).toBeEnabled();
  await expect(page.locator('#exportModal')).toHaveAttribute('aria-hidden', 'true');
});

test('split-frame ZIP preflight rejects oversized output before allocation', async ({ page }) => {
  await page.locator('#fileInput').setInputFiles(gifFile());
  await page.evaluate(() => {
    editor.estimateZipUpperBound = () => 513 * 1024 * 1024;
  });
  let downloads = 0;
  page.on('download', () => downloads++);

  await page.locator('#splitFramesBtn').click();

  await expect(page.locator('.toast.error')).toContainText('PNG split stopped before allocation');
  await expect(page.locator('#exportModal')).toHaveAttribute('aria-hidden', 'true');
  expect(downloads).toBe(0);
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

test('service worker caches the app shell for offline reload and exposes update UI', async ({ page, context, browserName }) => {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) {
    await page.reload();
  }
  const manifest = await page.evaluate(async () => (await fetch('./manifest.json')).json());
  expect(manifest.id).toBe('./index.html');
  expect(manifest.display).toBe('standalone');
  expect(manifest.background_color).toBe('#101311');
  expect(manifest.theme_color).toBe('#101311');
  expect(manifest.icons).toEqual(expect.arrayContaining([
    expect.objectContaining({ src: 'icons/icon-192.png', sizes: '192x192', purpose: 'any' }),
    expect.objectContaining({ src: 'icons/icon-512.png', sizes: '512x512', purpose: 'any' }),
    expect.objectContaining({ src: 'icons/icon-192-maskable.png', sizes: '192x192', purpose: 'maskable' }),
    expect.objectContaining({ src: 'icons/icon-512-maskable.png', sizes: '512x512', purpose: 'maskable' })
  ]));
  const cachedPaths = await page.evaluate(async () => {
    const cache = await caches.open('gifstudio-v0.6.0');
    return (await cache.keys()).map(request => new URL(request.url).pathname);
  });
  expect(cachedPaths).toEqual(expect.arrayContaining([
    '/index.html',
    '/manifest.json',
    '/icon.png',
    '/icons/icon-192.png',
    '/icons/icon-192-maskable.png',
    '/icons/icon-512.png',
    '/icons/icon-512-maskable.png',
    '/vendor/pako-3.0.1.min.js',
    '/vendor/upng-2.1.0.js',
    '/vendor/gifsicle-wasm-browser-1.5.19.min.js'
  ]));

  await context.setOffline(true);
  if (browserName === 'webkit') {
    test.info().annotations.push({
      type: 'capability',
      description: 'webkit: Playwright offline navigation reload is unavailable; cached shell verified through the active service worker'
    });
    const offlineShell = await page.evaluate(async () => {
      const cache = await caches.open('gifstudio-v0.6.0');
      const response = await cache.match('./index.html');
      return { ok: response.ok, text: await response.text() };
    });
    expect(offlineShell.ok).toBe(true);
    expect(offlineShell.text).toContain('<title>GifStudio');
  } else {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Drop a GIF or image sequence' })).toBeVisible();
  }
  await context.setOffline(false);

  await page.evaluate(() => {
    window.__gifStudioUpdateMessage = null;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'gifstudioUpdateAccepted') return;
      return setItem.call(this, key, value);
    };
    showUpdateNotice({
      waiting: {
        postMessage(message) {
          window.__gifStudioUpdateMessage = message;
        }
      }
    });
  });
  await expect(page.locator('#updateNotice')).toContainText('verified GifStudio update');
  if (browserName === 'webkit') {
    test.info().annotations.push({
      type: 'capability',
      description: 'webkit: first-controller activation may reload the harness before the synthetic waiting-worker message is observable'
    });
    return;
  }
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
  await expandSidebarSection(page, 'timingSection');
  await expandSidebarSection(page, 'speedSection');
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
  expect(record.appVersion).toBe('0.6.0');
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

test('recovery ownership isolates tabs and reclaims an abandoned lease', async ({ page, context }) => {
  await page.locator('#fileInput').setInputFiles(gifFile('first-tab.gif'));
  await expandSidebarSection(page, 'timingSection');
  await page.locator('#frameDelay').fill('11');
  await page.locator('#applyDelayAll').click();
  await page.waitForTimeout(2_500);

  const secondPage = await context.newPage();
  await secondPage.goto('/');
  await expect(secondPage.locator('.toast.warning')).toContainText(
    'Another GifStudio tab has an active recovery'
  );
  await secondPage.locator('#fileInput').setInputFiles(gifFile('second-tab.gif'));
  await expandSidebarSection(secondPage, 'timingSection');
  await secondPage.locator('#frameDelay').fill('23');
  await secondPage.locator('#applyDelayAll').click();
  await secondPage.waitForTimeout(2_500);

  let entries = await readRecoveryEntries(page);
  expect(entries).toHaveLength(2);
  expect(new Set(entries.map(entry => entry.record.ownerId)).size).toBe(2);
  expect(entries.map(entry => entry.record.frames[0].delay).sort((a, b) => a - b)).toEqual([110, 230]);

  const secondEntry = entries.find(entry => entry.record.frames[0].delay === 230);
  const staleDelete = await page.evaluate(
    ({ key, ownerId, savedAt }) => editor.clearSavedSession({
      key,
      expectedOwnerId: ownerId,
      expectedSavedAt: savedAt
    }),
    {
      key: secondEntry.key,
      ownerId: secondEntry.record.ownerId,
      savedAt: secondEntry.record.savedAt
    }
  );
  expect(staleDelete).toBe(false);
  expect(await readRecoveryEntries(page)).toHaveLength(2);

  await page.evaluate(() => editor.clearSavedSession());
  entries = await readRecoveryEntries(page);
  expect(entries).toHaveLength(1);
  expect(entries[0].record.frames[0].delay).toBe(230);

  await secondPage.close();
  await page.evaluate(async key => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('GifStudioSession', 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('session', 'readwrite');
      const store = tx.objectStore('session');
      const request = store.get(key);
      request.onsuccess = () => {
        const record = request.result;
        record.leaseExpiresAt = Date.now() - 1;
        store.put(record, key);
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, entries[0].key);

  const reclaimPage = await context.newPage();
  await reclaimPage.goto('/');
  await expect(reclaimPage.getByRole('region', { name: 'Saved session recovery' })).toBeVisible();
  await reclaimPage.getByRole('button', { name: 'Restore' }).click();
  await expect(reclaimPage.locator('#currentDelay')).toHaveText('230');
  await expect.poll(async () => (await readRecoveryEntries(reclaimPage)).length).toBe(1);
  await expect.poll(async () => {
    const [entry] = await readRecoveryEntries(reclaimPage);
    return entry.record.leaseExpiresAt - Date.now();
  }).toBeGreaterThan(10_000);
  const reclaimed = await readRecoveryEntries(reclaimPage);
  expect(reclaimed[0].record.frames[0].delay).toBe(230);
  await reclaimPage.close();
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
      const request = db.transaction('session').objectStore('session').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).then(records => records.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))[0]);
    delete existing.schemaVersion;
    delete existing.appVersion;
    delete existing.editorState;
    delete existing.sourceTiming;
    delete existing.ownerId;
    delete existing.leaseExpiresAt;
    await new Promise((resolve, reject) => {
      const tx = db.transaction('session', 'readwrite');
      const store = tx.objectStore('session');
      store.clear();
      store.put(existing, 'current');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });

  await page.reload();
  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(page.locator('#totalFrames')).toHaveText('1');
  await expect(page.locator('#timingSummary')).toContainText('Source (Migrated recovery)');
  await expect.poll(async () => {
    const entries = await readRecoveryEntries(page);
    return entries.length === 1 &&
      entries[0].key !== 'current' &&
      Boolean(entries[0].record.ownerId);
  }).toBe(true);

  await page.evaluate(() => {
    if (editor._recoveryLeaseTimer) clearInterval(editor._recoveryLeaseTimer);
    editor._recoveryLeaseTimer = null;
    if (editor._autosaveTimer) clearTimeout(editor._autosaveTimer);
    editor._autosaveTimer = null;
    editor._autosaveGeneration++;
    try { editor._autosaveTransaction?.abort(); } catch {}
  });
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('GifStudioSession', 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('session', 'readwrite');
      const store = tx.objectStore('session');
      store.clear();
      store.put({
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
  await page.evaluate(() => {
    const render = GifEncoder.prototype.render;
    GifEncoder.prototype.render = async function(...args) {
      await new Promise(resolve => setTimeout(resolve, 500));
      return render.apply(this, args);
    };
  });
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
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toMatch(
    /^(diagnosticsSectionToggle|gifInfoSectionToggle)$/
  );

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
