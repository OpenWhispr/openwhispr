const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  pickSpeakerForRange,
  relabelForIdentification,
  pruneIdentifications,
} = require("../../src/helpers/speakerRangeMatch");
const { applyConfirmedSpeaker } = require("../../src/helpers/speakerAssignmentPolicy");

const source = fs.readFileSync(path.join(__dirname, "../../src/helpers/ipcHandlers.js"), "utf8");

const T = 1_700_000_000_000;

const identification = (speakerId, startOffset, endOffset) => ({
  speakerId,
  displayName: `Name ${speakerId}`,
  startTime: T + startOffset,
  endTime: T + endOffset,
});

function harness(identifications = []) {
  const start = source.indexOf("const storeMeetingDiarizationSegment =");
  const end = source.indexOf("const sendMeetingFinalSegment =", start);
  assert.ok(start >= 0 && end > start, "store/apply closures not found in ipcHandlers.js");
  const context = {
    meetingDiarizationSegments: [],
    meetingLiveIdentifications: identifications,
    pickSpeakerForRange,
    relabelForIdentification,
    pruneIdentifications,
    applyConfirmedSpeaker,
    Date,
  };
  vm.createContext(context);
  vm.runInContext(
    `${source.slice(start, end)}
     globalThis.store = storeMeetingDiarizationSegment;
     globalThis.applyIdentification = applyLiveIdentificationToRows;`,
    context
  );
  return context;
}

test("a ranged system row is labelled when it is stored", () => {
  const ctx = harness([identification("speaker_0", 0, 3000), identification("speaker_1", 3000, 9000)]);
  ctx.store("hello", "system", T + 3500, null, true, T + 8000);
  const [row] = ctx.meetingDiarizationSegments;
  assert.equal(row.speaker, "speaker_1");
  assert.equal(row.liveOverlapMs, 4500);
});

test("a mic row and a row without a range are left alone", () => {
  const ctx = harness([identification("speaker_0", 0, 3000), identification("speaker_1", 3000, 9000)]);
  ctx.store("mine", "mic", T + 3500, null, true, T + 8000);
  ctx.store("cloud", "system", T + 3500);
  assert.deepEqual(
    Array.from(ctx.meetingDiarizationSegments, (segment) => segment.speaker),
    [undefined, undefined]
  );
});

const labelledRow = (ctx) => {
  ctx.store("hello", "system", T, null, true, T + 4000);
  const [row] = ctx.meetingDiarizationSegments;
  applyConfirmedSpeaker(row, { speaker: "speaker_0", speakerName: "Zero", speakerIsPlaceholder: false });
  row.liveOverlapMs = 1000;
  return row;
};

test("a later identification covering more of a ranged row takes it over", () => {
  const ctx = harness();
  const row = labelledRow(ctx);
  ctx.applyIdentification(identification("speaker_1", 1500, 4000));
  assert.equal(row.speaker, "speaker_1");
  assert.equal(row.liveOverlapMs, 2500);
});

test("an identification covering less of a ranged row leaves it alone", () => {
  const ctx = harness();
  const row = labelledRow(ctx);
  ctx.applyIdentification(identification("speaker_1", 3200, 4000));
  assert.equal(row.speaker, "speaker_0");
  assert.equal(row.liveOverlapMs, 1000);
});

test("an unranged system row keeps the point-in-window rule", () => {
  const ctx = harness();
  ctx.store("inside", "system", T + 1000);
  ctx.store("outside", "system", T + 9000);
  ctx.applyIdentification(identification("speaker_2", 0, 2000));
  assert.deepEqual(
    Array.from(ctx.meetingDiarizationSegments, (segment) => segment.speaker),
    ["speaker_2", undefined]
  );
});

test("a mic row is never relabelled by an identification", () => {
  const ctx = harness();
  ctx.store("mine", "mic", T + 500, null, true, T + 1500);
  ctx.applyIdentification(identification("speaker_2", 0, 4000));
  assert.equal(ctx.meetingDiarizationSegments[0].speaker, undefined);
});

test("identifications older than the retention window are pruned", () => {
  const ctx = harness([identification("speaker_0", 0, 3000)]);
  ctx.applyIdentification(identification("speaker_1", 200_000, 203_000));
  assert.deepEqual(
    Array.from(ctx.meetingLiveIdentifications, (entry) => entry.speakerId),
    ["speaker_1"]
  );
});
