const test = require("node:test");
const assert = require("node:assert/strict");

const createMeetingSystemAudioHandover = require("../../src/helpers/meetingSystemAudioHandover");
const { makeSine, toInt16Buffer } = require("./harness/pcmFixtures");

const { CONFIRM_MS } = createMeetingSystemAudioHandover;

const AUDIBLE = toInt16Buffer(makeSine({ durationMs: 100, amplitude: 0.3 }));
const SILENT = Buffer.alloc(AUDIBLE.length);

const createHarness = () => {
  let now = 1_000_000;
  const handover = createMeetingSystemAudioHandover({ now: () => now });
  return {
    handover,
    advance: (ms) => {
      now += ms;
    },
  };
};

test("without a trial both producers pass straight through", () => {
  const { handover } = createHarness();

  assert.equal(handover.acceptNativeChunk(SILENT), true);
  assert.equal(handover.acceptRendererChunk(AUDIBLE), "send");
});

test("the trial begins once per session", () => {
  const { handover } = createHarness();

  assert.equal(handover.begin(), true);
  assert.equal(handover.begin(), false);
  handover.reset();
  assert.equal(handover.begin(), true);
});

test("renderer loopback takes over once it keeps hearing audio the helper misses", () => {
  const { handover, advance } = createHarness();
  handover.begin();

  assert.equal(handover.acceptNativeChunk(SILENT), true);
  assert.equal(handover.acceptRendererChunk(AUDIBLE), "drop");
  advance(CONFIRM_MS - 1);
  assert.equal(handover.acceptRendererChunk(AUDIBLE), "drop");
  advance(1);
  assert.equal(handover.acceptRendererChunk(AUDIBLE), "takeover");

  assert.equal(handover.acceptRendererChunk(SILENT), "send");
  assert.equal(handover.acceptNativeChunk(AUDIBLE), false);
});

test("the helper keeps the channel while it hears what loopback hears", () => {
  const { handover, advance } = createHarness();
  handover.begin();

  for (let elapsed = 0; elapsed <= CONFIRM_MS * 5; elapsed += 100) {
    assert.equal(handover.acceptRendererChunk(AUDIBLE), "drop");
    assert.equal(handover.acceptNativeChunk(AUDIBLE), true);
    advance(100);
  }
});

test("loopback that hears nothing never takes over", () => {
  const { handover, advance } = createHarness();
  handover.begin();

  advance(CONFIRM_MS * 5);
  assert.equal(handover.acceptRendererChunk(SILENT), "drop");
  assert.equal(handover.acceptNativeChunk(SILENT), true);
});

test("reset returns a taken-over session to the native producer", () => {
  const { handover, advance } = createHarness();
  handover.begin();
  handover.acceptRendererChunk(AUDIBLE);
  advance(CONFIRM_MS);
  assert.equal(handover.acceptRendererChunk(AUDIBLE), "takeover");

  handover.reset();

  assert.equal(handover.acceptNativeChunk(AUDIBLE), true);
  assert.equal(handover.acceptRendererChunk(AUDIBLE), "send");
});
