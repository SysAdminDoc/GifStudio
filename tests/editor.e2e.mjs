import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const BASIC_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
const PAKO_PATH = resolve('node_modules/pako/dist/pako.min.js');
const UPNG_PATH = resolve('node_modules/upng-js/UPNG.js');

function gifFile(name = 'pixel.gif') {
  return { name, mimeType: 'image/gif', buffer: BASIC_GIF };
}

test.beforeEach(async ({ page }) => {
  await page.route('https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js', async route => {
    await route.fulfill({
      contentType: 'text/javascript',
      body: await readFile(PAKO_PATH)
    });
  });
  await page.route('https://cdn.jsdelivr.net/npm/upng-js@2.1.0/UPNG.min.js', async route => {
    await route.fulfill({
      contentType: 'text/javascript',
      body: await readFile(UPNG_PATH)
    });
  });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: undefined
    });
  });
  await page.goto('/');
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
});

test('GIF export rounds millisecond delays to centiseconds deterministically', async ({ page }) => {
  await page.locator('#fileInput').setInputFiles(gifFile());
  await page.locator('#frameDelay').fill('15');
  await page.locator('#applyDelayAll').click();

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
  await expect(page.locator('#exportModal')).not.toHaveClass(/active/);
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
  await page.locator('#frameDelay').fill('230');
  await page.locator('#applyDelayAll').click();
  await page.waitForTimeout(2_500);

  await page.reload();
  await expect(page.getByText(/Recover previous session/)).toBeVisible();
  await page.getByRole('button', { name: 'Restore' }).click();

  await expect(page.locator('#totalFrames')).toHaveText('1');
  await expect(page.locator('#currentDelay')).toHaveText('230');
  await expect(page.locator('#exportBtn')).toBeEnabled();
});

test('timeline keyboard navigation and confirmed deletion update frame state', async ({ page }) => {
  await page.locator('#fileInput').setInputFiles([
    gifFile('one.gif'),
    gifFile('two.gif'),
    gifFile('three.gif')
  ]);
  const firstFrame = page.locator('.frame-item').first();
  await firstFrame.focus();
  await firstFrame.press('ArrowRight');
  await expect(page.locator('#currentFrameNum')).toHaveText('2');

  await page.locator('.frame-item.selected').press('Delete');
  await page.locator('.frame-item.selected').press('Delete');
  await expect(page.locator('#totalFrames')).toHaveText('2');
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
