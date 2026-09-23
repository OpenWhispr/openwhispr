const test = require("node:test");
const assert = require("node:assert/strict");

const { createTurnEndpointer, createSampleRing } = require("../../src/helpers/voiceTurnEndpointer");

const RATE = 16000;
const ms = (value) => (value * RATE) / 1000;
const segment = (startMs, lengthMs, fill = 0.1) => ({
  startSample: ms(startMs),
  samples: new Float32Array(ms(lengthMs)).fill(fill),
});

test("silence-only mode commits every VAD segment as its own turn", () => {
  const endpointer = createTurnEndpointer({ smartTurn: false });
  const actions = endpointer.onSegment({ ...segment(1000, 800), nowSample: ms(2300) });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, "commit");
  assert.equal(actions[0].reason, "silence");
  assert.equal(actions[0].samples.length, ms(800));
  assert.equal(actions[0].speechEndSample, ms(1800));
});

test("smart mode asks the classifier about the turn so far on each short pause", () => {
  const endpointer = createTurnEndpointer({ smartTurn: true, preRollMs: 500 });
  const actions = endpointer.onSegment({ ...segment(1000, 800), nowSample: ms(2000) });
  assert.deepEqual(actions, [
    { type: "classify", requestId: 1, fromSample: ms(500), toSample: ms(2000) },
  ]);
});

test("the classifier window never starts before sample 0 or reaches back more than 8 s", () => {
  const early = createTurnEndpointer({ smartTurn: true, preRollMs: 500 });
  assert.equal(early.onSegment({ ...segment(100, 500), nowSample: ms(800) })[0].fromSample, 0);

  const long = createTurnEndpointer({ smartTurn: true, preRollMs: 500 });
  const [action] = long.onSegment({ ...segment(1000, 12000), nowSample: ms(13200) });
  assert.equal(action.fromSample, ms(13200) - ms(8000));
});

test("a complete prediction commits the turn with every segment joined", () => {
  const endpointer = createTurnEndpointer({ smartTurn: true });
  const first = endpointer.onSegment({ ...segment(1000, 800, 0.1), nowSample: ms(2000) })[0];
  assert.deepEqual(endpointer.onPrediction({ requestId: first.requestId, probability: 0.2 }), []);
  endpointer.onSpeechStart();
  const second = endpointer.onSegment({ ...segment(2400, 600, 0.2), nowSample: ms(3200) })[0];
  const [commit] = endpointer.onPrediction({
    requestId: second.requestId,
    probability: 0.9,
    nowSample: ms(3230),
  });

  assert.equal(commit.type, "commit");
  assert.equal(commit.reason, "smart-turn");
  assert.equal(commit.probability, 0.9);
  assert.equal(commit.samples.length, ms(1400));
  assert.equal(commit.samples[0], Math.fround(0.1));
  assert.equal(commit.samples[commit.samples.length - 1], Math.fround(0.2));
  assert.equal(commit.speechEndSample, ms(3000));
  assert.equal(commit.commitSample, ms(3230));
  assert.equal(commit.segments, 2);
});

test("the classifier window for a later pause starts at the first segment of the turn", () => {
  const endpointer = createTurnEndpointer({ smartTurn: true, preRollMs: 500 });
  endpointer.onSegment({ ...segment(1000, 800), nowSample: ms(2000) });
  endpointer.onSpeechStart();
  const [action] = endpointer.onSegment({ ...segment(2400, 600), nowSample: ms(3200) });
  assert.equal(action.fromSample, ms(500));
});

test("an incomplete prediction waits, then max silence commits the turn", () => {
  const endpointer = createTurnEndpointer({ smartTurn: true, maxSilenceMs: 1200 });
  const [action] = endpointer.onSegment({ ...segment(1000, 800), nowSample: ms(2000) });
  assert.deepEqual(endpointer.onPrediction({ requestId: action.requestId, probability: 0.3 }), []);
  assert.deepEqual(endpointer.advance(ms(2999)), []);

  const [commit] = endpointer.advance(ms(3000));
  assert.equal(commit.reason, "max-silence");
  assert.equal(commit.probability, 0.3);
  assert.equal(commit.commitSample, ms(3000));
  assert.deepEqual(endpointer.advance(ms(4000)), []);
});

test("max silence commits even when the classifier has not answered", () => {
  const endpointer = createTurnEndpointer({ smartTurn: true, maxSilenceMs: 1200 });
  const [action] = endpointer.onSegment({ ...segment(1000, 800), nowSample: ms(2000) });
  const [commit] = endpointer.advance(ms(3000));
  assert.equal(commit.reason, "max-silence");
  assert.equal(commit.probability, null);
  assert.deepEqual(endpointer.onPrediction({ requestId: action.requestId, probability: 0.99 }), []);
});

test("a prediction that lands after speech resumed is ignored", () => {
  const endpointer = createTurnEndpointer({ smartTurn: true });
  const [action] = endpointer.onSegment({ ...segment(1000, 800), nowSample: ms(2000) });
  endpointer.onSpeechStart();
  assert.deepEqual(endpointer.onPrediction({ requestId: action.requestId, probability: 0.99 }), []);
});

test("max silence never fires while the user is speaking again", () => {
  const endpointer = createTurnEndpointer({ smartTurn: true, maxSilenceMs: 1200 });
  endpointer.onSegment({ ...segment(1000, 800), nowSample: ms(2000) });
  endpointer.onSpeechStart();
  assert.deepEqual(endpointer.advance(ms(9000)), []);
});

test("a failed classification (null probability) leaves the decision to max silence", () => {
  const endpointer = createTurnEndpointer({ smartTurn: true, maxSilenceMs: 1200 });
  const [action] = endpointer.onSegment({ ...segment(1000, 800), nowSample: ms(2000) });
  assert.deepEqual(endpointer.onPrediction({ requestId: action.requestId, probability: null }), []);
  assert.equal(endpointer.advance(ms(3000))[0].reason, "max-silence");
});

test("tiered mode commits at once only above the fast threshold", () => {
  const endpointer = createTurnEndpointer({
    smartTurn: true,
    threshold: 0.5,
    fastThreshold: 0.9,
    holdSilenceMs: 500,
  });
  const [action] = endpointer.onSegment({ ...segment(1000, 800), nowSample: ms(2000) });
  const [commit] = endpointer.onPrediction({
    requestId: action.requestId,
    probability: 0.95,
    nowSample: ms(2050),
  });
  assert.equal(commit.reason, "smart-turn");
});

test("tiered mode holds a likely-complete turn until the hold silence", () => {
  const endpointer = createTurnEndpointer({
    smartTurn: true,
    threshold: 0.5,
    fastThreshold: 0.9,
    holdSilenceMs: 500,
    maxSilenceMs: 1200,
  });
  const [action] = endpointer.onSegment({ ...segment(1000, 800), nowSample: ms(2000) });
  assert.deepEqual(
    endpointer.onPrediction({ requestId: action.requestId, probability: 0.7, nowSample: ms(2050) }),
    []
  );
  assert.deepEqual(endpointer.advance(ms(2299)), []);

  const [commit] = endpointer.advance(ms(2300));
  assert.equal(commit.reason, "smart-turn-hold");
  assert.equal(commit.probability, 0.7);
});

test("tiered mode forgets a held turn when the user speaks again", () => {
  const endpointer = createTurnEndpointer({
    smartTurn: true,
    fastThreshold: 0.9,
    holdSilenceMs: 500,
  });
  const [action] = endpointer.onSegment({ ...segment(1000, 800), nowSample: ms(2000) });
  endpointer.onPrediction({ requestId: action.requestId, probability: 0.7, nowSample: ms(2050) });
  endpointer.onSpeechStart();
  endpointer.onSegment({ ...segment(2400, 600), nowSample: ms(3200) });
  // 500 ms after the second pause, with no prediction for it yet: keep waiting.
  assert.deepEqual(endpointer.advance(ms(3500)), []);
});

test("reset drops a pending turn", () => {
  const endpointer = createTurnEndpointer({ smartTurn: true, maxSilenceMs: 1200 });
  endpointer.onSegment({ ...segment(1000, 800), nowSample: ms(2000) });
  endpointer.reset();
  assert.deepEqual(endpointer.advance(ms(9000)), []);
});

test("the sample ring returns absolute-indexed slices across the wrap point", () => {
  const ring = createSampleRing(5);
  ring.push(new Float32Array([1, 2, 3]));
  ring.push(new Float32Array([4, 5, 6, 7]));
  assert.equal(ring.totalSamples, 7);
  assert.deepEqual(Array.from(ring.slice(3, 7)), [4, 5, 6, 7]);
  assert.deepEqual(Array.from(ring.slice(4, 6)), [5, 6]);
});

test("the sample ring clamps slices to the samples it still holds", () => {
  const ring = createSampleRing(4);
  ring.push(new Float32Array([1, 2, 3, 4, 5, 6]));
  assert.deepEqual(Array.from(ring.slice(0, 10)), [3, 4, 5, 6]);
  assert.equal(ring.slice(8, 9).length, 0);
});
