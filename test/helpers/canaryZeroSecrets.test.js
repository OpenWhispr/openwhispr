const test = require("node:test");
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const path = require("node:path");

// A canary that skips every provider (no secrets configured, or the secrets
// silently dropped from the workflow) must fail loudly: an all-skip run probed
// nothing, so "All probes passed" would hide a dead canary behind a green check.
// Per-provider skips stay allowed — only the zero-secret case is a failure.

const repoRoot = path.resolve(__dirname, "../..");

function runCanary(scriptArgs, keys = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.includes("_CANARY_"))
  );
  return cp.spawnSync(process.execPath, scriptArgs, {
    cwd: repoRoot,
    env: { ...env, ...keys },
    encoding: "utf8",
    timeout: 60_000,
  });
}

for (const [name, scriptArgs] of [
  ["llm-canary", ["--import", "tsx", "scripts/llm-canary.mjs"]],
  ["stt-canary", ["scripts/stt-canary.mjs"]],
]) {
  test(`${name} exits non-zero when no secrets are configured`, () => {
    const result = runCanary(scriptArgs);
    const output = `${result.stdout}\n${result.stderr}`;

    assert.notEqual(result.status, 0, output);
    assert.match(output, /no .*secrets? configured/i);
    assert.doesNotMatch(output, /All probes passed/);
  });
}

test("LLM canary reports only unprobed constrained models from the live catalog", () => {
  const result = runCanary(
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `
        import bundled from "./src/models/modelRegistryData.json" with { type: "json" };
        const pinned = bundled.cloudProviders.find(({ id }) => id === "tinfoil").models;
        globalThis.fetch = async (url) => {
          if (url.endsWith("/models")) {
            const ids = ["kimi-k3-1-pro", "moonshotai/Kimi-K3.1-Fast", "qwen-new", "kimi-k3"];
            return Response.json({ data: [...pinned, ...ids.map((id) => ({ id }))] });
          }
          return Response.json({ choices: [{ message: { content: "OK" } }] });
        };
        await import("./scripts/llm-canary.mjs");
      `,
    ],
    { LLM_CANARY_TINFOIL_KEY: "test-only" }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = result.stdout
    .split("\n")
    .find((line) => line.includes("unprobed constrained-family ids"));
  assert.match(
    report,
    /unprobed constrained-family ids: moonshotai\/Kimi-K3\.1-Fast, qwen-new \|$/
  );
});
