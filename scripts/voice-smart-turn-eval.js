// Offline end-of-turn evaluation for local voice conversation: Silero-only vs Smart Turn.
//
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/voice-smart-turn-eval.js [outDir]
//
// Synthesizes utterances with voice conversation's Pocket TTS voice, splices silent
// pauses into the middle of some of them (at the quietest point, so the prosody before
// the pause still "continues"), adds a faint noise floor, then streams each clip
// through the worker's exact VAD config + endpointer in 512-sample frames. The
// classifier runs for real; its result is delivered to the endpointer only after
// its measured latency has elapsed on the mic clock, as it would live.
const fs = require("fs");
const os = require("os");
const path = require("path");
const sherpa = require("sherpa-onnx-node");
const { buildVoiceWorkerConfig } = require("../src/helpers/voiceConversationConfig");
const { getVoiceModelPaths } = require("../src/helpers/voiceModels");
const { createTurnEndpointer, createSampleRing } = require("../src/helpers/voiceTurnEndpointer");
const { createSmartTurnSession } = require("../src/workers/smartTurnSession");

const modelPaths = getVoiceModelPaths();

const RATE = 16000;
const FRAME = 512;
const CACHE_DIR = path.join(os.homedir(), ".cache", "openwhispr");
const OUT_DIR = process.argv[2] || path.join(os.tmpdir(), "smart-turn-eval");
const LEAD_MS = 600;
const TAIL_MS = 2500;
const PAUSES_MS = [300, 600, 900];

const COMPLETE = [
  "Yes.",
  "No, cancel that.",
  "Okay, thanks.",
  "Stop.",
  "What time is my next meeting?",
  "Set a timer for ten minutes.",
  "What's the weather like in Seattle tomorrow?",
  "Remind me to call Sarah when I get home.",
  "Can you summarize my notes from yesterday's meeting?",
];
// Pauses go before a named word. "midPhrase": the words before the pause cannot
// end a request, so any commit there is a false cut-off. "clause": the words
// before the pause are a plausible request on their own, so a cut is ambiguous.
const LONG = [
  {
    text: "I'd like to schedule a meeting with the design team next Thursday afternoon.",
    midPhrase: "design",
    clause: "with",
  },
  {
    text: "Can you find the notes where we talked about the quarterly revenue projections?",
    midPhrase: "quarterly",
    clause: "where",
  },
  {
    text: "Send a message to Alex saying that I'll be about fifteen minutes late.",
    midPhrase: "i'll",
    clause: "saying",
  },
  {
    text: "What's the difference between the old pricing plan and the new one?",
    midPhrase: "pricing",
  },
  {
    text: "Add milk, eggs and a loaf of bread to my shopping list.",
    midPhrase: "loaf",
    clause: "to",
  },
  {
    text: "Look up the best route to the airport that avoids the highway.",
    midPhrase: "airport",
    clause: "that",
  },
  { text: "Tell me how many hours I spent in meetings last week.", midPhrase: "spent" },
  {
    text: "Write a short note about the bug we found in the login flow.",
    midPhrase: "bug",
    clause: "we",
  },
];
const VOICES = [{ id: "pocket-bria" }];

const METHODS = [
  { id: "silero-500", silenceMs: 500, smartTurn: false },
  { id: "silero-200", silenceMs: 200, smartTurn: false },
  { id: "smart-200/1200", silenceMs: 200, smartTurn: true, maxSilenceMs: 1200 },
  {
    id: "smart-200/1200 p>0.8",
    silenceMs: 200,
    smartTurn: true,
    maxSilenceMs: 1200,
    threshold: 0.8,
  },
  {
    id: "smart-200/1200 p>0.95",
    silenceMs: 200,
    smartTurn: true,
    maxSilenceMs: 1200,
    threshold: 0.95,
  },
  { id: "smart-300/1200", silenceMs: 300, smartTurn: true, maxSilenceMs: 1200 },
  {
    id: "tiered .9@200 .5@500",
    silenceMs: 200,
    smartTurn: true,
    maxSilenceMs: 1200,
    fastThreshold: 0.9,
    holdSilenceMs: 500,
  },
  {
    id: "tiered .95@200 .5@500",
    silenceMs: 200,
    smartTurn: true,
    maxSilenceMs: 1200,
    fastThreshold: 0.95,
    holdSilenceMs: 500,
  },
  {
    id: "tiered .9@200 .8@500",
    silenceMs: 200,
    smartTurn: true,
    maxSilenceMs: 1200,
    threshold: 0.8,
    fastThreshold: 0.9,
    holdSilenceMs: 500,
  },
];

// Windowed-sinc resampler: the TTS voices run at 24 kHz and sherpa's resampler is linear.
function resample(input, fromRate, toRate) {
  const ratio = fromRate / toRate;
  const cutoff = 0.5 * Math.min(1, toRate / fromRate) * 0.95;
  const halfWidth = 24;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let n = 0; n < out.length; n += 1) {
    const center = n * ratio;
    const first = Math.ceil(center - halfWidth);
    let sum = 0;
    for (let k = first; k <= center + halfWidth; k += 1) {
      if (k < 0 || k >= input.length) continue;
      const distance = center - k;
      const x = 2 * cutoff * distance;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const window = 0.5 + 0.5 * Math.cos((Math.PI * distance) / halfWidth);
      sum += input[k] * 2 * cutoff * sinc * window;
    }
    out[n] = sum;
  }
  return out;
}

function frameRms(samples, start, length) {
  let sum = 0;
  for (let index = start; index < start + length; index += 1) sum += samples[index] ** 2;
  return Math.sqrt(sum / length);
}

function speechBounds(samples) {
  const hop = RATE / 100;
  const rms = [];
  for (let start = 0; start + hop <= samples.length; start += hop)
    rms.push(frameRms(samples, start, hop));
  const peak = Math.max(...rms);
  const active = rms.map((value) => value > peak * 0.03);
  const first = active.indexOf(true);
  const last = active.lastIndexOf(true);
  return { start: first * hop, end: (last + 1) * hop, rms, hop };
}

function createAligner() {
  const dir = path.join(CACHE_DIR, "parakeet-models", "parakeet-unified-en-0.6b");
  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(dir, "encoder.int8.onnx"),
        decoder: path.join(dir, "decoder.int8.onnx"),
        joiner: path.join(dir, "joiner.int8.onnx"),
      },
      tokens: path.join(dir, "tokens.txt"),
      modelType: "nemo_transducer",
      numThreads: 4,
    },
  });
  const decode = (samples) => {
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples: Float32Array.from(samples), sampleRate: RATE });
    recognizer.decode(stream);
    return recognizer.getResult(stream);
  };
  return {
    transcribe: (samples) => decode(samples).text.trim(),
    /** Word start times (s) from Parakeet's token timestamps; a word starts at a space-led token. */
    words(samples) {
      const result = decode(samples);
      const words = [];
      result.tokens.forEach((token, index) => {
        if (token.startsWith(" ") || words.length === 0)
          words.push({ word: "", start: result.timestamps[index] });
        words[words.length - 1].word += token;
      });
      return words.map((entry) => ({
        ...entry,
        word: entry.word
          .trim()
          .toLowerCase()
          .replace(/[^a-z']/g, ""),
      }));
    },
  };
}

const normalizeWord = (word) => word.toLowerCase().replace(/[^a-z']/g, "");
const lastWord = (text) => normalizeWord(text.trim().split(/\s+/).pop() || "");
const firstWord = (text) => normalizeWord(text.trim().split(/\s+/)[0] || "");

/**
 * Splice point between `beforeWord` and the word preceding it. Parakeet's token
 * times are 80 ms coarse, so try the quiet points around the boundary and keep
 * the first whose two halves transcribe as "... previous" / "beforeWord ...".
 */
function splicePointBefore(samples, text, aligner, beforeWord) {
  const sentence = text.split(/\s+/).map(normalizeWord);
  const previous = sentence[sentence.indexOf(beforeWord) - 1];
  const target = aligner.words(samples).find((entry) => entry.word === beforeWord);
  if (!target || !previous) return null;
  const { rms, hop } = speechBounds(samples);
  const center = Math.round((target.start * RATE) / hop);
  const candidates = [];
  for (
    let index = Math.max(1, center - 30);
    index <= Math.min(rms.length - 2, center + 15);
    index += 1
  ) {
    if (rms[index] <= rms[index - 1] && rms[index] <= rms[index + 1]) candidates.push(index);
  }
  candidates.sort((a, b) => rms[a] - rms[b]);
  for (const index of candidates.slice(0, 8)) {
    const split = index * hop + hop / 2;
    const before = aligner.transcribe(samples.subarray(0, split));
    const after = aligner.transcribe(samples.subarray(split));
    if (lastWord(before) === previous && firstWord(after) === beforeWord)
      return { split, before, after };
  }
  return null;
}

function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296 - 0.5;
  };
}

function buildClip(speech, pauseMs, split, seed) {
  const lead = (LEAD_MS * RATE) / 1000;
  const tail = (TAIL_MS * RATE) / 1000;
  const pause = (pauseMs * RATE) / 1000;
  const clip = new Float32Array(lead + speech.length + pause + tail);
  clip.set(speech.subarray(0, split), lead);
  clip.set(speech.subarray(split), lead + split + pause);
  const rng = makeRng(seed);
  // About -60 dBFS of noise so silence is not digital zero.
  for (let index = 0; index < clip.length; index += 1) clip[index] += rng() * 0.002;
  const bounds = speechBounds(speech);
  return {
    clip,
    speechEnd: lead + bounds.end + (bounds.end > split ? pause : 0),
    pauseAt: pause ? lead + split : null,
  };
}

async function synthesizeAll() {
  const cacheFile = path.join(OUT_DIR, "tts-cache.json");
  if (fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    return cached.map((entry) => ({ ...entry, speech: Float32Array.from(entry.speech) }));
  }
  const utterances = [];
  for (const voice of VOICES) {
    const config = buildVoiceWorkerConfig({ modelPaths });
    const tts = await sherpa.OfflineTts.createAsync(config.tts);
    const extras = {};
    if (config.pocketVoiceWav) {
      const wave = sherpa.readWave(config.pocketVoiceWav, false);
      extras.generationConfig = new sherpa.GenerationConfig({
        referenceAudio: wave.samples,
        referenceSampleRate: wave.sampleRate,
      });
    }
    for (const entry of [...COMPLETE.map((text) => ({ text })), ...LONG]) {
      const audio = await tts.generateAsync({
        text: entry.text,
        sid: 0,
        speed: 1.0,
        enableExternalBuffer: false,
        ...extras,
      });
      const speech = resample(Float32Array.from(audio.samples), audio.sampleRate, RATE);
      utterances.push({ voice: voice.id, ...entry, speech });
      process.stdout.write(".");
    }
  }
  process.stdout.write("\n");
  fs.writeFileSync(
    cacheFile,
    JSON.stringify(utterances.map((entry) => ({ ...entry, speech: Array.from(entry.speech) })))
  );
  return utterances;
}

// One VAD per method, reset per clip like the worker's: each sherpa Vad holds
// its own ORT session, and hundreds of leaked ones swamp the CPU.
const vads = new Map();
function vadFor(method) {
  if (!vads.has(method.id)) {
    // Silero-only baseline / varied-silence methods: copy the shared config and
    // override just the pause duration the worker would otherwise fix at 200 ms.
    const { vad: baseVad } = buildVoiceWorkerConfig({ modelPaths });
    const vadConfig = {
      ...baseVad,
      sileroVad: { ...baseVad.sileroVad, minSilenceDuration: method.silenceMs / 1000 },
    };
    vads.set(method.id, new sherpa.Vad(vadConfig, 60));
  }
  const vad = vads.get(method.id);
  vad.reset();
  return vad;
}

async function runClip(method, clip, classifier, latencies) {
  const vad = vadFor(method);
  const ring = createSampleRing(RATE * 10);
  const endpointer = createTurnEndpointer({
    smartTurn: method.smartTurn,
    sampleRate: RATE,
    maxSilenceMs: method.maxSilenceMs,
    threshold: method.threshold,
    fastThreshold: method.fastThreshold,
    holdSilenceMs: method.holdSilenceMs,
  });
  const commits = [];
  const deliveries = [];
  let speaking = false;

  const apply = async (actions) => {
    for (const action of actions) {
      if (action.type === "commit") {
        commits.push(action);
      } else if (action.type === "classify") {
        const result = await classifier.predict(ring.slice(action.fromSample, action.toSample));
        latencies.push(result);
        const latencySamples = Math.ceil(((result.featureMs + result.inferenceMs) * RATE) / 1000);
        deliveries.push({
          at: action.toSample + latencySamples,
          requestId: action.requestId,
          probability: result.probability,
        });
      }
    }
  };

  for (let offset = 0; offset < clip.length; offset += FRAME) {
    const frame = clip.subarray(offset, Math.min(clip.length, offset + FRAME));
    ring.push(frame);
    const now = ring.totalSamples;
    for (const delivery of deliveries.filter((entry) => entry.at <= now)) {
      deliveries.splice(deliveries.indexOf(delivery), 1);
      // Delivered at its arrival time on the mic clock, not at the frame boundary.
      await apply(endpointer.onPrediction({ ...delivery, nowSample: delivery.at }));
    }
    vad.acceptWaveform(Float32Array.from(frame));
    const detected = vad.isDetected();
    if (detected && !speaking) await apply(endpointer.onSpeechStart());
    speaking = detected;
    while (!vad.isEmpty()) {
      const segment = vad.front(false);
      vad.pop();
      await apply(
        endpointer.onSegment({
          samples: Float32Array.from(segment.samples),
          startSample: segment.start,
          nowSample: now,
        })
      );
    }
    await apply(endpointer.advance(now));
  }
  return commits;
}

const percentile = (values, fraction) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
};
const toMs = (samples) => Math.round((samples / RATE) * 1000);

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const utterances = await synthesizeAll();
  const smartTurnConfig = buildVoiceWorkerConfig({ modelPaths }).smartTurn;
  const classifier = await createSmartTurnSession(smartTurnConfig);

  const aligner = createAligner();
  const clips = [];
  const splits = [];
  utterances.forEach((utterance, index) => {
    clips.push({
      ...utterance,
      kind: "complete",
      pauseMs: 0,
      ...buildClip(utterance.speech, 0, utterance.speech.length, index + 1),
    });
    for (const kind of ["midPhrase", "clause"]) {
      if (!utterance[kind]) continue;
      const found = splicePointBefore(utterance.speech, utterance.text, aligner, utterance[kind]);
      if (found === null) {
        console.warn(
          `no clean splice before "${utterance[kind]}" (${utterance.voice}): ${utterance.text}`
        );
        continue;
      }
      const { split, before, after } = found;
      splits.push({ voice: utterance.voice, kind, before, after });
      for (const pauseMs of PAUSES_MS) {
        clips.push({
          ...utterance,
          kind,
          pauseMs,
          ...buildClip(utterance.speech, pauseMs, split, index * 10 + pauseMs),
        });
      }
    }
  });
  fs.writeFileSync(path.join(OUT_DIR, "splits.json"), JSON.stringify(splits, null, 2));

  const rows = [];
  const latencies = [];
  // Classifier latency feeds the simulated clock, so a busy machine skews every smart result.
  const loadBefore = os.loadavg()[0];
  for (const method of METHODS) {
    for (const clip of clips) {
      const commits = await runClip(
        method,
        clip.clip,
        classifier,
        method.smartTurn ? latencies : []
      );
      const early = commits.filter((commit) => commit.commitSample < clip.speechEnd);
      const final = commits.find((commit) => commit.commitSample >= clip.speechEnd);
      rows.push({
        method: method.id,
        voice: clip.voice,
        text: clip.text,
        kind: clip.kind,
        pauseMs: clip.pauseMs,
        commits: commits.length,
        cutOff: early.length > 0,
        endOfTurnMs: final ? toMs(final.commitSample - clip.speechEnd) : null,
        finalReason: final?.reason ?? null,
        finalProbability: final?.probability ?? null,
        earlyReasons: early.map((commit) => commit.reason).join("+"),
      });
    }
    process.stdout.write(`${method.id} done\n`);
  }

  const summary = METHODS.map((method) => {
    const mine = rows.filter((row) => row.method === method.id);
    // Same 51 unpaused clips for every method, so delays compare like for like.
    const clean = mine.filter(
      (row) => row.kind === "complete" && !row.cutOff && row.endOfTurnMs !== null
    );
    const group = (kind, pauseMs) =>
      mine.filter((row) => row.kind === kind && (pauseMs === undefined || row.pauseMs === pauseMs));
    const cutRate = (subset) => `${subset.filter((row) => row.cutOff).length}/${subset.length}`;
    return {
      method: method.id,
      eotP50: percentile(
        clean.map((row) => row.endOfTurnMs),
        0.5
      ),
      eotP90: percentile(
        clean.map((row) => row.endOfTurnMs),
        0.9
      ),
      maxSilence: `${clean.filter((row) => row.finalReason === "max-silence").length}/${clean.length}`,
      cutComplete: cutRate(group("complete")),
      ...Object.fromEntries(
        PAUSES_MS.map((pauseMs) => [`cutMid${pauseMs}`, cutRate(group("midPhrase", pauseMs))])
      ),
      ...Object.fromEntries(
        PAUSES_MS.map((pauseMs) => [`cutClause${pauseMs}`, cutRate(group("clause", pauseMs))])
      ),
    };
  });
  const latency = {
    calls: latencies.length,
    featureP50: percentile(
      latencies.map((entry) => entry.featureMs),
      0.5
    ),
    featureP90: percentile(
      latencies.map((entry) => entry.featureMs),
      0.9
    ),
    inferenceP50: percentile(
      latencies.map((entry) => entry.inferenceMs),
      0.5
    ),
    inferenceP90: percentile(
      latencies.map((entry) => entry.inferenceMs),
      0.9
    ),
    totalP50: percentile(
      latencies.map((entry) => entry.featureMs + entry.inferenceMs),
      0.5
    ),
    totalP90: percentile(
      latencies.map((entry) => entry.featureMs + entry.inferenceMs),
      0.9
    ),
    totalMax: Math.max(...latencies.map((entry) => entry.featureMs + entry.inferenceMs)),
    loadAverageBefore: loadBefore,
    loadAverageAfter: os.loadavg()[0],
  };

  fs.writeFileSync(path.join(OUT_DIR, "rows.json"), JSON.stringify(rows, null, 2));
  fs.writeFileSync(
    path.join(OUT_DIR, "summary.json"),
    JSON.stringify({ summary, latency }, null, 2)
  );
  console.table(summary);
  console.log(
    "classifier latency (ms)",
    JSON.stringify(latency, (_key, value) =>
      typeof value === "number" ? Math.round(value * 10) / 10 : value
    )
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
