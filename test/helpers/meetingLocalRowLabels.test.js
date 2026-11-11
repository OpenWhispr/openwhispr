const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const speakerRangeMatch = require("../../src/helpers/speakerRangeMatch");
const {
  applyConfirmedSpeaker,
  canAutoRelabelSpeaker,
} = require("../../src/helpers/speakerAssignmentPolicy");

const source = fs.readFileSync(path.join(__dirname, "../../src/helpers/ipcHandlers.js"), "utf8");

const T = 1_700_000_000_000;

const identification = (speakerId, startOffset, endOffset, displayName = `Name ${speakerId}`) => ({
  speakerId,
  displayName,
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
    ...speakerRangeMatch,
    applyConfirmedSpeaker,
    canAutoRelabelSpeaker,
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
  assert.equal("liveOverlapMs" in row, false);
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

// A row 0–4000 first heard as speaker_0 "Zero" for its first second.
const labelledRow = (ctx) => {
  ctx.meetingLiveIdentifications.push(identification("speaker_0", 0, 1000, "Zero"));
  ctx.store("hello", "system", T, null, true, T + 4000);
  const [row] = ctx.meetingDiarizationSegments;
  assert.equal(row.speaker, "speaker_0");
  return row;
};

test("a later identification covering more of a ranged row takes it over", () => {
  const ctx = harness();
  const row = labelledRow(ctx);
  ctx.applyIdentification(identification("speaker_1", 1500, 4000));
  assert.equal(row.speaker, "speaker_1");
});

test("an identification covering less of a ranged row leaves it alone", () => {
  const ctx = harness([identification("speaker_0", 0, 3000, "Zero")]);
  ctx.store("hello", "system", T, null, true, T + 4000);
  const [row] = ctx.meetingDiarizationSegments;
  ctx.applyIdentification(identification("speaker_1", 3200, 4000));
  assert.equal(row.speaker, "speaker_0");
  assert.equal(row.speakerName, "Zero");
});

// One speech segment (padded start 0): the embedding hears A until 5750, though B
// started talking at 4000, then B as the segment goes on.
const speechSegment = (speakerId, endOffset) => identification(speakerId, 0, endOffset, null);

test("a row first heard as the earlier speaker moves to the next one as their audio accumulates", () => {
  const ctx = harness(
    [1750, 2750, 3750, 4750, 5750].map((end) => speechSegment("speaker_0", end))
  );
  ctx.store("over to you", "system", T + 4000, null, true, T + 9000);
  const [row] = ctx.meetingDiarizationSegments;
  assert.equal(row.speaker, "speaker_0");

  // 1 s of B against 1.75 s of A: still A.
  ctx.applyIdentification(speechSegment("speaker_1", 6750));
  assert.equal(row.speaker, "speaker_0");

  ctx.applyIdentification(speechSegment("speaker_1", 7750));
  assert.equal(row.speaker, "speaker_1");
});

test("a row in the earlier speaker's part keeps them as the next speaker is heard", () => {
  const ctx = harness(
    [1750, 2750, 3750, 4750, 5750].map((end) => speechSegment("speaker_0", end))
  );
  ctx.store("my part", "system", T + 750, null, true, T + 4000);
  const [row] = ctx.meetingDiarizationSegments;
  for (const end of [6750, 7750, 8750, 9750]) {
    ctx.applyIdentification(speechSegment("speaker_1", end));
  }
  assert.equal(row.speaker, "speaker_0");
});

test("a ranged row stored after the next speaker is heard goes to who spoke it", () => {
  const ctx = harness([
    ...[1750, 2750, 3750, 4750, 5750].map((end) => speechSegment("speaker_0", end)),
    ...[6750, 7750, 8750].map((end) => speechSegment("speaker_1", end)),
  ]);
  ctx.store("my part", "system", T + 750, null, true, T + 4000);
  assert.equal(ctx.meetingDiarizationSegments[0].speaker, "speaker_0");
});

test("a ranged row moved to another speaker drops the previous speaker's name", () => {
  const ctx = harness();
  const row = labelledRow(ctx);
  ctx.applyIdentification(identification("speaker_1", 1500, 4000, null));
  assert.equal(row.speaker, "speaker_1");
  assert.equal(row.speakerName, undefined);
});

test("a ranged row stored with an unnamed speaker carries no name", () => {
  const ctx = harness([identification("speaker_1", 0, 4000, null)]);
  ctx.store("hello", "system", T, null, true, T + 4000);
  const [row] = ctx.meetingDiarizationSegments;
  assert.equal(row.speaker, "speaker_1");
  assert.equal(row.speakerName, undefined);
});

test("a ranged row moved within the same speaker keeps its name when the new one has none", () => {
  const ctx = harness();
  const row = labelledRow(ctx);
  ctx.applyIdentification(identification("speaker_0", 0, 4000, null));
  assert.equal(row.speaker, "speaker_0");
  assert.equal(row.speakerName, "Zero");
});

test("an unconfirmed ranged row confirmed for the same speaker keeps its name", () => {
  const ctx = harness();
  ctx.store("hello", "system", T, null, true, T + 4000);
  const [row] = ctx.meetingDiarizationSegments;
  Object.assign(row, { speaker: "speaker_0", speakerName: "Zero", speakerStatus: "provisional" });
  ctx.applyIdentification(identification("speaker_0", 0, 4000, null));
  assert.equal(row.speakerStatus, "confirmed");
  assert.equal(row.speakerName, "Zero");
});

test("a ranged row the user locked is never relabelled", () => {
  const ctx = harness();
  const row = labelledRow(ctx);
  Object.assign(row, { speakerLocked: true, speakerLockSource: "user", speakerName: "Zed" });
  ctx.applyIdentification(identification("speaker_1", 1000, 4000, null));
  assert.equal(row.speaker, "speaker_0");
  assert.equal(row.speakerName, "Zed");
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

test("a ranged row stored after a speaker merge is labelled with the kept speaker", () => {
  const ctx = harness([identification("speaker_1", 0, 4000, null)]);
  vm.runInContext("globalThis.remapMergedSpeakers = remapMergedSpeakers;", ctx);
  ctx.remapMergedSpeakers([{ keep: "speaker_0", remove: "speaker_1", displayName: "Ana" }]);
  ctx.store("hello", "system", T, null, true, T + 4000);
  const [row] = ctx.meetingDiarizationSegments;
  assert.equal(row.speaker, "speaker_0");
  assert.equal(row.speakerName, "Ana");
});

test("a merge without a name keeps the identifications' own names", () => {
  const ctx = harness([identification("speaker_1", 0, 4000, "Bo")]);
  vm.runInContext("globalThis.remapMergedSpeakers = remapMergedSpeakers;", ctx);
  ctx.remapMergedSpeakers([{ keep: "speaker_0", remove: "speaker_1", displayName: null }]);
  assert.deepEqual(
    Array.from(ctx.meetingLiveIdentifications, ({ speakerId, displayName }) => [
      speakerId,
      displayName,
    ]),
    [["speaker_0", "Bo"]]
  );
});
