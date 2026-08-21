const test = require("node:test");
const assert = require("node:assert/strict");

test("a duplicate request attached to an active download receives its late error once", async () => {
  const requests = await import("../../src/hooks/modelDownloadRequest.ts");
  const errors = [];
  const terminalEvents = [];
  const requestErrorHandled = [];
  const request = requests.createModelDownloadRequest("base", {
    onError: (error) => errors.push(error),
  });
  request.awaitingTerminalEvent = true;
  const terminal = {
    type: "error",
    modelId: "base",
    error: "network failed",
  };

  assert.equal(
    requests.routeModelDownloadTerminalEvent(request, terminal, {
      formatError: (event) => `formatted:${event.error}`,
      applyTerminal: (event, result) => {
        terminalEvents.push(event);
        requestErrorHandled.push(result.requestErrorHandled);
      },
    }),
    "settled"
  );
  assert.equal(
    requests.routeModelDownloadTerminalEvent(request, terminal, {
      formatError: (event) => `formatted:${event.error}`,
      applyTerminal: (event) => terminalEvents.push(event),
    }),
    "ignored"
  );
  assert.deepEqual(errors, ["formatted:network failed"]);
  assert.deepEqual(terminalEvents, [terminal]);
  assert.deepEqual(requestErrorHandled, [true]);
});

test("a terminal event is deferred while the initiating request still owns its promise", async () => {
  const requests = await import("../../src/hooks/modelDownloadRequest.ts");
  let applied = 0;
  const request = requests.createModelDownloadRequest("qwen-local", {});
  const terminal = { type: "complete", modelId: "qwen-local" };

  assert.equal(
    requests.routeModelDownloadTerminalEvent(request, terminal, {
      formatError: () => "",
      applyTerminal: () => {
        applied += 1;
      },
    }),
    "deferred"
  );
  assert.equal(request.terminalEvent, terminal);
  assert.equal(applied, 0);
});

test("a different active model reports busy until its terminal event, then B starts once", async () => {
  const requests = await import("../../src/hooks/modelDownloadRequest.ts");
  const activeA = requests.createModelDownloadRequest("model-a", {});
  const callbacksB = { onSelect: () => {} };

  assert.deepEqual(
    requests.attachModelDownloadRequestToActive(activeA, "model-a", "model-b", callbacksB),
    { outcome: "busy-other", request: activeA }
  );
  assert.deepEqual(
    requests.attachModelDownloadRequestToActive(null, null, "model-b", callbacksB),
    { outcome: "available", request: null }
  );

  const started = new Set();
  assert.equal(started.has("model-b"), false);
  started.add("model-b");
  assert.equal(started.has("model-b"), true);
  assert.equal(started.size, 1);
});

test("joining the same active model transfers terminal ownership to the latest selection", async () => {
  const requests = await import("../../src/hooks/modelDownloadRequest.ts");
  let selectedA = 0;
  let selectedB = 0;
  const active = requests.createModelDownloadRequest("shared", {
    onSelect: () => {
      selectedA += 1;
    },
  });
  const attached = requests.attachModelDownloadRequestToActive(
    active,
    "shared",
    "shared",
    {
      onSelect: () => {
        selectedB += 1;
      },
    }
  );

  assert.equal(attached.outcome, "joined-same");
  assert.equal(attached.request.awaitingTerminalEvent, true);
  requests.routeModelDownloadTerminalEvent(
    attached.request,
    { type: "complete", modelId: "shared" },
    { formatError: () => "", applyTerminal: () => {} }
  );
  assert.equal(selectedA, 0);
  assert.equal(selectedB, 1);
});

test("an origin success cannot select again after a joined terminal event settled the request", async () => {
  const requests = await import("../../src/hooks/modelDownloadRequest.ts");
  let selected = 0;
  const request = requests.createModelDownloadRequest("shared", {
    onSelect: () => {
      selected += 1;
    },
  });
  request.awaitingTerminalEvent = true;
  requests.routeModelDownloadTerminalEvent(
    request,
    { type: "complete", modelId: "shared" },
    { formatError: () => "", applyTerminal: () => {} }
  );

  assert.equal(requests.settleModelDownloadOriginSuccess(request), false);
  assert.equal(selected, 1);
});

test("a cross-window cancellation identifies the exact active model to release", async () => {
  const cancellation = await import("../../src/hooks/modelDownloadCancellation.ts");
  const event = {
    type: "storage",
    key: cancellation.MODEL_DOWNLOAD_CANCELLATION_KEY,
    newValue: JSON.stringify({ modelType: "whisper", modelId: "base", nonce: 1 }),
  };

  assert.deepEqual(cancellation.readModelDownloadCancellationEvent(event), {
    modelType: "whisper",
    modelId: "base",
    nonce: 1,
  });
  assert.equal(
    cancellation.readModelDownloadCancellationEvent({ ...event, key: "unrelated" }),
    null
  );
});
