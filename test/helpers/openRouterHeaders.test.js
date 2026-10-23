const test = require("node:test");
const assert = require("node:assert/strict");
const { openRouterHeaders } = require("../../src/helpers/openRouterHeaders");

test("OpenRouter requests carry the public app identity for any API path", () => {
  for (const endpoint of [
    "https://openrouter.ai/api/v1/",
    "https://OPENROUTER.AI:443/api/v1/chat/completions",
    "https://openrouter.ai/api/v1/audio/transcriptions",
  ]) {
    assert.deepEqual(openRouterHeaders(endpoint), {
      "HTTP-Referer": "https://openwhispr.com",
      "X-OpenRouter-Title": "OpenWhispr",
    });
  }
});

test("app identity is not sent to other origins or malformed endpoints", () => {
  for (const endpoint of [
    undefined,
    "",
    "invalid",
    "http://openrouter.ai/api/v1",
    "https://openrouter.ai:8443/api/v1",
    "https://openrouter.ai.example.com/api/v1",
    "https://openrouter.ai@example.com/api/v1",
    "https://example.com/openrouter.ai",
    "https://api.openai.com/v1",
    "http://localhost:8000/v1",
  ]) {
    assert.deepEqual(openRouterHeaders(endpoint), {}, String(endpoint));
  }
});
