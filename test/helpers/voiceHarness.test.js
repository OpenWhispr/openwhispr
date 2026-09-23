const test = require("node:test");
const assert = require("node:assert/strict");

const {
  HARNESS_SCENARIOS,
  resampleLinear,
  toFrames,
  scoreTurn,
  percentile,
  summarizeHarness,
  formatHarnessReport,
} = require("../../src/helpers/voiceHarness");

test("every scenario has an id, something to say, and the tools it expects", () => {
  const ids = new Set();
  for (const scenario of HARNESS_SCENARIOS) {
    assert.ok(scenario.id && !ids.has(scenario.id), `unique id ${scenario.id}`);
    ids.add(scenario.id);
    assert.ok(scenario.say.length > 3);
    assert.ok(Array.isArray(scenario.expectTools));
  }
  assert.ok(HARNESS_SCENARIOS.some((scenario) => scenario.bargeIn));
  assert.ok(HARNESS_SCENARIOS.some((scenario) => scenario.expectTools.length === 0));
});

test("resampling 24 kHz to 16 kHz keeps duration and shape", () => {
  const input = Float32Array.from({ length: 2400 }, (_, index) => index / 2400);
  const output = resampleLinear(input, 24000, 16000);
  assert.equal(output.length, 1600);
  assert.ok(Math.abs(output[800] - 0.5) < 0.01);
});

test("frames are fixed-size and the last one is zero-padded", () => {
  const frames = toFrames(Float32Array.from({ length: 1100 }, () => 1), 512);
  assert.equal(frames.length, 3);
  assert.ok(frames.every((frame) => frame.length === 512));
  assert.equal(frames[2][75], 1);
  assert.equal(frames[2][76], 0);
});

test("scoring: expected tool called, no tool when none expected, unavailable tools skip", () => {
  const available = ["web_search", "search_notes"];
  assert.deepEqual(scoreTurn({ expectTools: ["web_search"], calledTools: ["web_search"], availableTools: available }), {
    status: "pass",
  });
  assert.equal(
    scoreTurn({ expectTools: ["web_search"], calledTools: [], availableTools: available }).status,
    "fail"
  );
  assert.equal(scoreTurn({ expectTools: [], calledTools: [], availableTools: available }).status, "pass");
  assert.equal(
    scoreTurn({ expectTools: [], calledTools: ["web_search"], availableTools: available }).status,
    "fail"
  );
  assert.equal(
    scoreTurn({ expectTools: ["get_calendar_events"], calledTools: [], availableTools: available }).status,
    "skipped"
  );
});

test("percentile uses nearest rank and ignores missing values", () => {
  assert.equal(percentile([5, 1, 3, null, 4, 2], 50), 3);
  assert.equal(percentile([5, 1, 3, 4, 2], 90), 5);
  assert.equal(percentile([], 50), null);
});

const result = (overrides) => ({
  id: "x",
  said: "hello",
  heard: "hello",
  expectTools: [],
  calledTools: [],
  availableTools: ["web_search"],
  outcome: "spoke",
  metrics: { speechEndToFirstAudioMs: 1000, transcriptToFirstDeltaMs: 400, firstChunkToFirstAudioMs: 300 },
  answer: "Hi.",
  ...overrides,
});

test("summary counts pass/fail/skip and reports latency percentiles", () => {
  const summary = summarizeHarness([
    result({ id: "a" }),
    result({ id: "b", expectTools: ["web_search"], calledTools: [], metrics: { speechEndToFirstAudioMs: 3000 } }),
    result({ id: "c", expectTools: ["get_calendar_events"] }),
    result({ id: "d", bargeInMs: 250 }),
  ]);
  assert.equal(summary.passed, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.firstAudio.p50, 1000);
  assert.equal(summary.firstAudio.p90, 3000);
  assert.equal(summary.bargeIn.p90, 250);
  assert.deepEqual(summary.failures, ["b"]);
});

test("the report names the machine, the headline numbers and each scenario", () => {
  const results = [result({ id: "weather", said: "Weather in Tokyo?", calledTools: ["web_search"], expectTools: ["web_search"] })];
  const report = formatHarnessReport({
    results,
    summary: summarizeHarness(results),
    environment: { machine: "Apple M5 Pro", memoryGb: 48, brain: "qwen3.5-9b", tts: "pocket" },
  });
  assert.match(report, /Apple M5 Pro/);
  assert.match(report, /First audio/);
  assert.match(report, /\| weather \|/);
  assert.match(report, /web_search/);
});
