const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveLiveSpeakerLimit, autoDisplayCount } = require("../../src/helpers/liveSpeakerLimit");

test("a count set on the stepper is exact, even below the speakers found", () => {
  assert.deepEqual(resolveLiveSpeakerLimit({ expectedCount: 3, explicit: true }, 4), {
    maxSpeakers: 2,
    gated: true,
  });
});

test("a count from attendees never drops below the speakers found", () => {
  assert.deepEqual(resolveLiveSpeakerLimit({ expectedCount: 3 }, 0), {
    maxSpeakers: 2,
    gated: true,
  });
  assert.deepEqual(resolveLiveSpeakerLimit({ expectedCount: 3 }, 4), {
    maxSpeakers: 4,
    gated: true,
  });
});

test("automatic is uncapped and gated", () => {
  assert.deepEqual(resolveLiveSpeakerLimit({ expectedCount: 2, auto: true }, 0), {
    maxSpeakers: 7,
    gated: true,
  });
});

// With one remote speaker there is no second voice to hold a new one for.
test("a count of 1 or 2 leaves one remote speaker, ungated", () => {
  for (const expectedCount of [1, 2]) {
    assert.deepEqual(resolveLiveSpeakerLimit({ expectedCount, explicit: true }), {
      maxSpeakers: 1,
      gated: false,
    });
  }
  assert.deepEqual(resolveLiveSpeakerLimit({ expectedCount: 2 }, 0), {
    maxSpeakers: 1,
    gated: false,
  });
});

test("the display count is you plus the speakers found, from 2 to 8", () => {
  assert.deepEqual([0, 1, 3, 7, 9].map(autoDisplayCount), [2, 2, 4, 8, 8]);
});
