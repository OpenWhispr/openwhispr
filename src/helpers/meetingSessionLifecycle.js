/**
 * Serializes meeting start/stop operations in call order.
 *
 * Recording setup and teardown touch shared audio/session state. Keeping the
 * queue here makes that ownership rule explicit and independently testable.
 */
class MeetingSessionLifecycle {
  constructor() {
    this._tail = Promise.resolve();
    this._stopPromise = null;
    this._pendingCount = 0;
    this._lastSessionOperationKind = null;
  }

  /**
   * @template T
   * @param {() => T | Promise<T>} operation
   * @returns {Promise<T>}
   */
  _enqueue(operation) {
    this._pendingCount += 1;
    const result = this._tail.then(operation, operation);
    const tracked = result.finally(() => {
      this._pendingCount -= 1;
    });
    this._tail = tracked.then(
      () => undefined,
      () => undefined
    );
    return tracked;
  }

  /**
   * @template T
   * @param {() => T | Promise<T>} operation
   * @returns {Promise<T>}
   */
  start(operation) {
    this._lastSessionOperationKind = "start";
    return this._enqueue(operation);
  }

  /**
   * Queue an operation that touches meeting session resources without starting
   * or stopping a recording (for example, connection pre-warming).
   *
   * @template T
   * @param {() => T | Promise<T>} operation
   * @returns {Promise<T>}
   */
  run(operation) {
    return this._enqueue(operation);
  }

  /**
   * @template T
   * @param {() => T | Promise<T>} operation
   * @returns {Promise<T>}
   */
  stop(operation) {
    if (this._stopPromise && this._lastSessionOperationKind === "stop") {
      return this._stopPromise;
    }

    this._lastSessionOperationKind = "stop";
    const result = this._enqueue(operation);
    const tracked = result.finally(() => {
      if (this._stopPromise === tracked) this._stopPromise = null;
    });
    this._stopPromise = tracked;
    this._tail = tracked.then(
      () => undefined,
      () => undefined
    );
    return tracked;
  }

  whenIdle() {
    return this._tail;
  }

  get isStopping() {
    return this._stopPromise !== null;
  }

  get hasPendingOperations() {
    return this._pendingCount > 0;
  }
}

module.exports = { MeetingSessionLifecycle };
