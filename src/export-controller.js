export class ExportController {
  constructor({
    getFrames,
    getDimensions,
    getProjectGeneration,
    getActiveOperation,
    showToast,
    stopPlayback,
    preflightMemory,
    cloneFrame,
    releaseFrames,
    setControlsLocked,
    getCurrentEncoder = () => null,
    onFinished = () => {},
    now = () => globalThis.performance?.now?.() ?? Date.now()
  }) {
    this.getFrames = getFrames;
    this.getDimensions = getDimensions;
    this.getProjectGeneration = getProjectGeneration;
    this.getActiveOperation = getActiveOperation;
    this.showToast = showToast;
    this.stopPlayback = stopPlayback;
    this.preflightMemory = preflightMemory;
    this.cloneFrame = cloneFrame;
    this.releaseFrames = releaseFrames;
    this.setControlsLocked = setControlsLocked;
    this.getCurrentEncoder = getCurrentEncoder;
    this.onFinished = onFinished;
    this.now = now;
    this.activeJob = null;
    this.generation = 0;
  }

  begin(kind, temporaryCopies, returnFocus) {
    if (this.getFrames().length === 0) return null;
    const activeOperation = this.getActiveOperation();
    if (activeOperation) {
      this.showToast('Wait for ' + activeOperation.kind + ' to finish', 'warning');
      return null;
    }
    if (this.activeJob) {
      this.showToast('Another export is already running', 'warning');
      return null;
    }

    this.stopPlayback();
    const dimensions = this.getDimensions();
    const memoryEstimate = this.preflightMemory(kind, {
      width: dimensions.width,
      height: dimensions.height,
      frameCount: this.getFrames().length,
      temporaryCopies
    });
    const snapshotFrames = [];
    try {
      this.getFrames().forEach(frame => snapshotFrames.push(this.cloneFrame(frame)));
    } catch (error) {
      this.releaseFrames(snapshotFrames);
      throw error;
    }

    let resolveCancel;
    const cancelSignal = new Promise(resolve => {
      resolveCancel = resolve;
    });
    const job = {
      id: ++this.generation,
      kind,
      frames: snapshotFrames,
      width: dimensions.width,
      height: dimensions.height,
      projectGeneration: this.getProjectGeneration(),
      startedAt: this.now(),
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
    this.activeJob = job;
    this.setControlsLocked(true);
    return job;
  }

  isCurrent(job) {
    return !!job &&
      !job.cancelled &&
      this.activeJob === job &&
      job.id === this.generation;
  }

  assertCurrent(job) {
    if (!this.isCurrent(job)) {
      const error = new Error(job?.cancelReason || 'Aborted');
      error.name = 'AbortError';
      throw error;
    }
  }

  updateProgress(job, percent, message, progress, status) {
    this.assertCurrent(job);
    job.progress = Math.max(job.progress, Math.min(100, percent));
    if (progress) progress.style.width = job.progress + '%';
    if (status && message) status.textContent = message;
  }

  async waitForTask(job, task) {
    const outcome = await Promise.race([
      Promise.resolve(task).then(value => ({ value })),
      job.cancelSignal.then(() => ({ cancelled: true }))
    ]);
    if (outcome.cancelled) this.assertCurrent(job);
    return outcome.value;
  }

  cancel(reason = 'Export cancelled') {
    const job = this.activeJob;
    if (!job || job.cancelled) return;
    job.cancelled = true;
    job.cancelReason = reason;
    job.resolveCancel();
    if (job.encoder) job.encoder.abort();
    const currentEncoder = this.getCurrentEncoder();
    if (currentEncoder) currentEncoder.abort();
  }

  finish(job) {
    if (!job) return;
    this.releaseFrames(job.frames);
    job.frames = [];
    if (this.activeJob !== job) return;
    this.activeJob = null;
    this.onFinished({
      job,
      profile: {
        kind: job.kind,
        durationMs: Math.round(this.now() - job.startedAt),
        maxFrameBlockMs: Math.round(job.maxFrameBlockMs),
        cancelled: job.cancelled
      }
    });
    this.setControlsLocked(false);
  }
}
