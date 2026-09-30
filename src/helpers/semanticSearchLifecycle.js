const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const RETRY_DELAY_MS = 30 * 1000;
const DRAIN_PAGE_SIZE = 50;
// A row that fails this many passes is parked until the next activation, so one
// poison note never disables semantic search for the rest.
const MAX_ROW_FAILURES = 3;

// Owns all note-vector work so idle teardown cannot race a query or an index write.
class SemanticSearchLifecycle {
  constructor({
    qdrant,
    vectorIndex,
    embeddings,
    noteEmbedText,
    database,
    logger,
    now = Date.now,
    setTimeout = global.setTimeout,
    clearTimeout = global.clearTimeout,
  }) {
    this.qdrant = qdrant;
    this.vectorIndex = vectorIndex;
    this.embeddings = embeddings;
    this.noteEmbedText = noteEmbedText;
    this.database = database;
    this.logger = logger;
    this.now = now;
    this.setTimeout = setTimeout;
    this.clearTimeout = clearTimeout;
    this.ready = false;
    this.closed = false;
    this.activationPromise = null;
    this.stoppingPromise = null;
    this.searches = new Set();
    this.idleTimer = null;
    this.retryTimer = null;
    this.retryAfter = 0;
    this.indexPort = null;
    this.drainedThroughRevision = 0;
    this.retryDue = false;
    this.rowFailures = new Map();
    this.lastActivity = now();
    this.onRestart = () => {
      this.ready = false;
      // Qdrant emits before leaving its restart critical section. Also wait
      // for any old-port indexing attempt before preparing the replacement.
      Promise.resolve(this.activationPromise)
        .then(() => (this.closed ? false : this.warmUp({ recovery: true })))
        .catch((error) =>
          this.logger.warn("Semantic search recovery failed", { error: error.message })
        );
    };
    qdrant.on("restarted", this.onRestart);
  }

  // An initialized index on a live Qdrant; it may lag journal rows still draining.
  _canSearch() {
    return (
      this.ready &&
      !this.closed &&
      !this.stoppingPromise &&
      this.qdrant.isReady() &&
      this.indexPort === this.qdrant.getPort()
    );
  }

  isReady() {
    return (
      this._canSearch() &&
      !this.activationPromise &&
      !this.retryDue &&
      this.database.getPendingVectorChanges(1, this.drainedThroughRevision).length === 0
    );
  }

  _clearIdleTimer() {
    if (this.idleTimer !== null) this.clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  _clearRetryTimer() {
    if (this.retryTimer !== null) this.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryDue = false;
  }

  // One timer per pass. Indexed rows leave the journal, so a retry pass re-walks
  // it from the start and only revisits the rows that failed.
  _scheduleRetry() {
    if (this.retryTimer !== null) return;
    this.retryTimer = this.setTimeout(() => {
      this.retryTimer = null;
      // Wait for an in-flight pass so it cannot overwrite the rewound cursor.
      return Promise.resolve(this.activationPromise)
        .then(() => {
          this.retryDue = true;
          this.drainedThroughRevision = 0;
          return this.closed ? false : this.warmUp({ recovery: true });
        })
        .catch((error) =>
          this.logger.warn("Semantic search retry failed", { error: error.message })
        );
    }, RETRY_DELAY_MS);
    this.retryTimer?.unref?.();
  }

  _scheduleIdle() {
    this._clearIdleTimer();
    if (!this.ready || this.closed || this.activationPromise || this.searches.size) return;
    const remaining = Math.max(0, IDLE_TIMEOUT_MS - (this.now() - this.lastActivity));
    this.idleTimer = this.setTimeout(() => this._stopIdle(), remaining);
    this.idleTimer?.unref?.();
  }

  // Forget the index so the next activation re-walks the whole journal.
  _resetIndexState() {
    this.ready = false;
    this.vectorIndex.reset();
    this.indexPort = null;
    this.drainedThroughRevision = 0;
    this.rowFailures.clear();
    this._clearRetryTimer();
  }

  async _releaseResources() {
    this._resetIndexState();
    try {
      await this.qdrant.stop();
    } finally {
      await this.embeddings.unload();
    }
  }

  _stopIdle() {
    this._clearIdleTimer();
    if (this.closed || this.activationPromise || this.searches.size) return Promise.resolve();
    if (this.qdrant.restarting) {
      // Stopping inside _restartUnhealthy would burn a restart attempt; look again later.
      this.idleTimer = this.setTimeout(() => this._stopIdle(), RETRY_DELAY_MS);
      this.idleTimer?.unref?.();
      return Promise.resolve();
    }
    this.stoppingPromise = this._releaseResources()
      .catch((error) =>
        this.logger.warn("Semantic search idle cleanup failed", { error: error.message })
      )
      .finally(() => {
        this.stoppingPromise = null;
      });
    return this.stoppingPromise;
  }

  // Database triggers retain changes while asleep; notifications only wake an already-used index.
  notifyChanges() {
    if (!this.ready && !this.activationPromise) return;
    this.warmUp().catch((error) =>
      this.logger.warn("Semantic search wake failed", { error: error.message })
    );
  }

  async warmUp({ recovery = false } = {}) {
    if (this.closed) return false;
    if (this.activationPromise) return this.activationPromise;
    if (this.isReady()) return true;
    if (this.now() < this.retryAfter) return false;
    // Let the existing health supervisor own unhealthy restarts and their retry budget.
    if (
      !this.stoppingPromise &&
      (this.qdrant.restarting || (this.qdrant.process && !this.qdrant.isReady()))
    ) {
      return false;
    }
    if (this.qdrant.restartBlocked) return false;

    if (!recovery) this.lastActivity = this.now();
    this._clearIdleTimer();
    this.activationPromise = this._activate()
      .catch(async (error) => {
        this.retryAfter = this.now() + RETRY_DELAY_MS;
        this.logger.debug("Semantic search unavailable; using keyword search", {
          error: error.message,
        });
        await this._releaseResources().catch((cleanupError) => {
          this.logger.warn("Semantic search cleanup failed", { error: cleanupError.message });
        });
        return false;
      })
      .finally(() => {
        this.activationPromise = null;
        this._scheduleIdle();
      });
    return this.activationPromise;
  }

  async _activate() {
    if (this.stoppingPromise) await this.stoppingPromise;
    await Promise.allSettled([...this.searches]);
    if (this.closed) return false;
    if (!this.qdrant.isAvailable()) throw new Error("Qdrant binary is unavailable");
    if (!this.embeddings.isAvailable()) await this.embeddings.downloadModel();
    if (this.closed) return false;
    await this.qdrant.start();
    if (this.closed || !this.qdrant.isReady()) return false;
    this.vectorIndex.init(this.qdrant.getPort());
    this.indexPort = this.qdrant.getPort();
    const collection = await this.vectorIndex.ensureCollection();
    // An existing collection answers while the journal catches it up; a new one is empty.
    if (collection.created) this.database.enqueueAllVectorChanges();
    else this.ready = true;
    await this._drainPending();
    if (this.closed) return false;
    this.ready = true;
    this.retryAfter = 0;
    return true;
  }

  // Returns whether the row is still worth retrying after this failure.
  _recordRowFailure(key, meta) {
    const failures = (this.rowFailures.get(key) ?? 0) + 1;
    this.rowFailures.set(key, failures);
    this.logger.debug("Vector update failed; skipping row for this pass", { ...meta, failures });
    return failures < MAX_ROW_FAILURES;
  }

  _isParked(key) {
    return (this.rowFailures.get(key) ?? 0) >= MAX_ROW_FAILURES;
  }

  async _applyChange(noteId) {
    const note = this.database.getNoteForVectorIndex(noteId);
    if (!note || note.deleted_at) return this.vectorIndex.deleteNote(noteId);
    return this.vectorIndex.upsertNote(
      noteId,
      this.noteEmbedText(note.title, note.content, note.enhanced_content),
      { space_id: note.space_id, folder_id: note.folder_id ?? null }
    );
  }

  // Purged notes are also journaled by the delete triggers and filtered by scope
  // on read, so a failed purge is retried without blocking readiness.
  async _drainPurges() {
    let retry = false;
    for (const { space_id } of this.database.getPendingVectorPurges()) {
      if (this.closed) return retry;
      const key = `space:${space_id}`;
      if (this._isParked(key)) continue;
      if (await this.vectorIndex.deleteBySpace(space_id)) {
        this.database.clearPendingVectorPurge(space_id);
      } else if (this._recordRowFailure(key, { spaceId: space_id })) {
        retry = true;
      }
      this.lastActivity = this.now();
    }
    return retry;
  }

  async _drainPending() {
    this.retryDue = false;
    let retry = await this._drainPurges();
    let cursor = this.drainedThroughRevision;
    while (!this.closed) {
      const changes = this.database.getPendingVectorChanges(DRAIN_PAGE_SIZE, cursor);
      if (changes.length === 0) break;
      for (const { note_id, revision } of changes) {
        if (this.closed) return;
        cursor = revision;
        const key = `${note_id}:${revision}`;
        if (this._isParked(key)) continue;
        if (await this._applyChange(note_id)) {
          this.database.clearPendingVectorChange(note_id, revision);
        } else if (this._recordRowFailure(key, { noteId: note_id, revision })) {
          retry = true;
        }
        this.lastActivity = this.now();
      }
    }
    if (this.closed) return;
    this.drainedThroughRevision = cursor;
    if (retry) this._scheduleRetry();
  }

  // Never waits: a cold index answers with keywords, and a warm one searches while
  // pending changes drain in the background.
  async search(query, limit, filter) {
    this.lastActivity = this.now();
    if (!this.isReady()) {
      this.warmUp().catch((error) =>
        this.logger.warn("Semantic search warm-up failed", { error: error.message })
      );
      if (!this._canSearch()) return null;
    }
    this._clearIdleTimer();
    const search = this.vectorIndex.search(query, limit, filter);
    this.searches.add(search);
    try {
      return await search;
    } finally {
      this.searches.delete(search);
      this.lastActivity = this.now();
      this._scheduleIdle();
    }
  }

  async stop() {
    this.closed = true;
    this.ready = false;
    this._clearIdleTimer();
    this._clearRetryTimer();
    this.qdrant.removeListener("restarted", this.onRestart);
    try {
      // Cancel a port scan immediately; _activate checks closed after each preparation step.
      await this.qdrant.stop();
      await Promise.allSettled([this.activationPromise, this.stoppingPromise, ...this.searches]);
      this._resetIndexState();
      await this.embeddings.unload();
    } catch (error) {
      this.logger.warn("Semantic search shutdown cleanup failed", { error: error.message });
    }
  }
}

module.exports = SemanticSearchLifecycle;
