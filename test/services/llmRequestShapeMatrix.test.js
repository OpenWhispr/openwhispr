const test = require("node:test");
const assert = require("node:assert/strict");

// Exhaustive provider × model-family snapshot of every tunable request param
// the chat-completions shaping layer produces. Each row asserts the FULL param
// set (presence and absence), so any change to a dialect, family constraint,
// or registry capability flag shows up here as a reviewable one-line diff.
// Rationale: #1611 shipped green because no test looked at the whole body a
// given provider×model pair actually gets.

const load = () => import("../../src/services/ai/chatRequestBody.ts");

const MAX_TOKENS = 1000;
const CLEANUP = {};
const CLEANUP_NO_THINK = { disableThinking: true };
const AGENT = { systemPrompt: "You are an agent." };
const AGENT_NO_THINK = { systemPrompt: "You are an agent.", disableThinking: true };
const SELECTION_EDIT = { systemPrompt: "Edit the selection.", requireCompleteOutput: true };

// [description, provider, model, endpoint, config, expected params]
const MATRIX = [
  // --- Groq (strict: rejects unknown fields; per-family reasoning_effort enum) ---
  ["groq gpt-oss cleanup pins the family's low effort", "Groq", "openai/gpt-oss-120b", null, CLEANUP,
    { max_tokens: MAX_TOKENS, temperature: 0, reasoning_effort: "low" }],
  ["groq gpt-oss suppression floors at low, never none (#990)", "Groq", "openai/gpt-oss-120b", null, CLEANUP_NO_THINK,
    { max_tokens: MAX_TOKENS, temperature: 0, reasoning_effort: "low" }],
  ["groq unknown family gets no guessed reasoning params", "Groq", "llama-3.3-70b-versatile", null, CLEANUP_NO_THINK,
    { max_tokens: MAX_TOKENS, temperature: 0 }],

  // --- Tinfoil (dynamic catalog: legacy shape for registry and unknown ids alike) ---
  ["tinfoil gpt-oss cleanup pins low effort (same family fact as Groq)", "tinfoil", "gpt-oss-120b", null, CLEANUP,
    { max_tokens: MAX_TOKENS, temperature: 0, reasoning_effort: "low" }],
  ["tinfoil gpt-oss suppression sends low, not the rejected none (#1611)", "tinfoil", "gpt-oss-120b", null, CLEANUP_NO_THINK,
    { max_tokens: MAX_TOKENS, temperature: 0, reasoning_effort: "low", chat_template_kwargs: { enable_thinking: false } }],
  ["tinfoil selection edits on gpt-oss also pin low effort", "tinfoil", "gpt-oss-120b", null, SELECTION_EDIT,
    { max_tokens: MAX_TOKENS, temperature: 0.3, reasoning_effort: "low" }],
  ["tinfoil model outside the registry keeps the legacy shape", "tinfoil", "deepseek-v4-flash", null, CLEANUP,
    { max_tokens: MAX_TOKENS, temperature: 0 }],

  // --- OpenAI / custom / OpenRouter (registry-driven shape) ---
  ["openai legacy model keeps max_tokens and temperature", "openai", "gpt-4o", null, CLEANUP,
    { max_tokens: MAX_TOKENS, temperature: 0 }],
  ["openai gpt-5 family uses max_completion_tokens and omits temperature", "openai", "gpt-5-mini", null, CLEANUP,
    { max_completion_tokens: MAX_TOKENS }],
  ["openrouter vendor-prefixed id speaks plain chat completions", "openrouter", "openai/gpt-4o", null, AGENT,
    { max_tokens: MAX_TOKENS, temperature: 0.3 }],
  ["openrouter forwards sampling upstream: temperature-rejecting Claude omits it (#1417)", "openrouter", "anthropic/claude-sonnet-5", null, AGENT,
    { max_tokens: MAX_TOKENS }],
  ["openrouter suppression uses its native reasoning toggle", "openrouter", "openai/gpt-4o", null, AGENT_NO_THINK,
    { max_tokens: MAX_TOKENS, temperature: 0.3, reasoning: { enabled: false } }],

  // --- Endpoint dialects (host beats provider and model id) ---
  ["mistral host: max_tokens, temperature, no reasoning params on magistral", "custom", "magistral-small-latest", "https://api.mistral.ai/v1", CLEANUP_NO_THINK,
    { max_tokens: MAX_TOKENS, temperature: 0 }],
  ["mistral host: reasoning_effort none is its native off switch (#844)", "custom", "mistral-small-latest", "https://api.mistral.ai/v1", CLEANUP_NO_THINK,
    { max_tokens: MAX_TOKENS, temperature: 0, reasoning_effort: "none" }],
  ["deepseek host: thinking object, never reasoning_effort none (#1260)", "custom", "deepseek-chat", "https://api.deepseek.com/v1", CLEANUP_NO_THINK,
    { max_tokens: MAX_TOKENS, temperature: 0, thinking: { type: "disabled" } }],
  ["cerebras host: strict like groq, no chat_template_kwargs (#831)", "custom", "gpt-oss-120b", "https://api.cerebras.ai/v1", AGENT_NO_THINK,
    { max_tokens: MAX_TOKENS, temperature: 0.3, reasoning_effort: "low" }],
  ["cerebras host: unknown family gets no guessed reasoning params", "custom", "llama-4-maverick", "https://api.cerebras.ai/v1", AGENT_NO_THINK,
    { max_tokens: MAX_TOKENS, temperature: 0.3 }],

  // --- Self-hosted ---
  ["lan disables Ollama thinking via the nested reasoning object (#1021)", "lan", "qwen3.5:9b", null, CLEANUP_NO_THINK,
    { max_tokens: MAX_TOKENS, temperature: 0, reasoning: { effort: "none" }, chat_template_kwargs: { enable_thinking: false } }],
  ["lan gpt-oss cleanup: family low floor in both the pin and the reasoning object, no contradictory none", "lan", "gpt-oss-20b-mxfp4", null, CLEANUP_NO_THINK,
    { max_tokens: MAX_TOKENS, temperature: 0, reasoning_effort: "low", reasoning: { effort: "low" }, chat_template_kwargs: { enable_thinking: false } }],
  ["lan gpt-oss suppression sends the family floor, never the off value the family lacks", "lan", "gpt-oss-20b-mxfp4", null, AGENT_NO_THINK,
    { max_tokens: MAX_TOKENS, temperature: 0.3, reasoning: { effort: "low" }, chat_template_kwargs: { enable_thinking: false } }],
  ["local llama.cpp gets think false plus chat_template_kwargs (#783)", "local", "qwen3.5-4b-gguf", null, CLEANUP_NO_THINK,
    { max_tokens: MAX_TOKENS, temperature: 0, think: false, chat_template_kwargs: { enable_thinking: false } }],

  // --- Corti (registry max_tokens; legacy set keeps unknown ids stable) ---
  ["corti keeps the legacy chat-completions shape", "Corti", "corti-s1", null, AGENT,
    { max_tokens: MAX_TOKENS, temperature: 0.3 }],

  // --- Gemini through its OpenAI-compat endpoint (agent streaming route) ---
  ["gemini openai-compat: fallback config, no temperature param", "gemini", "gemini-3-flash-preview", null, AGENT,
    { max_completion_tokens: MAX_TOKENS }],
];

for (const [name, provider, model, endpoint, config, expectedParams] of MATRIX) {
  test(`matrix: ${name}`, async () => {
    const { applyChatCompletionsParams } = await load();
    const body = { model, messages: [] };
    applyChatCompletionsParams(body, { model, provider, endpoint, config, maxTokens: MAX_TOKENS });

    const { model: _m, messages: _msgs, ...params } = body;
    assert.deepEqual(params, expectedParams);
  });
}

test("matrix: explicit temperature and maxTokens overrides always win", async () => {
  const { applyChatCompletionsParams } = await load();
  const body = { model: "gpt-4o", messages: [] };
  applyChatCompletionsParams(body, {
    model: "gpt-4o",
    provider: "openai",
    config: { temperature: 0.7, maxTokens: 42 },
    maxTokens: 42,
  });
  assert.equal(body.temperature, 0.7);
  assert.equal(body.max_tokens, 42);
});
