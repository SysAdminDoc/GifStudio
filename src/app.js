        // ============================================
        // GIF Studio Pro - Main Application
        // ============================================

        const APP_VERSION = '0.6.0';
        const SESSION_SCHEMA_VERSION = 2;
        const RECOVERY_LEASE_MS = 30_000;
        const RECOVERY_HEARTBEAT_MS = 10_000;
        const RECOVERY_KEY_PREFIX = 'session:';
        const SIDEBAR_STATE_KEY = 'gifstudioSidebarSectionsV1';
        const MEBIBYTE = 1024 * 1024;
        const MEMORY_LIMITS = Object.freeze({
            lowDeviceDefault: 256 * MEBIBYTE,
            mediumDeviceDefault: 384 * MEBIBYTE,
            standardDefault: 512 * MEBIBYTE,
            absoluteCeiling: 1024 * MEBIBYTE
        });
        const ZIP_LIMITS = Object.freeze({
            maxEntries: 500,
            maxArchiveBytes: 512 * MEBIBYTE,
            copyChunkBytes: 4 * MEBIBYTE
        });
        const OPTIONAL_ASSETS = Object.freeze({
            pako: {
                src: 'vendor/pako-2.1.0.min.js',
                integrity: 'sha256-7eJpOkpqUSa501ZpBis1jsq2rnubhqHPMC/rRahRSQc=',
                global: 'pako'
            },
            upng: {
                src: 'vendor/upng-2.1.0.js',
                integrity: 'sha256-aXU5RmOscgzQUVIsdzzmpU41GPc3rl8v3kmD9fz7U+U=',
                global: 'UPNG'
            },
            gifsicle: {
                src: 'vendor/gifsicle-wasm-browser-1.5.19.min.js',
                integrity: 'sha256-wrnvGs08ogoHlf7GZJaiTsYAH1ODYRPAJVvURkZiqc0=',
                global: 'gifsicle'
            }
        });

        class GIFEditor {
            constructor() {
                // State
                this.frames = [];
                this.currentFrame = 0;
                this.isPlaying = false;
                this.playInterval = null;
                this.playbackSpeed = 1;
                this.playbackMode = 'normal'; // normal, pingpong, boomerang
                this.playDirection = 1; // 1 = forward, -1 = backward
                this.zoom = 1;
                this.originalWidth = 0;
                this.originalHeight = 0;
                this.fileSize = 0;
                this.activeTool = 'select';
                this.originalFilename = 'edited';
                this.currentEncoder = null;
                this._loadInProgress = false;
                this._autosaveGeneration = 0;
                this._autosaveTransaction = null;
                this._lastSavedGeneration = 0;
                this._storageErrorShown = false;
                this.storageStatus = 'checking';
                this.storageTelemetry = {
                    usage: null,
                    quota: null,
                    persisted: null,
                    persistenceSupported: false
                };
                this.recoveryCoordinationStatus = 'initializing';
                this._recoveryInstanceId = this.createRecoveryId('instance');
                this._recoveryOwnerId = this.loadRecoveryOwnerId();
                this._recoveryKey = `${RECOVERY_KEY_PREFIX}${this._recoveryOwnerId}`;
                this._recoveryOwnerEpoch = 0;
                this._recoveryChannel = null;
                this._recoveryLeaseTimer = null;
                this._runtimeDisposed = false;
                this._recoveryConflictShown = false;
                this._recoveryPngCache = new WeakMap();
                this._canvasRefCounts = new WeakMap();
                this._scriptLoads = new Map();
                this.serviceWorkerStatus = 'not-available';
                this._modalReturnFocus = null;
                this.lastOutputValidation = null;
                this._operationGeneration = 0;
                this._activeOperation = null;
                this._activeExportJob = null;
                this._exportGeneration = 0;
                this._projectGeneration = 0;
                this.sourceTiming = null;
                this.lastDecoderPath = 'none';
                this.lastDiagnosticError = null;
                this.memoryTelemetry = {
                    peakEstimatedBytes: 0,
                    lastEstimate: null,
                    overrideCount: 0
                };
                this._autosaveMemoryWarningShown = false;

                // Crop state
                this.cropRect = { x: 0, y: 0, w: 100, h: 100 };
                this.isDraggingCrop = false;
                this.cropDragStart = { x: 0, y: 0 };
                this.cropDragType = null;

                // Delete confirmation state
                this.deleteConfirmPending = false;
                this.deleteConfirmTimer = null;

                this.selectedFrames = new Set();

                // Undo/redo state
                this.undoStack = [];
                this.redoStack = [];
                this.maxUndoBytes = Math.floor(this.getMemoryLimits().defaultBytes / 4);

                // Elements
                this.canvas = document.getElementById('mainCanvas');
                this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
                this.dropZone = document.getElementById('dropZone');
                this.canvasWrapper = document.getElementById('canvasWrapper');
                this.timeline = document.getElementById('timeline');
                this.framesContainer = document.getElementById('framesContainer');
                this.fileInput = document.getElementById('fileInput');

                this.init();
            }

            init() {
                this.initializeSidebarSections();
                this.bindEvents();
                this.setActiveTool('select');
                this.setDropZoneActive(true);
                this.initializeRecoveryCoordination();
                this.refreshStorageStatus();
                this.checkSessionRecovery();
            }

            initializeSidebarSections() {
                const defaultExpanded = new Set([
                    'gifInfoSection',
                    'exportSection',
                    'diagnosticsSection'
                ]);
                let savedState = {};
                try {
                    const stored = JSON.parse(localStorage.getItem(SIDEBAR_STATE_KEY) || '{}');
                    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
                        savedState = stored;
                    }
                } catch {}

                document.querySelectorAll('#sidebar .sidebar-section').forEach(section => {
                    const title = section.querySelector(':scope > .sidebar-title');
                    if (!title) return;

                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'sidebar-title';
                    button.id = `${section.id}Toggle`;
                    button.textContent = title.textContent.trim();

                    const panel = document.createElement('div');
                    panel.className = 'sidebar-panel';
                    panel.id = `${section.id}Panel`;
                    while (title.nextSibling) panel.appendChild(title.nextSibling);
                    title.replaceWith(button);
                    section.appendChild(panel);

                    button.setAttribute('aria-controls', panel.id);
                    const expanded = typeof savedState[section.id] === 'boolean'
                        ? savedState[section.id]
                        : defaultExpanded.has(section.id);
                    this.setSidebarSectionExpanded(section, expanded, { persist: false });
                    button.addEventListener('click', () => {
                        this.setSidebarSectionExpanded(
                            section,
                            button.getAttribute('aria-expanded') !== 'true'
                        );
                    });
                });
            }

            setSidebarSectionExpanded(sectionOrId, expanded, { persist = true } = {}) {
                const section = typeof sectionOrId === 'string'
                    ? document.getElementById(sectionOrId)
                    : sectionOrId;
                const button = section?.querySelector(':scope > .sidebar-title');
                const panel = section?.querySelector(':scope > .sidebar-panel');
                if (!section || !button || !panel) return;

                button.setAttribute('aria-expanded', String(expanded));
                panel.hidden = !expanded;
                section.classList.toggle('collapsed', !expanded);

                if (persist) {
                    const state = {};
                    document.querySelectorAll('#sidebar .sidebar-section').forEach(candidate => {
                        const toggle = candidate.querySelector(':scope > .sidebar-title');
                        if (toggle) state[candidate.id] = toggle.getAttribute('aria-expanded') === 'true';
                    });
                    try {
                        localStorage.setItem(SIDEBAR_STATE_KEY, JSON.stringify(state));
                    } catch {}
                }
            }

            beginOperation(kind) {
                if (this._activeOperation) {
                    this.showToast(`${this._activeOperation.kind} is already in progress`, 'warning');
                    return null;
                }
                if (this._activeExportJob) {
                    this.cancelExportJob('A new project operation started');
                }
                this.stopPlayback();
                const token = {
                    id: ++this._operationGeneration,
                    kind,
                    cancelled: false
                };
                this._activeOperation = token;
                this._loadInProgress = true;
                return token;
            }

            isOperationCurrent(token) {
                return !!token &&
                    !token.cancelled &&
                    this._activeOperation === token &&
                    token.id === this._operationGeneration;
            }

            assertOperationCurrent(token) {
                if (!this.isOperationCurrent(token)) {
                    const error = new Error('Operation cancelled');
                    error.name = 'AbortError';
                    throw error;
                }
            }

            finishOperation(token) {
                if (this._activeOperation !== token) return;
                token.cancelled = true;
                this._activeOperation = null;
                this._loadInProgress = false;
            }

            prepareMutation({
                operation = 'Edit',
                width = this.originalWidth,
                height = this.originalHeight,
                frameCount = this.frames.length,
                temporaryCopies = 1
            } = {}) {
                if (this._activeOperation) {
                    this.showToast(`Wait for ${this._activeOperation.kind} to finish`, 'warning');
                    return false;
                }
                if (this._activeExportJob) {
                    this.showToast('Cancel the active export before editing', 'warning');
                    return false;
                }
                try {
                    this.preflightMemory(operation, {
                        width,
                        height,
                        frameCount,
                        temporaryCopies
                    });
                } catch (error) {
                    this.showToast(error.message, 'error');
                    return false;
                }
                this.stopPlayback();
                this._projectGeneration++;
                return true;
            }

            getMemoryLimits() {
                const deviceMemory = Number(navigator.deviceMemory);
                let defaultBytes = MEMORY_LIMITS.standardDefault;
                if (Number.isFinite(deviceMemory) && deviceMemory <= 2) {
                    defaultBytes = MEMORY_LIMITS.lowDeviceDefault;
                } else if (Number.isFinite(deviceMemory) && deviceMemory <= 4) {
                    defaultBytes = MEMORY_LIMITS.mediumDeviceDefault;
                }
                const deviceCeiling = Number.isFinite(deviceMemory)
                    ? Math.max(defaultBytes * 2, deviceMemory * 256 * MEBIBYTE)
                    : MEMORY_LIMITS.absoluteCeiling;
                return {
                    defaultBytes,
                    safeCeilingBytes: Math.min(MEMORY_LIMITS.absoluteCeiling, deviceCeiling),
                    deviceMemory: Number.isFinite(deviceMemory) ? deviceMemory : null
                };
            }

            estimateFrameBytes(width, height, frameCount) {
                const pixels = width * height * frameCount;
                const bytes = pixels * 4;
                if (!Number.isSafeInteger(pixels) || !Number.isSafeInteger(bytes) || pixels < 0) {
                    const error = new Error('Frame memory exceeds safe browser arithmetic limits');
                    error.name = 'MemoryBudgetError';
                    throw error;
                }
                return { pixels, bytes };
            }

            estimateResidentBytes() {
                const canvases = new Set();
                const collect = frames => (frames || []).forEach(frame => canvases.add(frame.canvas));
                collect(this.frames);
                this.undoStack.forEach(snapshot => collect(snapshot.frames));
                this.redoStack.forEach(snapshot => collect(snapshot.frames));
                return [...canvases].reduce(
                    (sum, canvas) => sum + canvas.width * canvas.height * 4,
                    0
                );
            }

            estimateMemory(operation, {
                width,
                height,
                frameCount,
                temporaryCopies = 1
            }) {
                const raw = this.estimateFrameBytes(width, height, frameCount);
                const residentBytes = this.estimateResidentBytes();
                const temporaryBytes = raw.bytes * temporaryCopies;
                const estimatedPeakBytes = residentBytes + temporaryBytes;
                return {
                    operation,
                    width,
                    height,
                    frameCount,
                    pixels: raw.pixels,
                    rawFrameBytes: raw.bytes,
                    residentBytes,
                    temporaryBytes,
                    temporaryCopies,
                    estimatedPeakBytes,
                    limits: this.getMemoryLimits(),
                    overridden: false,
                    recordedAt: new Date().toISOString()
                };
            }

            recordMemoryEstimate(estimate) {
                this.memoryTelemetry.lastEstimate = estimate;
                this.memoryTelemetry.peakEstimatedBytes = Math.max(
                    this.memoryTelemetry.peakEstimatedBytes,
                    estimate.estimatedPeakBytes
                );
                this.updateAnalyzer();
            }

            memoryBudgetError(message) {
                const error = new Error(message);
                error.name = 'MemoryBudgetError';
                return error;
            }

            preflightMemory(operation, options, { allowOverride = true } = {}) {
                GifDecoder.validateBudget(options.width, options.height, options.frameCount);
                const estimate = this.estimateMemory(operation, options);
                this.recordMemoryEstimate(estimate);
                const { defaultBytes, safeCeilingBytes } = estimate.limits;
                if (estimate.estimatedPeakBytes <= defaultBytes) return estimate;

                const details =
                    `${estimate.frameCount.toLocaleString()} frame${estimate.frameCount === 1 ? '' : 's'} at ` +
                    `${estimate.width}×${estimate.height} contain ${this.formatBytes(estimate.rawFrameBytes)} of raw pixels; ` +
                    `resident frames/history plus temporary buffers may peak at ${this.formatBytes(estimate.estimatedPeakBytes)}.`;
                const recovery =
                    ' Export the current work first, then retry with fewer/smaller frames or reload and re-import to clear undo history.';

                if (estimate.estimatedPeakBytes > safeCeilingBytes) {
                    throw this.memoryBudgetError(
                        `${operation} stopped before allocation. ${details} ` +
                        `The safe ceiling is ${this.formatBytes(safeCeilingBytes)}.` +
                        recovery
                    );
                }
                if (!allowOverride) {
                    throw this.memoryBudgetError(
                        `${operation} paused because ${details} ` +
                        `The automatic-task budget is ${this.formatBytes(defaultBytes)}.` +
                        recovery
                    );
                }

                const approved = window.confirm(
                    `${operation} may exceed this browser's ${this.formatBytes(defaultBytes)} default memory budget.\n\n` +
                    `${details}\n\nContinuing can make this tab unresponsive. Continue once?` +
                    recovery
                );
                if (!approved) {
                    throw this.memoryBudgetError(
                        `${operation} cancelled before allocation. ${details}` + recovery
                    );
                }
                estimate.overridden = true;
                this.memoryTelemetry.overrideCount++;
                this.recordMemoryEstimate(estimate);
                return estimate;
            }

            releaseFrames(frames) {
                if (!frames) return;
                frames.forEach(frame => this.releaseCanvas(frame.canvas));
            }

            retainCanvas(canvas) {
                const owners = this._canvasRefCounts.get(canvas) || 1;
                this._canvasRefCounts.set(canvas, owners + 1);
                return canvas;
            }

            ensureWritableFrame(index) {
                const frame = this.frames[index];
                if (!frame || (this._canvasRefCounts.get(frame.canvas) || 1) <= 1) return frame;
                const source = frame.canvas;
                const canvas = document.createElement('canvas');
                canvas.width = source.width;
                canvas.height = source.height;
                canvas.getContext('2d').drawImage(source, 0, 0);
                this.releaseCanvas(source);
                frame.canvas = canvas;
                return frame;
            }

            commitProject(project, token) {
                this.assertOperationCurrent(token);
                const previousFrames = this.frames;
                this.clearUndoHistory();
                this.frames = project.frames;
                this.originalWidth = project.width;
                this.originalHeight = project.height;
                this.currentFrame = Math.min(project.currentFrame || 0, this.frames.length - 1);
                this.originalFilename = project.filename || 'edited';
                this.fileSize = project.fileSize || 0;
                this.rawGifMeta = project.rawGifMeta || null;
                this.lastDecoderPath = project.decoderPath || 'not applicable';
                this.lastOutputValidation = null;
                this.sourceTiming = project.sourceTiming || {
                    format: project.sourceFormat || 'Imported',
                    delays: this.frames.map(frame => frame.delay)
                };
                this.cropRect = { x: 0, y: 0, w: project.width, h: project.height };
                this.selectedFrames.clear();
                this._projectGeneration++;
                this.releaseFrames(previousFrames);

                const filenameInput = document.getElementById('exportFilename');
                if (filenameInput) {
                    filenameInput.value = project.exportFilename || `${this.originalFilename}-edited`;
                }
                this.showEditor();
                this.syncTimingControls();
                this.scheduleAutosave();
            }

            // ============================================
            // Session Autosave (IndexedDB)
            // ============================================

            createRecoveryId(prefix) {
                const random = globalThis.crypto?.randomUUID?.() ||
                    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
                return `${prefix}-${random}`;
            }

            loadRecoveryOwnerId() {
                const storageKey = 'gifstudioRecoveryOwner';
                try {
                    const existing = sessionStorage.getItem(storageKey);
                    if (existing && /^[a-z0-9-]{12,}$/i.test(existing)) return existing;
                    const created = this.createRecoveryId('tab');
                    sessionStorage.setItem(storageKey, created);
                    return created;
                } catch {
                    return this.createRecoveryId('tab');
                }
            }

            initializeRecoveryCoordination() {
                this.recoveryCoordinationStatus = 'isolated tab session';
                if ('BroadcastChannel' in window) {
                    this._recoveryChannel = new BroadcastChannel('gifstudio-recovery');
                    this._recoveryChannel.addEventListener('message', event => {
                        const message = event.data;
                        if (
                            message?.type !== 'claim' ||
                            message.ownerId !== this._recoveryOwnerId ||
                            message.instanceId === this._recoveryInstanceId
                        ) return;

                        // sessionStorage can be copied when a tab is duplicated. The
                        // lexicographically later live instance yields the copied ID.
                        if (this._recoveryInstanceId > message.instanceId) {
                            this.rotateRecoveryOwner();
                        } else {
                            this.broadcastRecoveryClaim();
                        }
                    });
                    this.broadcastRecoveryClaim();
                }

                this._recoveryLeaseTimer = setInterval(
                    () => this.refreshRecoveryLease(),
                    RECOVERY_HEARTBEAT_MS
                );
                window.addEventListener('pagehide', event => {
                    if (!event.persisted) this.disposeRuntime();
                }, { once: true });
            }

            disposeRuntime() {
                if (this._runtimeDisposed) return;
                this._runtimeDisposed = true;
                if (this._recoveryLeaseTimer) clearInterval(this._recoveryLeaseTimer);
                this._recoveryLeaseTimer = null;
                this._recoveryChannel?.close();
                this._recoveryChannel = null;
                if (this._autosaveTimer) clearTimeout(this._autosaveTimer);
                this._autosaveTimer = null;
                this._autosaveGeneration++;
                try { this._autosaveTransaction?.abort(); } catch {}
                this._autosaveTransaction = null;
                if (this.playInterval) clearTimeout(this.playInterval);
                this.playInterval = null;
                this.isPlaying = false;
                if (this._activeOperation) this._activeOperation.cancelled = true;
                if (this._activeExportJob) this._activeExportJob.cancelled = true;
            }

            broadcastRecoveryClaim() {
                this._recoveryChannel?.postMessage({
                    type: 'claim',
                    ownerId: this._recoveryOwnerId,
                    instanceId: this._recoveryInstanceId
                });
            }

            rotateRecoveryOwner() {
                this._recoveryOwnerId = this.createRecoveryId('tab');
                this._recoveryKey = `${RECOVERY_KEY_PREFIX}${this._recoveryOwnerId}`;
                this._recoveryOwnerEpoch++;
                try {
                    sessionStorage.setItem('gifstudioRecoveryOwner', this._recoveryOwnerId);
                } catch {}
                this.recoveryCoordinationStatus = 'copied tab isolated';
                this.broadcastRecoveryClaim();
                if (this.frames.length) this.scheduleAutosave();
                this.showToast('This duplicated tab now has an independent recovery session.', 'info');
            }

            async readRecoveryEntries(db) {
                const tx = db.transaction('session', 'readonly');
                const store = tx.objectStore('session');
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
            }

            async refreshRecoveryLease() {
                if (!this._lastSavedGeneration) return;
                let db;
                try {
                    db = await this.openDB();
                    const tx = db.transaction('session', 'readwrite');
                    const store = tx.objectStore('session');
                    const request = store.get(this._recoveryKey);
                    request.onsuccess = () => {
                        const record = request.result;
                        if (!record || record.ownerId !== this._recoveryOwnerId) return;
                        record.leaseExpiresAt = Date.now() + RECOVERY_LEASE_MS;
                        store.put(record, this._recoveryKey);
                    };
                    await new Promise((resolve, reject) => {
                        tx.oncomplete = resolve;
                        tx.onerror = () => reject(tx.error);
                        tx.onabort = () => reject(tx.error || new Error('Recovery lease update aborted'));
                    });
                } catch (error) {
                    if (error?.name !== 'AbortError') {
                        this.recordDiagnosticError(error.message, 'recovery-coordination');
                    }
                } finally {
                    if (db) db.close();
                }
            }

            openDB() {
                return new Promise((resolve, reject) => {
                    const req = indexedDB.open('GifStudioSession', SESSION_SCHEMA_VERSION);
                    req.onupgradeneeded = () => {
                        const db = req.result;
                        if (!db.objectStoreNames.contains('session')) {
                            db.createObjectStore('session');
                        }
                    };
                    req.onblocked = () => reject(new Error('Recovery database upgrade is blocked by another GifStudio tab'));
                    req.onsuccess = () => {
                        const db = req.result;
                        db.onversionchange = () => db.close();
                        this.storageStatus = 'ready';
                        resolve(db);
                    };
                    req.onerror = () => reject(req.error);
                });
            }

            captureEditorState() {
                return {
                    currentFrame: this.currentFrame,
                    playbackSpeed: this.playbackSpeed,
                    playbackMode: this.playbackMode,
                    exportFormat: this.getExportFormat(),
                    exportFilename: document.getElementById('exportFilename').value,
                    quality: Number(document.getElementById('qualitySlider').value),
                    colorCount: document.getElementById('colorCount').value,
                    dither: document.getElementById('ditherSelect').value,
                    loop: document.getElementById('loopGif').checked
                };
            }

            restoreEditorState(state = {}) {
                this.currentFrame = Math.max(0, Math.min(
                    Number.isInteger(state.currentFrame) ? state.currentFrame : 0,
                    this.frames.length - 1
                ));
                this.playbackSpeed = Number.isFinite(state.playbackSpeed) ? state.playbackSpeed : 1;
                document.getElementById('speedSlider').value = String(this.playbackSpeed);
                document.getElementById('speedDisplay').textContent = `${this.playbackSpeed}x`;
                this.setPlaybackMode(['normal', 'pingpong', 'boomerang'].includes(state.playbackMode)
                    ? state.playbackMode
                    : 'normal');

                const format = state.exportFormat === 'apng' ? 'apng' : 'gif';
                document.getElementById('exportFormat').value = format;
                if (typeof state.exportFilename === 'string' && state.exportFilename.trim()) {
                    document.getElementById('exportFilename').value = state.exportFilename;
                }
                if (Number.isFinite(state.quality)) {
                    document.getElementById('qualitySlider').value = String(Math.max(1, Math.min(30, state.quality)));
                }
                if (['16', '32', '64', '128', '256'].includes(state.colorCount)) {
                    document.getElementById('colorCount').value = state.colorCount;
                }
                if (['none', 'FloydSteinberg'].includes(state.dither)) {
                    document.getElementById('ditherSelect').value = state.dither;
                }
                if (typeof state.loop === 'boolean') {
                    document.getElementById('loopGif').checked = state.loop;
                }
                this.syncTimingControls();
                this.renderTimeline();
                this.renderFrame();
            }

            migrateSession(record) {
                const invalid = (message, name = 'DataError') => {
                    const error = new Error(message);
                    error.name = name;
                    throw error;
                };
                if (!record || typeof record !== 'object') {
                    invalid('Recovery record is not an object');
                }
                const version = record.schemaVersion || 1;
                if (version > SESSION_SCHEMA_VERSION) {
                    invalid(`Recovery schema ${version} requires a newer GifStudio`, 'VersionError');
                }
                if (!Array.isArray(record.frames) || record.frames.length === 0) {
                    invalid('Recovery record has no frames');
                }
                try {
                    GifDecoder.validateBudget(record.width, record.height, record.frames.length);
                } catch (error) {
                    invalid(error.message);
                }
                record.frames.forEach((frame, index) => {
                    const validPng = frame?.png instanceof ArrayBuffer || ArrayBuffer.isView(frame?.png);
                    if (!validPng) invalid(`Recovery frame ${index + 1} has no PNG data`);
                    if (!Number.isFinite(frame.delay) || frame.delay < 1) {
                        invalid(`Recovery frame ${index + 1} has an invalid delay`);
                    }
                });

                if (version === 1) {
                    return {
                        ...record,
                        schemaVersion: SESSION_SCHEMA_VERSION,
                        appVersion: APP_VERSION,
                        sourceTiming: {
                            format: 'Migrated recovery',
                            delays: record.frames.map(frame => frame.delay)
                        },
                        editorState: {
                            currentFrame: record.currentFrame || 0,
                            exportFilename: `${record.filename || 'recovered'}-edited`,
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

            reportStorageError(context, error) {
                this.storageStatus = 'error';
                console.error(`${context}:`, error);
                if (this._storageErrorShown) return;
                this._storageErrorShown = true;
                const quota = error?.name === 'QuotaExceededError';
                this.showToast(
                    quota
                        ? 'Local recovery storage is full. The previous recovery was retained; export your work, then free browser site storage.'
                        : 'Local recovery is unavailable. Keep this tab open and export your work before leaving.',
                    'error'
                );
            }

            updateStorageDurabilityUI() {
                const status = document.getElementById('storageDurabilityStatus');
                const button = document.getElementById('requestPersistenceBtn');
                const telemetry = this.storageTelemetry;
                if (status) {
                    const usage = Number.isFinite(telemetry.usage) && Number.isFinite(telemetry.quota)
                        ? `${this.formatBytes(telemetry.usage)} of ${this.formatBytes(telemetry.quota)} used`
                        : 'Usage unavailable';
                    const durability = telemetry.persisted === true
                        ? 'persistent'
                        : telemetry.persisted === false
                            ? 'best effort'
                            : 'durability unknown';
                    status.textContent = `${usage} · ${durability}`;
                }
                if (button) {
                    button.hidden = !telemetry.persistenceSupported;
                    button.disabled = telemetry.persisted === true;
                    button.textContent = telemetry.persisted === true
                        ? 'Persistent storage granted'
                        : 'Request persistent storage';
                }
            }

            async refreshStorageStatus() {
                const storage = navigator.storage;
                this.storageTelemetry.persistenceSupported = typeof storage?.persist === 'function';
                try {
                    const [estimate, persisted] = await Promise.all([
                        typeof storage?.estimate === 'function'
                            ? storage.estimate()
                            : Promise.resolve({}),
                        typeof storage?.persisted === 'function'
                            ? storage.persisted()
                            : Promise.resolve(null)
                    ]);
                    this.storageTelemetry.usage = Number.isFinite(estimate?.usage) ? estimate.usage : null;
                    this.storageTelemetry.quota = Number.isFinite(estimate?.quota) ? estimate.quota : null;
                    this.storageTelemetry.persisted = typeof persisted === 'boolean' ? persisted : null;
                } catch (error) {
                    this.recordDiagnosticError(error.message, 'storage-status');
                }
                this.updateStorageDurabilityUI();
                return this.storageTelemetry;
            }

            async requestPersistentStorage() {
                if (typeof navigator.storage?.persist !== 'function') {
                    this.showToast('This browser does not expose persistent storage requests; autosave remains best effort.', 'warning');
                    return false;
                }
                try {
                    const granted = await navigator.storage.persist();
                    this.storageTelemetry.persisted = Boolean(granted);
                    await this.refreshStorageStatus();
                    this.showToast(
                        granted
                            ? 'Persistent recovery storage granted for this site.'
                            : 'Persistent storage was not granted; autosave continues with best-effort recovery.',
                        granted ? 'success' : 'warning'
                    );
                    return granted;
                } catch (error) {
                    this.recordDiagnosticError(error.message, 'storage-persistence');
                    this.showToast('Persistent storage request failed; autosave continues with best-effort recovery.', 'warning');
                    return false;
                }
            }

            scheduleAutosave() {
                this._autosaveGeneration++;
                const generation = this._autosaveGeneration;
                if (this._autosaveTransaction) {
                    try { this._autosaveTransaction.abort(); } catch {}
                }
                if (this._autosaveTimer) clearTimeout(this._autosaveTimer);
                this._autosaveTimer = setTimeout(() => this.saveSession(generation), 2000);
            }

            async saveSession(generation = this._autosaveGeneration) {
                if (this.frames.length === 0 || generation !== this._autosaveGeneration) return;
                const recoveryOwnerId = this._recoveryOwnerId;
                const recoveryKey = this._recoveryKey;
                const recoveryOwnerEpoch = this._recoveryOwnerEpoch;
                try {
                    this.preflightMemory('Recovery autosave', {
                        width: this.originalWidth,
                        height: this.originalHeight,
                        frameCount: this.frames.length,
                        temporaryCopies: 1
                    }, { allowOverride: false });
                    this._autosaveMemoryWarningShown = false;
                } catch (error) {
                    if (!this._autosaveMemoryWarningShown) {
                        this._autosaveMemoryWarningShown = true;
                        this.showToast(error.message, 'warning');
                    }
                    return;
                }
                const snapshot = {
                    frames: this.frames.map(f => ({
                        canvas: this.retainCanvas(f.canvas),
                        delay: f.delay,
                        disposalType: f.disposalType
                    })),
                    width: this.originalWidth,
                    height: this.originalHeight,
                    filename: this.originalFilename,
                    sourceTiming: this.sourceTiming
                        ? { format: this.sourceTiming.format, delays: [...this.sourceTiming.delays] }
                        : null,
                    editorState: this.captureEditorState()
                };
                let db;
                let tx;
                try {
                    db = await this.openDB();
                    if (
                        generation !== this._autosaveGeneration ||
                        recoveryOwnerEpoch !== this._recoveryOwnerEpoch
                    ) return;
                    const frameData = [];
                    for (const frame of snapshot.frames) {
                        let buf = this._recoveryPngCache.get(frame.canvas);
                        if (!buf) {
                            const blob = await new Promise(r => frame.canvas.toBlob(r, 'image/png'));
                            if (!blob) throw new Error('Browser could not serialize a recovery frame');
                            if (
                                generation !== this._autosaveGeneration ||
                                recoveryOwnerEpoch !== this._recoveryOwnerEpoch
                            ) return;
                            buf = await blob.arrayBuffer();
                            this._recoveryPngCache.set(frame.canvas, buf);
                        }
                        frameData.push({ png: buf, delay: frame.delay, disposalType: frame.disposalType });
                    }
                    if (
                        generation !== this._autosaveGeneration ||
                        recoveryOwnerEpoch !== this._recoveryOwnerEpoch
                    ) return;
                    const session = {
                        schemaVersion: SESSION_SCHEMA_VERSION,
                        appVersion: APP_VERSION,
                        generation,
                        ownerId: recoveryOwnerId,
                        leaseExpiresAt: Date.now() + RECOVERY_LEASE_MS,
                        frames: frameData,
                        width: snapshot.width,
                        height: snapshot.height,
                        filename: snapshot.filename,
                        sourceTiming: snapshot.sourceTiming,
                        editorState: snapshot.editorState,
                        savedAt: Date.now()
                    };
                    tx = db.transaction('session', 'readwrite');
                    this._autosaveTransaction = tx;
                    if (
                        generation !== this._autosaveGeneration ||
                        recoveryOwnerEpoch !== this._recoveryOwnerEpoch
                    ) {
                        tx.abort();
                        return;
                    }
                    tx.objectStore('session').put(session, recoveryKey);
                    await new Promise((resolve, reject) => {
                        tx.oncomplete = resolve;
                        tx.onerror = () => reject(tx.error);
                        tx.onabort = () => reject(tx.error || new DOMException('Autosave superseded', 'AbortError'));
                    });
                    if (generation === this._autosaveGeneration) {
                        this._lastSavedGeneration = generation;
                        this.storageStatus = 'ready';
                        this.recoveryCoordinationStatus = 'owned by this tab';
                        this._storageErrorShown = false;
                        this._recoveryChannel?.postMessage({
                            type: 'saved',
                            ownerId: recoveryOwnerId,
                            savedAt: session.savedAt
                        });
                    }
                } catch (e) {
                    if (generation === this._autosaveGeneration && e?.name !== 'AbortError') {
                        this.reportStorageError('Autosave failed', e);
                    }
                } finally {
                    if (this._autosaveTransaction === tx) this._autosaveTransaction = null;
                    if (db) db.close();
                    this.releaseFrames(snapshot.frames);
                }
            }

            async checkSessionRecovery() {
                let db;
                try {
                    db = await this.openDB();
                    const now = Date.now();
                    const entries = await this.readRecoveryEntries(db);
                    const own = entries.find(entry => entry.key === this._recoveryKey);
                    const legacy = entries.find(entry => entry.key === 'current');
                    const expired = entries
                        .filter(entry =>
                            entry.key !== this._recoveryKey &&
                            entry.key !== 'current' &&
                            (!Number.isFinite(entry.record?.leaseExpiresAt) ||
                                entry.record.leaseExpiresAt <= now)
                        )
                        .sort((a, b) => (b.record?.savedAt || 0) - (a.record?.savedAt || 0));
                    const activeOthers = entries.filter(entry =>
                        entry.key !== this._recoveryKey &&
                        entry.key !== 'current' &&
                        Number.isFinite(entry.record?.leaseExpiresAt) &&
                        entry.record.leaseExpiresAt > now
                    );
                    if (activeOthers.length) {
                        this.recoveryCoordinationStatus =
                            `${activeOthers.length} other active tab${activeOthers.length === 1 ? '' : 's'} isolated`;
                        if (!this._recoveryConflictShown) {
                            this._recoveryConflictShown = true;
                            this.showToast(
                                'Another GifStudio tab has an active recovery. This tab will save separately.',
                                'warning'
                            );
                        }
                    }

                    const candidate = own || legacy || expired[0];
                    if (!candidate) return;
                    let migrated;
                    try {
                        migrated = this.migrateSession(candidate.record);
                    } catch (error) {
                        error.recoveryKey = candidate.key;
                        error.recoveryOwnerId = candidate.record?.ownerId || null;
                        error.recoverySavedAt = candidate.record?.savedAt;
                        throw error;
                    }

                    const age = Date.now() - (migrated.savedAt || 0);
                    if (age > 7 * 24 * 60 * 60 * 1000) {
                        await this.clearSavedSession({
                            key: candidate.key,
                            expectedOwnerId: migrated.ownerId || null,
                            expectedSavedAt: migrated.savedAt
                        });
                        return;
                    }

                    const mins = Math.round(age / 60000);
                    const timeAgo = mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
                    this.showRecoveryBanner(migrated, timeAgo, candidate.key);
                } catch (e) {
                    if (e?.name === 'VersionError') {
                        console.error('Session recovery version mismatch:', e);
                        this.showToast('Saved recovery belongs to a newer GifStudio version and was retained unchanged.', 'warning');
                    } else if (e?.name === 'DataError' || /^Recovery /.test(e?.message || '')) {
                        console.error('Invalid recovery record:', e);
                        await this.clearSavedSession({
                            key: e.recoveryKey || 'current',
                            expectedOwnerId: e.recoveryOwnerId,
                            expectedSavedAt: e.recoverySavedAt,
                            reportErrors: false
                        });
                        this.showToast('Saved recovery was invalid and has been removed. Import the source file to continue.', 'error');
                    } else {
                        this.reportStorageError('Session recovery check failed', e);
                    }
                } finally {
                    if (db) try { db.close(); } catch {}
                }
            }

            showRecoveryBanner(session, timeAgo, recoveryKey = this._recoveryKey) {
                document.getElementById('recoveryBanner')?.remove();
                const banner = document.createElement('div');
                banner.id = 'recoveryBanner';
                banner.className = 'recovery-banner';
                banner.setAttribute('role', 'region');
                banner.setAttribute('aria-label', 'Saved session recovery');
                banner.setAttribute('aria-live', 'polite');
                const message = document.createElement('span');
                message.className = 'recovery-message';
                message.textContent = `Recover previous session? (${session.frames.length} frames, ${timeAgo}). Saved locally until dismissed or seven days old.`;
                banner.appendChild(message);
                const actions = document.createElement('div');
                actions.className = 'recovery-actions';
                const restoreBtn = document.createElement('button');
                restoreBtn.className = 'btn btn-primary';
                restoreBtn.textContent = 'Restore';
                restoreBtn.onclick = async () => {
                    banner.remove();
                    const restored = await this.restoreSession(session, recoveryKey);
                    if (restored) {
                        if (this._autosaveTimer) {
                            clearTimeout(this._autosaveTimer);
                            this._autosaveTimer = null;
                        }
                        await this.saveSession(this._autosaveGeneration);
                        if (recoveryKey !== this._recoveryKey) {
                            await this.clearSavedSession({
                                key: recoveryKey,
                                expectedOwnerId: session.ownerId || null,
                                expectedSavedAt: session.savedAt
                            });
                        }
                        document.getElementById('exportBtn').focus();
                    }
                };
                const dismissBtn = document.createElement('button');
                dismissBtn.className = 'btn btn-ghost';
                dismissBtn.textContent = 'Dismiss';
                dismissBtn.onclick = async () => {
                    banner.remove();
                    await this.clearSavedSession({
                        key: recoveryKey,
                        expectedOwnerId: session.ownerId || null,
                        expectedSavedAt: session.savedAt
                    });
                    document.getElementById('importBtn').focus();
                };
                actions.appendChild(restoreBtn);
                actions.appendChild(dismissBtn);
                banner.appendChild(actions);
                document.body.appendChild(banner);
            }

            async restoreSession(session, recoveryKey = this._recoveryKey) {
                const token = this.beginOperation('Session restore');
                if (!token) return;
                const restoredFrames = [];
                let committed = false;
                try {
                    GifDecoder.validateBudget(session.width, session.height, session.frames?.length || 0);
                    this.preflightMemory('Session restore', {
                        width: session.width,
                        height: session.height,
                        frameCount: session.frames.length,
                        temporaryCopies: 1
                    });
                    for (const fd of session.frames) {
                        this.assertOperationCurrent(token);
                        const blob = new Blob([fd.png], { type: 'image/png' });
                        const img = await new Promise((resolve, reject) => {
                            const i = new Image();
                            i.onload = () => { URL.revokeObjectURL(i.src); resolve(i); };
                            i.onerror = () => { URL.revokeObjectURL(i.src); reject(new Error('Failed to load recovery frame')); };
                            i.src = URL.createObjectURL(blob);
                        });
                        this.assertOperationCurrent(token);
                        const c = document.createElement('canvas');
                        c.width = session.width;
                        c.height = session.height;
                        c.getContext('2d').drawImage(img, 0, 0);
                        restoredFrames.push({ canvas: c, delay: fd.delay, disposalType: fd.disposalType || 0 });
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
                        exportFilename: `${session.filename || 'recovered'}-edited`
                    }, token);
                    committed = true;
                    this.restoreEditorState(session.editorState);
                    this.showToast(`Restored ${restoredFrames.length} frames`, 'success');
                    return true;
                } catch (error) {
                    if (!committed) this.releaseFrames(restoredFrames);
                    if (error.name !== 'AbortError') {
                        console.error('Session restore failed:', error);
                        this.showToast('Recovery failed: ' + error.message, 'error');
                        if (error.name !== 'MemoryBudgetError') {
                            await this.clearSavedSession({
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

            async clearSavedSession({
                key = this._recoveryKey,
                expectedOwnerId = key === this._recoveryKey ? this._recoveryOwnerId : undefined,
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
                            key !== this._recoveryKey &&
                            record.ownerId &&
                            record.ownerId !== this._recoveryOwnerId &&
                            record.leaseExpiresAt > Date.now();
                        if (ownerChanged || recordChanged || activeOtherOwner) {
                            this.recoveryCoordinationStatus = 'stale delete prevented';
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
                    if (!deleted && request.result) {
                        this.showToast('Recovery changed in another tab and was kept.', 'warning');
                    }
                    return deleted;
                } catch (e) {
                    if (reportErrors) this.reportStorageError('Could not clear recovery', e);
                    return false;
                } finally {
                    if (db) db.close();
                }
            }

            // ============================================
            // Undo / Redo
            // ============================================

            captureHistorySnapshot(label) {
                return {
                    label,
                    frames: this.frames.map(frame => ({
                        canvas: this.retainCanvas(frame.canvas),
                        delay: frame.delay,
                        disposalType: frame.disposalType
                    })),
                    currentFrame: this.currentFrame,
                    originalWidth: this.originalWidth,
                    originalHeight: this.originalHeight,
                    cropRect: { ...this.cropRect }
                };
            }

            releaseHistorySnapshot(snapshot) {
                this.releaseFrames(snapshot?.frames);
            }

            estimateHistoryBytes() {
                const canvases = new Set();
                [...this.undoStack, ...this.redoStack].forEach(snapshot => {
                    snapshot.frames.forEach(frame => canvases.add(frame.canvas));
                });
                return [...canvases].reduce(
                    (sum, canvas) => sum + canvas.width * canvas.height * 4,
                    0
                );
            }

            trimHistoryToBudget() {
                while (this.estimateHistoryBytes() > this.maxUndoBytes) {
                    const snapshot = this.undoStack.length > 1
                        ? this.undoStack.shift()
                        : this.redoStack.shift() || this.undoStack.shift();
                    if (!snapshot) break;
                    this.releaseHistorySnapshot(snapshot);
                }
            }

            saveUndoState(label) {
                this.undoStack.push(this.captureHistorySnapshot(label));
                this.redoStack.forEach(snapshot => this.releaseHistorySnapshot(snapshot));
                this.redoStack = [];
                this.trimHistoryToBudget();
                this.updateUndoRedoButtons();
                this.scheduleAutosave();
            }

            restoreSnapshot(snapshot) {
                this.releaseFrames(this.frames);
                // The popped snapshot transfers its retained canvas ownership to
                // the active project; metadata objects remain independently mutable.
                this.frames = snapshot.frames.map(frame => ({ ...frame }));
                this.currentFrame = Math.min(snapshot.currentFrame, this.frames.length - 1);
                this.originalWidth = snapshot.originalWidth;
                this.originalHeight = snapshot.originalHeight;
                this.cropRect = { ...snapshot.cropRect };
                this.selectedFrames.clear();
                this.updateGIFInfo();
                this.updateResizeInputs();
                this.updateCropInputs();
                this.renderTimeline();
                this.renderFrame();
                this.fitToView();
            }

            undo() {
                if (this.undoStack.length === 0) return;
                if (!this.prepareMutation({ operation: 'Undo', temporaryCopies: 0 })) return;
                this.redoStack.push(this.captureHistorySnapshot('redo'));
                const snapshot = this.undoStack.pop();
                this.restoreSnapshot(snapshot);
                this.trimHistoryToBudget();
                this.updateUndoRedoButtons();
                this.scheduleAutosave();
                this.showToast(`Undo: ${snapshot.label}`, 'info');
            }

            redo() {
                if (this.redoStack.length === 0) return;
                if (!this.prepareMutation({ operation: 'Redo', temporaryCopies: 0 })) return;
                this.undoStack.push(this.captureHistorySnapshot('undo'));
                const snapshot = this.redoStack.pop();
                this.restoreSnapshot(snapshot);
                this.trimHistoryToBudget();
                this.updateUndoRedoButtons();
                this.scheduleAutosave();
                this.showToast('Redo', 'info');
            }

            updateUndoRedoButtons() {
                const undoBtn = document.getElementById('undoBtn');
                const redoBtn = document.getElementById('redoBtn');
                undoBtn.disabled = this.undoStack.length === 0;
                redoBtn.disabled = this.redoStack.length === 0;
                undoBtn.title = this.undoStack.length > 0
                    ? `Undo: ${this.undoStack[this.undoStack.length - 1].label} (Ctrl+Z)`
                    : 'Undo (Ctrl+Z)';
                redoBtn.title = this.redoStack.length > 0
                    ? 'Redo (Ctrl+Y)'
                    : 'Redo (Ctrl+Y)';
            }

            clearUndoHistory() {
                this.undoStack.forEach(snapshot => this.releaseHistorySnapshot(snapshot));
                this.redoStack.forEach(snapshot => this.releaseHistorySnapshot(snapshot));
                this.undoStack = [];
                this.redoStack = [];
                this.updateUndoRedoButtons();
            }

            bindEvents() {
                // File handling
                document.getElementById('importBtn').addEventListener('click', () => this.fileInput.click());
                document.getElementById('chooseFilesBtn').addEventListener('click', () => this.fileInput.click());
                this.fileInput.addEventListener('change', (e) => {
                    const files = Array.from(e.target.files);
                    if (files.length === 1 && files[0].type === 'image/gif') {
                        this.handleFileSelect(files[0]);
                    } else if (files.length >= 1) {
                        this.handleImageFiles(files);
                    }
                });

                // Drag and drop
                this.dropZone.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    this.dropZone.classList.add('dragover');
                });
                this.dropZone.addEventListener('dragleave', () => {
                    this.dropZone.classList.remove('dragover');
                });
                this.dropZone.addEventListener('drop', (e) => {
                    e.preventDefault();
                    this.dropZone.classList.remove('dragover');
                    const files = Array.from(e.dataTransfer.files);
                    if (files.length === 1 && files[0].type === 'image/gif') {
                        this.handleFileSelect(files[0]);
                    } else if (files.length >= 1 && files.every(f => f.type.startsWith('image/'))) {
                        this.handleImageFiles(files);
                    }
                });

                // Undo/Redo
                document.getElementById('undoBtn').addEventListener('click', () => this.undo());
                document.getElementById('redoBtn').addEventListener('click', () => this.redo());

                // Tools
                document.getElementById('toolSelect').addEventListener('click', () => this.setActiveTool('select'));
                document.getElementById('toolCrop').addEventListener('click', () => this.setActiveTool('crop'));
                document.getElementById('toolRedact').addEventListener('click', () => this.setActiveTool('redact'));

                // Zoom
                document.getElementById('zoomIn').addEventListener('click', () => this.setZoom(this.zoom + 0.25));
                document.getElementById('zoomOut').addEventListener('click', () => this.setZoom(this.zoom - 0.25));
                document.getElementById('zoomFit').addEventListener('click', () => this.fitToView());

                // Transforms
                document.getElementById('flipH').addEventListener('click', () => this.flipHorizontal());
                document.getElementById('flipV').addEventListener('click', () => this.flipVertical());
                document.getElementById('rotate').addEventListener('click', () => this.rotate90());

                // Playback
                document.getElementById('playPause').addEventListener('click', () => this.togglePlay());
                document.getElementById('prevFrame').addEventListener('click', () => this.goToFrame(this.currentFrame - 1));
                document.getElementById('nextFrame').addEventListener('click', () => this.goToFrame(this.currentFrame + 1));

                // Frame actions
                document.getElementById('duplicateFrame').addEventListener('click', () => this.duplicateFrame());
                document.getElementById('deleteFrame').addEventListener('click', () => this.deleteFrame());
                document.getElementById('reverseFrames').addEventListener('click', () => this.reverseFrames());

                // Crop controls
                document.getElementById('applyCrop').addEventListener('click', () => this.applyCrop());
                ['cropX', 'cropY', 'cropW', 'cropH'].forEach(id => {
                    document.getElementById(id).addEventListener('input', () => this.updateCropFromInputs());
                });

                // Resize controls
                document.getElementById('applyResize').addEventListener('click', () => this.applyResize());
                document.getElementById('resizeW').addEventListener('input', () => this.handleResizeInput('width'));
                document.getElementById('resizeH').addEventListener('input', () => this.handleResizeInput('height'));
                document.getElementById('resizePreset').addEventListener('change', (e) => {
                    const val = e.target.value;
                    if (!val) return;
                    const [w, h] = val.split('x').map(Number);
                    document.getElementById('resizeW').value = w;
                    document.getElementById('resizeH').value = h;
                });

                // Canvas expand
                document.getElementById('applyExpand').addEventListener('click', () => this.applyCanvasExpand());

                // Timing controls
                document.getElementById('applyDelaySelected').addEventListener('click', () => this.applyDelayToSelected());
                document.getElementById('applyDelayAll').addEventListener('click', () => this.applyDelayToAll());

                // Speed control
                document.getElementById('speedSlider').addEventListener('input', (e) => {
                    this.playbackSpeed = parseFloat(e.target.value);
                    document.getElementById('speedDisplay').textContent = this.playbackSpeed + 'x';
                });

                document.getElementById('qualitySlider').addEventListener('input', (e) => {
                    const v = parseInt(e.target.value);
                    const label = v <= 5 ? 'Best' : v <= 15 ? 'Good' : v <= 25 ? 'Fast' : 'Fastest';
                    document.getElementById('qualityDisplay').textContent = label;
                    this.updateSizeEstimate();
                });

                // Export settings that affect size estimate
                document.getElementById('colorCount').addEventListener('change', () => this.updateSizeEstimate());
                document.getElementById('ditherSelect').addEventListener('change', () => this.updateSizeEstimate());
                document.getElementById('exportFormat').addEventListener('change', () => this.syncTimingControls());

                // Export
                document.getElementById('exportBtn').addEventListener('click', event => {
                    const fmt = document.getElementById('exportFormat').value;
                    if (fmt === 'apng') this.exportAPNG(event.currentTarget);
                    else this.exportGIF(event.currentTarget);
                });
                document.getElementById('splitFramesBtn').addEventListener(
                    'click',
                    event => this.splitFramesToPNG(event.currentTarget)
                );
                document.getElementById('copyDiagnosticsBtn').addEventListener('click', () => this.copyDiagnostics());
                document.getElementById('requestPersistenceBtn').addEventListener(
                    'click',
                    () => this.requestPersistentStorage()
                );
                document.getElementById('shareBtn').addEventListener('click', async () => {
                    if (this.lastExportFile) {
                        try { await navigator.share({ files: [this.lastExportFile] }); } catch {}
                    }
                });
                document.getElementById('cancelExportBtn').addEventListener('click', () => {
                    if (this._activeExportJob) {
                        this.cancelExportJob();
                    } else {
                        this.closeExportModal();
                    }
                });

                // Filters
                const filterIds = ['filterBrightness', 'filterContrast', 'filterSaturate', 'filterHueRotate'];
                const filterUnits = ['%', '%', '%', '°'];
                filterIds.forEach((id, i) => {
                    document.getElementById(id).addEventListener('input', (e) => {
                        document.getElementById(id + 'Val').textContent = e.target.value + filterUnits[i];
                        this.previewFilters();
                    });
                });
                document.getElementById('resetFilters').addEventListener('click', () => {
                    document.getElementById('filterBrightness').value = 100;
                    document.getElementById('filterContrast').value = 100;
                    document.getElementById('filterSaturate').value = 100;
                    document.getElementById('filterHueRotate').value = 0;
                    document.getElementById('filterBrightnessVal').textContent = '100%';
                    document.getElementById('filterContrastVal').textContent = '100%';
                    document.getElementById('filterSaturateVal').textContent = '100%';
                    document.getElementById('filterHueRotateVal').textContent = '0°';
                    this.renderFrame();
                });
                document.getElementById('applyFilters').addEventListener('click', () => this.applyFilters());

                // Redaction
                document.getElementById('redactStrength').addEventListener('input', (e) => {
                    document.getElementById('redactStrengthVal').textContent = e.target.value + 'px';
                });
                document.getElementById('applyRedact').addEventListener('click', () => this.applyRedaction());

                // Background layer
                document.getElementById('bgType').addEventListener('change', (e) => {
                    document.getElementById('bgColorGroup').style.display = e.target.value === 'color' ? '' : 'none';
                    document.getElementById('bgImageGroup').style.display = e.target.value === 'image' ? '' : 'none';
                });
                document.getElementById('bgImageBtn').addEventListener('click', () => document.getElementById('bgImageInput').click());
                document.getElementById('bgImageInput').addEventListener('change', (e) => {
                    const file = e.target.files[0];
                    if (!file) return;
                    const img = new Image();
                    img.onload = () => {
                        this._bgImage = img;
                        document.getElementById('bgImageName').textContent = file.name;
                        URL.revokeObjectURL(img.src);
                    };
                    img.src = URL.createObjectURL(file);
                });
                document.getElementById('applyBackground').addEventListener('click', () => this.applyBackgroundLayer());

                // Optimize
                document.getElementById('optimizeLossy').addEventListener('input', (e) => {
                    document.getElementById('optimizeLossyVal').textContent = e.target.value;
                });
                document.getElementById('optimizeBtn').addEventListener(
                    'click',
                    event => this.optimizeGIF(event.currentTarget)
                );

                // Playback modes
                document.querySelectorAll('.playback-mode-btn').forEach(btn => {
                    btn.addEventListener('click', () => this.setPlaybackMode(btn.dataset.mode));
                });

                this.initCropInteraction();

                const sidebar = document.getElementById('sidebar');
                const overlay = document.getElementById('sidebarOverlay');
                const mobileMenuBtn = document.getElementById('mobileMenuBtn');
                mobileMenuBtn.addEventListener('click', () => {
                    this.setMobileDrawer(!sidebar.classList.contains('open'));
                });
                overlay.addEventListener('click', () => {
                    this.setMobileDrawer(false, true);
                });

                document.addEventListener('keydown', (e) => this.handleKeyboard(e));

                // Paste from clipboard
                document.addEventListener('paste', (e) => this.handlePaste(e));
            }

            setMobileDrawer(open, returnFocus = false) {
                const sidebar = document.getElementById('sidebar');
                const overlay = document.getElementById('sidebarOverlay');
                const button = document.getElementById('mobileMenuBtn');
                sidebar.classList.toggle('open', open);
                overlay.classList.toggle('active', open);
                button.setAttribute('aria-expanded', String(open));
                button.setAttribute('aria-label', open ? 'Close edit tools' : 'Open edit tools');
                if (open) {
                    requestAnimationFrame(() => {
                        const target = [...sidebar.querySelectorAll(
                            'button:not([disabled]), input:not([disabled]), select:not([disabled])'
                        )].find(element => element.offsetParent !== null);
                        (target || sidebar).focus();
                    });
                } else if (returnFocus) {
                    button.focus();
                }
            }

            openExportModal(title, returnFocus = document.activeElement) {
                const modal = document.getElementById('exportModal');
                this._modalReturnFocus = returnFocus;
                document.getElementById('exportModalTitle').textContent = title;
                modal.removeAttribute('inert');
                modal.classList.add('active');
                modal.setAttribute('aria-hidden', 'false');
                requestAnimationFrame(() => document.getElementById('cancelExportBtn').focus());
            }

            closeExportModal({ returnFocus = true } = {}) {
                const modal = document.getElementById('exportModal');
                modal.classList.remove('active');
                modal.setAttribute('aria-hidden', 'true');
                modal.setAttribute('inert', '');
                const returnTarget = returnFocus && this._modalReturnFocus?.isConnected
                    ? this._modalReturnFocus
                    : null;
                this._modalReturnFocus = null;
                if (returnTarget) {
                    const restoreFocus = () => {
                        if (returnTarget.isConnected && !returnTarget.disabled) {
                            returnTarget.focus({ preventScroll: true });
                        }
                    };
                    restoreFocus();
                    requestAnimationFrame(() => setTimeout(restoreFocus, 0));
                }
            }

            trapExportModalFocus(event) {
                if (event.key !== 'Tab') return false;
                const modal = document.getElementById('exportModal');
                if (!modal.classList.contains('active')) return false;
                const focusable = [...modal.querySelectorAll(
                    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
                )].filter(element => element.offsetParent !== null);
                if (focusable.length === 0) {
                    event.preventDefault();
                    modal.querySelector('[role="dialog"]').focus();
                    return true;
                }
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
                return true;
            }

            // ============================================
            // File Loading
            // ============================================

            setParseBusy(busy) {
                document.getElementById('dropIcon').style.display = busy ? 'none' : '';
                document.getElementById('dropText').style.display = busy ? 'none' : '';
                document.getElementById('parseSpinner').style.display = busy ? 'flex' : 'none';
            }

            async handleFileSelect(file) {
                this.fileInput.value = '';
                if (!file || file.type !== 'image/gif') {
                    this.showToast('Please select a valid GIF file', 'error');
                    return;
                }
                const token = this.beginOperation('GIF import');
                if (!token) return;
                this.setParseBusy(true);
                let project = null;

                try {
                    const buffer = await file.arrayBuffer();
                    this.assertOperationCurrent(token);
                    const gif = GifDecoder.parseGIF(buffer);
                    const gifW = gif.width, gifH = gif.height;
                    const budget = GifDecoder.validateBudget(gifW, gifH, gif.frames.length);
                    const rawGifMeta = gif.frames.map((f, i) => ({
                        index: i + 1,
                        left: f.left, top: f.top, width: f.width, height: f.height,
                        interlaced: f.interlaced,
                        paletteSize: f.colorTable ? f.colorTable.length : 0,
                        delay: f.graphicControl ? f.graphicControl.delay : 0,
                        disposal: f.graphicControl ? f.graphicControl.disposalMethod : 0,
                        transparent: f.graphicControl ? f.graphicControl.transparentFlag : 0
                    }));

                    if (typeof ImageDecoder !== 'undefined') {
                        try {
                            project = await this.decodeWithImageDecoder(buffer, token);
                            if (project) project.decoderPath = 'native ImageDecoder';
                        } catch (error) {
                            if (error.name === 'AbortError' || error.name === 'MemoryBudgetError') throw error;
                            project = null;
                        }
                    }

                    if (!project) {
                        this.preflightMemory('GIF import', {
                            width: gifW,
                            height: gifH,
                            frameCount: gif.frames.length,
                            temporaryCopies: 2
                        });
                        if (gifW > 4096 || gifH > 4096) {
                            this.showToast(`Warning: large dimensions ${gifW}×${gifH} — performance may be slow`, 'warning');
                        }
                        if (budget.decodedBytes > GifDecoder.limits.maxDecodedBytes * 0.75) {
                            this.showToast(`Warning: decoded frames require about ${this.formatBytes(budget.decodedBytes)}`, 'warning');
                        }

                        const frames = GifDecoder.decompressFrames(gif, true);
                        project = this.composeFrames(frames);
                        project.decoderPath = 'strict JavaScript parser';
                    }
                    project.rawGifMeta = rawGifMeta;

                    this.assertOperationCurrent(token);
                    if (!project || project.frames.length === 0) {
                        throw new Error('No frames found in GIF');
                    }
                    const filename = file.name.replace(/\.gif$/i, '') || 'edited';
                    project.filename = filename;
                    project.fileSize = file.size;
                    project.sourceFormat = 'GIF';
                    project.exportFilename = `${filename}-edited`;
                    this.commitProject(project, token);
                    const frameCount = project.frames.length;
                    project = null;
                    this.showToast(`Loaded ${frameCount} frames`, 'success');

                } catch (error) {
                    if (project) this.releaseFrames(project.frames);
                    if (error.name !== 'AbortError') {
                        console.error('Error loading GIF:', error);
                        this.showToast('Failed to load GIF: ' + error.message, 'error');
                    }
                } finally {
                    this.setParseBusy(false);
                    this.finishOperation(token);
                }
            }

            async decodeWithImageDecoder(buffer, token) {
                let decoder = null;
                const decodedFrames = [];
                try {
                    decoder = new ImageDecoder({ data: buffer, type: 'image/gif' });
                    await decoder.tracks.ready;
                    const track = decoder.tracks.selectedTrack;
                    if (!track || track.frameCount === 0) return false;

                    const frameCount = track.frameCount;
                    GifDecoder.validateBudget(1, 1, frameCount);
                    let width = 0;
                    let height = 0;

                    for (let i = 0; i < frameCount; i++) {
                        this.assertOperationCurrent(token);
                        const result = await decoder.decode({ frameIndex: i, completeFramesOnly: true });
                        const vf = result.image;
                        try {
                            this.assertOperationCurrent(token);
                            if (i === 0) {
                                width = vf.displayWidth;
                                height = vf.displayHeight;
                                GifDecoder.validateBudget(width, height, frameCount);
                                this.preflightMemory('GIF import', {
                                    width,
                                    height,
                                    frameCount,
                                    temporaryCopies: 2
                                });
                            } else if (vf.displayWidth !== width || vf.displayHeight !== height) {
                                throw new Error('Invalid GIF: native decoder returned inconsistent frame dimensions');
                            }
                            const c = document.createElement('canvas');
                            c.width = width;
                            c.height = height;
                            const ctx = c.getContext('2d');
                            ctx.drawImage(vf, 0, 0);
                            const delayMs = Math.round((vf.duration || 100000) / 1000);
                            decodedFrames.push({ canvas: c, delay: delayMs || 100, disposalType: 0 });
                        } finally {
                            vf.close();
                        }
                    }

                    if (decodedFrames.length === 0) return false;
                    return {
                        frames: decodedFrames,
                        width,
                        height,
                        currentFrame: 0,
                        rawGifMeta: null,
                        sourceFormat: 'GIF'
                    };
                } catch (error) {
                    decodedFrames.forEach(frame => this.releaseCanvas(frame.canvas));
                    throw error;
                } finally {
                    if (decoder) decoder.close();
                }
            }

            async handleImageFiles(files) {
                this.fileInput.value = '';
                const imageFiles = files.filter(f => f.type.startsWith('image/'));
                if (imageFiles.length === 0) {
                    this.showToast('No valid image files found', 'error');
                    return;
                }
                const token = this.beginOperation('Image import');
                if (!token) return;
                this.setParseBusy(true);
                let projectFrames = [];

                try {
                    const loadImage = (file) => new Promise((resolve, reject) => {
                        const img = new Image();
                        img.onload = () => { URL.revokeObjectURL(img.src); resolve(img); };
                        img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error(`Failed to load ${file.name}`)); };
                        img.src = URL.createObjectURL(file);
                    });

                    const images = await Promise.all(imageFiles.map(loadImage));
                    this.assertOperationCurrent(token);
                    const maxW = Math.max(...images.map(i => i.naturalWidth));
                    const maxH = Math.max(...images.map(i => i.naturalHeight));
                    GifDecoder.validateBudget(maxW, maxH, images.length);
                    this.preflightMemory('Image import', {
                        width: maxW,
                        height: maxH,
                        frameCount: images.length,
                        temporaryCopies: 1
                    });

                    images.forEach(img => {
                        this.assertOperationCurrent(token);
                        const c = document.createElement('canvas');
                        c.width = maxW;
                        c.height = maxH;
                        const ctx = c.getContext('2d');
                        const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight);
                        const w = img.naturalWidth * scale;
                        const h = img.naturalHeight * scale;
                        ctx.drawImage(img, (maxW - w) / 2, (maxH - h) / 2, w, h);
                        projectFrames.push({ canvas: c, delay: 100, disposalType: 0 });
                    });

                    const filename = imageFiles[0].name.replace(/\.[^.]+$/, '') || 'sequence';
                    this.commitProject({
                        frames: projectFrames,
                        width: maxW,
                        height: maxH,
                        currentFrame: 0,
                        rawGifMeta: null,
                        sourceFormat: 'Image sequence',
                        fileSize: imageFiles.reduce((sum, item) => sum + item.size, 0),
                        filename,
                        exportFilename: `${filename}-animated`
                    }, token);
                    projectFrames = [];
                    this.showToast(`Created GIF from ${images.length} images`, 'success');
                } catch (error) {
                    this.releaseFrames(projectFrames);
                    if (error.name !== 'AbortError') {
                        console.error('Error loading images:', error);
                        this.showToast('Failed to load images: ' + error.message, 'error');
                    }
                } finally {
                    this.setParseBusy(false);
                    this.finishOperation(token);
                }
            }

            async handlePaste(e) {
                const items = e.clipboardData?.items;
                if (!items) return;

                const imageItems = [];
                for (const item of items) {
                    if (item.type.startsWith('image/')) {
                        const file = item.getAsFile();
                        if (file) imageItems.push(file);
                    }
                }

                if (imageItems.length === 0) return;
                e.preventDefault();

                if (imageItems.length === 1 && imageItems[0].type === 'image/gif') {
                    this.handleFileSelect(imageItems[0]);
                } else if (this.frames.length > 0) {
                    const token = this.beginOperation('Paste');
                    if (!token) return;
                    const pastedFrames = [];
                    try {
                        GifDecoder.validateBudget(
                            this.originalWidth,
                            this.originalHeight,
                            this.frames.length + imageItems.length
                        );
                        this.preflightMemory('Paste frames', {
                            width: this.originalWidth,
                            height: this.originalHeight,
                            frameCount: this.frames.length + imageItems.length,
                            temporaryCopies: 1
                        });
                        for (const file of imageItems) {
                            this.assertOperationCurrent(token);
                            const img = await new Promise((resolve, reject) => {
                                const i = new Image();
                                i.onload = () => { URL.revokeObjectURL(i.src); resolve(i); };
                                i.onerror = () => { URL.revokeObjectURL(i.src); reject(new Error('Failed to load pasted image')); };
                                i.src = URL.createObjectURL(file);
                            });
                            this.assertOperationCurrent(token);
                            const c = document.createElement('canvas');
                            c.width = this.originalWidth;
                            c.height = this.originalHeight;
                            const ctx = c.getContext('2d');
                            const scale = Math.min(this.originalWidth / img.naturalWidth, this.originalHeight / img.naturalHeight);
                            const w = img.naturalWidth * scale;
                            const h = img.naturalHeight * scale;
                            ctx.drawImage(img, (this.originalWidth - w) / 2, (this.originalHeight - h) / 2, w, h);
                            pastedFrames.push({ canvas: c, delay: 100, disposalType: 0 });
                        }
                        this.assertOperationCurrent(token);
                        this.saveUndoState('Paste frames');
                        this.frames.splice(this.currentFrame + 1, 0, ...pastedFrames);
                        this._projectGeneration++;
                        this.renderTimeline();
                        this.goToFrame(this.currentFrame + 1);
                        this.showToast(`Pasted ${imageItems.length} frame${imageItems.length > 1 ? 's' : ''}`, 'success');
                        pastedFrames.length = 0;
                    } catch (err) {
                        this.releaseFrames(pastedFrames);
                        if (err.name !== 'AbortError') {
                            this.showToast('Failed to paste image: ' + err.message, 'error');
                        }
                    } finally {
                        this.finishOperation(token);
                    }
                } else {
                    // No existing project — create from pasted images
                    this.handleImageFiles(imageItems);
                }
            }

            releaseCanvas(canvas) {
                if (!canvas) return;
                const owners = this._canvasRefCounts.get(canvas);
                if (owners > 1) {
                    this._canvasRefCounts.set(canvas, owners - 1);
                    return;
                }
                if (owners === 1) this._canvasRefCounts.delete(canvas);
                canvas.width = 1;
                canvas.height = 1;
                const ctx = canvas.getContext('2d');
                if (ctx) ctx.clearRect(0, 0, 1, 1);
            }

            revokeBlob(url) {
                if (url) URL.revokeObjectURL(url);
            }

            composeFrames(rawFrames) {
                let maxWidth = 0, maxHeight = 0;
                rawFrames.forEach(f => {
                    maxWidth = Math.max(maxWidth, f.dims.left + f.dims.width);
                    maxHeight = Math.max(maxHeight, f.dims.top + f.dims.height);
                });
                GifDecoder.validateBudget(maxWidth, maxHeight, rawFrames.length);
                const composedFrames = [];

                // Create a temp canvas for compositing
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = maxWidth;
                tempCanvas.height = maxHeight;
                const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
                const restoreCanvas = document.createElement('canvas');
                restoreCanvas.width = maxWidth;
                restoreCanvas.height = maxHeight;
                const restoreCtx = restoreCanvas.getContext('2d', { willReadFrequently: true });

                try {
                    rawFrames.forEach((frame, index) => {
                        if (index === 0) {
                            tempCtx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);
                        }

                        if (frame.disposalType === 3) {
                            restoreCtx.clearRect(0, 0, restoreCanvas.width, restoreCanvas.height);
                            restoreCtx.drawImage(tempCanvas, 0, 0);
                        }

                        const frameImageData = new ImageData(
                            new Uint8ClampedArray(frame.patch),
                            frame.dims.width,
                            frame.dims.height
                        );
                        tempCtx.putImageData(frameImageData, frame.dims.left, frame.dims.top);

                        const frameCanvas = document.createElement('canvas');
                        frameCanvas.width = maxWidth;
                        frameCanvas.height = maxHeight;
                        const frameCtx = frameCanvas.getContext('2d');
                        frameCtx.drawImage(tempCanvas, 0, 0);

                        composedFrames.push({
                            canvas: frameCanvas,
                            delay: frame.delay * 10 || 100,
                            disposalType: frame.disposalType
                        });

                        if (frame.disposalType === 2) {
                            tempCtx.clearRect(frame.dims.left, frame.dims.top, frame.dims.width, frame.dims.height);
                        } else if (frame.disposalType === 3) {
                            tempCtx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);
                            tempCtx.drawImage(restoreCanvas, 0, 0);
                        }
                    });
                    return {
                        frames: composedFrames,
                        width: maxWidth,
                        height: maxHeight,
                        currentFrame: 0
                    };
                } catch (error) {
                    this.releaseFrames(composedFrames);
                    throw error;
                } finally {
                    this.releaseCanvas(tempCanvas);
                    this.releaseCanvas(restoreCanvas);
                }
            }

            setDropZoneActive(active) {
                this.dropZone.classList.toggle('hidden', !active);
                this.dropZone.inert = !active;
                if (active) {
                    this.dropZone.removeAttribute('aria-hidden');
                } else {
                    this.dropZone.setAttribute('aria-hidden', 'true');
                }
            }

            showEditor() {
                this.setDropZoneActive(false);
                this.canvasWrapper.style.display = 'block';
                this.timeline.style.display = 'flex';

                // Show sidebar sections
                document.getElementById('gifInfoSection').style.display = 'block';
                document.getElementById('cropSection').style.display = 'block';
                document.getElementById('resizeSection').style.display = 'block';
                document.getElementById('expandSection').style.display = 'block';
                document.getElementById('timingSection').style.display = 'block';
                document.getElementById('speedSection').style.display = 'block';
                document.getElementById('filtersSection').style.display = 'block';
                document.getElementById('redactSection').style.display = 'block';
                document.getElementById('backgroundSection').style.display = 'block';
                document.getElementById('exportSection').style.display = 'block';
                document.getElementById('optimizeSection').style.display = 'block';
                document.getElementById('analyzerSection').style.display = 'block';

                // Enable export
                document.getElementById('exportBtn').disabled = false;

                // Update UI
                this.updateGIFInfo();
                this.updateAnalyzer();
                this.updateResizeInputs();
                this.updateExpandInputs();
                this.updateCropInputs();
                this.renderTimeline();
                this.renderFrame();
                this.fitToView();
            }

            // ============================================
            // Rendering
            // ============================================

            renderFrame() {
                if (this.frames.length === 0) return;

                const frame = this.frames[this.currentFrame];
                this.canvas.width = this.originalWidth;
                this.canvas.height = this.originalHeight;
                this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
                this.ctx.drawImage(frame.canvas, 0, 0);

                // Apply zoom
                this.canvas.style.width = (this.originalWidth * this.zoom) + 'px';
                this.canvas.style.height = (this.originalHeight * this.zoom) + 'px';

                // Update UI
                document.getElementById('currentFrameNum').textContent = this.currentFrame + 1;
                document.getElementById('currentDelay').textContent = frame.delay;

                // Update timeline selection
                this.updateTimelineSelection();
            }

            renderTimeline() {
                if (this.thumbObserver) this.thumbObserver.disconnect();

                if (this.frames.length === 0) {
                    this.framesContainer.innerHTML = '<div class="empty-frames">No frames loaded</div>';
                    return;
                }

                document.getElementById('totalFrames').textContent = this.frames.length;
                this.framesContainer.innerHTML = '';

                this.thumbObserver = new IntersectionObserver((entries) => {
                    entries.forEach(entry => {
                        if (!entry.isIntersecting) return;
                        const item = entry.target;
                        const idx = parseInt(item.dataset.index);
                        const thumb = item.querySelector('.frame-thumb');
                        if (!thumb || thumb.dataset.drawn) return;
                        const frame = this.frames[idx];
                        if (!frame) return;
                        const thumbCtx = thumb.getContext('2d');
                        const scale = Math.min(80 / frame.canvas.width, 60 / frame.canvas.height);
                        const w = frame.canvas.width * scale, h = frame.canvas.height * scale;
                        thumbCtx.fillStyle = '#000';
                        thumbCtx.fillRect(0, 0, 80, 60);
                        thumbCtx.drawImage(frame.canvas, (80 - w) / 2, (60 - h) / 2, w, h);
                        thumb.dataset.drawn = '1';
                    });
                }, { root: this.framesContainer, rootMargin: '200px' });

                const frag = document.createDocumentFragment();

                this.frames.forEach((frame, index) => {
                    const item = document.createElement('div');
                    item.className = 'frame-item' + (index === this.currentFrame ? ' selected' : '');
                    item.draggable = true;
                    item.dataset.index = index;
                    item.id = `frame-option-${index}`;
                    item.setAttribute('role', 'option');
                    item.setAttribute('aria-selected', index === this.currentFrame ? 'true' : 'false');
                    item.setAttribute('aria-label', `Frame ${index + 1}, ${frame.delay}ms`);
                    item.setAttribute('aria-posinset', String(index + 1));
                    item.setAttribute('aria-setsize', String(this.frames.length));
                    item.tabIndex = index === this.currentFrame ? 0 : -1;

                    const thumb = document.createElement('canvas');
                    thumb.className = 'frame-thumb';
                    thumb.width = 80;
                    thumb.height = 60;

                    const info = document.createElement('div');
                    info.className = 'frame-info';
                    info.innerHTML = `<span class="frame-number">#${index + 1}</span><span>${frame.delay}ms</span>`;

                    const deleteBtn = document.createElement('button');
                    deleteBtn.className = 'frame-delete';
                    deleteBtn.innerHTML = '×';
                    deleteBtn.setAttribute('aria-label', `Delete frame ${index + 1}`);
                    deleteBtn.tabIndex = -1;
                    deleteBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.deleteFrameAt(index);
                    });

                    item.appendChild(thumb);
                    item.appendChild(info);
                    item.appendChild(deleteBtn);

                    item.addEventListener('click', (e) => {
                        if (e.shiftKey && this.frames.length > 0) {
                            const start = Math.min(this.currentFrame, index);
                            const end = Math.max(this.currentFrame, index);
                            this.selectedFrames.clear();
                            for (let i = start; i <= end; i++) this.selectedFrames.add(i);
                        } else if (e.ctrlKey || e.metaKey) {
                            if (this.selectedFrames.has(index)) this.selectedFrames.delete(index);
                            else this.selectedFrames.add(index);
                        } else {
                            this.selectedFrames.clear();
                        }
                        this.goToFrame(index);
                    });
                    item.addEventListener('keydown', event => this.handleTimelineKeydown(event, index));

                    item.addEventListener('dragstart', (e) => {
                        e.dataTransfer.setData('text/plain', index);
                        item.classList.add('dragging');
                    });
                    item.addEventListener('dragend', () => item.classList.remove('dragging'));
                    item.addEventListener('dragover', (e) => e.preventDefault());
                    item.addEventListener('drop', (e) => {
                        e.preventDefault();
                        const fromIndex = parseInt(e.dataTransfer.getData('text/plain'));
                        if (fromIndex !== index) this.reorderFrame(fromIndex, index);
                    });

                    frag.appendChild(item);
                    this.thumbObserver.observe(item);
                });

                this.framesContainer.appendChild(frag);
            }

            updateTimelineSelection() {
                const items = this.framesContainer.querySelectorAll('.frame-item');
                items.forEach((item, index) => {
                    const isCurrent = index === this.currentFrame;
                    const isMultiSelected = this.selectedFrames.has(index);
                    item.classList.toggle('selected', isCurrent || isMultiSelected);
                    item.setAttribute('aria-selected', isCurrent || isMultiSelected ? 'true' : 'false');
                    item.tabIndex = isCurrent ? 0 : -1;
                });
                this.framesContainer.setAttribute('aria-activedescendant', `frame-option-${this.currentFrame}`);

                const selected = this.framesContainer.querySelector('.frame-item.selected');
                if (selected) {
                    selected.scrollIntoView({
                        behavior: 'auto',
                        inline: 'center',
                        block: 'nearest'
                    });
                }
            }

            handleTimelineKeydown(event, index) {
                let target = null;
                if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                    target = Math.min(this.frames.length - 1, index + 1);
                } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                    target = Math.max(0, index - 1);
                } else if (event.key === 'Home') {
                    target = 0;
                } else if (event.key === 'End') {
                    target = this.frames.length - 1;
                } else if (event.key === 'Delete' || event.key === 'Backspace') {
                    event.preventDefault();
                    event.stopPropagation();
                    this.currentFrame = index;
                    this.confirmCurrentFrameDelete();
                    return;
                }
                if (target === null) return;
                event.preventDefault();
                event.stopPropagation();
                this.selectedFrames.clear();
                this.goToFrame(target);
                requestAnimationFrame(() => {
                    this.framesContainer.querySelector(`#frame-option-${target}`)?.focus();
                });
            }

            // ============================================
            // Playback
            // ============================================

            togglePlay() {
                if (this.isPlaying) {
                    this.stopPlayback();
                } else {
                    this.startPlayback();
                }
            }

            startPlayback() {
                if (this.frames.length < 2) return;

                this.isPlaying = true;
                document.getElementById('playIcon').innerHTML = '<use href="#icon-pause"/>';
                this.playNextFrame();
            }

            stopPlayback() {
                this.isPlaying = false;
                document.getElementById('playIcon').innerHTML = '<use href="#icon-play"/>';
                if (this.playInterval) {
                    clearTimeout(this.playInterval);
                    this.playInterval = null;
                }
            }

            playNextFrame() {
                if (!this.isPlaying) return;
                if (this.frames.length < 2) { this.stopPlayback(); return; }

                const frame = this.frames[this.currentFrame];
                if (!frame) { this.stopPlayback(); return; }
                const delay = frame.delay / this.playbackSpeed;

                this.playInterval = setTimeout(() => {
                    const len = this.frames.length;
                    if (len < 2) { this.stopPlayback(); return; }
                    if (this.playbackMode === 'normal') {
                        this.currentFrame = (this.currentFrame + 1) % len;
                    } else if (this.playbackMode === 'pingpong') {
                        const next = this.currentFrame + this.playDirection;
                        if (next >= len) {
                            this.playDirection = -1;
                            this.currentFrame = len - 2;
                        } else if (next < 0) {
                            this.playDirection = 1;
                            this.currentFrame = 1;
                        } else {
                            this.currentFrame = next;
                        }
                    } else if (this.playbackMode === 'boomerang') {
                        const next = this.currentFrame + this.playDirection;
                        if (next >= len) {
                            this.playDirection = -1;
                            this.currentFrame = Math.max(len - 2, 0);
                        } else if (next < 0) {
                            this.playDirection = 1;
                            this.currentFrame = 0;
                        } else {
                            this.currentFrame = next;
                        }
                    }
                    this.renderFrame();
                    this.playNextFrame();
                }, delay);
            }

            setPlaybackMode(mode) {
                this.playbackMode = mode;
                this.playDirection = 1;
                document.querySelectorAll('.playback-mode-btn').forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.mode === mode);
                });
            }

            goToFrame(index) {
                if (this.frames.length === 0) return;
                if (index < 0) index = this.frames.length - 1;
                if (index >= this.frames.length) index = 0;

                this.currentFrame = index;
                this.renderFrame();

                // Update delay input
                this.updateDelayInput();
            }

            // ============================================
            // Frame Operations
            // ============================================

            duplicateFrame() {
                if (this.frames.length === 0) return;
                if (!this.prepareMutation({
                    operation: 'Duplicate frame',
                    frameCount: this.frames.length + 1
                })) return;
                this.saveUndoState('Duplicate frame');

                const frame = this.frames[this.currentFrame];
                const newCanvas = document.createElement('canvas');
                newCanvas.width = frame.canvas.width;
                newCanvas.height = frame.canvas.height;
                newCanvas.getContext('2d').drawImage(frame.canvas, 0, 0);

                this.frames.splice(this.currentFrame + 1, 0, {
                    canvas: newCanvas,
                    delay: frame.delay,
                    disposalType: frame.disposalType
                });

                this.selectedFrames.clear();
                this.renderTimeline();
                this.goToFrame(this.currentFrame + 1);
                this.showToast('Frame duplicated', 'success');
            }

            deleteFrame() {
                if (!this.prepareMutation()) return;
                if (this.selectedFrames.size > 1) {
                    const indices = [...this.selectedFrames].sort((a, b) => b - a);
                    if (indices.length >= this.frames.length) {
                        this.showToast('Cannot delete all frames', 'warning');
                        return;
                    }
                    this.saveUndoState('Delete frames');
                    indices.forEach(i => {
                        this.releaseCanvas(this.frames[i].canvas);
                        this.frames.splice(i, 1);
                    });
                    this.selectedFrames.clear();
                    this.currentFrame = Math.min(this.currentFrame, this.frames.length - 1);
                    this.renderTimeline();
                    this.renderFrame();
                    this.updateGIFInfo();
                    this.showToast(`${indices.length} frames deleted`, 'success');
                    return;
                }
                this.deleteFrameAt(this.currentFrame, true);
            }

            confirmCurrentFrameDelete() {
                if (this.deleteConfirmPending) {
                    clearTimeout(this.deleteConfirmTimer);
                    this.deleteConfirmPending = false;
                    this.deleteFrame();
                } else {
                    this.deleteConfirmPending = true;
                    this.showToast('Press Delete again to confirm', 'warning');
                    this.deleteConfirmTimer = setTimeout(() => {
                        this.deleteConfirmPending = false;
                    }, 2000);
                }
            }

            deleteFrameAt(index, mutationPrepared = false) {
                if (this.frames.length <= 1) {
                    this.showToast('Cannot delete the last frame', 'warning');
                    return;
                }
                if (!mutationPrepared && !this.prepareMutation()) return;
                this.saveUndoState('Delete frame');

                this.releaseCanvas(this.frames[index].canvas);
                this.frames.splice(index, 1);
                
                if (this.currentFrame >= this.frames.length) {
                    this.currentFrame = this.frames.length - 1;
                }

                this.renderTimeline();
                this.renderFrame();
                this.updateGIFInfo();
                this.showToast('Frame deleted', 'success');
            }

            reorderFrame(fromIndex, toIndex) {
                if (!this.prepareMutation()) return;
                this.saveUndoState('Reorder frame');
                const [frame] = this.frames.splice(fromIndex, 1);
                this.frames.splice(toIndex, 0, frame);
                
                // Update current frame index
                if (this.currentFrame === fromIndex) {
                    this.currentFrame = toIndex;
                } else if (fromIndex < this.currentFrame && toIndex >= this.currentFrame) {
                    this.currentFrame--;
                } else if (fromIndex > this.currentFrame && toIndex <= this.currentFrame) {
                    this.currentFrame++;
                }

                this.selectedFrames.clear();
                this.renderTimeline();
                this.renderFrame();
            }

            reverseFrames() {
                if (this.frames.length < 2) return;
                if (!this.prepareMutation()) return;
                this.saveUndoState('Reverse frames');

                this.frames.reverse();
                this.currentFrame = this.frames.length - 1 - this.currentFrame;
                this.renderTimeline();
                this.renderFrame();
                this.showToast('Frames reversed', 'success');
            }

            // ============================================
            // Timing
            // ============================================

            applyDelayToSelected() {
                if (this.frames.length === 0 || !this.prepareMutation()) return;
                this.saveUndoState('Change frame delay');
                const delay = this.readDelayInput();
                const targets = (this.selectedFrames.size > 1
                    ? [...this.selectedFrames]
                    : [this.currentFrame]).filter(i => i < this.frames.length);
                targets.forEach(i => { this.frames[i].delay = delay; });
                this.renderTimeline();
                this.renderFrame();
                this.updateGIFInfo();
                this.showToast(`Delay applied to ${targets.length} frame${targets.length > 1 ? 's' : ''}`, 'success');
            }

            applyDelayToAll() {
                if (this.frames.length === 0 || !this.prepareMutation()) return;
                this.saveUndoState('Change all delays');
                const delay = this.readDelayInput();
                this.frames.forEach(f => f.delay = delay);
                this.renderTimeline();
                this.updateGIFInfo();
                this.showToast('Delay applied to all frames', 'success');
            }

            // ============================================
            // Crop
            // ============================================

            initCropInteraction() {
                const overlay = document.getElementById('cropOverlay');
                const box = document.getElementById('cropBox');

                overlay.addEventListener('mousedown', (e) => {
                    if (this.activeTool !== 'crop') return;
                    
                    const rect = overlay.getBoundingClientRect();
                    const x = (e.clientX - rect.left) / this.zoom;
                    const y = (e.clientY - rect.top) / this.zoom;

                    // Check if clicking on a handle
                    const handles = box.querySelectorAll('.crop-handle');
                    for (const handle of handles) {
                        const hRect = handle.getBoundingClientRect();
                        if (e.clientX >= hRect.left && e.clientX <= hRect.right &&
                            e.clientY >= hRect.top && e.clientY <= hRect.bottom) {
                            this.isDraggingCrop = true;
                            this.cropDragType = handle.className.replace('crop-handle ', '');
                            this.cropDragStart = { x: e.clientX, y: e.clientY };
                            return;
                        }
                    }

                    // Check if clicking inside box (move)
                    if (x >= this.cropRect.x && x <= this.cropRect.x + this.cropRect.w &&
                        y >= this.cropRect.y && y <= this.cropRect.y + this.cropRect.h) {
                        this.isDraggingCrop = true;
                        this.cropDragType = 'move';
                        this.cropDragStart = { x: e.clientX, y: e.clientY };
                    }
                });

                document.addEventListener('mousemove', (e) => {
                    if (!this.isDraggingCrop) return;

                    const dx = (e.clientX - this.cropDragStart.x) / this.zoom;
                    const dy = (e.clientY - this.cropDragStart.y) / this.zoom;
                    this.cropDragStart = { x: e.clientX, y: e.clientY };
                    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

                    switch (this.cropDragType) {
                        case 'move':
                            this.cropRect.x = Math.max(0, Math.min(this.originalWidth - this.cropRect.w, this.cropRect.x + dx));
                            this.cropRect.y = Math.max(0, Math.min(this.originalHeight - this.cropRect.h, this.cropRect.y + dy));
                            break;
                        case 'nw':
                            const right = this.cropRect.x + this.cropRect.w;
                            const bottom = this.cropRect.y + this.cropRect.h;
                            const newX = clamp(this.cropRect.x + dx, 0, right - 10);
                            const newY = clamp(this.cropRect.y + dy, 0, bottom - 10);
                            this.cropRect.x = newX;
                            this.cropRect.y = newY;
                            this.cropRect.w = right - newX;
                            this.cropRect.h = bottom - newY;
                            break;
                        case 'ne':
                            const bottomNe = this.cropRect.y + this.cropRect.h;
                            this.cropRect.w = clamp(this.cropRect.w + dx, 10, this.originalWidth - this.cropRect.x);
                            const newYne = clamp(this.cropRect.y + dy, 0, bottomNe - 10);
                            this.cropRect.y = newYne;
                            this.cropRect.h = bottomNe - newYne;
                            break;
                        case 'sw':
                            const rightSw = this.cropRect.x + this.cropRect.w;
                            const newXsw = clamp(this.cropRect.x + dx, 0, rightSw - 10);
                            this.cropRect.x = newXsw;
                            this.cropRect.w = rightSw - newXsw;
                            this.cropRect.h = clamp(this.cropRect.h + dy, 10, this.originalHeight - this.cropRect.y);
                            break;
                        case 'se':
                            this.cropRect.w = clamp(this.cropRect.w + dx, 10, this.originalWidth - this.cropRect.x);
                            this.cropRect.h = clamp(this.cropRect.h + dy, 10, this.originalHeight - this.cropRect.y);
                            break;
                    }

                    this.cropRect.w = Math.max(10, this.cropRect.w);
                    this.cropRect.h = Math.max(10, this.cropRect.h);
                    this.updateCropBox();
                    this.updateCropInputs();
                });

                document.addEventListener('mouseup', () => {
                    this.isDraggingCrop = false;
                    this.cropDragType = null;
                });
            }

            updateCropBox() {
                const box = document.getElementById('cropBox');
                box.style.left = (this.cropRect.x * this.zoom) + 'px';
                box.style.top = (this.cropRect.y * this.zoom) + 'px';
                box.style.width = (this.cropRect.w * this.zoom) + 'px';
                box.style.height = (this.cropRect.h * this.zoom) + 'px';
            }

            updateCropInputs() {
                document.getElementById('cropX').value = Math.round(this.cropRect.x);
                document.getElementById('cropY').value = Math.round(this.cropRect.y);
                document.getElementById('cropW').value = Math.round(this.cropRect.w);
                document.getElementById('cropH').value = Math.round(this.cropRect.h);
            }

            updateCropFromInputs() {
                this.cropRect.x = parseInt(document.getElementById('cropX').value) || 0;
                this.cropRect.y = parseInt(document.getElementById('cropY').value) || 0;
                this.cropRect.w = parseInt(document.getElementById('cropW').value) || 10;
                this.cropRect.h = parseInt(document.getElementById('cropH').value) || 10;

                // Clamp values
                this.cropRect.x = Math.max(0, Math.min(this.originalWidth - 10, this.cropRect.x));
                this.cropRect.y = Math.max(0, Math.min(this.originalHeight - 10, this.cropRect.y));
                this.cropRect.w = Math.max(10, Math.min(this.originalWidth - this.cropRect.x, this.cropRect.w));
                this.cropRect.h = Math.max(10, Math.min(this.originalHeight - this.cropRect.y, this.cropRect.h));

                this.updateCropBox();
            }

            applyCrop() {
                if (this.frames.length === 0) return;
                if (!this.prepareMutation()) return;
                this.saveUndoState('Crop');

                const x = Math.round(this.cropRect.x), y = Math.round(this.cropRect.y);
                const w = Math.round(this.cropRect.w), h = Math.round(this.cropRect.h);

                this.frames.forEach(frame => {
                    const newCanvas = document.createElement('canvas');
                    newCanvas.width = w;
                    newCanvas.height = h;
                    const ctx = newCanvas.getContext('2d');
                    ctx.drawImage(frame.canvas, -x, -y);
                    this.releaseCanvas(frame.canvas);
                    frame.canvas = newCanvas;
                });

                this.originalWidth = w;
                this.originalHeight = h;
                this.cropRect = { x: 0, y: 0, w, h };

                this.updateGIFInfo();
                this.updateResizeInputs();
                this.updateCropInputs();
                this.renderTimeline();
                this.renderFrame();
                this.fitToView();
                this.showToast('Crop applied', 'success');
            }

            // ============================================
            // Resize
            // ============================================

            updateResizeInputs() {
                document.getElementById('resizeW').value = this.originalWidth;
                document.getElementById('resizeH').value = this.originalHeight;
            }

            handleResizeInput(dimension) {
                if (!document.getElementById('lockAspect').checked) return;
                if (!this.originalWidth || !this.originalHeight) return;

                const aspect = this.originalWidth / this.originalHeight;
                
                if (dimension === 'width') {
                    const w = parseInt(document.getElementById('resizeW').value) || 1;
                    document.getElementById('resizeH').value = Math.round(w / aspect);
                } else {
                    const h = parseInt(document.getElementById('resizeH').value) || 1;
                    document.getElementById('resizeW').value = Math.round(h * aspect);
                }
            }

            applyResize() {
                if (this.frames.length === 0) return;

                const newWidth = parseInt(document.getElementById('resizeW').value) || this.originalWidth;
                const newHeight = parseInt(document.getElementById('resizeH').value) || this.originalHeight;

                if (newWidth === this.originalWidth && newHeight === this.originalHeight) return;
                const currentArea = this.originalWidth * this.originalHeight;
                const targetArea = newWidth * newHeight;
                if (!this.prepareMutation({
                    operation: 'Resize',
                    width: targetArea >= currentArea ? newWidth : this.originalWidth,
                    height: targetArea >= currentArea ? newHeight : this.originalHeight
                })) return;
                this.saveUndoState('Resize');

                this.frames.forEach(frame => {
                    const newCanvas = document.createElement('canvas');
                    newCanvas.width = newWidth;
                    newCanvas.height = newHeight;
                    const ctx = newCanvas.getContext('2d');
                    ctx.imageSmoothingQuality = 'high';
                    ctx.drawImage(frame.canvas, 0, 0, newWidth, newHeight);
                    this.releaseCanvas(frame.canvas);
                    frame.canvas = newCanvas;
                });

                this.originalWidth = newWidth;
                this.originalHeight = newHeight;
                this.cropRect = { x: 0, y: 0, w: newWidth, h: newHeight };

                this.updateGIFInfo();
                this.updateCropInputs();
                this.renderTimeline();
                this.renderFrame();
                this.fitToView();
                this.showToast(`Resized to ${newWidth}×${newHeight}`, 'success');
            }

            updateExpandInputs() {
                document.getElementById('expandW').value = this.originalWidth;
                document.getElementById('expandH').value = this.originalHeight;
            }

            applyCanvasExpand() {
                if (this.frames.length === 0) return;

                const newW = parseInt(document.getElementById('expandW').value) || this.originalWidth;
                const newH = parseInt(document.getElementById('expandH').value) || this.originalHeight;

                if (newW <= this.originalWidth && newH <= this.originalHeight) {
                    this.showToast('New dimensions must be larger than current canvas', 'warning');
                    return;
                }
                if (!this.prepareMutation({
                    operation: 'Canvas expand',
                    width: newW,
                    height: newH
                })) return;
                this.saveUndoState('Canvas expand');

                const anchor = document.getElementById('expandAnchor').value;
                const bgColor = document.getElementById('expandColor').value.trim();
                const isTransparent = bgColor.toLowerCase() === 'transparent' || bgColor === '';

                const oW = this.originalWidth, oH = this.originalHeight;
                let ox = 0, oy = 0;
                if (anchor.includes('right')) ox = newW - oW;
                else if (!anchor.includes('left')) ox = Math.round((newW - oW) / 2);
                if (anchor.includes('bottom')) oy = newH - oH;
                else if (!anchor.includes('top')) oy = Math.round((newH - oH) / 2);

                this.frames.forEach(frame => {
                    const newCanvas = document.createElement('canvas');
                    newCanvas.width = newW;
                    newCanvas.height = newH;
                    const ctx = newCanvas.getContext('2d');
                    if (!isTransparent) {
                        ctx.fillStyle = bgColor;
                        ctx.fillRect(0, 0, newW, newH);
                    }
                    ctx.drawImage(frame.canvas, ox, oy);
                    this.releaseCanvas(frame.canvas);
                    frame.canvas = newCanvas;
                });

                this.originalWidth = newW;
                this.originalHeight = newH;
                this.cropRect = { x: 0, y: 0, w: newW, h: newH };

                this.updateGIFInfo();
                this.updateResizeInputs();
                this.updateExpandInputs();
                this.updateCropInputs();
                this.renderTimeline();
                this.renderFrame();
                this.fitToView();
                this.showToast(`Canvas expanded to ${newW}×${newH}`, 'success');
            }

            // ============================================
            // Transforms
            // ============================================

            flipHorizontal() {
                if (this.frames.length === 0) return;
                if (!this.prepareMutation()) return;
                this.saveUndoState('Flip horizontal');

                this.frames.forEach(frame => {
                    const newCanvas = document.createElement('canvas');
                    newCanvas.width = frame.canvas.width;
                    newCanvas.height = frame.canvas.height;
                    const ctx = newCanvas.getContext('2d');
                    ctx.translate(newCanvas.width, 0);
                    ctx.scale(-1, 1);
                    ctx.drawImage(frame.canvas, 0, 0);
                    this.releaseCanvas(frame.canvas);
                    frame.canvas = newCanvas;
                });

                this.renderTimeline();
                this.renderFrame();
                this.showToast('Flipped horizontally', 'success');
            }

            flipVertical() {
                if (this.frames.length === 0) return;
                if (!this.prepareMutation()) return;
                this.saveUndoState('Flip vertical');

                this.frames.forEach(frame => {
                    const newCanvas = document.createElement('canvas');
                    newCanvas.width = frame.canvas.width;
                    newCanvas.height = frame.canvas.height;
                    const ctx = newCanvas.getContext('2d');
                    ctx.translate(0, newCanvas.height);
                    ctx.scale(1, -1);
                    ctx.drawImage(frame.canvas, 0, 0);
                    this.releaseCanvas(frame.canvas);
                    frame.canvas = newCanvas;
                });

                this.renderTimeline();
                this.renderFrame();
                this.showToast('Flipped vertically', 'success');
            }

            rotate90() {
                if (this.frames.length === 0) return;
                if (!this.prepareMutation()) return;
                this.saveUndoState('Rotate 90');

                this.frames.forEach(frame => {
                    const newCanvas = document.createElement('canvas');
                    newCanvas.width = frame.canvas.height;
                    newCanvas.height = frame.canvas.width;
                    const ctx = newCanvas.getContext('2d');
                    ctx.translate(newCanvas.width / 2, newCanvas.height / 2);
                    ctx.rotate(Math.PI / 2);
                    ctx.drawImage(frame.canvas, -frame.canvas.width / 2, -frame.canvas.height / 2);
                    this.releaseCanvas(frame.canvas);
                    frame.canvas = newCanvas;
                });

                [this.originalWidth, this.originalHeight] = [this.originalHeight, this.originalWidth];
                this.cropRect = { x: 0, y: 0, w: this.originalWidth, h: this.originalHeight };

                this.updateGIFInfo();
                this.updateResizeInputs();
                this.updateCropInputs();
                this.renderTimeline();
                this.renderFrame();
                this.fitToView();
                this.showToast('Rotated 90°', 'success');
            }

            // ============================================
            // Filters
            // ============================================

            getFilterString() {
                const b = document.getElementById('filterBrightness').value;
                const c = document.getElementById('filterContrast').value;
                const s = document.getElementById('filterSaturate').value;
                const h = document.getElementById('filterHueRotate').value;
                if (b == 100 && c == 100 && s == 100 && h == 0) return '';
                return `brightness(${b}%) contrast(${c}%) saturate(${s}%) hue-rotate(${h}deg)`;
            }

            previewFilters() {
                if (this.frames.length === 0) return;
                const filterStr = this.getFilterString();
                const frame = this.frames[this.currentFrame];
                this.canvas.width = this.originalWidth;
                this.canvas.height = this.originalHeight;
                this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
                this.ctx.filter = filterStr || 'none';
                this.ctx.drawImage(frame.canvas, 0, 0);
                this.ctx.filter = 'none';
                this.canvas.style.width = (this.originalWidth * this.zoom) + 'px';
                this.canvas.style.height = (this.originalHeight * this.zoom) + 'px';
            }

            applyFilters() {
                if (this.frames.length === 0) return;
                const filterStr = this.getFilterString();
                if (!filterStr) {
                    this.showToast('No filter changes to apply', 'warning');
                    return;
                }
                if (!this.prepareMutation()) return;
                this.saveUndoState('Apply filters');
                this.frames.forEach(frame => {
                    const newCanvas = document.createElement('canvas');
                    newCanvas.width = frame.canvas.width;
                    newCanvas.height = frame.canvas.height;
                    const ctx = newCanvas.getContext('2d');
                    ctx.filter = filterStr;
                    ctx.drawImage(frame.canvas, 0, 0);
                    ctx.filter = 'none';
                    this.releaseCanvas(frame.canvas);
                    frame.canvas = newCanvas;
                });
                document.getElementById('filterBrightness').value = 100;
                document.getElementById('filterContrast').value = 100;
                document.getElementById('filterSaturate').value = 100;
                document.getElementById('filterHueRotate').value = 0;
                document.getElementById('filterBrightnessVal').textContent = '100%';
                document.getElementById('filterContrastVal').textContent = '100%';
                document.getElementById('filterSaturateVal').textContent = '100%';
                document.getElementById('filterHueRotateVal').textContent = '0°';
                this.renderTimeline();
                this.renderFrame();
                this.showToast('Filters applied to all frames', 'success');
            }

            // ============================================
            // Redaction
            // ============================================

            applyRedaction() {
                if (this.frames.length === 0) return;

                const mode = document.getElementById('redactMode').value;
                const strength = parseInt(document.getElementById('redactStrength').value) || 12;
                const scope = document.getElementById('redactScope').value;
                const { x, y, w, h } = this.cropRect;
                const rx = Math.round(x), ry = Math.round(y), rw = Math.round(w), rh = Math.round(h);

                if (rw < 4 || rh < 4) {
                    this.showToast('Select a larger region to redact', 'warning');
                    return;
                }

                if (!this.prepareMutation()) return;
                this.saveUndoState('Redact');

                let targets;
                if (scope === 'current') targets = [this.currentFrame];
                else if (scope === 'selected' && this.selectedFrames.size > 0) targets = [...this.selectedFrames];
                else targets = this.frames.map((_, i) => i);

                targets.forEach(i => {
                    const frame = this.ensureWritableFrame(i);
                    const ctx = frame.canvas.getContext('2d', { willReadFrequently: true });

                    if (mode === 'black') {
                        ctx.fillStyle = '#000';
                        ctx.fillRect(rx, ry, rw, rh);
                    } else if (mode === 'pixelate') {
                        const blockSize = strength;
                        const imgData = ctx.getImageData(rx, ry, rw, rh);
                        const d = imgData.data;
                        for (let by = 0; by < rh; by += blockSize) {
                            for (let bx = 0; bx < rw; bx += blockSize) {
                                let tr = 0, tg = 0, tb = 0, count = 0;
                                const bw = Math.min(blockSize, rw - bx);
                                const bh = Math.min(blockSize, rh - by);
                                for (let py = 0; py < bh; py++) {
                                    for (let px = 0; px < bw; px++) {
                                        const idx = ((by + py) * rw + (bx + px)) * 4;
                                        tr += d[idx]; tg += d[idx + 1]; tb += d[idx + 2]; count++;
                                    }
                                }
                                tr = Math.round(tr / count); tg = Math.round(tg / count); tb = Math.round(tb / count);
                                for (let py = 0; py < bh; py++) {
                                    for (let px = 0; px < bw; px++) {
                                        const idx = ((by + py) * rw + (bx + px)) * 4;
                                        d[idx] = tr; d[idx + 1] = tg; d[idx + 2] = tb;
                                    }
                                }
                            }
                        }
                        ctx.putImageData(imgData, rx, ry);
                    } else if (mode === 'blur') {
                        const passes = Math.max(1, Math.round(strength / 4));
                        const tempCanvas = document.createElement('canvas');
                        tempCanvas.width = rw;
                        tempCanvas.height = rh;
                        const tctx = tempCanvas.getContext('2d');
                        tctx.drawImage(frame.canvas, rx, ry, rw, rh, 0, 0, rw, rh);
                        for (let p = 0; p < passes; p++) {
                            tctx.drawImage(tempCanvas, 0, 0, rw, rh, -1, -1, rw + 2, rh + 2);
                        }
                        ctx.drawImage(tempCanvas, 0, 0, rw, rh, rx, ry, rw, rh);
                        this.releaseCanvas(tempCanvas);
                    }
                });

                this.renderTimeline();
                this.renderFrame();
                this.showToast(`Redaction applied to ${targets.length} frame${targets.length > 1 ? 's' : ''}`, 'success');
            }

            applyBackgroundLayer() {
                if (this.frames.length === 0) return;
                const bgType = document.getElementById('bgType').value;
                if (bgType === 'none') {
                    this.showToast('Select a background type first', 'warning');
                    return;
                }

                if (!this.prepareMutation()) return;
                this.saveUndoState('Background layer');

                this.frames.forEach(frame => {
                    const newCanvas = document.createElement('canvas');
                    newCanvas.width = frame.canvas.width;
                    newCanvas.height = frame.canvas.height;
                    const ctx = newCanvas.getContext('2d');

                    if (bgType === 'color') {
                        ctx.fillStyle = document.getElementById('bgColorPicker').value || '#000000';
                        ctx.fillRect(0, 0, newCanvas.width, newCanvas.height);
                    } else if (bgType === 'image' && this._bgImage) {
                        const scale = Math.max(newCanvas.width / this._bgImage.naturalWidth, newCanvas.height / this._bgImage.naturalHeight);
                        const w = this._bgImage.naturalWidth * scale;
                        const h = this._bgImage.naturalHeight * scale;
                        ctx.drawImage(this._bgImage, (newCanvas.width - w) / 2, (newCanvas.height - h) / 2, w, h);
                    }

                    ctx.drawImage(frame.canvas, 0, 0);
                    this.releaseCanvas(frame.canvas);
                    frame.canvas = newCanvas;
                });

                this.renderTimeline();
                this.renderFrame();
                this.showToast('Background applied to all frames', 'success');
            }

            // ============================================
            // Zoom
            // ============================================

            setZoom(level) {
                this.zoom = Math.max(0.25, Math.min(4, level));
                document.getElementById('zoomDisplay').textContent = Math.round(this.zoom * 100) + '%';
                this.renderFrame();
                if (this.activeTool === 'crop') {
                    this.updateCropBox();
                }
            }

            fitToView() {
                const container = document.querySelector('.canvas-container');
                const padding = 80;
                const availableWidth = container.clientWidth - padding;
                const availableHeight = container.clientHeight - padding;
                
                const scaleX = availableWidth / this.originalWidth;
                const scaleY = availableHeight / this.originalHeight;
                const scale = Math.min(scaleX, scaleY, 2);
                
                this.setZoom(scale);
            }

            // ============================================
            // Tools
            // ============================================

            setActiveTool(tool) {
                this.activeTool = tool;

                document.querySelectorAll('.tool-btn').forEach(btn => btn.classList.remove('active'));
                document.getElementById('tool' + tool.charAt(0).toUpperCase() + tool.slice(1)).classList.add('active');

                const cropOverlay = document.getElementById('cropOverlay');
                if (tool === 'crop' || tool === 'redact') {
                    this.setSidebarSectionExpanded(
                        tool === 'crop' ? 'cropSection' : 'redactSection',
                        true
                    );
                    cropOverlay.classList.add('active');
                    this.cropRect = { x: 0, y: 0, w: this.originalWidth || 100, h: this.originalHeight || 100 };
                    this.updateCropBox();
                    this.updateCropInputs();
                } else {
                    cropOverlay.classList.remove('active');
                }
            }

            cloneFrame(frame) {
                const canvas = document.createElement('canvas');
                canvas.width = frame.canvas.width;
                canvas.height = frame.canvas.height;
                canvas.getContext('2d').drawImage(frame.canvas, 0, 0);
                return { canvas, delay: frame.delay, disposalType: frame.disposalType };
            }

            setExportControlsLocked(locked) {
                const ids = [
                    'importBtn', 'fileInput', 'undoBtn', 'redoBtn',
                    'flipH', 'flipV', 'rotate', 'duplicateFrame', 'deleteFrame', 'reverseFrames',
                    'applyCrop', 'applyResize', 'applyExpand', 'applyDelaySelected', 'applyDelayAll',
                    'applyFilters', 'applyRedact', 'applyBackground', 'exportBtn',
                    'splitFramesBtn', 'optimizeBtn'
                ];
                if (locked) {
                    this._exportControlStates = new Map();
                    ids.forEach(id => {
                        const element = document.getElementById(id);
                        if (!element) return;
                        this._exportControlStates.set(element, element.disabled);
                        element.disabled = true;
                    });
                } else if (this._exportControlStates) {
                    this._exportControlStates.forEach((wasDisabled, element) => {
                        element.disabled = wasDisabled;
                    });
                    this._exportControlStates = null;
                }
            }

            beginExportJob(
                kind,
                temporaryCopies = kind === 'GIF optimization' ? 4 : 3,
                returnFocus = document.activeElement
            ) {
                if (this.frames.length === 0) return null;
                if (this._activeOperation) {
                    this.showToast(`Wait for ${this._activeOperation.kind} to finish`, 'warning');
                    return null;
                }
                if (this._activeExportJob) {
                    this.showToast('Another export is already running', 'warning');
                    return null;
                }

                this.stopPlayback();
                const memoryEstimate = this.preflightMemory(kind, {
                    width: this.originalWidth,
                    height: this.originalHeight,
                    frameCount: this.frames.length,
                    temporaryCopies
                });
                const snapshotFrames = [];
                try {
                    this.frames.forEach(frame => snapshotFrames.push(this.cloneFrame(frame)));
                } catch (error) {
                    this.releaseFrames(snapshotFrames);
                    throw error;
                }

                let resolveCancel;
                const cancelSignal = new Promise(resolve => {
                    resolveCancel = resolve;
                });
                const job = {
                    id: ++this._exportGeneration,
                    kind,
                    frames: snapshotFrames,
                    width: this.originalWidth,
                    height: this.originalHeight,
                    projectGeneration: this._projectGeneration,
                    startedAt: performance.now(),
                    progress: 0,
                    maxFrameBlockMs: 0,
                    memoryEstimate,
                    cancelled: false,
                    cancelReason: '',
                    encoder: null,
                    returnFocus,
                    cancelSignal,
                    resolveCancel
                };
                this._activeExportJob = job;
                this.setExportControlsLocked(true);
                return job;
            }

            isExportJobCurrent(job) {
                return !!job &&
                    !job.cancelled &&
                    this._activeExportJob === job &&
                    job.id === this._exportGeneration;
            }

            assertExportJobCurrent(job) {
                if (!this.isExportJobCurrent(job)) {
                    const error = new Error(job?.cancelReason || 'Aborted');
                    error.name = 'AbortError';
                    throw error;
                }
            }

            updateExportProgress(job, percent, message, progress, status) {
                this.assertExportJobCurrent(job);
                job.progress = Math.max(job.progress, Math.min(100, percent));
                if (progress) progress.style.width = `${job.progress}%`;
                if (status && message) status.textContent = message;
            }

            async waitForExportTask(job, task) {
                const outcome = await Promise.race([
                    Promise.resolve(task).then(value => ({ value })),
                    job.cancelSignal.then(() => ({ cancelled: true }))
                ]);
                if (outcome.cancelled) this.assertExportJobCurrent(job);
                return outcome.value;
            }

            cancelExportJob(reason = 'Export cancelled') {
                const job = this._activeExportJob;
                if (!job || job.cancelled) return;
                job.cancelled = true;
                job.cancelReason = reason;
                job.resolveCancel();
                if (job.encoder) job.encoder.abort();
                if (this.currentEncoder) this.currentEncoder.abort();
                const status = document.getElementById('exportStatus');
                if (status) status.textContent = 'Cancelling...';
            }

            finishExportJob(job) {
                if (!job) return;
                this.releaseFrames(job.frames);
                job.frames = [];
                if (this._activeExportJob === job) {
                    this.lastExportProfile = {
                        kind: job.kind,
                        durationMs: Math.round(performance.now() - job.startedAt),
                        maxFrameBlockMs: Math.round(job.maxFrameBlockMs),
                        cancelled: job.cancelled
                    };
                    this._activeExportJob = null;
                    this.currentEncoder = null;
                    this.setExportControlsLocked(false);
                }
            }

            async validateGIFOutput(blob, job) {
                try {
                    const buffer = await blob.arrayBuffer();
                    const gif = GifDecoder.parseGIF(buffer);
                    if (gif.width !== job.width || gif.height !== job.height) {
                        throw new Error(`dimensions are ${gif.width}×${gif.height}, expected ${job.width}×${job.height}`);
                    }
                    if (gif.frames.length !== job.frames.length) {
                        throw new Error(`frame count is ${gif.frames.length}, expected ${job.frames.length}`);
                    }
                    const actualDelays = gif.frames.map(frame => (frame.graphicControl?.delay || 0) * 10);
                    const expectedDelays = job.frames.map(frame => this.getEncodedDelayMs(frame.delay, 'gif'));
                    if (actualDelays.some((delay, index) => delay !== expectedDelays[index])) {
                        throw new Error('encoded frame delays do not match the GIF timing model');
                    }
                    return {
                        format: 'GIF',
                        width: gif.width,
                        height: gif.height,
                        frameCount: gif.frames.length,
                        duration: actualDelays.reduce((sum, delay) => sum + delay, 0),
                        bytes: blob.size
                    };
                } catch (error) {
                    throw new Error(`Output validation failed: ${error.message}`);
                }
            }

            async validateAPNGOutput(blob, job) {
                try {
                    const bytes = new Uint8Array(await blob.arrayBuffer());
                    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
                    if (bytes.length < 8 || signature.some((value, index) => bytes[index] !== value)) {
                        throw new Error('PNG signature is missing');
                    }
                    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                    let offset = 8;
                    let width = 0;
                    let height = 0;
                    let animationFrames = 0;
                    const frameControls = [];
                    let sawEnd = false;
                    while (offset + 12 <= bytes.length) {
                        const length = view.getUint32(offset);
                        if (offset + 12 + length > bytes.length) throw new Error('PNG chunk is truncated');
                        const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
                        const dataOffset = offset + 8;
                        if (type === 'IHDR') {
                            width = view.getUint32(dataOffset);
                            height = view.getUint32(dataOffset + 4);
                        } else if (type === 'acTL') {
                            animationFrames = view.getUint32(dataOffset);
                        } else if (type === 'fcTL') {
                            if (length !== 26) throw new Error('APNG frame control has an invalid length');
                            const frameWidth = view.getUint32(dataOffset + 4);
                            const frameHeight = view.getUint32(dataOffset + 8);
                            const xOffset = view.getUint32(dataOffset + 12);
                            const yOffset = view.getUint32(dataOffset + 16);
                            if (!frameWidth || !frameHeight || xOffset + frameWidth > width || yOffset + frameHeight > height) {
                                throw new Error('APNG frame control exceeds the canvas');
                            }
                            const delayNumerator = view.getUint16(dataOffset + 20);
                            const delayDenominator = view.getUint16(dataOffset + 22) || 100;
                            frameControls.push({
                                delay: delayNumerator * 1000 / delayDenominator
                            });
                        } else if (type === 'IEND') {
                            sawEnd = true;
                            break;
                        }
                        offset += 12 + length;
                    }
                    if (!sawEnd) throw new Error('PNG end chunk is missing');
                    if (width !== job.width || height !== job.height) {
                        throw new Error(`dimensions are ${width}×${height}, expected ${job.width}×${job.height}`);
                    }
                    if (!animationFrames || animationFrames !== frameControls.length) {
                        throw new Error(`animation declares ${animationFrames} frames but contains ${frameControls.length} controls`);
                    }
                    const expectedDuration = job.frames.reduce(
                        (sum, frame) => sum + this.getEncodedDelayMs(frame.delay, 'apng'),
                        0
                    );
                    const actualDuration = frameControls.reduce((sum, frame) => sum + frame.delay, 0);
                    const durationTolerance = Math.max(2, animationFrames);
                    if (Math.abs(actualDuration - expectedDuration) > durationTolerance) {
                        throw new Error(`duration is ${Math.round(actualDuration)}ms, expected ${expectedDuration}ms`);
                    }
                    return {
                        format: 'APNG',
                        width,
                        height,
                        frameCount: animationFrames,
                        duration: actualDuration,
                        bytes: blob.size
                    };
                } catch (error) {
                    throw new Error(`Output validation failed: ${error.message}`);
                }
            }

            recordOutputValidation(validation) {
                this.lastOutputValidation = validation;
                this.updateSizeEstimate(validation.bytes);
                this.updateAnalyzer();
            }

            // ============================================
            // Export
            // ============================================

            async exportGIF(returnFocus = document.activeElement) {
                let job;
                try {
                    job = this.beginExportJob('GIF export', 3, returnFocus);
                } catch (error) {
                    this.showToast('Could not start export: ' + error.message, 'error');
                    return;
                }
                if (!job) return;

                const progress = document.getElementById('exportProgress');
                const status = document.getElementById('exportStatus');
                this.openExportModal('Exporting GIF...', job.returnFocus);
                progress.style.width = '0%';
                status.textContent = 'Preparing frames...';

                const quality = parseInt(document.getElementById('qualitySlider').value);
                const ditherVal = document.getElementById('ditherSelect').value;
                const colorCount = parseInt(document.getElementById('colorCount').value) || 256;
                const loop = document.getElementById('loopGif').checked ? 0 : -1;
                const filenameInput = document.getElementById('exportFilename');
                const filename = (filenameInput && filenameInput.value.trim()) || (this.originalFilename + '-edited');

                try {
                    const encoder = new GifEncoder(job.width, job.height, {
                        quality: quality,
                        dither: ditherVal !== 'none' ? ditherVal : false,
                        repeat: loop,
                        maxColors: colorCount
                    });
                    job.encoder = encoder;
                    this.currentEncoder = encoder;

                    for (let i = 0; i < job.frames.length; i++) {
                        this.assertExportJobCurrent(job);
                        const frame = job.frames[i];
                        encoder.addFrame(frame.canvas, frame.delay);
                        this.updateExportProgress(
                            job,
                            ((i + 1) / job.frames.length) * 40,
                            `Adding frame ${i + 1} of ${job.frames.length}...`,
                            progress,
                            status
                        );
                        await this.waitForExportTask(
                            job,
                            new Promise(resolve => requestAnimationFrame(resolve))
                        );
                    }

                    status.textContent = 'Encoding...';
                    progress.classList.add('encoding');

                    const blob = await this.waitForExportTask(job, encoder.render((p, metrics) => {
                        job.maxFrameBlockMs = Math.max(job.maxFrameBlockMs, metrics?.durationMs || 0);
                        if (!this.isExportJobCurrent(job)) {
                            encoder.abort();
                            return;
                        }
                        this.updateExportProgress(
                            job,
                            40 + p * 60,
                            `Encoding: ${Math.round(p * 100)}%`,
                            progress,
                            status
                        );
                    }));

                    this.assertExportJobCurrent(job);
                    const validation = await this.waitForExportTask(job, this.validateGIFOutput(blob, job));
                    this.assertExportJobCurrent(job);
                    this.recordOutputValidation(validation);
                    this.updateExportProgress(job, 100, 'Export complete', progress, status);

                    const sizeText = this.formatBytes(blob.size);
                    const fullFilename = filename + '.gif';

                    if (window.showSaveFilePicker) {
                        try {
                            const handle = await window.showSaveFilePicker({
                                suggestedName: fullFilename,
                                types: [{ description: 'GIF Image', accept: { 'image/gif': ['.gif'] } }]
                            });
                            const writable = await handle.createWritable();
                            await writable.write(blob);
                            await writable.close();
                            this.showToast(`GIF saved (${sizeText})`, 'success');
                        } catch (e) {
                            if (e.name !== 'AbortError') throw e;
                        }
                    } else {
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = fullFilename;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        this.revokeBlob(url);
                        this.showToast(`GIF exported (${sizeText})`, 'success');
                    }

                    if (navigator.share && navigator.canShare) {
                        const shareFile = new File([blob], fullFilename, { type: 'image/gif' });
                        if (navigator.canShare({ files: [shareFile] })) {
                            this.lastExportFile = shareFile;
                            document.getElementById('shareBtn').style.display = '';
                        }
                    }

                } catch (error) {
                    if (error.name === 'AbortError' || error.message === 'Aborted') {
                        this.showToast('Export cancelled', 'warning');
                    } else {
                        console.error('Export error:', error);
                        this.showToast('Export failed: ' + error.message, 'error');
                    }
                } finally {
                    progress.classList.remove('encoding');
                    this.finishExportJob(job);
                    this.closeExportModal();
                }
            }

            // ============================================
            // APNG Export
            // ============================================

            loadOptionalAsset(name) {
                const asset = OPTIONAL_ASSETS[name];
                if (!asset) return Promise.reject(new Error(`Unknown optional asset: ${name}`));
                if (window[asset.global]) return Promise.resolve();
                if (this._scriptLoads.has(name)) return this._scriptLoads.get(name);

                const loading = new Promise((resolve, reject) => {
                    const script = document.createElement('script');
                    script.src = asset.src;
                    if (location.protocol === 'http:' || location.protocol === 'https:') {
                        script.integrity = asset.integrity;
                    }
                    script.onload = () => {
                        if (!window[asset.global]) {
                            reject(new Error(`${name} loaded without exposing ${asset.global}`));
                            return;
                        }
                        resolve();
                    };
                    script.onerror = () => reject(new Error(
                        `Bundled ${name} asset is unavailable. GIF editing and export still work.`
                    ));
                    document.head.appendChild(script);
                }).catch(error => {
                    this._scriptLoads.delete(name);
                    throw error;
                });
                this._scriptLoads.set(name, loading);
                return loading;
            }

            async loadUPNG() {
                if (!window.pako) await this.loadOptionalAsset('pako');
                if (!window.UPNG) await this.loadOptionalAsset('upng');
            }

            async exportAPNG(returnFocus = document.activeElement) {
                let job;
                try {
                    job = this.beginExportJob('APNG export', 3, returnFocus);
                } catch (error) {
                    this.showToast('Could not start export: ' + error.message, 'error');
                    return;
                }
                if (!job) return;

                const progress = document.getElementById('exportProgress');
                const status = document.getElementById('exportStatus');
                this.openExportModal('Exporting APNG...', job.returnFocus);
                progress.style.width = '0%';
                status.textContent = 'Loading APNG encoder...';

                try {
                    await this.waitForExportTask(job, this.loadUPNG());
                    this.assertExportJobCurrent(job);

                    status.textContent = 'Preparing frames...';
                    const w = job.width, h = job.height;
                    const imgs = [];
                    const dels = [];

                    for (let i = 0; i < job.frames.length; i++) {
                        this.assertExportJobCurrent(job);
                        const frame = job.frames[i];
                        const ctx = frame.canvas.getContext('2d', { willReadFrequently: true });
                        const imgData = ctx.getImageData(0, 0, w, h);
                        imgs.push(imgData.data.buffer);
                        dels.push(frame.delay);
                        this.updateExportProgress(
                            job,
                            ((i + 1) / job.frames.length) * 40,
                            `Preparing frame ${i + 1} of ${job.frames.length}...`,
                            progress,
                            status
                        );
                        await this.waitForExportTask(
                            job,
                            new Promise(resolve => requestAnimationFrame(resolve))
                        );
                    }

                    status.textContent = 'Encoding APNG...';
                    progress.classList.add('encoding');

                    const colorCount = parseInt(document.getElementById('colorCount').value) || 256;
                    const cnum = colorCount >= 256 ? 0 : colorCount;
                    const encodeStarted = performance.now();
                    const apngBuffer = UPNG.encode(imgs, w, h, cnum, dels);
                    job.maxFrameBlockMs = Math.max(job.maxFrameBlockMs, performance.now() - encodeStarted);
                    this.assertExportJobCurrent(job);

                    const blob = new Blob([apngBuffer], { type: 'image/apng' });
                    const validation = await this.waitForExportTask(job, this.validateAPNGOutput(blob, job));
                    this.assertExportJobCurrent(job);
                    this.recordOutputValidation(validation);
                    this.updateExportProgress(job, 100, 'Export complete', progress, status);
                    const sizeText = this.formatBytes(blob.size);
                    const filenameInput = document.getElementById('exportFilename');
                    const filename = (filenameInput && filenameInput.value.trim()) || (this.originalFilename + '-edited');
                    const fullFilename = filename + '.apng';

                    if (window.showSaveFilePicker) {
                        try {
                            const handle = await window.showSaveFilePicker({
                                suggestedName: fullFilename,
                                types: [{ description: 'APNG Image', accept: { 'image/apng': ['.apng', '.png'] } }]
                            });
                            const writable = await handle.createWritable();
                            await writable.write(blob);
                            await writable.close();
                            this.showToast(`APNG saved (${sizeText})`, 'success');
                        } catch (e) {
                            if (e.name !== 'AbortError') throw e;
                        }
                    } else {
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = fullFilename;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        this.revokeBlob(url);
                        this.showToast(`APNG exported (${sizeText})`, 'success');
                    }
                } catch (error) {
                    if (error.name === 'AbortError') {
                        this.showToast('Export cancelled', 'warning');
                    } else {
                        console.error('APNG export error:', error);
                        this.showToast('APNG export failed: ' + error.message, 'error');
                    }
                } finally {
                    progress.classList.remove('encoding');
                    this.finishExportJob(job);
                    this.closeExportModal();
                }
            }

            // ============================================
            // GIF Optimization (gifsicle-wasm)
            // ============================================

            async optimizeGIF(returnFocus = document.activeElement) {
                let job;
                try {
                    job = this.beginExportJob('GIF optimization', 4, returnFocus);
                } catch (error) {
                    this.showToast('Could not start optimization: ' + error.message, 'error');
                    return;
                }
                if (!job) return;

                const statusEl = document.getElementById('optimizeStatus');
                const btn = document.getElementById('optimizeBtn');
                statusEl.style.display = 'block';
                statusEl.textContent = 'Exporting GIF for optimization...';
                btn.disabled = true;

                try {
                    const quality = parseInt(document.getElementById('qualitySlider').value);
                    const ditherVal = document.getElementById('ditherSelect').value;
                    const colorCount = parseInt(document.getElementById('colorCount').value) || 256;
                    const loop = document.getElementById('loopGif').checked ? 0 : -1;

                    const encoder = new GifEncoder(job.width, job.height, {
                        quality, dither: ditherVal !== 'none' ? ditherVal : false,
                        repeat: loop, maxColors: colorCount
                    });
                    job.encoder = encoder;
                    this.currentEncoder = encoder;
                    for (let i = 0; i < job.frames.length; i++) {
                        this.assertExportJobCurrent(job);
                        const frame = job.frames[i];
                        encoder.addFrame(frame.canvas, frame.delay);
                        this.updateExportProgress(
                            job,
                            ((i + 1) / job.frames.length) * 30,
                            `Preparing frame ${i + 1} of ${job.frames.length}...`,
                            null,
                            statusEl
                        );
                        await this.waitForExportTask(
                            job,
                            new Promise(resolve => requestAnimationFrame(resolve))
                        );
                    }
                    const blob = await this.waitForExportTask(job, encoder.render((progress, metrics) => {
                        job.maxFrameBlockMs = Math.max(job.maxFrameBlockMs, metrics?.durationMs || 0);
                        if (!this.isExportJobCurrent(job)) {
                            encoder.abort();
                            return;
                        }
                        this.updateExportProgress(
                            job,
                            30 + progress * 30,
                            `Encoding source GIF: ${Math.round(progress * 100)}%`,
                            null,
                            statusEl
                        );
                    }));
                    this.assertExportJobCurrent(job);
                    const originalSize = blob.size;

                    this.updateExportProgress(job, 65, 'Loading optimizer...', null, statusEl);

                    if (!window._gifsicleLoaded) {
                        await this.waitForExportTask(job, this.loadOptionalAsset('gifsicle'));
                        window._gifsicleLoaded = true;
                    }
                    this.assertExportJobCurrent(job);

                    this.updateExportProgress(job, 70, 'Optimizing...', null, statusEl);

                    const level = document.getElementById('optimizeLevel').value;
                    const lossy = parseInt(document.getElementById('optimizeLossy').value);
                    const args = [`-${level}`];
                    if (lossy > 0) args.push(`--lossy=${lossy}`);

                    const result = await this.waitForExportTask(job, window.gifsicle.run({
                        input: [{ file: await blob.arrayBuffer(), name: 'input.gif' }],
                        command: [`gifsicle ${args.join(' ')} input.gif -o /output/out.gif`]
                    }));
                    this.assertExportJobCurrent(job);
                    this.updateExportProgress(job, 100, 'Optimization complete', null, statusEl);

                    if (!result || !result[0]) throw new Error('Optimization produced no output');

                    const optimizedBlob = new Blob([result[0]], { type: 'image/gif' });
                    const validation = await this.waitForExportTask(job, this.validateGIFOutput(optimizedBlob, job));
                    this.assertExportJobCurrent(job);
                    this.recordOutputValidation(validation);
                    const reduction = Math.round((1 - optimizedBlob.size / originalSize) * 100);
                    const filenameInput = document.getElementById('exportFilename');
                    const filename = (filenameInput && filenameInput.value.trim() || 'optimized') + '-opt.gif';

                    if (window.showSaveFilePicker) {
                        try {
                            const handle = await window.showSaveFilePicker({
                                suggestedName: filename,
                                types: [{ description: 'GIF Image', accept: { 'image/gif': ['.gif'] } }]
                            });
                            const writable = await handle.createWritable();
                            await writable.write(optimizedBlob);
                            await writable.close();
                        } catch (e) {
                            if (e.name !== 'AbortError') throw e;
                        }
                    } else {
                        const url = URL.createObjectURL(optimizedBlob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = filename;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        this.revokeBlob(url);
                    }

                    statusEl.textContent = `${this.formatBytes(originalSize)} → ${this.formatBytes(optimizedBlob.size)} (−${reduction}%)`;
                    this.showToast(`Optimized: ${reduction}% smaller`, 'success');

                } catch (error) {
                    if (error.name === 'AbortError' || error.message === 'Aborted') {
                        statusEl.textContent = 'Optimization cancelled';
                        this.showToast('Optimization cancelled', 'warning');
                    } else {
                        console.error('Optimization error:', error);
                        statusEl.textContent = 'Optimization failed: ' + error.message;
                        this.showToast('Optimization failed: ' + error.message, 'error');
                    }
                } finally {
                    this.finishExportJob(job);
                }
            }

            // ============================================
            // Frame Split
            // ============================================

            async splitFramesToPNG(returnFocus = document.activeElement) {
                if (this.frames.length === 0) return;
                const estimatedArchiveBytes = this.estimateZipUpperBound(
                    this.originalWidth,
                    this.originalHeight,
                    this.frames.length
                );
                if (this.frames.length > ZIP_LIMITS.maxEntries || estimatedArchiveBytes > ZIP_LIMITS.maxArchiveBytes) {
                    this.showToast(
                        `PNG split stopped before allocation: estimated ZIP ${this.formatBytes(estimatedArchiveBytes)} ` +
                        `exceeds the ${this.formatBytes(ZIP_LIMITS.maxArchiveBytes)} limit. ` +
                        'Export fewer frames or resize them first.',
                        'error'
                    );
                    return;
                }

                let job;
                try {
                    job = this.beginExportJob('PNG frame split', 4, returnFocus);
                } catch (error) {
                    this.showToast('Could not start PNG split: ' + error.message, 'error');
                    return;
                }
                if (!job) return;

                const progress = document.getElementById('exportProgress');
                const status = document.getElementById('exportStatus');
                const files = [];
                const pad = String(job.frames.length).length;
                const baseName = this.sanitizeBasename(this.originalFilename, 'frames');
                this.openExportModal('Splitting frames to PNG...', job.returnFocus);
                progress.style.width = '0%';
                status.textContent = 'Preparing PNG frames...';

                try {
                    for (let i = 0; i < job.frames.length; i++) {
                        this.assertExportJobCurrent(job);
                        const blob = await this.waitForExportTask(job, new Promise(resolve => {
                            job.frames[i].canvas.toBlob(resolve, 'image/png');
                        }));
                        this.assertExportJobCurrent(job);
                        if (!blob) {
                            throw new Error(`Browser could not serialize frame ${i + 1} as PNG`);
                        }
                        const nextBytes = files.reduce((sum, file) => sum + file.data.length, 0) + blob.size;
                        if (nextBytes > ZIP_LIMITS.maxArchiveBytes) {
                            throw new Error(
                                `PNG data exceeded the ${this.formatBytes(ZIP_LIMITS.maxArchiveBytes)} ZIP limit`
                            );
                        }
                        const data = new Uint8Array(await this.waitForExportTask(job, blob.arrayBuffer()));
                        this.assertExportJobCurrent(job);
                        files.push({
                            name: `${baseName}-frame-${String(i + 1).padStart(pad, '0')}.png`,
                            data
                        });
                        this.updateExportProgress(
                            job,
                            ((i + 1) / job.frames.length) * 55,
                            `Encoded PNG ${i + 1} of ${job.frames.length}`,
                            progress,
                            status
                        );
                        await this.waitForExportTask(job, new Promise(resolve => requestAnimationFrame(resolve)));
                    }

                    const zip = await this.buildZip(files, job, (percent, message) => {
                        this.updateExportProgress(job, percent, message, progress, status);
                    });
                    this.assertExportJobCurrent(job);
                    const zipBlob = new Blob([zip], { type: 'application/zip' });
                    const fullFilename = `${baseName}-frames.zip`;

                    if (window.showSaveFilePicker) {
                        const handle = await window.showSaveFilePicker({
                            suggestedName: fullFilename,
                            types: [{ description: 'ZIP Archive', accept: { 'application/zip': ['.zip'] } }]
                        });
                        this.assertExportJobCurrent(job);
                        const writable = await handle.createWritable();
                        await writable.write(zipBlob);
                        await writable.close();
                    } else {
                        const url = URL.createObjectURL(zipBlob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = fullFilename;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        this.revokeBlob(url);
                    }
                    this.updateExportProgress(job, 100, 'ZIP export complete', progress, status);
                    this.showToast(
                        `Exported ${files.length} frames as PNG (${this.formatBytes(zipBlob.size)})`,
                        'success'
                    );
                } catch (error) {
                    if (error.name === 'AbortError') {
                        this.showToast('PNG split cancelled', 'warning');
                    } else {
                        console.error('PNG split failed:', error);
                        this.showToast(
                            `PNG split failed: ${error.message}. Export fewer/smaller frames or retry after reloading.`,
                            'error'
                        );
                    }
                } finally {
                    files.forEach(file => { file.data = new Uint8Array(0); });
                    this.finishExportJob(job);
                    this.closeExportModal();
                }
            }

            sanitizeBasename(value, fallback = 'frames') {
                let name = String(value || '')
                    .normalize('NFKC')
                    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '-')
                    .replace(/^\.+/, '')
                    .replace(/[ .]+$/g, '')
                    .trim()
                    .slice(0, 80);
                if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name += '-file';
                return name || fallback;
            }

            estimateZipUpperBound(width, height, frameCount) {
                const rawBytes = this.estimateFrameBytes(width, height, frameCount).bytes;
                const filteredBytes = rawBytes + height * frameCount;
                const deflateOverhead = Math.ceil(filteredBytes / 16383) * 5;
                return filteredBytes + deflateOverhead + frameCount * 320 + 22;
            }

            async buildZip(files, job, onProgress = () => {}) {
                if (files.length === 0 || files.length > ZIP_LIMITS.maxEntries) {
                    throw new Error(`ZIP entry count must be between 1 and ${ZIP_LIMITS.maxEntries}`);
                }
                const entries = [];
                let offset = 0;

                for (let index = 0; index < files.length; index++) {
                    this.assertExportJobCurrent(job);
                    const file = files[index];
                    const nameBytes = new TextEncoder().encode(file.name);
                    if (nameBytes.length > 0xFFFF) throw new Error('ZIP entry name is too long');
                    const crc = await this.crc32(file.data, job);
                    const size = file.data.length;
                    if (size > 0xFFFFFFFF || offset > 0xFFFFFFFF) {
                        throw new Error('ZIP32 size limit exceeded');
                    }
                    entries.push({ file, nameBytes, crc, size, offset });
                    offset += 30 + nameBytes.length + size;
                    onProgress(55 + ((index + 1) / files.length) * 15, `Checksummed PNG ${index + 1} of ${files.length}`);
                }

                const centralSize = entries.reduce((sum, entry) => sum + 46 + entry.nameBytes.length, 0);
                const totalSize = offset + centralSize + 22;
                if (totalSize > ZIP_LIMITS.maxArchiveBytes || totalSize > 0xFFFFFFFF) {
                    throw new Error(
                        `ZIP would be ${this.formatBytes(totalSize)}; limit is ${this.formatBytes(ZIP_LIMITS.maxArchiveBytes)}`
                    );
                }
                const out = new Uint8Array(totalSize);
                let pos = 0;
                const view = new DataView(out.buffer);

                for (let index = 0; index < entries.length; index++) {
                    this.assertExportJobCurrent(job);
                    const entry = entries[index];
                    view.setUint32(pos, 0x04034b50, true);
                    view.setUint16(pos + 4, 20, true);
                    view.setUint16(pos + 8, 0, true);
                    view.setUint32(pos + 14, entry.crc, true);
                    view.setUint32(pos + 18, entry.size, true);
                    view.setUint32(pos + 22, entry.size, true);
                    view.setUint16(pos + 26, entry.nameBytes.length, true);
                    out.set(entry.nameBytes, pos + 30);
                    pos += 30 + entry.nameBytes.length;
                    for (let source = 0; source < entry.size; source += ZIP_LIMITS.copyChunkBytes) {
                        this.assertExportJobCurrent(job);
                        const chunk = entry.file.data.subarray(
                            source,
                            Math.min(source + ZIP_LIMITS.copyChunkBytes, entry.size)
                        );
                        out.set(chunk, pos + source);
                        if (entry.size > ZIP_LIMITS.copyChunkBytes) {
                            await new Promise(resolve => requestAnimationFrame(resolve));
                        }
                    }
                    pos += entry.size;
                    onProgress(70 + ((index + 1) / entries.length) * 18, `Packed PNG ${index + 1} of ${entries.length}`);
                }

                const centralOffset = pos;
                for (const entry of entries) {
                    view.setUint32(pos, 0x02014b50, true);
                    view.setUint16(pos + 4, 20, true);
                    view.setUint16(pos + 6, 20, true);
                    view.setUint16(pos + 12, 0, true);
                    view.setUint32(pos + 16, entry.crc, true);
                    view.setUint32(pos + 20, entry.size, true);
                    view.setUint32(pos + 24, entry.size, true);
                    view.setUint16(pos + 28, entry.nameBytes.length, true);
                    view.setUint32(pos + 42, entry.offset, true);
                    out.set(entry.nameBytes, pos + 46);
                    pos += 46 + entry.nameBytes.length;
                }
                view.setUint32(pos, 0x06054b50, true);
                view.setUint16(pos + 8, entries.length, true);
                view.setUint16(pos + 10, entries.length, true);
                view.setUint32(pos + 12, centralSize, true);
                view.setUint32(pos + 16, centralOffset, true);
                onProgress(99, 'Finalizing ZIP archive');
                return out;
            }

            async crc32(data, job) {
                if (!this._crc32Table) {
                    this._crc32Table = new Uint32Array(256);
                    for (let value = 0; value < 256; value++) {
                        let entry = value;
                        for (let bit = 0; bit < 8; bit++) {
                            entry = (entry >>> 1) ^ (entry & 1 ? 0xEDB88320 : 0);
                        }
                        this._crc32Table[value] = entry >>> 0;
                    }
                }
                let crc = 0xFFFFFFFF;
                for (let i = 0; i < data.length; i++) {
                    crc = (crc >>> 8) ^ this._crc32Table[(crc ^ data[i]) & 0xFF];
                    if (i > 0 && i % ZIP_LIMITS.copyChunkBytes === 0) {
                        this.assertExportJobCurrent(job);
                        await new Promise(resolve => requestAnimationFrame(resolve));
                    }
                }
                return (crc ^ 0xFFFFFFFF) >>> 0;
            }

            // ============================================
            // UI Helpers
            // ============================================

            getExportFormat() {
                return document.getElementById('exportFormat')?.value || 'gif';
            }

            getEncodedDelayMs(delay, format = this.getExportFormat()) {
                const milliseconds = Math.max(1, Math.round(Number(delay) || 0));
                return format === 'gif' ? Math.max(10, Math.round(milliseconds / 10) * 10) : milliseconds;
            }

            getTimingModel(format = this.getExportFormat()) {
                const editedDelays = this.frames.map(frame => frame.delay);
                const outputDelays = editedDelays.map(delay => this.getEncodedDelayMs(delay, format));
                return {
                    format,
                    editedDelays,
                    outputDelays,
                    editedDuration: editedDelays.reduce((sum, delay) => sum + delay, 0),
                    outputDuration: outputDelays.reduce((sum, delay) => sum + delay, 0)
                };
            }

            formatDuration(milliseconds) {
                return `${(milliseconds / 1000).toFixed(2)}s`;
            }

            updateDelayInput() {
                if (this.frames.length === 0) return;
                const input = document.getElementById('frameDelay');
                const delay = this.frames[this.currentFrame]?.delay || 100;
                input.value = this.getExportFormat() === 'gif'
                    ? String(delay / 10)
                    : String(delay);
            }

            readDelayInput() {
                const value = Number.parseFloat(document.getElementById('frameDelay').value);
                if (this.getExportFormat() === 'gif') {
                    return Math.max(10, Math.min(5000, Math.round((Number.isFinite(value) ? value : 10) * 10)));
                }
                return Math.max(1, Math.min(5000, Math.round(Number.isFinite(value) ? value : 100)));
            }

            syncTimingControls() {
                const format = this.getExportFormat();
                const input = document.getElementById('frameDelay');
                const label = document.getElementById('frameDelayLabel');
                if (format === 'gif') {
                    label.textContent = 'Delay (centiseconds)';
                    input.min = '1';
                    input.max = '500';
                    input.step = '1';
                } else {
                    label.textContent = 'Delay (milliseconds)';
                    input.min = '1';
                    input.max = '5000';
                    input.step = '1';
                }
                this.updateDelayInput();
                this.updateGIFInfo();
            }

            updateTimingSummary(model = this.getTimingModel()) {
                const summary = document.getElementById('timingSummary');
                const warning = document.getElementById('timingWarning');
                if (!summary || !warning || this.frames.length === 0) return;

                const sourceDelays = this.sourceTiming?.delays || [];
                const sourceDuration = sourceDelays.reduce((sum, delay) => sum + delay, 0);
                const currentOutputDelay = model.outputDelays[this.currentFrame] || 0;
                const fps = currentOutputDelay > 0 ? (1000 / currentOutputDelay).toFixed(2) : '—';
                const unit = model.format === 'gif'
                    ? `${currentOutputDelay / 10} cs`
                    : `${currentOutputDelay} ms`;
                summary.textContent =
                    `Source (${this.sourceTiming?.format || 'Imported'}): ${this.formatDuration(sourceDuration)} · ` +
                    `${model.format.toUpperCase()} output: ${this.formatDuration(model.outputDuration)} · ` +
                    `selected ${unit} (${fps} FPS)`;

                const warnings = [];
                if (model.format === 'gif') {
                    const editedDelay = model.editedDelays[this.currentFrame] || 0;
                    if (editedDelay !== currentOutputDelay) {
                        warnings.push(`Selected delay rounds ${editedDelay}ms → ${currentOutputDelay}ms for GIF.`);
                    }
                    if (model.outputDelays.some(delay => delay < 20)) {
                        warnings.push('Some GIF viewers clamp delays below 20ms; validate the target viewer.');
                    }
                    if (model.outputDelays.some(delay => delay >= 3000)) {
                        warnings.push('Long GIF delays may be rewritten by downstream converters; validate the exported file.');
                    }
                } else {
                    warnings.push('APNG stores millisecond delays; actual display scheduling still depends on the viewer.');
                }
                warning.textContent = warnings.join(' ');
            }

            updateGIFInfo() {
                document.getElementById('infoDimensions').textContent = `${this.originalWidth}×${this.originalHeight}`;
                document.getElementById('infoFrames').textContent = this.frames.length;

                const timing = this.getTimingModel();
                document.getElementById('infoDuration').textContent =
                    `${this.formatDuration(timing.editedDuration)} / ${this.formatDuration(timing.outputDuration)}`;
                document.getElementById('infoSize').textContent = this.formatBytes(this.fileSize);
                this.updateTimingSummary(timing);
                this.updateSizeEstimate();
            }

            updateAnalyzer() {
                const el = document.getElementById('analyzerContent');
                if (!el) return;
                el.replaceChildren();
                if (this.frames.length === 0) {
                    el.textContent = 'No source loaded.';
                    return;
                }

                const addSummary = (text, color = 'var(--text-secondary)') => {
                    const line = document.createElement('div');
                    line.style.cssText = `color:${color};padding:3px 0;`;
                    line.textContent = text;
                    el.appendChild(line);
                };
                addSummary(
                    `${this.sourceTiming?.format || 'Imported source'} · decoded frames · ` +
                    `${this.originalWidth}×${this.originalHeight} · ${this.frames.length} frame${this.frames.length === 1 ? '' : 's'}`,
                    'var(--text-primary)'
                );
                addSummary(this.rawGifMeta
                    ? 'Raw GIF block metadata available.'
                    : 'Raw GIF block metadata unavailable; showing decoded frame properties.');
                const memory = this.memoryTelemetry.lastEstimate;
                if (memory) {
                    const budgetState = memory.overridden
                        ? ' · user override accepted'
                        : memory.estimatedPeakBytes > memory.limits.defaultBytes
                            ? ' · over default budget'
                            : '';
                    addSummary(
                        `Memory (${memory.operation}): ${this.formatBytes(memory.rawFrameBytes)} raw-frame footprint · ` +
                        `${this.formatBytes(memory.temporaryBytes)} temporary allocation · ` +
                        `${this.formatBytes(memory.estimatedPeakBytes)} estimated peak${budgetState}`,
                        memory.estimatedPeakBytes > memory.limits.defaultBytes
                            ? 'var(--warning)'
                            : 'var(--text-secondary)'
                    );
                }

                const disposalNames = ['none', 'keep', 'bg', 'prev'];
                this.frames.forEach((frame, index) => {
                    const raw = this.rawGifMeta?.[index];
                    const row = document.createElement('div');
                    row.style.cssText = 'display:flex;gap:8px;color:var(--text-secondary);padding:2px 0;border-bottom:1px solid var(--border-subtle);';
                    const values = raw
                        ? [
                            `#${index + 1}`,
                            `${raw.width}×${raw.height}`,
                            `+${raw.left},${raw.top}`,
                            `${frame.delay}ms`,
                            disposalNames[raw.disposal] || String(raw.disposal),
                            `${raw.paletteSize}c`,
                            raw.transparent ? 'transparent' : ''
                        ]
                        : [
                            `#${index + 1}`,
                            `${frame.canvas.width}×${frame.canvas.height}`,
                            `${frame.delay}ms`,
                            disposalNames[frame.disposalType] || String(frame.disposalType)
                        ];
                    values.filter(Boolean).forEach((value, valueIndex) => {
                        const span = document.createElement('span');
                        span.textContent = value;
                        if (valueIndex === 0) {
                            span.style.color = 'var(--text-primary)';
                            span.style.minWidth = '24px';
                        }
                        row.appendChild(span);
                    });
                    el.appendChild(row);
                });

                if (this.lastOutputValidation) {
                    const output = this.lastOutputValidation;
                    addSummary(
                        `Validated ${output.format} output · ${output.width}×${output.height} · ` +
                        `${output.frameCount} frame${output.frameCount === 1 ? '' : 's'} · ` +
                        `${this.formatDuration(output.duration)} · ${this.formatBytes(output.bytes)}`,
                        'var(--success)'
                    );
                } else {
                    addSummary('No exported output has been validated for this project.');
                }
            }

            getPlatformFitProfiles() {
                return [
                    {
                        name: 'Discord message',
                        maxBytes: 10 * 1024 * 1024,
                        limitLabel: '10 MiB',
                        source: 'Discord API default file upload limit'
                    },
                    {
                        name: 'Discord emoji',
                        maxBytes: 256 * 1024,
                        limitLabel: '256 KiB',
                        source: 'Discord Emoji Resource'
                    },
                    {
                        name: 'X web GIF',
                        maxBytes: 15 * 1000 * 1000,
                        limitLabel: '15 MB',
                        source: 'X Help GIF upload requirements'
                    },
                    {
                        name: 'X mobile GIF',
                        maxBytes: 5 * 1000 * 1000,
                        limitLabel: '5 MB',
                        source: 'X Help GIF upload requirements'
                    }
                ];
            }

            evaluatePlatformFit(bytes) {
                return this.getPlatformFitProfiles().map(profile => ({
                    ...profile,
                    fits: bytes <= profile.maxBytes
                }));
            }

            renderPlatformFit(bytes, isFinal = false) {
                const el = document.getElementById('sizeEstimate');
                const badges = document.getElementById('platformBadges');
                if (!el || !badges) return;
                const outputDuration = this.getTimingModel().outputDuration;
                el.textContent = `${isFinal ? 'Final' : 'Estimated'} ${isFinal ? '' : '~'}${this.formatBytes(bytes)} · ` +
                    `${this.formatDuration(outputDuration)}`;
                badges.replaceChildren();
                this.evaluatePlatformFit(bytes).forEach(profile => {
                    const badge = document.createElement('span');
                    badge.className = `platform-fit ${profile.fits ? 'fits' : 'over'}`;
                    badge.dataset.destination = profile.name;
                    badge.dataset.fits = String(profile.fits);
                    badge.title = `${profile.source}; reviewed 2026-07-29`;
                    badge.textContent =
                        `${profile.fits ? '✓' : '✗'} ${profile.name} (${profile.limitLabel})`;
                    badges.appendChild(badge);
                });
            }

            updateSizeEstimate(actualBytes = null) {
                if (this.frames.length === 0) return;

                const pixels = this.originalWidth * this.originalHeight;
                const quality = parseInt(document.getElementById('qualitySlider').value) || 10;
                const colorCount = parseInt(document.getElementById('colorCount').value) || 256;
                const colorFactor = Math.log2(colorCount) / 8;
                const compressionRatio = (0.05 + (quality / 30) * 0.15) * colorFactor;
                const bytesPerFrame = pixels * 3 * compressionRatio;
                const overhead = 800 + this.frames.length * (20 + colorCount * 3);
                const estimated = Math.round(overhead + bytesPerFrame * this.frames.length);

                this.renderPlatformFit(actualBytes ?? estimated, actualBytes !== null);
            }

            formatBytes(bytes) {
                if (bytes === 0) return '0 B';
                const k = 1024;
                const sizes = ['B', 'KB', 'MB', 'GB'];
                const i = Math.floor(Math.log(bytes) / Math.log(k));
                return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
            }

            sanitizeDiagnosticText(message) {
                return String(message || 'Unknown error')
                    .replace(/https?:\/\/\S+/gi, '[url]')
                    .replace(/(?:[A-Za-z]:)?[\\/](?:[^\s"'<>]+[\\/])*[^\s"'<>]*/g, '[path]')
                    .replace(/\b[^\s<>:"/\\|?*]+\.(?:gif|png|jpe?g|webp|apng|zip)\b/gi, '[file]')
                    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .slice(0, 300);
            }

            recordDiagnosticError(message, surface = 'application') {
                this.lastDiagnosticError = {
                    surface,
                    message: this.sanitizeDiagnosticText(message),
                    recordedAt: new Date().toISOString()
                };
            }

            buildDiagnosticsReport() {
                const yesNo = value => value ? 'yes' : 'no';
                const hasProject = this.frames.length > 0;
                const memory = this.memoryTelemetry.lastEstimate;
                const output = this.lastOutputValidation;
                const profile = this.lastExportProfile;
                const nativeDecoder = typeof ImageDecoder !== 'undefined';
                const filePicker = typeof window.showSaveFilePicker === 'function';
                const fileShare = typeof navigator.share === 'function' && typeof navigator.canShare === 'function';
                const clipboard = Boolean(navigator.clipboard?.writeText && window.isSecureContext);

                return [
                    'GifStudio diagnostics',
                    `Generated: ${new Date().toISOString()}`,
                    `App version: ${APP_VERSION}`,
                    `Project loaded: ${yesNo(hasProject)}`,
                    `Dimensions: ${hasProject ? `${this.originalWidth}x${this.originalHeight}` : 'none'}`,
                    `Frame count: ${this.frames.length}`,
                    `Selected format: ${this.getExportFormat().toUpperCase()}`,
                    `Source metadata: ${!hasProject ? 'none' : this.rawGifMeta ? 'raw GIF blocks available' : 'decoded frames only'}`,
                    `Decoder used: ${hasProject ? this.lastDecoderPath : 'none'}`,
                    `Validated output: ${output
                        ? `${output.format}, ${output.width}x${output.height}, ${output.frameCount} frames, ${Math.round(output.duration)}ms, ${output.bytes} bytes`
                        : 'none'}`,
                    `Memory last estimate: ${memory
                        ? `${memory.operation}, raw ${memory.rawFrameBytes} bytes, temporary ${memory.temporaryBytes} bytes, peak ${memory.estimatedPeakBytes} bytes`
                        : 'none'}`,
                    `Memory highest estimate: ${this.memoryTelemetry.peakEstimatedBytes} bytes`,
                    `Memory overrides: ${this.memoryTelemetry.overrideCount}`,
                    `Undo history: ${this.estimateHistoryBytes()} of ${this.maxUndoBytes} bytes`,
                    `Last export profile: ${profile
                        ? `${profile.kind}, ${profile.durationMs}ms total, ${profile.maxFrameBlockMs}ms max block, cancelled ${yesNo(profile.cancelled)}`
                        : 'none'}`,
                    '',
                    'Capabilities and fallbacks',
                    `ImageDecoder: ${yesNo(nativeDecoder)} (${nativeDecoder ? 'optional pixel decoder after strict structural validation' : 'strict JavaScript pixel decoder'})`,
                    `File System Access: ${yesNo(filePicker)} (${filePicker ? 'direct save' : 'download fallback'})`,
                    `File sharing: ${yesNo(fileShare)} (${fileShare ? 'share button after compatible GIF export' : 'share control hidden'})`,
                    `Clipboard write: ${yesNo(clipboard)} (${clipboard ? 'async clipboard' : 'temporary text selection fallback'})`,
                    `Service worker API: ${yesNo('serviceWorker' in navigator)}`,
                    `Service worker state: ${this.serviceWorkerStatus}`,
                    `Offline cache controlled: ${yesNo(Boolean(navigator.serviceWorker?.controller))}`,
                    `Recovery storage: ${this.storageStatus}`,
                    `Storage usage: ${Number.isFinite(this.storageTelemetry.usage) &&
                        Number.isFinite(this.storageTelemetry.quota)
                        ? `${this.storageTelemetry.usage} of ${this.storageTelemetry.quota} bytes`
                        : 'unavailable'}`,
                    `Storage persistence: ${this.storageTelemetry.persisted === true
                        ? 'granted'
                        : this.storageTelemetry.persisted === false
                            ? 'not granted'
                            : this.storageTelemetry.persistenceSupported
                                ? 'unknown'
                                : 'unsupported'}`,
                    `Recovery coordination: ${this.recoveryCoordinationStatus}`,
                    `IndexedDB: ${yesNo('indexedDB' in window)}`,
                    `WebAssembly: ${yesNo(typeof WebAssembly !== 'undefined')}`,
                    `Cross-origin isolated: ${yesNo(window.crossOriginIsolated)}`,
                    `Online: ${yesNo(navigator.onLine)}`,
                    `Bundled pako loaded: ${yesNo(Boolean(window.pako))}`,
                    `Bundled UPNG loaded: ${yesNo(Boolean(window.UPNG))}`,
                    `Bundled gifsicle loaded: ${yesNo(Boolean(window.gifsicle))}`,
                    '',
                    `Last error: ${this.lastDiagnosticError
                        ? `${this.lastDiagnosticError.surface} at ${this.lastDiagnosticError.recordedAt}: ${this.lastDiagnosticError.message}`
                        : 'none'}`,
                    'Privacy: report excludes frame pixels, thumbnails, filenames, source URLs, user agent, and telemetry.'
                ].join('\n');
            }

            async copyDiagnostics() {
                const report = this.buildDiagnosticsReport();
                try {
                    if (navigator.clipboard?.writeText && window.isSecureContext) {
                        await navigator.clipboard.writeText(report);
                    } else {
                        const textarea = document.createElement('textarea');
                        textarea.value = report;
                        textarea.setAttribute('readonly', '');
                        textarea.style.cssText = 'position:fixed;left:-9999px;top:0;';
                        document.body.appendChild(textarea);
                        textarea.select();
                        if (!document.execCommand('copy')) throw new Error('Browser denied text copy');
                        textarea.remove();
                    }
                    this.showToast('Diagnostics copied without media or filenames', 'success');
                } catch (error) {
                    this.showToast('Could not copy diagnostics: ' + error.message, 'error');
                }
            }

            showToast(message, type = 'info') {
                if (type === 'error') this.recordDiagnosticError(message);
                const container = document.getElementById('toastContainer');
                const toast = document.createElement('div');
                toast.className = 'toast ' + type;
                const icons = { success: '✓', error: '✕', warning: '⚠', info: '●' };
                const iconEl = document.createElement('span');
                iconEl.style.cssText = 'font-weight:700; font-size:14px; flex-shrink:0; width:18px; text-align:center;';
                iconEl.textContent = icons[type] || icons.info;
                toast.appendChild(iconEl);
                const msgEl = document.createElement('span');
                msgEl.textContent = message;
                toast.appendChild(msgEl);
                container.appendChild(toast);

                setTimeout(() => {
                    toast.style.opacity = '0';
                    toast.style.transform = 'translateX(20px)';
                    setTimeout(() => toast.remove(), 300);
                }, 3000);
            }

            handleKeyboard(e) {
                if (this.trapExportModalFocus(e)) return;
                if (e.key === 'Escape') {
                    const modal = document.getElementById('exportModal');
                    if (modal.classList.contains('active')) {
                        e.preventDefault();
                        if (this._activeExportJob) {
                            this.cancelExportJob();
                        } else {
                            this.closeExportModal();
                        }
                        return;
                    }
                    if (document.getElementById('sidebar').classList.contains('open')) {
                        e.preventDefault();
                        this.setMobileDrawer(false, true);
                        return;
                    }
                }

                if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

                switch (e.key) {
                    case ' ':
                        e.preventDefault();
                        this.togglePlay();
                        break;
                    case 'ArrowLeft':
                        e.preventDefault();
                        this.goToFrame(this.currentFrame - 1);
                        break;
                    case 'ArrowRight':
                        e.preventDefault();
                        this.goToFrame(this.currentFrame + 1);
                        break;
                    case 'Delete':
                    case 'Backspace':
                        e.preventDefault();
                        this.confirmCurrentFrameDelete();
                        break;
                    case 'z':
                        if (e.ctrlKey || e.metaKey) {
                            e.preventDefault();
                            if (e.shiftKey) {
                                this.redo();
                            } else {
                                this.undo();
                            }
                        }
                        break;
                    case 'y':
                        if (e.ctrlKey || e.metaKey) {
                            e.preventDefault();
                            this.redo();
                        }
                        break;
                    case 'd':
                        if (e.ctrlKey || e.metaKey) {
                            e.preventDefault();
                            this.duplicateFrame();
                        }
                        break;
                    case '+':
                    case '=':
                        e.preventDefault();
                        this.setZoom(this.zoom + 0.25);
                        break;
                    case '-':
                        e.preventDefault();
                        this.setZoom(this.zoom - 0.25);
                        break;
                    case '0':
                        e.preventDefault();
                        this.fitToView();
                        break;
                }
            }
        }

        function showUpdateNotice(registration) {
            if (document.getElementById('updateNotice')) return;
            const notice = document.createElement('div');
            notice.id = 'updateNotice';
            notice.setAttribute('role', 'status');
            notice.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:1600;background:var(--bg-elevated);border:1px solid var(--accent-primary);border-radius:var(--radius-md);padding:12px;display:flex;align-items:center;gap:10px;box-shadow:var(--shadow-lg);font-size:12px;';
            const message = document.createElement('span');
            message.textContent = 'A verified GifStudio update is ready.';
            const reload = document.createElement('button');
            reload.className = 'btn btn-primary';
            reload.textContent = 'Reload';
            reload.onclick = () => {
                sessionStorage.setItem('gifstudioUpdateAccepted', '1');
                registration.waiting?.postMessage({ type: 'GIFSTUDIO_SKIP_WAITING' });
            };
            notice.appendChild(message);
            notice.appendChild(reload);
            document.body.appendChild(notice);
        }

        async function registerServiceWorker(editorInstance) {
            if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
            try {
                const registration = await navigator.serviceWorker.register('coi-serviceworker.js');
                editorInstance.serviceWorkerStatus = navigator.serviceWorker.controller ? 'active' : 'installing';
                if (registration.waiting && navigator.serviceWorker.controller) showUpdateNotice(registration);
                registration.addEventListener('updatefound', () => {
                    const worker = registration.installing;
                    if (!worker) return;
                    worker.addEventListener('statechange', () => {
                        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
                            editorInstance.serviceWorkerStatus = 'update-ready';
                            showUpdateNotice(registration);
                        }
                    });
                });
                navigator.serviceWorker.addEventListener('message', event => {
                    if (event.data?.type === 'GIFSTUDIO_SW_ACTIVATED') {
                        editorInstance.serviceWorkerStatus = 'active';
                    }
                });
                let reloading = false;
                navigator.serviceWorker.addEventListener('controllerchange', () => {
                    if (reloading || sessionStorage.getItem('gifstudioUpdateAccepted') !== '1') return;
                    reloading = true;
                    sessionStorage.removeItem('gifstudioUpdateAccepted');
                    location.reload();
                });
            } catch (error) {
                editorInstance.serviceWorkerStatus = 'error';
                editorInstance.recordDiagnosticError(error.message, 'service-worker');
                console.error('Service worker registration failed:', error);
                editorInstance.showToast('Offline caching is unavailable; the network editor remains usable.', 'warning');
            }
        }

        // Initialize the app
        const editor = new GIFEditor();
        registerServiceWorker(editor);
