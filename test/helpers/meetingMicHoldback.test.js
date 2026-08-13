const test = require("node:test");
const assert = require("node:assert/strict");

const {
  partitionPendingMicFinals,
  isWithinRetractWindow,
} = require("../../src/helpers/meetingMicHoldback");

const NOW = 1_000_000;

const entry = (overrides = {}) => ({
  text: "hello there",
  timestamp: NOW - 5000,
  releaseAt: NOW - 1,
  micSuppression: null,
  ...overrides,
});

test("defers entries whose holdback has not elapsed without evaluating them", () => {
  const waiting = entry({ releaseAt: NOW + 2000 });
  const due = entry({ releaseAt: NOW - 500 });
  const evaluated = [];

  const { deferred, duplicates, releases } = partitionPendingMicFinals({
    pending: [waiting, due],
    now: NOW,
    isDuplicate: (candidate) => {
      evaluated.push(candidate);
      return false;
    },
  });

  assert.deepEqual(deferred, [waiting]);
  assert.deepEqual(duplicates, []);
  assert.deepEqual(releases, [due]);
  // The dedupe verdict must be taken at release time, when the system channel
  // has had the full holdback window to produce a matching transcript.
  assert.deepEqual(evaluated, [due]);
});

test("entries due exactly at now are evaluated, not re-deferred", () => {
  // The flush timer fires at exactly releaseAt, so now === releaseAt is the
  // common case; re-deferring would cause a needless 0ms reschedule loop.
  const due = entry({ releaseAt: NOW });

  const { deferred, releases } = partitionPendingMicFinals({
    pending: [due],
    now: NOW,
    isDuplicate: () => false,
  });

  assert.deepEqual(deferred, []);
  assert.deepEqual(releases, [due]);
});

test("force flush evaluates entries still inside the holdback window", () => {
  const waiting = entry({ releaseAt: NOW + 2000 });

  const { deferred, releases } = partitionPendingMicFinals({
    pending: [waiting],
    now: NOW,
    force: true,
    isDuplicate: () => false,
  });

  assert.deepEqual(deferred, []);
  assert.deepEqual(releases, [waiting]);
});

test("force flush still drops confirmed duplicates (meeting-stop path)", () => {
  // flushPendingMicFinals(true) runs at meeting stop; entries inside their
  // holdback window get their one and only dedupe check there.
  const echoed = entry({ releaseAt: NOW + 2000, text: "so that is eight dollars a month" });
  const genuine = entry({ releaseAt: NOW + 2000, text: "thanks for taking the time" });

  const { deferred, duplicates, releases } = partitionPendingMicFinals({
    pending: [echoed, genuine],
    now: NOW,
    force: true,
    isDuplicate: (candidate) => candidate === echoed,
  });

  assert.deepEqual(deferred, []);
  assert.deepEqual(duplicates, [echoed]);
  assert.deepEqual(releases, [genuine]);
});

test("drops entries only when the transcript matcher confirms a duplicate", () => {
  const echoed = entry({ text: "we have our own cloud server" });
  const genuine = entry({ text: "how do you make money off of this" });

  const { duplicates, releases } = partitionPendingMicFinals({
    pending: [echoed, genuine],
    now: NOW,
    isDuplicate: (candidate) => candidate === echoed,
  });

  assert.deepEqual(duplicates, [echoed]);
  assert.deepEqual(releases, [genuine]);
});

test("regression: bleed-flagged speech without a transcript match is released, not dropped", () => {
  // Field logs (2026-07-02, Windows): genuine local speech during double-talk
  // scored correlations of 0.73–0.81 and was silently discarded after holdback
  // even though no system transcript ever matched it.
  const flagged = entry({
    text: "how do you make money off of this one",
    micSuppression: {
      reason: "double_talk",
      hasBleedEvidence: true,
      likelyRenderBleed: false,
      averageCorrelation: 0.742,
      averageResidual: 0.45,
    },
  });

  const { deferred, duplicates, releases } = partitionPendingMicFinals({
    pending: [flagged],
    now: NOW,
    isDuplicate: () => false,
  });

  assert.deepEqual(deferred, []);
  assert.deepEqual(duplicates, []);
  assert.deepEqual(releases, [flagged]);
});

test("bleed-flagged speech that matches a system transcript is still dropped", () => {
  const echoed = entry({
    text: "we are very early and so i am still trying to figure out the best",
    micSuppression: { hasBleedEvidence: true, averageCorrelation: 0.81 },
  });

  const { duplicates, releases } = partitionPendingMicFinals({
    pending: [echoed],
    now: NOW,
    isDuplicate: () => true,
  });

  assert.deepEqual(duplicates, [echoed]);
  assert.deepEqual(releases, []);
});

test("preserves queue order within each partition", () => {
  const first = entry({ text: "first", releaseAt: NOW - 30 });
  const second = entry({ text: "second", releaseAt: NOW - 20 });
  const third = entry({ text: "third", releaseAt: NOW - 10 });

  const { releases } = partitionPendingMicFinals({
    pending: [first, second, third],
    now: NOW,
    isDuplicate: () => false,
  });

  assert.deepEqual(
    releases.map((candidate) => candidate.text),
    ["first", "second", "third"]
  );
});

test("handles an empty queue", () => {
  const { deferred, duplicates, releases } = partitionPendingMicFinals({
    pending: [],
    now: NOW,
    isDuplicate: () => false,
  });

  assert.deepEqual(deferred, []);
  assert.deepEqual(duplicates, []);
  assert.deepEqual(releases, []);
});

test("retract window matches on capture timestamps for segments committed on arrival", () => {
  const candidate = { timestamp: NOW, committedAt: NOW };

  assert.equal(
    isWithinRetractWindow({ candidate, systemTimestamp: NOW + 3000, windowMs: 6000 }),
    true
  );
  assert.equal(
    isWithinRetractWindow({ candidate, systemTimestamp: NOW + 6001, windowMs: 6000 }),
    false
  );
});

test("regression: late confirmation races commit time for held-back segments", () => {
  // Local mode stamps segments at transcription completion and releases them
  // holdback ms later, so a confirming next-cycle system transcript is always
  // more than `holdback` past the capture timestamp. On capture timestamps
  // alone this candidate could categorically never be retracted.
  const holdback = 6000;
  const released = { timestamp: NOW, committedAt: NOW + holdback };

  assert.equal(
    isWithinRetractWindow({ candidate: released, systemTimestamp: NOW + 6500, windowMs: 6000 }),
    true
  );
  assert.equal(
    isWithinRetractWindow({
      candidate: released,
      systemTimestamp: NOW + holdback + 6001,
      windowMs: 6000,
    }),
    false
  );
});

test("commit-time race never matches system transcripts from before the segment was spoken", () => {
  const released = { timestamp: NOW, committedAt: NOW + 6000 };

  assert.equal(
    isWithinRetractWindow({ candidate: released, systemTimestamp: NOW - 6500, windowMs: 6000 }),
    false
  );
});

test("segments without a commit time fall back to the capture window only", () => {
  const legacy = { timestamp: NOW, committedAt: null };

  assert.equal(
    isWithinRetractWindow({ candidate: legacy, systemTimestamp: NOW + 6500, windowMs: 6000 }),
    false
  );
  assert.equal(
    isWithinRetractWindow({ candidate: legacy, systemTimestamp: NOW + 5000, windowMs: 6000 }),
    true
  );
});
