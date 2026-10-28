const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/noteRecorder.ts");
const loadTranscript = () => import("../../src/utils/llmTranscript.ts");

const t = (key, options) => {
  if (key === "notes.speaker.label") return `Speaker ${options.n}`;
  if (key === "notes.speaker.them") return "Them";
  if (key === "notes.speaker.you") return "You";
  if (key === "notes.speaker.noteTaker") return "Note taker";
  return key;
};

const attendee = (email, displayName, self = false) => ({
  email,
  displayName,
  responseStatus: null,
  self,
});

const viewer = { name: "Bob Viewer", email: "bob@acme.com" };
const owner = { name: "Alice Owner", email: "alice@acme.com" };

test("the user's own note is recorded by the user", async () => {
  const { resolveNoteRecorder, recorderTranscriptLabel, recorderLlmLabel } = await load();
  const recorder = resolveNoteRecorder({
    ownNote: true,
    user: { name: " Bob Viewer ", email: "bob@acme.com" },
    owner: null,
    participants: [],
  });
  assert.deepEqual(recorder, {
    selfName: "Bob Viewer",
    selfEmail: "bob@acme.com",
    participants: [],
  });
  assert.equal(recorderTranscriptLabel(recorder, true, t), "You");
  assert.equal(recorderLlmLabel(recorder, true, t), "Bob Viewer");
  assert.equal(
    recorderLlmLabel({ selfName: null, selfEmail: null, participants: [] }, true, t),
    "You"
  );
});

test("a teammate's note is recorded by its owner, never the viewer", async () => {
  const { resolveNoteRecorder, recorderTranscriptLabel, recorderLlmLabel } = await load();
  const recorder = resolveNoteRecorder({ ownNote: false, user: viewer, owner, participants: [] });
  assert.equal(recorder.selfName, "Alice Owner");
  assert.equal(recorder.selfEmail, "alice@acme.com");
  assert.equal(recorderTranscriptLabel(recorder, false, t), "Alice Owner");
  assert.equal(recorderLlmLabel(recorder, false, t), "Alice Owner");

  const nameless = resolveNoteRecorder({
    ownNote: false,
    user: viewer,
    owner: { name: null, email: "alice@acme.com" },
    participants: [],
  });
  assert.equal(recorderTranscriptLabel(nameless, false, t), "alice@acme.com");
});

test("without a roster entry, the attendee the recorder's calendar flagged names them", async () => {
  const { resolveNoteRecorder, recorderTranscriptLabel } = await load();
  const participants = [
    attendee("alice@acme.com", "Alice Owner", true),
    attendee("bob@acme.com", "Bob Viewer"),
  ];
  const recorder = resolveNoteRecorder({ ownNote: false, user: viewer, owner: null, participants });
  assert.equal(recorder.selfName, "Alice Owner");
  assert.equal(recorder.selfEmail, "alice@acme.com");
  assert.equal(recorderTranscriptLabel(recorder, false, t), "Alice Owner");
});

test("an unknown recorder is the note taker, not You", async () => {
  const { resolveNoteRecorder, recorderTranscriptLabel, recorderLlmLabel } = await load();
  const recorder = resolveNoteRecorder({
    ownNote: false,
    user: viewer,
    owner: null,
    participants: [],
  });
  assert.deepEqual(recorder, { selfName: null, selfEmail: null, participants: [] });
  assert.equal(recorderTranscriptLabel(recorder, false, t), "Note taker");
  assert.equal(recorderLlmLabel(recorder, false, t), "Note taker");
});

test("note generation on a teammate's note attributes the mic to the owner and lists the viewer as invited", async () => {
  const { resolveNoteRecorder, recorderLlmLabel } = await load();
  const { buildLlmTranscript, buildMeetingContext, collectKnownPeople } = await loadTranscript();
  const participants = [
    attendee("alice@acme.com", "Alice Owner", true),
    attendee("bob@acme.com", "Bob Viewer"),
  ];
  const recorder = resolveNoteRecorder({ ownNote: false, user: viewer, owner, participants });
  const label = recorderLlmLabel(recorder, false, t);
  const segments = [
    { source: "mic", speaker: "you", text: "I'll send the deck." },
    { source: "system", speaker: "speaker_0", text: "Thanks." },
  ];

  assert.equal(
    buildLlmTranscript(segments, { speaker_0: "Bob Viewer" }, label, t),
    "Alice Owner: I'll send the deck.\nBob Viewer: Thanks."
  );
  assert.equal(
    buildMeetingContext(recorder, label),
    [
      "## Meeting Context",
      'The note owner ("Alice Owner" in the transcript) is Alice Owner <alice@acme.com>.',
      "Invited participants: Bob Viewer <bob@acme.com>.",
    ].join("\n")
  );
  assert.deepEqual(collectKnownPeople(recorder, {}, []), [
    { name: "Alice Owner", email: "alice@acme.com" },
    { name: "Bob Viewer", email: "bob@acme.com" },
  ]);
});

test("new recording attribution follows the viewer only on somebody else's note", async () => {
  const { recordingRecorderName, resolveSpeakerAssignmentName } = await load();
  const user = { id: "bob", ...viewer };
  assert.equal(
    recordingRecorderName({ cloud_id: "cloud", owner_user_id: "alice" }, user, t),
    "Bob Viewer"
  );
  assert.equal(
    recordingRecorderName({ cloud_id: "cloud", owner_user_id: "bob" }, user, t),
    undefined
  );
  assert.equal(recordingRecorderName({ cloud_id: null, owner_user_id: null }, user, t), undefined);
  assert.equal(
    resolveSpeakerAssignmentName("You", { email: "bob@acme.com" }, false, t),
    "bob@acme.com"
  );
  assert.equal(resolveSpeakerAssignmentName("You", null, false, t), "Note taker");
  assert.equal(resolveSpeakerAssignmentName("You", user, true, t), "You");
  assert.equal(resolveSpeakerAssignmentName("Alice", user, false, t), "Alice");
});
