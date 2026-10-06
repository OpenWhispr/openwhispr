const test = require("node:test");
const assert = require("node:assert/strict");

const {
  timestampRequestFields,
  mapVerboseSegments,
} = require("../../src/helpers/uploadTimestamps");

test("timestamp fields are requested only from providers/models that accept them", () => {
  assert.deepEqual(timestampRequestFields("openai", "whisper-1"), {
    response_format: "verbose_json",
  });
  assert.deepEqual(timestampRequestFields("groq", "whisper-large-v3"), {
    response_format: "verbose_json",
  });
  assert.deepEqual(timestampRequestFields("groq", "whisper-large-v3-turbo"), {
    response_format: "verbose_json",
  });
  assert.deepEqual(timestampRequestFields("mistral", "voxtral-mini-latest"), {
    timestamp_granularities: "segment",
  });

  // gpt-4o transcribe models reject verbose_json outright.
  assert.equal(timestampRequestFields("openai", "gpt-4o-transcribe"), null);
  assert.equal(timestampRequestFields("openai", "gpt-4o-mini-transcribe"), null);

  // Everything else fails safe to a plain-text request: a custom or
  // self-hosted server may 400 on fields it doesn't know.
  assert.equal(timestampRequestFields("custom", "whisper-1"), null);
  assert.equal(timestampRequestFields("self-hosted", "whisper-large-v3"), null);
  assert.equal(timestampRequestFields("xai", "grok-stt"), null);
  assert.equal(timestampRequestFields(undefined, undefined), null);
});

test("verbose segments map to {text, start, end}", () => {
  assert.deepEqual(
    mapVerboseSegments({
      text: "Hello world. Goodbye.",
      segments: [
        { id: 0, seek: 0, start: 0, end: 4.2, text: " Hello world." },
        { id: 1, seek: 400, start: 4.2, end: 7.5, text: " Goodbye." },
      ],
    }),
    [
      { text: "Hello world.", start: 0, end: 4.2 },
      { text: "Goodbye.", start: 4.2, end: 7.5 },
    ]
  );
});

test("malformed verbose segments are dropped, never thrown", () => {
  const mapped = mapVerboseSegments({
    segments: [
      { start: 0, end: 1, text: "   " },
      { start: NaN, end: 2, text: "no start" },
      { start: "1", end: 2, text: "string start" },
      { end: 2, text: "missing start" },
      null,
      { start: 3, end: "x", text: "bad end falls back to start" },
      { start: 5, text: "missing end falls back to start" },
    ],
  });

  assert.deepEqual(mapped, [
    { text: "bad end falls back to start", start: 3, end: 3 },
    { text: "missing end falls back to start", start: 5, end: 5 },
  ]);
});

test("verbose segments clamp negative start timestamps and inverted end timestamps", () => {
  const mapped = mapVerboseSegments({
    segments: [
      { start: -2.5, end: 3, text: "negative start clamped" },
      { start: 6, end: 2, text: "inverted end clamped" },
    ],
  });

  assert.deepEqual(mapped, [
    { text: "negative start clamped", start: 0, end: 3 },
    { text: "inverted end clamped", start: 6, end: 6 },
  ]);
});

test("responses without usable segments map to null", () => {
  assert.equal(mapVerboseSegments({ text: "plain json response" }), null);
  assert.equal(mapVerboseSegments({ segments: "not-an-array" }), null);
  assert.equal(mapVerboseSegments({ segments: [] }), null);
  assert.equal(mapVerboseSegments({ segments: [{ start: NaN, text: "" }] }), null);
  assert.equal(mapVerboseSegments(null), null);
  assert.equal(mapVerboseSegments(undefined), null);
});
