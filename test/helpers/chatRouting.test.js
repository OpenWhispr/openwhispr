const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/chatRouting.js");

test("custom BYOK Chat stays on its provider route", async () => {
  const { resolveChatRoute } = await load();
  const route = resolveChatRoute({
    provider: "custom",
    customApiKey: "litellm-key",
  });

  assert.deepEqual(route, { kind: "provider", baseUrl: "", apiKey: "" });
});

test("built-in provider Chat stays on its provider route", async () => {
  const { resolveChatRoute } = await load();
  const route = resolveChatRoute({ provider: "gemini" });

  assert.equal(route.kind, "provider");
});

test("local Chat stays on its local route", async () => {
  const { resolveChatRoute } = await load();
  const route = resolveChatRoute({ provider: "ollama" });

  assert.equal(route.kind, "local");
});

test("explicit self-hosted Chat URL wins over a stale enterprise provider", async () => {
  const { resolveChatRoute } = await load();
  const route = resolveChatRoute({
    provider: "bedrock",
    lanUrl: "  http://127.0.0.1:4000/v1  ",
    customApiKey: "  secret-key  ",
    isEnterpriseProvider: true,
  });

  assert.deepEqual(route, {
    kind: "self-hosted",
    baseUrl: "http://127.0.0.1:4000/v1",
    apiKey: "secret-key",
  });
});

test("self-hosted Chat preserves an empty optional API key", async () => {
  const { resolveChatRoute } = await load();
  const route = resolveChatRoute({
    provider: "custom",
    lanUrl: "http://127.0.0.1:11434/v1",
  });

  assert.equal(route.kind, "self-hosted");
  assert.equal(route.apiKey, "");
});

test("enterprise Chat stays enterprise without a Chat LAN URL", async () => {
  const { resolveChatRoute } = await load();
  const route = resolveChatRoute({
    provider: "vertex",
    isEnterpriseProvider: true,
  });

  assert.equal(route.kind, "enterprise");
});

test("blank Chat LAN URL does not activate self-hosted routing", async () => {
  const { resolveChatRoute } = await load();
  const route = resolveChatRoute({
    provider: "custom",
    lanUrl: "   ",
    customApiKey: "secret-key",
  });

  assert.equal(route.kind, "provider");
});
