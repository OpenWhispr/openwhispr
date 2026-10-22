// How fast each text model reads a prompt and writes its answer on this
// machine, and whether the app's requests reuse the fixed instructions from
// the previous request (llama-server keeps the last prompt and skips re-reading
// a shared start). The rates feed the predictions for other machines.
//   node --import tsx scripts/local-model-exam/measure-rates.mjs [--models a,b] --out <dir>
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { EXAM_DIR, listArg, log, parseArgs, readJson, resultsDir } from "./lib/cli.mjs";
import { installElectronStub, REPO_ROOT } from "./lib/electron.mjs";

installElectronStub();
const text = await import("./lib/text.mjs");
const prompts = await import(pathToFileURL(path.join(REPO_ROOT, "src/config/prompts.ts")).href);

const args = parseArgs();
const DEFAULT_MODELS = [
  "qwen3.5-2b-q4_k_m",
  "qwen3.5-4b-q4_k_m",
  "gemma-4-e2b-it-q4_k_m",
  "gemma-4-e4b-it-qat-q4_0",
  "qwen3.5-9b-q4_k_m",
  "lfm2.5-1.2b-instruct-q4_k_m",
  "llama-3.2-3b-instruct-q4_k_m",
];
const models = listArg(args.models, DEFAULT_MODELS);
const outDir = resultsDir(args.out);

const cleanupFixture = readJson(path.join(EXAM_DIR, "fixtures/cleanup-cases.json"));
const agentFixture = readJson(path.join(EXAM_DIR, "fixtures/agent-tasks.json"));
const normals = cleanupFixture.cases
  .filter((c) => c.language === "en" && c.kind === "normal")
  .map((c) => c.input);
// Dictations of about `words` words; offset 0 is the text run-text.mjs timed.
const dictation = (offset, words = 60) => {
  const parts = [];
  for (let i = offset, n = 0; n < words; i++) {
    parts.push(normals[i % normals.length]);
    n += normals[i % normals.length].split(/\s+/).length;
  }
  return parts.join(" ");
};

// The request the app sends for a cleanup (llamaServer.inference), with
// llama-server's own timings read from the reply.
function cleanupRequest(port, systemPrompt, transcript, extra = {}) {
  const body = JSON.stringify({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompts.wrapCleanupTranscript(transcript) },
    ],
    temperature: 0,
    max_tokens: Math.max(512, Math.min(transcript.length * 2, 2048)),
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
    ...extra,
  });
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve({ ms: performance.now() - started, timings: json.timings || null });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

const rate = (n, ms) => (n && ms ? +(n / (ms / 1000)).toFixed(1) : null);
const summary = { models: {} };
for (const modelId of models) {
  log(`== ${modelId}`);
  const s = (summary.models[modelId] = {});

  // 1. Load time: the server start a first request after idle pays.
  await text.stopTextModel();
  const { port, loadMs } = await text.ensureServer(modelId);
  s.loadMs = Math.round(loadMs);

  // 2. Cleanup, per length: a full read (cache off), then two requests as the
  //    app sends them, so the third shows how much of the fixed instructions
  //    is reused.
  const systemPrompt = await text.cleanupSystemPrompt("en");
  s.cleanup = {};
  for (const words of [60, 250]) {
    const full = await cleanupRequest(port, systemPrompt, dictation(0, words), {
      cache_prompt: false,
    });
    await cleanupRequest(port, systemPrompt, dictation(3, words));
    const reuse = await cleanupRequest(port, systemPrompt, dictation(0, words));
    s.cleanup[words] = {
      promptTokens: full.timings?.prompt_n ?? null,
      readPerSecond: rate(full.timings?.prompt_n, full.timings?.prompt_ms),
      readMs: Math.round(full.timings?.prompt_ms ?? 0),
      outputTokens: full.timings?.predicted_n ?? null,
      writePerSecond: rate(full.timings?.predicted_n, full.timings?.predicted_ms),
      writeMs: Math.round(full.timings?.predicted_ms ?? 0),
      fullRequestMs: Math.round(full.ms),
      reusedTokens: reuse.timings?.cache_n ?? null,
      readAgainTokens: reuse.timings?.prompt_n ?? null,
      readAgainMs: Math.round(reuse.timings?.prompt_ms ?? 0),
      reusedWriteMs: Math.round(reuse.timings?.predicted_ms ?? 0),
      reusedRequestMs: Math.round(reuse.ms),
    };
    log(`  cleanup ${words}w`, s.cleanup[words]);
  }

  // 3. Agent: two turns of the same task, as the app sends them. The first
  //    request of the second turn shows whether the instructions are reused.
  const task = agentFixture.tasks.find((t) => t.id === "none-01");
  const turns = [];
  for (let i = 0; i < 2; i++) {
    const timings = [];
    const r = await text.agentTurn(
      modelId,
      { ...task, cannedResults: agentFixture.canned },
      { onTimings: (t) => timings.push(t) }
    );
    turns.push({ firstWordsMs: r.firstWordsMs, totalMs: r.totalMs, timings });
    // Requests a second apart carry a different timestamp, as real ones do.
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  const first = turns[0].timings[0];
  const again = turns[1].timings[0];
  s.agent = {
    gotTools: text.localModelGetsTools(modelId),
    promptTokens: first ? (first.cache_n ?? 0) + first.prompt_n : null,
    readPerSecond: rate(first?.prompt_n, first?.prompt_ms),
    writePerSecond: rate(first?.predicted_n, first?.predicted_ms),
    secondTurnReusedTokens: again?.cache_n ?? null,
    secondTurnReadAgainTokens: again?.prompt_n ?? null,
    secondTurnReadAgainMs: again ? Math.round(again.prompt_ms) : null,
    firstWordsMs: turns.map((t) => (t.firstWordsMs == null ? null : Math.round(t.firstWordsMs))),
    requests: turns.map((t) => t.timings.length),
  };
  log("  agent", s.agent);
  fs.writeFileSync(path.join(outDir, "rates-summary.json"), JSON.stringify(summary, null, 2));
}

await text.stopTextModel();
fs.writeFileSync(path.join(outDir, "rates-summary.json"), JSON.stringify(summary, null, 2));
log("done", outDir);
process.exit(0);
