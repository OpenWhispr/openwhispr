const test = require("node:test");
const assert = require("node:assert/strict");
const { validateManifest } = require("../../scripts/leaderboard-v1-profiles");

function manifest(overrides = {}) {
  return {
    version: 2,
    generation: "a1b2c3",
    profiles: [
      {
        key: "free-create",
        label: "Free · Create",
        expected: "create",
        token: "local-token-for-qa",
        bridgePort: 5201,
      },
    ],
    ...overrides,
  };
}

test("the profile harness accepts a complete versioned manifest", () => {
  const input = manifest();
  assert.equal(validateManifest(input), input);
});

test("the profile harness rejects stale and ambiguous profile manifests", () => {
  assert.throws(() => validateManifest(manifest({ version: 1 })), /Unsupported/);
  assert.throws(() => validateManifest(manifest({ generation: "../bad" })), /Unsupported/);
  assert.throws(
    () =>
      validateManifest(
        manifest({ profiles: [manifest().profiles[0], { ...manifest().profiles[0] }] })
      ),
    /Invalid/
  );
  assert.throws(
    () =>
      validateManifest(
        manifest({
          profiles: [
            manifest().profiles[0],
            { ...manifest().profiles[0], key: "another", bridgePort: 5201 },
          ],
        })
      ),
    /Invalid/
  );
});
