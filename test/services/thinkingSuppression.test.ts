import test from "node:test";
import assert from "node:assert/strict";
import { applyThinkingSuppression } from "../../src/services/ai/thinkingSuppression";
import type { ReasoningConfig } from "../../src/services/BaseReasoningService";

// Unknown model → getCloudModel/getLocalModel return undefined →
// knownModel is falsy → supportsThinking guard skipped →
// suppressThinking runs unconditionally when disableThinking is true.
const UNKNOWN_MODEL = "__test_unknown_model__";
const DISABLE: ReasoningConfig = { disableThinking: true };
const NO_DISABLE: ReasoningConfig = { disableThinking: false };

function freshBody(): Record<string, unknown> {
  return { model: UNKNOWN_MODEL, messages: [] };
}

// ── Cloud / custom providers: reasoning_effort only, no chat_template_kwargs ──

test("custom provider (e.g. Cerebras) gets reasoning_effort:low, no chat_template_kwargs", () => {
  const body = freshBody();
  applyThinkingSuppression(body, UNKNOWN_MODEL, "custom", DISABLE);
  assert.equal(body.reasoning_effort, "low");
  assert.equal(body.chat_template_kwargs, undefined);
  assert.equal(body.think, undefined);
});

test("groq provider gets reasoning_effort, no chat_template_kwargs", () => {
  const body = freshBody();
  applyThinkingSuppression(body, UNKNOWN_MODEL, "groq", DISABLE);
  assert.equal(body.reasoning_effort, "none");
  assert.equal(body.chat_template_kwargs, undefined);
  assert.equal(body.think, undefined);
});

test("openai provider gets reasoning_effort, no chat_template_kwargs", () => {
  const body = freshBody();
  applyThinkingSuppression(body, UNKNOWN_MODEL, "openai", DISABLE);
  assert.equal(body.reasoning_effort, "none");
  assert.equal(body.chat_template_kwargs, undefined);
  assert.equal(body.think, undefined);
});

test("anthropic provider gets reasoning_effort, no chat_template_kwargs", () => {
  const body = freshBody();
  applyThinkingSuppression(body, UNKNOWN_MODEL, "anthropic", DISABLE);
  assert.equal(body.reasoning_effort, "none");
  assert.equal(body.chat_template_kwargs, undefined);
  assert.equal(body.think, undefined);
});

test("gemini provider gets reasoning_effort, no chat_template_kwargs", () => {
  const body = freshBody();
  applyThinkingSuppression(body, UNKNOWN_MODEL, "gemini", DISABLE);
  assert.equal(body.reasoning_effort, "none");
  assert.equal(body.chat_template_kwargs, undefined);
  assert.equal(body.think, undefined);
});

// ── Local provider: think + chat_template_kwargs ──

test("local provider gets think:false and chat_template_kwargs", () => {
  const body = freshBody();
  applyThinkingSuppression(body, UNKNOWN_MODEL, "local", DISABLE);
  assert.equal(body.think, false);
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(body.reasoning_effort, undefined);
});

// ── LAN provider (Ollama dialect, default in Node.js) ──

test("lan provider (Ollama dialect) gets think:false and chat_template_kwargs", () => {
  const body = freshBody();
  applyThinkingSuppression(body, UNKNOWN_MODEL, "lan", DISABLE);
  assert.equal(body.think, false);
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(body.reasoning_effort, undefined);
});

// ── LAN provider with openai-compatible setting ──

test("lan provider (openai-compatible) gets reasoning_effort and chat_template_kwargs", () => {
  // Simulate browser environment with localStorage
  const origWindow = globalThis.window;
  // @ts-expect-error -- minimal mock for usesOllamaDialect()
  globalThis.window = {
    localStorage: {
      getItem(key: string) {
        return key === "remoteReasoningType" ? "openai-compatible" : null;
      },
    },
  };

  try {
    const body = freshBody();
    applyThinkingSuppression(body, UNKNOWN_MODEL, "lan", DISABLE);
    assert.equal(body.reasoning_effort, "none");
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(body.think, undefined);
  } finally {
    // @ts-expect-error -- restore
    globalThis.window = origWindow;
  }
});

// ── disableThinking=false → nothing added ──

test("disableThinking=false leaves request body untouched", () => {
  const body = freshBody();
  const before = JSON.stringify(body);
  applyThinkingSuppression(body, UNKNOWN_MODEL, "custom", NO_DISABLE);
  assert.equal(JSON.stringify(body), before);
});

test("disableThinking=false leaves local request body untouched", () => {
  const body = freshBody();
  const before = JSON.stringify(body);
  applyThinkingSuppression(body, UNKNOWN_MODEL, "local", NO_DISABLE);
  assert.equal(JSON.stringify(body), before);
});

// ── Provider key is case-insensitive ──

test("provider key is lowercased (Custom → custom behavior)", () => {
  const body = freshBody();
  applyThinkingSuppression(body, UNKNOWN_MODEL, "Custom", DISABLE);
  assert.equal(body.reasoning_effort, "low");
  assert.equal(body.chat_template_kwargs, undefined);
});

// ── Integration: strict server rejects chat_template_kwargs ──

test("strict OpenAI-compatible server rejects chat_template_kwargs", async () => {
  const http = await import("node:http");

  const ACCEPTED_FIELDS = new Set([
    "model", "messages", "temperature", "max_tokens", "max_completion_tokens",
    "stream", "stop", "top_p", "frequency_penalty", "presence_penalty",
    "reasoning_effort", "response_format", "tools", "tool_choice", "seed",
    "logprobs", "top_logprobs", "user", "service_tier",
  ]);

  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (chunk: Buffer) => { data += chunk; });
    req.on("end", () => {
      const body = JSON.parse(data);
      const unknown = Object.keys(body).filter((k) => !ACCEPTED_FIELDS.has(k));
      if (unknown.length > 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          error: { message: `${unknown[0]}: property '${unknown[0]}' is unsupported` },
        }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;

  try {
    // Build request body the way OpenWhispr does for a custom provider
    const requestBody: Record<string, unknown> = {
      model: "gpt-oss-120b",
      messages: [{ role: "user", content: "test" }],
      max_completion_tokens: 4096,
    };
    applyThinkingSuppression(requestBody, "gpt-oss-120b", "custom", DISABLE);

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    assert.equal(res.status, 200, "strict server should accept the request without chat_template_kwargs");

    // Verify chat_template_kwargs would fail
    const badBody = { ...requestBody, chat_template_kwargs: { enable_thinking: false } };
    const badRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(badBody),
    });

    assert.equal(badRes.status, 400, "strict server should reject chat_template_kwargs");
    const err = await badRes.json() as { error: { message: string } };
    assert.match(err.error.message, /chat_template_kwargs.*unsupported/);
  } finally {
    server.close();
  }
});
