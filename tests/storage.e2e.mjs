import { expect, test } from '@playwright/test';

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
      const transaction = db.transaction('session');
      const request = transaction.objectStore('session').getAll();
      const records = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return records.sort((a, b) => (b?.savedAt || 0) - (a?.savedAt || 0))[0];
    } finally {
      db.close();
    }
  });
}

async function saveCurrentSession(page) {
  await page.evaluate(async () => {
    if (editor._autosaveTimer) clearTimeout(editor._autosaveTimer);
    editor._autosaveTimer = null;
    await editor.saveSession(editor._autosaveGeneration);
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

test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.editor?.disposeRuntime()).catch(() => {});
});

test('reports quota and grants a user-requested persistent-storage upgrade', async ({ page }) => {
  await page.evaluate(async () => {
    window.__storagePersisted = false;
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        estimate: async () => ({ usage: 1024 * 1024, quota: 10 * 1024 * 1024 }),
        persisted: async () => window.__storagePersisted,
        persist: async () => {
          window.__storagePersisted = true;
          return true;
        }
      }
    });
    await editor.refreshStorageStatus();
  });

  await expect(page.locator('#storageDurabilityStatus')).toHaveText('1 MB of 10 MB used · best effort');
  await expect(page.locator('#requestPersistenceBtn')).toBeVisible();
  await page.locator('#requestPersistenceBtn').click();
  await expect(page.locator('.toast.success')).toContainText('Persistent recovery storage granted');
  await expect(page.locator('#storageDurabilityStatus')).toHaveText('1 MB of 10 MB used · persistent');
  await expect(page.locator('#requestPersistenceBtn')).toBeDisabled();

  const report = await page.evaluate(() => editor.buildDiagnosticsReport());
  expect(report).toContain('Storage usage: 1048576 of 10485760 bytes');
  expect(report).toContain('Storage persistence: granted');
});

test('continues best-effort autosave when persistence is denied', async ({ page }) => {
  await page.evaluate(async () => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        estimate: async () => ({}),
        persisted: async () => false,
        persist: async () => false
      }
    });
    await editor.refreshStorageStatus();
  });

  await page.locator('#requestPersistenceBtn').click();
  await expect(page.locator('.toast.warning')).toContainText('autosave continues with best-effort recovery');

  await page.evaluate(() => {
    window.ImageDecoder = undefined;
  });
  await page.locator('#fileInput').setInputFiles(gifFile('best-effort.gif'));
  await expect(page.locator('#totalFrames')).toHaveText('1');
  await saveCurrentSession(page);
  await expect.poll(async () => (await readRecoveryRecord(page))?.filename).toBe('best-effort');
});

test('retains the last committed recovery when a quota write fails', async ({ page }) => {
  await page.evaluate(() => {
    window.ImageDecoder = undefined;
  });
  await page.locator('#fileInput').setInputFiles(gifFile('quota.gif'));
  await expect(page.locator('#totalFrames')).toHaveText('1');
  await saveCurrentSession(page);
  await expect.poll(async () => (await readRecoveryRecord(page))?.frames[0].delay).toBe(100);

  await page.evaluate(async () => {
    if (editor._recoveryLeaseTimer) clearInterval(editor._recoveryLeaseTimer);
    editor._recoveryLeaseTimer = null;
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function quotaPut(...args) {
      if (this.name === 'session') {
        throw new DOMException('Synthetic quota limit', 'QuotaExceededError');
      }
      return originalPut.apply(this, args);
    };
    try {
      editor.frames[0].delay = 230;
      editor.scheduleAutosave();
      if (editor._autosaveTimer) clearTimeout(editor._autosaveTimer);
      editor._autosaveTimer = null;
      await editor.saveSession(editor._autosaveGeneration);
    } finally {
      IDBObjectStore.prototype.put = originalPut;
    }
  });

  await expect(page.locator('.toast.error')).toContainText('previous recovery was retained');
  expect((await readRecoveryRecord(page)).frames[0].delay).toBe(100);
});
