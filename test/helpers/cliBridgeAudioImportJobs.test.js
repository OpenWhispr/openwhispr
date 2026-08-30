const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isReady: () => false },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const CliBridge = require("../../src/helpers/cliBridge.js");

function call(bridge, method, pathname, body) {
  for (const route of bridge.routes) {
    if (route.method !== method) continue;
    const params = route.match(pathname);
    if (!params) continue;
    const promise = (async () => route.handler({ params, query: new URLSearchParams(), body }))();
    return { promise, route };
  }
  throw new Error(`No route for ${method} ${pathname}`);
}

// A minimal fake standing in for CliAudioImportBridge: these tests only need
// to prove cliBridge.js wires HTTP verbs/params/status codes onto the real
// job-manager surface (submit/get/cancel) and maps its error codes to the
// right HTTP status — CliAudioImportBridge's own behavior is covered by
// test/helpers/cliAudioImportBridge.test.js.
function makeFakeAudioImportBridge({ submitImpl, getImpl, cancelImpl } = {}) {
  return {
    submit: submitImpl || (() => ({ job_id: "job-1", status: "queued" })),
    get: getImpl || (() => null),
    cancel: cancelImpl || (() => null),
  };
}

test("POST /v1/audio-import-jobs returns 202 with the submitted job", async () => {
  const bridge = new CliBridge({
    cliAudioImportBridge: makeFakeAudioImportBridge({
      submitImpl: (p) => {
        assert.equal(p, "/abs/audio.mp3");
        return { job_id: "job-1", status: "queued", stage: "queued", progress: 0 };
      },
    }),
  });
  const { promise, route } = call(bridge, "POST", "/v1/audio-import-jobs", {
    path: "/abs/audio.mp3",
  });
  assert.equal(route.status, 202);
  const result = await promise;
  assert.deepEqual(result.data, { job_id: "job-1", status: "queued", stage: "queued", progress: 0 });
});

test("POST /v1/audio-import-jobs surfaces a validation rejection as 400", async () => {
  const bridge = new CliBridge({
    cliAudioImportBridge: makeFakeAudioImportBridge({
      submitImpl: () => {
        throw Object.assign(new Error("path must be an absolute local file path"), {
          code: "VALIDATION",
        });
      },
    }),
  });
  const { promise } = call(bridge, "POST", "/v1/audio-import-jobs", { path: "relative.mp3" });
  await assert.rejects(promise, { code: "VALIDATION" });
});

test("POST /v1/audio-import-jobs surfaces a missing renderer as RENDERER_UNAVAILABLE", async () => {
  const bridge = new CliBridge({
    cliAudioImportBridge: makeFakeAudioImportBridge({
      submitImpl: () => {
        throw Object.assign(new Error("no renderer"), { code: "RENDERER_UNAVAILABLE" });
      },
    }),
  });
  const { promise } = call(bridge, "POST", "/v1/audio-import-jobs", { path: "/abs/audio.mp3" });
  await assert.rejects(promise, { code: "RENDERER_UNAVAILABLE" });
});

test("GET /v1/audio-import-jobs/:id returns the job state", async () => {
  const bridge = new CliBridge({
    cliAudioImportBridge: makeFakeAudioImportBridge({
      getImpl: (id) => {
        assert.equal(id, "job-1");
        return { job_id: "job-1", status: "completed", result: { note_id: 5 } };
      },
    }),
  });
  const { promise } = call(bridge, "GET", "/v1/audio-import-jobs/job-1");
  const result = await promise;
  assert.equal(result.data.status, "completed");
  assert.equal(result.data.result.note_id, 5);
});

test("GET /v1/audio-import-jobs/:id 404s for an unknown job", async () => {
  const bridge = new CliBridge({ cliAudioImportBridge: makeFakeAudioImportBridge() });
  const { promise } = call(bridge, "GET", "/v1/audio-import-jobs/unknown");
  await assert.rejects(promise, { code: "NOT_FOUND" });
});

test("DELETE /v1/audio-import-jobs/:id requests cancellation via the job manager", async () => {
  let cancelledId = null;
  const bridge = new CliBridge({
    cliAudioImportBridge: makeFakeAudioImportBridge({
      cancelImpl: (id) => {
        cancelledId = id;
        return { job: { job_id: id, status: "transcribing" }, cancellation_requested: true };
      },
    }),
  });
  const { promise } = call(bridge, "DELETE", "/v1/audio-import-jobs/job-1");
  const result = await promise;
  assert.equal(cancelledId, "job-1");
  assert.equal(result.data.cancellation_requested, true);
});

test("DELETE /v1/audio-import-jobs/:id 404s for an unknown job", async () => {
  const bridge = new CliBridge({ cliAudioImportBridge: makeFakeAudioImportBridge() });
  const { promise } = call(bridge, "DELETE", "/v1/audio-import-jobs/unknown");
  await assert.rejects(promise, { code: "NOT_FOUND" });
});

test("audio-import routes fail closed (503) when the job manager was never wired", async () => {
  const bridge = new CliBridge({});
  const { promise } = call(bridge, "POST", "/v1/audio-import-jobs", { path: "/abs/audio.mp3" });
  await assert.rejects(promise, { code: "RENDERER_UNAVAILABLE" });
});
