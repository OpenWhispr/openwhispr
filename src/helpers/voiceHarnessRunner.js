// End-to-end harness for local voice conversation (OPENWHISPR_VOICE_HARNESS=1).
// The renderer opens a session with no mic; this runner synthesizes each
// scripted question, plays it into the worker's VAD at real-time pace, and
// collects the renderer's per-turn report. Everything after the VAD is the live
// pipeline: Parakeet, the assistant panel with its tools, and TTS playback.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { app } = require("electron");
const debugLogger = require("./debugLogger");
const {
  HARNESS_SCENARIOS,
  resampleLinear,
  toFrames,
  summarizeHarness,
  formatHarnessReport,
} = require("./voiceHarness");

const VAD_RATE = 16000;
const FRAME_SIZE = 512;
const FRAME_MS = (FRAME_SIZE / VAD_RATE) * 1000;
const LEAD_SILENCE_S = 0.3;
// A live mic never stops streaming; the harness does after this tail. It must
// outlast Smart Turn's 1.2 s max silence, or a turn the classifier scores as
// unfinished stalls until the next scenario's audio arrives.
const TAIL_SILENCE_S = 2.0;
const TURN_TIMEOUT_MS = 45_000;
const WARM_UP_MS = 4000;
const BETWEEN_TURNS_MS = 1500;
const BARGE_IN_AFTER_AUDIO_MS = 1200;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitFor(emitter, event, timeoutMs, predicate = () => true) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      emitter.removeListener(event, onEvent);
      resolve(null);
    }, timeoutMs);
    function onEvent(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      emitter.removeListener(event, onEvent);
      resolve(payload);
    }
    emitter.on(event, onEvent);
  });
}

async function synthesize(voiceWorker, text, index, sampleRate) {
  const utteranceId = `harness-${index}`;
  const chunks = [];
  const onAudio = (event) => {
    if (event.utteranceId === utteranceId) chunks.push(event.samples);
  };
  voiceWorker.on("tts-audio", onAudio);
  try {
    await voiceWorker.request("speak", { utteranceId, chunkIndex: 0, text });
  } finally {
    voiceWorker.removeListener("tts-audio", onAudio);
  }
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const joined = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return resampleLinear(joined, sampleRate, VAD_RATE);
}

/** Plays 16 kHz speech into the VAD in real time. Resolves with when speech began. */
async function playIntoVad(voiceWorker, speech) {
  const padded = new Float32Array(
    Math.round((LEAD_SILENCE_S + TAIL_SILENCE_S) * VAD_RATE) + speech.length
  );
  padded.set(speech, Math.round(LEAD_SILENCE_S * VAD_RATE));
  const frames = toFrames(padded, FRAME_SIZE);
  const startedAt = Date.now();
  for (let index = 0; index < frames.length; index += 1) {
    voiceWorker.notify("vad-feed", { samples: frames[index] });
    const wait = startedAt + (index + 1) * FRAME_MS - Date.now();
    if (wait > 0) await delay(wait);
  }
  return { speechStartedAt: startedAt + LEAD_SILENCE_S * 1000 };
}

function toResult(scenario, report, extra = {}) {
  return {
    id: scenario.id,
    said: scenario.say,
    expectTools: scenario.expectTools,
    heard: report?.transcript ?? "",
    calledTools: report?.calledTools ?? [],
    availableTools: report?.availableTools ?? [],
    ranWrites: report?.ranWrites ?? [],
    outcome: report?.outcome ?? "timeout",
    metrics: report?.metrics ?? {},
    answer: report?.answer ?? "",
    ...extra,
  };
}

async function runVoiceHarness({ voiceWorker, conversationEvents, getSession, sendToRenderer }) {
  const started = await waitFor(conversationEvents, "session-started", 120_000);
  if (!started) {
    debugLogger.error("voice harness: no voice session started within 2 minutes");
    return null;
  }
  const session = getSession();
  debugLogger.info("voice harness: session started, synthesizing scenarios");
  await delay(WARM_UP_MS);

  // Synthesize everything first: the assistant's replies share the TTS worker,
  // and a question queued behind a reply would skew the timings.
  const audio = [];
  for (const [index, scenario] of HARNESS_SCENARIOS.entries()) {
    const main = await synthesize(voiceWorker, scenario.say, index, session.sampleRate);
    const bargeIn = scenario.bargeIn
      ? await synthesize(voiceWorker, scenario.bargeIn.say, `${index}-barge`, session.sampleRate)
      : null;
    audio.push({ main, bargeIn });
  }

  const results = [];
  for (const [index, scenario] of HARNESS_SCENARIOS.entries()) {
    debugLogger.info("voice harness: scenario", { id: scenario.id, say: scenario.say });
    const report = waitFor(conversationEvents, "turn-report", TURN_TIMEOUT_MS);
    if (!scenario.bargeIn) {
      await playIntoVad(voiceWorker, audio[index].main);
      results.push(toResult(scenario, await report));
    } else {
      const firstAudio = waitFor(conversationEvents, "turn-event", TURN_TIMEOUT_MS, (e) => e.type === "first-audio");
      await playIntoVad(voiceWorker, audio[index].main);
      await firstAudio;
      await delay(BARGE_IN_AFTER_AUDIO_MS);
      const flushed = waitFor(conversationEvents, "turn-event", 10_000, (e) => e.type === "flushed");
      const followUp = (async () => {
        await report;
        return waitFor(conversationEvents, "turn-report", TURN_TIMEOUT_MS);
      })();
      const { speechStartedAt } = await playIntoVad(voiceWorker, audio[index].bargeIn);
      const flush = await flushed;
      results.push(
        toResult(scenario, await report, {
          bargeInMs: flush ? flush.at - speechStartedAt : null,
        })
      );
      results.push(
        toResult({ id: `${scenario.id}-followup`, say: scenario.bargeIn.say, expectTools: [] }, await followUp)
      );
    }
    await delay(BETWEEN_TURNS_MS);
  }

  const summary = summarizeHarness(results);
  const environment = {
    machine: os.cpus()?.[0]?.model || os.arch(),
    memoryGb: Math.round(os.totalmem() / 1024 ** 3),
    brain: session.brainModel || "unknown",
    tts: "pocket",
    startedAt: new Date().toISOString(),
  };
  const dir = path.join(app.getPath("userData"), "voice-harness");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = environment.startedAt.replace(/[:.]/g, "-");
  const reportPath = path.join(dir, `report-${stamp}.md`);
  fs.writeFileSync(reportPath, formatHarnessReport({ results, summary, environment }));
  fs.writeFileSync(
    path.join(dir, `report-${stamp}.json`),
    JSON.stringify({ environment, summary, results }, null, 2)
  );
  debugLogger.info("voice harness: done", { reportPath, summary });
  // Visible in the terminal that launched the app, whatever the log level.
  process.stdout.write(`\nVoice harness report: ${reportPath}\n`);

  sendToRenderer("voice-conversation:harness-done");
  if (process.env.OPENWHISPR_VOICE_HARNESS_QUIT === "1") {
    setTimeout(() => app.quit(), 1000);
  }
  return { reportPath, summary };
}

module.exports = { runVoiceHarness };
