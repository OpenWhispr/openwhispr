const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const RETRY_DELAY_MS = 30 * 1000;

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
    this.retryAfter = 0;
    this.indexedCount = 0;
    this.indexPort = null;
    this.lastActivity = now();
    this.onRestart = () => {
      this.ready = false;
      // Qdrant emits before leaving its restart critical section. Also wait
      // for any old-port indexing attempt before preparing the replacement.
      void Promise.resolve(this.activationPromise).then(() => {
        if (!this.closed) void this.warmUp({ recovery: true });
      });
    };
    qdrant.on("restarted", this.onRestart);
  }

  isReady() {
    return (
      this.ready &&
      !this.closed &&
      !this.activationPromise &&
      !this.stoppingPromise &&
      this.qdrant.isReady() &&
      this.indexPort === this.qdrant.getPort() &&
      this.database.getPendingVectorChanges(1).length === 0 &&
      this.database.getPendingVectorPurges().length === 0
    );
  }

  _clearIdleTimer() {
    if (this.idleTimer !== null) this.clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  _scheduleIdle() {
    this._clearIdleTimer();
    if (!this.ready || this.closed || this.activationPromise || this.searches.size) return;
    const remaining = Math.max(0, IDLE_TIMEOUT_MS - (this.now() - this.lastActivity));
    this.idleTimer = this.setTimeout(() => this._stopIdle(), remaining);
    this.idleTimer?.unref?.();
  }

  async _releaseResources() {
    this.ready = false;
    this.vectorIndex.reset();
    this.indexPort = null;
    try {
      await this.qdrant.stop();
    } finally {
      await this.embeddings.unload();
    }
  }

  _stopIdle() {
    this._clearIdleTimer();
    if (this.closed || this.activationPromise || this.searches.size) return Promise.resolve();
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
    void this.warmUp();
  }

  warmUp({ recovery = false } = {}) {
    if (this.closed) return Promise.resolve(false);
    if (this.activationPromise) return this.activationPromise;
    if (this.isReady()) return Promise.resolve(true);
    if (this.now() < this.retryAfter) return Promise.resolve(false);
    // Let the existing health supervisor own unhealthy restarts and their retry budget.
    if (
      !this.stoppingPromise &&
      (this.qdrant.restarting || (this.qdrant.process && !this.qdrant.isReady()))
    ) {
      return Promise.resolve(false);
    }
    if (this.qdrant.restartBlocked) return Promise.resolve(false);

    if (!recovery) this.lastActivity = this.now();
    this.ready = false;
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
    if (collection.created) this.database.enqueueAllVectorChanges();
    await this._drainPending();
    if (this.closed) return false;
    this.ready = true;
    this.retryAfter = 0;
    return true;
  }

  async _drainPending() {
    while (!this.closed) {
      for (const { space_id } of this.database.getPendingVectorPurges()) {
        if (!(await this.vectorIndex.deleteBySpace(space_id)))
          throw new Error("Vector space purge failed");
        this.database.clearPendingVectorPurge(space_id);
        this.lastActivity = this.now();
        if (this.closed) return;
      }
      const changes = this.database.getPendingVectorChanges();
      if (changes.length === 0) return;
      for (const { note_id, revision } of changes) {
        if (this.closed) return;
        const note = this.database.getNoteForVectorIndex(note_id);
        const live = note && !note.deleted_at;
        const succeeded = live
          ? await this.vectorIndex.upsertNote(
              note_id,
              this.noteEmbedText(note.title, note.content, note.enhanced_content),
              { space_id: note.space_id, folder_id: note.folder_id ?? null }
            )
          : await this.vectorIndex.deleteNote(note_id);
        if (!succeeded) throw new Error(`Vector update failed for note ${note_id}`);
        this.database.clearPendingVectorChange(note_id, revision);
        this.lastActivity = this.now();
        if (live) this.indexedCount++;
      }
    }
  }

  async search(query, limit, filter) {
    this.lastActivity = this.now();
    if (!this.isReady()) {
      void this.warmUp();
      return null;
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

  async reindex() {
    if (this.closed) return { success: false, error: "Semantic search is stopped" };
    this.database.enqueueAllVectorChanges();
    this.retryAfter = 0;
    const before = this.indexedCount;
    const success = await this.warmUp();
    return {
      success,
      indexed: this.indexedCount - before,
      ...(!success && { error: "Vector index not ready" }),
    };
  }

  async stop() {
    this.closed = true;
    this.ready = false;
    this._clearIdleTimer();
    this.qdrant.removeListener("restarted", this.onRestart);
    // Cancel a port scan immediately; _activate checks closed after each preparation step.
    await this.qdrant.stop();
    await Promise.allSettled([this.activationPromise, this.stoppingPromise, ...this.searches]);
    await this._releaseResources();
  }
}

module.exports = SemanticSearchLifecycle;
