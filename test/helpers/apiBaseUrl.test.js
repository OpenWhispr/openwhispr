const test = require("node:test");
const assert = require("node:assert/strict");

// Requires Node's native TypeScript type-stripping (Node >= 22.6 with
// --experimental-strip-types, on by default in Node 23.6+/24). CI runs Node 24.

const load = () => import("../../src/config/constants.ts");

test("empty or blank base URLs normalize to an empty string", async () => {
  const { normalizeBaseUrl } = await load();

  assert.equal(normalizeBaseUrl(null), "");
  assert.equal(normalizeBaseUrl(undefined), "");
  assert.equal(normalizeBaseUrl(""), "");
  assert.equal(normalizeBaseUrl("   "), "");
});

test("trailing slashes are stripped", async () => {
  const { normalizeBaseUrl } = await load();

  assert.equal(normalizeBaseUrl("https://api.example.com/"), "https://api.example.com");
  assert.equal(normalizeBaseUrl("https://api.example.com///"), "https://api.example.com");
});

test("pasted endpoint URLs are reduced to their base — users paste full completion URLs from provider docs", async () => {
  const { normalizeBaseUrl } = await load();

  assert.equal(
    normalizeBaseUrl("https://api.example.com/v1/chat/completions"),
    "https://api.example.com/v1"
  );
  assert.equal(
    normalizeBaseUrl("https://api.example.com/chat/completions"),
    "https://api.example.com"
  );
  assert.equal(
    normalizeBaseUrl("https://api.example.com/v1/responses"),
    "https://api.example.com/v1"
  );
  assert.equal(normalizeBaseUrl("https://api.example.com/v1/models"), "https://api.example.com/v1");
  assert.equal(
    normalizeBaseUrl("https://api.example.com/v1/audio/transcriptions"),
    "https://api.example.com/v1"
  );
  assert.equal(
    normalizeBaseUrl("https://api.example.com/audio/transcriptions"),
    "https://api.example.com"
  );
  assert.equal(
    normalizeBaseUrl("https://api.example.com/v1/audio/translations"),
    "https://api.example.com/v1"
  );
});

test("a clean base URL passes through unchanged", async () => {
  const { normalizeBaseUrl } = await load();

  assert.equal(normalizeBaseUrl("https://api.openai.com/v1"), "https://api.openai.com/v1");
});

test("suffix matching is case-insensitive and canonicalizes to lowercase /v1", async () => {
  const { normalizeBaseUrl } = await load();

  assert.equal(
    normalizeBaseUrl("https://api.example.com/V1/Chat/Completions"),
    "https://api.example.com/v1"
  );
});

test("buildApiUrl joins base and path, adding the leading slash when missing", async () => {
  const { buildApiUrl } = await load();

  assert.equal(
    buildApiUrl("https://api.openai.com/v1", "/responses"),
    "https://api.openai.com/v1/responses"
  );
  assert.equal(
    buildApiUrl("https://api.openai.com/v1", "responses"),
    "https://api.openai.com/v1/responses"
  );
});

test("buildApiUrl falls back to the OpenAI default when the base is empty", async () => {
  const { buildApiUrl } = await load();

  assert.equal(buildApiUrl("", "/responses"), "https://api.openai.com/v1/responses");
});

test("buildApiUrl normalizes a pasted endpoint URL before appending", async () => {
  const { buildApiUrl } = await load();

  assert.equal(
    buildApiUrl("https://api.example.com/v1/chat/completions", "/responses"),
    "https://api.example.com/v1/responses"
  );
});

test("buildApiUrl with an empty path returns just the normalized base", async () => {
  const { buildApiUrl } = await load();

  assert.equal(buildApiUrl("https://api.openai.com/v1", ""), "https://api.openai.com/v1");
});
