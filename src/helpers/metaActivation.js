const { randomUUID } = require("node:crypto");

// A small dedicated queue. It never reads transcription/Insights tables and
// never stores text, audio, model names, titles or application context.
class MetaActivation {
  constructor({ db, getScope, request, monotonicNow = () => performance.now() }) {
    this.db = db;
    this.getScope = getScope;
    this.request = request;
    this.monotonicNow = monotonicNow;
    this.anchor = null;
    this.running = null;
    this.failedCaptures = new Set();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS streams (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'new',
        registered_at TEXT, complete_through TEXT, last_seq INTEGER NOT NULL DEFAULT 0,
        total_words INTEGER NOT NULL DEFAULT 0, gap INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS captures (
        id TEXT PRIMARY KEY, stream_id TEXT NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL, started_at TEXT NOT NULL, occurred_at TEXT,
        seq INTEGER, words INTEGER
      );
    `);
    // A process died before persisting a result. Do not certify that interval
    // complete, even if a recovered recording later appears in ordinary history.
    this.db
      .exec(`UPDATE streams SET gap=1 WHERE id IN (SELECT stream_id FROM captures WHERE words IS NULL);
      DELETE FROM captures WHERE words IS NULL;`);
  }

  start() {
    this.timer = setInterval(() => void this.flush(true), 30_000);
    this.timer.unref?.();
    void this.flush();
  }

  current(scope = this.getScope()) {
    if (!scope) return null;
    return this.db
      .prepare("SELECT * FROM streams WHERE account_id=? ORDER BY rowid DESC LIMIT 1")
      .get(scope.accountId);
  }

  clock(scope) {
    if (
      !this.anchor ||
      this.anchor.accountId !== scope?.accountId ||
      this.anchor.generation !== scope?.authGeneration
    )
      return null;
    return this.anchor.serverTime + (this.monotonicNow() - this.anchor.monotonicTime);
  }

  begin() {
    const scope = this.getScope();
    let stream = this.current(scope);
    if (!scope) return null;
    if (!stream || stream.state === "closed") {
      this.db
        .prepare("INSERT INTO streams(id,account_id) VALUES(?,?)")
        .run(randomUUID(), scope.accountId);
      stream = this.current(scope);
    }
    if (stream.state === "done") return null;
    const time = this.clock(scope);
    if (time === null || stream.state !== "open") {
      // The cohort starts only after permitted registration. Earlier usage
      // is intentionally untracked; a missing clock after enrollment is a gap.
      if (stream.registered_at)
        this.db.prepare("UPDATE streams SET gap=1 WHERE id=?").run(stream.id);
      void this.flush();
      return null;
    }
    if (stream.total_words >= 200) return null;
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO captures(id,stream_id,generation,started_at) VALUES(?,?,?,?)")
      .run(id, stream.id, scope.authGeneration, new Date(Math.ceil(time)).toISOString());
    return id;
  }

  stopCapture(id) {
    const row = this.db
      .prepare(
        "SELECT c.*,s.account_id FROM captures c JOIN streams s ON s.id=c.stream_id WHERE c.id=?"
      )
      .get(id);
    if (!row || row.occurred_at) return;
    const scope = this.getScope();
    const time = this.clock(scope);
    if (
      !scope ||
      scope.accountId !== row.account_id ||
      scope.authGeneration !== row.generation ||
      time === null
    ) {
      this.db.prepare("UPDATE streams SET gap=1 WHERE id=?").run(row.stream_id);
      return;
    }
    this.db
      .prepare("UPDATE captures SET occurred_at=? WHERE id=?")
      .run(new Date(Math.max(Math.ceil(time), Date.parse(row.started_at) + 1)).toISOString(), id);
  }

  finish(id, wordCount) {
    if (typeof id !== "string" || !Number.isSafeInteger(wordCount) || wordCount < 0) return;
    try {
      this.db.transaction(() => {
        const row = this.db
          .prepare(
            "SELECT c.*,s.account_id,s.total_words,s.last_seq FROM captures c JOIN streams s ON s.id=c.stream_id WHERE c.id=?"
          )
          .get(id);
        if (!row || row.words !== null) return;
        const scope = this.getScope();
        if (
          !scope ||
          scope.accountId !== row.account_id ||
          scope.authGeneration !== row.generation
        ) {
          this.db.prepare("UPDATE streams SET gap=1 WHERE id=?").run(row.stream_id);
          this.db.prepare("DELETE FROM captures WHERE id=?").run(id);
          return;
        }
        const words = Math.min(wordCount, 200 - row.total_words);
        if (words === 0) {
          this.db.prepare("DELETE FROM captures WHERE id=?").run(id);
          return;
        }
        if (!row.occurred_at) {
          this.db.prepare("UPDATE streams SET gap=1 WHERE id=?").run(row.stream_id);
          this.db.prepare("DELETE FROM captures WHERE id=?").run(id);
          return;
        }
        this.db
          .prepare("UPDATE captures SET words=?,seq=? WHERE id=?")
          .run(words, row.last_seq + 1, id);
        this.db
          .prepare("UPDATE streams SET last_seq=last_seq+1,total_words=total_words+? WHERE id=?")
          .run(words, row.stream_id);
      })();
    } catch (error) {
      // Keep the unresolved capture across renderer cleanup. On restart it
      // becomes a durable coverage gap instead of silently losing spoken words.
      this.failedCaptures.add(id);
      throw error;
    }
    void this.flush();
  }

  cancel(id) {
    if (typeof id !== "string" || this.failedCaptures.has(id)) return;
    this.db.prepare("DELETE FROM captures WHERE id=? AND words IS NULL").run(id);
    void this.flush();
  }

  async flush(scheduled = false) {
    if (this.disposed) return;
    if (this.running) return this.running;
    this.running = this.runPass(scheduled)
      .catch(() => {})
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  async runPass(scheduled) {
    const scope = this.getScope();
    if (!scope) return;
    const assertCurrent = () => {
      const current = this.getScope();
      if (this.disposed) throw new Error("Activation storage closed");
      if (
        !current ||
        current.accountId !== scope.accountId ||
        current.authGeneration !== scope.authGeneration
      )
        throw new Error("Account changed");
    };
    let stream = this.current(scope);
    if (!stream || stream.state === "closed") {
      const id = randomUUID();
      this.db.prepare("INSERT INTO streams(id,account_id) VALUES(?,?)").run(id, scope.accountId);
      stream = this.current(scope);
    }
    if (stream.state === "done") return;
    // Once the server answers awaiting_permission or refuses (403, e.g. org
    // policy) an unregistered stream, only activity posts again. A registered
    // stream keeps certifying its watermark, and a lost answer may have
    // committed a device, so the timer retries both.
    if (scheduled && this.unpermittedStream === stream.id) return;
    const post = async (path, body) => {
      assertCurrent();
      this.unpermittedStream = null;
      const result = await this.request({
        path,
        method: "POST",
        body,
        expectedAuthGeneration: scope.authGeneration,
      });
      assertCurrent();
      if (!result?.success) {
        if (result?.status === 403 && !stream.registered_at) this.unpermittedStream = stream.id;
        throw new Error("Activation sync unavailable");
      }
      return result.data;
    };
    if (this.clock(scope) === null || stream.state === "new") {
      const response = await post("/api/activation/device", {
        accountId: scope.accountId,
        deviceId: stream.id,
      });
      if (response.status === "awaiting_permission") {
        this.unpermittedStream = stream.id;
        return;
      }
      if (response.status !== "collecting") {
        this.retire(stream.id);
        return;
      }
      if (!response.device || !Number.isFinite(Date.parse(response.serverTime)))
        throw new Error("Invalid registration");
      if (response.device.closed) {
        this.db.prepare("UPDATE streams SET state='closed' WHERE id=?").run(stream.id);
        return;
      }
      this.anchor = {
        accountId: scope.accountId,
        generation: scope.authGeneration,
        serverTime: Date.parse(response.serverTime),
        monotonicTime: this.monotonicNow(),
      };
      this.db
        .prepare(
          "UPDATE streams SET state=CASE WHEN state='closing' THEN state ELSE 'open' END,registered_at=?,complete_through=COALESCE(complete_through,?) WHERE id=?"
        )
        .run(
          new Date(response.device.registered_at).toISOString(),
          new Date(response.device.complete_through).toISOString(),
          stream.id
        );
      stream = this.current(scope);
    }
    const pending = this.db
      .prepare("SELECT * FROM captures WHERE stream_id=? ORDER BY seq")
      .all(stream.id);
    // Stop times belong to unfinished STT/cleanup work. Don't advance a device
    // checkpoint while that work could still add an earlier contribution.
    if (pending.some((row) => row.words === null) && !stream.gap) return;
    const completeThrough = new Date(
      Math.max(
        Math.ceil(this.clock(scope)),
        Date.parse(stream.complete_through),
        ...pending.map((row) => Date.parse(row.occurred_at))
      )
    ).toISOString();
    const events = pending
      .filter((row) => row.words !== null)
      .map((row) => ({
        eventId: row.id,
        seq: row.seq,
        words: row.words,
        occurredAt: row.occurred_at,
      }));
    const result = await post("/api/activation/batch", {
      deviceId: stream.id,
      events,
      completeThrough,
      close: stream.state === "closing",
      gap: Boolean(stream.gap),
    });
    if (result.status !== "collecting") {
      this.retire(stream.id);
      return;
    }
    if (!Number.isSafeInteger(result.acceptedThrough) || result.acceptedThrough > stream.last_seq)
      throw new Error("Invalid acknowledgement");
    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM captures WHERE stream_id=? AND seq<=?")
        .run(stream.id, result.acceptedThrough);
      this.db
        .prepare(
          "UPDATE streams SET complete_through=?,state=CASE WHEN ? AND state='closing' THEN 'closed' ELSE state END WHERE id=?"
        )
        .run(completeThrough, stream.state === "closing" ? 1 : 0, stream.id);
    })();
  }

  retire(id) {
    for (const row of this.db.prepare("SELECT id FROM captures WHERE stream_id=?").all(id))
      this.failedCaptures.delete(row.id);
    this.db.transaction(() => {
      this.db.prepare("UPDATE streams SET state='done' WHERE id=?").run(id);
      this.db.prepare("DELETE FROM captures WHERE stream_id=?").run(id);
    })();
  }

  async close() {
    const stream = this.current();
    if (
      !stream ||
      stream.state === "done" ||
      stream.state === "closed" ||
      this.unpermittedStream === stream.id
    )
      return;
    const unresolved = this.db
      .prepare("SELECT 1 FROM captures WHERE stream_id=? AND words IS NULL LIMIT 1")
      .get(stream.id);
    if (unresolved) {
      this.db.prepare("UPDATE streams SET gap=1 WHERE id=?").run(stream.id);
    }
    this.db.prepare("DELETE FROM captures WHERE stream_id=? AND words IS NULL").run(stream.id);
    this.db.prepare("UPDATE streams SET state='closing' WHERE id=?").run(stream.id);
    await this.flush();
    // An already-running pass may have read the pre-close state.
    if (this.current()?.state === "closing" && this.unpermittedStream !== stream.id)
      await this.flush();
    this.anchor = null;
  }

  purge(accountId) {
    const captures = this.db
      .prepare(
        "SELECT c.id FROM captures c JOIN streams s ON s.id=c.stream_id WHERE s.account_id=?"
      )
      .all(accountId);
    for (const row of captures) this.failedCaptures.delete(row.id);
    this.db.prepare("DELETE FROM streams WHERE account_id=?").run(accountId);
    this.anchor = null;
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    this.anchor = null;
    this.failedCaptures.clear();
    this.db.close();
  }

  async shutdown() {
    clearInterval(this.timer);
    await this.close();
  }
}

module.exports = { MetaActivation };
