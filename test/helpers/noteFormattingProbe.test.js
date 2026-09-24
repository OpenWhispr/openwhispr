const test = require("node:test");
const assert = require("node:assert/strict");

// The live canary's note probe is only worth its weekly tokens if it sends the
// request the app sends: a meeting-sized transcript in the editor's layout and
// the exact Detailed Notes system prompt.

const load = () => import("../../scripts/lib/note-formatting-probe.mjs");

test("the probe transcript is meeting-sized, deterministic and in the editor's layout", async () => {
  const { buildNoteProbeTranscript, countWords, NOTE_PROBE_MIN_WORDS } = await load();

  const transcript = buildNoteProbeTranscript();
  assert.ok(
    countWords(transcript) >= NOTE_PROBE_MIN_WORDS,
    `expected at least ${NOTE_PROBE_MIN_WORDS} words, got ${countWords(transcript)}`
  );
  assert.equal(transcript, buildNoteProbeTranscript(), "the fixture must not change between runs");
  assert.match(transcript, /^## Meeting Context\n/);
  assert.match(transcript, /\n## Meeting Transcript\n/);
  for (const speaker of ["You", "Priya", "Marcus"]) {
    assert.match(transcript, new RegExp(`\\n${speaker}: `), `${speaker} should have lines`);
  }
  assert.doesNotMatch(transcript, /\{(n|pct|date)\d+\}/, "every placeholder must be filled");
});

test("the probe sends the Detailed Notes prompt exactly as the note store assembles it", async () => {
  const { buildNoteProbeSystemPrompt } = await load();
  const { BUILTIN_ACTIONS, DETAILED_NOTES_KEY, MEETING_INPUT_PREAMBLE } =
    await import("../../src/helpers/builtinActions.js");
  const detailed = BUILTIN_ACTIONS.find((action) => action.translationKey === DETAILED_NOTES_KEY);

  assert.equal(buildNoteProbeSystemPrompt(), MEETING_INPUT_PREAMBLE + detailed.prompt);
});
