"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

// POC-scoped retention bound for terminal (completed/failed/cancelled) jobs:
// this is in-memory-only state with no admin/UI surface to browse it, so a
// small documented TTL + count cap (rather than unbounded growth) keeps a
// long-running app from retaining old source paths/transcripts indefinitely.
// Active/queued jobs are never pruned by this; a job is only ever pruned
// after it has already gone terminal.
const TERMINAL_JOB_RETENTION_MS = 15 * 60 * 1000; // 15 minutes
const MAX_RETAINED_TERMINAL_JOBS = 20;
// The CLI's --wait polls this bridge roughly once a second (see the CLI
// worktree's transcribe command). The count cap alone offers no such
// guarantee: a burst of other jobs terminalizing in the same pump cycle can
// push the terminal count over MAX_RETAINED_TERMINAL_JOBS immediately after
// a job's own transition, before its own client has had any chance to poll
// it. Count-based eviction is therefore only ever applied to jobs already
// older than this grace margin — comfortably longer than any reasonable
// poll cadence — so a --wait client always gets at least one real chance to
// observe its job's terminal result. The TTL sweep above still guarantees
// eventual removal regardless of how many jobs are retained in the interim.
const TERMINAL_JOB_EVICTION_GRACE_MS = 5 * 1000; // 5 seconds

// Backs the CLI-import bridge routes (see cliBridge.js's
// /v1/audio-import-jobs). Unlike a standalone worker, the actual
// transcription runs entirely inside the one registered renderer, through
// the app's own UploadAudioView pipeline
// (transcribeFileWithSpeakers -> saveUploadNote): this module only tracks
// job lifecycle and dispatches/receives IPC, so submitting a job produces a
// real, visible Personal Notes upload note — the same one a user creates by
// picking a file in the UI — never a second, note-less pipeline.
//
// Jobs are processed one at a time (a queued job waits for the active one to
// finish) since they all drive the same renderer's single upload flow.
// In-memory only: state is lost on app restart, matching every other job
// this app already runs client-side.
class CliAudioImportBridge {
  constructor({ resolveAllowedAudioPath, approveAudioPath, supportedAudioExtensions }) {
    this._resolveAllowedAudioPath = resolveAllowedAudioPath;
    this._approveAudioPath = approveAudioPath;
    this._supportedExtensions = new Set(
      (supportedAudioExtensions || []).map((ext) => ext.toLowerCase())
    );
    this._jobs = new Map();
    this._queue = [];
    this._activeJobId = null;
    this._rendererWebContents = null;
    this._detachRendererListeners = null;
  }

  // Called when the renderer's always-mounted CLI-import host component
  // mounts. Only one renderer may be registered at a time (the control
  // panel window); a second registration simply replaces the first, since
  // there is only ever one such host in this app.
  registerRenderer(webContents) {
    // A previous registration's listeners (from this same webContents
    // object across a reload, or a prior window) must be detached before
    // attaching a fresh set, or they'd accumulate on every crash-reload
    // cycle (WindowManager reuses the same webContents object) and could
    // fire spuriously against a later, unrelated registration.
    this._detachRendererListeners?.();

    this._rendererWebContents = webContents;
    const onLost = () => this.unregisterRenderer(webContents);
    // isDestroyed() stays false across both a crash (render-process-gone,
    // after which WindowManager reloads the SAME webContents object) and a
    // same-webContents full-page reload/navigation — both wipe out the
    // renderer's JS listeners/registration without ever firing "destroyed".
    // Treat all three as an equivalent loss of this registration so an
    // active job can't be left dispatching/cancelling against a stale
    // renderer or hanging forever waiting for a report that will never
    // arrive (see ipcHandlers.js's enterprise-stream abort-on-navigation
    // for the same underlying Electron behavior). isMainFrame && !isInPlace
    // excludes in-page (hash/route) navigation, which doesn't reset the JS
    // context this host is mounted in.
    const onNavigation = (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) onLost();
    };
    webContents.once("destroyed", onLost);
    webContents.once("render-process-gone", onLost);
    webContents.on("did-start-navigation", onNavigation);
    this._detachRendererListeners = () => {
      webContents.removeListener("destroyed", onLost);
      webContents.removeListener("render-process-gone", onLost);
      webContents.removeListener("did-start-navigation", onNavigation);
    };
  }

  unregisterRenderer(webContents) {
    if (this._rendererWebContents === webContents) {
      this._detachRendererListeners?.();
      this._detachRendererListeners = null;
      this._rendererWebContents = null;
      // The renderer that owned the active job is gone: that job can never
      // report a result now, so it must terminalize rather than hang
      // "transcribing" forever (which would also wedge _pump() and every
      // queued job behind it, and make a CLI --wait poll indefinitely). A
      // queued job is drained the same way (see _pump()'s
      // isRendererAvailable() check below) rather than held for a future
      // registration: dispatching a stale job to a since-replaced renderer
      // risks running it against the wrong context, so a fresh submission
      // after re-registration is the only supported path forward.
      this._failActiveJob(
        "the desktop app's renderer became unavailable while this job was running"
      );
    }
  }

  // Terminalizes the active job (if any) as failed and resumes the queue.
  // Shared by renderer-destruction handling and by a synchronous
  // webContents.send() throw in _pump(), which is otherwise the same
  // failure mode: the renderer can no longer be dispatched to.
  _failActiveJob(reason) {
    const jobId = this._activeJobId;
    if (!jobId) return;
    this._activeJobId = null;
    const job = this._jobs.get(jobId);
    if (job && !TERMINAL_STATUSES.has(job.status)) {
      job.status = "failed";
      job.stage = "failed";
      job.error = reason;
      job.updatedAt = new Date().toISOString();
    }
    this._pump();
  }

  isRendererAvailable() {
    return !!(this._rendererWebContents && !this._rendererWebContents.isDestroyed());
  }

  // Validates and enqueues a new job. Throws an Error with a `.code` on any
  // rejection (VALIDATION | RENDERER_UNAVAILABLE) so cliBridge.js can map it
  // to the right HTTP status without string-matching messages.
  submit(rawPath) {
    if (typeof rawPath !== "string" || !rawPath || !path.isAbsolute(rawPath)) {
      throw Object.assign(new Error("path must be an absolute local file path"), {
        code: "VALIDATION",
      });
    }
    let real;
    try {
      real = fs.realpathSync(rawPath);
    } catch {
      throw Object.assign(new Error("path does not exist or is not readable"), {
        code: "VALIDATION",
      });
    }
    const stat = fs.statSync(real);
    if (!stat.isFile()) {
      throw Object.assign(new Error("path is not a file"), { code: "VALIDATION" });
    }
    const ext = path.extname(real).slice(1).toLowerCase();
    if (this._supportedExtensions.size > 0 && !this._supportedExtensions.has(ext)) {
      throw Object.assign(new Error(`unsupported audio file extension: .${ext}`), {
        code: "VALIDATION",
      });
    }
    if (!this.isRendererAvailable()) {
      throw Object.assign(
        new Error("the desktop app's renderer is not available to run this import"),
        { code: "RENDERER_UNAVAILABLE" }
      );
    }

    // Pre-approve through the same main-process allowlist the file-dialog/
    // drag-drop flow populates (see ipcHandlers.js#approveAudioPath): the
    // renderer's own transcribeAudioFile IPC call re-validates every path
    // against this allowlist, so a CLI-submitted path must be approved here
    // or that call would reject it as unapproved.
    this._approveAudioPath(real);

    const job = {
      id: crypto.randomUUID(),
      path: real,
      requestId: crypto.randomUUID(),
      status: "queued",
      stage: "queued",
      progress: 0,
      error: null,
      result: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this._jobs.set(job.id, job);
    this._queue.push(job.id);
    this._pump();
    return this._toJson(job);
  }

  _pump() {
    this._pruneTerminalJobs();
    if (this._activeJobId) return;
    const nextId = this._queue.shift();
    if (!nextId) return;
    const job = this._jobs.get(nextId);
    if (!job) {
      this._pump();
      return;
    }
    if (!this.isRendererAvailable()) {
      job.status = "failed";
      job.stage = "failed";
      job.error = "the desktop app's renderer became unavailable before this job could run";
      job.updatedAt = new Date().toISOString();
      this._pump();
      return;
    }
    this._activeJobId = job.id;
    job.status = "transcribing";
    job.stage = "transcribing";
    job.updatedAt = new Date().toISOString();
    try {
      this._rendererWebContents.send("cli-audio-import:job", {
        jobId: job.id,
        path: job.path,
        requestId: job.requestId,
      });
    } catch (err) {
      // Same failure mode as a destroyed renderer: it can't run this job,
      // so fail it explicitly instead of leaving it stuck "transcribing".
      this._failActiveJob(`failed to dispatch import job to the renderer: ${err.message}`);
    }
  }

  // Bounds in-memory retention of terminal jobs (see TERMINAL_JOB_RETENTION_MS
  // / MAX_RETAINED_TERMINAL_JOBS / TERMINAL_JOB_EVICTION_GRACE_MS above).
  // Called on every _pump() so it runs after every submit/report/cancel/
  // failure transition without needing a real timer (keeps this testable
  // without fake timers).
  _pruneTerminalJobs(now = Date.now()) {
    for (const [id, job] of this._jobs) {
      if (
        TERMINAL_STATUSES.has(job.status) &&
        now - Date.parse(job.updatedAt) > TERMINAL_JOB_RETENTION_MS
      ) {
        this._jobs.delete(id);
      }
    }
    const terminalEntries = [...this._jobs.entries()]
      .filter(([, job]) => TERMINAL_STATUSES.has(job.status))
      .sort((a, b) => Date.parse(a[1].updatedAt) - Date.parse(b[1].updatedAt));
    const excess = terminalEntries.length - MAX_RETAINED_TERMINAL_JOBS;
    if (excess <= 0) return;
    // Only the oldest entries that have already cleared the grace margin are
    // eligible for count-based eviction; a job younger than that must
    // survive this pump even if it means the cap is transiently exceeded —
    // the TTL sweep above is what guarantees it is never retained forever.
    const evictable = terminalEntries.filter(
      ([, job]) => now - Date.parse(job.updatedAt) > TERMINAL_JOB_EVICTION_GRACE_MS
    );
    const evictionCount = Math.min(excess, evictable.length);
    for (let i = 0; i < evictionCount; i++) {
      this._jobs.delete(evictable[i][0]);
    }
  }

  // Called from the renderer's report-result IPC handler once its
  // transcribeFileWithSpeakers -> saveUploadNote run settles.
  reportResult(jobId, report) {
    const job = this._jobs.get(jobId);
    if (!job || TERMINAL_STATUSES.has(job.status)) return;

    job.updatedAt = new Date().toISOString();
    if (job.stage === "cancelling" && report?.status === "completed") {
      // Backstop only: the renderer's atomic beginPersist() gate (below)
      // is the sanctioned way a commit and a cancel are serialized against
      // each other, so a "completed" report should never reach here while
      // still "cancelling" in practice. This still guards against it (e.g.
      // a caller that skipped the gate) without ever mislabeling a job
      // that actually reached "persisting" — see the stage check above,
      // which only matches "cancelling", never "persisting".
      job.status = "cancelled";
      job.stage = "cancelled";
    } else if (report?.status === "completed") {
      job.status = "completed";
      job.stage = "completed";
      job.progress = 100;
      job.result = {
        note_id: report.noteId ?? null,
        title: report.title ?? null,
        text: report.text ?? null,
        duration_seconds: report.durationSeconds ?? null,
      };
    } else if (report?.status === "cancelled") {
      job.status = "cancelled";
      job.stage = "cancelled";
    } else {
      job.status = "failed";
      job.stage = "failed";
      job.error = report?.error || "local audio import failed";
    }

    if (this._activeJobId === job.id) {
      this._activeJobId = null;
      this._pump();
    }
  }

  // The atomic commit point the renderer must win before it may call
  // saveUploadNote (see cliAudioImport.ts). This is the single, bridge-
  // mediated source of truth that a concurrent cancel() is serialized
  // against: a renderer-local "was I cancelled?" flag can't see a cancel
  // the bridge already recorded before its IPC notification arrives, and
  // rejecting an already-*saved* note after the fact (in reportResult
  // above) would mislabel a real, persisted note as cancelled. Succeeding
  // here is what lets cancel() safely refuse to flip the job back to
  // "cancelling" once persistence has been committed to.
  beginPersist(jobId) {
    const job = this._jobs.get(jobId);
    if (!job) return { ok: false, reason: "not_found" };
    if (job.id !== this._activeJobId) return { ok: false, reason: "not_active" };
    if (TERMINAL_STATUSES.has(job.status)) return { ok: false, reason: "terminal" };
    if (job.stage === "cancelling") return { ok: false, reason: "cancelling" };
    job.stage = "persisting";
    job.updatedAt = new Date().toISOString();
    return { ok: true };
  }

  // Authoritative fallback terminalization for when the renderer's normal
  // reportResult() IPC call itself is unreachable (throws/rejects) once its
  // transcribeFileWithSpeakers -> saveUploadNote run has already settled —
  // otherwise this job would be stuck "transcribing"/"persisting" forever,
  // since nothing else would ever move it to a terminal state. Requires the
  // caller's own requestId to match this job's, not just its jobId: jobId
  // alone identifies the job, but pairing it with requestId (which the
  // renderer only ever receives via the job dispatch IPC message for the
  // job it is actually running) keeps this narrowly scoped to "the job I
  // was just running", the same safe-identity precedent this bridge already
  // uses in cancel()'s cancellation-request payload.
  failJob(jobId, requestId, reason) {
    const job = this._jobs.get(jobId);
    if (!job) return { ok: false, reason: "not_found" };
    if (job.requestId !== requestId) return { ok: false, reason: "identity_mismatch" };
    if (TERMINAL_STATUSES.has(job.status)) return { ok: false, reason: "already_terminal" };
    job.status = "failed";
    job.stage = "failed";
    job.error = reason || "the renderer could not report this import's result";
    job.updatedAt = new Date().toISOString();
    if (this._activeJobId === job.id) {
      this._activeJobId = null;
      this._pump();
    }
    return { ok: true };
  }

  get(jobId) {
    const job = this._jobs.get(jobId);
    return job ? this._toJson(job) : null;
  }

  // Cancels a queued job outright, or requests cancellation of the active
  // one through the same per-request cancel path the UploadAudioView Cancel
  // button uses (window.electronAPI.cancelUploadTranscription /
  // ipcHandlers.js's upload-cancel registry) — never process killing, since
  // the work runs inside the app's own renderer/main process, not a
  // separate child.
  cancel(jobId) {
    const job = this._jobs.get(jobId);
    if (!job) return null;
    if (TERMINAL_STATUSES.has(job.status)) {
      // A terminal job has nothing left to cancel; honor the DELETE verb by
      // actually purging its stored path/transcript now rather than leaving
      // it to the passive TTL/count sweep in _pruneTerminalJobs().
      const snapshot = this._toJson(job);
      this._jobs.delete(jobId);
      return { job: snapshot, cancelled: false, already_terminal: true, purged: true };
    }
    if (job.status === "queued") {
      this._queue = this._queue.filter((id) => id !== jobId);
      job.status = "cancelled";
      job.stage = "cancelled";
      job.updatedAt = new Date().toISOString();
      return { job: this._toJson(job), cancelled: true };
    }
    if (job.stage === "persisting") {
      // beginPersist() already won this race: the renderer is saving (or
      // has saved) a real note. Report plainly that cancellation is too
      // late rather than flipping state to "cancelling" — doing that would
      // either be a no-op the renderer never observes, or, worse, let a
      // genuinely completed report get relabeled "cancelled" by the
      // backstop in reportResult above, mislabeling a real saved note.
      return { job: this._toJson(job), cancelled: false, too_late: true };
    }
    // Latch the cancel request against this active job *before* attempting
    // delivery, so reportResult()'s "cancelling" check (above) is armed
    // even if the renderer's own handling of the IPC message races with a
    // completion report that was already in flight.
    job.stage = "cancelling";
    job.updatedAt = new Date().toISOString();
    if (this.isRendererAvailable()) {
      try {
        this._rendererWebContents.send("cli-audio-import:cancel", {
          jobId: job.id,
          requestId: job.requestId,
        });
      } catch (err) {
        // Same guarantee as a dispatch-send failure: the renderer can't be
        // reached, so this job can never learn it should cancel (or ever
        // report a result) — terminalize it now instead of leaving it
        // stuck "cancelling" forever, and let the queue keep moving.
        this._failActiveJob(
          `failed to deliver cancellation request to the renderer: ${err.message}`
        );
        return { job: this._toJson(job), cancelled: false, cancellation_requested: false };
      }
    }
    return { job: this._toJson(job), cancelled: false, cancellation_requested: true };
  }

  _toJson(job) {
    return {
      job_id: job.id,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      error: job.error,
      result: job.result,
      created_at: job.createdAt,
      updated_at: job.updatedAt,
    };
  }
}

module.exports = { CliAudioImportBridge };
