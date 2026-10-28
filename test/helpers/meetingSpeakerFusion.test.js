const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CAPTION_LAG_MS,
  createMeetingSpeakerFusion,
} = require("../../src/helpers/meetingSpeakerFusion");

const T0 = 1_700_000_000_000;
const JANE = { id: "jane", name: "Jane Doe" };
const OMAR = { id: "omar", name: "Omar Haddad" };
const ME = { id: "me", name: "Gabe", isSelf: true };

// Plays the meeting app's speaking indicator: each turn is [speaking ids, from,
// to] in ms after T0, in order.
function highlight(fusion, turns, roster = [JANE, OMAR]) {
  for (const [ids, from, to] of turns) {
    fusion.recordAppState({ at: T0 + from, participants: roster, speakingIds: ids });
    fusion.recordAppState({ at: T0 + to, participants: roster, speakingIds: [] });
  }
}

function identify(fusion, speakerId, from, to, displayName = null) {
  return fusion.observeIdentification({
    speakerId,
    displayName,
    startTime: T0 + from,
    endTime: T0 + to,
  });
}

test("names an unnamed voice once its speech lines up with one participant", () => {
  const fusion = createMeetingSpeakerFusion();
  highlight(fusion, [[["jane"], 0, 10_000]]);

  assert.equal(identify(fusion, "speaker_0", 0, 2_000), null);
  assert.equal(identify(fusion, "speaker_0", 2_500, 4_000), null);
  assert.deepEqual(identify(fusion, "speaker_0", 4_500, 6_000), {
    speakerId: "speaker_0",
    participantId: "jane",
    displayName: "Jane Doe",
  });
  // Named: later agreeing speech arrives with that name and changes nothing.
  assert.equal(identify(fusion, "speaker_0", 6_500, 8_000, "Jane Doe"), null);
});

test("re-identified growing windows of one utterance count each moment once", () => {
  const fusion = createMeetingSpeakerFusion();
  highlight(fusion, [[["jane"], 0, 10_000]]);

  // The windows sum to 7.5 s but cover 3.5 s of speech: still under the floor.
  for (const end of [1_500, 2_500, 3_500]) {
    assert.equal(identify(fusion, "speaker_0", 0, end), null);
  }
  assert.equal(identify(fusion, "speaker_0", 0, 4_500)?.displayName, "Jane Doe");
});

test("never renames a voice another source already named", () => {
  const fusion = createMeetingSpeakerFusion();
  highlight(fusion, [[["jane"], 0, 20_000]]);

  for (let at = 0; at < 18_000; at += 2_000) {
    assert.equal(identify(fusion, "speaker_0", at, at + 1_500, "Bob (voice profile)"), null);
  }
});

test("lets go of a voice the user renames after the meeting app named it", () => {
  const fusion = createMeetingSpeakerFusion();
  highlight(fusion, [[["jane"], 0, 30_000]]);
  identify(fusion, "speaker_0", 0, 2_000);
  assert.equal(identify(fusion, "speaker_0", 2_000, 5_000)?.displayName, "Jane Doe");

  for (let at = 5_000; at < 28_000; at += 2_000) {
    assert.equal(identify(fusion, "speaker_0", at, at + 1_500, "Janie"), null);
  }
  assert.equal(fusion.summarize().namedClusters, 0);
});

test("crosstalk casts no vote", () => {
  const fusion = createMeetingSpeakerFusion();
  highlight(fusion, [[["jane", "omar"], 0, 20_000]]);

  for (let at = 0; at < 18_000; at += 2_000) {
    assert.equal(identify(fusion, "speaker_0", at, at + 1_500), null);
  }
});

test("a participant who stopped speaking collects no votes", () => {
  const fusion = createMeetingSpeakerFusion();
  highlight(fusion, [[["jane"], 0, 1_000]]);

  for (let at = 1_500; at < 15_000; at += 2_000) {
    assert.equal(identify(fusion, "speaker_0", at, at + 1_500), null);
  }
});

test("the user's own tile never names a remote voice", () => {
  const fusion = createMeetingSpeakerFusion();
  highlight(fusion, [[["me"], 0, 20_000]], [ME, JANE]);

  for (let at = 0; at < 18_000; at += 2_000) {
    assert.equal(identify(fusion, "speaker_0", at, at + 1_500), null);
  }
});

test("stays the user once marked, after the app stops marking them", () => {
  const fusion = createMeetingSpeakerFusion();
  fusion.recordAppState({ at: T0, participants: [ME, JANE], speakingIds: [] });
  // Zoom's home window closed: the user's tile is still there, unmarked.
  highlight(fusion, [[["me"], 0, 20_000]], [{ id: "me", name: "Gabe" }, JANE]);

  for (let at = 0; at < 18_000; at += 2_000) {
    assert.equal(identify(fusion, "speaker_0", at, at + 1_500), null);
  }
});

test("a highlight that trails the audio lines up once its lag is compensated", () => {
  // Omar and Jane alternate 5 s turns; the app highlights each 1.5 s late, so
  // every turn of Jane's opens on Omar's still-lit tile.
  const audioTurns = [
    ["omar", 0],
    ["jane", 5_000],
    ["omar", 10_000],
    ["jane", 15_000],
    ["omar", 20_000],
    ["jane", 25_000],
  ];
  const run = (lagMs) => {
    const fusion = createMeetingSpeakerFusion({ lagMs });
    highlight(
      fusion,
      audioTurns.map(([id, from]) => [[id], from + 1_500, from + 6_500])
    );
    const namings = [];
    for (const [id, from] of audioTurns) {
      if (id !== "jane") continue;
      for (let at = from; at + 1_600 <= from + 5_000; at += 1_600) {
        const naming = identify(fusion, "speaker_1", at, at + 1_600);
        if (naming) namings.push(naming.displayName);
      }
    }
    return namings;
  };

  assert.deepEqual(run(1_500), ["Jane Doe"]);
  // Uncompensated, the late highlight splits Jane's long turns' votes and
  // nothing is named. Short turns can still lean on the wrong tile; the
  // one-name-per-voice rule below keeps that from naming her Omar.
  assert.deepEqual(run(0), []);
});

test("one name per voice: a highlight that lingers lends nobody its name", () => {
  // Omar's tile stays lit through his monologue while Jane says "yeah" now
  // and then: her votes all land on Omar.
  const fusion = createMeetingSpeakerFusion();
  highlight(fusion, [[["omar"], 0, 60_000]]);

  assert.equal(identify(fusion, "speaker_0", 0, 2_500), null);
  assert.equal(identify(fusion, "speaker_0", 2_500, 5_000)?.displayName, "Omar Haddad");
  for (let at = 6_000; at < 50_000; at += 4_000) {
    assert.equal(identify(fusion, "speaker_1", at, at + 1_000), null);
  }
});

test("the user's tile stops counting once marked, even for late windows", () => {
  const fusion = createMeetingSpeakerFusion();
  // The user's tile was lit for 6 s before anything marked it as theirs.
  highlight(fusion, [[["me"], 0, 6_000]], [{ id: "me", name: "Gabe" }, JANE]);
  identify(fusion, "speaker_0", 0, 1_500);
  fusion.recordAppState({ at: T0 + 6_500, participants: [ME, JANE], speakingIds: [] });
  // A window arriving late, over the time the tile was lit, adds nothing...
  assert.equal(identify(fusion, "speaker_0", 1_500, 6_000), null);
  // ...so Jane's speech holds the majority it would have had.
  highlight(fusion, [[["jane"], 7_000, 12_000]], [ME, JANE]);
  let naming = null;
  for (let at = 7_000; at < 12_000 && !naming; at += 1_500) {
    naming = identify(fusion, "speaker_0", at, at + 1_500);
  }
  assert.equal(naming?.displayName, "Jane Doe");
});

test("a voice the user names frees its participant at once", () => {
  const fusion = createMeetingSpeakerFusion();
  highlight(fusion, [[["jane"], 0, 30_000]]);
  assert.equal(identify(fusion, "speaker_0", 0, 4_500)?.displayName, "Jane Doe");
  fusion.release("speaker_0");

  // Jane's real voice takes her name before the renamed one speaks again...
  assert.equal(identify(fusion, "speaker_1", 10_000, 14_500)?.displayName, "Jane Doe");
  // ...and the user's own name for the first is never replaced.
  assert.equal(identify(fusion, "speaker_0", 15_000, 19_000, "Janet"), null);
});

test("a name the user confirms in the app's own wording still releases the voice", () => {
  const fusion = createMeetingSpeakerFusion();
  highlight(fusion, [
    [["jane"], 0, 6_000],
    [["omar"], 10_000, 60_000],
  ]);
  assert.equal(identify(fusion, "speaker_0", 0, 4_500)?.displayName, "Jane Doe");
  for (let at = 10_000; at < 60_000; at += 1_500) {
    const naming = fusion.observeIdentification({
      speakerId: "speaker_0",
      displayName: "Jane Doe",
      nameFromMeetingApp: false,
      startTime: T0 + at,
      endTime: T0 + at + 1_500,
    });
    assert.equal(naming, null);
  }
});

test("caption intervals are moved back by the caption lag", () => {
  // Captions show Jane from 1.5 s after she starts until 1.5 s after she stops.
  const fusion = createMeetingSpeakerFusion();
  fusion.recordAppState({
    at: T0 + CAPTION_LAG_MS,
    participants: [JANE, OMAR],
    speakingIds: ["jane"],
    strategy: "captions",
  });
  fusion.recordAppState({
    at: T0 + 5_000 + CAPTION_LAG_MS,
    participants: [JANE, OMAR],
    speakingIds: [],
    strategy: "captions",
  });
  assert.equal(identify(fusion, "speaker_0", 0, 2_000), null);
  assert.equal(identify(fusion, "speaker_0", 2_000, 4_500)?.displayName, "Jane Doe");
});

test("moving a name to another participant needs a majority of the history", () => {
  const fusion = createMeetingSpeakerFusion();
  highlight(fusion, [
    [["jane"], 0, 6_000],
    [["omar"], 10_000, 40_000],
  ]);
  identify(fusion, "speaker_0", 0, 2_500);
  assert.equal(identify(fusion, "speaker_0", 2_500, 5_000)?.displayName, "Jane Doe");

  // 6 s of Omar against 5 s of Jane is not a majority.
  for (let at = 10_000; at < 16_000; at += 1_500) {
    assert.equal(identify(fusion, "speaker_0", at, at + 1_500, "Jane Doe"), null);
  }
  let naming = null;
  for (let at = 16_000; at < 40_000 && !naming; at += 1_500) {
    naming = identify(fusion, "speaker_0", at, at + 1_500, "Jane Doe");
  }
  assert.deepEqual(naming, {
    speakerId: "speaker_0",
    participantId: "omar",
    displayName: "Omar Haddad",
  });
});

test("follows a participant's rename in the meeting app", () => {
  const fusion = createMeetingSpeakerFusion();
  highlight(fusion, [[["jane"], 0, 5_000]]);
  assert.equal(identify(fusion, "speaker_0", 0, 4_500)?.displayName, "Jane Doe");

  const renamed = { id: "jane", name: "Jane D." };
  highlight(fusion, [[["jane"], 6_000, 12_000]], [renamed, OMAR]);
  assert.equal(identify(fusion, "speaker_0", 6_000, 7_500, "Jane Doe")?.displayName, "Jane D.");
  // The identifier keeps an utterance's first name until it ends; a window
  // still carrying the old name is the fusion's own, not another source's.
  assert.equal(identify(fusion, "speaker_0", 7_500, 9_000, "Jane Doe"), null);
  assert.equal(identify(fusion, "speaker_0", 9_000, 10_500, "Jane D."), null);
  assert.equal(fusion.summarize().namedClusters, 1);
});

test("merges carry votes to the kept voice", () => {
  const fusion = createMeetingSpeakerFusion();
  highlight(fusion, [[["jane"], 0, 10_000]]);
  assert.equal(identify(fusion, "speaker_0", 0, 2_500), null);
  assert.equal(identify(fusion, "speaker_1", 3_000, 5_000), null);

  fusion.applyMerges([{ keep: "speaker_0", remove: "speaker_1", displayName: null }]);
  assert.equal(identify(fusion, "speaker_0", 5_000, 5_500)?.displayName, "Jane Doe");
});

test("a merge keeps the meeting app's name on the kept voice", () => {
  const fusion = createMeetingSpeakerFusion();
  highlight(fusion, [[["jane"], 0, 10_000]]);
  assert.equal(identify(fusion, "speaker_1", 0, 4_500)?.displayName, "Jane Doe");

  fusion.applyMerges([{ keep: "speaker_0", remove: "speaker_1", displayName: "Jane Doe" }]);
  assert.equal(identify(fusion, "speaker_0", 5_000, 6_500, "Jane Doe"), null);
  assert.deepEqual(fusion.summarize(), {
    participants: 2,
    votingClusters: 1,
    namedClusters: 1,
  });
});

test("ignores malformed states and windows", () => {
  const fusion = createMeetingSpeakerFusion();
  fusion.recordAppState({ at: Number.NaN, participants: [JANE], speakingIds: ["jane"] });
  fusion.recordAppState();
  assert.equal(fusion.observeIdentification({}), null);
  assert.equal(fusion.observeIdentification(), null);
  assert.equal(identify(fusion, "speaker_0", 0, 4_500), null);
});

test("a merge never hands a voice the user's name from votes cast before marking", () => {
  const fusion = createMeetingSpeakerFusion();
  highlight(fusion, [[["me"], 0, 6_000]], [{ id: "me", name: "Gabe" }, JANE]);
  identify(fusion, "speaker_0", 0, 3_000);
  identify(fusion, "speaker_1", 3_000, 6_000);
  fusion.recordAppState({ at: T0 + 6_500, participants: [ME, JANE], speakingIds: [] });
  fusion.applyMerges([{ keep: "speaker_0", remove: "speaker_1", displayName: null }]);
  assert.equal(identify(fusion, "speaker_0", 7_000, 7_500), null);
});

test("a speaker carried from captions to a layout takes the layout's lag", () => {
  const fusion = createMeetingSpeakerFusion();
  const state = (at, speakingIds, strategy) =>
    fusion.recordAppState({ at: T0 + at, participants: [JANE, OMAR], speakingIds, strategy });
  // Jane talks 0–10 s: captions name her from 1.5 s, then the caption bar
  // closes and Spotlight keeps her until 10 s.
  state(CAPTION_LAG_MS, ["jane"], "captions");
  state(5_000, ["jane"], "speaker-view");
  state(10_000, [], "speaker-view");
  // Speech 8.6–10 s lines up with the layout interval, not one shifted by 1.5 s.
  let naming = null;
  for (let at = 5_000; at < 10_000 && !naming; at += 1_400) {
    naming = identify(fusion, "speaker_0", at, at + 1_400);
  }
  assert.equal(naming?.displayName, "Jane Doe");
});

test("speech counts once when a layout interval and a caption interval overlap", () => {
  const fusion = createMeetingSpeakerFusion();
  const state = (at, speakingIds, strategy) =>
    fusion.recordAppState({ at: T0 + at, participants: [JANE, OMAR], speakingIds, strategy });
  // Speaker view shows Jane from 0, captions take over at 4 s: once shifted,
  // the two intervals overlap for 1.5 s.
  state(0, ["jane"], "speaker-view");
  state(4_000, ["jane"], "captions");
  assert.equal(identify(fusion, "speaker_0", 2_500, 4_000), null);
  assert.equal(identify(fusion, "speaker_0", 4_000, 4_600), null);
  // 2.6 s of speech so far: under the 4 s it takes to name a voice.
  assert.equal(identify(fusion, "speaker_0", 4_600, 5_100), null);
});

test("a voice named after someone later marked as the user is let go", () => {
  const fusion = createMeetingSpeakerFusion();
  highlight(fusion, [[["me"], 0, 5_000]], [{ id: "me", name: "Gabe" }, JANE]);
  assert.equal(identify(fusion, "speaker_0", 0, 4_500)?.displayName, "Gabe");
  fusion.recordAppState({ at: T0 + 5_500, participants: [ME, JANE], speakingIds: [] });
  assert.equal(fusion.summarize().namedClusters, 0);
});
