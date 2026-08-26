const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let userDataDirectory = os.tmpdir();
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return { app: { getPath: () => userDataDirectory } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const binding = require("../../src/helpers/accountScopeBinding.js");
Module._load = originalLoad;

function freshUserData(t) {
  userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "account-scope-binding-"));
  t.after(() => fs.rmSync(userDataDirectory, { recursive: true, force: true }));
  return userDataDirectory;
}

const sha256 = (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

test("resolveBootAccountScope restores only a hash-matching binding", () => {
  const valid = { version: 1, accountId: "account-a", tokenHash: sha256("token-a") };
  assert.equal(binding.resolveBootAccountScope({ token: "token-a", binding: valid }), "account-a");
  assert.equal(binding.resolveBootAccountScope({ token: null, binding: valid }), null);
  assert.equal(binding.resolveBootAccountScope({ token: "", binding: valid }), null);
  assert.equal(binding.resolveBootAccountScope({ token: "token-a", binding: null }), null);
  assert.equal(binding.resolveBootAccountScope({ token: "rotated-token", binding: valid }), null);
  assert.equal(
    binding.resolveBootAccountScope({ token: "token-a", binding: { ...valid, version: 2 } }),
    null
  );
  assert.equal(
    binding.resolveBootAccountScope({ token: "token-a", binding: { ...valid, accountId: " " } }),
    null
  );
});

test("evaluateScopeRequest fences null scope calls made under a live credential", () => {
  assert.deepEqual(
    binding.evaluateScopeRequest({
      accountId: " ",
      expectedGeneration: 1,
      token: "t",
      generation: 1,
    }),
    { ok: false, code: "INVALID_ACCOUNT" }
  );
  assert.deepEqual(
    binding.evaluateScopeRequest({
      accountId: "a",
      expectedGeneration: 1,
      token: null,
      generation: 1,
    }),
    { ok: false, code: "AUTH_CONTEXT_CHANGED" }
  );
  assert.deepEqual(
    binding.evaluateScopeRequest({
      accountId: "a",
      expectedGeneration: 1,
      token: "t",
      generation: 2,
    }),
    { ok: false, code: "AUTH_CONTEXT_CHANGED" }
  );
  assert.deepEqual(
    binding.evaluateScopeRequest({
      accountId: null,
      expectedGeneration: 1,
      token: "t",
      generation: 2,
    }),
    { ok: false, code: "AUTH_CONTEXT_CHANGED" }
  );
  assert.deepEqual(
    binding.evaluateScopeRequest({
      accountId: null,
      expectedGeneration: undefined,
      token: null,
      generation: 7,
    }),
    { ok: true }
  );
  assert.deepEqual(
    binding.evaluateScopeRequest({
      accountId: "a",
      expectedGeneration: 7,
      token: "t",
      generation: 7,
    }),
    { ok: true }
  );
  assert.deepEqual(
    binding.evaluateScopeRequest({
      accountId: null,
      expectedGeneration: 7,
      token: "t",
      generation: 7,
    }),
    { ok: true }
  );
});

test("persist, read, and resolve round-trip through the binding file", (t) => {
  const dir = freshUserData(t);
  binding.persist("account-a", "token-a");
  const stored = binding.read();
  assert.deepEqual(stored, { version: 1, accountId: "account-a", tokenHash: sha256("token-a") });
  assert.equal(binding.resolveBootAccountScope({ token: "token-a", binding: stored }), "account-a");
  if (process.platform !== "win32") {
    const mode = fs.statSync(path.join(dir, "account-scope-binding.json")).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});

test("clear removes the binding and read tolerates absence and corruption", (t) => {
  const dir = freshUserData(t);
  assert.equal(binding.read(), null);
  binding.persist("account-a", "token-a");
  binding.clear();
  assert.equal(binding.read(), null);
  fs.writeFileSync(path.join(dir, "account-scope-binding.json"), "{not json");
  assert.equal(binding.read(), null);
  binding.clear();
});
