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
  assert.equal(resolveLlmSpeakerLabel({ source: "mic", text: "hi" }, {}, "Gabriel Stein", t), "Gabriel Stein");
  assert.equal(
    resolveLlmSpeakerLabel({ source: "system", speaker: "you", text: "hi" }, {}, "Gabriel Stein", t),
    "Gabriel Stein"
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
    resolveLlmSpeakerLabel({ source: "system", speaker: "speaker_1", text: "hi" }, { speaker_1: "Sean" }, "You", t),
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
  assert.equal(buildMeetingContext({ selfName: null, selfEmail: null, participants: [] }, "You"), "");
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
