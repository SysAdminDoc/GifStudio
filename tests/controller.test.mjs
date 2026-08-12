import assert from 'node:assert/strict';
import test from 'node:test';
import { ExportController } from '../src/export-controller.js';
import { HistoryController } from '../src/history-controller.js';
import { RecoveryController, migrateRecoverySession } from '../src/recovery-controller.js';

function fakeCanvas(width = 2, height = 2) {
  return { width, height };
}

test('history controller retains snapshots and restores through injected state callbacks', () => {
  let frames = [{ canvas: fakeCanvas(), delay: 100, disposalType: 0 }];
  let state = { currentFrame: 0, originalWidth: 2, originalHeight: 2, cropRect: { x: 0, y: 0, w: 2, h: 2 } };
  const released = [];
  const toasts = [];
  const history = new HistoryController({
    getFrames: () => frames,
    setFrames: value => { frames = value; },
    readState: () => ({ ...state, cropRect: { ...state.cropRect } }),
    applyState: snapshot => {
      state = {
        currentFrame: snapshot.currentFrame,
        originalWidth: snapshot.originalWidth,
        originalHeight: snapshot.originalHeight,
        cropRect: { ...snapshot.cropRect }
      };
    },
    retainCanvas: canvas => canvas,
    releaseFrames: value => released.push(...(value || []).map(frame => frame.canvas)),
    prepareMutation: () => true,
    getMaxBytes: () => 1024 * 1024,
    showToast: message => toasts.push(message)
  });

  history.save('paint');
  const editedCanvas = fakeCanvas();
  frames = [{ canvas: editedCanvas, delay: 250, disposalType: 1 }];
  assert.equal(history.undo(), true);
  assert.equal(frames[0].delay, 100);
  assert.equal(history.redoStack.length, 1);
  assert.equal(history.redo(), true);
  assert.equal(frames[0].canvas, editedCanvas);
  assert.deepEqual(toasts, ['Undo: paint', 'Redo']);
  assert.ok(released.includes(editedCanvas));
});

test('history controller trims oldest snapshots against the injected byte budget', () => {
  let frames = [{ canvas: fakeCanvas(4, 4), delay: 100, disposalType: 0 }];
  const history = new HistoryController({
    getFrames: () => frames,
    setFrames: value => { frames = value; },
    readState: () => ({ currentFrame: 0, originalWidth: 4, originalHeight: 4, cropRect: { x: 0, y: 0, w: 4, h: 4 } }),
    applyState: () => {},
    retainCanvas: canvas => canvas,
    releaseFrames: () => {},
    prepareMutation: () => true,
    getMaxBytes: () => 64
  });

  history.save('first');
  frames = [{ canvas: fakeCanvas(4, 4), delay: 200, disposalType: 0 }];
  history.save('second');
  assert.equal(history.estimateBytes(), 64);
  assert.deepEqual(history.undoStack.map(snapshot => snapshot.label), ['second']);
});

test('export controller owns cancellation, progress, and cleanup lifecycle', async () => {
  const sourceCanvas = fakeCanvas();
  const released = [];
  let locked = [];
  let now = 10;
  let currentEncoder = { abort: () => { currentEncoder.aborted = true; } };
  const controller = new ExportController({
    getFrames: () => [{ canvas: sourceCanvas, delay: 100, disposalType: 0 }],
    getDimensions: () => ({ width: 2, height: 2 }),
    getProjectGeneration: () => 4,
    getActiveOperation: () => null,
    showToast: () => {},
    stopPlayback: () => {},
    preflightMemory: () => ({ estimatedPeakBytes: 32 }),
    cloneFrame: frame => ({ ...frame, canvas: fakeCanvas() }),
    releaseFrames: frames => released.push(...frames),
    setControlsLocked: value => locked.push(value),
    getCurrentEncoder: () => currentEncoder,
    now: () => now
  });

  const job = controller.begin('GIF export', 3, null);
  assert.equal(job.width, 2);
  assert.equal(controller.isCurrent(job), true);
  controller.updateProgress(job, 40, 'Encoding', { style: {} }, { textContent: '' });
  assert.equal(job.progress, 40);
  controller.cancel('test cancellation');
  assert.equal(job.cancelled, true);
  assert.equal(currentEncoder.aborted, true);
  await assert.rejects(controller.waitForTask(job, new Promise(() => {})), /test cancellation/);

  now = 20;
  controller.finish(job);
  assert.deepEqual(locked, [true, false]);
  assert.equal(released.length, 1);
  assert.equal(controller.activeJob, null);
});

test('recovery migration validates records and fills legacy editor state', () => {
  const migrated = migrateRecoverySession({
    schemaVersion: 1,
    width: 2,
    height: 2,
    filename: 'legacy',
    currentFrame: 0,
    frames: [{ png: new Uint8Array([1]).buffer, delay: 120 }]
  }, {
    schemaVersion: 2,
    appVersion: 'test',
    validateBudget: () => {}
  });
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.appVersion, 'test');
  assert.equal(migrated.editorState.exportFilename, 'legacy-edited');
  assert.deepEqual(migrated.sourceTiming.delays, [120]);
  assert.throws(() => migrateRecoverySession({
    schemaVersion: 2,
    width: 2,
    height: 2,
    frames: [{ png: new Uint8Array([1]).buffer, delay: 0 }]
  }, {
    schemaVersion: 2,
    appVersion: 'test',
    validateBudget: () => {}
  }), /invalid delay/);
});

function fakeDatabase(records) {
  return {
    transaction() {
      const tx = { error: null, oncomplete: null, onerror: null, onabort: null };
      const store = {
        put(value, key) {
          records.set(key, value);
          queueMicrotask(() => tx.oncomplete?.());
        },
        get(key) {
          const request = { result: records.get(key), onsuccess: null, onerror: null };
          queueMicrotask(() => request.onsuccess?.());
          return request;
        },
        delete(key) {
          records.delete(key);
          queueMicrotask(() => tx.oncomplete?.());
        }
      };
      tx.objectStore = () => store;
      tx.abort = () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        tx.error = error;
        tx.onabort?.();
      };
      return tx;
    },
    close() {}
  };
}

test('recovery controller autosaves and clears through injected database boundaries', async () => {
  const records = new Map();
  const canvas = fakeCanvas();
  const saved = [];
  let frames = [{ canvas, delay: 100, disposalType: 0 }];
  let retained = 0;
  let released = 0;
  const controller = new RecoveryController({
    schemaVersion: 2,
    appVersion: 'test',
    leaseMs: 30_000,
    getContext: () => ({ key: 'session:test', ownerId: 'owner', ownerEpoch: 0 }),
    getFrames: () => frames,
    getDimensions: () => ({ width: 2, height: 2 }),
    getFilename: () => 'demo',
    getSourceTiming: () => ({ format: 'GIF', delays: [100] }),
    retainCanvas: value => { retained++; return value; },
    releaseFrames: value => { released += value.length; },
    captureEditorState: () => ({ currentFrame: 0 }),
    preflightMemory: () => {},
    openDB: async () => fakeDatabase(records),
    validateBudget: () => {},
    serializeCanvas: async () => new Uint8Array([1, 2, 3]).buffer,
    decodeFrame: async () => fakeCanvas(),
    beginOperation: () => ({ cancelled: false }),
    assertOperationCurrent: () => {},
    finishOperation: () => {},
    commitProject: () => {},
    restoreEditorState: () => {},
    onSaved: session => saved.push(session)
  });
  controller.generation = 1;
  assert.equal(await controller.save(1), true);
  assert.equal(records.get('session:test').frames.length, 1);
  assert.equal(saved.length, 1);
  assert.equal(retained, 1);
  assert.equal(released, 1);
  assert.equal(await controller.clear({ key: 'session:test', expectedOwnerId: 'owner' }), true);
  assert.equal(records.has('session:test'), false);
});
