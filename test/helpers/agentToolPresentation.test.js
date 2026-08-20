const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const load = () => import("../../src/helpers/agentToolPresentation.ts");

test("Agent tool activity uses a restrained rotating verb set of i18n keys", async () => {
  const {
    AGENT_TOOL_ACTIVITY_MIN_VISIBLE_MS,
    AGENT_TOOL_ACTIVITY_ROTATION_MS,
    AGENT_TOOL_ACTIVITY_VERB_KEYS,
    AGENT_TOOL_NAME_FALLBACK_KEY,
    getAgentToolActivityRemainingMs,
  } = await load();

  assert.deepEqual(
    [...AGENT_TOOL_ACTIVITY_VERB_KEYS],
    [
      "assistant.toolActivity.verbs.invoking",
      "assistant.toolActivity.verbs.calling",
      "assistant.toolActivity.verbs.using",
    ]
  );
  assert.equal(AGENT_TOOL_NAME_FALLBACK_KEY, "assistant.toolActivity.toolFallback");
  assert.equal(AGENT_TOOL_ACTIVITY_ROTATION_MS, 1400);
  assert.equal(AGENT_TOOL_ACTIVITY_MIN_VISIBLE_MS, 2400);
  assert.equal(getAgentToolActivityRemainingMs(10_000, 10_500), 1900);
  assert.equal(getAgentToolActivityRemainingMs(10_000, 12_500), 0);
});

test("every exported activity key resolves in the base locale", async () => {
  const { AGENT_TOOL_ACTIVITY_VERB_KEYS, AGENT_TOOL_NAME_FALLBACK_KEY } = await load();
  const translation = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../src/locales/en/translation.json"), "utf8")
  );
  const resolve = (key) =>
    key.split(".").reduce((node, part) => (node ? node[part] : undefined), translation);

  for (const key of [...AGENT_TOOL_ACTIVITY_VERB_KEYS, AGENT_TOOL_NAME_FALLBACK_KEY]) {
    assert.equal(typeof resolve(key), "string", `missing en translation for ${key}`);
  }
});
