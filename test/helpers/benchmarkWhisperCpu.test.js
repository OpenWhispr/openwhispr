const test = require("node:test");
const assert = require("node:assert/strict");

const loadHarness = () => import("../../scripts/benchmark-whisper-cpu.mjs");

test("duration-scaled audio context follows the published formula, alignment, and bounds", async () => {
  const { calculateDurationScaledAudioCtx } = await loadHarness();

  assert.equal(calculateDurationScaledAudioCtx(2.46), 256);
  assert.equal(calculateDurationScaledAudioCtx(8), 576);
  assert.equal(calculateDurationScaledAudioCtx(60), 1500);
  assert.throws(() => calculateDurationScaledAudioCtx(0), /positive duration/);
});

test("variant construction changes one benchmark condition at a time", async () => {
  const { buildVariants } = await loadHarness();

  const variants = buildVariants(2.46);
  assert.deepEqual(
    variants.map(({ id, language, audioCtx, flashAttention, threads }) => ({
      id,
      language,
      audioCtx,
      flashAttention,
      threads,
    })),
    [
      {
        id: "baseline-start",
        language: "auto",
        audioCtx: null,
        flashAttention: true,
        threads: 6,
      },
      {
        id: "forced-spanish",
        language: "es",
        audioCtx: null,
        flashAttention: true,
        threads: 6,
      },
      {
        id: "audio-ctx-512",
        language: "auto",
        audioCtx: 512,
        flashAttention: true,
        threads: 6,
      },
      {
        id: "audio-ctx-duration-scaled",
        language: "auto",
        audioCtx: 256,
        flashAttention: true,
        threads: 6,
      },
      {
        id: "flash-attention-off",
        language: "auto",
        audioCtx: null,
        flashAttention: false,
        threads: 6,
      },
      {
        id: "threads-4",
        language: "auto",
        audioCtx: null,
        flashAttention: true,
        threads: 4,
      },
      {
        id: "threads-8",
        language: "auto",
        audioCtx: null,
        flashAttention: true,
        threads: 8,
      },
      {
        id: "baseline-end",
        language: "auto",
        audioCtx: null,
        flashAttention: true,
        threads: 6,
      },
    ]
  );
});

test("command and multipart fields reproduce current-main defaults", async () => {
  const { buildServerArgs, buildInferenceFields } = await loadHarness();
  const variant = {
    language: "es",
    audioCtx: 512,
    flashAttention: false,
    threads: 4,
  };

  assert.deepEqual(buildServerArgs(variant, "/tmp/small.bin", 8180), [
    "--model",
    "/tmp/small.bin",
    "--host",
    "127.0.0.1",
    "--port",
    "8180",
    "--threads",
    "4",
    "--language",
    "auto",
    "--no-timestamps",
    "--no-flash-attn",
  ]);
  assert.deepEqual(buildInferenceFields(variant), {
    language: "es",
    entropy_thold: "2.8",
    logprob_thold: "-1.25",
    response_format: "json",
    audio_ctx: "512",
  });
});

test("native timing parser extracts cumulative whisper stages and detected language", async () => {
  const { parseWhisperDiagnostics } = await loadHarness();
  const parsed = parseWhisperDiagnostics(`
whisper_full_with_state: auto-detected language: es (p = 0.992)
whisper_print_timings:     load time =   321.45 ms
whisper_print_timings:   sample time =    20.00 ms /    11 runs (1.82 ms per run)
whisper_print_timings:   encode time =  2200.00 ms /    11 runs (200.00 ms per run)
whisper_print_timings:   decode time =   550.00 ms /    11 runs (50.00 ms per run)
whisper_print_timings:    total time =  3100.00 ms
`);

  assert.deepEqual(parsed, {
    detectedLanguage: "es",
    detectedLanguageProbability: 0.992,
    timingsMs: {
      load: 321.45,
      sample: 20,
      encode: 2200,
      decode: 550,
      total: 3100,
    },
  });
});

test("duration summary reports a literal median and interquartile spread", async () => {
  const { summarizeDurations } = await loadHarness();

  assert.deepEqual(summarizeDurations([100, 120, 130, 140, 200]), {
    count: 5,
    minMs: 100,
    p25Ms: 120,
    medianMs: 130,
    p75Ms: 140,
    maxMs: 200,
    iqrMs: 20,
  });
});

test("duration summary averages the two middle values for ten measured runs", async () => {
  const { summarizeDurations } = await loadHarness();

  const summary = summarizeDurations([1, 2, 3, 4, 5, 100, 101, 102, 103, 104]);

  assert.equal(summary.medianMs, 52.5);
});

test("baseline drift above fifteen percent marks the run unstable", async () => {
  const { evaluateBaselineDrift } = await loadHarness();

  assert.deepEqual(evaluateBaselineDrift(1000, 1160), {
    startMedianMs: 1000,
    endMedianMs: 1160,
    changePercent: 16,
    thresholdPercent: 15,
    stable: false,
  });
  assert.equal(evaluateBaselineDrift(1000, 850).stable, true);
  assert.equal(evaluateBaselineDrift(1000, 800).stable, false);
});

test("variant execution always stops the server and preserves a request failure", async () => {
  const { executeVariant } = await loadHarness();
  const events = [];

  const result = await executeVariant(
    { id: "baseline-start" },
    {
      start: async () => {
        events.push("start");
        return { readyMs: 42 };
      },
      request: async () => {
        events.push("request");
        throw new Error("connection reset");
      },
      stop: async () => {
        events.push("stop");
        return { exitCode: 0, stderr: "native diagnostics" };
      },
    },
    { warmups: 1, measuredRuns: 10 }
  );

  assert.deepEqual(events, ["start", "request", "stop"]);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "connection reset");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "native diagnostics");
});

test("variant execution attaches each auto-detected language to its request", async () => {
  const { executeVariant } = await loadHarness();
  const detections = [
    ["es", "0.99"],
    ["es", "0.98"],
    ["fr", "0.60"],
  ];

  const result = await executeVariant(
    { id: "baseline-start", language: "auto" },
    {
      start: async () => ({ readyMs: 42 }),
      request: async (_server, _variant, index) => ({
        index: index + 1,
        durationMs: 100 + index,
        status: 200,
        transcript: "Hola",
      }),
      stop: async () => ({
        exitCode: 0,
        stderr: detections
          .map(
            ([language, probability]) =>
              `whisper_full_with_state: auto-detected language: ${language} (p = ${probability})`
          )
          .join("\n"),
      }),
    },
    { warmups: 1, measuredRuns: 2 }
  );

  assert.deepEqual(result.warmup[0], {
    index: 1,
    durationMs: 100,
    status: 200,
    transcript: "Hola",
    requestedLanguage: "auto",
    detectedLanguage: "es",
    detectedLanguageProbability: 0.99,
  });
  assert.deepEqual(
    result.requests.map(({ requestedLanguage, detectedLanguage, detectedLanguageProbability }) => ({
      requestedLanguage,
      detectedLanguage,
      detectedLanguageProbability,
    })),
    [
      {
        requestedLanguage: "auto",
        detectedLanguage: "es",
        detectedLanguageProbability: 0.98,
      },
      {
        requestedLanguage: "auto",
        detectedLanguage: "fr",
        detectedLanguageProbability: 0.6,
      },
    ]
  );
});

test("report schema keeps provenance, environment, rows, and drift explicit", async () => {
  const { createReport } = await loadHarness();
  const report = createReport({
    environment: { os: "linux", architecture: "x64" },
    repository: { sha: "abc123" },
    sidecar: { version: "0.0.8", sha256: "sidecar-sha" },
    model: { id: "ggml-small.bin", sha256: "model-sha" },
    fixture: { sha256: "fixture-sha", expectedLanguage: "es" },
    results: [{ id: "baseline-start", status: "passed" }],
    baselineDrift: { stable: true },
  });

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.environment.os, "linux");
  assert.equal(report.sidecar.sha256, "sidecar-sha");
  assert.equal(report.fixture.expectedLanguage, "es");
  assert.equal(report.results[0].id, "baseline-start");
  assert.equal(report.baselineDrift.stable, true);
});

test("markdown report remains writable when setup fails before benchmarking", async () => {
  const { renderMarkdown } = await loadHarness();
  const markdown = renderMarkdown({
    generatedAt: "2026-09-01T00:00:00.000Z",
    repository: { sha: "abc123" },
    environment: { os: "linux", release: "test", runner: {} },
    sidecar: { version: "0.0.8", sha256: "sidecar-sha" },
    model: { id: "ggml-small.bin", sha256: "model-sha" },
    fixture: { path: "test.wav" },
    results: [],
    baselineDrift: { stable: false },
    fatalError: "fixture verification failed",
  });

  assert.match(markdown, /Fixture: test\.wav \(unavailable\)/);
  assert.match(markdown, /Fatal error: fixture verification failed/);
});
