const nodeTest = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { execFileSync } = require("node:child_process");
const { transcribeManagedAudioFile } = require("../../src/helpers/managedAudioFileTranscription");
const { getFFmpegPath } = require("../../src/helpers/ffmpegUtils");
const { silenceWav } = require("../../src/helpers/enterpriseAudioSetup");
const { getSafeTempDir } = require("../../src/helpers/safeTempDir");
const test = getFFmpegPath() ? nodeTest : nodeTest.skip;

function audio(durationSeconds = 3) {
  const buffer = Buffer.alloc(44 + Math.round(24000 * 2 * durationSeconds));
  silenceWav().copy(buffer, 0, 0, 44);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.writeUInt32LE(buffer.length - 44, 40);
  return buffer;
}
const temporaryFiles = () =>
  fs
    .readdirSync(getSafeTempDir())
    .filter((name) => /^enterprise-(buffer|chunks)-/.test(name))
    .sort();

for (const durationSeconds of [3, 3.05]) {
  test(`managed chunks keep a valid final clip for ${durationSeconds}s at an exact split boundary`, async () => {
    const before = temporaryFiles();
    const source = audio(durationSeconds);
    for (let frame = 24000 * 3; frame < (source.length - 44) / 2; frame++) {
      source.writeInt16LE(
        Math.round(12000 * Math.sin((2 * Math.PI * 600 * frame) / 24000)),
        44 + frame * 2
      );
    }
    const decoded = [];
    await transcribeManagedAudioFile({
      audioBuffer: source,
      fileName: "boundary.wav",
      maxUploadBytes: 20000,
      transcribe: async (buffer) => {
        assert.ok(buffer.length <= 20000);
        const pcm = execFileSync(
          getFFmpegPath(),
          ["-v", "error", "-i", "pipe:0", "-ar", "16000", "-ac", "1", "-f", "s16le", "pipe:1"],
          { input: buffer, windowsHide: true }
        );
        assert.ok(pcm.length >= 3200, `Azure rejects a ${pcm.length / 32000}s clip`);
        decoded.push(pcm);
        return `part-${decoded.length}`;
      },
    });
    assert.ok(decoded.length >= 3);
    if (durationSeconds > 3) assert.ok(decoded.at(-1).some((byte) => byte !== 0));
    assert.deepEqual(temporaryFiles(), before);
  });
}

test("oversized managed buffers use real ffmpeg chunks in order and clean temporary audio", async () => {
  const before = temporaryFiles();
  const sizes = [];
  const result = await transcribeManagedAudioFile({
    audioBuffer: audio(),
    fileName: "history.wav",
    maxUploadBytes: 20000,
    transcribe: async (buffer, name, type) => {
      assert.match(name, /\.mp3$/);
      assert.equal(type, "audio/mpeg");
      sizes.push(buffer.length);
      return `part-${sizes.length}`;
    },
  });
  assert.ok(sizes.length >= 3);
  assert.ok(sizes.every((size) => size <= 20000));
  assert.equal(result.text, sizes.map((_, index) => `part-${index + 1}`).join(" "));
  assert.deepEqual(temporaryFiles(), before);
});

test("canceling a managed history buffer stops queued chunks and releases temporary files", async () => {
  const before = temporaryFiles();
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    transcribeManagedAudioFile({
      audioBuffer: audio(),
      fileName: "dictation.wav",
      maxUploadBytes: 20000,
      signal: controller.signal,
      transcribe: async () => {
        calls++;
        controller.abort();
        return "retained";
      },
    }),
    { name: "AbortError" }
  );
  assert.equal(calls, 1);
  assert.deepEqual(temporaryFiles(), before);
});

test("managed chunk failures retain usable text and report the missing chunk", async () => {
  const before = temporaryFiles();
  let index = 0;
  const result = await transcribeManagedAudioFile({
    audioBuffer: audio(),
    fileName: "upload.wav",
    maxUploadBytes: 20000,
    onProgress: (progress) => {
      index = progress.chunksCompleted;
    },
    transcribe: async () => {
      if (index === 1)
        throw Object.assign(new Error("local provider unavailable"), { code: "SERVER_ERROR" });
      return `part-${index}`;
    },
  });
  assert.equal(result.failedChunks, 1);
  assert.match(result.text, /part-0/);
  assert.doesNotMatch(result.text, /part-1/);
  assert.deepEqual(temporaryFiles(), before);
});

test("the IPC job retains its original profile lifetime during preparation and between chunks", async () => {
  const ipcPath = path.join(__dirname, "../../src/helpers/ipcHandlers.js");
  const source = fs.readFileSync(ipcPath, "utf8");
  const start = source.indexOf("const transcribeManagedAudio = async");
  const end = source.indexOf("\n    ipcMain.handle(", start);
  assert.ok(start >= 0 && end > start);
  for (const rotationPoint of ["splitting", "between-chunks"]) {
    const before = temporaryFiles();
    let retirement = new AbortController();
    let submitted = 0;
    const rotate = () => {
      retirement.abort();
      retirement = new AbortController();
    };
    const run = vm.runInNewContext(`${source.slice(start, end)}\ntranscribeManagedAudio;`, {
      require: createRequire(ipcPath),
      AbortSignal,
      resolveEnterpriseRuntime: async () => ({
        enterprise: {
          audioProfile: { signal: retirement.signal, section: { maxUploadBytes: 20000 } },
        },
      }),
      executeManagedTranscription: async () => {
        submitted++;
        rotate();
        return "first chunk";
      },
    });
    await assert.rejects(
      run(
        {},
        { provider: "openai-compatible", context: {} },
        {
          audioBuffer: audio(),
          fileName: "history.wav",
          onProgress: ({ stage }) => {
            if (rotationPoint === "splitting" && stage === "splitting") rotate();
          },
        }
      ),
      { name: "AbortError" }
    );
    assert.equal(submitted, rotationPoint === "splitting" ? 0 : 1);
    assert.deepEqual(temporaryFiles(), before);
  }
});

nodeTest("managed uploads under the size cap report start and completion progress", async () => {
  const directory = fs.mkdtempSync(path.join(getSafeTempDir(), "managed-small-"));
  const filePath = path.join(directory, "upload.mp3");
  fs.writeFileSync(filePath, Buffer.from("small"));
  for (const input of [
    { audioBuffer: Buffer.from("small"), fileName: "dictation.webm" },
    { filePath },
  ]) {
    const progress = [];
    try {
      const result = await transcribeManagedAudioFile({
        ...input,
        maxUploadBytes: 20000,
        onProgress: (event) => progress.push(event),
        transcribe: async () => {
          progress.push("request");
          return "whole file";
        },
      });
      assert.deepEqual(result, { text: "whole file" });
    } finally {
      if (input.filePath) fs.rmSync(directory, { recursive: true, force: true });
    }
    assert.deepEqual(progress, [
      { stage: "transcribing", chunksTotal: 1, chunksCompleted: 0 },
      "request",
      { stage: "transcribing", chunksTotal: 1, chunksCompleted: 1 },
    ]);
  }
});

const networkFailures = () => [
  Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
  Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
  Object.assign(new Error("Enterprise proxy connection failed"), { code: "PROXY_FAILED" }),
  // Electron's net.fetch (legacy Azure) carries no code, only the Chromium error.
  new Error("net::ERR_NETWORK_CHANGED"),
  new Error("net::ERR_INTERNET_DISCONNECTED"),
  new Error("net::ERR_CONNECTION_RESET"),
];
const deadlineFailures = () => [
  Object.assign(new Error("connect timed out"), { code: "ETIMEDOUT" }),
  Object.assign(new Error("Enterprise connection timed out"), { code: "TIMEOUT" }),
  Object.assign(new Error("headers timed out"), { code: "UND_ERR_HEADERS_TIMEOUT" }),
  new DOMException("The operation timed out.", "TimeoutError"),
  Object.assign(new Error("The operation was aborted"), {
    name: "AbortError",
    code: "ABORT_ERR",
    cause: Object.assign(new Error("Enterprise connection timed out"), { code: "TIMEOUT" }),
  }),
  new Error("net::ERR_TIMED_OUT"),
  new Error("net::ERR_CONNECTION_TIMED_OUT"),
];

test("a transient network failure on a late chunk is retried instead of discarding the job", async () => {
  for (const failure of networkFailures()) {
    const before = temporaryFiles();
    let index = 0;
    let failedOnce = false;
    const result = await transcribeManagedAudioFile({
      audioBuffer: audio(),
      fileName: "upload.wav",
      maxUploadBytes: 20000,
      onProgress: (progress) => {
        index = progress.chunksCompleted;
      },
      transcribe: async () => {
        if (index === 2 && !failedOnce) {
          failedOnce = true;
          throw failure;
        }
        return `part-${index}`;
      },
    });
    assert.equal(failedOnce, true);
    assert.equal(result.failedChunks, 0, failure.message);
    assert.match(result.text, /part-0 part-1 part-2/);
    assert.deepEqual(temporaryFiles(), before);
  }
});

test("a chunk that keeps failing on the network keeps the completed chunks", async () => {
  let index = 0;
  const result = await transcribeManagedAudioFile({
    audioBuffer: audio(),
    fileName: "upload.wav",
    maxUploadBytes: 20000,
    onProgress: (progress) => {
      index = progress.chunksCompleted;
    },
    transcribe: async () => {
      if (index === 1)
        throw Object.assign(new Error("Enterprise proxy connection failed"), {
          code: "PROXY_FAILED",
        });
      return `part-${index}`;
    },
  });
  assert.equal(result.failedChunks, 1);
  assert.match(result.text, /part-0/);
  assert.doesNotMatch(result.text, /part-1/);
});

test("configuration, identity and credential refusals still abort the whole chunked job", async () => {
  for (const code of ["MANAGED_CONFIG_CHANGED", "AUTH_CONTEXT_CHANGED", "MANAGED_AUTH_REJECTED"]) {
    const before = temporaryFiles();
    let calls = 0;
    await assert.rejects(
      transcribeManagedAudioFile({
        audioBuffer: audio(),
        fileName: "upload.wav",
        maxUploadBytes: 20000,
        transcribe: async () => {
          calls++;
          if (calls === 2) throw Object.assign(new Error("changed"), { code });
          return "kept";
        },
      }),
      { code }
    );
    assert.equal(calls, 2);
    assert.deepEqual(temporaryFiles(), before);
  }
});

test("certificate, DNS and proxy setup failures abort with the original error", async () => {
  const failures = [
    Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }),
    Object.assign(new Error("unable to verify the first certificate"), {
      code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    }),
    Object.assign(new Error("fetch failed"), {
      cause: Object.assign(new Error("self-signed certificate"), {
        code: "DEPTH_ZERO_SELF_SIGNED_CERT",
      }),
    }),
    Object.assign(new Error("getaddrinfo ENOTFOUND speech.example.com"), { code: "ENOTFOUND" }),
    new Error("net::ERR_CERT_AUTHORITY_INVALID"),
    new Error("net::ERR_NAME_NOT_RESOLVED"),
    new Error("net::ERR_PROXY_CONNECTION_FAILED"),
  ];
  for (const failure of failures) {
    const before = temporaryFiles();
    let calls = 0;
    await assert.rejects(
      transcribeManagedAudioFile({
        audioBuffer: audio(),
        fileName: "upload.wav",
        maxUploadBytes: 20000,
        transcribe: async () => {
          calls++;
          if (calls === 2) throw failure;
          return "kept";
        },
      }),
      (error) => error === failure
    );
    assert.equal(calls, 2, failure.message);
    assert.deepEqual(temporaryFiles(), before);
  }
});

test("a chunk that hits its request deadline is counted as failed without a retry", async () => {
  for (const failure of deadlineFailures()) {
    let index = 0;
    let attempts = 0;
    const result = await transcribeManagedAudioFile({
      audioBuffer: audio(),
      fileName: "upload.wav",
      maxUploadBytes: 20000,
      onProgress: (progress) => {
        index = progress.chunksCompleted;
      },
      transcribe: async () => {
        if (index !== 1) return `part-${index}`;
        attempts++;
        throw failure;
      },
    });
    assert.equal(attempts, 1, failure.message);
    assert.equal(result.failedChunks, 1);
    assert.match(result.text, /part-0 part-2/);
  }
});

test("a chunk the provider refuses or answers badly is skipped and the others are kept", async () => {
  const failures = [
    ...[400, 404, 413, 415, 422].map((status) =>
      Object.assign(new Error(`Enterprise transcription error: ${status}`), {
        status,
        code: "MANAGED_REQUEST_REJECTED",
      })
    ),
    Object.assign(new Error("Managed transcription response was malformed"), {
      code: "MANAGED_RESPONSE_MALFORMED",
    }),
  ];
  for (const failure of failures) {
    let index = 0;
    let attempts = 0;
    const result = await transcribeManagedAudioFile({
      audioBuffer: audio(),
      fileName: "upload.wav",
      maxUploadBytes: 20000,
      onProgress: (progress) => {
        index = progress.chunksCompleted;
      },
      transcribe: async () => {
        if (index !== 1) return `part-${index}`;
        attempts++;
        throw failure;
      },
    });
    assert.equal(attempts, 1, failure.message);
    assert.equal(result.failedChunks, 1);
    assert.match(result.text, /part-0 part-2/);
  }
});

test("losing more than the cloud path's share of chunks fails the job instead of a fragment", async () => {
  const before = temporaryFiles();
  let index = 0;
  await assert.rejects(
    transcribeManagedAudioFile({
      audioBuffer: audio(),
      fileName: "upload.wav",
      maxUploadBytes: 20000,
      onProgress: (progress) => {
        index = progress.chunksCompleted;
      },
      transcribe: async () => {
        if (index === 0) return "part-0";
        throw Object.assign(new Error("Enterprise transcription error: 422"), {
          status: 422,
          code: "MANAGED_REQUEST_REJECTED",
        });
      },
    }),
    {
      code: "CHUNK_LOSS_EXCEEDED",
      messageKey: "hooks.audioRecording.errorDescriptions.chunkLoss",
    }
  );
  assert.deepEqual(temporaryFiles(), before);
});

test("when every chunk fails, the job reports the provider's error instead of a loss count", async () => {
  const before = temporaryFiles();
  const refusal = Object.assign(new Error("Enterprise transcription error: 415"), {
    status: 415,
    code: "MANAGED_REQUEST_REJECTED",
    messageKey: "hooks.audioRecording.errorDescriptions.managedRequestRejected",
  });
  let calls = 0;
  await assert.rejects(
    transcribeManagedAudioFile({
      audioBuffer: audio(),
      fileName: "upload.wav",
      maxUploadBytes: 20000,
      transcribe: async () => {
        calls++;
        throw refusal;
      },
    }),
    (error) => error === refusal
  );
  assert.ok(calls >= 3);
  assert.deepEqual(temporaryFiles(), before);
});
