// Builds a markdown report from one machine's speech and text results.
//   node --import tsx scripts/local-model-exam/report.mjs --speech <dir> --text <dir>[,<dir>] [--judge <file>] [--cloud <file>] --out <file>
// --cloud defaults to <speech dir>/cloud-baseline.json (cloud-baseline.mjs).
import fs from "node:fs";
import path from "node:path";
import { EXAM_DIR, parseArgs, readJson, readJsonl } from "./lib/cli.mjs";
import { cleanupRuleCheck, instructionMarkersFrom } from "./lib/rules.mjs";
import { errorCounts, insertionsOutsideSpeech } from "./lib/score.mjs";
import { GROUP_OF } from "./lib/sets.mjs";

const args = parseArgs();
const fmtS = (ms) => (ms == null ? "–" : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`);
const fmtN = (n, d = 1) => (n == null || Number.isNaN(n) ? "–" : Number(n).toFixed(d));
const mark = (ok) => (ok == null ? "–" : ok ? "pass" : "fail");

// Pass marks set on 2026-10-21. Speed was reset on 2026-10-22: accuracy first,
// with good speed: at most 3 s after a typical 60-word dictation, 2 s or less is
// good, under 1 s the goal. Longer dictations may take longer.
const GOOD_SPEED_MS_AT_60_WORDS = 3000;
const GREAT_SPEED_MS_AT_60_WORDS = 2000;
// Cloud today, shown for comparison only.
const CLOUD_WAIT_MS = { 15: 1300, 60: 1300, 250: 4400, 600: 6700 };
const cloudWait = (words) => `${CLOUD_WAIT_MS[words] / 1000} s`;
const CLEANUP_MAX_CHANGE_RATE = 1 / 50;
const AGENT = { minCorrect: 0.9, firstWordsMs: 3000, twoStepMs: 15000 };
const ACCURACY_MAX_GAP = 2;

const speechDir = args.speech;
const textDirs = (args.text || "").split(",").filter(Boolean);
const speech =
  speechDir && fs.existsSync(path.join(speechDir, "speech-summary.json"))
    ? readJson(path.join(speechDir, "speech-summary.json"))
    : null;
// Accuracy is rescored from the saved transcripts, so a scoring fix applies to
// past runs too.
const speechRecords = (speechDir ? readJsonl(path.join(speechDir, "records.jsonl")) : []).map(
  (r) =>
    r.task === "accuracy" && typeof r.reference === "string"
      ? { ...r, counts: errorCounts(r.reference, r.text || "", r.language) }
      : r
);
// The cloud's transcripts of the same clips, rescored the same way.
const cloudPath = args.cloud || (speechDir && path.join(speechDir, "cloud-baseline.json"));
const cloud = cloudPath && fs.existsSync(cloudPath) ? readJson(cloudPath) : null;
// One set of counts per cloud run, since the cloud can answer the same clip differently.
const cloudCounts = new Map(
  (cloud?.clips || []).map((c) => [
    c.clip,
    c.runs.map((r) => errorCounts(c.reference, r.text || "", c.language)),
  ])
);
const cloudRuns = cloud?.runs || 0;
const cloudName = cloud ? `cloud (${Object.keys(cloud.models).join(", ")})` : null;
const textModels = {};
const textRecords = [];
for (const dir of textDirs) {
  const summary = readJson(path.join(dir, "text-summary.json"));
  Object.assign(textModels, summary.models);
  textRecords.push(...readJsonl(path.join(dir, "records.jsonl")));
}
const judge = args.judge && fs.existsSync(args.judge) ? readJson(args.judge) : null;
const cases = readJson(path.join(EXAM_DIR, "fixtures/cleanup-cases.json")).cases;
const caseById = Object.fromEntries(cases.map((c) => [c.id, c]));
const markers = instructionMarkersFrom(
  readJson(path.join(EXAM_DIR, "../../src/locales/en/prompts.json")).cleanupPrompt
);

const lines = [];
const out = (s = "") => lines.push(s);

out(`# Local model exam — results on one machine`);
out();
const profile = speech?.profile;
// Apple-chip Macs fall into a type by memory alone; a PC's type depends on its
// graphics card, which the profile does not record.
const macType = (p) =>
  p.platform !== "darwin" || p.arch !== "arm64"
    ? null
    : p.ramGiB >= 32
      ? "5 (Apple chip, 32 GB or more)"
      : p.ramGiB >= 16
        ? "4b (Apple chip, 16–31 GB)"
        : "4a (Apple chip, under 16 GB)";
if (profile)
  out(
    `Machine: ${profile.chip}, ${profile.ramGiB} GiB RAM, ${profile.cpus} cores (${profile.platform}/${profile.arch}).${macType(profile) ? ` Machine type **${macType(profile)}**.` : ""}`
  );
out();

if (speech) {
  out(`## Speech: the wait after you stop talking`);
  out();
  out(
    `Measured on this machine. FLEURS clips are slow read speech, so the wait for the same number of words at a normal 150 words a minute is estimated from the measured rate (streaming models don't depend on length). Speed bar: at most ${GOOD_SPEED_MS_AT_60_WORDS / 1000} s after a typical 60-word dictation (${GREAT_SPEED_MS_AT_60_WORDS / 1000} s or less is good), judged on the slower of the first dictation after the model loads and the ones after it; when only that first one misses, the table says so. Other lengths are information only. Cloud today, for comparison only: ${cloudWait(60)} under 100 words, ${cloudWait(250)} at 200–299, ${cloudWait(600)} at 600+.`
  );
  out();
  out(
    `| Model | 15 words (cold / warm) | 60 words | 250 words | 600 words | Speed here (60 words within ${GOOD_SPEED_MS_AT_60_WORDS / 1000} s) |`
  );
  out(`|---|---|---|---|---|---|`);
  for (const [id, m] of Object.entries(speech.models)) {
    const cells = [15, 60, 250, 600].map((w) => {
      const v = m.speed[w];
      if (!v) return "–";
      const e = v.estimatedAt150wpm || {};
      return `${fmtS(e.coldMs ?? v.coldMs)} / ${fmtS(e.warmMs ?? v.warmMedianMs)}`;
    });
    const v = m.speed[60];
    const e = v?.estimatedAt150wpm || {};
    const warm = e.warmMs ?? v?.warmMedianMs;
    const cold = e.coldMs ?? v?.coldMs;
    const slower = Math.max(warm ?? 0, cold ?? 0);
    const speed =
      warm == null
        ? "–"
        : slower <= GREAT_SPEED_MS_AT_60_WORDS
          ? "good"
          : slower <= GOOD_SPEED_MS_AT_60_WORDS
            ? "pass"
            : warm <= GOOD_SPEED_MS_AT_60_WORDS
              ? `fail on the first dictation after loading (${fmtS(warm)} after that)`
              : "fail";
    out(`| ${id} | ${cells.join(" | ")} | ${speed} |`);
  }
  out();

  out(
    `## Speech: accuracy (word errors per 100 words; characters for Chinese, Japanese, Korean, Thai)`
  );
  out();
  // How much each local model's errors moved when the same dictation was decoded
  // again (the speed test repeats each length).
  const repeats = Object.groupBy(
    speechRecords.filter((r) => r.task === "dictation-speed" && r.errorsPer100 != null),
    (r) => `${r.model}|${r.clip}`
  );
  const moved = {};
  for (const list of Object.values(repeats)) {
    const spread =
      Math.max(...list.map((r) => r.errorsPer100)) - Math.min(...list.map((r) => r.errorsPer100));
    if (spread > 0) moved[list[0].model] = Math.max(moved[list[0].model] || 0, spread);
  }
  const movedList = Object.entries(moved).map(
    ([id, spread]) => `${id} (up to ${fmtN(spread)} apart)`
  );
  const localRepeatNote = `Local models ran once per clip. Decoding the same dictation again gave identical errors for ${movedList.length ? `every local model except ${movedList.join(", ")}` : "every local model"}, but streaming models change their errors when the same speech starts a fraction of a second later, so a local gap near the bar is not settled either.`;
  const realSpeechNote = `Real speech is FLEURS (25 European languages, about 12 clips each, so a single language can move by several points). The other languages use the Mac's built-in voices, which are cleaner than real speech, so their error rates flatter every model.`;
  if (cloud) {
    out(
      `Pooled errors per 100 words, with the number of clips in brackets, then the gap to ${cloudName} on exactly the same clips. The bar: at most ${ACCURACY_MAX_GAP} more errors per 100 words than cloud. The cloud ran every clip ${cloudRuns} times on ${cloud.createdAt.slice(0, 10)} through the desktop's own route (raw transcript, no cleanup, the clip's language set as for the local models; test set ${cloud.testSet.fingerprint}), because it can answer the same audio differently each time. The gap is measured from the cloud's average, and "±" is half the spread between its runs. "pass" means within the bar against every cloud run, "fail" means outside it against every run, and anything in between is "too close to call": the cloud's own noise decides it. ${localRepeatNote} ${realSpeechNote} The last column scores the bar language by language; with about 12 clips each it is a guide, not the verdict.`
    );
  } else {
    out(
      `Pooled errors per 100 words, with the number of clips in brackets. ${realSpeechNote} No cloud baseline yet, so the "within 2 of cloud" bar cannot be scored; these are raw error rates.`
    );
  }
  out();
  const groupFilters = [
    (r) => r.language === "en" && r.set === "fleurs",
    (r) => r.language === "en" && r.set === "synthetic",
    (r) => GROUP_OF[r.language] === "major-european" && r.set === "fleurs",
    (r) => GROUP_OF[r.language] === "other-european" && r.set === "fleurs",
    (r) => GROUP_OF[r.language] === "asian-other",
  ];
  const rateOf = (recs, countsOf = (r) => r.counts) => {
    const t = recs.reduce(
      (a, r) => {
        const c = countsOf(r);
        return { e: a.e + c.substitutions + c.deletions + c.insertions, n: a.n + c.referenceUnits };
      },
      { e: 0, n: 0 }
    );
    return t.n ? (100 * t.e) / t.n : null;
  };
  const cloudRateRuns = (recs) =>
    Array.from({ length: cloudRuns }, (_, i) => rateOf(recs, (r) => cloudCounts.get(r.clip)[i]));
  // Taken on exactly the clips both were scored on, so a clip the cloud failed
  // on never counts against a model; one gap per cloud run.
  const gapToCloud = (recs) => {
    const shared = recs.filter((r) => cloudCounts.has(r.clip));
    if (!shared.length) return null;
    const local = rateOf(shared);
    const gaps = cloudRateRuns(shared).map((c) => local - c);
    return {
      gap: gaps.reduce((a, b) => a + b, 0) / gaps.length,
      min: Math.min(...gaps),
      max: Math.max(...gaps),
    };
  };
  const within = (gap) => Number(gap.toFixed(1)) <= ACCURACY_MAX_GAP;
  const verdict = (g) => (within(g.max) ? "pass" : within(g.min) ? "too close to call" : "fail");
  const fmtGap = (g) =>
    `${g.gap >= 0 ? "+" : ""}${fmtN(g.gap)} ±${fmtN((g.max - g.min) / 2)} ${verdict(g)}`;
  const accuracyRecords = speechRecords.filter((r) => r.task === "accuracy");
  out(
    `| Model | English (FLEURS) | English dictation (voice) | Major European | Other European | Asian and other (voice) |${cloud ? " Languages within 2 of cloud |" : ""}`
  );
  out(`|---|---|---|---|---|---|${cloud ? "---|" : ""}`);
  if (cloud) {
    const cells = groupFilters.map((f) => {
      const recs = cloud.clips.filter(f);
      if (!recs.length) return "–";
      const rates = cloudRateRuns(recs);
      return `${fmtN(rates.reduce((a, b) => a + b, 0) / rates.length)} (${recs.length}), runs ${fmtN(Math.min(...rates))}–${fmtN(Math.max(...rates))}`;
    });
    out(`| ${cloudName} | ${cells.join(" | ")} | – |`);
  }
  for (const id of Object.keys(speech.models)) {
    const mine = accuracyRecords.filter((r) => r.model === id);
    const cells = groupFilters.map((f) => {
      const recs = mine.filter(f);
      const rate = rateOf(recs);
      if (rate == null) return "–";
      const gap = gapToCloud(recs);
      return `${fmtN(rate)} (${recs.length})${gap == null ? "" : `, ${fmtGap(gap)}`}`;
    });
    let languages = "";
    if (cloud) {
      const byLanguage = Object.groupBy(mine, (r) => `${r.language}:${r.set}`);
      const verdicts = Object.values(byLanguage)
        .map(gapToCloud)
        .filter((g) => g != null)
        .map(verdict);
      const close = verdicts.filter((v) => v === "too close to call").length;
      languages = ` ${verdicts.filter((v) => v === "pass").length} of ${verdicts.length}${close ? ` (${close} too close to call)` : ""} |`;
    }
    out(`| ${id} | ${cells.join(" | ")} |${languages}`);
  }
  out();

  out(`### Accuracy by language`);
  out();
  out(
    `Errors per 100 words (characters for Chinese, Japanese, Korean and Thai), FLEURS real speech unless marked "voice". The best local model in each row is in bold; "–" means the model does not support the language.${cloud ? ` The cloud column is the baseline the bar is measured from, averaged over its ${cloudRuns} runs.` : ""}`
  );
  out();
  const ids = Object.keys(speech.models);
  const byLang = {};
  const cloudRows = cloud
    ? cloud.clips.flatMap((c) =>
        cloudCounts.get(c.clip).map((counts) => ({ ...c, model: cloudName, counts }))
      )
    : [];
  for (const r of [...accuracyRecords, ...cloudRows]) {
    const key = `${r.language}${r.set === "synthetic" ? " (voice)" : ""}`;
    const cell = ((byLang[key] ||= {})[r.model] ||= { e: 0, n: 0, clips: 0 });
    cell.e += r.counts.substitutions + r.counts.deletions + r.counts.insertions;
    cell.n += r.counts.referenceUnits;
    cell.clips++;
  }
  const cloudCell = (key) =>
    cloud
      ? `${byLang[key][cloudName]?.n ? fmtN((100 * byLang[key][cloudName].e) / byLang[key][cloudName].n) : "–"} | `
      : "";
  out(`| Language (clips) | ${cloud ? `${cloudName} | ` : ""}${ids.join(" | ")} |`);
  out(`|---|${cloud ? "---|" : ""}${ids.map(() => "---").join("|")}|`);
  const groupRank = (key) =>
    ["english", "major-european", "other-european", "asian-other"].indexOf(
      GROUP_OF[key.split(" ")[0]]
    );
  for (const key of Object.keys(byLang).sort(
    (a, b) => groupRank(a) - groupRank(b) || a.localeCompare(b)
  )) {
    const rates = ids.map((id) =>
      byLang[key][id]?.n ? (100 * byLang[key][id].e) / byLang[key][id].n : null
    );
    const best = Math.min(...rates.filter((x) => x != null));
    const clips = Math.max(...ids.map((id) => byLang[key][id]?.clips || 0));
    out(
      `| ${key} (${clips}) | ${cloudCell(key)}${rates.map((v) => (v == null ? "–" : v === best ? `**${fmtN(v)}**` : fmtN(v))).join(" | ")} |`
    );
  }
  out();

  out(`## Speech: made-up words on silence (deal-breaker)`);
  out();
  out(
    `Each clip ran 10 times on the shipped path, where the app's speech gate drops pure silence before it reaches a model. Silence and noise clips count every word written. Speech followed by silence, noise or a long pause counts only words written in the silent part: a word misheard inside the speech is an accuracy error, not a made-up word. Clips in a language the model doesn't support are left out.`
  );
  out();
  out(
    `| Model | Silence or noise only: runs with words | Pure silence fed straight to the model (gate off): runs with words | Speech then silence, noise or a pause: clips with words in the silent part | Example | Passes? |`
  );
  out(`|---|---|---|---|---|---|`);
  // Older runs did not store each speech clip's reference parts. The set is
  // built from the first two FLEURS clips per language, in order.
  const firstClips = {};
  for (const r of speechRecords) {
    if (r.task !== "accuracy" || r.set !== "fleurs") continue;
    const list = (firstClips[r.language] ||= []);
    if (list.length < 2 && !list.some((c) => c.clip === r.clip))
      list.push({ clip: r.clip, reference: r.reference });
  }
  const partsFor = (rec) => {
    if (rec.referenceParts) return rec.referenceParts;
    const lang = /^trailing-silence-(\w+)$/.exec(rec.clip)?.[1];
    if (lang) return firstClips[lang]?.[0] ? [firstClips[lang][0].reference] : null;
    if (rec.clip === "mid-pause-en")
      return firstClips.en?.length >= 2 ? firstClips.en.map((c) => c.reference) : null;
    if (rec.clip === "speech-then-noise-en")
      return firstClips.en?.[0] ? [firstClips.en[0].reference] : null;
    return null;
  };
  const silenceRows = (id, vad) => {
    const recs = speechRecords.filter(
      (r) => r.task === "silence" && r.model === id && !!r.vad === vad
    );
    if (!recs.length) return null;
    const noSpeech = recs.filter((r) => r.kind === "no-speech");
    const runs = noSpeech.reduce(
      (a, r) => a + (r.gateSkips ? 0 : r.extraWords.filter((x) => x > 0).length),
      0
    );
    const noSpeechBad = noSpeech.filter((r) => !r.gateSkips && r.extraWords.some((x) => x > 0));
    const speechBad = [];
    for (const r of recs.filter((x) => x.kind !== "no-speech")) {
      const parts = partsFor(r);
      if (!parts || r.gateSkips) continue;
      const lang = /^trailing-silence-(\w+)$/.exec(r.clip)?.[1] || "en";
      const added = r.outputs.map((o) => insertionsOutsideSpeech(parts, o, lang));
      if (Math.max(...added) > 0)
        speechBad.push({ clip: r.clip, output: r.outputs[added.indexOf(Math.max(...added))] });
    }
    const speechCount = recs.filter((x) => x.kind !== "no-speech").length;
    const gated = noSpeech.filter((r) => r.gateSkips);
    const rawRuns = gated.reduce((a, r) => a + r.extraWords.filter((x) => x > 0).length, 0);
    const example = noSpeechBad[0]
      ? `${noSpeechBad[0].clip}: "${noSpeechBad[0].outputs.find((o) => o.trim())?.slice(0, 60)}"`
      : speechBad[0]
        ? `${speechBad[0].clip}: "…${speechBad[0].output.slice(-60)}"`
        : "none";
    return `${runs} of ${noSpeech.length * 10} | ${gated.length ? `${rawRuns} of ${gated.length * 10}` : "–"} | ${speechBad.length} of ${speechCount}${speechBad.length ? ` (${speechBad.map((b) => b.clip).join(", ")})` : ""} | ${example} | ${mark(runs === 0 && speechBad.length === 0)} |`;
  };
  for (const id of Object.keys(speech.models)) {
    const row = silenceRows(id, false);
    if (row) out(`| ${id} | ${row}`);
    const vadRow = silenceRows(id, true);
    if (vadRow) out(`| ${id} with the app's silence detection on | ${vadRow}`);
  }
  out();

  out(`## Live preview`);
  out();
  out(
    `The words that appear on screen while you talk (the preview setting). Streaming models show their running transcript, which becomes the final text. Offline models decode each new 1.5 s of audio on its own for the preview, then decode the whole recording again for the final text, so their preview can read worse than the result. Measured on the 60-word clip, in real time.`
  );
  out();
  out(
    `| Model | Path | First words appear after | Updates | Longest gap or lag | Preview errors per 100 words | Final errors per 100 words |`
  );
  out(`|---|---|---|---|---|---|---|`);
  for (const [id, m] of Object.entries(speech.models)) {
    const p = m.preview || {};
    const live = p.path === "live stream";
    const gap = live ? p.maxGapMs : p.maxLagMs;
    const final = speechRecords.find(
      (r) => r.task === "dictation-speed" && r.model === id && r.clip === "length-60" && !r.cold
    )?.errorsPer100;
    const previewErrors = live ? final : p.previewErrorsPer100;
    out(
      `| ${id} | ${live ? "live stream" : p.path || "–"} | ${fmtS(p.firstWordsMs)} | ${p.updates ?? p.chunks ?? "–"} | ${fmtS(gap)} | ${fmtN(previewErrors)} | ${fmtN(final)} |`
    );
  }
  out();
}

if (Object.keys(textModels).length) {
  out(`## Cleanup (on by default)`);
  out();
  out(
    `Cleanup time is on top of the speech wait, and the whole dictation should still land within about ${GOOD_SPEED_MS_AT_60_WORDS / 1000} s at 60 words (the cloud's whole dictation takes ${cloudWait(60)}). Meaning changes were judged blind by a separate reviewer model, then every flag was checked by hand: "borderline" means a careful editor could pass it. ${cases.length} dictations is too few to prove the 1-in-${Math.round(1 / CLEANUP_MAX_CHANGE_RATE)} bar (that takes about 150 clean results per language group); no clear change in ${cases.length} only shows the true rate is under about ${((3 / cases.length) * 100).toFixed(1)}%.`
  );
  out();
  const lengthWords = Object.values(textModels)[0]?.cleanupSpeed || {};
  const lw = (w) => `${lengthWords[w]?.words ?? w} words`;
  out(
    `| Model | ${lw(15)} (first / warm) | ${lw(60)} | ${lw(250)} | Meaning changed: clear / borderline | Did what the dictation asked instead (deal-breaker) | Extra text pasted | Printed its own instructions (rule) |`
  );
  out(`|---|---|---|---|---|---|---|---|`);
  for (const [id, m] of Object.entries(textModels)) {
    const sp = (w) =>
      m.cleanupSpeed[w]
        ? `${fmtS(m.cleanupSpeed[w].coldMs)} / ${fmtS(m.cleanupSpeed[w].warmMedianMs)}`
        : "–";
    const recs = textRecords.filter((r) => r.task === "cleanup" && r.model === id);
    const rechecked = recs.map((r) => cleanupRuleCheck(caseById[r.case], r.output || "", markers));
    const echoed = rechecked.filter((c) => c.echoedInstructions).length;
    const failures = recs.filter((r) => !r.ok).length;
    const j = judge?.[id];
    const judged = (v) => (j ? String(v) : "not judged");
    out(
      `| ${id} | ${sp(15)} | ${sp(60)} | ${sp(250)} | ${j ? `${j.meaningChanged} / ${j.borderline} of ${j.judged}` : "not judged"}${failures ? ` (${failures} errors)` : ""} | ${judged(j?.answeredInstead)} | ${judged(j?.format)} | ${echoed} |`
    );
  }
  out();
  out(`## Agent`);
  out();
  out(
    `Fake tools; the app gives tools only to models named 4B or larger, so a model without tools can only get the 8 tasks right that need no tool. Bars: correct ${AGENT.minCorrect * 10} in 10, first words within ${AGENT.firstWordsMs / 1000} s, a two-step request within ${AGENT.twoStepMs / 1000} s, never sends unasked.`
  );
  out();
  out(
    `| Model | Gets tools | Correct | Sent unasked | First words (median) | Two-step (median) | Peak memory |`
  );
  out(`|---|---|---|---|---|---|---|`);
  for (const [id, m] of Object.entries(textModels)) {
    const a = m.agent || {};
    out(
      `| ${id} | ${m.getsTools ? "yes" : "no (name under 4B)"} | ${a.correct ?? "–"} of ${a.tasks ?? "–"} | ${a.sentUnasked ?? "–"} | ${fmtS(a.firstWordsMedianMs)} | ${fmtS(a.twoStepMedianMs)} | ${m.peakMiB ? `${(m.peakMiB / 1024).toFixed(2)} GiB` : "–"} |`
    );
  }
  out();
}

fs.writeFileSync(args.out, lines.join("\n") + "\n");
console.log("wrote", args.out);
