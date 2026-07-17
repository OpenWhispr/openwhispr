const test = require("node:test");
const assert = require("node:assert/strict");

// Requires Node's native TypeScript type-stripping (Node >= 22.6 with
// --experimental-strip-types, on by default in Node 23.6+/24). CI runs Node 24.

// Regression for #1187: the OpenAI-compatible model list (Self-Hosted / Custom
// providers, e.g. LM Studio) must be discovered at `<base>/v1/models`. A user
// who enters only the server root (`http://127.0.0.1:1234`) previously hit
// `/models` with no version segment, so LM Studio never returned its list and
// the UI showed "No models returned". The inference path already runs the base
// through ensureV1Suffix; model discovery has to do the same.

test("buildModelsUrl appends /v1 for a bare host:port", async () => {
  const { buildModelsUrl } = await import("../../src/config/constants.ts");
  assert.equal(buildModelsUrl("http://127.0.0.1:1234"), "http://127.0.0.1:1234/v1/models");
  assert.equal(buildModelsUrl("http://127.0.0.1:1234/"), "http://127.0.0.1:1234/v1/models");
});

test("buildModelsUrl keeps an explicit /v1 without duplicating it", async () => {
  const { buildModelsUrl } = await import("../../src/config/constants.ts");
  assert.equal(buildModelsUrl("http://127.0.0.1:1234/v1"), "http://127.0.0.1:1234/v1/models");
});

test("buildModelsUrl respects an explicit /api/v1 path", async () => {
  const { buildModelsUrl } = await import("../../src/config/constants.ts");
  assert.equal(
    buildModelsUrl("http://127.0.0.1:1234/api/v1"),
    "http://127.0.0.1:1234/api/v1/models"
  );
});

test("buildModelsUrl matches the endpoint the inference layer targets (ensureV1Suffix)", async () => {
  const { buildModelsUrl, ensureV1Suffix, buildApiUrl } = await import(
    "../../src/config/constants.ts"
  );
  for (const base of [
    "http://127.0.0.1:1234",
    "http://127.0.0.1:1234/v1",
    "http://127.0.0.1:1234/api/v1",
  ]) {
    assert.equal(buildModelsUrl(base), buildApiUrl(ensureV1Suffix(base), "/models"));
  }
});
