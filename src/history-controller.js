export class HistoryController {
  constructor({
    getFrames,
    setFrames,
    readState,
    applyState,
    retainCanvas,
    releaseFrames,
    prepareMutation,
    getMaxBytes,
    onRestored = () => {},
    updateButtons = () => {},
    scheduleAutosave = () => {},
    showToast = () => {}
  }) {
    this.getFrames = getFrames;
    this.setFrames = setFrames;
    this.readState = readState;
    this.applyState = applyState;
    this.retainCanvas = retainCanvas;
    this.releaseFrames = releaseFrames;
    this.prepareMutation = prepareMutation;
    this.getMaxBytes = getMaxBytes;
    this.onRestored = onRestored;
    this.updateButtons = updateButtons;
    this.scheduleAutosave = scheduleAutosave;
    this.showToast = showToast;
    this.undoStack = [];
    this.redoStack = [];
  }

  captureSnapshot(label) {
    return {
      label,
      frames: this.getFrames().map(frame => ({
        canvas: this.retainCanvas(frame.canvas),
        delay: frame.delay,
        disposalType: frame.disposalType
      })),
      ...this.readState()
    };
  }

  releaseSnapshot(snapshot) {
    this.releaseFrames(snapshot?.frames);
  }

  estimateBytes() {
    const canvases = new Set();
    [...this.undoStack, ...this.redoStack].forEach(snapshot => {
      snapshot.frames.forEach(frame => canvases.add(frame.canvas));
    });
    return [...canvases].reduce(
      (sum, canvas) => sum + canvas.width * canvas.height * 4,
      0
    );
  }

  trimToBudget() {
    while (this.estimateBytes() > this.getMaxBytes()) {
      const snapshot = this.undoStack.length > 1
        ? this.undoStack.shift()
        : this.redoStack.shift() || this.undoStack.shift();
      if (!snapshot) break;
      this.releaseSnapshot(snapshot);
    }
  }

  save(label) {
    this.undoStack.push(this.captureSnapshot(label));
    this.redoStack.forEach(snapshot => this.releaseSnapshot(snapshot));
    this.redoStack = [];
    this.trimToBudget();
    this.updateButtons();
    this.scheduleAutosave();
  }

  restore(snapshot) {
    this.releaseFrames(this.getFrames());
    this.setFrames(snapshot.frames.map(frame => ({ ...frame })));
    this.applyState(snapshot);
    this.onRestored();
  }

  undo() {
    if (this.undoStack.length === 0) return false;
    if (!this.prepareMutation({ operation: 'Undo', temporaryCopies: 0 })) return false;
    this.redoStack.push(this.captureSnapshot('redo'));
    const snapshot = this.undoStack.pop();
    this.restore(snapshot);
    this.trimToBudget();
    this.updateButtons();
    this.scheduleAutosave();
    this.showToast('Undo: ' + snapshot.label, 'info');
    return true;
  }

  redo() {
    if (this.redoStack.length === 0) return false;
    if (!this.prepareMutation({ operation: 'Redo', temporaryCopies: 0 })) return false;
    this.undoStack.push(this.captureSnapshot('undo'));
    const snapshot = this.redoStack.pop();
    this.restore(snapshot);
    this.trimToBudget();
    this.updateButtons();
    this.scheduleAutosave();
    this.showToast('Redo', 'info');
    return true;
  }

  update() {
    this.updateButtons();
  }

  clear() {
    this.undoStack.forEach(snapshot => this.releaseSnapshot(snapshot));
    this.redoStack.forEach(snapshot => this.releaseSnapshot(snapshot));
    this.undoStack = [];
    this.redoStack = [];
    this.updateButtons();
  }
}
