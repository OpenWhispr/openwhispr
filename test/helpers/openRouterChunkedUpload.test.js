const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  OPENROUTER_CHUNK_SECONDS,
  transcribeOpenRouterChunks,
} = require("../../src/helpers/openRouterChunkedUpload");

// Stands in for ffmpeg's segmenter: writes `count` pieces where it is told.
function fakeSplit(count, { durationSeconds = count * OPENROUTER_CHUNK_SECONDS } = {}) {
  const calls = [];
  const split = async (inputPath, outputDir, options) => {
    calls.push({ inputPath, outputDir, options });
    const chunkPaths = [];
    for (let i = 0; i < count; i++) {
      const piece = path.join(outputDir, `chunk-${String(i).padStart(3, "0")}.mp3`);
      fs.writeFileSync(piece, `piece ${i}`);
      chunkPaths.push(piece);
    }
    return { chunkPaths, durationSeconds };
  };
  return { split, calls };
}

const httpError = (statusCode, message = `API error: ${statusCode}`, extra = {}) =>
  Object.assign(new Error(message), { statusCode }, extra);
const pieceName = (piece) => path.basename(piece, ".mp3");
const noWait = { retryDelayMs: () => 0 };

async function until(predicate) {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setImmediate(r));
  assert.ok(predicate(), "condition never became true");
}

test("a 30-minute upload goes out as eight 4-minute pieces, one at a time, in order", async () => {
  const { split, calls } = fakeSplit(8);
  const progress = [];
  const sent = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const result = await transcribeOpenRouterChunks({
    inputPath: "/uploads/meeting.m4a",
    split,
    transcribeChunk: async (piece) => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight--;
      sent.push(pieceName(piece));
      return { text: `part ${sent.length}` };
    },
    onProgress: (event) => progress.push(event),
  });

  assert.equal(OPENROUTER_CHUNK_SECONDS, 240);
  assert.equal(calls[0].inputPath, "/uploads/meeting.m4a");
  assert.equal(calls[0].options.segmentDuration, 240);
  assert.equal(calls[0].options.audioOnly, true, "a video's frames must not ride along");
  assert.equal(maxInFlight, 1, "pieces never overlap");
  assert.deepEqual(
    sent,
    Array.from({ length: 8 }, (_, i) => `chunk-00${i}`)
  );
  assert.equal(result.text, "part 1 part 2 part 3 part 4 part 5 part 6 part 7 part 8");
  assert.equal(result.warning, undefined);
  assert.deepEqual(progress[0], { stage: "splitting", chunksTotal: 0, chunksCompleted: 0 });
  assert.deepEqual(progress.at(-1), { stage: "transcribing", chunksTotal: 8, chunksCompleted: 8 });
  assert.equal(fs.existsSync(calls[0].outputDir), false, "pieces are deleted afterwards");
});

test("an account problem stops the upload at that piece", async () => {
  const cases = [
    [401, {}],
    [
      402,
      {
        code: "OPENROUTER_OUT_OF_CREDITS",
        messageKey: "hooks.audioRecording.errorDescriptions.openrouterOutOfCredits",
      },
    ],
    [403, {}],
    [404, {}],
  ];
  for (const [status, extra] of cases) {
    const { split } = fakeSplit(3);
    const sent = [];
    await assert.rejects(
      transcribeOpenRouterChunks({
        inputPath: "in",
        split,
        ...noWait,
        transcribeChunk: async (piece) => {
          sent.push(piece);
          if (sent.length === 2) throw httpError(status, `status ${status}`, extra);
          return { text: "ok" };
        },
      }),
      (err) => err.statusCode === status && err.code === extra.code
    );
    assert.equal(sent.length, 2, `${status}: nothing is sent after it`);
  }
});

test("a provider hiccup is retried and the piece still lands", async () => {
  const hiccups = [
    () => httpError(502),
    () => httpError(429),
    () => httpError(524),
    () => new Error("net::ERR_CONNECTION_RESET"),
  ];
  for (const hiccup of hiccups) {
    const { split } = fakeSplit(1);
    let attempts = 0;
    const result = await transcribeOpenRouterChunks({
      inputPath: "in",
      split,
      ...noWait,
      transcribeChunk: async () => {
        if (++attempts < 3) throw hiccup();
        return { text: "made it" };
      },
    });
    assert.equal(attempts, 3);
    assert.equal(result.text, "made it");
  }
});

test("no answer, or a rate limit that outlasts the retries, ends the upload early", async () => {
  const failures = [
    () => new Error("net::ERR_INTERNET_DISCONNECTED"),
    () => httpError(429, "Rate limit exceeded. Please try again later."),
  ];
  for (const failure of failures) {
    const { split } = fakeSplit(8);
    const sent = [];
    await assert.rejects(
      transcribeOpenRouterChunks({
        inputPath: "in",
        split,
        ...noWait,
        transcribeChunk: async (piece) => {
          sent.push(piece);
          throw failure();
        },
      }),
      { message: failure().message }
    );
    assert.equal(sent.length, 3, "three tries at the first piece, none at the other seven");
  }
});

test("a piece the provider rejects becomes a marked gap, not a failed upload", async () => {
  const { split } = fakeSplit(3);
  const attempts = new Map();
  const result = await transcribeOpenRouterChunks({
    inputPath: "in",
    split,
    ...noWait,
    transcribeChunk: async (piece) => {
      attempts.set(pieceName(piece), (attempts.get(pieceName(piece)) ?? 0) + 1);
      if (pieceName(piece) === "chunk-001") throw httpError(400, "Audio file could not be decoded");
      return { text: pieceName(piece) };
    },
  });
  assert.equal(result.text, "chunk-000 [missing audio 4:00-8:00] chunk-002");
  assert.deepEqual([result.failedChunks, result.totalChunks], [1, 3]);
  assert.equal(attempts.get("chunk-001"), 1, "a rejection is not retried");
});

test("when the model rejects every piece, the user sees the provider's reason", async () => {
  const { split } = fakeSplit(3);
  await assert.rejects(
    transcribeOpenRouterChunks({
      inputPath: "in",
      split,
      ...noWait,
      transcribeChunk: async () => {
        throw httpError(400, "The selected model does not support large audio inputs");
      },
    }),
    /does not support large audio inputs/
  );
});

test("silence is not lost audio, and an all-silent upload says so", async () => {
  const mixed = await transcribeOpenRouterChunks({
    inputPath: "in",
    split: fakeSplit(3).split,
    transcribeChunk: async (piece) => ({ text: pieceName(piece) === "chunk-001" ? " " : "words" }),
  });
  assert.equal(mixed.text, "words words");
  assert.equal(mixed.warning, undefined);

  await assert.rejects(
    transcribeOpenRouterChunks({
      inputPath: "in",
      split: fakeSplit(2).split,
      transcribeChunk: async () => ({ text: "" }),
    }),
    { code: "NO_SPEECH_DETECTED" }
  );
});

test("losing more than half the audio fails the upload", async () => {
  await assert.rejects(
    transcribeOpenRouterChunks({
      inputPath: "in",
      split: fakeSplit(3).split,
      ...noWait,
      transcribeChunk: async (piece) => {
        if (pieceName(piece) !== "chunk-000") throw httpError(502);
        return { text: "only this" };
      },
    }),
    { code: "CHUNK_LOSS_EXCEEDED" }
  );
});

test("a sliver ffmpeg leaves at the end is not sent", async () => {
  // A length that is an exact multiple of the piece leaves a ~0.05 s tail.
  const { split } = fakeSplit(3, { durationSeconds: 2 * OPENROUTER_CHUNK_SECONDS + 0.05 });
  const sent = [];
  const result = await transcribeOpenRouterChunks({
    inputPath: "in",
    split,
    transcribeChunk: async (piece) => {
      sent.push(pieceName(piece));
      return { text: pieceName(piece) };
    },
  });
  assert.deepEqual(sent, ["chunk-000", "chunk-001"]);
  assert.equal(result.warning, undefined);

  // Without a known length nothing is dropped.
  const all = [];
  await transcribeOpenRouterChunks({
    inputPath: "in",
    split: fakeSplit(3, { durationSeconds: null }).split,
    transcribeChunk: async (piece) => {
      all.push(piece);
      return { text: "x" };
    },
  });
  assert.equal(all.length, 3);
});

test("cancelling stops at the piece in flight and cleans up", async () => {
  const { split, calls } = fakeSplit(8);
  const controller = new AbortController();
  const sent = [];
  const job = transcribeOpenRouterChunks({
    inputPath: "in",
    split,
    signal: controller.signal,
    transcribeChunk: (piece, signal) =>
      new Promise((_resolve, reject) => {
        sent.push(piece);
        signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("Aborted"), { name: "AbortError" }))
        );
      }),
  });
  await until(() => sent.length === 1);
  controller.abort();
  await assert.rejects(job, { name: "AbortError" });
  assert.equal(sent.length, 1);
  assert.equal(calls[0].options.signal, controller.signal, "a cancel also stops ffmpeg mid-split");
  assert.equal(fs.existsSync(calls[0].outputDir), false);
});
