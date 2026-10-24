const test = require("node:test");
const assert = require("node:assert/strict");

const loadSegmenter = () => import("../../src/helpers/continuousSegmenter.js");
const loadSession = () => import("../../src/helpers/continuousDictationSession.js");

const FRAME = 800; // 50 ms at 16 kHz, the worklet's message size

// A frame of a 220 Hz tone at `amplitude` (0..1), or near-silence.
function frame(amplitude) {
  const samples = new Int16Array(FRAME);
  for (let i = 0; i < FRAME; i++) {
    samples[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / 16000) * amplitude * 0x7fff);
  }
  return samples;
}
const speech = (ms) => Array.from({ length: ms / 50 }, () => frame(0.2));
const silence = (ms) => Array.from({ length: ms / 50 }, () => frame(0.0005));

function drive(segmenter, ...runs) {
  for (const run of runs) for (const f of run) segmenter.push(f);
}

// A segmenter whose phrases land the moment they're cut, as if transcription
// and paste were instant; the submit countdown then runs from each phrase's end.
async function instantSegmenter(options = {}) {
  const { ContinuousSegmenter } = await loadSegmenter();
  const events = [];
  const segmenter = new ContinuousSegmenter({
    // These tests were written around a short pause; the 2 s default has its own test.
    phrasePauseMs: 700,
    ...options,
    onSegment: (samples, info) => {
      events.push("segment");
      options.onSegment?.(samples, info);
      segmenter.phraseSettled();
    },
    onSubmit: () => events.push("submit"),
  });
  return { segmenter, events };
}

test("a pause ends a phrase and a longer silence submits the message", async () => {
  const infos = [];
  const { segmenter, events } = await instantSegmenter({
    submitSilenceMs: 2000,
    onSegment: (_samples, info) => infos.push(info),
  });

  drive(segmenter, silence(500), speech(1000), silence(800));
  assert.deepEqual(events, ["segment"]);
  // Pre-roll (300 ms) + speech + 300 ms of the pause that closed it.
  assert.ok(infos[0].durationMs >= 1500 && infos[0].durationMs <= 1700, infos[0].durationMs);
  assert.ok(infos[0].speechMs >= 1000);

  // The countdown runs from the phrase landing, 100 ms into this silence.
  drive(segmenter, silence(1800));
  assert.deepEqual(events, ["segment"]);
  drive(segmenter, silence(200));
  assert.deepEqual(events, ["segment", "submit"]);
});

test("two phrases with a short pause between them are one message", async () => {
  const { segmenter, events } = await instantSegmenter({ submitSilenceMs: 2000 });

  drive(segmenter, speech(600), silence(1000), speech(600), silence(3000));
  assert.deepEqual(events, ["segment", "segment", "submit"]);
});

test("Enter waits for the phrase to land, then the whole silence after it", async () => {
  const { ContinuousSegmenter } = await loadSegmenter();
  const events = [];
  const segmenter = new ContinuousSegmenter({
    phrasePauseMs: 700,
    submitSilenceMs: 5000,
    onSegment: () => events.push("segment"),
    onSubmit: () => events.push("submit"),
  });

  // Transcription is slow: the phrase hasn't landed after 8 s of silence.
  drive(segmenter, speech(600), silence(8000));
  assert.deepEqual(events, ["segment"]);
  segmenter.phraseSettled();
  drive(segmenter, silence(4900));
  assert.deepEqual(events, ["segment"]);
  drive(segmenter, silence(200));
  assert.deepEqual(events, ["segment", "submit"]);
});

test("a click or breath too short for a phrase doesn't restart the countdown", async () => {
  const { segmenter, events } = await instantSegmenter({ submitSilenceMs: 2000 });

  drive(segmenter, speech(600), silence(1500));
  // 800 ms into the countdown, a 150 ms burst of noise.
  drive(segmenter, speech(150), silence(1300));
  assert.deepEqual(events, ["segment", "submit"]);
});

test("silence alone never submits, and short noises are not phrases", async () => {
  const { ContinuousSegmenter } = await loadSegmenter();
  const events = [];
  const segmenter = new ContinuousSegmenter({
    onSegment: () => events.push("segment"),
    onSubmit: () => events.push("submit"),
  });

  drive(segmenter, silence(3000), speech(100), silence(3000));
  assert.deepEqual(events, []);
});

test("a steady background hum raises the bar instead of reading as speech", async () => {
  const { segmenter, events } = await instantSegmenter();
  const hum = (ms) => Array.from({ length: ms / 50 }, () => frame(0.006));

  drive(segmenter, hum(5000));
  assert.deepEqual(events, []);
  drive(segmenter, speech(800), hum(4000));
  assert.deepEqual(events, ["segment", "submit"]);
});

test("speech that never leaves a gap is cut at its quietest moment and keeps going", async () => {
  const { ContinuousSegmenter } = await loadSegmenter();
  const segments = [];
  const segmenter = new ContinuousSegmenter({
    phrasePauseMs: 700,
    chunkTargetMs: 1000,
    chunkMaxMs: 2000,
    onSegment: (samples, info) => segments.push(info),
  });

  drive(segmenter, speech(4500), silence(800));
  assert.equal(segments.length, 3);
  assert.deepEqual(
    segments.map((info) => info.endedAtPause),
    [false, false, true]
  );
});

test("flush emits the phrase being spoken but never submits", async () => {
  const { ContinuousSegmenter } = await loadSegmenter();
  const events = [];
  const segmenter = new ContinuousSegmenter({
    onSegment: () => events.push("segment"),
    onSubmit: () => events.push("submit"),
  });

  drive(segmenter, speech(800));
  segmenter.flush();
  assert.deepEqual(events, ["segment"]);
});

function createSession(ContinuousDictationSession, overrides = {}) {
  const log = [];
  const transcripts = overrides.transcripts ?? ["Hello there.", "How are you?"];
  let index = 0;
  const session = new ContinuousDictationSession({
    submitSilenceMs: 2000,
    segmenterOptions: { phrasePauseMs: 700 },
    transcribe: async (wav) => {
      log.push(`transcribe:${wav.type}`);
      if (overrides.transcribe) return overrides.transcribe(index++);
      return { text: transcripts[index++] ?? "" };
    },
    deliver: async (text) => {
      log.push(`paste:${text}`);
      return { pasted: overrides.pasted ?? true };
    },
    pressEnter: async () => {
      log.push("enter");
      return true;
    },
    onMessageComplete: (message) => log.push(message),
    onSegmentError: () => log.push("error"),
  });
  return { session, log };
}

function feed(session, ...runs) {
  for (const run of runs) for (const f of run) session.feed(f);
}

// Lets queued transcriptions and pastes finish, as real time would while the
// user keeps talking or stays quiet.
async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("the session pastes each phrase in order and presses Enter after the last", async () => {
  const { ContinuousDictationSession } = await loadSession();
  const { session, log } = createSession(ContinuousDictationSession);

  feed(session, speech(600), silence(1000));
  await settle();
  feed(session, speech(600), silence(800));
  await settle();
  feed(session, silence(2500));
  await session.stop();

  assert.deepEqual(log, [
    "transcribe:audio/wav",
    "paste:Hello there.",
    "transcribe:audio/wav",
    "paste:How are you?",
    "enter",
    { text: "Hello there. How are you?", rawText: "Hello there. How are you?", submitted: true },
  ]);
});

test("stopping pastes what was said but does not press Enter", async () => {
  const { ContinuousDictationSession } = await loadSession();
  const { session, log } = createSession(ContinuousDictationSession);

  feed(session, speech(600), silence(900));
  await session.stop();

  assert.deepEqual(log, [
    "transcribe:audio/wav",
    "paste:Hello there.",
    { text: "Hello there.", rawText: "Hello there.", submitted: false },
  ]);
});

test("a message missing a phrase is not submitted", async () => {
  const { ContinuousDictationSession } = await loadSession();
  const { session, log } = createSession(ContinuousDictationSession, {
    transcribe: (i) => {
      if (i === 1) throw new Error("server down");
      return { text: "First part." };
    },
  });

  feed(session, speech(600), silence(1000), speech(600), silence(2500));
  await session.stop();

  assert.ok(!log.includes("enter"));
  assert.ok(log.includes("error"));
  assert.deepEqual(log.at(-1), {
    text: "First part.",
    rawText: "First part.",
    submitted: false,
  });
});

test("a phrase that didn't paste holds the Enter back", async () => {
  const { ContinuousDictationSession } = await loadSession();
  const { session, log } = createSession(ContinuousDictationSession, { pasted: false });

  feed(session, speech(600), silence(2500));
  await session.stop();

  assert.ok(!log.includes("enter"));
});

test("an empty transcription is neither pasted nor submitted", async () => {
  const { ContinuousDictationSession } = await loadSession();
  const { session, log } = createSession(ContinuousDictationSession, { transcripts: [""] });

  feed(session, speech(600), silence(2500));
  await session.stop();

  assert.deepEqual(log, ["transcribe:audio/wav"]);
});

test("cancelling drops phrases that haven't been pasted yet", async () => {
  const { ContinuousDictationSession } = await loadSession();
  let release;
  const { session, log } = createSession(ContinuousDictationSession, {
    transcribe: () => new Promise((resolve) => (release = () => resolve({ text: "Late." }))),
  });

  feed(session, speech(600), silence(2500));
  // Let the transcription start, so cancel lands while it's in flight.
  await new Promise((resolve) => setImmediate(resolve));
  session.cancel();
  // The session no longer listens once cancelled.
  feed(session, speech(600), silence(2500));
  release();
  await session.stop();

  assert.deepEqual(log, ["transcribe:audio/wav"]);
});

test("a stored submit silence snaps to the nearest offered choice", async () => {
  const { snapContinuousSubmitSilenceMs } = await loadSegmenter();
  assert.equal(snapContinuousSubmitSilenceMs(2000), 3000);
  assert.equal(snapContinuousSubmitSilenceMs(5000), 5000);
  assert.equal(snapContinuousSubmitSilenceMs(8000), 7000);
  assert.equal(snapContinuousSubmitSilenceMs(13000), 15000);
  assert.equal(snapContinuousSubmitSilenceMs(60000), 15000);
  assert.equal(snapContinuousSubmitSilenceMs(Number.NaN), 3000);
});

test("a long submit silence still waits the full time", async () => {
  const { segmenter, events } = await instantSegmenter({ submitSilenceMs: 15000 });

  // The phrase lands 700 ms into the silence; Enter comes 15 s after that.
  drive(segmenter, speech(600), silence(15600));
  assert.deepEqual(events, ["segment"]);
  drive(segmenter, silence(200));
  assert.deepEqual(events, ["segment", "submit"]);
});

test("by default a short pause ends a phrase", async () => {
  const { ContinuousSegmenter } = await loadSegmenter();
  const segments = [];
  const segmenter = new ContinuousSegmenter({
    onSegment: (samples, info) => {
      segments.push(info);
      segmenter.phraseSettled();
    },
  });

  drive(segmenter, speech(1200), silence(900));
  assert.equal(segments.length, 0);
  drive(segmenter, silence(100));
  assert.equal(segments.length, 1);
  assert.equal(segments[0].endedAtPause, true);
});

test("talking without pausing lands a chunk at the first gap between words", async () => {
  const { ContinuousSegmenter } = await loadSegmenter();
  const segments = [];
  const segmenter = new ContinuousSegmenter({
    onSegment: (samples, info) => segments.push(info),
  });
  // A dip far below the speaking level, too short to be a pause.
  const wordGap = () => [frame(0.04)];

  // A gap before the chunk is long enough doesn't cut.
  drive(segmenter, speech(1500), wordGap(), speech(50));
  assert.equal(segments.length, 0);
  // Past 2.5 s, the cut falls in the next gap once speech resumes.
  drive(segmenter, speech(1200), wordGap());
  assert.equal(segments.length, 0);
  drive(segmenter, speech(50));
  assert.equal(segments.length, 1);
  assert.equal(segments[0].endedAtPause, false);
  assert.ok(segments[0].durationMs >= 2500, segments[0].durationMs);
  // The talk goes on into the next chunk.
  drive(segmenter, speech(1000), silence(1100));
  assert.equal(segments.length, 2);
  assert.equal(segments[1].endedAtPause, true);
});

test("chunks cut mid-sentence join up as one sentence", async () => {
  const { joinChunk } = await loadSession();
  assert.equal(
    joinChunk("So I was thinking.", { continuesSentence: false, endsMidSentence: true }),
    "So I was thinking"
  );
  assert.equal(
    joinChunk("That we should go.", { continuesSentence: true, endsMidSentence: false }),
    "that we should go."
  );
  assert.equal(
    joinChunk("I think so.", { continuesSentence: true, endsMidSentence: false }),
    "I think so."
  );
  assert.equal(
    joinChunk("NASA said so...", { continuesSentence: true, endsMidSentence: true }),
    "NASA said so..."
  );
  assert.equal(
    joinChunk("Is it ready?", { continuesSentence: false, endsMidSentence: true }),
    "Is it ready?"
  );
});

test("sound tags are dropped from what gets pasted", async () => {
  const { withoutSoundTags } = await loadSession();
  assert.equal(withoutSoundTags(" *sniff*"), "");
  assert.equal(withoutSoundTags("[BLANK_AUDIO]"), "");
  assert.equal(withoutSoundTags("(coughs)"), "");
  assert.equal(withoutSoundTags("♪ ♪"), "");
  assert.equal(withoutSoundTags("Hello *clears throat* there."), "Hello there.");
  assert.equal(withoutSoundTags("Meet at noon (or one)."), "Meet at noon (or one).");
});

test("a phrase that was only a noise is neither pasted nor submitted", async () => {
  const { ContinuousDictationSession } = await loadSession();
  const { session, log } = createSession(ContinuousDictationSession, {
    transcripts: ["*sniff*"],
  });

  feed(session, speech(600), silence(900));
  await settle();
  feed(session, silence(2500));
  await session.stop();

  assert.deepEqual(log, ["transcribe:audio/wav"]);
});
