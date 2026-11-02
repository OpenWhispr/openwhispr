const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/transcriptSpeakerState.ts");

const YOU = "You";

const userLocked = (segment, speakerName) => ({
  ...segment,
  speakerName,
  speakerLocked: true,
  speakerLockSource: "user",
  speakerStatus: "locked",
});

test("a remote call keeps the mic on the user's side", async () => {
  const { isSelfSideSegment } = await load();
  assert.equal(isSelfSideSegment({ source: "mic", speaker: "you" }, {}, YOU), true);
  assert.equal(isSelfSideSegment({ source: "system", speaker: "speaker_0" }, {}, YOU), false);
});

test("an in-person meeting puts numbered mic clusters on the other side", async () => {
  const { isSelfSideSegment } = await load();
  assert.equal(isSelfSideSegment({ source: "mic", speaker: "speaker_0" }, {}, YOU), false);
  assert.equal(isSelfSideSegment({ source: "mic", speaker: "speaker_1" }, {}, YOU), false);
});

test("an undiarized mic stays on the user's side", async () => {
  const { isSelfSideSegment } = await load();
  assert.equal(isSelfSideSegment({ source: "mic" }, undefined, YOU), true);
  assert.equal(isSelfSideSegment({ source: "system" }, undefined, YOU), false);
});

test("naming a cluster You moves it to the user's side, any other name moves it off", async () => {
  const { isSelfSideSegment } = await load();
  assert.equal(
    isSelfSideSegment({ source: "mic", speaker: "speaker_1" }, { speaker_1: " you " }, YOU),
    true
  );
  assert.equal(isSelfSideSegment({ source: "mic", speaker: "you" }, { you: "Alice" }, YOU), false);
});

test("a recognized name decides the side like the chip does", async () => {
  const { isSelfSideSegment } = await load();
  assert.equal(isSelfSideSegment({ source: "mic", speakerName: "Alice" }, {}, YOU), false);
  // A voice profile named You recognizes the user without writing a mapping.
  assert.equal(
    isSelfSideSegment({ source: "mic", speaker: "speaker_0", speakerName: "You" }, {}, YOU),
    true
  );
  assert.equal(
    isSelfSideSegment(
      { source: "mic", speaker: "speaker_0", speakerName: "You" },
      { speaker_0: "Alice" },
      YOU
    ),
    false
  );
});

test("a reassigned stretch follows its new name over the cluster mapping", async () => {
  const { isSelfSideSegment } = await load();
  const cluster = { source: "mic", speaker: "speaker_0" };
  assert.equal(isSelfSideSegment(userLocked(cluster, "Bob"), { speaker_0: "You" }, YOU), false);
  assert.equal(isSelfSideSegment(userLocked(cluster, "You"), { speaker_0: "Alice" }, YOU), true);
  assert.equal(isSelfSideSegment(userLocked(cluster, "You"), {}, YOU), true);
});

test("a You suggestion sits on the user's side until it is confirmed or dismissed", async () => {
  const { isSelfSideSegment } = await load();
  assert.equal(
    isSelfSideSegment({ source: "mic", speaker: "speaker_0", suggestedName: "You" }, {}, YOU),
    true
  );
  assert.equal(
    isSelfSideSegment({ source: "mic", speaker: "speaker_0", suggestedName: "Alice" }, {}, YOU),
    false
  );
  // A confirmed or mapped name outranks the suggestion, as it does on the chip.
  assert.equal(
    isSelfSideSegment(
      { source: "mic", speaker: "speaker_0", suggestedName: "You" },
      { speaker_0: "Alice" },
      YOU
    ),
    false
  );
});

test("a You saved in another UI language still counts as the user", async () => {
  const { isSelfSideSegment } = await load();
  const cluster = { source: "mic", speaker: "speaker_0" };
  assert.equal(isSelfSideSegment(cluster, { speaker_0: "You" }, "Du"), true);
  assert.equal(isSelfSideSegment(cluster, { speaker_0: "Du" }, "Du"), true);
  assert.equal(isSelfSideSegment(cluster, { speaker_0: "Youssef" }, "Du"), false);
});

test("a remote voice matched to the user's voice profile stays on the other side", async () => {
  const { isSelfSideSegment } = await load();
  const remote = { source: "system", speaker: "speaker_0" };
  assert.equal(isSelfSideSegment({ ...remote, suggestedName: "You" }, {}, YOU), false);
  assert.equal(isSelfSideSegment({ ...remote, speakerName: "You" }, {}, YOU), false);
  // An automatic match can write a mapping too, so only the user's lock moves it.
  assert.equal(isSelfSideSegment(remote, { speaker_0: "You" }, YOU), false);
  assert.equal(isSelfSideSegment(userLocked(remote, "You"), {}, YOU), true);
});
