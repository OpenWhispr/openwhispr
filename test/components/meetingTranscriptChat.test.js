const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const i18next = require("i18next");
const { initReactI18next } = require("react-i18next");
const { renderStatic } = require("../helpers/harness/reactSsr");

const SEGMENTS = [
  { id: "s1", text: "hello from mic", source: "mic", timestamp: 1 },
  { id: "s2", text: "hi from remote", source: "system", timestamp: 2, speaker: "speaker_0" },
  { id: "s3", text: "second remote line", source: "system", timestamp: 3, speaker: "speaker_0" },
];

async function renderChat(props) {
  if (!i18next.isInitialized) {
    const en = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
    );
    await i18next.use(initReactI18next).init({
      lng: "en",
      resources: { en: { translation: en } },
      interpolation: { escapeValue: false },
    });
  }
  const mod = await import("../../src/components/notes/MeetingTranscriptChat.tsx");
  return renderStatic(mod.MeetingTranscriptChat, { segments: SEGMENTS, ...props });
}

test("rows resolve speaker labels through the live mappings", async () => {
  const unmapped = await renderChat({ speakerMappings: {} });
  assert.ok(unmapped.includes("Speaker 1"), "unmapped cluster shows its numbered label");

  const renamed = await renderChat({ speakerMappings: { speaker_0: "Alice" } });
  assert.ok(renamed.includes("Alice"), "renaming the cluster renames the rows");
  assert.ok(!renamed.includes("Speaker 1"));
});

test("consecutive rows of one speaker collapse the repeat label behind hover", async () => {
  const html = await renderChat({});
  // s3 follows s2 with the same effective speaker key.
  assert.equal(html.split("grid-rows-[0fr]").length - 1, 1);
});

test("selection ring follows selectedSegmentIds", async () => {
  const html = await renderChat({
    selectedSegmentIds: new Set(["s2"]),
    onToggleSelect: () => {},
  });
  assert.equal(html.split("ring-2 ring-primary/60").length - 1, 1);
});

test("a mapped profile without an email offers the add-contact affordance", async () => {
  const html = await renderChat({
    speakerMappings: { speaker_0: "Alice" },
    speakerProfiles: [{ id: 7, display_name: "Alice", email: null }],
    onAttachSpeakerEmail: () => {},
  });
  assert.ok(html.includes("Add contact"));

  const withEmail = await renderChat({
    speakerMappings: { speaker_0: "Alice" },
    speakerProfiles: [{ id: 7, display_name: "Alice", email: "alice@example.com" }],
    onAttachSpeakerEmail: () => {},
  });
  assert.ok(!withEmail.includes("Add contact"));
});

test("a long transcript renders only a window of rows, each animating at most once", async () => {
  const many = Array.from({ length: 500 }, (_, i) => ({
    id: `m${i}`,
    text: `line ${i}`,
    source: "system",
    timestamp: i,
    speaker: `speaker_${i % 3}`,
  }));
  const html = await renderChat({ segments: many });

  const rendered = html.split("data-index=").length - 1;
  assert.ok(rendered > 0, "the first screenful renders before the scroller is measured");
  assert.ok(rendered < 60, `expected a window, got ${rendered} of 500 rows`);
  // A remounting row must not replay its entrance while the list scrolls.
  assert.ok(html.split("agent-message-in").length - 1 <= 1);
});

test("live partials render alongside the settled rows", async () => {
  const html = await renderChat({ micPartial: "still talking" });
  assert.ok(html.includes("still talking"));
  assert.ok(html.includes("hello from mic"));
});

test("an in-person meeting draws numbered mic speakers on the other side", async () => {
  const html = await renderChat({
    segments: [
      { id: "p1", text: "first person", source: "mic", timestamp: 1, speaker: "speaker_0" },
      { id: "p2", text: "second person", source: "mic", timestamp: 2, speaker: "speaker_1" },
      { id: "p3", text: "not diarized", source: "mic", timestamp: 3 },
    ],
  });
  const otherSide = html.split("bg-surface-2 border border-border/70 text-foreground").length - 1;
  const selfSide = html.split("bg-primary/90 text-primary-foreground").length - 1;
  assert.equal(otherSide, 2, "both numbered speakers sit on the other side");
  assert.equal(selfSide, 1, "a mic line without a speaker stays on the user's side");
  assert.ok(html.includes("Speaker 1") && html.includes("Speaker 2"));
});

test("a stretch of the user's lines reassigned to someone gets its own colour", async () => {
  const html = await renderChat({
    segments: [
      { id: "y1", text: "my own line", source: "mic", timestamp: 1, speaker: "you" },
      { id: "r1", text: "remote line", source: "system", timestamp: 2, speaker: "speaker_0" },
      {
        id: "y2",
        text: "actually bob",
        source: "mic",
        timestamp: 3,
        speaker: "you",
        speakerName: "Bob",
        speakerLocked: true,
        speakerLockSource: "user",
        speakerStatus: "locked",
      },
    ],
  });
  assert.equal(
    html.split("border-s-blue-400/50").length - 1,
    1,
    "Speaker 1 keeps the first colour"
  );
  assert.equal(html.split("border-s-green-400/50").length - 1, 1, "Bob gets the next one");
});

test("the recorder's lines carry recorderLabel instead of You on a teammate's note", async () => {
  const segments = [
    { id: "y1", text: "I'll send the deck", source: "mic", timestamp: 1, speaker: "you" },
    {
      id: "y2",
      text: "named on the recorder's device",
      source: "mic",
      timestamp: 2,
      speaker: "speaker_0",
      speakerName: "You",
      speakerLocked: true,
      speakerLockSource: "user",
    },
    { id: "r1", text: "remote line", source: "system", timestamp: 3, speaker: "speaker_1" },
  ];
  const html = await renderChat({ segments, recorderLabel: "Alice Owner" });
  assert.equal(html.split("Alice Owner").length - 1, 2, "both recorder lines name the owner");
  assert.ok(!/>You</.test(html), "no row is labelled You");

  const own = await renderChat({ segments });
  assert.ok(/>You</.test(own), "the user's own note keeps You");
});

test("a You the viewer set in their own mappings still reads You", async () => {
  const html = await renderChat({
    segments: [
      { id: "p1", text: "me in the room", source: "mic", timestamp: 1, speaker: "speaker_0" },
    ],
    speakerMappings: { speaker_0: "You" },
    recorderLabel: "Alice Owner",
  });
  assert.ok(/>You</.test(html));
  assert.ok(!html.includes("Alice Owner"));
});

test("a local self mapping wins over an unlocked stored self name, but not a locked correction", async () => {
  const segment = {
    id: "p1",
    text: "My commitment",
    source: "mic",
    timestamp: 1,
    speaker: "speaker_0",
    speakerName: "You",
    recorderName: "Alice Recorder",
  };
  const props = { speakerMappings: { speaker_0: "You" }, recorderLabel: "Original Recorder" };
  const mapped = await renderChat({ ...props, segments: [segment] });
  assert.match(mapped, />You</);
  assert.ok(!mapped.includes("Alice Recorder"));

  const locked = await renderChat({
    ...props,
    segments: [{ ...segment, speakerLocked: true }],
  });
  assert.ok(locked.includes("Alice Recorder"));
  assert.doesNotMatch(locked, />You</);

  const adjacent = await renderChat({
    ...props,
    segments: [segment, { ...segment, id: "p2", timestamp: 2, speakerLocked: true }],
  });
  assert.match(adjacent, />You</);
  assert.ok(adjacent.includes("Alice Recorder"));
  assert.ok(
    !adjacent.includes("grid-rows-[0fr]"),
    "the recorder's label stays visible after the viewer's line"
  );
});

for (const [recorderName, expectedLabel] of [
  [undefined, "Alice Recorder"],
  ["Carol Recorder", "Carol Recorder"],
  ["ليلى", "ليلى"],
]) {
  test(`stored self suggestions display ${expectedLabel} on a teammate's note`, async () => {
    const html = await renderChat({
      recorderLabel: "Alice Recorder",
      segments: [
        {
          id: "suggested",
          source: "mic",
          speaker: "speaker_0",
          suggestedName: "You",
          suggestedProfileId: 7,
          recorderName,
          text: "Recorder's words",
        },
      ],
    });
    assert.match(html, new RegExp(`<span dir="auto"[^>]*>${expectedLabel}</span>`));
    assert.doesNotMatch(html, />You</);
  });
}

test("a later recorder's mic lines retain their name in the shared transcript", async () => {
  const html = await renderChat({
    recorderLabel: "Alice Owner",
    segments: [
      {
        id: "bob",
        source: "mic",
        text: "My new recording",
        timestamp: 1,
        recorderName: "Bob Viewer",
      },
    ],
  });
  assert.ok(html.includes("Bob Viewer"));
  assert.ok(!html.includes("Alice Owner"));
});

test("a correction of an unnumbered recorder line overrides its session identity", async () => {
  const html = await renderChat({
    recorderLabel: "Alice Owner",
    segments: [
      {
        id: "bob",
        source: "mic",
        text: "Corrected",
        timestamp: 1,
        recorderName: "Bob Viewer",
        speakerName: "Alice Owner",
        speakerLocked: true,
      },
    ],
  });
  assert.ok(html.includes("Alice Owner"));
  assert.ok(!html.includes("Bob Viewer"));
});

test("original unnumbered mic rows show the resolved recorder and preserve named corrections", async () => {
  const segments = [{ id: "original", source: "mic", text: "Original words", timestamp: 1 }];
  const shared = await renderChat({ segments, recorderLabel: "Alice Recorder" });
  assert.ok(shared.includes("Alice Recorder"));
  const own = await renderChat({ segments });
  assert.match(own, />You</);
  const corrected = await renderChat({
    segments: [{ ...segments[0], speakerName: "Corrected", speakerLocked: true }],
    recorderLabel: "Alice Recorder",
  });
  assert.ok(corrected.includes("Corrected"));
  assert.ok(!corrected.includes("Alice Recorder"));
});
