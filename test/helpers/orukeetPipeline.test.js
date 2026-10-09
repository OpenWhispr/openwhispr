const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { OrukeetStreaming } = require("../../src/helpers/orukeetStreaming");
const { connectManagedOrukeet, validateSession } = require("../../src/helpers/orukeetCloudSession");
const { withPolicyRequestHeaders } = require("../../src/helpers/policyRequestHeaders");
const session = {
  baseUrl: "https://orukeet.gizmovoice.ai/preview/gemma12",
  websocketUrl: "wss://orukeet.gizmovoice.ai/preview/gemma12/v1/pipeline/stream",
  protocol: "orukeet.pipeline.v2",
  clientToken: "single.use.token",
  model: "orukeet-v0.1.0",
  cleanup: true,
  cleanupModel: "gemma-4-12b",
  requireAccountLimits: true,
  expiresIn: 60,
  singleUse: true,
};
const ready = {
  type: "ready",
  sample_rate: 16000,
  channels: 1,
  encoding: "pcm_s16le",
  max_seconds: 600,
  pipeline_protocol: 2,
  cleanup: true,
  account_limits: true,
};
const final = {
  type: "final",
  text: "Send invoice 128 to Orukeet.",
  raw_text: "um send invoice one twenty eight to aurakeet",
  cleanup_status: "complete",
  cleanup_receipt: "signed.proof",
};
function fixture(t, response = final) {
  let socket;
  const streaming = new OrukeetStreaming({
    timeoutMs: 100,
    createSocket(url, opts, protocols) {
      assert.equal(url, session.websocketUrl);
      assert.deepEqual(protocols, [session.protocol, "auth.single.use.token"]);
      assert.deepEqual(opts.headers, {});
      socket = new EventEmitter();
      socket.readyState = 1;
      socket.bufferedAmount = 0;
      socket.close = () => {};
      socket.terminate = () => {};
      socket.send = (data, cb) => {
        cb?.();
        if (typeof data === "string" && JSON.parse(data).type === "commit")
          queueMicrotask(() => socket.emit("message", JSON.stringify(response)));
      };
      queueMicrotask(() => socket.emit("message", JSON.stringify(ready)));
      return socket;
    },
  });
  t.after(() => streaming.disconnect());
  return streaming;
}
test(
  "combined stream keeps raw text and cleanup separate and meters exactly once on duplicate final",
  { timeout: 2500 },
  async (t) => {
    const streaming = fixture(t);
    const options = { customDictionary: ["Orukeet"] };
    let mints = 0,
      receipts = 0,
      finals = 0;
    const tokenStore = {
      getState: () => ({ token: "account", generation: 1 }),
      subscribe: () => () => {},
    };
    streaming.onFinalTranscript = (raw) => {
      finals++;
      assert.equal(raw, final.raw_text);
    };
    await connectManagedOrukeet({
      streaming,
      tokenStore,
      pipelineOptions: options,
      getApiUrl: () => "https://api.test",
      withPolicyHeaders: (h) => withPolicyRequestHeaders(h, "1.10.2"),
      proxyFetch: async (url, req) => {
        assert.equal(req.headers.Authorization, "Bearer account");
        if (url.endsWith("pipeline-session")) {
          mints++;
          assert.deepEqual(JSON.parse(req.body), {
            variant: "gemma12",
            cleanup: true,
            cleanupOptions: options,
          });
          return Response.json(session);
        }
        assert.ok(url.endsWith("pipeline-usage"));
        receipts++;
        assert.deepEqual(JSON.parse(req.body), { receipt: final.cleanup_receipt });
        return Response.json({ recorded: true });
      },
    });
    streaming.sendAudio(Buffer.alloc(320));
    const result = await streaming.finalize();
    streaming.handleMessage(final);
    await streaming.usagePromise;
    assert.equal(result.text, final.raw_text);
    assert.equal(result.cleanupText, final.text);
    assert.deepEqual(result.cleanupOptions, options);
    assert.deepEqual([mints, receipts, finals], [1, 1, 1]);
  }
);
test(
  "pipeline cannot bypass account-limit handshake or spoof an arbitrary host",
  { timeout: 2500 },
  async (t) => {
    for (const update of [
      { baseUrl: "https://evil.test" },
      { cleanup: false },
      { requireAccountLimits: false },
      { cleanupModel: "gemma-4-31b" },
      { clientToken: "x".repeat(161) },
    ])
      assert.throws(() => validateSession({ ...session, ...update }, true));
    const streaming = fixture(t);
    await streaming.connect(validateSession(session, true));
    const other = new OrukeetStreaming();
    other.pipeline = true;
    other.requireAccountLimits = true;
    assert.throws(() => other.handleMessage({ ...ready, account_limits: false }), /account limits/);
  }
);
test(
  "malformed final cannot replace a recoverable raw transcript",
  { timeout: 2500 },
  async (t) => {
    const streaming = fixture(t, { ...final, raw_text: undefined });
    await streaming.connect(validateSession(session, true));
    streaming.sendAudio(Buffer.alloc(320));
    await assert.rejects(streaming.finalize(), /Invalid pipeline final/);
  }
);
test("canceled recording never commits or emits a receipt", { timeout: 2500 }, async (t) => {
  const streaming = fixture(t);
  let receipts = 0;
  streaming.onUsageReceipt = () => receipts++;
  await streaming.connect(validateSession(session, true));
  streaming.sendAudio(Buffer.alloc(320));
  await streaming.disconnect();
  streaming.handleMessage(final);
  assert.equal(receipts, 0);
  assert.equal(streaming.result, null);
});

test(
  "pipeline handshake and final metadata reject malformed cleanup contracts promptly",
  { timeout: 2500 },
  async (t) => {
    for (const update of [
      { pipeline_protocol: 1 },
      { pipeline_protocol: undefined },
      { cleanup: false },
    ]) {
      const adapter = new OrukeetStreaming();
      adapter.pipeline = true;
      assert.throws(() => adapter.handleMessage({ ...ready, ...update }), /pipeline handshake/);
    }
    for (const update of [
      { cleanup_status: "unknown" },
      { cleanup_receipt: {} },
      { cleanup_receipt: "x".repeat(2049) },
    ]) {
      const adapter = fixture(t, { ...final, ...update });
      await adapter.connect(validateSession(session, true));
      adapter.sendAudio(Buffer.alloc(320));
      await assert.rejects(adapter.finalize(), /Invalid (pipeline final|cleanup receipt)/);
    }
  }
);

test("pipeline endpoint allowlist rejects a consistent lookalike or unlisted region", () => {
  for (const baseUrl of [
    "https://orukeet.gizmovoice.ai.attacker.test/preview/gemma12",
    "https://orukeet.gizmovoice.ai/regions/us-east1/gemma12",
    "https://orukeet.gizmovoice.ai/regions/us-west1/gemma31",
  ])
    assert.throws(
      () =>
        validateSession(
          {
            ...session,
            baseUrl,
            websocketUrl: `${baseUrl.replace("https:", "wss:")}/v1/pipeline/stream`,
          },
          true
        ),
      /Invalid/
    );
});

test("pipeline deadline allows ASR plus full cleanup queue budget, within hard cap", () => {
  const {
    MAX_FINAL_WAIT_MS,
    PIPELINE_CLEANUP_BUDGET_MS,
    PIPELINE_FINAL_MARGIN_MS,
  } = require("../../src/helpers/orukeetStreaming");
  for (const base of [7000, 25000]) {
    const adapter = new OrukeetStreaming({ finalTimeoutMs: () => base });
    adapter.pipeline = true;
    adapter.isConnected = true;
    adapter.audioBytesSent = 32000;
    adapter.sendControl = (_message, callback) => callback();
    const pending = adapter.finalize();
    assert.equal(
      adapter.finalTimer._idleTimeout,
      Math.min(MAX_FINAL_WAIT_MS, base + PIPELINE_CLEANUP_BUDGET_MS + PIPELINE_FINAL_MARGIN_MS)
    );
    adapter.finalResolve({});
    adapter.clearFinal();
    void pending;
  }
});

const plainSession = {
  baseUrl: "https://orukeet.gizmovoice.ai",
  websocketUrl: "wss://orukeet.gizmovoice.ai/v1/audio/transcriptions/stream",
  clientToken: "test.token",
  protocol: "orukeet.pcm.v1",
  model: "orukeet-v0.1.0",
  expiresIn: 60,
  singleUse: true,
};
function managedFixture() {
  const state = { token: "account", generation: 1 };
  return {
    state,
    tokenStore: { getState: () => ({ ...state }), subscribe: () => () => {} },
    streaming: {
      connect: async function (options) {
        this.connected = options;
      },
      close() {},
      fail(error) {
        this.failure = error;
      },
    },
    getApiUrl: () => "https://api.test",
    withPolicyHeaders: (h) => h,
  };
}
test(
  "cleanup policy or option refusal retries plain ASR without losing capture",
  { timeout: 2500 },
  async () => {
    for (const [status, code] of [
      [403, "POLICY_MODE_BLOCKED"],
      [400, "PIPELINE_OPTIONS_UNSUPPORTED"],
    ]) {
      const deps = managedFixture();
      const calls = [];
      await connectManagedOrukeet({
        ...deps,
        pipelineOptions: { customPrompt: "long prompt" },
        proxyFetch: async (url, request) => {
          calls.push([url, request]);
          return calls.length === 1
            ? Response.json({ code }, { status })
            : Response.json(plainSession);
        },
      });
      assert.deepEqual(
        calls.map(([url]) => url.split("/").pop()),
        ["pipeline-session", "session"]
      );
      assert.equal(calls[1][1].body, undefined);
      assert.equal(deps.streaming.cleanupOptions, undefined);
      assert.equal(deps.streaming.connected.baseUrl, plainSession.baseUrl);
    }
  }
);

test(
  "plain retry still honors transcription policy and account quota refusals",
  { timeout: 2500 },
  async () => {
    for (const refusal of [
      Response.json({ code: "POLICY_MODE_BLOCKED" }, { status: 403 }),
      Response.json({ limitReached: true }, { status: 429 }),
    ]) {
      const deps = managedFixture();
      let requests = 0;
      await assert.rejects(
        connectManagedOrukeet({
          ...deps,
          pipelineOptions: {},
          proxyFetch: async () =>
            ++requests === 1
              ? Response.json({ code: "PIPELINE_OPTIONS_UNSUPPORTED" }, { status: 400 })
              : refusal,
        }),
        /./
      );
      assert.equal(requests, 2);
      assert.equal(deps.streaming.connected, undefined);
    }
  }
);

test(
  "receipt relay retries transient responses exactly twice and stops on permanent rejection",
  { timeout: 2500 },
  async () => {
    const { relayCleanupUsage } = require("../../src/helpers/orukeetCloudSession");
    const { captureAuthFence } = require("../../src/helpers/cloudApiRequest");
    for (const status of [401, 408, 429, 500, 400, 403]) {
      const deps = managedFixture();
      let requests = 0;
      const waits = [];
      await assert.rejects(
        relayCleanupUsage({
          ...deps,
          receipt: "signed",
          apiUrl: "https://api.test",
          fence: captureAuthFence(deps.tokenStore, 1),
          wait: async (ms) => waits.push(ms),
          proxyFetch: async () => {
            requests++;
            return new Response(null, { status });
          },
        }),
        /Cleanup usage rejected/
      );
      assert.equal(requests, [400, 403].includes(status) ? 1 : 3, String(status));
      assert.deepEqual(waits, [400, 403].includes(status) ? [] : [250, 500]);
    }
  }
);

test(
  "receipt retries cannot cross an account change and errors reach the adapter observer",
  { timeout: 2500 },
  async () => {
    const { relayCleanupUsage } = require("../../src/helpers/orukeetCloudSession");
    const { captureAuthFence } = require("../../src/helpers/cloudApiRequest");
    const deps = managedFixture();
    let calls = 0;
    await assert.rejects(
      relayCleanupUsage({
        ...deps,
        receipt: "signed",
        apiUrl: "https://api.test",
        fence: captureAuthFence(deps.tokenStore, 1),
        wait: async () => {
          deps.state.token = "other";
          deps.state.generation++;
        },
        proxyFetch: async () => {
          calls++;
          return new Response(null, { status: 500 });
        },
      }),
      /Authentication context changed/
    );
    assert.equal(calls, 1);
    const fresh = managedFixture();
    let observed;
    fresh.streaming.onUsageError = (error) => {
      observed = error;
    };
    await connectManagedOrukeet({
      ...fresh,
      pipelineOptions: {},
      proxyFetch: async (url) =>
        url.endsWith("pipeline-session")
          ? Response.json(session)
          : new Response(null, { status: 403 }),
    });
    fresh.streaming.onUsageReceipt("signed");
    await assert.rejects(fresh.streaming.usagePromise);
    await new Promise(setImmediate);
    assert.deepEqual(observed, { status: 403, code: undefined });
  }
);

test(
  "ASR arrival timing stays separate from cleanup and only real model work has attribution",
  { timeout: 2500 },
  async (t) => {
    for (const extra of [
      {
        cleanup_status: "complete",
        cleanup_method: "model",
        cleanup_model: "gemma-4-12b",
        cleanup_ms: 230,
        cleanup_input_tokens: 31,
        cleanup_output_tokens: 9,
      },
      { cleanup_status: "complete", cleanup_method: "passthrough", cleanup_model: null },
      { cleanup_status: "fallback" },
      { cleanup_status: "skipped" },
      { cleanup_status: "complete", cleanup_method: "model", cleanup_model: "untrusted" },
    ]) {
      const adapter = fixture(t);
      await adapter.connect(validateSession(session, true));
      adapter.sendAudio(Buffer.alloc(320));
      adapter.sendControl = (_message, callback) => {
        callback();
        adapter.handleMessage({ type: "transcript", text: final.raw_text });
        setTimeout(() => adapter.handleMessage({ ...final, ...extra }), 20);
      };
      const result = await adapter.finalize();
      assert.ok(result.asrFinalMs < performance.now() - adapter.finalStartedAt - 10);
      assert.equal(result.cleanup.status, extra.cleanup_status);
      assert.equal(
        result.cleanup.model,
        extra.cleanup_status === "complete" &&
          extra.cleanup_method === "model" &&
          extra.cleanup_model === "gemma-4-12b"
          ? "gemma-4-12b"
          : undefined
      );
      assert.equal(result.cleanup.processingMs, extra.cleanup_ms);
      assert.equal(result.cleanup.inputTokens, extra.cleanup_input_tokens);
    }
  }
);
