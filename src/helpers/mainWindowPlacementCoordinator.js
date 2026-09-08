class MainWindowPlacementCoordinator {
  constructor() {
    this._requestId = 0;
    this._hasManualPosition = false;
  }

  cancelPending() {
    this._requestId += 1;
  }

  markManuallyPositioned() {
    this._hasManualPosition = true;
    this.cancelPending();
  }

  resetManualPosition() {
    this._hasManualPosition = false;
    this.cancelPending();
  }

  async request(resolvePlacement, applyPlacement) {
    if (this._hasManualPosition) {
      return { applied: false, reason: "manual-position" };
    }

    const requestId = ++this._requestId;
    const isCurrent = () => requestId === this._requestId && !this._hasManualPosition;
    const placement = await resolvePlacement();

    if (!isCurrent()) {
      return { applied: false, reason: "superseded" };
    }

    return applyPlacement(placement, isCurrent);
  }
}

module.exports = MainWindowPlacementCoordinator;
