const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { OrukeetStreaming } = require("../../src/helpers/orukeetStreaming");
const { connectManagedOrukeet, validateSession } = require("../../src/helpers/orukeetCloudSession");
const { ORUKEET_BASE_URL } = require("../../src/helpers/orukeetProtocol");

const ORIGINS = ["https://orukeet.gizmovoice.ai", "https://orukeet.openwhispr.com"];
const ASR_PATHS = ["", "/preview/language-routing"];
const PIPELINE_PATHS = [
  "/preview/gemma12",
  "/regions/us-west1/gemma12",
  "/regions/europe-west4/gemma12",
  "/regions/asia-southeast1/gemma12",
];

function grant(baseUrl, pipeline) {
  return {
    baseUrl,
    websocketUrl:
      baseUrl.replace("https:", "wss:") +
      (pipeline ? "/v1/pipeline/stream" : "/v1/audio/transcriptions/stream"),
    clientToken: "single.use.test-token",
    protocol: pipeline ? "orukeet.pipeline.v2" : "orukeet.pcm.v1",
    model: "orukeet-v0.1.0",
    singleUse: true,
    expiresIn: 60,
    ...(pipeline ? { cleanup: true, cleanupModel: "gemma-4-12b", requireAccountLimits: true } : {}),
  };
}

test("managed hostname support preserves the existing default", () => {
  assert.equal(ORUKEET_BASE_URL, "https://orukeet.gizmovoice.ai");
});

for (const origin of ORIGINS) {
  for (const pipeline of [false, true]) {
    for (const path of pipeline ? PIPELINE_PATHS : ASR_PATHS) {
      test(`managed ${pipeline ? "cleanup" : "ASR"} connects only to its granted route ${origin}${path}`, async (t) => {
        const issued = grant(origin + path, pipeline);
        let commits = 0;
        let metered = 0;
        const streaming = new OrukeetStreaming({
          timeoutMs: 500,
          createSocket(url, options, protocols) {
            assert.equal(url, issued.websocketUrl);
            assert.deepEqual(options.headers, {});
            assert.deepEqual(protocols, [issued.protocol, "auth.single.use.test-token"]);
            const socket = new EventEmitter();
            socket.readyState = 1;
            socket.bufferedAmount = 0;
            socket.close = () => {};
            socket.terminate = () => {};
            socket.send = (data, cb) => {
              cb?.();
              if (typeof data === "string" && JSON.parse(data).type === "commit") {
                commits++;
                queueMicrotask(() =>
                  socket.emit(
                    "message",
                    JSON.stringify({
                      type: "final",
                      text: "Test transcript.",
                      ...(pipeline
                        ? {
                            raw_text: "test transcript",
                            cleanup_status: "complete",
                            cleanup_receipt: "test.proof",
                          }
                        : {}),
                    })
                  )
                );
              }
            };
            queueMicrotask(() =>
              socket.emit(
                "message",
                JSON.stringify({
                  type: "ready",
                  sample_rate: 16000,
                  channels: 1,
                  encoding: "pcm_s16le",
                  max_seconds: 600,
                  ...(pipeline
                    ? { pipeline_protocol: 2, cleanup: true, account_limits: true }
                    : {}),
                })
              )
            );
            return socket;
          },
        });
        t.after(() => streaming.disconnect());
        streaming.beginConnecting();
        await connectManagedOrukeet({
          streaming,
          tokenStore: {
            getState: () => ({ token: "account-only", generation: 1 }),
            subscribe: () => () => {},
          },
          getApiUrl: () => "https://api.openwhispr.test",
          withPolicyHeaders: (h) => h,
          ...(pipeline ? { pipelineOptions: { customDictionary: ["Orukeet"] } } : {}),
          proxyFetch: async (url, options) => {
            assert.equal(options.headers.Authorization, "Bearer account-only");
            assert.equal(options.redirect, "error");
            assert.equal(options.useSessionCookies, false);
            if (url.endsWith("pipeline-usage")) {
              assert.equal(url, "https://api.openwhispr.test/api/stt/orukeet/pipeline-usage");
              assert.deepEqual(JSON.parse(options.body), { receipt: "test.proof" });
              metered++;
              return Response.json({ recorded: true });
            }
            assert.equal(
              url,
              `https://api.openwhispr.test/api/stt/orukeet/${pipeline ? "pipeline-session" : "session"}`
            );
            return Response.json(issued);
          },
        });
        streaming.sendAudio(Buffer.alloc(320));
        const final = await streaming.finalize();
        await streaming.usagePromise;
        assert.equal(pipeline ? final.cleanupText : final.text, "Test transcript.");
        assert.equal(commits, 1);
        assert.equal(metered, pipeline ? 1 : 0);
      });
    }
  }
}

for (const pipeline of [false, true]) {
  test(`managed ${pipeline ? "cleanup" : "ASR"} rejects origin/path variants and cross-origin WebSockets`, () => {
    const path = pipeline ? "/regions/us-west1/gemma12" : "/preview/language-routing";
    const base = "https://orukeet.openwhispr.com" + path;
    const invalid = [
      "http://orukeet.openwhispr.com" + path,
      "https://orukeet.openwhispr.com.attacker.test" + path,
      "https://attacker.test@orukeet.openwhispr.com" + path,
      "https://orukeet.openwhispr.com@attacker.test" + path,
      "https://orukeet.openwhispr.com:443" + path,
      "https://ORUKEET.openwhispr.com" + path,
      "https://orukeet.openwhispr.com." + path,
      "https://orukeet%2eopenwhispr.com" + path,
      base + "/",
      base + "?token=secret",
      base + "#fragment",
      "https://orukeet.openwhispr.com/preview/../" + path,
      "https://orukeet.openwhispr.com/preview%2Flanguage-routing",
      "https://orukeet.openwhispr.com/regions/us-east1/gemma12",
      "https://orukeet.openwhispr.com/regions/us-west1/gemma31",
    ];
    for (const candidate of invalid) {
      assert.throws(
        () => validateSession(grant(candidate, pipeline), pipeline),
        /Invalid/,
        candidate
      );
    }
    for (const origin of ORIGINS) {
      const issued = grant(origin + path, pipeline);
      for (const websocketUrl of [
        issued.websocketUrl.replace(
          origin.replace("https:", "wss:"),
          ORIGINS.find((o) => o !== origin).replace("https:", "wss:")
        ),
        issued.websocketUrl + "?token=secret",
        issued.websocketUrl + "/",
        issued.websocketUrl.replace("wss:", "ws:"),
        issued.websocketUrl.replace(path, ""),
      ]) {
        assert.throws(
          () => validateSession({ ...issued, websocketUrl }, pipeline),
          /Invalid/,
          websocketUrl
        );
      }
      for (const altered of [
        { singleUse: false },
        { expiresIn: 61 },
        { clientToken: "bad token" },
        { protocol: "other" },
        { model: "other" },
        ...(pipeline ? [{ requireAccountLimits: false }, { cleanupModel: "gemma-4-31b" }] : []),
      ])
        assert.throws(() => validateSession({ ...issued, ...altered }, pipeline), /Invalid/);
    }
  });
}
