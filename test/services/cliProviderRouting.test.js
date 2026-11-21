const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const routing = require("../../src/helpers/llmCli/llmCliRouting.js");
const providers = require("../../src/helpers/llmCliProviders.js");
const { resolveChatRoute } = require("../../src/helpers/chatRouting.js");
const { INFERENCE_SCOPES } = require("../../src/config/inferenceScopes.ts");

const SIGNED_IN = {
  claude: { status: "signed-in" },
  codex: { status: "signed-in" },
  grok: { status: "signed-in" },
  agy: { status: "signed-in" },
};
const CLAUDE_ON = { claudeEnabled: true };
const CLAUDE_OFF = { claudeEnabled: false };

const ALLOWED_SCOPES = ["chatIntelligence", "dictationAgent"];

function read(rel) {
  return fs.readFileSync(path.join(__dirname, "../..", rel), "utf8");
}

test("isCliProviderId recognises the four seat ids only", () => {
  for (const id of ["cli-codex", "cli-claude", "cli-grok", "cli-agy"]) {
    assert.equal(routing.isCliProviderId(id), true, id);
  }
  for (const id of ["openai", "local", "cli-other", "codex", "", undefined, null, 5]) {
    assert.equal(routing.isCliProviderId(id), false, String(id));
  }
  assert.equal(routing.cliSeatForProviderId("cli-grok"), "grok");
  assert.equal(routing.cliSeatForProviderId("openai"), null);
});

test("the two allowed scopes list signed-in seats; every other scope lists none", () => {
  const scopes = Object.keys(INFERENCE_SCOPES);
  for (const scope of ["dictationCleanup", "dictationAgentVision", "noteFormatting"]) {
    assert.ok(scopes.includes(scope), `${scope} exists`);
  }
  for (const scope of scopes) {
    const ids = routing.cliPickerSeats(scope, CLAUDE_ON, SIGNED_IN).map((s) => s.id);
    if (ALLOWED_SCOPES.includes(scope)) {
      assert.deepEqual(ids, ["cli-codex", "cli-claude", "cli-grok", "cli-agy"], scope);
    } else {
      assert.deepEqual(ids, [], `${scope} must not list CLI providers (D-03)`);
    }
  }
});

test("the Claude seat needs the main-held pref; seats must be signed in", () => {
  const off = routing.cliPickerSeats("chatIntelligence", CLAUDE_OFF, SIGNED_IN).map((s) => s.id);
  assert.ok(!off.includes("cli-claude"));
  assert.ok(off.includes("cli-codex"));
  const noPrefs = routing.cliPickerSeats("chatIntelligence", undefined, SIGNED_IN);
  assert.ok(!noPrefs.map((s) => s.id).includes("cli-claude"));

  const partial = {
    ...SIGNED_IN,
    codex: { status: "signed-out" },
    grok: { status: "installed" },
    agy: { status: "missing" },
  };
  assert.deepEqual(
    routing.cliPickerSeats("dictationAgent", CLAUDE_ON, partial).map((s) => s.id),
    ["cli-claude"]
  );
  assert.deepEqual(routing.cliPickerSeats("dictationAgent", CLAUDE_ON, undefined), []);
});

test("picker seats carry the label and the table models", () => {
  const seats = routing.cliPickerSeats("chatIntelligence", CLAUDE_ON, SIGNED_IN);
  assert.equal(seats[0].label, "Codex");
  assert.deepEqual(seats[1].models, ["haiku", "sonnet", "opus"]);
});

test("isCliProviderAvailable is false off-scope, unsigned, or with the Claude pref off", () => {
  const avail = routing.isCliProviderAvailable;
  assert.equal(avail("cli-codex", "chatIntelligence", CLAUDE_OFF, SIGNED_IN), true);
  assert.equal(avail("cli-codex", "dictationCleanup", CLAUDE_ON, SIGNED_IN), false);
  const signedOut = { ...SIGNED_IN, codex: { status: "signed-out" } };
  assert.equal(avail("cli-codex", "chatIntelligence", CLAUDE_ON, signedOut), false);
  assert.equal(avail("cli-claude", "chatIntelligence", CLAUDE_OFF, SIGNED_IN), false);
  assert.equal(avail("cli-claude", "chatIntelligence", CLAUDE_ON, SIGNED_IN), true);
});

test("model id helper maps the stored default to no model", () => {
  assert.equal(routing.cliModelIdFor("default"), undefined);
  assert.equal(routing.cliModelIdFor(""), undefined);
  assert.equal(routing.cliModelIdFor("sonnet"), "sonnet");
});

test("chat routing sends a CLI provider to the cli route and leaves the others alone", () => {
  assert.equal(resolveChatRoute({ provider: "cli-codex", isCliProvider: true }).kind, "cli");
  assert.equal(resolveChatRoute({ provider: "openai" }).kind, "provider");
  assert.equal(resolveChatRoute({ provider: "some-local-model" }).kind, "local");
  assert.equal(
    resolveChatRoute({ provider: "bedrock", isEnterpriseProvider: true }).kind,
    "enterprise"
  );
  assert.equal(
    resolveChatRoute({ provider: "cli-codex", isCliProvider: true, lanUrl: "http://x/v1" }).kind,
    "self-hosted",
    "an explicit self-hosted URL still wins, as for enterprise"
  );
});

test("every cli-* id maps to the one subscription provider in the registry source", () => {
  const src = read("src/services/ai/inferenceProviders/index.ts");
  assert.match(src, /LLM_CLI_PROVIDERS\.map\(\(p\) => \[p\.id, cliSubscriptionProvider\]\)/);
  assert.equal(providers.LLM_CLI_PROVIDERS.length, 4);
});

test("a CLI provider is valid only in providers mode", () => {
  const src = read("src/models/ModelRegistry.ts");
  const providersCase = src.match(/case "providers":\s*return \(([\s\S]*?)\);/);
  assert.ok(providersCase, "providers case found");
  assert.match(providersCase[1], /isCliProviderId\(provider\)/);
  const localCase = src.match(/case "local":\s*return ([^;]*);/);
  assert.doesNotMatch(localCase[1], /isCliProviderId/);
});

test("the editor mounts the CLI picker only behind the scope allowlist", () => {
  const src = read("src/components/settings/InferenceConfigEditor.tsx");
  assert.match(src, /CLI_SCOPE_ALLOWLIST\.includes\(scope\)/);
  assert.match(src, /<CliProviderPicker/);
});

test("the agent branch builds the CLI model with no tools and no key resolution", () => {
  const src = read("src/services/ReasoningService.ts");
  assert.match(src, /createCliChatModel\(cliSeatForProviderId\(provider\)!, model\)/);
  assert.match(src, /tools: isCli \? undefined : tools \|\| undefined/);
  assert.match(src, /if \(isEnterprise \|\| isCli\) \{/);
  assert.match(src, /if \(isCliProviderId\(settings\.cleanupProvider\)\) return false;/);
});
