export function migrateRecoverySession(record, {
  schemaVersion,
  appVersion,
  validateBudget
}) {
  const invalid = (message, name = 'DataError') => {
    const error = new Error(message);
    error.name = name;
    throw error;
  };
  if (!record || typeof record !== 'object') {
    invalid('Recovery record is not an object');
  }
  const version = record.schemaVersion || 1;
  if (version > schemaVersion) {
    invalid('Recovery schema ' + version + ' requires a newer GifStudio', 'VersionError');
  }
  if (!Array.isArray(record.frames) || record.frames.length === 0) {
    invalid('Recovery record has no frames');
  }
  try {
    validateBudget(record.width, record.height, record.frames.length);
  } catch (error) {
    invalid(error.message);
  }
  record.frames.forEach((frame, index) => {
    const validPng = frame?.png instanceof ArrayBuffer || ArrayBuffer.isView(frame?.png);
    if (!validPng) invalid('Recovery frame ' + (index + 1) + ' has no PNG data');
    if (!Number.isFinite(frame.delay) || frame.delay < 1) {
      invalid('Recovery frame ' + (index + 1) + ' has an invalid delay');
    }
  });

  if (version === 1) {
    return {
      ...record,
      schemaVersion,
      appVersion,
      sourceTiming: {
        format: 'Migrated recovery',
        delays: record.frames.map(frame => frame.delay)
      },
      editorState: {
        currentFrame: record.currentFrame || 0,
        exportFilename: (record.filename || 'recovered') + '-edited',
        exportFormat: 'gif',
        playbackSpeed: 1,
        playbackMode: 'normal'
      }
    };
  }
  if (record.sourceTiming && (
    typeof record.sourceTiming.format !== 'string' ||
    !Array.isArray(record.sourceTiming.delays) ||
    record.sourceTiming.delays.some(delay => !Number.isFinite(delay) || delay < 1)
  )) {
    invalid('Recovery source timing is invalid');
  }
  return record;
}

export class RecoveryController {
  constructor({
    schemaVersion,
    appVersion,
    leaseMs,
    getContext,
    getFrames,
    getDimensions,
    getFilename,
    getSourceTiming,
    retainCanvas,
    releaseFrames,
    captureEditorState,
    preflightMemory,
    openDB,
    validateBudget,
    serializeCanvas,
    decodeFrame,
    beginOperation,
    assertOperationCurrent,
    finishOperation,
    commitProject,
    restoreEditorState,
    showToast = () => {},
    reportStorageError = () => {},
    onSaved = () => {},
    onMemoryWarning = () => {},
    onStaleDelete = () => {},
    now = () => Date.now(),
    setTimeoutFn = (...args) => globalThis.setTimeout(...args),
    clearTimeoutFn = (...args) => globalThis.clearTimeout(...args),
    autosaveDelay = 2000
  }) {
    this.schemaVersion = schemaVersion;
    this.appVersion = appVersion;
    this.leaseMs = leaseMs;
    this.getContext = getContext;
    this.getFrames = getFrames;
    this.getDimensions = getDimensions;
    this.getFilename = getFilename;
    this.getSourceTiming = getSourceTiming;
    this.retainCanvas = retainCanvas;
    this.releaseFrames = releaseFrames;
    this.captureEditorState = captureEditorState;
    this.preflightMemory = preflightMemory;
    this.openDB = openDB;
    this.validateBudget = validateBudget;
    this.serializeCanvas = serializeCanvas || (async canvas => {
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('Browser could not serialize a recovery frame');
      return blob.arrayBuffer();
    });
    this.decodeFrame = decodeFrame;
    this.beginOperation = beginOperation;
    this.assertOperationCurrent = assertOperationCurrent;
    this.finishOperation = finishOperation;
    this.commitProject = commitProject;
    this.restoreEditorState = restoreEditorState;
    this.showToast = showToast;
    this.reportStorageError = reportStorageError;
    this.onSaved = onSaved;
    this.onMemoryWarning = onMemoryWarning;
    this.onStaleDelete = onStaleDelete;
    this.now = now;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.autosaveDelay = autosaveDelay;
    this.generation = 0;
    this.transaction = null;
    this.timer = null;
    this.lastSavedGeneration = 0;
    this.pngCache = new WeakMap();
    this.memoryWarningShown = false;
  }

  get context() {
    return this.getContext();
  }

  isCurrent(generation, ownerEpoch) {
    return generation === this.generation && this.context.ownerEpoch === ownerEpoch;
  }

  schedule() {
    this.generation++;
    const generation = this.generation;
    if (this.transaction) {
      try { this.transaction.abort(); } catch {}
    }
    if (this.timer) this.clearTimeoutFn(this.timer);
    this.timer = this.setTimeoutFn(() => this.save(generation), this.autosaveDelay);
    return generation;
  }

  dispose() {
    if (this.timer) this.clearTimeoutFn(this.timer);
    this.timer = null;
    this.generation++;
    try { this.transaction?.abort(); } catch {}
    this.transaction = null;
  }

  async save(generation = this.generation) {
    const frames = this.getFrames();
    if (frames.length === 0 || generation !== this.generation) return false;
    const context = this.context;
    const dimensions = this.getDimensions();
    try {
      this.preflightMemory('Recovery autosave', {
        width: dimensions.width,
        height: dimensions.height,
        frameCount: frames.length,
        temporaryCopies: 1
      }, { allowOverride: false });
      this.memoryWarningShown = false;
    } catch (error) {
      if (!this.memoryWarningShown) {
        this.memoryWarningShown = true;
        this.onMemoryWarning(error);
      }
      return false;
    }

    const snapshot = {
      frames: frames.map(frame => ({
        canvas: this.retainCanvas(frame.canvas),
        delay: frame.delay,
        disposalType: frame.disposalType
      })),
      width: dimensions.width,
      height: dimensions.height,
      filename: this.getFilename(),
      sourceTiming: this.getSourceTiming()
        ? {
            format: this.getSourceTiming().format,
            delays: [...this.getSourceTiming().delays]
          }
        : null,
      editorState: this.captureEditorState()
    };
    let db;
    let tx;
    try {
      db = await this.openDB();
      if (!this.isCurrent(generation, context.ownerEpoch)) return false;
      const frameData = [];
      for (const frame of snapshot.frames) {
        let buffer = this.pngCache.get(frame.canvas);
        if (!buffer) {
          buffer = await this.serializeCanvas(frame.canvas);
          if (!this.isCurrent(generation, context.ownerEpoch)) return false;
          this.pngCache.set(frame.canvas, buffer);
        }
        frameData.push({
          png: buffer,
          delay: frame.delay,
          disposalType: frame.disposalType
        });
      }
      if (!this.isCurrent(generation, context.ownerEpoch)) return false;
      const session = {
        schemaVersion: this.schemaVersion,
        appVersion: this.appVersion,
        generation,
        ownerId: context.ownerId,
        leaseExpiresAt: this.now() + this.leaseMs,
        frames: frameData,
        width: snapshot.width,
        height: snapshot.height,
        filename: snapshot.filename,
        sourceTiming: snapshot.sourceTiming,
        editorState: snapshot.editorState,
        savedAt: this.now()
      };
      tx = db.transaction('session', 'readwrite');
      this.transaction = tx;
      if (!this.isCurrent(generation, context.ownerEpoch)) {
        tx.abort();
        return false;
      }
      tx.objectStore('session').put(session, context.key);
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => {
          const error = tx.error || new Error('Autosave superseded');
          error.name = 'AbortError';
          reject(error);
        };
      });
      if (generation === this.generation) {
        this.lastSavedGeneration = generation;
        this.onSaved(session);
      }
      return true;
    } catch (error) {
      if (generation === this.generation && error?.name !== 'AbortError') {
        this.reportStorageError('Autosave failed', error);
      }
      return false;
    } finally {
      if (this.transaction === tx) this.transaction = null;
      if (db) db.close();
      this.releaseFrames(snapshot.frames);
    }
  }

  migrate(record) {
    return migrateRecoverySession(record, {
      schemaVersion: this.schemaVersion,
      appVersion: this.appVersion,
      validateBudget: this.validateBudget
    });
  }

  async restore(session, recoveryKey) {
    const token = this.beginOperation('Session restore');
    if (!token) return false;
    const restoredFrames = [];
    let committed = false;
    try {
      this.validateBudget(session.width, session.height, session.frames?.length || 0);
      this.preflightMemory('Session restore', {
        width: session.width,
        height: session.height,
        frameCount: session.frames.length,
        temporaryCopies: 1
      });
      for (const frameData of session.frames) {
        this.assertOperationCurrent(token);
        const canvas = await this.decodeFrame(frameData.png, session.width, session.height);
        this.assertOperationCurrent(token);
        restoredFrames.push({
          canvas,
          delay: frameData.delay,
          disposalType: frameData.disposalType || 0
        });
      }
      this.commitProject({
        frames: restoredFrames,
        width: session.width,
        height: session.height,
        currentFrame: session.editorState?.currentFrame,
        filename: session.filename || 'recovered',
        rawGifMeta: null,
        sourceTiming: session.sourceTiming,
        sourceFormat: 'Recovered session',
        exportFilename: (session.filename || 'recovered') + '-edited'
      }, token);
      committed = true;
      this.restoreEditorState(session.editorState);
      this.showToast('Restored ' + restoredFrames.length + ' frames', 'success');
      return true;
    } catch (error) {
      if (!committed) this.releaseFrames(restoredFrames);
      if (error.name !== 'AbortError') {
        console.error('Session restore failed:', error);
        this.showToast('Recovery failed: ' + error.message, 'error');
        if (error.name !== 'MemoryBudgetError') {
          await this.clear({
            key: recoveryKey,
            expectedOwnerId: session.ownerId || null,
            expectedSavedAt: session.savedAt,
            reportErrors: false
          });
        }
      }
      return false;
    } finally {
      this.finishOperation(token);
    }
  }

  async clear({
    key = this.context.key,
    expectedOwnerId = key === this.context.key ? this.context.ownerId : undefined,
    expectedSavedAt,
    reportErrors = true
  } = {}) {
    let db;
    try {
      db = await this.openDB();
      const tx = db.transaction('session', 'readwrite');
      const store = tx.objectStore('session');
      const request = store.get(key);
      let deleted = false;
      request.onsuccess = () => {
        const record = request.result;
        if (!record) return;
        const ownerChanged = expectedOwnerId !== undefined &&
          (record.ownerId || null) !== expectedOwnerId;
        const recordChanged = expectedSavedAt !== undefined &&
          record.savedAt !== expectedSavedAt;
        const activeOtherOwner =
          key !== this.context.key &&
          record.ownerId &&
          record.ownerId !== this.context.ownerId &&
          record.leaseExpiresAt > this.now();
        if (ownerChanged || recordChanged || activeOtherOwner) {
          this.onStaleDelete();
          return;
        }
        store.delete(key);
        deleted = true;
      };
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Recovery delete aborted'));
      });
      if (!deleted && request.result) this.showToast('Recovery changed in another tab and was kept.', 'warning');
      return deleted;
    } catch (error) {
      if (reportErrors) this.reportStorageError('Could not clear recovery', error);
      return false;
    } finally {
      if (db) db.close();
    }
  }
}
