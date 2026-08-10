import { expect, test } from '@playwright/test';

const BASIC_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');

function gifFile(name = 'visual.gif') {
  return { name, mimeType: 'image/gif', buffer: BASIC_GIF };
}

async function waitForFonts(page) {
  await page.evaluate(() => document.fonts.ready.then(() => true));
}

async function loadProject(page, name = 'visual.gif') {
  await page.locator('#fileInput').setInputFiles(gifFile(name));
  await expect(page.locator('#totalFrames')).toHaveText('1');
  await expect(page.locator('#dropZone')).toHaveAttribute('aria-hidden', 'true');
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: undefined
    });
  });
  await page.goto('/');
  await waitForFonts(page);
});

test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.editor?.disposeRuntime()).catch(() => {});
});

test('empty workspace visual contract', async ({ page }) => {
  await expect(page).toHaveScreenshot('empty-workspace.png');
});

test('loaded editor visual contract', async ({ page }) => {
  await loadProject(page);
  await expect(page).toHaveScreenshot('loaded-editor.png');
});

test('saved recovery visual contract', async ({ page }) => {
  await loadProject(page, 'recovery-visual.gif');
  await page.evaluate(async () => {
    if (editor._autosaveTimer) clearTimeout(editor._autosaveTimer);
    editor._autosaveTimer = null;
    await editor.saveSession(editor._autosaveGeneration);
  });
  await page.reload();
  await waitForFonts(page);
  await expect(page.getByRole('region', { name: 'Saved session recovery' })).toBeVisible();
  await expect(page).toHaveScreenshot('saved-recovery.png');
});

test('export modal visual contract', async ({ page }) => {
  await loadProject(page, 'export-visual.gif');
  await page.evaluate(() => {
    editor.openExportModal('Exporting GIF');
    document.getElementById('exportStatus').textContent = 'Encoding frame 1 of 1';
    document.getElementById('exportProgress').style.width = '64%';
  });
  await expect(page.locator('#exportModal')).toHaveClass(/active/);
  await expect(page).toHaveScreenshot('export-modal.png');
});

test('mobile drawer visual contract', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loadProject(page, 'mobile-visual.gif');
  await page.locator('#mobileMenuBtn').click();
  await expect(page.locator('#sidebar')).toHaveClass(/open/);
  await expect(page).toHaveScreenshot('mobile-drawer.png');
});
