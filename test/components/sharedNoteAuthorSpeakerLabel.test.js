const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer } = require("../lib/rendererTestHarness");

test("MeetingTranscriptChat renders 'You' for owned note and author name or Author for shared note", async (t) => {
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-shared-note-author-",
  });
  const { MeetingTranscriptChat } = await vite.ssrLoadModule(
    "/components/notes/MeetingTranscriptChat.tsx"
  );

  const segments = [
    { id: "s1", text: "Hello team", source: "mic", timestamp: 1, speaker: "you" },
    { id: "s2", text: "Hi there", source: "system", timestamp: 2, speaker: "speaker_0" },
  ];

  // 1. Owned note (default isOwnNote = true): renders "You"
  const ownedMarkup = renderToStaticMarkup(
    React.createElement(MeetingTranscriptChat, {
      segments,
      isOwnNote: true,
    })
  );
  assert.ok(ownedMarkup.includes("notes.speaker.you"), "Owned note renders notes.speaker.you");

  // 2. Shared note with authorName: renders authorName
  const sharedWithAuthorMarkup = renderToStaticMarkup(
    React.createElement(MeetingTranscriptChat, {
      segments,
      isOwnNote: false,
      authorName: "Sarah Connor",
    })
  );
  assert.ok(
    sharedWithAuthorMarkup.includes("Sarah Connor"),
    "Shared note with authorName renders author display name"
  );
  assert.ok(
    !sharedWithAuthorMarkup.includes("notes.speaker.you"),
    "Shared note should not render notes.speaker.you"
  );

  // 3. Shared note without authorName fallback: renders notes.speaker.author
  const sharedFallbackMarkup = renderToStaticMarkup(
    React.createElement(MeetingTranscriptChat, {
      segments,
      isOwnNote: false,
    })
  );
  assert.ok(
    sharedFallbackMarkup.includes("notes.speaker.author"),
    "Shared note without authorName falls back to notes.speaker.author"
  );
  assert.ok(
    !sharedFallbackMarkup.includes("notes.speaker.you"),
    "Shared note fallback should not render notes.speaker.you"
  );
});
