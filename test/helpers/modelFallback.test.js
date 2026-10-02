const test = require("node:test");
const assert = require("node:assert/strict");

test("model fallback classifies transport failures conservatively", async () => {
  const { canFallback } = require("../../src/helpers/modelFallback.ts");
  for (const status of [402, 408, 429, 500, 503]) {
    assert.equal(canFallback(Object.assign(new Error("provider failed"), { status })), true);
  }
  for (const status of [400, 401, 403, 404, 499]) {
    assert.equal(canFallback(Object.assign(new Error("provider failed"), { status })), false);
  }
  assert.equal(canFallback(new TypeError("Failed to fetch")), true);
  assert.equal(
    canFallback(Object.assign(new Error("deadline"), { code: "LLM_REQUEST_TIMEOUT" })),
    true
  );
  assert.equal(canFallback(new Error("No audio detected")), false);
  assert.equal(
    canFallback(Object.assign(new Error("policy"), { status: 503, code: "POLICY_RESTRICTED" })),
    false
  );
  assert.equal(canFallback(Object.assign(new TypeError("fetch failed"), { status: 0 })), true);
  assert.equal(canFallback(Object.assign(new Error("aborted"), { name: "AbortError" })), false);
  assert.equal(
    canFallback(Object.assign(new Error("failed"), { selectionEditFatal: true, status: 503 })),
    false
  );
});

test("unavailable targets are skipped and cancellation during eligibility stops dispatch", async () => {
  const { runModelFallback } = require("../../src/helpers/modelFallback.ts");
  const calls = [];
  const primary = { provider: "openrouter", model: "primary" };
  const targets = [
    { provider: "groq", model: "backup" },
    { provider: "local", model: "downloaded" },
  ];
  const original = Object.assign(new Error("quota"), { status: 429 });
  const result = await runModelFallback({
    primary,
    targets,
    isAllowed: (target) => target.provider !== "groq",
    attempt: async (target) => {
      calls.push(target.provider);
      if (target === primary) throw original;
      return "local";
    },
  });
  assert.equal(result.value, "local");
  assert.deepEqual(calls, ["openrouter", "local"]);
  let cancelled = false;
  calls.length = 0;
  await assert.rejects(
    runModelFallback({
      primary,
      targets,
      wasCancelled: () => cancelled,
      isAllowed: async () => {
        cancelled = true;
        return true;
      },
      attempt: async (target) => {
        calls.push(target.provider);
        throw original;
      },
    }),
    { name: "AbortError" }
  );
  assert.deepEqual(calls, ["openrouter"]);
});

test("fallback tries ordered distinct targets and preserves the primary error", async () => {
  const { runModelFallback } = require("../../src/helpers/modelFallback.ts");
  const calls = [];
  const primary = { provider: "openrouter", model: "primary" };
  const next = { provider: "groq", model: "backup" };
  const original = Object.assign(new Error("quota"), { status: 429 });
  const result = await runModelFallback({
    primary,
    targets: [primary, next, next, { provider: "local", model: "local" }],
    attempt: async (target) => {
      calls.push(target.provider);
      if (target.provider !== "local") throw original;
      return "ok";
    },
  });
  assert.equal(result.value, "ok");
  assert.equal(result.target.provider, "local");
  assert.equal(result.usedFallback, true);
  assert.deepEqual(calls, ["openrouter", "groq", "local"]);
  await assert.rejects(
    runModelFallback({
      primary,
      targets: [next],
      attempt: async () => {
        throw original;
      },
    }),
    (error) => error === original
  );
});

test("cancellation stops between attempts and discards late success", async () => {
  const { runModelFallback } = require("../../src/helpers/modelFallback.ts");
  let cancelled = false;
  let calls = 0;
  await assert.rejects(
    runModelFallback({
      primary: { provider: "openai", model: "main" },
      targets: [{ provider: "groq", model: "backup" }],
      wasCancelled: () => cancelled,
      attempt: async () => {
        calls++;
        cancelled = true;
        return "late";
      },
    }),
    { name: "AbortError" }
  );
  assert.equal(calls, 1);
});

test("normalization strips secrets, rejects invalid targets and bounds the chain", async () => {
  const { normalizeFallbackTargets } = require("../../src/helpers/modelFallback.ts");
  assert.deepEqual(
    normalizeFallbackTargets([
      { provider: "groq", model: " test ", apiKey: "secret" },
      null,
      { provider: "", model: "a" },
    ]),
    [{ provider: "groq", model: "test" }]
  );
  assert.equal(
    normalizeFallbackTargets(
      Array.from({ length: 10 }, (_, i) => ({ provider: "groq", model: String(i) }))
    ).length,
    3
  );
  assert.deepEqual(normalizeFallbackTargets("bad"), []);
});

test("same model with different key profiles is distinct and secrets are stripped", async () => {
  const {
    normalizeFallbackTargets,
    runModelFallback,
  } = require("../../src/helpers/modelFallback.ts");
  const primary = { provider: "groq", model: "model" };
  const backup = { ...primary, keyId: "backup-key" };
  assert.deepEqual(
    normalizeFallbackTargets([
      backup,
      { ...backup, apiKey: "secret" },
      { ...backup, keyId: "../bad" },
    ]),
    [backup]
  );
  const calls = [];
  const result = await runModelFallback({
    primary,
    targets: [primary, backup, backup],
    attempt: async (target) => {
      calls.push(target.keyId);
      if (!target.keyId) throw Object.assign(new Error("quota"), { status: 429 });
      return "ok";
    },
  });
  assert.equal(result.value, "ok");
  assert.deepEqual(calls, [undefined, "backup-key"]);
});
