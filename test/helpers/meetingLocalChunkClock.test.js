const test = require("node:test");
const assert = require("node:assert/strict");

const { createLocalChunkClock } = require("../../src/helpers/meetingLocalChunkClock");

const SAMPLE_RATE = 24000;
const bytesFor = (ms) => Math.round((ms / 1000) * SAMPLE_RATE) * 2;

test("a chunk starts at its first buffer's capture time, not at take time", () => {
  let now = 10_000;
  const clock = createLocalChunkClock({ now: () => now });

  clock.mark("system", 1_000);
  clock.mark("system", 1_100);
  clock.mark("system", 5_900);
  now = 7_500; // the decode finished long after the audio was captured

  assert.equal(clock.take("system", bytesFor(5000)), 1_000);
});

test("sources are timed independently", () => {
  const clock = createLocalChunkClock({ now: () => 0 });

  clock.mark("system", 2_000);
  clock.mark("mic", 2_250);

  assert.equal(clock.take("mic"), 2_250);
  assert.equal(clock.take("system"), 2_000);
});

test("take() ends the chunk, so the next buffer starts the next chunk", () => {
  const clock = createLocalChunkClock({ now: () => 0 });

  clock.mark("mic", 1_000);
  assert.equal(clock.take("mic"), 1_000);

  clock.mark("mic", 6_000);
  clock.mark("mic", 6_100);
  assert.equal(clock.take("mic"), 6_000);
});

test("buffers without a capture time fall back to their arrival", () => {
  let now = 3_000;
  const clock = createLocalChunkClock({ now: () => now });

  clock.mark("mic", null);
  now = 4_000;
  clock.mark("mic", 3_500); // later buffers never move the start

  assert.equal(clock.take("mic"), 3_000);
});

test("an unmarked chunk is assumed to have just ended", () => {
  const clock = createLocalChunkClock({ now: () => 20_000 });

  assert.equal(clock.take("system", bytesFor(5000)), 15_000);
  assert.equal(clock.take("system"), 20_000);
});

test("reset() forgets pending starts", () => {
  const clock = createLocalChunkClock({ now: () => 9_000 });

  clock.mark("system", 1_000);
  clock.mark("mic", 1_000);
  clock.reset();

  assert.equal(clock.take("system"), 9_000);
  assert.equal(clock.take("mic"), 9_000);
});
