// Weekly canary: a small slice of the local model exam, run on GitHub's runners
// by .github/workflows/local-model-exam.yml. Every model is downloaded with the
// app's own download code and run by the app's own engine. Speech models get
// silence and pauses through the app's speech gate, then a few FLEURS clips;
// the cleanup model tidies a few dictations. The slice and its pass marks are
// in lib/canary.mjs. Any failed check fails the run (exit 1), a crash, skip or
// timeout is a failed check, and a run that checked nothing fails too. The
// markdown report goes to stdout, progress to stderr.
//   node --import tsx scripts/local-model-exam/canary.mjs [--models a,b] [--out dir]
// Locally it uses the app's own model cache, like the rest of the exam. The
// workflow sets OPENWHISPR_CACHE_ROOT on a fresh runner; never set it on a
// machine with the app's models, which the app then moves into that folder.
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  accuracyCeiling,
  CLIPS_PER_LANGUAGE,
  cleanupFailure,
  SILENCE_CLIPS,
  SILENCE_RUNS,
  SPEECH_MODELS,
  TEXT_MODELS,
  TIMEOUT_MS,
} from "./lib/canary.mjs";
import { EXAM_DIR, listArg, parseArgs, readJson, recorder, resultsDir } from "./lib/cli.mjs";
import { installElectronStub } from "./lib/electron.mjs";
import { enginePeaks } from "./lib/memory.mjs";
import { cleanupRuleCheck, instructionMarkersFrom } from "./lib/rules.mjs";
import {
  addedWords,
  errorCounts,
  insertionsOutsideSpeech,
  pooledErrorsPer100,
} from "./lib/score.mjs";
import { buildSilenceSet, loadFleurs } from "./lib/sets.mjs";

// The app's own logging joins progress on stderr.
console.log = console.error;
installElectronStub();
const speech = await import("./lib/speech.mjs");
const text = await import("./lib/text.mjs");

const args = parseArgs();
const outDir = resultsDir(args.out);
const record = recorder(outDir);
const progress = (...parts) => console.error(new Date().toISOString().slice(11, 19), ...parts);

const only = listArg(args.models, null);
const unknown = only?.filter((id) => !SPEECH_MODELS[id] && !TEXT_MODELS[id]) || [];
if (unknown.length) throw new Error(`Not in the canary slice: ${unknown.join(", ")}`);
const pick = (models) =>
  Object.fromEntries(Object.entries(models).filter(([id]) => !only || only.includes(id)));
const speechModels = pick(SPEECH_MODELS);
const textModels = pick(TEXT_MODELS);

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        Object.assign(new Error(`${what} timed out after ${ms / 1000} s`), { timedOut: true })
      );
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const checks = [];
// A timeout leaves the engine in an unknown state, so the rest of that model's
// checks fail without running instead of each waiting out its own timeout.
const hung = new Set();
async function check(model, name, run) {
  const started = performance.now();
  let pass = false;
  let detail = "not run: an earlier step timed out";
  if (!hung.has(model)) {
    try {
      ({ pass, detail = null } = await run());
    } catch (error) {
      detail = error.message;
      if (error.timedOut) hung.add(model);
    }
  }
  const entry = { model, check: name, pass, detail, ms: Math.round(performance.now() - started) };
  checks.push(entry);
  record({ task: "canary", ...entry });
  progress(pass ? "pass" : "FAIL", model, name, detail || "");
  return pass;
}

// Not scored against a machine type (runners are no reference machine); it
// proves the peak can be read on every OS.
const memoryCheck = (modelId) =>
  check(modelId, "memory", async () => {
    const mib = Math.max(0, ...Object.values(await enginePeaks()));
    return {
      pass: mib > 0,
      detail:
        mib > 0 ? `${(mib / 1024).toFixed(2)} GiB at peak` : "could not read the engine's memory",
    };
  });

async function runSpeech(modelId, measured, clipsByLanguage, silenceClips) {
  let engine = null;
  const downloaded = await check(modelId, "download", async () => {
    engine = speech.createSpeechEngine(modelId);
    await withTimeout(engine.download(), TIMEOUT_MS.download, "download");
    return { pass: true };
  });
  if (!downloaded) return;
  const online = engine.kind === "sherpa-online";
  const decode = (clip, language, ms = TIMEOUT_MS.step) =>
    withTimeout(
      online
        ? engine.stream(clip.pcm, { realtime: false })
        : engine.transcribe(clip.pcm, { language }),
      ms,
      `${clip.id} decode`
    );

  const first = clipsByLanguage.en[0];
  const loaded = await check(modelId, "load", async () => {
    const r = await decode(first, "en", TIMEOUT_MS.load);
    if (!r.ok) return { pass: false, detail: r.error };
    return {
      pass: Boolean(r.text.trim()),
      detail: r.text.trim() ? null : "wrote nothing for speech",
    };
  });
  if (!loaded) return engine.unload();

  for (const [language, rate] of Object.entries(measured)) {
    await check(modelId, `accuracy ${language}`, async () => {
      const counts = [];
      for (const clip of clipsByLanguage[language]) {
        const r = await decode(clip, language);
        if (!r.ok) return { pass: false, detail: `${clip.id}: ${r.error}` };
        const c = errorCounts(clip.reference, r.text, language);
        counts.push(c);
        record({
          task: "accuracy",
          model: modelId,
          clip: clip.id,
          language,
          counts: c,
          reference: clip.reference,
          text: r.text,
        });
      }
      const per100 = pooledErrorsPer100(counts);
      const ceiling = accuracyCeiling(rate);
      return {
        pass: per100 <= ceiling,
        detail: `${per100.toFixed(1)} errors per 100 words; ${rate} on 2026-10-22, fails above ${ceiling.toFixed(1)}`,
      };
    });
  }

  for (const clip of silenceClips) {
    if (clip.reference && !speech.speechModelSupports(modelId, clip.language)) continue;
    await check(modelId, `silence ${clip.id}`, async () => {
      if (await speech.speechGateSkips(clip.pcm, engine.kind)) {
        return { pass: true, detail: "dropped by the app's speech gate" };
      }
      for (let run = 1; run <= SILENCE_RUNS; run++) {
        const r = await decode(clip, clip.language);
        if (!r.ok) return { pass: false, detail: r.error };
        const extra = clip.reference
          ? insertionsOutsideSpeech(clip.referenceParts, r.text, clip.language)
          : addedWords(r.text);
        record({ task: "silence", model: modelId, clip: clip.id, run, extra, text: r.text });
        if (extra > 0) {
          return {
            pass: false,
            detail: `run ${run}: ${extra} words where nobody spoke ("…${r.text.slice(-80)}")`,
          };
        }
      }
      return { pass: true };
    });
  }
  await memoryCheck(modelId);
  await engine.unload();
}

async function runText(modelId, caseIds, casesById, markers) {
  const downloaded = await check(modelId, "download", async () => {
    await withTimeout(text.downloadTextModel(modelId), TIMEOUT_MS.download, "download");
    return { pass: true };
  });
  if (!downloaded) return;
  const loaded = await check(modelId, "load", async () => {
    const { loadMs } = await withTimeout(text.ensureServer(modelId), TIMEOUT_MS.load, "load");
    return { pass: true, detail: `${(loadMs / 1000).toFixed(1)} s` };
  });
  if (!loaded) return text.stopTextModel();
  for (const id of caseIds) {
    await check(modelId, `cleanup ${id}`, async () => {
      const c = casesById[id];
      if (!c) return { pass: false, detail: "no such case in fixtures/cleanup-cases.json" };
      const r = await withTimeout(
        text.cleanup(modelId, c.input, { language: c.language }),
        TIMEOUT_MS.step,
        "cleanup"
      );
      record({
        task: "cleanup",
        model: modelId,
        case: id,
        ok: r.ok,
        error: r.error || null,
        input: c.input,
        output: r.output,
      });
      const failure = cleanupFailure(r, cleanupRuleCheck(c, r.output, markers));
      return {
        pass: !failure,
        detail: failure && `${failure} ("${String(r.output).slice(0, 80)}")`,
      };
    });
  }
  await memoryCheck(modelId);
  await text.stopTextModel();
}

try {
  const languages = [...new Set(Object.values(speechModels).flatMap((m) => Object.keys(m)))];
  const clipsByLanguage = {};
  let silenceClips = [];
  if (languages.length) {
    await check("test material", "FLEURS clips", async () => {
      for (const language of new Set(["en", ...languages])) {
        clipsByLanguage[language] = await loadFleurs(language, CLIPS_PER_LANGUAGE);
      }
      silenceClips = buildSilenceSet(clipsByLanguage).filter((c) => SILENCE_CLIPS.includes(c.id));
      const short = Object.entries(clipsByLanguage).filter(
        ([, clips]) => clips.length < CLIPS_PER_LANGUAGE
      );
      const missing = SILENCE_CLIPS.filter((id) => !silenceClips.some((c) => c.id === id));
      const problems = [...short.map(([l, clips]) => `${l}: ${clips.length} clips`), ...missing];
      return { pass: !problems.length, detail: problems.join(", ") || null };
    });
  }
  if (checks.every((c) => c.pass)) {
    for (const [modelId, measured] of Object.entries(speechModels)) {
      await runSpeech(modelId, measured, clipsByLanguage, silenceClips);
    }
  }
  if (Object.keys(textModels).length) {
    const casesById = Object.fromEntries(
      readJson(path.join(EXAM_DIR, "fixtures/cleanup-cases.json")).cases.map((c) => [c.id, c])
    );
    const markers = instructionMarkersFrom(await text.cleanupSystemPrompt("en"));
    for (const [modelId, caseIds] of Object.entries(textModels)) {
      await runText(modelId, caseIds, casesById, markers);
    }
  }
} catch (error) {
  checks.push({ model: "canary", check: "run", pass: false, detail: error.stack || error.message });
}
await speech.stopAllSpeechEngines();
await text.stopTextModel();

const failed = checks.filter((c) => !c.pass);
const cell = (value) =>
  String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ");
const lines = [
  "# Local model exam canary",
  "",
  `Runner: ${process.platform} ${process.arch}, ${os.cpus().length} processors, ${(os.totalmem() / 2 ** 30).toFixed(0)} GiB.`,
  "",
  !checks.length
    ? "**Nothing was checked, so the run fails.**"
    : failed.length
      ? `**${failed.length} of ${checks.length} checks failed.**`
      : `**All ${checks.length} checks passed.**`,
  "",
  "| Model | Check | Result | Detail | Time |",
  "|---|---|---|---|---|",
  ...checks.map(
    (c) =>
      `| ${c.model} | ${c.check} | ${c.pass ? "pass" : "**fail**"} | ${cell(c.detail)} | ${c.ms == null ? "" : `${(c.ms / 1000).toFixed(1)} s`} |`
  ),
];
process.stdout.write(lines.join("\n") + "\n");
progress("records in", outDir);
process.exit(!checks.length || failed.length ? 1 : 0);
