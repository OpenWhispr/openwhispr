// Cloud baseline, the reference the local models' accuracy is compared with:
// sends the exam's accuracy clips through OpenWhispr Cloud's
// dictation route, the one the desktop uses (/api/transcribe, raw transcript,
// no cleanup), and scores the transcripts the way the local models are scored.
// The cloud model can answer the same audio differently from one request to the
// next, so every clip is sent --runs times (default 3): all clips once, then all
// again, and the baseline keeps each run's score and the spread between them.
// Run it once per test-set version; the result is frozen with that version.
//   OW_CLOUD_TOKEN_FILE=<file> node scripts/local-model-exam/cloud-baseline.mjs --speech <dir> [--runs 3] [--parallel 1] [--limit n] [--gap-ms 1500]
//   node scripts/local-model-exam/cloud-baseline.mjs --speech <dir> --score-only
// <dir> is a speech run (its records.jsonl fixes the clip set). The token file
// holds a Better Auth bearer from a test sign-in; it is read, never printed.
// Public test clips only, never customer audio. At most --parallel requests are
// in flight, each lane waiting --gap-ms between starts, and the run stops on any
// auth or limit answer, or when failures pile up.
// Writes <dir>/cloud-records.jsonl (one line per request; a rerun skips the
// clip-runs already done) and <dir>/cloud-baseline.json.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pcmToWav } from "./lib/audio.mjs";
import { log, parseArgs, readJsonl } from "./lib/cli.mjs";
import { errorCounts, pooledErrorsPer100 } from "./lib/score.mjs";
import { DICTATION_SENTENCES, FLEURS_LANGUAGES, loadFleurs, loadSynthetic } from "./lib/sets.mjs";

const args = parseArgs();
const speechDir = args.speech;
if (!speechDir || !fs.existsSync(path.join(speechDir, "records.jsonl")))
  throw new Error("--speech <dir> with a records.jsonl is required");
const api = String(args.api || "https://api.openwhispr.com").replace(/\/$/, "");
const gapMs = Number(args["gap-ms"] || 1500);
const limit = args.limit ? Number(args.limit) : Infinity;
const runs = Number(args.runs || 3);
const parallel = Number(args.parallel || 1);
const clipsPerLanguage = Number(args.clips || 12);
const recordsPath = path.join(speechDir, "cloud-records.jsonl");
const outPath = path.join(speechDir, "cloud-baseline.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The same clips run-speech.mjs scored, from the cache, checked against the run.
const byLanguage = {};
for (const language of FLEURS_LANGUAGES)
  byLanguage[language] = await loadFleurs(
    language,
    language === "en" ? Math.max(40, clipsPerLanguage) : clipsPerLanguage
  );
const clips = [
  ...FLEURS_LANGUAGES.flatMap((l) => byLanguage[l].slice(0, clipsPerLanguage)),
  ...(await Promise.all(Object.keys(DICTATION_SENTENCES).map(loadSynthetic))).flat(),
];
const scored = new Set(
  readJsonl(path.join(speechDir, "records.jsonl"))
    .filter((r) => r.task === "accuracy")
    .map((r) => r.clip)
);
const ids = new Set(clips.map((c) => c.id));
const missing = [...scored].filter((id) => !ids.has(id));
const extra = [...ids].filter((id) => !scored.has(id));
if (missing.length || extra.length)
  throw new Error(
    `clip set differs from the speech run (missing ${missing.length}, extra ${extra.length}); a new test-set version needs its own baseline`
  );
const fingerprint = crypto
  .createHash("sha256")
  .update(
    clips
      .map((c) => `${c.id}\t${c.reference}`)
      .sort()
      .join("\n")
  )
  .digest("hex")
  .slice(0, 16);
log(`${clips.length} accuracy clips, test set ${fingerprint}`);

// The cloud model rejects these language codes (HTTP 500 "Language code 'mt' is
// not recognized", 2026-10-22), so their clips go without one and it detects
// the language itself. Recorded per request as languageSent.
const CLOUD_DETECTS_LANGUAGE = new Set(["mt"]);
const runKey = (clip, run) => `${clip}#${run}`;
const done = new Set(
  readJsonl(recordsPath)
    .filter((r) => r.ok)
    .map((r) => runKey(r.clip, r.run))
);

if (!args["score-only"]) {
  const tokenFile = process.env.OW_CLOUD_TOKEN_FILE;
  if (!tokenFile || !fs.existsSync(tokenFile))
    throw new Error("OW_CLOUD_TOKEN_FILE must point at a file holding the bearer");
  const token = fs.readFileSync(tokenFile, "utf8").trim();
  const todo = Array.from({ length: runs }, (_, i) => i + 1)
    .flatMap((run) => clips.map((clip) => ({ clip, run })))
    .filter(({ clip, run }) => !done.has(runKey(clip.id, run)))
    .slice(0, limit);
  log(
    `${done.size} already done, sending ${todo.length} to ${api}/api/transcribe, ${parallel} at a time, each lane one every ${gapMs} ms or slower`
  );
  let sent = 0;
  let failed = 0;
  let failedInARow = 0;
  let next = 0;
  let stopped = false;
  const stop = (why) => {
    if (!stopped) log(`stopping: ${why}`);
    stopped = true;
  };
  const send = async ({ clip, run }) => {
    const started = Date.now();
    const languageSent = CLOUD_DETECTS_LANGUAGE.has(clip.language) ? null : clip.language;
    // Built whole, so the upload goes with a known length.
    const boundary = `----exam${crypto.randomBytes(12).toString("hex")}`;
    const field = (name, value) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`
      ),
      pcmToWav(clip.pcm),
      Buffer.from(
        `\r\n${languageSent ? field("language", languageSent) : ""}${field("sendLogs", "false")}--${boundary}--\r\n`
      ),
    ]);
    let status = 0;
    let reply = null;
    let error = null;
    try {
      const res = await fetch(`${api}/api/transcribe`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "openwhispr-local-model-exam",
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
      });
      status = res.status;
      reply = await res.json().catch(() => null);
    } catch (err) {
      error = err.message;
    }
    sent++;
    // 422 is the route's "no speech found": an empty transcript, scored as such.
    const ok = status === 200 || status === 422;
    const text = status === 200 ? String(reply?.text ?? "") : "";
    fs.appendFileSync(
      recordsPath,
      JSON.stringify({
        at: new Date().toISOString(),
        clip: clip.id,
        run,
        set: clip.set,
        language: clip.language,
        languageSent,
        group: clip.group,
        ok,
        status,
        error: ok ? null : error || reply?.error || `HTTP ${status}`,
        ms: Date.now() - started,
        sttProvider: reply?.sttProvider ?? null,
        sttModel: reply?.sttModel ?? null,
        sttProcessingMs: reply?.sttProcessingMs ?? null,
        audioMs: Math.round((clip.pcm.length / 32000) * 1000),
        reference: clip.reference,
        text,
      }) + "\n"
    );
    if (ok) {
      failedInARow = 0;
      done.add(runKey(clip.id, run));
    } else {
      failed++;
      failedInARow++;
      log(`  ${clip.id} run ${run}: ${status || "network"} ${error || reply?.error || ""}`);
    }
    if (sent % 25 === 0) log(`  ${sent} of ${todo.length} sent, ${failed} failed`);
    if ([401, 403, 426, 429].includes(status))
      stop(`HTTP ${status} (${reply?.error || "auth or limit"})`);
    if (failedInARow >= 3) stop("3 failures in a row");
    if (sent >= 20 && failed / sent > 0.05) stop(`${failed} of ${sent} failed`);
    await sleep(Math.max(0, gapMs - (Date.now() - started)));
  };
  await Promise.all(
    Array.from({ length: parallel }, async () => {
      while (!stopped && next < todo.length) await send(todo[next++]);
    })
  );
  log(`sent ${sent}, failed ${failed}`);
}

// Scored from the saved transcripts, like report.mjs does for the local models.
// A clip counts only when every run of it came back.
const cloudRecords = readJsonl(recordsPath);
const latest = new Map(cloudRecords.map((r) => [runKey(r.clip, r.run), r]));
const runNumbers = Array.from({ length: runs }, (_, i) => i + 1);
const complete = (c) => runNumbers.every((run) => latest.get(runKey(c.id, run))?.ok);
const results = clips.filter(complete).map((c) => {
  const perRun = runNumbers.map((run) => {
    const r = latest.get(runKey(c.id, run));
    return {
      run,
      sttModel: r.sttModel,
      status: r.status,
      ms: r.ms,
      text: r.text,
      counts: errorCounts(c.reference, r.text, c.language),
    };
  });
  return {
    clip: c.id,
    set: c.set,
    language: c.language,
    group: c.group,
    reference: c.reference,
    sameTextEveryRun: new Set(perRun.map((r) => r.text)).size === 1,
    runs: perRun,
  };
});
// Each run's pooled rate, then their mean and spread.
const spread = (list) => {
  if (!list.length) return null;
  const rates = runNumbers.map((_, i) => pooledErrorsPer100(list.map((r) => r.runs[i].counts)));
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  const sd = Math.sqrt(
    rates.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rates.length - 1)
  );
  return {
    clips: list.length,
    runRates: rates,
    mean,
    min: Math.min(...rates),
    max: Math.max(...rates),
    sd,
    clipsWithDifferentText: list.filter((r) => !r.sameTextEveryRun).length,
  };
};
const models = {};
for (const r of results.flatMap((c) => c.runs))
  models[r.sttModel || "unknown"] = (models[r.sttModel || "unknown"] || 0) + 1;
const perLanguage = Object.fromEntries(
  Object.entries(Object.groupBy(results, (r) => `${r.language}:${r.set}`)).map(([k, list]) => [
    k,
    spread(list),
  ])
);
const baseline = {
  // When the last cloud reply came back, so --score-only leaves it unchanged.
  createdAt: cloudRecords.at(-1)?.at ?? new Date().toISOString(),
  route: `${api}/api/transcribe`,
  runs,
  models,
  languageDetectedByCloud: [...CLOUD_DETECTS_LANGUAGE],
  testSet: {
    fingerprint,
    clips: clips.length,
    scored: results.length,
    notScored: clips.filter((c) => !complete(c)).map((c) => c.id),
  },
  summary: {
    pooled: spread(results),
    englishFleurs: spread(results.filter((r) => r.language === "en" && r.set === "fleurs")),
    englishVoice: spread(results.filter((r) => r.language === "en" && r.set === "synthetic")),
    majorEuropean: spread(
      results.filter((r) => r.group === "major-european" && r.set === "fleurs")
    ),
    otherEuropean: spread(
      results.filter((r) => r.group === "other-european" && r.set === "fleurs")
    ),
    asianOtherVoice: spread(results.filter((r) => r.group === "asian-other")),
    byLanguage: perLanguage,
  },
  clips: results,
};
fs.writeFileSync(outPath, JSON.stringify(baseline, null, 2) + "\n");
const show = (v) =>
  v ? `${v.mean.toFixed(1)} (${v.min.toFixed(1)}–${v.max.toFixed(1)}, ${v.clips} clips)` : "–";
log(`wrote ${outPath}: ${results.length} of ${clips.length} clips scored on all ${runs} runs`);
for (const [k, v] of Object.entries(baseline.summary))
  if (k !== "byLanguage") log(`  ${k}: ${show(v)}`);
