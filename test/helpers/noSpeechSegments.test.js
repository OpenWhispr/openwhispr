const test = require("node:test");
const assert = require("node:assert/strict");

const { dropNoSpeechSegments } = require("../../src/helpers/noSpeechSegments");

const speech = (text, extra = {}) => ({
  text,
  start: 0,
  end: 2,
  no_speech_prob: 0.02,
  avg_logprob: -0.21,
  ...extra,
});

test("a trailing no-speech segment is dropped", () => {
  assert.equal(
    dropNoSpeechSegments({
      text: " Send the report to Dana by Friday. Thank you for watching!",
      segments: [
        speech(" Send the report to Dana by Friday."),
        speech(" Thank you for watching!", { no_speech_prob: 0.93, avg_logprob: -1.32 }),
      ],
    }),
    "Send the report to Dana by Friday."
  );
});

test("a leading no-speech segment is dropped", () => {
  assert.equal(
    dropNoSpeechSegments({
      text: " Sous-titres par la communauté. On se voit demain.",
      segments: [
        speech(" Sous-titres par la communauté.", { no_speech_prob: 0.81, avg_logprob: -1.05 }),
        speech(" On se voit demain."),
      ],
    }),
    "On se voit demain."
  );
});

test("quiet speech the decoder was confident in is kept", () => {
  // High no_speech_prob alone is not enough: Whisper keeps the segment when
  // avg_logprob is above the logprob threshold.
  const result = {
    text: " Remind me to call mom.",
    segments: [speech(" Remind me to call mom.", { no_speech_prob: 0.72, avg_logprob: -0.45 })],
  };
  assert.equal(dropNoSpeechSegments(result), result.text);
});

test("low confidence without a no-speech signal is kept", () => {
  const result = {
    text: " Kubernetes ingress annotations.",
    segments: [
      speech(" Kubernetes ingress annotations.", { no_speech_prob: 0.1, avg_logprob: -1.6 }),
    ],
  };
  assert.equal(dropNoSpeechSegments(result), result.text);
});

test("thresholds are Whisper's: no_speech_prob > 0.6 and avg_logprob <= -1.0", () => {
  const drops = (no_speech_prob, avg_logprob) =>
    dropNoSpeechSegments({
      text: " Kept. Maybe.",
      segments: [speech(" Kept."), speech(" Maybe.", { no_speech_prob, avg_logprob })],
    }) === "Kept.";
  assert.equal(drops(0.61, -1.0), true);
  assert.equal(drops(0.6, -1.5), false);
  assert.equal(drops(0.9, -0.99), false);
});

test("nothing dropped returns the provider's text unchanged", () => {
  const result = {
    text: " Hello world. Goodbye.",
    segments: [speech(" Hello world."), speech(" Goodbye.")],
  };
  assert.equal(dropNoSpeechSegments(result), result.text);
});

test("every segment dropped leaves an empty transcript", () => {
  assert.equal(
    dropNoSpeechSegments({
      text: " Thank you for watching!",
      segments: [speech(" Thank you for watching!", { no_speech_prob: 0.97, avg_logprob: -1.2 })],
    }),
    ""
  );
});

test("CJK segments rejoin without inserted spaces", () => {
  assert.equal(
    dropNoSpeechSegments({
      text: "明天开会。请订阅频道",
      segments: [
        speech("明天开会。"),
        speech("请订阅频道", { no_speech_prob: 0.88, avg_logprob: -1.4 }),
      ],
    }),
    "明天开会。"
  );
});

test("missing or unusable segments fall back to the provider's text", () => {
  assert.equal(dropNoSpeechSegments({ text: "plain json response" }), "plain json response");
  assert.equal(dropNoSpeechSegments({ text: "x", segments: [] }), "x");
  assert.equal(dropNoSpeechSegments({ text: "x", segments: "not-an-array" }), "x");
  // No scores on the segment: nothing to judge it by.
  assert.equal(
    dropNoSpeechSegments({ text: " Hi. Bye.", segments: [{ text: " Hi." }, { text: " Bye." }] }),
    " Hi. Bye."
  );
  assert.equal(dropNoSpeechSegments(null), undefined);
});

test("segments that don't cover the whole text are not used to rebuild it", () => {
  const result = {
    text: " First sentence. Second sentence. Thank you.",
    segments: [
      speech(" First sentence."),
      speech(" Thank you.", { no_speech_prob: 0.9, avg_logprob: -1.3 }),
    ],
  };
  assert.equal(dropNoSpeechSegments(result), result.text);
});
