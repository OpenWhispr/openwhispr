// Speech half of the local model exam, run on one machine.
//   node --import tsx scripts/local-model-exam/run-speech.mjs [--models a,b] [--clips 12] [--out dir]
// Writes one JSON line per measurement to <out>/records.jsonl and a summary to
// <out>/speech-summary.json. Quit OpenWhispr for speed runs: it competes for the
// processor and graphics chip.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listArg, log, median, parseArgs, recorder, resultsDir } from "./lib/cli.mjs";
import { installElectronStub } from "./lib/electron.mjs";
import {
  addedWords,
  errorCounts,
  errorsPer100,
  insertionsOutsideSpeech,
  pooledErrorsPer100,
} from "./lib/score.mjs";
import {
  buildLengths,
  buildSilenceSet,
  DICTATION_SENTENCES,
  FLEURS_LANGUAGES,
  loadFleurs,
  loadSynthetic,
} from "./lib/sets.mjs";
import { enginePeaks } from "./lib/memory.mjs";

installElectronStub();
const {
  createSpeechEngine,
  speechGateSkips,
  speechModelSupports: supports,
  stopAllSpeechEngines,
} = await import("./lib/speech.mjs");

const args = parseArgs();
const DEFAULT_MODELS = [
  "nemotron-speech-streaming-en-0.6b",
  "parakeet-unified-en-0.6b",
  "parakeet-tdt-0.6b-v3",
  "orukeet-v0.1.0",
  "nemotron-3.5-asr-streaming-0.6b",
  "base",
  "small",
  "turbo",
];
const models = listArg(args.models, DEFAULT_MODELS);
const clipsPerLanguage = Number(args.clips || 12);
const outDir = resultsDir(args.out);
const record = recorder(outDir);

// Machine profile, filed with every run.
const profile = {
  platform: process.platform,
  arch: process.arch,
  chip: (() => {
    try {
      return execFileSync("sysctl", ["-n", "machdep.cpu.brand_string"]).toString().trim();
    } catch {
      return os.cpus()[0]?.model;
    }
  })(),
  cpus: os.cpus().length,
  ramGiB: +(os.totalmem() / 2 ** 30).toFixed(1),
  node: process.version,
};
fs.writeFileSync(path.join(outDir, "profile.json"), JSON.stringify(profile, null, 2));
log("machine", profile);

// Material.
log("loading test material");
const byLanguage = {};
for (const language of FLEURS_LANGUAGES) {
  byLanguage[language] = await loadFleurs(
    language,
    language === "en" ? Math.max(40, clipsPerLanguage) : clipsPerLanguage
  );
}
const synthetic = {};
for (const language of Object.keys(DICTATION_SENTENCES))
  synthetic[language] = await loadSynthetic(language);
const lengths = buildLengths(byLanguage.en);
const silence = buildSilenceSet({ ...byLanguage, ja: synthetic.ja });
const accuracyClips = [
  ...FLEURS_LANGUAGES.flatMap((l) => byLanguage[l].slice(0, clipsPerLanguage)),
  ...Object.values(synthetic).flat(),
];
log(
  `material: ${accuracyClips.length} accuracy clips, ${lengths.length} lengths (${lengths.map((l) => l.words).join("/")} words), ${silence.length} silence clips`
);

const summary = { profile, models: {} };

for (const modelId of models) {
  const engine = createSpeechEngine(modelId);
  const online = engine.kind === "sherpa-online";
  const s = (summary.models[modelId] = {
    kind: engine.kind,
    speed: {},
    accuracy: {},
    silence: {},
    preview: null,
    peakMiB: null,
  });
  log(`== ${modelId} (${engine.kind})`);

  // 1. Speed: the wait after the key is released, cold then warm, per length.
  for (const clip of lengths) {
    const runs = [];
    const warmCount = clip.targetWords >= 250 ? (online ? 1 : 3) : online ? 2 : 5;
    await engine.unload();
    for (let i = 0; i <= warmCount; i++) {
      const cold = i === 0;
      const r = online
        ? await engine.stream(clip.pcm, { language: "en", realtime: true })
        : await engine.transcribe(clip.pcm, { language: "en" });
      const waitMs = online ? r.waitMs : r.ms;
      const per100 = errorsPer100(errorCounts(clip.reference, r.text, "en"));
      record({
        task: "dictation-speed",
        model: modelId,
        clip: clip.id,
        words: clip.words,
        cold,
        ok: r.ok,
        error: r.error || null,
        waitMs,
        readyMs: r.readyMs ?? null,
        errorsPer100: per100,
      });
      runs.push({ cold, waitMs, ok: r.ok });
      if (online && clip.targetWords === 60 && !cold && !s.preview) {
        const firstPartial = r.updates.find((u) => u.text?.trim());
        const gaps = r.updates.slice(1).map((u, k) => u.atMs - r.updates[k].atMs);
        s.preview = {
          path: "live stream",
          firstWordsMs: firstPartial ? firstPartial.atMs : null,
          updates: r.updates.length,
          medianGapMs: median(gaps),
          maxGapMs: gaps.length ? Math.max(...gaps) : null,
          speechSeconds: clip.seconds,
        };
        record({ task: "live-preview", model: modelId, clip: clip.id, ...s.preview });
      }
    }
    const coldMs = runs.find((x) => x.cold)?.waitMs ?? null;
    const warmMedianMs = median(runs.filter((x) => !x.cold && x.ok).map((x) => x.waitMs));
    // FLEURS is slow read speech (~1.9 words/s). An offline decode scales with
    // audio length, so the wait for the same word count spoken at a normal
    // 150 words a minute (2.5 words/s) is estimated from the measured rate.
    // A streaming model's wait does not depend on length.
    const normalSeconds = clip.words / 2.5;
    const scale = online ? 1 : normalSeconds / clip.seconds;
    s.speed[clip.targetWords] = {
      words: clip.words,
      audioSeconds: +clip.seconds.toFixed(1),
      coldMs,
      warmMedianMs,
      realTimeFactor: online ? null : warmMedianMs / (clip.seconds * 1000),
      estimatedAt150wpm: {
        coldMs: coldMs && Math.round(coldMs * scale),
        warmMs: warmMedianMs && Math.round(warmMedianMs * scale),
      },
      failures: runs.filter((x) => !x.ok).length,
    };
    log(`  speed ${clip.targetWords}w`, s.speed[clip.targetWords]);
  }

  // 2. Live preview for offline engines: the 1.5 s chunk path, in real time.
  if (!online) {
    const clip = lengths.find((l) => l.targetWords === 60);
    const p = await engine.preview(clip.pcm, { language: "en" });
    const lags = p.chunks.map((c) => c.shownAtMs - c.audioEndMs);
    s.preview = {
      path: "1.5 s chunks",
      firstWordsMs: p.chunks.find((c) => c.text.trim())?.shownAtMs ?? null,
      chunks: p.chunks.length,
      maxDecodeMs: p.chunks.length ? Math.max(...p.chunks.map((c) => c.decodeMs)) : null,
      medianLagMs: median(lags),
      maxLagMs: lags.length ? Math.max(...lags) : null,
      speechSeconds: clip.seconds,
      previewErrorsPer100: errorsPer100(errorCounts(clip.reference, p.text, "en")),
    };
    record({ task: "live-preview", model: modelId, clip: clip.id, ...s.preview });
    log("  preview", s.preview);
  }

  // 3. Accuracy in every supported language (warm engine, whole-clip decode).
  const perLanguage = {};
  for (const clip of accuracyClips) {
    if (!supports(modelId, clip.language)) continue;
    const r = online
      ? await engine.stream(clip.pcm, { language: clip.language, realtime: false })
      : await engine.transcribe(clip.pcm, { language: clip.language });
    const counts = errorCounts(clip.reference, r.text, clip.language);
    record({
      task: "accuracy",
      model: modelId,
      clip: clip.id,
      set: clip.set,
      language: clip.language,
      group: clip.group,
      ok: r.ok,
      error: r.error || null,
      ms: online ? r.waitMs : r.ms,
      audioSeconds: clip.seconds,
      counts,
      errorsPer100: errorsPer100(counts),
      reference: clip.reference,
      text: r.text,
    });
    const key = `${clip.language}:${clip.set}`;
    (perLanguage[key] ||= { counts: [], failures: 0 }).counts.push(counts);
    if (!r.ok) perLanguage[key].failures++;
  }
  for (const [key, v] of Object.entries(perLanguage))
    s.accuracy[key] = {
      errorsPer100: pooledErrorsPer100(v.counts),
      clips: v.counts.length,
      failures: v.failures,
    };
  log(
    "  accuracy",
    Object.fromEntries(Object.entries(s.accuracy).map(([k, v]) => [k, v.errorsPer100?.toFixed(1)]))
  );

  // 4. Silence and pauses, 10 runs each, with and without the app's speech gate.
  const vadSettings = engine.kind === "whisper" ? [false, true] : [false];
  for (const clip of silence) {
    if (clip.reference && !supports(modelId, clip.language)) continue;
    const gateSkips = await speechGateSkips(clip.pcm, engine.kind);
    for (const vad of vadSettings) {
      const outputs = [];
      for (let run = 0; run < 10; run++) {
        const r = online
          ? await engine.stream(clip.pcm, { language: clip.language, realtime: false })
          : await engine.transcribe(clip.pcm, { language: clip.language, vad });
        outputs.push(r.text || "");
      }
      // Speech clips: only words written where the audio was silent or noise.
      const extra = outputs.map((t) =>
        clip.reference
          ? insertionsOutsideSpeech(clip.referenceParts, t, clip.language)
          : addedWords(t)
      );
      const shippedExtra = gateSkips ? outputs.map(() => 0) : extra;
      const key = `${clip.id}${vad ? "+vad" : ""}`;
      s.silence[key] = {
        kind: clip.kind,
        gateSkips,
        maxAddedWords: Math.max(...extra),
        runsWithAddedWords: extra.filter((x) => x > 0).length,
        shippedRunsWithAddedWords: shippedExtra.filter((x) => x > 0).length,
      };
      record({
        task: "silence",
        model: modelId,
        clip: clip.id,
        kind: clip.kind,
        vad,
        gateSkips,
        extraWords: extra,
        referenceParts: clip.referenceParts || null,
        outputs: [...new Set(outputs)].slice(0, 5),
      });
    }
  }
  const silenceFails = Object.entries(s.silence)
    .filter(([, v]) => v.shippedRunsWithAddedWords > 0)
    .map(([k, v]) => `${k}:${v.shippedRunsWithAddedWords}/10`);
  log(
    "  silence (shipped path, runs with made-up words)",
    silenceFails.length ? silenceFails : "none"
  );

  // 5. Peak memory of the engine process.
  const peaks = await enginePeaks();
  s.peakMiB = Object.values(peaks).length ? Math.max(...Object.values(peaks)) : null;
  record({ task: "memory", model: modelId, peaks });
  log("  peak memory MiB", peaks);
  await engine.unload();
  fs.writeFileSync(path.join(outDir, "speech-summary.json"), JSON.stringify(summary, null, 2));
}

await stopAllSpeechEngines();
fs.writeFileSync(path.join(outDir, "speech-summary.json"), JSON.stringify(summary, null, 2));
log("done", outDir);
process.exit(0);
