const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");

const sarvamModulePath = require.resolve("../../src/helpers/sarvamTranscription");
const originalLoad = Module._load;

// Every request net.fetch sees, so the tests can assert on segment count,
// ordering, and the form fields each segment carried.
const fetches = [];
let fetchBehavior = () => ({ status: 200, body: { transcript: "hello" } });
// Per-request completion delay. Default 0 resolves in submission order; a test
// that cares about ordering overrides it to finish segments out of order.
let delayFor = () => 0;
let inFlight = 0;
let peakInFlight = 0;

const respond = (url, init) => {
  fetches.push({ url: String(url), init });
  const { status, body } = fetchBehavior(fetches.length - 1, init);
  const serialized = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => serialized,
  };
};

const electronStub = {
  net: {
    fetch: async (url, init) => {
      const index = fetches.length;
      const response = respond(url, init);
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, delayFor(index)));
        return response;
      } finally {
        inFlight--;
      }
    },
  },
  app: { getPath: () => "/tmp", getName: () => "test", getVersion: () => "0.0.0", on: () => {} },
};

// FFmpeg is replaced wholesale: the probe returns a scripted duration and the
// splitter writes real (tiny) files so the module's own readFileSync is exercised.
let probeDuration = 12;
let segmentCount = 0;
const splitCalls = [];

const ffmpegStub = {
  probeAudioDuration: async () => probeDuration,
  splitAudioFile: async (inputPath, outputDir, options) => {
    splitCalls.push({ inputPath, outputDir, options });
    const chunkPaths = [];
    for (let i = 0; i < segmentCount; i++) {
      const chunkPath = path.join(outputDir, `chunk-${String(i).padStart(3, "0")}.mp3`);
      fs.writeFileSync(chunkPath, Buffer.from([i]));
      chunkPaths.push(chunkPath);
    }
    return { chunkPaths, durationSeconds: probeDuration };
  },
};

Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === sarvamModulePath && request === "./ffmpegUtils") return ffmpegStub;
  return originalLoad.call(this, request, parent, isMain);
};

const {
  transcribeWithSarvam,
  joinSarvamTranscripts,
  sarvamErrorMessage,
  extractSarvamErrorDetail,
  sarvamFormFields,
  isRetryableSegmentError,
  postSegmentWithRetry,
  retryDelayMs,
  SARVAM_MAX_AUDIO_SECONDS,
  SARVAM_SEGMENT_SECONDS,
  SARVAM_SEGMENT_CONCURRENCY,
  SARVAM_SEGMENT_MAX_ATTEMPTS,
} = require("../../src/helpers/sarvamTranscription");

test.after(() => {
  Module._load = originalLoad;
});

test.beforeEach(() => {
  fetches.length = 0;
  splitCalls.length = 0;
  probeDuration = 12;
  segmentCount = 0;
  fetchBehavior = () => ({ status: 200, body: { transcript: "hello" } });
  delayFor = () => 0;
  inFlight = 0;
  peakInFlight = 0;
});

const transcribe = (overrides = {}) =>
  transcribeWithSarvam({
    apiKey: "sk-sarvam",
    audioBuffer: Buffer.from([1, 2, 3, 4]),
    model: "saaras:v3",
    language: "hi",
    ...overrides,
  });

test("audio inside the 30s limit is forwarded as one unmodified request", async () => {
  probeDuration = SARVAM_MAX_AUDIO_SECONDS;

  const result = await transcribe();

  assert.equal(result.text, "hello");
  assert.equal(result.segmentCount, 1);
  assert.equal(splitCalls.length, 0, "must not re-encode audio that already fits");
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].url, "https://api.sarvam.ai/speech-to-text");
  assert.equal(fetches[0].init.headers["api-subscription-key"], "sk-sarvam");
  assert.equal(fetches[0].init.body.get("file").type, "audio/webm");
  assert.equal(fetches[0].init.body.get("language_code"), "hi-IN");
});

test("an unprobeable duration sends the audio as-is rather than failing", async () => {
  probeDuration = null;

  const result = await transcribe();

  assert.equal(result.segmentCount, 1);
  assert.equal(result.durationSeconds, null);
  assert.equal(splitCalls.length, 0);
  assert.equal(fetches.length, 1);
});

test("audio past the limit is segmented and the transcripts joined in order", async () => {
  probeDuration = 95;
  segmentCount = 4;
  // Finish in reverse: the last segment submitted returns first. Without this
  // the stub completes in submission order and the ordering claim is vacuous —
  // the assertion below would hold even if results were appended as they landed.
  delayFor = (index) => (segmentCount - index) * 10;
  fetchBehavior = (index, init) => ({
    status: 200,
    body: { transcript: `part-${init.body.get("file").name}` },
  });

  const result = await transcribe();

  assert.equal(fetches.length, 4);
  assert.equal(result.segmentCount, 4);
  assert.equal(result.durationSeconds, 95);
  assert.equal(
    result.text,
    "part-chunk-000.mp3 part-chunk-001.mp3 part-chunk-002.mp3 part-chunk-003.mp3"
  );

  assert.equal(splitCalls.length, 1);
  assert.equal(splitCalls[0].options.segmentDuration, SARVAM_SEGMENT_SECONDS);
  assert.ok(
    SARVAM_SEGMENT_SECONDS < SARVAM_MAX_AUDIO_SECONDS,
    "segments need headroom under the API limit"
  );
});

test("segments are capped at the configured concurrency", async () => {
  probeDuration = 300;
  segmentCount = 12;
  delayFor = () => 5;

  await transcribe();

  assert.equal(fetches.length, 12);
  assert.equal(
    peakInFlight,
    SARVAM_SEGMENT_CONCURRENCY,
    "a long recording must not open one connection per segment"
  );
});

test("one non-retryable segment fails the job without its siblings finishing", async () => {
  probeDuration = 300;
  segmentCount = 12;
  delayFor = () => 5;
  // Only the second segment is rejected, and with a status that is never
  // retried — so this measures fail-fast propagation, not a total outage.
  fetchBehavior = (index) =>
    index === 1
      ? { status: 400, body: { error: { message: "unsupported codec" } } }
      : { status: 200, body: { transcript: "ok" } };

  await assert.rejects(transcribe(), /unsupported codec/);

  assert.ok(
    fetches.length < 12,
    `remaining segments must be abandoned, but all ${fetches.length} were sent`
  );

  // The call must not leave segments running behind it. Anything still on the
  // wire here would be uploading into a working directory the failure path has
  // already deleted, and burning quota for a transcript nobody will read.
  const settled = fetches.length;
  assert.equal(inFlight, 0, "every segment must have settled before the call threw");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fetches.length, settled, "no segment may start after the call threw");
});

test("every segment carries the same model and language fields", async () => {
  probeDuration = 60;
  segmentCount = 3;

  await transcribe();

  for (const { init } of fetches) {
    assert.equal(init.body.get("model"), "saaras:v3");
    assert.equal(init.body.get("mode"), "transcribe");
    assert.equal(init.body.get("language_code"), "hi-IN");
    // splitAudioFile emits MP3, so the declared type must follow the re-encode.
    assert.equal(init.body.get("file").type, "audio/mpeg");
  }
});

test("the working directory is removed even when a segment fails", async () => {
  probeDuration = 60;
  segmentCount = 2;
  fetchBehavior = () => ({ status: 401, body: { error: { message: "bad key" } } });

  await assert.rejects(transcribe(), /Invalid Sarvam API key/);

  // Asserted against the directory the splitter was actually handed. Scanning
  // tmpdir for leftovers instead would pass even if nothing were ever created,
  // and would read shared global state that a parallel test file also writes to.
  assert.equal(splitCalls.length, 1);
  assert.equal(
    fs.existsSync(splitCalls[0].outputDir),
    false,
    "the segment directory must not survive a failure"
  );
});

test("a key failure is coded so the renderer can localize it", async () => {
  probeDuration = 12;
  fetchBehavior = () => ({ status: 429, body: { error: { message: "slow down" } } });

  // Plain-English messages match the sibling provider modules; the renderer
  // localizes from code/messageKey, so those are what must be present.
  await assert.rejects(transcribe(), (error) => {
    assert.equal(error.code, "PROVIDER_RATE_LIMITED");
    assert.equal(error.messageKey, "hooks.audioRecording.errorDescriptions.providerRateLimited");
    return true;
  });

  fetchBehavior = () => ({ status: 401, body: { error: { message: "nope" } } });
  await assert.rejects(transcribe(), (error) => {
    assert.equal(error.code, "INVALID_KEY");
    return true;
  });

  fetchBehavior = () => ({ status: 500, body: { error: { message: "boom" } } });
  await assert.rejects(transcribe(), (error) => {
    assert.equal(error.code, "SERVER_ERROR");
    return true;
  });
});

test("a missing key fails before any request", async () => {
  await assert.rejects(transcribe({ apiKey: "" }), (error) => {
    assert.match(error.message, /Sarvam API key not configured/);
    assert.equal(error.code, "API_KEY_MISSING");
    return true;
  });
  assert.equal(fetches.length, 0);
});

test("sarvamErrorMessage surfaces the API's own diagnosis", () => {
  assert.match(
    sarvamErrorMessage(400, JSON.stringify({ error: { message: "unsupported codec" } })),
    /unsupported codec/
  );
  // FastAPI validation errors use `detail` instead of `error`.
  assert.match(
    sarvamErrorMessage(422, JSON.stringify({ detail: "bad language_code" })),
    /bad language_code/
  );
  assert.match(sarvamErrorMessage(401, ""), /Invalid Sarvam API key/);
  assert.match(sarvamErrorMessage(429, ""), /rate limit/);
  // A non-JSON body still has to reach the user rather than be swallowed.
  assert.match(sarvamErrorMessage(502, "<html>gateway</html>"), /gateway/);
  assert.equal(extractSarvamErrorDetail(null), "");
});

test("joinSarvamTranscripts drops empty segments and normalizes spacing", () => {
  assert.equal(joinSarvamTranscripts(["one ", "", null, "  two"]), "one two");
  assert.equal(joinSarvamTranscripts([]), "");
});

test("sarvamFormFields omits mode outside v3 and language outside Sarvam's set", () => {
  assert.deepEqual(sarvamFormFields("saaras:v4", "fr"), { model: "saaras:v4" });
  assert.deepEqual(sarvamFormFields(undefined, "auto"), {
    model: "saaras:v3",
    mode: "transcribe",
  });
});

test("only rate limits, server faults and unanswered requests are retried", () => {
  assert.equal(isRetryableSegmentError({ status: 429 }), true);
  assert.equal(isRetryableSegmentError({ status: 503 }), true);
  assert.equal(isRetryableSegmentError(new Error("socket hang up")), true);
  assert.equal(isRetryableSegmentError({ status: 400 }), false);
  assert.equal(isRetryableSegmentError({ status: 401 }), false);
  assert.equal(isRetryableSegmentError({ name: "AbortError" }), false);
  assert.ok(retryDelayMs(2) > retryDelayMs(1), "backoff must grow between attempts");
});

test("a segment retries a transient failure and gives up on the attempt ceiling", async () => {
  const noWait = async () => {};
  let calls = 0;

  const recovered = await postSegmentWithRetry(
    0,
    async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("rate limited"), { status: 429 });
      return { text: "ok" };
    },
    undefined,
    noWait
  );
  assert.deepEqual(recovered, { text: "ok" });
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(
    postSegmentWithRetry(
      0,
      async () => {
        calls++;
        throw Object.assign(new Error("server error"), { status: 500 });
      },
      undefined,
      noWait
    ),
    /server error/
  );
  assert.equal(calls, SARVAM_SEGMENT_MAX_ATTEMPTS);

  calls = 0;
  await assert.rejects(
    postSegmentWithRetry(
      0,
      async () => {
        calls++;
        throw Object.assign(new Error("bad key"), { status: 401 });
      },
      undefined,
      noWait
    ),
    /bad key/
  );
  assert.equal(calls, 1, "a credential failure repeats identically — it must not be retried");
});
