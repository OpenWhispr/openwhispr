const test = require("node:test");
const assert = require("node:assert/strict");
const {
  transcribeWithElevenLabs,
  groupWordsIntoSegments,
  sanitizeKeyterms,
} = require("../../src/helpers/elevenLabsTranscription");
const {
  ELEVENLABS_KEYTERM_REFUSALS,
  ELEVENLABS_AUDIO_TOO_SHORT,
  ELEVENLABS_BAD_AUDIO,
} = require("./harness/elevenLabsAnswers");

const AUDIO = Buffer.from("fake-audio-bytes");

function makeFetch(status, body) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return { fetchImpl, calls };
}

test("posts multipart audio with the xi-api-key header to the Scribe endpoint", async () => {
  const { fetchImpl, calls } = makeFetch(200, { text: "hello", language_code: "eng" });

  const result = await transcribeWithElevenLabs(
    {
      audioBuffer: AUDIO,
      model: "scribe_v2",
      fileName: "memo.mp3",
      contentType: "audio/mpeg",
      language: "de",
      apiKey: "k1",
    },
    fetchImpl
  );

  assert.equal(calls[0].url, "https://api.elevenlabs.io/v1/speech-to-text");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(calls[0].init.headers, { "xi-api-key": "k1" });
  assert.equal(calls[0].init.redirect, "error", "a redirect must never take the key elsewhere");
  const form = calls[0].init.body;
  assert.equal(form.get("model_id"), "scribe_v2");
  assert.equal(form.get("language_code"), "de");
  assert.equal(form.get("tag_audio_events"), "false", "sound tags must never reach the caret");
  assert.equal(form.get("timestamps_granularity"), "none");
  const file = form.get("file");
  assert.equal(file.name, "memo.mp3");
  assert.equal(file.type, "audio/mpeg");
  assert.equal(Buffer.from(await file.arrayBuffer()).toString(), "fake-audio-bytes");
  assert.deepEqual(result, { text: "hello", model: "scribe_v2", acceptedKeyterms: [] });
});

test("auto language sends no language_code, and the model defaults to scribe_v3", async () => {
  const { fetchImpl, calls } = makeFetch(200, { text: "ok" });

  await transcribeWithElevenLabs({ audioBuffer: AUDIO, language: "auto", apiKey: "k" }, fetchImpl);

  const form = calls[0].init.body;
  assert.equal(form.has("language_code"), false);
  assert.equal(form.get("model_id"), "scribe_v3");
  assert.equal(form.get("file").name, "audio.webm");
  assert.equal(form.has("keyterms"), false, "no dictionary means no keyterms surcharge");
});

test("dictionary words go out as repeated keyterms parts after sanitising", async () => {
  const { fetchImpl, calls } = makeFetch(200, { text: "ok" });

  const result = await transcribeWithElevenLabs(
    { audioBuffer: AUDIO, keyterms: ["OpenWhispr", " Kubernetes  cluster ", "{tag}"], apiKey: "k" },
    fetchImpl
  );

  assert.deepEqual(result.acceptedKeyterms, ["OpenWhispr", "Kubernetes cluster"]);
  assert.deepEqual(calls[0].init.body.getAll("keyterms"), result.acceptedKeyterms);
});

test("sanitizeKeyterms drops terms ElevenLabs would reject the whole request for", () => {
  assert.deepEqual(
    sanitizeKeyterms([
      "ok",
      "OK",
      "x".repeat(51),
      "one two three four five six",
      "a <tag>",
      "{brace}",
      "back\\slash",
      "",
      42,
      "  spaced   out  ",
    ]),
    ["ok", "spaced out"]
  );
  assert.deepEqual(sanitizeKeyterms(undefined), []);
  assert.equal(sanitizeKeyterms(Array.from({ length: 150 }, (_, i) => `term${i}`)).length, 100);
});

test("keyterms can contain exactly 50 Unicode characters", () => {
  const boundary = "𠮷".repeat(50);
  assert.deepEqual(sanitizeKeyterms([boundary, boundary + "a", "x".repeat(50)]), [
    boundary,
    "x".repeat(50),
  ]);
});

test("keyterms holding a control character ElevenLabs refuses are dropped", () => {
  const terms = Array.from({ length: 0x20 }, (_, code) => `Open${String.fromCharCode(code)}Whispr`);
  // U+0009 to U+000D are whitespace, and to ElevenLabs so are U+001C to U+001F.
  assert.deepEqual(sanitizeKeyterms(terms), ["Open Whispr"]);
  // U+0085 too, though \s matches none of the five: ElevenLabs refused six letters joined
  // by one as holding five spaces, and a term of nothing else as empty.
  for (const space of "\u001c\u001d\u001e\u001f\u0085") {
    assert.deepEqual(
      sanitizeKeyterms([[..."abcdef"].join(space), space, `${space}Open${space}Whispr${space}`]),
      ["Open Whispr"]
    );
  }
});

test("a missing key fails before any request", async () => {
  const { fetchImpl, calls } = makeFetch(200, { text: "never" });
  await assert.rejects(
    transcribeWithElevenLabs({ audioBuffer: AUDIO, apiKey: "  " }, fetchImpl),
    (error) => error.code === "API_KEY_MISSING"
  );
  assert.equal(calls.length, 0);
});

test("a refused key is an auth failure; an exhausted quota is not", async () => {
  const invalid = makeFetch(401, {
    detail: { type: "authentication_error", status: "invalid_api_key", message: "Invalid API key" },
  });
  await assert.rejects(
    transcribeWithElevenLabs({ audioBuffer: AUDIO, apiKey: "bad" }, invalid.fetchImpl),
    (error) => error.code === "PROVIDER_AUTH_FAILED" && error.settingsTarget === "speechToText"
  );

  const quota = makeFetch(401, {
    detail: { status: "quota_exceeded", message: "This request exceeds your quota." },
  });
  await assert.rejects(
    transcribeWithElevenLabs({ audioBuffer: AUDIO, apiKey: "k" }, quota.fetchImpl),
    (error) => error.code === "PROVIDER_QUOTA_EXHAUSTED"
  );

  const restricted = makeFetch(401, {
    detail: { status: "missing_permissions", message: "The API key is missing a permission." },
  });
  await assert.rejects(
    transcribeWithElevenLabs({ audioBuffer: AUDIO, apiKey: "k" }, restricted.fetchImpl),
    (error) => error.code === "PROVIDER_ACCESS_DENIED"
  );
});

test("an interrupted HTTP error body preserves rate limiting and the provider request ID", async () => {
  const body = new ReadableStream({
    start(stream) {
      stream.error(new TypeError("terminated"));
    },
  });
  const response = new Response(body, { status: 429, headers: { "x-request-id": "scribe-429" } });
  await assert.rejects(
    transcribeWithElevenLabs({ audioBuffer: AUDIO, apiKey: "k" }, async () => response),
    {
      code: "PROVIDER_RATE_LIMITED",
      status: 429,
      technicalDetails: { provider: "ElevenLabs", status: 429, requestId: "scribe-429" },
    }
  );
});

test("cancelling while reading an HTTP error body preserves the abort reason", async () => {
  const controller = new AbortController();
  await assert.rejects(
    transcribeWithElevenLabs(
      { audioBuffer: AUDIO, apiKey: "k", signal: controller.signal },
      async () => ({
        ok: false,
        status: 429,
        text: async () => {
          controller.abort();
          throw new TypeError("terminated");
        },
      })
    ),
    (error) => error === controller.signal.reason
  );
});

// The validation error ElevenLabs documents. It has not been seen to send one.
test("a 422 validation error is a bad request", async () => {
  const { fetchImpl, calls } = makeFetch(422, {
    detail: [{ loc: ["body", "file"], msg: "invalid audio" }],
  });
  await assert.rejects(
    transcribeWithElevenLabs(
      { audioBuffer: AUDIO, keyterms: ["OpenWhispr"], apiKey: "k" },
      fetchImpl
    ),
    (error) => error.code === "PROVIDER_BAD_REQUEST"
  );
  assert.equal(calls.length, 1, "a refusal over the file is not retried");
});

test("an empty or pause transcript represents silence", async () => {
  for (const text of ["", "  ", " [pause] "]) {
    const result = await transcribeWithElevenLabs({ audioBuffer: AUDIO, apiKey: "k" }, async () =>
      Response.json({ text })
    );
    assert.equal(result.text, "");
  }
});

test("a spoken pause marker inside a sentence remains literal", async () => {
  const result = await transcribeWithElevenLabs({ audioBuffer: AUDIO, apiKey: "k" }, async () =>
    Response.json({ text: "press [pause] now" })
  );
  assert.equal(result.text, "press [pause] now");
});

test("a recording too short for ElevenLabs represents silence as well", async (t) => {
  const debugLogger = require("../../src/helpers/debugLogger");
  const logged = [];
  t.mock.method(debugLogger, "debug", (message, meta) => logged.push({ message, meta }));
  const { fetchImpl, calls } = makeFetch(400, ELEVENLABS_AUDIO_TOO_SHORT);
  const result = await transcribeWithElevenLabs(
    { audioBuffer: AUDIO, keyterms: ["OpenWhispr"], apiKey: "k" },
    fetchImpl
  );
  // The whole request was refused, so its keyterm was not accepted.
  assert.deepEqual(result, { text: "", model: "scribe_v3", acceptedKeyterms: [] });
  assert.equal(calls.length, 1);
  // An empty transcript logs nothing more, so only this line shows that ElevenLabs refused.
  assert.deepEqual(logged.at(-1), {
    message: "ElevenLabs refused the recording as too short",
    meta: { status: 400, audioBytes: AUDIO.length },
  });
});

test("malformed successful responses surface a provider error", async () => {
  for (const response of [new Response("<html>"), Response.json({}), Response.json({ text: 0 })]) {
    await assert.rejects(
      transcribeWithElevenLabs({ audioBuffer: AUDIO, apiKey: "k" }, async () => response),
      { code: "PROVIDER_ERROR" }
    );
  }
});

test("a failed or cancelled response read keeps the original error", async () => {
  for (const error of [
    new TypeError("network error"),
    new DOMException("Cancelled", "AbortError"),
  ]) {
    await assert.rejects(
      transcribeWithElevenLabs({ audioBuffer: AUDIO, apiKey: "k" }, async () => ({
        ok: true,
        json: async () => {
          throw error;
        },
      })),
      (actual) => actual === error
    );
  }
});

test("Tagalog goes out under the Filipino code ElevenLabs lists", async () => {
  const { fetchImpl, calls } = makeFetch(200, { text: "ok" });
  await transcribeWithElevenLabs({ audioBuffer: AUDIO, language: "tl", apiKey: "k" }, fetchImpl);
  assert.equal(calls[0].init.body.get("language_code"), "fil");
});

test("a request refused over its keyterms goes again without them", async () => {
  for (const [status, refusal] of [
    ...ELEVENLABS_KEYTERM_REFUSALS.map((answer) => [400, answer]),
    // The validation error ElevenLabs documents, which names the request's own field. It
    // has not been seen to send one.
    [422, { detail: [{ loc: ["body", "keyterms", 0], msg: "too many words" }] }],
  ]) {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push(init.body.getAll("keyterms"));
      const refused = calls.length === 1;
      const body = refused ? refusal : { text: "hello" };
      return {
        ok: !refused,
        status: refused ? status : 200,
        headers: new Headers(),
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    };

    const result = await transcribeWithElevenLabs(
      { audioBuffer: AUDIO, keyterms: ["state-of-the-art"], apiKey: "k" },
      fetchImpl
    );

    assert.equal(result.text, "hello", JSON.stringify(refusal));
    assert.deepEqual(calls, [["state-of-the-art"], []]);
    assert.deepEqual(result.acceptedKeyterms, []);
  }
});

test("a refusal that isn't about keyterms is not retried", async () => {
  const other = makeFetch(400, ELEVENLABS_BAD_AUDIO);
  await assert.rejects(
    transcribeWithElevenLabs(
      { audioBuffer: AUDIO, keyterms: ["OpenWhispr"], apiKey: "k" },
      other.fetchImpl
    ),
    (error) => error.code === "PROVIDER_BAD_REQUEST"
  );
  assert.equal(other.calls.length, 1);

  const noTerms = makeFetch(400, ELEVENLABS_KEYTERM_REFUSALS[0]);
  await assert.rejects(
    transcribeWithElevenLabs({ audioBuffer: AUDIO, apiKey: "k" }, noTerms.fetchImpl)
  );
  assert.equal(noTerms.calls.length, 1);
});

test("unrelated errors mentioning keywords do not upload the recording twice", async () => {
  for (const [status, body] of [
    [400, '<html><head><meta name="keywords" content="gateway"></head></html>'],
    [400, JSON.stringify({ detail: { param: "file", message: "Invalid file keywords.wav" } })],
    [422, JSON.stringify({ detail: [{ loc: ["body", "file"], input: "keyterms" }] })],
  ]) {
    let uploads = 0;
    await assert.rejects(
      transcribeWithElevenLabs(
        { audioBuffer: AUDIO, keyterms: ["OpenWhispr"], apiKey: "k" },
        async () => {
          uploads++;
          return new Response(body, { status });
        }
      ),
      { code: "PROVIDER_BAD_REQUEST" }
    );
    assert.equal(uploads, 1);
  }
});

test("cancelling during a keyterm rejection prevents the second audio upload", async () => {
  const controller = new AbortController();
  let uploads = 0;
  await assert.rejects(
    transcribeWithElevenLabs(
      { audioBuffer: AUDIO, keyterms: ["OpenWhispr"], apiKey: "k", signal: controller.signal },
      async () => {
        uploads++;
        controller.abort();
        return Response.json(ELEVENLABS_KEYTERM_REFUSALS[0], { status: 400 });
      }
    ),
    { name: "AbortError" }
  );
  assert.equal(uploads, 1);
});

test("the ElevenLabs canary fails when the successful request omitted its keyterm", async () => {
  const { probeElevenLabsBatch } = await import("../../scripts/lib/elevenlabs-batch-probe.mjs");
  const hintLists = [];
  const rejected = await probeElevenLabsBatch("test-key", AUDIO, async (_url, request) => {
    const terms = request.body.getAll("keyterms");
    hintLists.push(terms);
    return terms.length
      ? Response.json(ELEVENLABS_KEYTERM_REFUSALS[0], { status: 400 })
      : Response.json({ text: "" });
  });
  assert.deepEqual(hintLists, [["OpenWhispr"], []]);
  assert.equal(rejected.ok, false);
  assert.match(rejected.detail, /keyterm/i);

  const accepted = await probeElevenLabsBatch("test-key", AUDIO, async () =>
    Response.json({ text: "[pause]" })
  );
  assert.equal(accepted.ok, true);
});

const word = (text, start, end, speaker_id) => ({ text, type: "word", start, end, speaker_id });
const SPACE = { text: " ", type: "spacing" };

test("speaker labels and word times are requested only when asked for, and come back as segments", async () => {
  const words = [word("Hello", 0, 0.4, "speaker_0")];
  const segments = [{ text: "Hello", start: 0, end: 0.4, speaker: "speaker_0" }];
  const { fetchImpl, calls } = makeFetch(200, { text: "Hello", words });

  const timed = await transcribeWithElevenLabs(
    { audioBuffer: AUDIO, timestamps: true, apiKey: "k" },
    fetchImpl
  );
  assert.equal(calls[0].init.body.has("timestamps_granularity"), false);
  assert.equal(calls[0].init.body.has("diarize"), false);
  assert.deepEqual(timed.segments, segments);

  const labelled = await transcribeWithElevenLabs(
    { audioBuffer: AUDIO, diarize: true, apiKey: "k" },
    fetchImpl
  );
  assert.equal(calls[1].init.body.get("diarize"), "true");
  assert.equal(calls[1].init.body.has("timestamps_granularity"), false);
  assert.deepEqual(labelled.segments, segments);

  // A reply without words gives none, so the upload keeps its text.
  const bare = await transcribeWithElevenLabs(
    { audioBuffer: AUDIO, timestamps: true, apiKey: "k" },
    makeFetch(200, { text: "Hello" }).fetchImpl
  );
  assert.equal("segments" in bare, false);
});

test("the request that goes again without keyterms still asks for speaker labels", async () => {
  const forms = [];
  const fetchImpl = async (_url, init) => {
    forms.push(init.body);
    return forms.length === 1
      ? Response.json(ELEVENLABS_KEYTERM_REFUSALS[0], { status: 400 })
      : Response.json({ text: "hello" });
  };

  await transcribeWithElevenLabs(
    { audioBuffer: AUDIO, keyterms: ["OpenWhispr"], diarize: true, apiKey: "k" },
    fetchImpl
  );

  assert.equal(forms.length, 2);
  for (const form of forms) {
    assert.equal(form.get("diarize"), "true");
    assert.equal(form.has("timestamps_granularity"), false);
  }
});

test("words group into one segment per speaker turn", () => {
  const turns = [
    word("Hello", 0, 0.4, "speaker_0"),
    SPACE,
    word("there.", 0.4, 0.9, "speaker_0"),
    SPACE,
    word("Hi!", 1, 1.3, "speaker_1"),
    SPACE,
    word("Bye.", 1.4, 1.8, "speaker_0"),
  ];
  assert.deepEqual(groupWordsIntoSegments(turns), [
    { text: "Hello there.", start: 0, end: 0.9, speaker: "speaker_0" },
    { text: "Hi!", start: 1, end: 1.3, speaker: "speaker_1" },
    { text: "Bye.", start: 1.4, end: 1.8, speaker: "speaker_0" },
  ]);

  // A word that names no speaker, among words that do, stays with the speaker before it.
  const partial = turns.map((item) =>
    item.text === "there." ? { ...item, speaker_id: null } : item
  );
  assert.deepEqual(groupWordsIntoSegments(partial), groupWordsIntoSegments(turns));

  // Words that name no speaker stay together, and no speaker is invented for them.
  const unlabelled = turns.map((item) => ({ ...item, speaker_id: null }));
  assert.deepEqual(groupWordsIntoSegments(unlabelled), [
    { text: "Hello there. Hi! Bye.", start: 0, end: 1.8 },
  ]);
});

// The transcript text has arrived by then, so a malformed item only costs its own timing.
test("an item without text is left out, and never fails the upload", () => {
  assert.deepEqual(
    groupWordsIntoSegments([
      word("Hello", 0, 0.4),
      null,
      { type: "spacing" },
      { type: "word", start: 0.4, end: 0.5 },
      SPACE,
      word("there.", 0.5, 0.9),
    ]),
    [{ text: "Hello there.", start: 0, end: 0.9 }]
  );
});

test("a pause over one second starts a new segment", () => {
  assert.deepEqual(
    groupWordsIntoSegments([
      word("One.", 0, 1),
      SPACE,
      word("Two.", 2, 2.4),
      SPACE,
      word("Three.", 3.5, 4),
    ]),
    [
      { text: "One. Two.", start: 0, end: 2.4 },
      { text: "Three.", start: 3.5, end: 4 },
    ]
  );
});

// Live, a 36.8 s monologue came back with 0.30 to 0.36 s between its sentences, so no
// pause ended a segment.
test("past twenty seconds a segment ends with its sentence, and at thirty at the latest", () => {
  // One word a second, with a sentence ending at 8, 20 and 22 seconds.
  const sentenceEnds = new Set([7, 19, 21]);
  const spoken = (mark) =>
    Array.from({ length: 35 }, (_, i) => [
      word(`w${i}${sentenceEnds.has(i) ? mark : ""}`, i, i + 1),
      SPACE,
    ]).flat();
  const spans = (words) => groupWordsIntoSegments(words).map(({ start, end }) => [start, end]);

  // A sentence mark of any script, alone or with the quote or bracket that closes after it.
  for (const mark of [".", "!", "?", "。", "！", "？", "।", "؟", "…", '."', "?”", ".)", "。」"]) {
    // Not at 8 or 20 seconds: the segment is not yet longer than twenty.
    assert.deepEqual(
      spans(spoken(mark)),
      [
        [0, 22],
        [22, 35],
      ],
      mark
    );
  }
  // A comma ends no sentence, so the turn runs to the cap.
  assert.deepEqual(spans(spoken(",")), [
    [0, 30],
    [30, 35],
  ]);
});

// buildUploadTranscript stores the whole note untimed when one segment has no finite start.
test("a word without times takes the previous word's end", () => {
  assert.deepEqual(
    groupWordsIntoSegments([
      word("One.", 0, 1, "speaker_0"),
      { text: "Two.", type: "word", speaker_id: "speaker_1" },
      SPACE,
      // With a start and no end, a word ends where it starts.
      { text: "Three.", type: "word", start: 4, speaker_id: "speaker_1" },
    ]),
    [
      { text: "One.", start: 0, end: 1, speaker: "speaker_0" },
      { text: "Two.", start: 1, end: 1, speaker: "speaker_1" },
      { text: "Three.", start: 4, end: 4, speaker: "speaker_1" },
    ]
  );
});
