/**
 * Live LLM request-shape canary. Sends a ~1-token request per provider ×
 * constrained model family using the app's REAL shaping code, so a provider
 * rejecting one of our shaped params (reasoning_effort, chat_template_kwargs,
 * thinking, temperature, token param) surfaces here on a schedule instead of
 * in a customer report (#990, #844, #1260, #1417, #1611). Also diffs each
 * provider's live /models catalog against modelRegistryData.json: a vanished
 * pinned id or a new member of a constrained family is exactly the drift that
 * caused Tinfoil+gpt-oss to break unnoticed.
 *
 * Also runs one meeting-sized Generate AI Summary request per keyed provider
 * through the app's real provider code and the note-formatting deadline. A
 * 1-token probe cannot see a reasoning model that thinks for longer than the
 * app is willing to wait (1.10.1: every BYOK summary timed out at 30s), so
 * this measures the request users actually make and reports how close it runs
 * to the deadline.
 *
 * Run: node --import tsx scripts/llm-canary.mjs
 * Keys come from LLM_CANARY_<PROVIDER>_KEY env vars; providers without a key
 * are skipped and listed. Exit 1 when any probe on a keyed provider fails, or
 * when no key is configured at all — an all-skip run probed nothing and must
 * not report green.
 */
import { applyChatCompletionsParams } from "../src/services/ai/chatRequestBody.ts";
import { openaiProvider } from "../src/services/ai/inferenceProviders/openai.ts";
import { geminiProvider } from "../src/services/ai/inferenceProviders/gemini.ts";
import { getLlmRequestTimeoutSeconds } from "../src/helpers/llmRequestTimeout.js";
import { NOTE_OUTPUT_MAX_TOKENS } from "../src/helpers/builtinActions.js";
import logger from "../src/utils/logger.ts";
import registryData from "../src/models/modelRegistryData.json" with { type: "json" };
import {
  buildNoteProbeSystemPrompt,
  buildNoteProbeTranscript,
  countWords,
} from "./lib/note-formatting-probe.mjs";

const CONSTRAINED_FAMILY = /gpt-oss|qwen|magistral/i;

const PROVIDERS = [
  {
    id: "openai",
    keyEnv: "LLM_CANARY_OPENAI_KEY",
    base: "https://api.openai.com/v1",
    // Registry models only — a non-registry id skips the suppression gate and
    // draws a 400 from OpenAI's strict parser that no app user ever hits.
    models: ["gpt-4.1-mini", "gpt-5-mini"],
  },
  {
    id: "groq",
    keyEnv: "LLM_CANARY_GROQ_KEY",
    base: "https://api.groq.com/openai/v1",
    models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"],
  },
  {
    id: "tinfoil",
    keyEnv: "LLM_CANARY_TINFOIL_KEY",
    base: "https://inference.tinfoil.sh/v1",
    // glm-5-3 is the registry default, so it is the model most Tinfoil users
    // are on — and the Tinfoil transport has no param-stripping ladder, so a
    // reasoning-param rejection there hard-errors (#1611).
    // deepseek-v4-flash was replaced by deepseek-v4-1-flash in Tinfoil's live
    // catalog (canary run 35322067138, 2026-09-18: HTTP 404 "model does not exist").
    models: ["glm-5-3", "gpt-oss-120b", "deepseek-v4-1-flash", "llama3-3-70b"],
  },
  {
    id: "gemini",
    keyEnv: "LLM_CANARY_GEMINI_KEY",
    base: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: ["gemini-3-flash-preview"],
  },
  {
    id: "openrouter",
    keyEnv: "LLM_CANARY_OPENROUTER_KEY",
    base: "https://openrouter.ai/api/v1",
    models: ["openai/gpt-4o-mini", "anthropic/claude-haiku-4-5"],
    skipCatalogDiff: true, // thousands of ids; registry pins none of them
  },
  {
    id: "custom", // endpoint dialects ride the custom provider
    label: "mistral",
    keyEnv: "LLM_CANARY_MISTRAL_KEY",
    base: "https://api.mistral.ai/v1",
    models: ["mistral-small-latest", "magistral-small-latest"],
    skipCatalogDiff: true,
  },
  {
    id: "custom",
    label: "deepseek",
    keyEnv: "LLM_CANARY_DEEPSEEK_KEY",
    base: "https://api.deepseek.com/v1",
    models: ["deepseek-chat"],
    skipCatalogDiff: true,
  },
  {
    id: "custom",
    label: "cerebras",
    keyEnv: "LLM_CANARY_CEREBRAS_KEY",
    base: "https://api.cerebras.ai/v1",
    models: ["gpt-oss-120b"],
    skipCatalogDiff: true,
  },
];

const registryIdsByProvider = new Map(
  registryData.cloudProviders.map((p) => [p.id, p.models.map((m) => m.id)])
);

function buildProbeBody(model, provider, endpoint) {
  const body = {
    model,
    messages: [
      { role: "system", content: "You are a health check." },
      { role: "user", content: "Reply with OK." },
    ],
  };
  // disableThinking exercises the suppression dialect — the shape that has
  // historically 400'd; maxTokens floor keeps thinking families from needing
  // room to reason before emitting content.
  applyChatCompletionsParams(body, {
    model,
    provider,
    endpoint,
    config: { systemPrompt: "You are a health check.", disableThinking: true },
    maxTokens: 256,
  });
  return body;
}

async function probe(entry, model, apiKey) {
  const body = buildProbeBody(model, entry.id, entry.base);
  const res = await fetch(`${entry.base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, detail: `HTTP ${res.status}: ${text.slice(0, 300)}` };
  }
  const content = JSON.parse(text)?.choices?.[0]?.message?.content;
  if (!content || !content.trim()) {
    return { ok: false, detail: `2xx but empty content: ${text.slice(0, 300)}` };
  }
  return { ok: true };
}

// One reasoning-capable model per keyed provider whose note request the
// renderer sends itself under the app's client deadline. Registry ids only,
// for the same reason as PROVIDERS.
const NOTE_PROBES = [
  {
    id: "openai",
    keyEnv: "LLM_CANARY_OPENAI_KEY",
    // The model in the 1.10.1 report; the provider raises its output cap to
    // 25k tokens for reasoning models, which is what lets it think past 30s.
    model: "gpt-5.6-terra",
    provider: openaiProvider,
    config: { provider: "openai" },
  },
  {
    id: "gemini",
    keyEnv: "LLM_CANARY_GEMINI_KEY",
    model: "gemini-3.5-flash",
    provider: geminiProvider,
    config: {},
  },
];

const NOTE_DEADLINE_SECONDS = getLlmRequestTimeoutSeconds({ scope: "noteFormatting" });
// Elapsed time past this fraction of the deadline is reported as slow so the
// budget is questioned before a provider change crosses it.
const NOTE_SLOW_FRACTION = 0.5;

async function probeNoteFormatting(entry, apiKey) {
  const transcript = buildNoteProbeTranscript();
  const config = {
    ...entry.config,
    inferenceScope: "noteFormatting",
    systemPrompt: buildNoteProbeSystemPrompt(),
    maxTokens: NOTE_OUTPUT_MAX_TOKENS,
    temperature: 0.3,
  };
  const ctx = {
    getApiKey: async () => apiKey,
    getSystemPrompt: () => "",
    getCustomDictionary: () => [],
    getPreferredLanguage: () => "en",
    getUiLanguage: () => "en",
    callChatCompletionsApi: async () => {
      throw new Error("note probe does not delegate to chat completions");
    },
    calculateMaxTokens: () => NOTE_OUTPUT_MAX_TOKENS,
  };

  // The providers only log token usage; lift it out of the debug log for the report.
  let tokens = null;
  const originalLogReasoning = logger.logReasoning;
  logger.logReasoning = (stage, details) => {
    if (typeof details?.tokensUsed === "number") tokens = details.tokensUsed;
    if (typeof details?.usageMetadata?.totalTokenCount === "number") {
      tokens = details.usageMetadata.totalTokenCount;
    }
    return originalLogReasoning(stage, details);
  };

  const startedAt = Date.now();
  try {
    const text = await entry.provider.call({
      text: transcript,
      model: entry.model,
      agentName: null,
      config,
      ctx,
    });
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    const slow = seconds > NOTE_DEADLINE_SECONDS * NOTE_SLOW_FRACTION;
    return {
      ok: true,
      seconds,
      tokens,
      words: countWords(text),
      detail: slow ? `⚠️ slow: ${seconds}s of the ${NOTE_DEADLINE_SECONDS}s note deadline` : "✅",
    };
  } catch (err) {
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    return { ok: false, seconds, tokens, words: 0, detail: `❌ ${err.message}` };
  } finally {
    logger.logReasoning = originalLogReasoning;
  }
}

async function catalogDiff(entry, apiKey) {
  const res = await fetch(`${entry.base}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return { error: `models list HTTP ${res.status}` };
  // Gemini's OpenAI-compat /models returns "models/"-prefixed ids; the
  // registry pins bare ids, so compare without the prefix.
  const live = ((await res.json())?.data ?? [])
    .map((m) => m.id?.replace(/^models\//, ""))
    .filter(Boolean);
  const pinned = registryIdsByProvider.get(entry.id) ?? [];
  const vanished = pinned.filter((id) => !live.includes(id));
  const probed = new Set(entry.models);
  const newConstrained = live.filter((id) => CONSTRAINED_FAMILY.test(id) && !probed.has(id));
  return { vanished, newConstrained };
}

const report = [];
const failures = [];
const skipped = [];

for (const entry of PROVIDERS) {
  const label = entry.label ?? entry.id;
  const apiKey = process.env[entry.keyEnv];
  if (!apiKey) {
    skipped.push(label);
    continue;
  }

  for (const model of entry.models) {
    const result = await probe(entry, model, apiKey).catch((err) => ({
      ok: false,
      detail: err.message,
    }));
    const line = `| ${label} | ${model} | ${result.ok ? "✅" : `❌ ${result.detail}`} |`;
    report.push(line);
    if (!result.ok) failures.push(`${label}/${model}: ${result.detail}`);
  }

  if (!entry.skipCatalogDiff) {
    const diff = await catalogDiff(entry, apiKey).catch((err) => ({ error: err.message }));
    if (diff.error) {
      report.push(`| ${label} | _catalog_ | ⚠️ ${diff.error} |`);
    } else {
      if (diff.vanished.length) {
        report.push(
          `| ${label} | _catalog_ | ⚠️ registry ids missing live: ${diff.vanished.join(", ")} |`
        );
        failures.push(
          `${label}: registry ids vanished from live catalog: ${diff.vanished.join(", ")}`
        );
      }
      if (diff.newConstrained.length) {
        report.push(
          `| ${label} | _catalog_ | ℹ️ unprobed constrained-family ids: ${diff.newConstrained.slice(0, 10).join(", ")} |`
        );
      }
    }
  }
}

const noteReport = [];
const noteSkipped = [];
for (const entry of NOTE_PROBES) {
  const apiKey = process.env[entry.keyEnv];
  if (!apiKey) {
    noteSkipped.push(entry.id);
    continue;
  }
  const result = await probeNoteFormatting(entry, apiKey);
  noteReport.push(
    `| ${entry.id} | ${entry.model} | ${result.seconds}s | ${result.tokens ?? "?"} | ${result.words} | ${result.detail} |`
  );
  if (!result.ok) failures.push(`note formatting ${entry.id}/${entry.model}: ${result.detail}`);
}

if (skipped.length === PROVIDERS.length) {
  failures.push("no canary secrets configured — every provider was skipped, nothing was probed");
}

console.log("## LLM request-shape canary\n");
console.log("| provider | model | result |\n|---|---|---|");
for (const line of report) console.log(line);
if (skipped.length) console.log(`\nSkipped (no key configured): ${skipped.join(", ")}`);

console.log(
  `\n## Note formatting latency (${countWords(buildNoteProbeTranscript())}-word transcript, ${NOTE_DEADLINE_SECONDS}s deadline)\n`
);
console.log(
  "| provider | model | elapsed | tokens | output words | result |\n|---|---|---|---|---|---|"
);
for (const line of noteReport) console.log(line);
if (noteSkipped.length) console.log(`\nSkipped (no key configured): ${noteSkipped.join(", ")}`);
if (failures.length) {
  console.log(`\n### ${failures.length} failure(s)\n`);
  for (const f of failures) console.log(`- ${f}`);
  process.exit(1);
}
console.log("\nAll probes passed.");
