const test = require("node:test");
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const path = require("node:path");

// A canary that skips every provider (no secrets configured, or the secrets
// silently dropped from the workflow) must fail loudly: an all-skip run probed
// nothing, so "All probes passed" would hide a dead canary behind a green check.
// Per-provider skips stay allowed — only the zero-secret case is a failure.

const repoRoot = path.resolve(__dirname, "../..");

function runCanaryWithoutSecrets(scriptArgs) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.includes("_CANARY_"))
  );
  return cp.spawnSync(process.execPath, scriptArgs, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
}

for (const [name, scriptArgs] of [
  ["llm-canary", ["--import", "tsx", "scripts/llm-canary.mjs"]],
  ["stt-canary", ["scripts/stt-canary.mjs"]],
]) {
  test(`${name} exits non-zero when no secrets are configured`, () => {
    const result = runCanaryWithoutSecrets(scriptArgs);
    const output = `${result.stdout}\n${result.stderr}`;

    assert.notEqual(result.status, 0, output);
    assert.match(output, /no .*secrets? configured/i);
    assert.doesNotMatch(output, /All probes passed/);
  });
}
