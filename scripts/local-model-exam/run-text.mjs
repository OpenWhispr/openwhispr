// Text half of the local model exam, run on one machine.
//   node --import tsx scripts/local-model-exam/run-text.mjs [--models a,b] [--out dir] [--cases N] [--tasks N]
// Cleanup runs through the app's dictation chain; the agent through its local
// tool path with recorded fake tools. Quit OpenWhispr's local models first.
import fs from "node:fs";
import path from "node:path";
import {
  EXAM_DIR,
  listArg,
  log,
  median,
  parseArgs,
  readJson,
  recorder,
  resultsDir,
} from "./lib/cli.mjs";
import { installElectronStub } from "./lib/electron.mjs";
import { enginePeaks } from "./lib/memory.mjs";
import { agentCheck, cleanupRuleCheck, instructionMarkersFrom } from "./lib/rules.mjs";

installElectronStub();
const text = await import("./lib/text.mjs");

const args = parseArgs();
const DEFAULT_MODELS = [
  "qwen3.5-4b-q4_k_m",
  "gemma-4-e2b-it-q4_k_m",
  "gemma-4-e4b-it-qat-q4_0",
  "qwen3.5-9b-q4_k_m",
];
const models = listArg(args.models, DEFAULT_MODELS);
const outDir = resultsDir(args.out);
const record = recorder(outDir);

const cleanupFixture = readJson(path.join(EXAM_DIR, "fixtures/cleanup-cases.json"));
const agentFixture = readJson(path.join(EXAM_DIR, "fixtures/agent-tasks.json"));
const cases = cleanupFixture.cases.slice(0, Number(args.cases || cleanupFixture.cases.length));
const tasks = agentFixture.tasks.slice(0, Number(args.tasks || agentFixture.tasks.length));
const tools = await text.listAgentTools();
const writeTools = new Set(tools.filter((t) => !t.readOnly).map((t) => t.name));
const markers = instructionMarkersFrom(await text.cleanupSystemPrompt("en"));

// Dictations of about 15, 60 and 250 words for cleanup timing.
const normals = cleanupFixture.cases
  .filter((c) => c.language === "en" && c.kind === "normal")
  .map((c) => c.input);
const wordsOf = (s) => s.split(/\s+/).filter(Boolean).length;
const buildText = (target) => {
  const parts = [];
  let n = 0;
  for (let i = 0; n < target; i++) {
    const p = normals[i % normals.length];
    parts.push(p);
    n += wordsOf(p);
  }
  return parts.join(" ");
};
const lengths = [15, 60, 250].map((target) => ({
  target,
  input: target <= 20 ? normals[0] : buildText(target),
}));

const summary = { models: {} };
for (const modelId of models) {
  const s = (summary.models[modelId] = {
    getsTools: text.localModelGetsTools(modelId),
    cleanupSpeed: {},
    cleanup: {},
    agent: {},
    peakMiB: null,
  });
  log(`== ${modelId} (agent tools: ${s.getsTools})`);

  // 1. Cleanup time per length: cold (first after the model loads), then warm.
  for (const { target, input } of lengths) {
    await text.stopTextModel();
    const runs = [];
    for (let i = 0; i < 4; i++) {
      const r = await text.cleanup(modelId, input, { language: "en" });
      runs.push({ cold: i === 0, ms: r.ms, ok: r.ok });
      record({
        task: "cleanup-speed",
        model: modelId,
        words: wordsOf(input),
        cold: i === 0,
        ok: r.ok,
        error: r.error || null,
        ms: r.ms,
      });
    }
    s.cleanupSpeed[target] = {
      words: wordsOf(input),
      coldMs: runs[0].ms,
      warmMedianMs: median(
        runs
          .slice(1)
          .filter((x) => x.ok)
          .map((x) => x.ms)
      ),
      failures: runs.filter((x) => !x.ok).length,
    };
    log(`  cleanup ${target}w`, s.cleanupSpeed[target]);
  }

  // 2. Every cleanup case, warm.
  const tally = { cases: 0, failures: 0, answered: 0, echoed: 0, emptied: 0, notKept: 0 };
  for (const c of cases) {
    const r = await text.cleanup(modelId, c.input, { language: c.language });
    const check = cleanupRuleCheck(c, r.output, markers);
    tally.cases++;
    if (!r.ok) tally.failures++;
    if (check.answered) tally.answered++;
    if (check.echoedInstructions) tally.echoed++;
    if (check.emptied) tally.emptied++;
    if (!check.keptAll) tally.notKept++;
    record({
      task: "cleanup",
      model: modelId,
      case: c.id,
      language: c.language,
      kind: c.kind,
      ok: r.ok,
      error: r.error || null,
      ms: r.ms,
      input: c.input,
      output: r.output,
      ...check,
    });
  }
  s.cleanup = tally;
  log("  cleanup cases", tally);

  // 3. Agent tasks on the local tool path.
  const agentTally = {
    tasks: 0,
    correct: 0,
    sentUnasked: 0,
    errors: 0,
    firstWordsMs: [],
    twoStepMs: [],
  };
  for (const task of tasks) {
    // The fake notes search only finds the budget note; any other query finds
    // nothing, so a model that keeps searching is measured as doing so.
    const canned = { ...agentFixture.canned };
    const r = await text.agentTurn(modelId, {
      ...task,
      cannedResults: canned,
      cannedFor: (name, toolArgs) =>
        name === "search_notes" && !/budget/i.test(String(toolArgs?.query))
          ? { success: true, displayText: "", data: { results: [] } }
          : canned[name],
    });
    const check = agentCheck(task, r.calls, { sendTools: agentFixture.sendTools, writeTools });
    agentTally.tasks++;
    if (check.correct) agentTally.correct++;
    if (check.sentUnasked) agentTally.sentUnasked++;
    if (r.error) agentTally.errors++;
    if (r.firstWordsMs !== null) agentTally.firstWordsMs.push(r.firstWordsMs);
    if (task.kind === "two-step") agentTally.twoStepMs.push(r.totalMs);
    record({
      task: "agent",
      model: modelId,
      taskId: task.id,
      kind: task.kind,
      gotTools: r.gotTools,
      correct: check.correct,
      reason: check.reason,
      sentUnasked: check.sentUnasked,
      calls: r.calls,
      finalText: r.finalText.slice(0, 600),
      firstWordsMs: r.firstWordsMs,
      totalMs: r.totalMs,
      error: r.error,
    });
  }
  s.agent = {
    tasks: agentTally.tasks,
    correct: agentTally.correct,
    sentUnasked: agentTally.sentUnasked,
    errors: agentTally.errors,
    firstWordsMedianMs: median(agentTally.firstWordsMs),
    twoStepMedianMs: median(agentTally.twoStepMs),
  };
  log("  agent", s.agent);

  // 4. Peak memory of llama-server for this model.
  const peaks = await enginePeaks();
  s.peakMiB = Object.values(peaks).length ? Math.max(...Object.values(peaks)) : null;
  record({ task: "memory", model: modelId, peaks });
  log("  peak memory MiB", peaks);
  fs.writeFileSync(path.join(outDir, "text-summary.json"), JSON.stringify(summary, null, 2));
}

await text.stopTextModel();
fs.writeFileSync(path.join(outDir, "text-summary.json"), JSON.stringify(summary, null, 2));
log("done", outDir);
process.exit(0);
