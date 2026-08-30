const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// runCliAudioImport itself is covered by test/services/cliAudioImport.test.js;
// this suite isolates the host's own wiring (register/dispatch/report/cancel/
// unregister) by faking that one collaborator through globalThis, the same
// pattern the mock-module string uses to reach back into the test.
const mockModules = {
  "/services/cliAudioImport": `
    export function runCliAudioImport(filePath, requestId, shouldAbort, beginPersist) {
      return globalThis.__cliAudioImportMock(filePath, requestId, shouldAbort, beginPersist);
    }
  `,
};

test("registers on mount, runs a dispatched job, and reports the outcome", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  let jobHandler = null;
  let readyCalls = 0;
  let unreadyCalls = 0;
  let reported = null;

  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        cliAudioImportHostReady: () => {
          readyCalls += 1;
        },
        cliAudioImportHostUnready: () => {
          unreadyCalls += 1;
        },
        onCliAudioImportJob: (cb) => {
          jobHandler = cb;
          return () => {
            jobHandler = null;
          };
        },
        onCliAudioImportCancel: () => () => {},
        beginCliAudioImportPersist: async () => ({ ok: true }),
        reportCliAudioImportResult: async (jobId, outcome) => {
          reported = { jobId, outcome };
        },
        failCliAudioImportJob: async () => ({ ok: true }),
      },
    },
  });
  const container = installHookDom(t);

  globalThis.__cliAudioImportMock = async (filePath, requestId) => {
    assert.equal(filePath, "/abs/audio.mp3");
    assert.equal(requestId, "req-1");
    return { status: "completed", noteId: 5, title: "t", text: "hi" };
  };
  t.after(() => {
    delete globalThis.__cliAudioImportMock;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cli-audio-import-host-job-test-",
    mockModules,
  });
  const { useCliAudioImportHost } = await vite.ssrLoadModule("/hooks/useCliAudioImportHost.ts");

  function Harness() {
    useCliAudioImportHost();
    return null;
  }

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });

  assert.equal(readyCalls, 1);
  assert.ok(jobHandler, "job handler registered on mount");

  await React.act(async () => {
    jobHandler({ jobId: "job-1", path: "/abs/audio.mp3", requestId: "req-1" });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.deepEqual(reported, {
    jobId: "job-1",
    outcome: { status: "completed", noteId: 5, title: "t", text: "hi" },
  });

  await React.act(async () => root.unmount());
  root = null;
  assert.equal(unreadyCalls, 1);
});

test("forwards a cancel for the active job's requestId, ignores a stale one", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  let jobHandler = null;
  let cancelHandler = null;
  let cancelledRequestId = null;
  let resolveJob;
  const jobPromise = new Promise((resolve) => {
    resolveJob = resolve;
  });

  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        cliAudioImportHostReady: () => {},
        cliAudioImportHostUnready: () => {},
        onCliAudioImportJob: (cb) => {
          jobHandler = cb;
          return () => {
            jobHandler = null;
          };
        },
        onCliAudioImportCancel: (cb) => {
          cancelHandler = cb;
          return () => {
            cancelHandler = null;
          };
        },
        beginCliAudioImportPersist: async () => ({ ok: true }),
        reportCliAudioImportResult: async () => {},
        failCliAudioImportJob: async () => ({ ok: true }),
        cancelUploadTranscription: async (requestId) => {
          cancelledRequestId = requestId;
        },
      },
    },
  });
  const container = installHookDom(t);

  globalThis.__cliAudioImportMock = () => jobPromise;
  t.after(() => {
    delete globalThis.__cliAudioImportMock;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cli-audio-import-host-cancel-test-",
    mockModules,
  });
  const { useCliAudioImportHost } = await vite.ssrLoadModule("/hooks/useCliAudioImportHost.ts");

  function Harness() {
    useCliAudioImportHost();
    return null;
  }

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });

  assert.ok(jobHandler, "job handler registered on mount");
  assert.ok(cancelHandler, "cancel handler registered on mount");

  // Dispatch the job directly (rather than via a scheduled callback): the
  // handler is captured synchronously above, so invoking it inside act
  // deterministically drives the hook's activeRequestIdRef assignment before
  // the assertions below, avoiding any dependency on timer/effect ordering.
  await React.act(async () => {
    jobHandler({ jobId: "job-2", path: "/abs/audio.mp3", requestId: "req-active" });
  });

  cancelHandler({ jobId: "job-2", requestId: "req-stale" });
  assert.equal(cancelledRequestId, null, "a cancel for a non-active requestId is ignored");

  cancelHandler({ jobId: "job-2", requestId: "req-active" });
  assert.equal(cancelledRequestId, "req-active");

  resolveJob({ status: "cancelled" });
  await React.act(async () => {
    await jobPromise;
    await Promise.resolve();
  });
});

test("shouldAbort passed to runCliAudioImport latches true once a cancel for the active job arrives", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  let jobHandler = null;
  let cancelHandler = null;
  let capturedShouldAbort = null;
  let resolveJob;
  const jobPromise = new Promise((resolve) => {
    resolveJob = resolve;
  });

  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        cliAudioImportHostReady: () => {},
        cliAudioImportHostUnready: () => {},
        onCliAudioImportJob: (cb) => {
          jobHandler = cb;
          return () => {
            jobHandler = null;
          };
        },
        onCliAudioImportCancel: (cb) => {
          cancelHandler = cb;
          return () => {
            cancelHandler = null;
          };
        },
        beginCliAudioImportPersist: async () => ({ ok: true }),
        reportCliAudioImportResult: async () => {},
        failCliAudioImportJob: async () => ({ ok: true }),
        cancelUploadTranscription: async () => {},
      },
    },
  });
  const container = installHookDom(t);

  globalThis.__cliAudioImportMock = (filePath, requestId, shouldAbort) => {
    capturedShouldAbort = shouldAbort;
    return jobPromise;
  };
  t.after(() => {
    delete globalThis.__cliAudioImportMock;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cli-audio-import-host-shouldabort-test-",
    mockModules,
  });
  const { useCliAudioImportHost } = await vite.ssrLoadModule("/hooks/useCliAudioImportHost.ts");

  function Harness() {
    useCliAudioImportHost();
    return null;
  }

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });

  await React.act(async () => {
    jobHandler({ jobId: "job-3", path: "/abs/audio.mp3", requestId: "req-shouldabort" });
  });

  assert.ok(capturedShouldAbort, "runCliAudioImport was given a shouldAbort callback");
  assert.equal(capturedShouldAbort(), false, "not aborted before any cancel arrives");

  cancelHandler({ jobId: "job-3", requestId: "req-shouldabort" });

  // The latch must reflect the cancel immediately — this is what lets
  // runCliAudioImport refuse to persist a note even if the underlying
  // transcription had already resolved by the time the cancel IPC message
  // was actually delivered.
  assert.equal(capturedShouldAbort(), true, "latched true once the matching cancel arrives");

  resolveJob({ status: "cancelled" });
  await React.act(async () => {
    await jobPromise;
    await Promise.resolve();
  });
});

test("beginPersist passed to runCliAudioImport wraps window.electronAPI.beginCliAudioImportPersist", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  let jobHandler = null;
  let capturedBeginPersist = null;
  let beginPersistCalledWith = null;
  let resolveJob;
  const jobPromise = new Promise((resolve) => {
    resolveJob = resolve;
  });

  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        cliAudioImportHostReady: () => {},
        cliAudioImportHostUnready: () => {},
        onCliAudioImportJob: (cb) => {
          jobHandler = cb;
          return () => {
            jobHandler = null;
          };
        },
        onCliAudioImportCancel: () => () => {},
        reportCliAudioImportResult: async () => {},
        beginCliAudioImportPersist: async (jobId) => {
          beginPersistCalledWith = jobId;
          return { ok: true };
        },
        failCliAudioImportJob: async () => ({ ok: true }),
      },
    },
  });
  const container = installHookDom(t);

  globalThis.__cliAudioImportMock = (filePath, requestId, shouldAbort, beginPersist) => {
    capturedBeginPersist = beginPersist;
    return jobPromise;
  };
  t.after(() => {
    delete globalThis.__cliAudioImportMock;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cli-audio-import-host-beginpersist-passthrough-",
    mockModules,
  });
  const { useCliAudioImportHost } = await vite.ssrLoadModule("/hooks/useCliAudioImportHost.ts");

  function Harness() {
    useCliAudioImportHost();
    return null;
  }

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });

  await React.act(async () => {
    jobHandler({ jobId: "job-4", path: "/abs/audio.mp3", requestId: "req-4" });
  });

  assert.ok(capturedBeginPersist, "runCliAudioImport was given a beginPersist callback");
  const result = await capturedBeginPersist();
  assert.deepEqual(result, { ok: true });
  assert.equal(beginPersistCalledWith, "job-4", "the job's own id is forwarded to the IPC call");

  resolveJob({ status: "completed", noteId: 1 });
  await React.act(async () => {
    await jobPromise;
    await Promise.resolve();
  });
});

test("does not register (no ready call, no job/cancel subscription) when beginCliAudioImportPersist is entirely absent", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  let jobHandler = null;
  let cancelHandler = null;
  let readyCalls = 0;

  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        cliAudioImportHostReady: () => {
          readyCalls += 1;
        },
        cliAudioImportHostUnready: () => {},
        onCliAudioImportJob: (cb) => {
          jobHandler = cb;
          return () => {
            jobHandler = null;
          };
        },
        onCliAudioImportCancel: (cb) => {
          cancelHandler = cb;
          return () => {};
        },
        reportCliAudioImportResult: async () => {},
        failCliAudioImportJob: async () => ({ ok: true }),
        // beginCliAudioImportPersist deliberately omitted, simulating a
        // partially rolled out preload/main (updated renderer, stale
        // preload). A partial preload must stay unregistered entirely —
        // not merely fail closed on that one method — so bridge
        // submissions fail renderer_unavailable up front instead of this
        // host silently accepting work it can only partially carry out.
      },
    },
  });
  const container = installHookDom(t);

  globalThis.__cliAudioImportMock = () => {
    throw new Error("must never be called: host should not have registered");
  };
  t.after(() => {
    delete globalThis.__cliAudioImportMock;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cli-audio-import-host-partial-preload-",
    mockModules,
  });
  const { useCliAudioImportHost } = await vite.ssrLoadModule("/hooks/useCliAudioImportHost.ts");

  function Harness() {
    useCliAudioImportHost();
    return null;
  }

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });

  assert.equal(readyCalls, 0, "must not call the ready handshake with a partial preload");
  assert.equal(jobHandler, null, "must not subscribe to jobs with a partial preload");
  assert.equal(cancelHandler, null, "must not subscribe to cancels with a partial preload");
});

test("does not register when each individual required API method is missing, one at a time", async (t) => {
  const fullApi = () => ({
    cliAudioImportHostReady: () => {},
    cliAudioImportHostUnready: () => {},
    onCliAudioImportJob: () => () => {},
    onCliAudioImportCancel: () => () => {},
    beginCliAudioImportPersist: async () => ({ ok: true }),
    reportCliAudioImportResult: async () => {},
    failCliAudioImportJob: async () => ({ ok: true }),
  });
  const requiredMethods = Object.keys(fullApi());

  for (const missing of requiredMethods) {
    await t.test(`missing ${missing}`, async (t) => {
      let root = null;
      t.after(async () => {
        if (root) await React.act(async () => root.unmount());
      });

      let readyCalls = 0;
      let jobSubscribed = false;
      let cancelSubscribed = false;
      const api = fullApi();
      api.cliAudioImportHostReady = () => {
        readyCalls += 1;
      };
      api.onCliAudioImportJob = () => {
        jobSubscribed = true;
        return () => {};
      };
      api.onCliAudioImportCancel = () => {
        cancelSubscribed = true;
        return () => {};
      };
      delete api[missing];

      installBrowserGlobals(t, { window: { electronAPI: api } });
      const container = installHookDom(t);

      globalThis.__cliAudioImportMock = () => {
        throw new Error("must never be called: host should not have registered");
      };
      t.after(() => {
        delete globalThis.__cliAudioImportMock;
      });

      const vite = await createRendererServer(t, {
        cachePrefix: `openwhispr-cli-audio-import-host-missing-${missing}-`,
        mockModules,
      });
      const { useCliAudioImportHost } = await vite.ssrLoadModule("/hooks/useCliAudioImportHost.ts");

      function Harness() {
        useCliAudioImportHost();
        return null;
      }

      root = createRoot(container);
      await React.act(async () => {
        root.render(React.createElement(Harness));
      });

      assert.equal(readyCalls, 0, `must not register when ${missing} is missing`);
      assert.equal(jobSubscribed, false, `must not subscribe to jobs when ${missing} is missing`);
      assert.equal(
        cancelSubscribed,
        false,
        `must not subscribe to cancels when ${missing} is missing`
      );
    });
  }
});

test("beginPersist fails closed (ok:false) when the gate API resolves a malformed response", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  let jobHandler = null;
  let capturedBeginPersist = null;
  let resolveJob;
  const jobPromise = new Promise((resolve) => {
    resolveJob = resolve;
  });

  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        cliAudioImportHostReady: () => {},
        cliAudioImportHostUnready: () => {},
        onCliAudioImportJob: (cb) => {
          jobHandler = cb;
          return () => {
            jobHandler = null;
          };
        },
        onCliAudioImportCancel: () => () => {},
        reportCliAudioImportResult: async () => {},
        // A malformed/unexpected response (missing `ok`, or truthy but not
        // strictly boolean true) must not be interpreted as permission.
        beginCliAudioImportPersist: async () => ({ status: "fine" }),
        failCliAudioImportJob: async () => ({ ok: true }),
      },
    },
  });
  const container = installHookDom(t);

  globalThis.__cliAudioImportMock = (filePath, requestId, shouldAbort, beginPersist) => {
    capturedBeginPersist = beginPersist;
    return jobPromise;
  };
  t.after(() => {
    delete globalThis.__cliAudioImportMock;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cli-audio-import-host-beginpersist-malformed-",
    mockModules,
  });
  const { useCliAudioImportHost } = await vite.ssrLoadModule("/hooks/useCliAudioImportHost.ts");

  function Harness() {
    useCliAudioImportHost();
    return null;
  }

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });

  await React.act(async () => {
    jobHandler({ jobId: "job-5b", path: "/abs/audio.mp3", requestId: "req-5b" });
  });

  const result = await capturedBeginPersist();
  assert.equal(result.ok, false, "a malformed gate response must fail closed");
  assert.equal(result.reason, "begin_persist_rejected");

  resolveJob({ status: "completed", noteId: 1 });
  await React.act(async () => {
    await jobPromise;
    await Promise.resolve();
  });
});

test("beginPersist fails closed (ok:false) when the IPC call throws", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  let jobHandler = null;
  let capturedBeginPersist = null;
  let resolveJob;
  const jobPromise = new Promise((resolve) => {
    resolveJob = resolve;
  });

  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        cliAudioImportHostReady: () => {},
        cliAudioImportHostUnready: () => {},
        onCliAudioImportJob: (cb) => {
          jobHandler = cb;
          return () => {
            jobHandler = null;
          };
        },
        onCliAudioImportCancel: () => () => {},
        reportCliAudioImportResult: async () => {},
        beginCliAudioImportPersist: async () => {
          throw new Error("IPC channel closed");
        },
        failCliAudioImportJob: async () => ({ ok: true }),
      },
    },
  });
  const container = installHookDom(t);

  globalThis.__cliAudioImportMock = (filePath, requestId, shouldAbort, beginPersist) => {
    capturedBeginPersist = beginPersist;
    return jobPromise;
  };
  t.after(() => {
    delete globalThis.__cliAudioImportMock;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cli-audio-import-host-beginpersist-throws-",
    mockModules,
  });
  const { useCliAudioImportHost } = await vite.ssrLoadModule("/hooks/useCliAudioImportHost.ts");

  function Harness() {
    useCliAudioImportHost();
    return null;
  }

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });

  await React.act(async () => {
    jobHandler({ jobId: "job-6", path: "/abs/audio.mp3", requestId: "req-6" });
  });

  const result = await capturedBeginPersist();
  assert.equal(result.ok, false, "a thrown IPC call must fail closed, not silently permit a save");
  assert.equal(result.reason, "IPC channel closed");

  resolveJob({ status: "completed", noteId: 1 });
  await React.act(async () => {
    await jobPromise;
    await Promise.resolve();
  });
});

test("falls back to failCliAudioImportJob with the job's own identity when reportCliAudioImportResult itself fails", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  let jobHandler = null;
  let failJobCalledWith = null;

  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        cliAudioImportHostReady: () => {},
        cliAudioImportHostUnready: () => {},
        onCliAudioImportJob: (cb) => {
          jobHandler = cb;
          return () => {
            jobHandler = null;
          };
        },
        onCliAudioImportCancel: () => () => {},
        beginCliAudioImportPersist: async () => ({ ok: true }),
        reportCliAudioImportResult: async () => {
          throw new Error("report IPC channel closed");
        },
        failCliAudioImportJob: async (jobId, requestId, reason) => {
          failJobCalledWith = { jobId, requestId, reason };
          return { ok: true };
        },
      },
    },
  });
  const container = installHookDom(t);

  globalThis.__cliAudioImportMock = async () => ({ status: "completed", noteId: 9 });
  t.after(() => {
    delete globalThis.__cliAudioImportMock;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cli-audio-import-host-report-fallback-",
    mockModules,
  });
  const { useCliAudioImportHost } = await vite.ssrLoadModule("/hooks/useCliAudioImportHost.ts");

  function Harness() {
    useCliAudioImportHost();
    return null;
  }

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });

  await React.act(async () => {
    jobHandler({ jobId: "job-7", path: "/abs/audio.mp3", requestId: "req-7" });
    // Let runCliAudioImport's mocked promise and the subsequent
    // report/fail-job chain settle.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.deepEqual(
    failJobCalledWith,
    { jobId: "job-7", requestId: "req-7", reason: failJobCalledWith?.reason },
    "failCliAudioImportJob must be scoped to this exact job's own id and requestId"
  );
  assert.match(
    failJobCalledWith.reason,
    /report IPC channel closed/,
    "the fallback reason should carry the original report failure for diagnostics"
  );
});

test("a failCliAudioImportJob fallback that itself throws is swallowed, not left unhandled", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });

  let jobHandler = null;
  let failJobCalls = 0;

  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        cliAudioImportHostReady: () => {},
        cliAudioImportHostUnready: () => {},
        onCliAudioImportJob: (cb) => {
          jobHandler = cb;
          return () => {
            jobHandler = null;
          };
        },
        onCliAudioImportCancel: () => () => {},
        beginCliAudioImportPersist: async () => ({ ok: true }),
        reportCliAudioImportResult: async () => {
          throw new Error("report IPC channel closed");
        },
        failCliAudioImportJob: async () => {
          failJobCalls += 1;
          throw new Error("channel is completely gone");
        },
      },
    },
  });
  const container = installHookDom(t);

  globalThis.__cliAudioImportMock = async () => ({ status: "completed", noteId: 9 });
  t.after(() => {
    delete globalThis.__cliAudioImportMock;
  });

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-cli-audio-import-host-report-fallback-throws-",
    mockModules,
  });
  const { useCliAudioImportHost } = await vite.ssrLoadModule("/hooks/useCliAudioImportHost.ts");

  function Harness() {
    useCliAudioImportHost();
    return null;
  }

  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(Harness));
  });

  await React.act(async () => {
    jobHandler({ jobId: "job-8", path: "/abs/audio.mp3", requestId: "req-8" });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  assert.equal(failJobCalls, 1, "the fallback must still be attempted even though it too fails");
  // No unhandled rejection should propagate out of the effect chain — the
  // test harness's own unmount/teardown succeeding (via t.after above) is
  // the practical proof; node:test would otherwise report an unhandled
  // rejection for this test.
});
