const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/llmTranscript.ts");

const t = (key, options) => {
  if (key === "notes.speaker.label") return `Speaker ${options.n}`;
  if (key === "notes.speaker.them") return "Them";
  if (key === "notes.speaker.you") return "You";
  return key;
};

const attendee = (email, displayName, self = false) => ({
  email,
  displayName,
  responseStatus: null,
  self,
});

test("mic segments carry the note owner's label", async () => {
  const { resolveLlmSpeakerLabel } = await load();
  assert.equal(
    resolveLlmSpeakerLabel({ source: "mic", text: "hi" }, {}, "Gabriel Stein", t),
    "Gabriel Stein"
  );
  assert.equal(
    resolveLlmSpeakerLabel(
      { source: "system", speaker: "you", text: "hi" },
      {},
      "Gabriel Stein",
      t
    ),
    "Gabriel Stein"
  );
});

test("manual speaker corrections override the microphone's assumed note owner", async () => {
  const { resolveLlmSpeakerLabel } = await load();
  for (const speaker of ["speaker_0", "you"]) {
    const segment = {
      source: "mic",
      speaker,
      speakerName: "Ravi Patel",
      speakerLocked: true,
      speakerStatus: "locked",
      speakerLockSource: "user",
      speakerIsPlaceholder: false,
      text: "I will send the proposal.",
    };
    assert.equal(
      resolveLlmSpeakerLabel(segment, { [speaker]: "Old name" }, "Casey", t),
      "Ravi Patel"
    );
  }
});

test("a renamed microphone cluster reaches note generation without per-segment names", async () => {
  const { buildLlmTranscript } = await load();
  const segment = {
    source: "mic",
    speaker: "speaker_0",
    timestamp: 123,
    speakerStatus: "confirmed",
    speakerIsPlaceholder: false,
    speakerLocked: false,
    text: "I will send the proposal.",
  };
  assert.equal(
    buildLlmTranscript([segment], { speaker_0: "Ravi Patel" }, "Casey", t),
    "Ravi Patel: I will send the proposal."
  );
  assert.equal(buildLlmTranscript([segment], {}, "Casey", t), "Casey: I will send the proposal.");
  assert.equal(
    buildLlmTranscript([segment], { speaker_0: " you " }, "Casey", t),
    "Casey: I will send the proposal."
  );
});

test("system segments resolve name → mapping → Speaker N → Them", async () => {
  const { resolveLlmSpeakerLabel } = await load();
  const locked = {
    source: "system",
    speaker: "speaker_0",
    speakerName: "Michael",
    speakerLocked: true,
    text: "hi",
  };
  assert.equal(resolveLlmSpeakerLabel(locked, { speaker_0: "Wrong" }, "You", t), "Michael");
  assert.equal(
    resolveLlmSpeakerLabel(
      { source: "system", speaker: "speaker_1", text: "hi" },
      { speaker_1: "Sean" },
      "You",
      t
    ),
    "Sean"
  );
  assert.equal(
    resolveLlmSpeakerLabel({ source: "system", speaker: "speaker_2", text: "hi" }, {}, "You", t),
    "Speaker 3"
  );
  assert.equal(resolveLlmSpeakerLabel({ source: "system", text: "hi" }, {}, "You", t), "Them");
});

test("buildLlmTranscript prefixes every line with the resolved label", async () => {
  const { buildLlmTranscript } = await load();
  const segments = [
    { source: "mic", text: "Morning everyone" },
    { source: "system", speaker: "speaker_0", text: "Morning" },
  ];
  assert.equal(
    buildLlmTranscript(segments, { speaker_0: "Michael" }, "Gabriel", t),
    "Gabriel: Morning everyone\nMichael: Morning"
  );
});

test("buildMeetingContext names the owner and invited participants", async () => {
  const { buildMeetingContext } = await load();
  const identity = {
    selfName: "Gabriel Stein",
    selfEmail: "gabe@openwhispr.com",
    participants: [
      attendee("gabe@openwhispr.com", "Gabriel Stein", true),
      attendee("michael@acme.com", "Michael Chen"),
      attendee("sean@acme.com", null),
    ],
  };
  assert.equal(
    buildMeetingContext(identity, "Gabriel Stein"),
    [
      "## Meeting Context",
      'The user taking these notes ("Gabriel Stein" in the transcript) is Gabriel Stein <gabe@openwhispr.com>.',
      "Invited participants: Michael Chen <michael@acme.com>, sean@acme.com.",
    ].join("\n")
  );
});

test("buildMeetingContext omits what it does not know", async () => {
  const { buildMeetingContext } = await load();
  assert.equal(
    buildMeetingContext({ selfName: null, selfEmail: null, participants: [] }, "You"),
    ""
  );
  assert.equal(
    buildMeetingContext(
      { selfName: null, selfEmail: null, participants: [attendee("a@b.com", "Ada")] },
      "You"
    ),
    "## Meeting Context\nInvited participants: Ada <a@b.com>."
  );
});

test("collectKnownPeople merges owner, participants, mappings, and named segments", async () => {
  const { collectKnownPeople } = await load();
  const people = collectKnownPeople(
    {
      selfName: "Gabriel Stein",
      selfEmail: "gabe@openwhispr.com",
      participants: [
        attendee("gabe@openwhispr.com", "Gabriel Stein", true),
        attendee("michael@acme.com", "Michael Chen"),
        attendee("sean@acme.com", null),
      ],
    },
    { speaker_0: "Michael Chen", speaker_1: "Priya" },
    [{ source: "system", speaker: "speaker_2", speakerName: "Ada", text: "hi" }]
  );
  assert.deepEqual(people, [
    { name: "Gabriel Stein", email: "gabe@openwhispr.com" },
    { name: "Michael Chen", email: "michael@acme.com" },
    { name: "sean", email: "sean@acme.com" },
    { name: "Priya", email: null },
    { name: "Ada", email: null },
  ]);
});

test("collectKnownPeople keeps same-name attendees with different email identities", async () => {
  const { collectKnownPeople } = await load();
  const participants = [
    attendee("alex.design@example.test", "Alex Morgan"),
    attendee("alex.engineering@example.test", "Alex Morgan"),
    attendee("ALEX.DESIGN@example.test", "Alex Morgan"),
  ];
  const people = collectKnownPeople(
    { selfName: "Casey", selfEmail: "casey@example.test", participants },
    { speaker_0: "Alex Morgan" },
    [{ source: "system", speakerName: "Alex Morgan", text: "I will send the proposal." }]
  );
  assert.deepEqual(people, [
    { name: "Casey", email: "casey@example.test" },
    { name: "Alex Morgan", email: "alex.design@example.test" },
    { name: "Alex Morgan", email: "alex.engineering@example.test" },
  ]);
});

test("first-name owners resolve to a unique attendee while explicit short labels retain their identity", async () => {
  const { collectKnownPeople } = await load();
  const { tagActionItemOwners } = await import("../../src/utils/mentionMarkdown.ts");
  const identity = {
    selfName: null,
    selfEmail: null,
    participants: [attendee("ravi@example.test", "Ravi Patel")],
  };
  const line = "- [ ] Send the proposal — Ravi";
  assert.equal(
    tagActionItemOwners(line, collectKnownPeople(identity, { speaker_0: "Ravi Patel" }, [])),
    "- [ ] Send the proposal — [@Ravi Patel](mention:ravi%40example.test)"
  );
  assert.equal(
    tagActionItemOwners(line, collectKnownPeople(identity, { speaker_0: " Ravi  Patel " }, [])),
    "- [ ] Send the proposal — [@Ravi Patel](mention:ravi%40example.test)"
  );
  // A name-only label is not evidence that it belongs to the similarly named invitee.
  assert.equal(
    tagActionItemOwners(line, collectKnownPeople(identity, { speaker_0: "Ravi" }, [])),
    "- [ ] Send the proposal — [@Ravi](mention:Ravi)"
  );
});

test("an owner without an email stays distinct from a same-name invitee", async () => {
  const { collectKnownPeople } = await load();
  const { tagActionItemOwners } = await import("../../src/utils/mentionMarkdown.ts");
  const people = collectKnownPeople(
    {
      selfName: "Alex Morgan",
      selfEmail: null,
      participants: [attendee("alex.other@example.test", "Alex Morgan")],
    },
    {},
    []
  );
  assert.deepEqual(people, [
    { name: "Alex Morgan", email: null },
    { name: "Alex Morgan", email: "alex.other@example.test" },
  ]);
  const line = "- [ ] Send the proposal — Alex Morgan";
  assert.equal(tagActionItemOwners(line, people), line);
});
