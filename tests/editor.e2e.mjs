import { expect, test } from '@playwright/test';

const BASIC_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');

function gifFile(name = 'pixel.gif') {
  return { name, mimeType: 'image/gif', buffer: BASIC_GIF };
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
