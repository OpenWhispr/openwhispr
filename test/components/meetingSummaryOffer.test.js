const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/components/notes/shared.ts");

const FINISHED_RECORDING = {
  isRecording: false,
  hasTranscriptSegments: true,
  hasSummary: false,
  canEdit: true,
  isProcessingAction: false,
};

// #2159 follow-up: the offer used to be gated on the transcript tab, so a meeting
// that auto-ended while the user sat on the Notes tab (where every detected and
// quick-action meeting starts) never offered its summary.
test("a finished recording with a transcript and no summary offers one", async () => {
  const { shouldOfferMeetingSummary } = await load();

  assert.equal(shouldOfferMeetingSummary(FINISHED_RECORDING), true);
});

test("a live recording, an existing summary, or nothing transcribed offers nothing", async () => {
  const { shouldOfferMeetingSummary } = await load();

  assert.equal(shouldOfferMeetingSummary({ ...FINISHED_RECORDING, isRecording: true }), false);
  assert.equal(shouldOfferMeetingSummary({ ...FINISHED_RECORDING, hasSummary: true }), false);
  assert.equal(
    shouldOfferMeetingSummary({ ...FINISHED_RECORDING, hasTranscriptSegments: false }),
    false
  );
});

test("a read-only note and an action already running offer nothing", async () => {
  const { shouldOfferMeetingSummary } = await load();

  assert.equal(shouldOfferMeetingSummary({ ...FINISHED_RECORDING, canEdit: false }), false);
  assert.equal(
    shouldOfferMeetingSummary({ ...FINISHED_RECORDING, isProcessingAction: true }),
    false
  );
});
