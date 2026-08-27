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
 * Run: node --import tsx scripts/llm-canary.mjs
 * Keys come from LLM_CANARY_<PROVIDER>_KEY env vars; providers without a key
 * are skipped and listed. Exit 1 when any probe on a keyed provider fails, or
 * when no key is configured at all — an all-skip run probed nothing and must
 * not report green.
 */
import { applyChatCompletionsParams } from "../src/services/ai/chatRequestBody.ts";
import registryData from "../src/models/modelRegistryData.json" with { type: "json" };

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
    models: ["gpt-oss-120b", "deepseek-v4-flash", "llama3-3-70b"],
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
        report.push(`| ${label} | _catalog_ | ⚠️ registry ids missing live: ${diff.vanished.join(", ")} |`);
        failures.push(`${label}: registry ids vanished from live catalog: ${diff.vanished.join(", ")}`);
      }
      if (diff.newConstrained.length) {
        report.push(
          `| ${label} | _catalog_ | ℹ️ unprobed constrained-family ids: ${diff.newConstrained.slice(0, 10).join(", ")} |`
        );
      }
    }
  }
}

if (skipped.length === PROVIDERS.length) {
  failures.push("no canary secrets configured — every provider was skipped, nothing was probed");
}

console.log("## LLM request-shape canary\n");
console.log("| provider | model | result |\n|---|---|---|");
for (const line of report) console.log(line);
if (skipped.length) console.log(`\nSkipped (no key configured): ${skipped.join(", ")}`);
if (failures.length) {
  console.log(`\n### ${failures.length} failure(s)\n`);
  for (const f of failures) console.log(`- ${f}`);
  process.exit(1);
}
console.log("\nAll probes passed.");
