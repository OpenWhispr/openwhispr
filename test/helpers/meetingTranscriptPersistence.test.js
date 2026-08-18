const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/meetingTranscriptPersistence.ts");

const segment = (id, text) => ({ id, text, source: "system" });

test("buildFinalMeetingTranscript serializes segments when any exist", async () => {
  const { buildFinalMeetingTranscript } = await load();
  const segments = [segment("a", "hello")];

  assert.equal(
    buildFinalMeetingTranscript(segments, "fallback", (s) => JSON.stringify(s)),
    JSON.stringify(segments)
  );
});

test("buildFinalMeetingTranscript falls back to the plain transcript, then null", async () => {
  const { buildFinalMeetingTranscript } = await load();
  const serialize = () => {
    throw new Error("must not serialize an empty segment list");
  };

  assert.equal(buildFinalMeetingTranscript([], "plain text", serialize), "plain text");
  assert.equal(buildFinalMeetingTranscript([], "", serialize), null);
});
