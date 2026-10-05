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

const {
  isRiskyMicDuplicateProfile,
  isDuplicateMicSegment,
  selectRacingMicEntryIndices,
  partitionOverlappingPendingMicFinals,
} = require("../../src/helpers/meetingMicHoldback");

const DUPLICATE_WINDOW = 6000;
const RETRACT_WINDOW = 4000;

test("isRiskyMicDuplicateProfile: warmup alone is risky, even with no suppression", () => {
  assert.equal(isRiskyMicDuplicateProfile({ suppression: null, inStartupWarmup: true }), true);
});

test("characterization: isRiskyMicDuplicateProfile treats systemSpeaking alone as risky (D4b changes this)", () => {
  assert.equal(
    isRiskyMicDuplicateProfile({ suppression: { systemSpeaking: true, reason: "clean" } }),
    true
  );
});

test("isRiskyMicDuplicateProfile: bleed evidence, render bleed, or double_talk are risky; clean is not", () => {
  assert.equal(isRiskyMicDuplicateProfile({ suppression: { reason: "double_talk" } }), true);
  assert.equal(isRiskyMicDuplicateProfile({ suppression: { hasBleedEvidence: true } }), true);
  assert.equal(isRiskyMicDuplicateProfile({ suppression: { likelyRenderBleed: true } }), true);
  // Today's closure yields `undefined` here (last operand of the `||` chain), not `false`;
  // callers only test truthiness. Phase 1 may normalize the return to a strict boolean.
  assert.equal(!!isRiskyMicDuplicateProfile({ suppression: { reason: "clean_local" } }), false);
  assert.equal(isRiskyMicDuplicateProfile({ suppression: null }), false);
  assert.equal(isRiskyMicDuplicateProfile({}), false);
});

test("isDuplicateMicSegment: bleed evidence uses the strict matcher; double_talk uses the relaxed matcher", () => {
  const calls = [];
  const matcher = (source, text, timestamp, options) => {
    calls.push({ source, text, timestamp, options });
    return true;
  };
  assert.equal(
    isDuplicateMicSegment({
      text: "hi",
      timestamp: 10,
      suppression: { hasBleedEvidence: true },
      hasNearbyTranscriptMatch: matcher,
    }),
    true
  );
  assert.deepEqual(calls[0], { source: "system", text: "hi", timestamp: 10, options: undefined });

  assert.equal(
    isDuplicateMicSegment({
      text: "hi",
      timestamp: 10,
      suppression: { reason: "double_talk" },
      hasNearbyTranscriptMatch: matcher,
    }),
    true
  );
  assert.deepEqual(calls[1].options, { relaxed: true });
});

test("isDuplicateMicSegment: bleed evidence without a strict match falls through to double_talk only if flagged", () => {
  const strictFalseRelaxedTrue = (source, text, timestamp, options) => !!options?.relaxed;
  assert.equal(
    isDuplicateMicSegment({
      text: "hi",
      timestamp: 10,
      suppression: { hasBleedEvidence: true, reason: "render_bleed" },
      hasNearbyTranscriptMatch: strictFalseRelaxedTrue,
    }),
    false
  );
  assert.equal(
    isDuplicateMicSegment({
      text: "hi",
      timestamp: 10,
      suppression: { hasBleedEvidence: true, reason: "double_talk" },
      hasNearbyTranscriptMatch: strictFalseRelaxedTrue,
    }),
    true
  );
});

test("isDuplicateMicSegment: systemSpeaking-only or no suppression never calls the matcher", () => {
  let calls = 0;
  const matcher = () => ((calls += 1), true);
  assert.equal(
    isDuplicateMicSegment({
      text: "hi",
      timestamp: 10,
      suppression: { systemSpeaking: true },
      hasNearbyTranscriptMatch: matcher,
    }),
    false
  );
  assert.equal(
    isDuplicateMicSegment({
      text: "hi",
      timestamp: 10,
      suppression: null,
      hasNearbyTranscriptMatch: matcher,
    }),
    false
  );
  assert.equal(calls, 0);
});

const micSeg = (overrides) => ({
  source: "mic",
  text: "we should ship on friday",
  timestamp: NOW - 1000,
  committedAt: NOW - 900,
  suppressionReason: null,
  hasBleedEvidence: false,
  likelyRenderBleed: false,
  ...overrides,
});

test("selectRacingMicEntryIndices removes bleed-flagged mic entries that overlap the arriving system final, newest first", () => {
  const segments = [
    { source: "system", text: "unrelated", timestamp: NOW - 5000 },
    micSeg({ hasBleedEvidence: true, timestamp: NOW - 3000, committedAt: NOW - 2900 }),
    micSeg({
      text: "clean speech",
      suppressionReason: null,
      timestamp: NOW - 2000,
      committedAt: NOW - 1900,
    }),
    micSeg({ suppressionReason: "double_talk", timestamp: NOW - 1000, committedAt: NOW - 900 }),
  ];
  const seen = [];
  const matcher = (source, text, timestamp, options) => {
    seen.push({ text, relaxed: !!options?.relaxed, extra: options?.extraSegment });
    return true;
  };
  const indices = selectRacingMicEntryIndices({
    segments,
    systemText: "we should ship on friday",
    systemTimestamp: NOW,
    hasNearbyTranscriptMatch: matcher,
    duplicateWindowMs: DUPLICATE_WINDOW,
    retractWindowMs: RETRACT_WINDOW,
  });
  assert.deepEqual(
    indices,
    [3, 1],
    "descending; the non-risky clean entry (index 2) is never removed"
  );
  assert.deepEqual(
    seen.map((s) => s.relaxed),
    [true, false, false],
    "double_talk candidates use the relaxed matcher"
  );
  assert.deepEqual(seen[0].extra, { text: "we should ship on friday", timestamp: NOW });
});

test("selectRacingMicEntryIndices skips candidates outside their per-candidate window (6 s bleed / 4 s otherwise)", () => {
  const segments = [
    micSeg({ hasBleedEvidence: true, timestamp: NOW - 5500, committedAt: NOW - 5400 }), // within 6 s
    micSeg({ suppressionReason: "double_talk", timestamp: NOW - 4500, committedAt: NOW - 4400 }), // outside 4 s
  ];
  const indices = selectRacingMicEntryIndices({
    segments,
    systemText: "x",
    systemTimestamp: NOW,
    hasNearbyTranscriptMatch: () => true,
    duplicateWindowMs: DUPLICATE_WINDOW,
    retractWindowMs: RETRACT_WINDOW,
  });
  assert.deepEqual(indices, [0]);
});

test("selectRacingMicEntryIndices without a system timestamp evaluates every risky candidate", () => {
  const segments = [
    micSeg({ hasBleedEvidence: true, timestamp: NOW - 50_000, committedAt: NOW - 49_000 }),
    micSeg({ timestamp: NOW - 100 }),
  ];
  const indices = selectRacingMicEntryIndices({
    segments,
    systemText: "x",
    systemTimestamp: null,
    hasNearbyTranscriptMatch: () => true,
    duplicateWindowMs: DUPLICATE_WINDOW,
    retractWindowMs: RETRACT_WINDOW,
  });
  assert.deepEqual(indices, [0]);
});

test("characterization: the backward-scan break stops before an older bleed-flagged entry whose commit time still races (Phase 1 flips break→continue)", () => {
  // From the 2026-08-17 verification: array is committedAt-ordered, windows are per-candidate.
  const E = micSeg({ hasBleedEvidence: true, timestamp: NOW - 8300, committedAt: NOW - 5300 }); // commit race passes the 6 s window
  const C = micSeg({ timestamp: NOW - 7500, committedAt: NOW - 4500 }); // non-bleed: fails 4 s on both races, ts < NOW-6000 → break
  const indices = selectRacingMicEntryIndices({
    segments: [E, C],
    systemText: "x",
    systemTimestamp: NOW,
    hasNearbyTranscriptMatch: () => true,
    duplicateWindowMs: DUPLICATE_WINDOW,
    retractWindowMs: RETRACT_WINDOW,
  });
  assert.deepEqual(indices, [], "TODAY: E is never scanned. Phase 1 expects [0].");
});

test("partitionOverlappingPendingMicFinals splits pending finals by system overlap, preserving order and using relaxed matching for double_talk", () => {
  const pending = [
    entry({ text: "a", micSuppression: { reason: "double_talk" } }),
    entry({ text: "b", micSuppression: null }),
    entry({ text: "c", micSuppression: { hasBleedEvidence: true } }),
  ];
  const seen = [];
  const matcher = (source, text, timestamp, options) => {
    seen.push({ text, relaxed: !!options?.relaxed });
    return text !== "b";
  };
  const { kept, removed } = partitionOverlappingPendingMicFinals({
    pending,
    systemText: "sys",
    systemTimestamp: NOW,
    hasNearbyTranscriptMatch: matcher,
  });
  assert.deepEqual(
    kept.map((p) => p.text),
    ["b"]
  );
  assert.deepEqual(
    removed.map((p) => p.text),
    ["a", "c"]
  );
  assert.deepEqual(seen, [
    { text: "a", relaxed: true },
    { text: "b", relaxed: false },
    { text: "c", relaxed: false },
  ]);
});
