const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

let updatePolicyMessageKey;

test.before(async () => {
  ({ updatePolicyMessageKey } = await import("../../src/utils/updatePolicyMessage.ts"));
});

const en = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
);
const copy = (key) => key.split(".").reduce((node, part) => node?.[part], en);

test("each updater refusal reads as its own message", () => {
  const keys = ["UPDATES_MANAGED_BY_ORG", "UPDATE_POLICY_UNAVAILABLE", "UPDATE_POLICY_CHANGED"].map(
    (code) => updatePolicyMessageKey({ code })
  );
  assert.equal(new Set(keys).size, keys.length);
  for (const key of keys) assert.equal(typeof copy(key), "string", key);
  assert.doesNotMatch(copy(updatePolicyMessageKey({ code: "UPDATE_POLICY_CHANGED" })), /connected/);
});
