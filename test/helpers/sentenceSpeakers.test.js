const test = require("node:test");
const assert = require("node:assert/strict");

const {
  assignSpeakersBySentence,
  buildLineWindows,
} = require("../../src/helpers/sentenceSpeakers");

// Voices as unit vectors; "between" sits halfway between A and B.
const VOICE = {
  A: [1, 0, 0],
  B: [0, 1, 0],
  C: [0, 0, 1],
  between: [0.7, 0.66, 0.2],
};

// Who really speaks when: the stub hears the voice at the window's midpoint.
function embedFrom(timeline) {
  const calls = [];
  const embedWindow = async (start, end) => {
    calls.push([start, end]);
    const mid = (start + end) / 2;
    const hit = timeline.find(([from, to]) => mid >= from && mid < to);
    return hit ? new Float32Array(VOICE[hit[2]]) : null;
  };
  return { embedWindow, calls };
}

const line = (timestamp, endTimestamp, speaker, text = "…", source = "system") => ({
  text,
  source,
  timestamp,
  endTimestamp,
  speaker,
  speakerIsPlaceholder: false,
  speakerStatus: "confirmed",
});

test("a short reply gets its own voice instead of the turn around it", async () => {
  // Diarization put the whole exchange in speaker_0's turn.
  const segments = [
    line(0, 4, "speaker_0", "Würden Sie am Freitag passen?"),
    line(4.4, 5, "speaker_0", "Ja."),
    line(5.5, 9, "speaker_0", "Dann komme ich vorbei."),
    line(9.5, 13, "speaker_1", "Gut, bis dann."),
  ];
  const { embedWindow } = embedFrom([
    [0, 4.2, "A"],
    [4.2, 5.3, "B"],
    [5.3, 9.2, "A"],
    [9.2, 13, "B"],
  ]);
  const { segments: out, refined } = await assignSpeakersBySentence(segments, {
    diarizedSource: "system",
    embedWindow,
  });
  assert.equal(refined, true);
  assert.deepEqual(
    out.map((s) => s.speaker),
    ["speaker_0", "speaker_1", "speaker_0", "speaker_1"]
  );
  assert.equal(out[1].speakerIsPlaceholder, false);
  assert.equal(out[1].text, "Ja.", "the short line is kept");
});

test("a close call keeps the best guess, stays provisional and stays out of the voices", async () => {
  const segments = [
    line(0, 4, "speaker_0"),
    line(5, 9, "speaker_1"),
    line(10, 14, "speaker_0"),
    line(15, 19, "speaker_1"),
    // Under the 2 s a voice is seeded from, so it can't shift the voices itself.
    line(20, 21.5, "speaker_1", "Hm, vielleicht."),
  ];
  const { embedWindow } = embedFrom([
    [0, 4, "A"],
    [5, 9, "B"],
    [10, 14, "A"],
    [15, 19, "B"],
    [20, 21.5, "between"],
  ]);
  const { segments: out, voices } = await assignSpeakersBySentence(segments, {
    diarizedSource: "system",
    embedWindow,
  });
  const unsure = out[4];
  assert.equal(unsure.speakerIsPlaceholder, true);
  assert.equal(unsure.speakerStatus, "provisional");
  // No shared "unknown" speaker: it keeps a real speaker id.
  assert.ok(["speaker_0", "speaker_1"].includes(unsure.speaker));
  // Profile voices come from sure lines only: B's voice is exactly B.
  assert.deepEqual(Array.from(voices.get("speaker_1")), VOICE.B);
  assert.deepEqual(Array.from(voices.get("speaker_0")), VOICE.A);
});

test("on a close call, a question before and a diarization change outvote a slight lean", async () => {
  const segments = [
    line(0, 4, "speaker_0"),
    line(5, 9, "speaker_1"),
    line(10, 14, "speaker_0", "Läuft es über den Konzern?"),
    // The voice leans slightly to speaker_0; diarization heard a change.
    line(14.5, 16, "speaker_1", "Nein, direkt."),
    line(17, 21, "speaker_1"),
  ];
  const { embedWindow } = embedFrom([
    [0, 4, "A"],
    [5, 9, "B"],
    [10, 14.2, "A"],
    [14.2, 16.5, "between"],
    [17, 21, "B"],
  ]);
  const { segments: out } = await assignSpeakersBySentence(segments, {
    diarizedSource: "system",
    embedWindow,
  });
  assert.equal(out[3].speaker, "speaker_1");
  assert.equal(out[3].speakerIsPlaceholder, true);
});

test("a line too short to hear keeps its diarization speaker, marked provisional", async () => {
  const segments = [
    line(0, 4, "speaker_0"),
    // Back to back with its neighbours: no pause to widen into.
    line(4, 4.3, "speaker_1", "Ja."),
    line(4.3, 8, "speaker_1"),
  ];
  const { embedWindow } = embedFrom([
    [0, 4, "A"],
    [4, 8, "B"],
  ]);
  const { segments: out } = await assignSpeakersBySentence(segments, {
    diarizedSource: "system",
    embedWindow,
  });
  assert.equal(out[1].speaker, "speaker_1");
  assert.equal(out[1].speakerIsPlaceholder, true);
  assert.equal(out[1].text, "Ja.");
});

test("a voice the diarization split in two ends up as one speaker", async () => {
  const segments = [
    line(0, 4, "speaker_0"),
    line(5, 9, "speaker_1"),
    line(10, 14, "speaker_2"),
    line(15, 19, "speaker_0"),
  ];
  const { embedWindow } = embedFrom([
    [0, 4, "A"],
    [5, 9, "B"],
    [10, 14, "A"],
    [15, 19, "A"],
  ]);
  const { segments: out, voices } = await assignSpeakersBySentence(segments, {
    diarizedSource: "system",
    embedWindow,
  });
  const ids = new Set(out.map((s) => s.speaker));
  assert.equal(ids.size, 2);
  assert.equal(out[2].speaker, out[0].speaker);
  assert.equal(voices.size, 2);
});

test("mic lines, 'you' lines and locked lines are left alone", async () => {
  const locked = {
    ...line(10, 14, "speaker_1"),
    speakerName: "Eva",
    speakerLocked: true,
    speakerStatus: "locked",
  };
  const segments = [
    line(0, 4, "speaker_0"),
    { ...line(4.5, 6, "you", "Ich auch.", "mic") },
    line(5, 9, "speaker_1"),
    locked,
  ];
  const { embedWindow } = embedFrom([
    [0, 4, "A"],
    [5, 9, "B"],
    [10, 14, "A"],
  ]);
  const { segments: out } = await assignSpeakersBySentence(segments, {
    diarizedSource: "system",
    embedWindow,
  });
  assert.equal(out[1].speaker, "you");
  assert.equal(out[1].source, "mic");
  assert.equal(out[3].speaker, "speaker_1");
  assert.equal(out[3].speakerName, "Eva");
  assert.equal(out[3].speakerLocked, true);
});

test("nothing changes without a single line long enough to trust", async () => {
  const segments = [line(0, 1, "speaker_0"), line(2, 3, "speaker_1")];
  const { embedWindow } = embedFrom([[0, 5, "A"]]);
  const result = await assignSpeakersBySentence(segments, {
    diarizedSource: "system",
    embedWindow,
  });
  assert.equal(result.refined, false);
  assert.equal(result.segments, segments);
});

test("a failed extraction leaves that line to the diarization", async () => {
  const segments = [line(0, 4, "speaker_0"), line(5, 9, "speaker_1"), line(10, 14, "speaker_1")];
  let n = 0;
  const embedWindow = async () => {
    n += 1;
    if (n === 3) throw new Error("worker gone");
    return new Float32Array(n === 1 ? VOICE.A : VOICE.B);
  };
  const { segments: out } = await assignSpeakersBySentence(segments, {
    diarizedSource: "system",
    embedWindow,
  });
  assert.equal(out[2].speaker, "speaker_1");
  assert.equal(out[2].speakerIsPlaceholder, true);
});

test("short lines widen into the pauses beside them, never into a neighbour", () => {
  const windows = buildLineWindows([
    { timestamp: 0, endTimestamp: 3 },
    { timestamp: 3.2, endTimestamp: 3.7 },
    { timestamp: 5, endTimestamp: 8 },
  ]);
  // 0.5 s of speech, 0.2 s pause before it, 1.3 s after it.
  assert.equal(windows[1].start, 3);
  assert.ok(Math.abs(windows[1].end - 4.2) < 1e-9);
  assert.equal(windows[1].speechSeconds, 0.5);
  // Without known ends a line runs to the next one.
  const open = buildLineWindows([{ timestamp: 0 }, { timestamp: 6 }, { timestamp: 30 }]);
  assert.equal(open[0].end, 6);
  assert.equal(open[1].end, 16);
});
