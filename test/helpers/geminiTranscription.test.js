const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");

const geminiModulePath = require.resolve("../../src/helpers/geminiTranscription");
const originalLoad = Module._load;

const fetches = [];
let fetchResponse = () => ({
  ok: true,
  status: 200,
  json: async () => ({
    candidates: [{ content: { parts: [{ text: "  hello world  " }] } }],
  }),
  text: async () => "",
});

const convertCalls = [];

// convertToWav is mocked so the test never needs the bundled ffmpeg binary; it
// writes a marker wav so the helper's read-and-base64 step is still exercised.
Module._load = function loadWithMocks(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getPath: () => require("node:os").tmpdir(),
        getName: () => "test",
        getVersion: () => "0.0.0",
        isPackaged: false,
        on: () => {},
      },
      net: {
        fetch: async (url, init) => {
          fetches.push({ url: String(url), init });
          return fetchResponse(String(url), init);
        },
      },
    };
  }
  if (parent?.filename === geminiModulePath && request === "./ffmpegUtils") {
    return {
      convertToWav: async (inputPath, outputPath, options) => {
        convertCalls.push({ input: fs.readFileSync(inputPath), options });
        fs.writeFileSync(outputPath, Buffer.from("RIFF-fake-wav"));
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

delete require.cache[geminiModulePath];
const { transcribeAudio, DEFAULT_GEMINI_TRANSCRIPTION_MODEL } = require(geminiModulePath);

test.after(() => {
  Module._load = originalLoad;
});

test("gemini: posts converted wav as inlineData to generateContent with x-goog-api-key", async () => {
  fetches.length = 0;
  convertCalls.length = 0;

  const result = await transcribeAudio({
    audioBuffer: Buffer.from([1, 2, 3]),
    model: "gemini-2.5-flash-lite",
    language: "es",
    prompt: "OpenWhispr, Zellij",
    apiKey: "gk-gemini",
  });

  assert.equal(result.text, "hello world", "candidate text is trimmed");
  assert.equal(result.model, "gemini-2.5-flash-lite");

  assert.equal(convertCalls.length, 1, "audio is converted before upload");
  assert.deepEqual(convertCalls[0].input, Buffer.from([1, 2, 3]));
  assert.deepEqual(convertCalls[0].options, { sampleRate: 16000, channels: 1, codec: "libopus", bitrate: "24k" });

  assert.equal(fetches.length, 1);
  assert.equal(
    fetches[0].url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent"
  );
  assert.equal(fetches[0].init.method, "POST");
  assert.equal(fetches[0].init.headers["x-goog-api-key"], "gk-gemini");
  assert.equal(fetches[0].init.headers["Content-Type"], "application/json");

  const body = JSON.parse(fetches[0].init.body);
  const parts = body.contents[0].parts;
  assert.equal(parts.length, 2);
  assert.match(parts[0].text, /verbatim/i, "instruction demands a verbatim transcript");
  assert.match(parts[0].text, /"es"/, "language hint rides the instruction");
  assert.match(parts[0].text, /OpenWhispr, Zellij/, "dictionary terms ride the instruction");
  assert.equal(parts[1].inlineData.mimeType, "audio/ogg");
  assert.equal(parts[1].inlineData.data, Buffer.from("RIFF-fake-wav").toString("base64"));
  assert.ok(!result.alreadyCleaned, "plain transcription is not marked cleaned");
});

test("gemini: a cleanupPrompt fuses cleanup into the instruction and marks the result cleaned", async () => {
  fetches.length = 0;

  const cleanupPrompt =
    "You are a transcript cleanup engine. Fix punctuation.\n\n" +
    "Custom Dictionary (use these exact spellings when they appear in the text): OpenWhispr, Zellij";
  const result = await transcribeAudio({
    audioBuffer: Buffer.from([1, 2, 3]),
    model: "gemini-3-flash-preview",
    language: "es",
    prompt: "OpenWhispr, Zellij",
    cleanupPrompt,
    apiKey: "gk-gemini",
  });

  assert.equal(result.alreadyCleaned, true);

  const instruction = JSON.parse(fetches[0].init.body).contents[0].parts[0].text;
  assert.ok(instruction.startsWith(cleanupPrompt), "cleanup rules lead the instruction");
  assert.doesNotMatch(instruction, /verbatim/i, "the verbatim directive is replaced");
  assert.match(
    instruction,
    /Output ONLY the cleaned transcript text/,
    "output-only directive bridges audio to the cleanup rules"
  );
  assert.match(instruction, /"es"/, "language hint still rides the instruction");
  // The cleanup prompt already carries the dictionary suffix; the separate
  // spellings line must not restate it.
  assert.doesNotMatch(instruction, /Prefer these spellings/);
  const dictionaryMentions = instruction.split("OpenWhispr, Zellij").length - 1;
  assert.equal(dictionaryMentions, 1, "dictionary appears exactly once");
});

test("gemini: defaults the model and omits language/dictionary lines when absent", async () => {
  fetches.length = 0;

  await transcribeAudio({ audioBuffer: Buffer.from([1]), apiKey: "gk-gemini" });

  assert.match(fetches[0].url, new RegExp(`${DEFAULT_GEMINI_TRANSCRIPTION_MODEL}:generateContent$`));
  const body = JSON.parse(fetches[0].init.body);
  assert.doesNotMatch(body.contents[0].parts[0].text, /ISO 639-1/);
  assert.doesNotMatch(body.contents[0].parts[0].text, /spellings/);
});

test("gemini: missing key fails before any conversion or request", async () => {
  fetches.length = 0;
  convertCalls.length = 0;

  await assert.rejects(
    () => transcribeAudio({ audioBuffer: Buffer.from([1]), apiKey: "  " }),
    (err) => err.code === "API_KEY_MISSING"
  );
  assert.equal(fetches.length, 0);
  assert.equal(convertCalls.length, 0);
});

test("gemini: HTTP failures map to the shared coded errors", async () => {
  try {
    fetchResponse = () => ({ ok: false, status: 403, text: async () => "denied" });
    await assert.rejects(
      () => transcribeAudio({ audioBuffer: Buffer.from([1]), apiKey: "gk" }),
      (err) => err.code === "INVALID_KEY"
    );

    fetchResponse = () => ({ ok: false, status: 429, text: async () => "slow down" });
    await assert.rejects(
      () => transcribeAudio({ audioBuffer: Buffer.from([1]), apiKey: "gk" }),
      (err) => err.code === "PROVIDER_RATE_LIMITED"
    );

    fetchResponse = () => ({ ok: false, status: 500, text: async () => "boom" });
    await assert.rejects(
      () => transcribeAudio({ audioBuffer: Buffer.from([1]), apiKey: "gk" }),
      (err) => err.code === "SERVER_ERROR" && /Gemini API Error: 500/.test(err.message)
    );
  } finally {
    fetchResponse = () => ({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
      text: async () => "",
    });
  }
});

test("gemini: an empty candidate yields empty text for the caller's empty-transcript path", async () => {
  fetchResponse = () => ({
    ok: true,
    status: 200,
    json: async () => ({ candidates: [] }),
    text: async () => "",
  });
  const result = await transcribeAudio({ audioBuffer: Buffer.from([1]), apiKey: "gk" });
  assert.equal(result.text, "");
});

test("gemini: a transient 503 is retried once and the retry's transcript is returned", async () => {
  fetches.length = 0;
  let calls = 0;
  fetchResponse = () => {
    calls += 1;
    if (calls === 1) {
      return { ok: false, status: 503, text: async () => "high demand" };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: "recovered" }] } }] }),
      text: async () => "",
    };
  };
  const result = await transcribeAudio({ audioBuffer: Buffer.from([1]), apiKey: "gk" });
  assert.equal(result.text, "recovered", "retry result is used after a 503");
  assert.equal(fetches.length, 2, "exactly one retry after the 503");

  // A second consecutive 503 surfaces as SERVER_ERROR — no retry loop.
  fetches.length = 0;
  fetchResponse = () => ({ ok: false, status: 503, text: async () => "still busy" });
  await assert.rejects(
    () => transcribeAudio({ audioBuffer: Buffer.from([1]), apiKey: "gk" }),
    (err) => err.code === "SERVER_ERROR" && /503/.test(err.message)
  );
  assert.equal(fetches.length, 3, "retry, then one fallback-model attempt, then fail");
  assert.match(fetches[2].url, /gemini-3\.5-flash-lite/, "third attempt hits the sibling model");
});
