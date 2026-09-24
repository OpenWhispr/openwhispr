const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/localLlmServerPolicy.ts");

const scope = (mode, model = "qwen3-4b-q4_k_m") => ({ mode, model });

test("the server is still needed while another scope runs a local model", async () => {
  const { isLocalLlmServerNeeded } = await load();

  // dictationCleanup just moved to OpenWhispr Cloud; the Voice Assistant is still local.
  const needed = isLocalLlmServerNeeded([scope("openwhispr"), scope("local"), scope("providers")]);

  assert.equal(needed, true);
});

test("the server is no longer needed once no scope is local", async () => {
  const { isLocalLlmServerNeeded } = await load();

  for (const mode of ["openwhispr", "providers", "self-hosted", "enterprise"]) {
    assert.equal(isLocalLlmServerNeeded([scope(mode), scope("openwhispr")]), false, `mode=${mode}`);
  }
});

test("a local scope with no model picked cannot use the server", async () => {
  const { isLocalLlmServerNeeded } = await load();

  assert.equal(isLocalLlmServerNeeded([scope("local", ""), scope("providers")]), false);
});

test("no scopes means no consumer", async () => {
  const { isLocalLlmServerNeeded } = await load();

  assert.equal(isLocalLlmServerNeeded([]), false);
});
