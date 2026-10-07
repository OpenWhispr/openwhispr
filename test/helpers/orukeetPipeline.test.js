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
test("combined stream keeps raw text and cleanup separate and meters exactly once on duplicate final", async (t) => {
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
});
test("pipeline cannot bypass account-limit handshake or spoof an arbitrary host", async (t) => {
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
});
test("malformed final cannot replace a recoverable raw transcript", async (t) => {
  const streaming = fixture(t, { ...final, raw_text: undefined });
  await streaming.connect(validateSession(session, true));
  streaming.sendAudio(Buffer.alloc(320));
  await assert.rejects(streaming.finalize(), /Invalid pipeline final/);
});
test("canceled recording never commits or emits a receipt", async (t) => {
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
