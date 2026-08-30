const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

// ipcHandlers.js requires electron at module scope; stub the pieces it
// touches at load time, mirroring the same technique
// test/helpers/cliBridgeDictionary.test.js uses for the same reason.
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      ipcMain: { handle() {}, on() {} },
      app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isReady: () => false },
      shell: {},
      BrowserWindow: class {},
      systemPreferences: {},
      net: {},
      session: {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { CliAudioImportBridge } = require("../../src/helpers/cliAudioImportBridge.js");
const {
  approveAudioPath,
  resolveAllowedAudioPath,
  SUPPORTED_AUDIO_EXTENSIONS,
} = require("../../src/helpers/ipcHandlers.js");

// A fake renderer webContents: just enough surface (send/once/isDestroyed)
// for the bridge to treat it as a live registration.
function makeFakeWebContents() {
  const sent = [];
  const listeners = {};
  const addListener = (event, listener, once) => {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push({ listener, once });
  };
  const fire = (event, ...args) => {
    const entries = listeners[event] ? listeners[event].slice() : [];
    for (const entry of entries) entry.listener(...args);
    // Mirror real EventEmitter semantics: a `once` listener self-removes
    // after firing, which is what lets registerRenderer's cleanup safely
    // call removeListener again without erroring on an already-gone entry.
    if (listeners[event]) {
      listeners[event] = listeners[event].filter((entry) => !entry.once);
    }
  };
  return {
    sent,
    send(channel, payload) {
      sent.push({ channel, payload });
    },
    once(event, listener) {
      addListener(event, listener, true);
    },
    on(event, listener) {
      addListener(event, listener, false);
    },
    removeListener(event, listener) {
      if (!listeners[event]) return;
      listeners[event] = listeners[event].filter((entry) => entry.listener !== listener);
    },
    isDestroyed() {
      return false;
    },
    _fireDestroyed() {
      fire("destroyed");
    },
    _fireRenderProcessGone(details = { reason: "crashed" }) {
      fire("render-process-gone", {}, details);
    },
    _fireNavigation({ isInPlace = false, isMainFrame = true, url = "http://localhost/control-panel" } = {}) {
      fire("did-start-navigation", {}, url, isInPlace, isMainFrame);
    },
    _listenerCount(event) {
      return listeners[event] ? listeners[event].length : 0;
    },
  };
}

function makeBridge() {
  return new CliAudioImportBridge({
    approveAudioPath,
    resolveAllowedAudioPath,
    supportedAudioExtensions: SUPPORTED_AUDIO_EXTENSIONS,
  });
}

function makeAudioFile(t, name = "clip.mp3") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-cli-import-test-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, "not real audio, just bytes for a path check");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return file;
}

test("submit rejects a non-absolute path", () => {
  const bridge = makeBridge();
  assert.throws(() => bridge.submit("relative/audio.mp3"), { code: "VALIDATION" });
});

test("submit rejects a path that does not exist", () => {
  const bridge = makeBridge();
  assert.throws(() => bridge.submit("/definitely/not/a/real/path/audio.mp3"), {
    code: "VALIDATION",
  });
});

test("submit rejects an unsupported extension", (t) => {
  const bridge = makeBridge();
  bridge.registerRenderer(makeFakeWebContents());
  const file = makeAudioFile(t, "clip.txt");
  assert.throws(() => bridge.submit(file), { code: "VALIDATION" });
});

test("submit rejects when no renderer is registered", (t) => {
  const bridge = makeBridge();
  const file = makeAudioFile(t);
  assert.throws(() => bridge.submit(file), { code: "RENDERER_UNAVAILABLE" });
});

test("submit approves the path and dispatches it to the registered renderer", (t) => {
  const bridge = makeBridge();
  const renderer = makeFakeWebContents();
  bridge.registerRenderer(renderer);
  const file = makeAudioFile(t);

  const job = bridge.submit(file);

  assert.equal(job.status, "transcribing", "single job runs immediately");
  assert.equal(job.stage, "transcribing");
  assert.equal(job.progress, 0);
  assert.equal(renderer.sent.length, 1);
  assert.equal(renderer.sent[0].channel, "cli-audio-import:job");
  assert.equal(renderer.sent[0].payload.path, fs.realpathSync(file));
  assert.ok(resolveAllowedAudioPath(file), "the path was approved through the shared allowlist");
});

test("a second submission queues behind the active job", (t) => {
  const bridge = makeBridge();
  const renderer = makeFakeWebContents();
  bridge.registerRenderer(renderer);
  const first = bridge.submit(makeAudioFile(t, "first.mp3"));
  const second = bridge.submit(makeAudioFile(t, "second.mp3"));

  assert.equal(first.status, "transcribing");
  assert.equal(second.status, "queued");
  assert.equal(renderer.sent.length, 1, "only the active job is dispatched");

  bridge.reportResult(first.job_id, { status: "completed", noteId: 1, title: "t", text: "hi" });

  assert.equal(bridge.get(second.job_id).status, "transcribing");
  assert.equal(renderer.sent.length, 2, "the queued job is pumped once the active one finishes");
});

test("reportResult populates the result for a completed job", (t) => {
  const bridge = makeBridge();
  bridge.registerRenderer(makeFakeWebContents());
  const job = bridge.submit(makeAudioFile(t));

  bridge.reportResult(job.job_id, {
    status: "completed",
    noteId: 7,
    title: "My note",
    text: "hello",
    durationSeconds: 3.5,
  });

  const stored = bridge.get(job.job_id);
  assert.equal(stored.status, "completed");
  assert.equal(stored.progress, 100);
  assert.deepEqual(stored.result, {
    note_id: 7,
    title: "My note",
    text: "hello",
    duration_seconds: 3.5,
  });
});

test("reportResult maps a failure to status failed with the error message", (t) => {
  const bridge = makeBridge();
  bridge.registerRenderer(makeFakeWebContents());
  const job = bridge.submit(makeAudioFile(t));

  bridge.reportResult(job.job_id, { status: "failed", error: "boom" });

  const stored = bridge.get(job.job_id);
  assert.equal(stored.status, "failed");
  assert.equal(stored.error, "boom");
});

test("reportResult is ignored once a job is already terminal", (t) => {
  const bridge = makeBridge();
  bridge.registerRenderer(makeFakeWebContents());
  const job = bridge.submit(makeAudioFile(t));

  bridge.reportResult(job.job_id, { status: "completed", text: "first" });
  bridge.reportResult(job.job_id, { status: "failed", error: "should not apply" });

  assert.equal(bridge.get(job.job_id).status, "completed");
  assert.equal(bridge.get(job.job_id).result.text, "first");
});

test("cancel removes a queued job outright", (t) => {
  const bridge = makeBridge();
  const renderer = makeFakeWebContents();
  bridge.registerRenderer(renderer);
  bridge.submit(makeAudioFile(t, "first.mp3"));
  const queued = bridge.submit(makeAudioFile(t, "second.mp3"));

  const outcome = bridge.cancel(queued.job_id);

  assert.equal(outcome.cancelled, true);
  assert.equal(bridge.get(queued.job_id).status, "cancelled");
});

test("cancel of the active job requests cancellation through IPC, not process killing", (t) => {
  const bridge = makeBridge();
  const renderer = makeFakeWebContents();
  bridge.registerRenderer(renderer);
  const job = bridge.submit(makeAudioFile(t));

  const outcome = bridge.cancel(job.job_id);

  assert.equal(outcome.cancelled, false);
  assert.equal(outcome.cancellation_requested, true);
  const cancelMessages = renderer.sent.filter((m) => m.channel === "cli-audio-import:cancel");
  assert.equal(cancelMessages.length, 1);
  assert.equal(cancelMessages[0].payload.jobId, job.job_id);
  // Still transcribing until the renderer actually reports back — the bridge
  // never assumes success, since it has no way to kill anything itself.
  assert.equal(bridge.get(job.job_id).status, "transcribing");
});

test("cancel of an already-terminal job reports already_terminal without error", (t) => {
  const bridge = makeBridge();
  bridge.registerRenderer(makeFakeWebContents());
  const job = bridge.submit(makeAudioFile(t));
  bridge.reportResult(job.job_id, { status: "completed", text: "hi" });

  const outcome = bridge.cancel(job.job_id);
  assert.equal(outcome.already_terminal, true);
  assert.equal(outcome.cancelled, false);
});

test("cancel and get return null for an unknown job id", () => {
  const bridge = makeBridge();
  assert.equal(bridge.get("does-not-exist"), null);
  assert.equal(bridge.cancel("does-not-exist"), null);
});

test("a renderer that becomes unavailable fails the next queued job instead of hanging", (t) => {
  const bridge = makeBridge();
  const renderer = makeFakeWebContents();
  bridge.registerRenderer(renderer);
  const first = bridge.submit(makeAudioFile(t, "first.mp3"));
  const second = bridge.submit(makeAudioFile(t, "second.mp3"));

  renderer._fireDestroyed();
  bridge.reportResult(first.job_id, { status: "completed", text: "hi" });

  const stored = bridge.get(second.job_id);
  assert.equal(stored.status, "failed");
  assert.match(stored.error, /renderer became unavailable/);
});

test("renderer destruction immediately terminalizes the active job, not just queued ones", (t) => {
  const bridge = makeBridge();
  const renderer = makeFakeWebContents();
  bridge.registerRenderer(renderer);
  const job = bridge.submit(makeAudioFile(t));
  assert.equal(job.status, "transcribing");

  renderer._fireDestroyed();

  const stored = bridge.get(job.job_id);
  assert.equal(stored.status, "failed", "the active job must not hang forever waiting on IPC");
  assert.match(stored.error, /renderer became unavailable while this job was running/);

  // A late/lagging report from the now-destroyed renderer must not resurrect
  // an already-terminal job.
  bridge.reportResult(job.job_id, { status: "completed", text: "too late" });
  assert.equal(bridge.get(job.job_id).status, "failed");
});

test("renderer destruction while active drains the queue so --wait can never poll indefinitely", (t) => {
  const bridge = makeBridge();
  const renderer = makeFakeWebContents();
  bridge.registerRenderer(renderer);
  const first = bridge.submit(makeAudioFile(t, "first.mp3"));
  const second = bridge.submit(makeAudioFile(t, "second.mp3"));
  assert.equal(first.status, "transcribing");
  assert.equal(second.status, "queued");

  renderer._fireDestroyed();

  assert.equal(bridge.get(first.job_id).status, "failed");
  assert.equal(bridge.get(second.job_id).status, "failed", "queued jobs must also terminalize");
});

test("render-process-gone (renderer stays undestroyed) invalidates the registration and terminalizes the active job", (t) => {
  // Reproduces a crash: WindowManager keeps the same webContents object
  // alive and reloads it later, so isDestroyed() stays false and
  // "destroyed" never fires — only "render-process-gone" signals the loss.
  const bridge = makeBridge();
  const renderer = makeFakeWebContents();
  bridge.registerRenderer(renderer);
  const job = bridge.submit(makeAudioFile(t));
  assert.equal(job.status, "transcribing");

  renderer._fireRenderProcessGone({ reason: "crashed" });

  const stored = bridge.get(job.job_id);
  assert.equal(stored.status, "failed", "must not hang forever waiting on a crashed renderer");
  assert.match(stored.error, /renderer became unavailable/);
  assert.equal(
    bridge.isRendererAvailable(),
    false,
    "the (still not-destroyed) webContents must no longer be treated as available"
  );

  // A late report or cancel against the stale renderer must not resurrect
  // the job or reach send() again.
  bridge.reportResult(job.job_id, { status: "completed", text: "too late" });
  assert.equal(bridge.get(job.job_id).status, "failed");
  const sentBeforeCancel = renderer.sent.length;
  bridge.cancel(job.job_id);
  assert.equal(
    renderer.sent.length,
    sentBeforeCancel,
    "cancel of an already-terminal job must not attempt to send to the stale renderer"
  );
});

test("render-process-gone drains queued jobs too, matching destroyed's behavior", (t) => {
  const bridge = makeBridge();
  const renderer = makeFakeWebContents();
  bridge.registerRenderer(renderer);
  const first = bridge.submit(makeAudioFile(t, "first.mp3"));
  const second = bridge.submit(makeAudioFile(t, "second.mp3"));
  assert.equal(second.status, "queued");

  renderer._fireRenderProcessGone();

  assert.equal(bridge.get(first.job_id).status, "failed");
  assert.equal(bridge.get(second.job_id).status, "failed", "queued jobs must also terminalize");
});

test("a submission after render-process-gone is rejected until a fresh renderer registers", (t) => {
  const bridge = makeBridge();
  const renderer = makeFakeWebContents();
  bridge.registerRenderer(renderer);
  bridge.submit(makeAudioFile(t, "first.mp3"));

  renderer._fireRenderProcessGone();

  assert.throws(() => bridge.submit(makeAudioFile(t, "second.mp3")), {
    code: "RENDERER_UNAVAILABLE",
  });

  // Only a fresh registration (the reloaded page's host remounting) makes
  // new submissions dispatchable again.
  const freshRenderer = makeFakeWebContents();
  bridge.registerRenderer(freshRenderer);
  const third = bridge.submit(makeAudioFile(t, "third.mp3"));
  assert.equal(third.status, "transcribing");
});

test("a full-page navigation/reload on the same webContents invalidates the registration the same way", (t) => {
  const bridge = makeBridge();
  const renderer = makeFakeWebContents();
  bridge.registerRenderer(renderer);
  const job = bridge.submit(makeAudioFile(t));

  renderer._fireNavigation({ isMainFrame: true, isInPlace: false });

  const stored = bridge.get(job.job_id);
  assert.equal(stored.status, "failed", "a same-webContents reload wipes the JS context/listeners");
  assert.equal(bridge.isRendererAvailable(), false);
});

test("an in-place (same-document) navigation does not invalidate the registration", (t) => {
  const bridge = makeBridge();
  const renderer = makeFakeWebContents();
  bridge.registerRenderer(renderer);
  const job = bridge.submit(makeAudioFile(t));

  // A hash/route change within the same document does not reset the JS
  // context the host is mounted in, so it must not be treated as a loss.
  renderer._fireNavigation({ isMainFrame: true, isInPlace: true });

  assert.equal(bridge.isRendererAvailable(), true);
  assert.equal(bridge.get(job.job_id).status, "transcribing", "must not have been terminalized");
});

test("a sub-frame navigation does not invalidate the registration", (t) => {
  const bridge = makeBridge();
  const renderer = makeFakeWebContents();
  bridge.registerRenderer(renderer);
  const job = bridge.submit(makeAudioFile(t));

  renderer._fireNavigation({ isMainFrame: false, isInPlace: false });

  assert.equal(bridge.isRendererAvailable(), true);
  assert.equal(bridge.get(job.job_id).status, "transcribing");
});

test("re-registering the same webContents after a reload detaches the prior listener set instead of accumulating", () => {
  const bridge = makeBridge();
  const renderer = makeFakeWebContents();
  bridge.registerRenderer(renderer);
  assert.equal(renderer._listenerCount("render-process-gone"), 1);
  assert.equal(renderer._listenerCount("did-start-navigation"), 1);

  // Simulate WindowManager reloading the SAME webContents object after a
  // crash: the host component remounts and registers again.
  bridge.registerRenderer(renderer);

  assert.equal(
    renderer._listenerCount("render-process-gone"),
    1,
    "must not accumulate a second render-process-gone listener on the same object"
  );
  assert.equal(
    renderer._listenerCount("did-start-navigation"),
    1,
    "must not accumulate a second did-start-navigation listener on the same object"
  );
});

test("a webContents.send() throw during dispatch fails that job and the queue keeps moving", (t) => {
  const bridge = makeBridge();
  const renderer = makeFakeWebContents();
  let throwOnNextSend = true;
  const originalSend = renderer.send;
  renderer.send = (...args) => {
    if (throwOnNextSend) {
      throwOnNextSend = false;
      throw new Error("IPC channel closed");
    }
    return originalSend.apply(renderer, args);
  };
  bridge.registerRenderer(renderer);

  const first = bridge.submit(makeAudioFile(t, "first.mp3"));
  const second = bridge.submit(makeAudioFile(t, "second.mp3"));

  const firstStored = bridge.get(first.job_id);
  assert.equal(firstStored.status, "failed");
  assert.match(firstStored.error, /failed to dispatch import job to the renderer/);
  // The queue must still advance to the next job instead of wedging behind
  // the failed dispatch.
  assert.equal(bridge.get(second.job_id).status, "transcribing");
});

test("cancel purges a terminal job's stored path/result instead of leaving it retained", (t) => {
  const bridge = makeBridge();
  bridge.registerRenderer(makeFakeWebContents());
  const job = bridge.submit(makeAudioFile(t));
  bridge.reportResult(job.job_id, { status: "completed", noteId: 1, title: "t", text: "hi" });

  const outcome = bridge.cancel(job.job_id);

  assert.equal(outcome.already_terminal, true);
  assert.equal(outcome.purged, true);
  assert.equal(outcome.job.status, "completed", "the response still reflects the last state");
  assert.equal(bridge.get(job.job_id), null, "the job record itself is gone after the DELETE");
});

test("terminal jobs older than the retention window are pruned on the next pump", (t) => {
  const bridge = makeBridge();
  bridge.registerRenderer(makeFakeWebContents());
  const job = bridge.submit(makeAudioFile(t));
  bridge.reportResult(job.job_id, { status: "completed", text: "hi" });
  assert.ok(bridge.get(job.job_id), "sanity: the job exists right after completion");

  // Simulate time passing well beyond the retention window, then trigger a
  // pump (any subsequent submit does this) without needing real timers.
  bridge._pruneTerminalJobs(Date.now() + 60 * 60 * 1000);

  assert.equal(bridge.get(job.job_id), null);
});

test("a burst of jobs terminalizing within the eviction grace period is never evicted by the count cap alone", (t) => {
  const bridge = makeBridge();
  bridge.registerRenderer(makeFakeWebContents());

  const jobs = [];
  for (let i = 0; i < 22; i++) {
    const job = bridge.submit(makeAudioFile(t, `clip-${i}.mp3`));
    bridge.reportResult(job.job_id, { status: "completed", text: `hi ${i}` });
    jobs.push(job);
  }

  // All 22 went terminal within the same real-time tick, well inside
  // TERMINAL_JOB_EVICTION_GRACE_MS — none may be evicted yet, even though
  // the terminal count is already over MAX_RETAINED_TERMINAL_JOBS. This is
  // what guarantees a --wait client's own just-finished job survives long
  // enough for at least one poll to observe it, regardless of how many
  // other jobs terminalize in the same burst.
  for (const job of jobs) {
    assert.ok(bridge.get(job.job_id), `${job.job_id} must survive an immediate pump`);
  }
});

test("terminal job count is capped once entries clear the eviction grace period, evicting the oldest first", (t) => {
  const bridge = makeBridge();
  bridge.registerRenderer(makeFakeWebContents());

  const jobs = [];
  for (let i = 0; i < 22; i++) {
    const job = bridge.submit(makeAudioFile(t, `clip-${i}.mp3`));
    bridge.reportResult(job.job_id, { status: "completed", text: `hi ${i}` });
    jobs.push(job);
  }

  // Simulate enough time passing to clear the grace period (well short of
  // the 15-minute TTL, so this isolates the count cap from the TTL sweep).
  bridge._pruneTerminalJobs(Date.now() + 6 * 1000);

  assert.equal(bridge.get(jobs[0].job_id), null, "oldest terminal job was evicted");
  assert.equal(bridge.get(jobs[1].job_id), null, "second-oldest terminal job was evicted");
  assert.ok(bridge.get(jobs.at(-1).job_id), "the most recent terminal job is retained");
});

test("active and queued jobs are never pruned by retention, only terminal ones", (t) => {
  const bridge = makeBridge();
  const renderer = makeFakeWebContents();
  bridge.registerRenderer(renderer);
  const active = bridge.submit(makeAudioFile(t, "active.mp3"));
  const queued = bridge.submit(makeAudioFile(t, "queued.mp3"));

  bridge._pruneTerminalJobs(Date.now() + 60 * 60 * 1000);

  assert.ok(bridge.get(active.job_id), "active job survives an aggressive prune sweep");
  assert.ok(bridge.get(queued.job_id), "queued job survives an aggressive prune sweep");
});

test("a webContents.send() throw while delivering cancellation terminalizes the job and drains the queue", (t) => {
  const bridge = makeBridge();
  const renderer = makeFakeWebContents();
  renderer.send = (channel) => {
    if (channel === "cli-audio-import:cancel") throw new Error("IPC channel closed");
    // Job dispatch itself must still work normally.
  };
  bridge.registerRenderer(renderer);
  const first = bridge.submit(makeAudioFile(t, "first.mp3"));
  const second = bridge.submit(makeAudioFile(t, "second.mp3"));
  assert.equal(first.status, "transcribing");
  assert.equal(second.status, "queued");

  const outcome = bridge.cancel(first.job_id);

  assert.equal(outcome.cancelled, false);
  assert.equal(outcome.cancellation_requested, false, "delivery failed, so no request went out");
  const firstStored = bridge.get(first.job_id);
  assert.equal(firstStored.status, "failed", "must not hang forever in 'cancelling'");
  assert.match(firstStored.error, /failed to deliver cancellation request/);
  assert.equal(
    bridge.get(second.job_id).status,
    "transcribing",
    "the queue must keep moving instead of wedging behind the failed cancel delivery"
  );
});

test("a completed report is rejected once the job is already cancelling, and terminalizes as cancelled", (t) => {
  const bridge = makeBridge();
  const renderer = makeFakeWebContents();
  bridge.registerRenderer(renderer);
  const first = bridge.submit(makeAudioFile(t, "first.mp3"));
  const second = bridge.submit(makeAudioFile(t, "second.mp3"));

  const outcome = bridge.cancel(first.job_id);
  assert.equal(outcome.cancellation_requested, true);
  assert.equal(bridge.get(first.job_id).stage, "cancelling");

  // The renderer's transcription had already finished before it observed
  // the cancel signal and reports "completed" anyway — the bridge must not
  // let that surface a note or a completed status for a job it already
  // told the CLI was being cancelled.
  bridge.reportResult(first.job_id, {
    status: "completed",
    noteId: 99,
    title: "should not surface",
    text: "should not surface",
  });

  const stored = bridge.get(first.job_id);
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.result, null, "no note/result data from the rejected completion leaks through");

  // The queue must still advance to the next job.
  assert.equal(bridge.get(second.job_id).status, "transcribing");
});

test("a genuinely cancelled report while cancelling still terminalizes as cancelled (not double-handled)", (t) => {
  const bridge = makeBridge();
  bridge.registerRenderer(makeFakeWebContents());
  const job = bridge.submit(makeAudioFile(t));

  bridge.cancel(job.job_id);
  bridge.reportResult(job.job_id, { status: "cancelled" });

  assert.equal(bridge.get(job.job_id).status, "cancelled");
});

test("beginPersist succeeds for the active, non-cancelling job and moves its stage to persisting", (t) => {
  const bridge = makeBridge();
  bridge.registerRenderer(makeFakeWebContents());
  const job = bridge.submit(makeAudioFile(t));
  assert.equal(bridge.get(job.job_id).stage, "transcribing");

  const outcome = bridge.beginPersist(job.job_id);

  assert.deepEqual(outcome, { ok: true });
  assert.equal(bridge.get(job.job_id).stage, "persisting");
});

test("beginPersist rejects an unknown job id", () => {
  const bridge = makeBridge();
  assert.deepEqual(bridge.beginPersist("no-such-job"), { ok: false, reason: "not_found" });
});

test("beginPersist rejects a job that is not the currently active one", (t) => {
  const bridge = makeBridge();
  bridge.registerRenderer(makeFakeWebContents());
  bridge.submit(makeAudioFile(t, "first.mp3"));
  const second = bridge.submit(makeAudioFile(t, "second.mp3"));
  assert.equal(bridge.get(second.job_id).status, "queued");

  assert.deepEqual(bridge.beginPersist(second.job_id), { ok: false, reason: "not_active" });
});

test("beginPersist rejects a job that has already gone terminal (observed as not_active, since terminalizing always clears activeJobId in the same step)", (t) => {
  const bridge = makeBridge();
  bridge.registerRenderer(makeFakeWebContents());
  const job = bridge.submit(makeAudioFile(t));
  bridge.reportResult(job.job_id, { status: "failed", error: "boom" });

  // Every terminalization path (reportResult, _failActiveJob) clears
  // _activeJobId in the same synchronous call that sets the terminal
  // status, so a terminal job is never still "active" by the time
  // beginPersist runs — the not_active check below is what actually fires
  // first. The dedicated `terminal` reason remains as defensive-in-depth
  // for any future code path that might terminalize a job without also
  // clearing _activeJobId.
  assert.deepEqual(bridge.beginPersist(job.job_id), { ok: false, reason: "not_active" });
});

test("beginPersist loses to a cancel that already latched 'cancelling' on the same job", (t) => {
  const bridge = makeBridge();
  bridge.registerRenderer(makeFakeWebContents());
  const job = bridge.submit(makeAudioFile(t));

  bridge.cancel(job.job_id);
  assert.equal(bridge.get(job.job_id).stage, "cancelling");

  assert.deepEqual(bridge.beginPersist(job.job_id), { ok: false, reason: "cancelling" });
});

test("cancel arriving after beginPersist has committed reports too_late without mutating state", (t) => {
  const bridge = makeBridge();
  const renderer = makeFakeWebContents();
  bridge.registerRenderer(renderer);
  const job = bridge.submit(makeAudioFile(t));

  const commit = bridge.beginPersist(job.job_id);
  assert.deepEqual(commit, { ok: true });
  renderer.sent.length = 0; // clear the initial job-dispatch send record

  const cancelOutcome = bridge.cancel(job.job_id);

  assert.equal(cancelOutcome.cancelled, false);
  assert.equal(cancelOutcome.too_late, true);
  assert.equal(
    renderer.sent.length,
    0,
    "a too-late cancel must not even attempt to notify the renderer"
  );
  const stored = bridge.get(job.job_id);
  assert.equal(stored.stage, "persisting", "state must stay persisting, never flip to cancelling");
  assert.equal(stored.status, "transcribing", "status is still non-terminal, awaiting the real report");
});

test("a completed report after beginPersist committed completes normally, not cancelled", (t) => {
  const bridge = makeBridge();
  bridge.registerRenderer(makeFakeWebContents());
  const job = bridge.submit(makeAudioFile(t));

  bridge.beginPersist(job.job_id);
  // A cancel that raced in and lost is expected to still be attempted by a
  // caller (see cancel() returning too_late above) but must never flip the
  // stage; simulate the renderer's real save completing right after.
  bridge.reportResult(job.job_id, {
    status: "completed",
    noteId: 42,
    title: "Real saved note",
    text: "hello world",
  });

  const stored = bridge.get(job.job_id);
  assert.equal(stored.status, "completed");
  assert.equal(stored.result.note_id, 42);
});

// Authoritative fallback used by the renderer host when reportResult()
// itself couldn't be delivered (see useCliAudioImportHost.ts).
function dispatchedRequestId(renderer, jobId) {
  const dispatch = renderer.sent.find(
    (entry) => entry.channel === "cli-audio-import:job" && entry.payload.jobId === jobId
  );
  return dispatch.payload.requestId;
}

test("failJob marks the matching active job failed, clears active state, and advances the queue", (t) => {
  const bridge = makeBridge();
  const renderer = makeFakeWebContents();
  bridge.registerRenderer(renderer);
  const active = bridge.submit(makeAudioFile(t, "first.mp3"));
  const queued = bridge.submit(makeAudioFile(t, "second.mp3"));
  assert.equal(bridge.get(queued.job_id).status, "queued");
  const requestId = dispatchedRequestId(renderer, active.job_id);

  const outcome = bridge.failJob(active.job_id, requestId, "report IPC unreachable");

  assert.deepEqual(outcome, { ok: true });
  const stored = bridge.get(active.job_id);
  assert.equal(stored.status, "failed");
  assert.equal(stored.stage, "failed");
  assert.equal(stored.error, "report IPC unreachable");
  // The queue must advance: the second job is dispatched once the first is
  // terminalized, exactly like any other terminalization path.
  assert.equal(bridge.get(queued.job_id).status, "transcribing");
});

test("failJob defaults to a diagnostic message when no reason is given", (t) => {
  const bridge = makeBridge();
  const renderer = makeFakeWebContents();
  bridge.registerRenderer(renderer);
  const job = bridge.submit(makeAudioFile(t));
  const requestId = dispatchedRequestId(renderer, job.job_id);

  bridge.failJob(job.job_id, requestId);

  assert.equal(
    bridge.get(job.job_id).error,
    "the renderer could not report this import's result"
  );
});

test("failJob rejects an unknown job id", () => {
  const bridge = makeBridge();
  assert.deepEqual(bridge.failJob("no-such-job", "whatever"), {
    ok: false,
    reason: "not_found",
  });
});

test("failJob rejects a mismatched requestId, leaving the job untouched", (t) => {
  const bridge = makeBridge();
  bridge.registerRenderer(makeFakeWebContents());
  const job = bridge.submit(makeAudioFile(t));

  const outcome = bridge.failJob(job.job_id, "not-the-real-request-id", "boom");

  assert.deepEqual(outcome, { ok: false, reason: "identity_mismatch" });
  assert.equal(bridge.get(job.job_id).status, "transcribing");
});

test("failJob rejects a job that has already gone terminal", (t) => {
  const bridge = makeBridge();
  const renderer = makeFakeWebContents();
  bridge.registerRenderer(renderer);
  const job = bridge.submit(makeAudioFile(t));
  const requestId = dispatchedRequestId(renderer, job.job_id);
  bridge.reportResult(job.job_id, { status: "completed", noteId: 1, title: "t", text: "x" });

  const outcome = bridge.failJob(job.job_id, requestId, "too late");

  assert.deepEqual(outcome, { ok: false, reason: "already_terminal" });
  assert.equal(bridge.get(job.job_id).status, "completed");
});
