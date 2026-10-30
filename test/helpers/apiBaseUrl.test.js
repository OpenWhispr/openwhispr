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

// Regression for #1309: query/hash must stay attached to the origin+path, not
// absorb later path joins. Provider docs and Azure gateways often include
// ?api-version=… on the pasted completions URL.
test("pasted endpoint URLs with query strings still strip path suffixes", async () => {
  const { normalizeBaseUrl } = await load();

  assert.equal(
    normalizeBaseUrl("https://api.example.com/v1/chat/completions?api-version=2024-02-01"),
    "https://api.example.com/v1?api-version=2024-02-01"
  );
  assert.equal(
    normalizeBaseUrl("https://api.example.com/v1/models?api-key=secret#section"),
    "https://api.example.com/v1?api-key=secret#section"
  );
});

test("buildApiUrl inserts the path before any query or hash", async () => {
  const { buildApiUrl } = await load();

  assert.equal(
    buildApiUrl("https://api.example.com/v1/chat/completions?api-version=2024-02-01", "/responses"),
    "https://api.example.com/v1/responses?api-version=2024-02-01"
  );
  assert.equal(
    buildApiUrl("https://gateway.example.com/v1?api-key=secret", "/models"),
    "https://gateway.example.com/v1/models?api-key=secret"
  );
  assert.equal(
    buildApiUrl("https://gateway.example.com/v1?api-key=secret#frag", "chat/completions"),
    "https://gateway.example.com/v1/chat/completions?api-key=secret#frag"
  );
});

test("ensureV1Suffix checks the path, not characters after the query", async () => {
  const { ensureV1Suffix } = await load();

  assert.equal(
    ensureV1Suffix("https://gateway.example.com/v1?api-key=secret"),
    "https://gateway.example.com/v1?api-key=secret"
  );
  assert.equal(
    ensureV1Suffix("https://gateway.example.com?api-key=secret"),
    "https://gateway.example.com/v1?api-key=secret"
  );
});

// Regression for #2381: a base that already ends in a version segment other
// than /v1 (Z.ai's coding base) is a complete API mount — appending /v1 sent
// requests to /api/coding/paas/v4/v1/chat/completions.
test("ensureV1Suffix leaves versioned bases other than /v1 untouched", async () => {
  const { ensureV1Suffix } = await load();

  assert.equal(
    ensureV1Suffix("https://api.z.ai/api/coding/paas/v4"),
    "https://api.z.ai/api/coding/paas/v4"
  );
  assert.equal(ensureV1Suffix("https://api.example.com/v2"), "https://api.example.com/v2");
  assert.equal(ensureV1Suffix("https://api.example.com/v1beta"), "https://api.example.com/v1beta");
  assert.equal(ensureV1Suffix("https://local.host:8080/api/v0"), "https://local.host:8080/api/v0");
});

test("ensureV1Suffix still appends /v1 to unversioned bases", async () => {
  const { ensureV1Suffix } = await load();

  assert.equal(ensureV1Suffix("https://api.example.com"), "https://api.example.com/v1");
  assert.equal(ensureV1Suffix("http://127.0.0.1:1234"), "http://127.0.0.1:1234/v1");
  // An unversioned named mount is not a version segment: keep the fallback.
  assert.equal(
    ensureV1Suffix("https://gateway.example.com/stable"),
    "https://gateway.example.com/stable/v1"
  );
  assert.equal(
    ensureV1Suffix("https://api.example.com/openai/v4?api-key=secret"),
    "https://api.example.com/openai/v4?api-key=secret"
  );
});
