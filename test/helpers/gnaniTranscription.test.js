const test = require("node:test");
const assert = require("node:assert/strict");
const { pcm16ToWav } = require("../../src/utils/audioUtils");
const { asciiJson, resolveGnaniConfig } = require("../../src/helpers/gnaniConfig");
const {
  createGnaniClient,
  transcribeGnaniRecording,
} = require("../../src/helpers/gnaniTranscription");
const { transcribeGnaniBatch } = require("../../src/helpers/gnaniBatch");
const { testProviderConnection } = require("../../src/helpers/providerConnectionTest");

const ok = (body) => Response.json(body);
const recording = (seconds) => pcm16ToWav(Buffer.alloc(seconds * 32000));

test("both Prisma models accept every supported language from the app's language picker", () => {
  const { languages } = require("../../src/config/languageRegistry.json");
  for (const base of ["en", "hi", "bn", "gu", "kn", "ml", "mr", "pa", "ta", "te"]) {
    const options = languages.filter(({ code }) => code.split("-")[0] === base);
    assert.ok(options.length, base);
    for (const { code } of options) {
      for (const model of ["prisma-v3.0", "prisma-v2.5"]) {
        assert.equal(resolveGnaniConfig({ model, language: code }).languageCode, base + "-IN");
      }
    }
  }
});

test("Prisma normalizes supported languages and bounds the escaped dictionary on v3 only", () => {
  const terms = [
    "OpenWhispr",
    "OpenWhispr",
    "नमस्ते",
    "<|skip",
    ...Array.from({ length: 210 }, (_, i) => "名".repeat(10) + i),
  ];
  const v3 = resolveGnaniConfig({ model: "stale", keyterms: terms });
  assert.equal(v3.model, "prisma-v3.0");
  assert.equal(v3.languageCode, "indic-auto");
  assert.equal(v3.format, "codemix");
  assert.deepEqual(v3.keyterms.slice(0, 2), ["OpenWhispr", "नमस्ते"]);
  const encoded = asciiJson(v3.keyterms);
  assert.doesNotMatch(encoded, /[^\x20-\x7e]/);
  assert.ok(encoded.length <= 4096);
  assert.deepEqual(JSON.parse(encoded), v3.keyterms);
  assert.equal(resolveGnaniConfig({ language: "gu" }).languageCode, "gu-IN");
  assert.deepEqual(
    resolveGnaniConfig({ model: "prisma-v2.5", language: "auto", keyterms: terms }),
    {
      model: "prisma-v2.5",
      languageCode: "en-IN",
      format: "transcribe",
      keyterms: [],
    }
  );
  assert.throws(() => resolveGnaniConfig({ model: "prisma-v2.5", language: "fr" }), /supported/);
});

test("REST preserves every sample in order, including a truncated success and a short final clip", async () => {
  const sizes = [];
  const result = await transcribeGnaniRecording({
    apiKey: "saved",
    audioBuffer: recording(31),
    language: "hi",
    keyterms: ["OpenWhispr"],
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.vachana.ai/stt/v3");
      assert.deepEqual(options.headers, { "X-API-Key-ID": "saved" });
      assert.equal(options.redirect, "error");
      assert.equal(options.body.get("model"), "prisma-v3.0");
      assert.equal(options.body.get("language_code"), "hi-IN");
      assert.equal(options.body.get("format"), "codemix");
      assert.equal(options.body.get("keyterms"), '["OpenWhispr"]');
      sizes.push((options.body.get("audio_file").size - 44) / 32000);
      return ok({
        success: true,
        transcript: sizes.length === 1 ? "incomplete" : String(sizes.length),
        truncated: sizes.length === 1,
        detected_language_code: "hi-IN",
      });
    },
  });
  assert.deepEqual(sizes, [30, 15, 15, 1]);
  assert.equal(result.text, "2 3 4");
  assert.equal(result.language, "hi-IN");
});

test("REST keeps recognized halves on a truncated clip and measures missing audio by duration", async () => {
  let calls = 0;
  const result = await transcribeGnaniRecording({
    audioBuffer: recording(31),
    apiKey: "saved",
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return ok({ success: true, transcript: "partial", truncated: true });
      if (calls === 3) return ok({});
      return ok({ success: true, transcript: calls === 2 ? "First half" : "Last second" });
    },
  });
  assert.match(result.text, /First half.*0:15.*0:30.*Last second/);
  assert.equal(result.failedChunks, 1);
  assert.equal(result.totalChunks, 3);
  let clips = 0;
  await assert.rejects(
    transcribeGnaniRecording({
      audioBuffer: recording(31),
      apiKey: "saved",
      fetchImpl: async () =>
        ++clips === 1 ? ok({}) : ok({ success: true, transcript: "Last second" }),
    }),
    /invalid transcription/
  );
});

test("REST distinguishes silence, malformed success, a recoverable gap, and rejected credentials", async () => {
  const run = (fetchImpl, seconds = 1) =>
    transcribeGnaniRecording({
      model: "prisma-v2.5",
      audioBuffer: recording(seconds),
      apiKey: "saved",
      fetchImpl,
    });
  assert.equal((await run(async () => ok({ success: true, transcript: "" }))).text, "");
  await assert.rejects(
    run(async () => ok({ success: true })),
    /invalid transcription/
  );
  let i = 0;
  const partial = await run(
    async () => (++i === 2 ? ok({ success: true }) : ok({ success: true, transcript: String(i) })),
    61
  );
  assert.equal(partial.failedChunks, 1);
  assert.match(partial.text, /1.*0:30.*1:00.*3/);
  let attempts = 0;
  await assert.rejects(
    run(async () => {
      attempts++;
      return Response.json({}, { status: 401 });
    }, 61),
    { code: "PROVIDER_AUTH_FAILED" }
  );
  assert.equal(attempts, 1);
});

test("key check requires Gnani's authenticated missing-audio response", async () => {
  const cfg = { scope: "transcription", provider: "gnani", apiKey: "test", model: "prisma-v2.5" };
  const valid = await testProviderConnection(cfg, async (url, opts) => {
    assert.equal(url, "https://api.vachana.ai/stt/v3");
    assert.equal(opts.headers["X-API-Key-ID"], "test");
    assert.equal(opts.body.get("model"), "prisma-v2.5");
    return Response.json(
      { detail: [{ type: "missing", loc: ["body", "audio_file"] }] },
      { status: 422 }
    );
  });
  assert.equal(valid.success, true);
  for (const status of [200, 401, 403, 422, 429, 503]) {
    const r = await testProviderConnection(cfg, async () => Response.json({}, { status }));
    assert.equal(r.success, false);
    assert.equal(r.status, status);
  }
});

function batchOptions(overrides = {}) {
  const jobId = "test-job";
  const fileId = "test-file";
  const file = {
    status: "COMPLETED",
    file_id: fileId,
    transcript_url: "https://gnaniasraudios.s3.amazonaws.com/result",
  };
  return {
    wav: new Blob(["audio"]),
    config: resolveGnaniConfig({ model: "prisma-v2.5" }),
    diarize: true,
    apiKey: "saved",
    pollIntervalMs: 0,
    request: async (route, options) => {
      if (route === "/batch/jobs") {
        const cfg = JSON.parse(options.body.get("config"));
        assert.equal(cfg.model, "prisma-v2.5");
        assert.equal(cfg.language_code, "en-IN");
        assert.equal(cfg.with_diarization, true);
        assert.equal(cfg.format, undefined);
        assert.equal(cfg.keyterms, undefined);
        return { job_id: jobId };
      }
      if (route.endsWith("/start")) return { status: "STARTING" };
      if (route.endsWith("/files")) return { data: [file] };
      return { status: "COMPLETED" };
    },
    fetchImpl: async (_url, opts) => {
      assert.equal(opts.headers, undefined);
      assert.equal(opts.redirect, "error");
      return ok({
        model: "prisma-v2.5",
        job_id: jobId,
        file_id: fileId,
        full_transcript: "Hello",
        segments: [{ text: "Hello", start_time: 0.5, end_time: 1.5, speaker_id: 0 }],
      });
    },
    ...overrides,
  };
}

test("Batch refreshes an expired result for the same file and retains speaker zero and offsets", async () => {
  const opts = batchOptions();
  let downloads = 0;
  const result = await transcribeGnaniBatch({
    ...opts,
    fetchImpl: (...args) =>
      ++downloads === 1 ? new Response(null, { status: 403 }) : opts.fetchImpl(...args),
  });
  assert.equal(result.diarized, true);
  assert.equal(downloads, 2);
  assert.deepEqual(result.segments, [{ text: "Hello", start: 0.5, end: 1.5, speaker: "0" }]);
});

test("large Batch audio uses the negotiated PUT without credentials and starts only after upload", async () => {
  const opts = batchOptions();
  const wav = new Blob([Buffer.alloc(10_000_001)]);
  const steps = [];
  await transcribeGnaniBatch({
    ...opts,
    wav,
    request: async (route, options) => {
      steps.push(route);
      if (route === "/batch/v2/jobs") {
        assert.equal(JSON.parse(options.body).source.type, "direct_upload_url");
        return { job_id: "test-job", uploads: [{ url: "https://test.s3.amazonaws.com/input" }] };
      }
      return opts.request(route, options);
    },
    fetchImpl: async (url, options) => {
      if (options.method !== "PUT") return opts.fetchImpl(url, options);
      steps.push(options.method);
      assert.equal(options.body, wav);
      assert.equal(options.headers, undefined);
      assert.equal(options.redirect, "error");
      return new Response(null, { status: 200 });
    },
  });
  assert.deepEqual(steps.slice(0, 3), ["/batch/v2/jobs", "PUT", "/batch/jobs/test-job/start"]);
});

test("a missing presigned endpoint falls back to one lossless inline file within the service limit", async () => {
  const opts = batchOptions();
  const wav = new Blob([Buffer.alloc(10_000_001)]);
  let inline = 0;
  const request = async (route, options) => {
    if (route === "/batch/v2/jobs")
      throw Object.assign(new Error("Unavailable"), { statusCode: 404 });
    if (route === "/batch/jobs") {
      inline++;
      assert.equal(options.body.get("files").name, "recording.flac");
    }
    return opts.request(route, options);
  };
  const result = await transcribeGnaniBatch({
    ...opts,
    wav,
    request,
    compactFile: async () => new Blob(["flac"]),
  });
  assert.equal(result.diarized, true);
  await assert.rejects(
    transcribeGnaniBatch({ ...opts, wav, request, compactFile: async () => wav }),
    /10 MB/
  );
  assert.equal(inline, 1);
});

test("job creation retries a rejected rate limit and preserves an ambiguous failure without creating another job", async () => {
  let attempts = 0;
  const request = createGnaniClient({
    apiKey: "saved",
    fetchImpl: async () =>
      ++attempts === 1
        ? Response.json({}, { status: 429, headers: { "Retry-After": "0" } })
        : Response.json({ request_id: "gnani-test" }, { status: 503 }),
  });
  await assert.rejects(
    request("/batch/jobs", { method: "POST" }, { retry: "rate-limit" }),
    (error) => error.statusCode === 503 && error.technicalDetails.requestId === "gnani-test"
  );
  assert.equal(attempts, 2);
});

test("Batch guards storage URLs and reports file failure even on a terminal job", async () => {
  const opts = batchOptions();
  for (const row of [
    { status: "FAILED" },
    { status: "COMPLETED", transcript_url: "http://127.0.0.1/test" },
  ]) {
    await assert.rejects(
      transcribeGnaniBatch({
        ...opts,
        request: (...args) =>
          args[0].endsWith("/files") ? { data: [row] } : opts.request(...args),
      }),
      /did not complete|unsupported storage/
    );
  }
});

test("cancelling a Batch poll cancels the owned job and does not create a second job", async () => {
  const ctrl = new AbortController();
  const opts = batchOptions();
  const created = [];
  const cancelled = [];
  await assert.rejects(
    transcribeGnaniBatch({
      ...opts,
      signal: ctrl.signal,
      request: async (route, options) => {
        if (route === "/batch/jobs/test-job") {
          ctrl.abort();
          return { status: "IN_PROGRESS" };
        }
        if (route === "/batch/jobs") created.push(route);
        return opts.request(route, options);
      },
      fetchImpl: async (url, options) => {
        cancelled.push(url);
        assert.equal(options.headers["X-API-Key-ID"], "saved");
        return ok({});
      },
    }),
    { name: "AbortError" }
  );
  assert.equal(created.length, 1);
  assert.deepEqual(cancelled, ["https://api.vachana.ai/stt/v3/batch/jobs/test-job/cancel"]);
});
