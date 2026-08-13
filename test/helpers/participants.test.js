const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

let loaded;
const load = () => {
  if (!loaded) {
    const filename = path.join(__dirname, "../../src/utils/participants.ts");
    const source = fs.readFileSync(filename, "utf8");
    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    loaded = import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
  }
  return loaded;
};

test("participant rosters derive total speakers from non-self attendees plus the recorder", async () => {
  const { resolveParticipantExpectedSpeakerCount } = await load();
  const participants = [
    { email: "recorder@example.com", self: true },
    { email: "one@example.com", self: false },
    { email: "two@example.com" },
  ];

  assert.equal(resolveParticipantExpectedSpeakerCount(participants), 3);
  assert.equal(resolveParticipantExpectedSpeakerCount([participants[0]]), null);
  assert.equal(resolveParticipantExpectedSpeakerCount([]), null);
});

test("active participant changes synchronize the session count before a manual override", async () => {
  const { resolveParticipantSpeakerCountSync } = await load();

  assert.equal(
    resolveParticipantSpeakerCountSync({
      recordingNoteId: 42,
      noteId: 42,
      userTouchedStepper: false,
      currentExpectedCount: 2,
      participants: [
        { email: "one@example.com", self: false },
        { email: "two@example.com", self: false },
      ],
    }),
    3
  );
});

test("participant changes do not override another recording, a manual count, or an unchanged count", async () => {
  const { resolveParticipantSpeakerCountSync } = await load();
  const participants = [
    { email: "one@example.com", self: false },
    { email: "two@example.com", self: false },
  ];

  assert.equal(
    resolveParticipantSpeakerCountSync({
      recordingNoteId: 7,
      noteId: 42,
      userTouchedStepper: false,
      currentExpectedCount: 2,
      participants,
    }),
    null
  );
  assert.equal(
    resolveParticipantSpeakerCountSync({
      recordingNoteId: 42,
      noteId: 42,
      userTouchedStepper: true,
      currentExpectedCount: 2,
      participants,
    }),
    null
  );
  assert.equal(
    resolveParticipantSpeakerCountSync({
      recordingNoteId: 42,
      noteId: 42,
      userTouchedStepper: false,
      currentExpectedCount: 3,
      participants,
    }),
    null
  );
});

// A roster that shrinks mid-recording must not pull the cap below the speakers
// already discovered — that would fold later voices onto an existing speaker.
test("a shrinking roster never lowers the session count", async () => {
  const { resolveParticipantSpeakerCountSync } = await load();
  const base = { recordingNoteId: 42, noteId: 42, userTouchedStepper: false };

  assert.equal(
    resolveParticipantSpeakerCountSync({
      ...base,
      currentExpectedCount: 4,
      participants: [{ email: "one@example.com", self: false }],
    }),
    null
  );
  assert.equal(
    resolveParticipantSpeakerCountSync({ ...base, currentExpectedCount: 4, participants: [] }),
    null
  );
});

test("participant-derived startup counts remain eligible for roster synchronization", async () => {
  const { resolveInitialSpeakerCountOverride } = await load();

  assert.equal(resolveInitialSpeakerCountOverride(3, false), false);
  assert.equal(resolveInitialSpeakerCountOverride(3, true), true);
  assert.equal(resolveInitialSpeakerCountOverride(3), true);
  assert.equal(resolveInitialSpeakerCountOverride(null), false);
});
