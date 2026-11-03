const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("retired template IDs fall back to AI Summary while edited templates retain their identity", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-template-resolution-" });
  const { resolveTemplate } = await vite.ssrLoadModule("/stores/actionStore.ts");
  const { BUILTIN_ACTIONS, GENERATE_NOTES_KEY, LEGACY_DETAILED_NOTES } =
    await import("../../src/helpers/builtinActions.js");
  const templates = BUILTIN_ACTIONS.filter((a) => a.kind === "template").map((a, id) => ({
    ...a,
    id,
    translation_key: a.translationKey,
    client_id: a.translationKey,
  }));
  for (const clientId of [null, undefined, "missing", LEGACY_DETAILED_NOTES.translationKey]) {
    assert.equal(resolveTemplate(templates, clientId).client_id, GENERATE_NOTES_KEY);
  }
  const edited = {
    ...LEGACY_DETAILED_NOTES,
    kind: "template",
    id: 100,
    translation_key: LEGACY_DETAILED_NOTES.translationKey,
    client_id: LEGACY_DETAILED_NOTES.translationKey,
    prompt: "My edited instructions",
  };
  const custom = {
    id: 101,
    kind: "template",
    client_id: "custom-template",
    prompt: "Custom instructions",
  };
  for (const row of [edited, custom]) {
    assert.equal(resolveTemplate([...templates, edited, custom], row.client_id), row);
  }
  assert.equal(resolveTemplate([], LEGACY_DETAILED_NOTES.translationKey), null);
});

test("default selection accepts only templates and preserves note-specific regeneration", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-default-template-" });
  const { resolveDefaultTemplate, resolveTemplate } =
    await vite.ssrLoadModule("/stores/actionStore.ts");
  const { GENERATE_NOTES_KEY, LEGACY_DETAILED_NOTES } =
    await import("../../src/helpers/builtinActions.js");
  const summary = {
    kind: "template",
    client_id: GENERATE_NOTES_KEY,
    translation_key: GENERATE_NOTES_KEY,
  };
  const custom = { kind: "template", client_id: "custom-template", name: "My template" };
  const previous = { kind: "template", client_id: "previous-template" };
  const chat = { kind: "action", client_id: "chat-action" };
  const catalog = [chat, custom, summary, previous];
  for (const id of [
    null,
    undefined,
    "",
    "missing",
    chat.client_id,
    LEGACY_DETAILED_NOTES.translationKey,
  ]) {
    assert.equal(resolveDefaultTemplate(catalog, id), summary);
  }
  assert.equal(resolveDefaultTemplate(catalog, custom.client_id), custom);
  assert.equal(resolveDefaultTemplate([chat, custom], "missing"), custom);
  assert.equal(resolveDefaultTemplate([], custom.client_id), null);
  assert.equal(resolveDefaultTemplate([chat], chat.client_id), null);
  assert.equal(resolveTemplate(catalog, previous.client_id), previous);
  assert.equal(resolveTemplate(catalog, "missing"), summary);
  assert.equal(resolveTemplate(catalog, chat.client_id), summary);
  assert.equal(resolveTemplate(catalog, null), summary);
});
