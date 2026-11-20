const { test } = require("node:test");
const assert = require("node:assert/strict");
const { pcm16ToWav } = require("../../src/utils/audioUtils");
const { getFFmpegPath } = require("../../src/helpers/ffmpegUtils");
const { transcribeWithSarvam } = require("../../src/helpers/sarvamTranscription");
const { sarvamKeyterms, sarvamLanguage } = require("../../src/utils/sarvam");

const mediaTest = getFFmpegPath() ? test : test.skip;
const audio = (seconds) => pcm16ToWav(Buffer.alloc(seconds * 32000));
const ok = (transcript) => Response.json({ transcript });

test("Sarvam maps only supported REST hints and preserves dictionary phrases", () => {
  assert.equal(sarvamLanguage("or"), "od-IN");
  assert.equal(sarvamLanguage("en-GB"), "en-IN");
  assert.equal(sarvamLanguage("as"), "as-IN");
  assert.equal(sarvamLanguage("auto"), undefined);
  assert.equal(sarvamLanguage("fr"), undefined);
  const terms = [" New Delhi ", "New Delhi", "", "x".repeat(65), "अ".repeat(64)];
  assert.deepEqual(sarvamKeyterms(terms), ["New Delhi", "अ".repeat(64)]);
  assert.equal(sarvamKeyterms(Array.from({ length: 60 }, (_, i) => String(i))).length, 50);
});

for (const model of ["saaras:v4", "saaras:v3"]) {
  mediaTest(`native transcription request on ${model}`, async () => {
    let calls = 0;
    const data = await transcribeWithSarvam({
      audioBuffer: audio(1),
      apiKey: "dummy",
      model,
      language: "hi",
      keyterms: ["OpenWhispr"],
      fetchImpl: async (url, { headers, body, redirect }) => {
        calls++;
        assert.equal(url, "https://api.sarvam.ai/speech-to-text");
        assert.equal(redirect, "error");
        assert.equal(headers["api-subscription-key"], "dummy");
        assert.equal(body.get("language_code"), "hi-IN");
        assert.equal(body.get("model"), model);
        assert.equal(body.get("mode"), "transcribe");
        assert.equal(body.get("keyterms"), model === "saaras:v4" ? '["OpenWhispr"]' : null);
        assert.equal(body.get("file").type, "audio/wav");
        return ok("नमस्ते");
      },
    });
    assert.equal(calls, 1);
    assert.equal(data.text, "नमस्ते");
  });
}

for (const seconds of [29, 30, 31]) {
  mediaTest(`recording of ${seconds}s produces complete ordered WAV segments`, async () => {
    const sizes = [];
    const data = await transcribeWithSarvam({
      audioBuffer: audio(seconds),
      apiKey: "dummy",
      language: "auto",
      fetchImpl: async (_, { body }) => {
        assert.equal(body.get("language_code"), null);
        const wav = Buffer.from(await body.get("file").arrayBuffer());
        assert.equal(wav.toString("ascii", 0, 4), "RIFF");
        sizes.push(wav.readUInt32LE(40));
        return ok(String(sizes.length));
      },
    });
    assert.ok(sizes.every((s) => s <= 30 * 32000));
    assert.equal(
      sizes.reduce((a, b) => a + b, 0),
      seconds * 32000
    );
    assert.equal(data.text, seconds <= 30 ? "1" : "1 2");
  });
}

mediaTest("a silent recording uses the normal no-speech outcome", async () => {
  await assert.rejects(
    transcribeWithSarvam({
      audioBuffer: audio(1),
      apiKey: "dummy",
      fetchImpl: async () => ok(" "),
    }),
    { code: "NO_SPEECH_DETECTED" }
  );
});

mediaTest("a failed or cancelled later segment never returns a partial success", async () => {
  let calls = 0;
  await assert.rejects(
    transcribeWithSarvam({
      audioBuffer: audio(32),
      apiKey: "dummy",
      fetchImpl: async () =>
        ++calls === 1
          ? ok("first")
          : Response.json({ error: { code: "invalid_api_key_error" } }, { status: 403 }),
    }),
    { code: "PROVIDER_AUTH_FAILED" }
  );
  assert.equal(calls, 2);
  const controller = new AbortController();
  await assert.rejects(
    transcribeWithSarvam({
      audioBuffer: audio(32),
      apiKey: "dummy",
      signal: controller.signal,
      fetchImpl: async () => {
        controller.abort();
        return ok("first");
      },
    }),
    { name: "AbortError" }
  );
});

mediaTest("a transient failure retries just the affected piece", async () => {
  const responses = [ok("first"), new Response(null, { status: 503 }), ok("second")];
  const sizes = [];
  const { text } = await transcribeWithSarvam({
    audioBuffer: audio(31),
    apiKey: "dummy",
    fetchImpl: async (_, { body }) => {
      sizes.push(body.get("file").size);
      return responses.shift();
    },
  });
  assert.equal(text, "first second");
  assert.equal(sizes.length, 3);
  assert.equal(sizes[1], sizes[2]);
  assert.notEqual(sizes[0], sizes[1]);
});

mediaTest("an upload reports each piece as it finishes", async () => {
  const progress = [];
  await transcribeWithSarvam({
    audioBuffer: audio(61),
    apiKey: "dummy",
    onProgress: ({ chunksCompleted, chunksTotal }) => progress.push([chunksCompleted, chunksTotal]),
    fetchImpl: async () => ok("piece"),
  });
  assert.deepEqual(progress, [
    [0, 3],
    [1, 3],
    [2, 3],
    [3, 3],
  ]);
});

mediaTest("a rate limit is waited out only within the caller's budget", async () => {
  const limited = () =>
    Response.json(
      { error: { code: "rate_limit_exceeded_error" } },
      {
        status: 429,
        headers: { "retry-after": "1" },
      }
    );
  const run = (options) => {
    let calls = 0;
    const result = transcribeWithSarvam({
      audioBuffer: audio(1),
      apiKey: "dummy",
      fetchImpl: async () => (++calls === 1 ? limited() : ok("after the wait")),
      ...options,
    });
    return result.finally(() => assert.equal(calls, options.expectedCalls));
  };
  await assert.rejects(run({ maxRetryWaitMs: 500, expectedCalls: 1 }), {
    code: "PROVIDER_RATE_LIMITED",
  });
  assert.equal((await run({ expectedCalls: 2 })).text, "after the wait");
});

mediaTest("a manifest disguised as a WAV cannot send a neighboring file", async (t) => {
  const fs = require("node:fs/promises");
  const path = require("node:path");
  const dir = await fs.mkdtemp(path.join(require("node:os").tmpdir(), "ow-sarvam-fixture-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "private.wav"), audio(1));
  const filePath = path.join(dir, "selected.wav");
  await fs.writeFile(filePath, "ffconcat version 1.0\nfile 'private.wav'\n");
  let calls = 0;
  await assert.rejects(
    transcribeWithSarvam({
      filePath,
      apiKey: "dummy",
      fetchImpl: async () => {
        calls++;
        return ok("unexpected");
      },
    }),
    /FFmpeg exited/
  );
  assert.equal(calls, 0);
});

mediaTest("a dropped response body retries the same clip", async () => {
  let calls = 0;
  const { text } = await transcribeWithSarvam({
    audioBuffer: audio(1),
    apiKey: "dummy",
    fetchImpl: async () => {
      if (++calls === 2) return ok("recovered");
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("socket closed"));
          },
        })
      );
    },
  });
  assert.equal(text, "recovered");
  assert.equal(calls, 2);
});

mediaTest(
  "a garbled success, a spent seat budget and repeated timeouts surface as provider errors",
  async () => {
    await assert.rejects(
      transcribeWithSarvam({
        audioBuffer: audio(1),
        apiKey: "dummy",
        fetchImpl: async () => new Response("<html>gateway</html>"),
      }),
      /invalid transcript/
    );
    let calls = 0;
    await assert.rejects(
      transcribeWithSarvam({
        audioBuffer: audio(1),
        apiKey: "dummy",
        fetchImpl: async () => {
          calls++;
          return Response.json({ error: { code: "seat_budget_exhausted_error" } }, { status: 429 });
        },
      }),
      { code: "PROVIDER_QUOTA_EXHAUSTED" }
    );
    assert.equal(calls, 1, "waiting does not clear a spent budget");
    await assert.rejects(
      transcribeWithSarvam({
        audioBuffer: audio(1),
        apiKey: "dummy",
        fetchImpl: async () => {
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        },
      }),
      { code: "PROVIDER_TIMEOUT" }
    );
  }
);
