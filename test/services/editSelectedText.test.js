const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function editor(t, settings = {}) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-selection-edit-" });
  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", policy: null });
  useSettingsStore.setState({
    useDictationAgent: true,
    dictationAgentMode: "providers",
    dictationAgentProvider: "openai",
    dictationAgentModel: "gpt-4.1-mini",
    isSignedIn: false,
    ...settings,
  });
  const service = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => service.destroy());
  const { editSelectedText } = await vite.ssrLoadModule("/services/editSelectedText.ts");
  return { service, editSelectedText };
}

test("selection edits send the screenshot on their first call and validate complete output", async (t) => {
  const { service, editSelectedText } = await editor(t);
  const calls = [];
  t.mock.method(service, "processText", async (...args) => {
    calls.push(args);
    const marker = args[3].systemPrompt.match(/__OPENWHISPR_SELECTION_COMPLETE_[\w-]+__/)[0];
    return `Revised paragraph.${marker}`;
  });
  const result = await editSelectedText("Elaborate this", "Short paragraph.", {
    attachment: { image: "fixture-image", mediaType: "image/jpeg" },
    signal: new AbortController().signal,
  });
  assert.equal(result, "Revised paragraph.");
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0][0]), {
    spokenInstruction: "Elaborate this",
    selectedText: "Short paragraph.",
  });
  assert.equal(calls[0][1], "gpt-4.1-mini");
  assert.deepEqual(calls[0][3].screenContext, { data: "fixture-image", mediaType: "image/jpeg" });
  assert.equal(calls[0][3].requiresAgent, true);
  assert.equal(calls[0][3].inferenceScope, "dictationAgent");
  assert.equal(calls[0][3].requireCompleteOutput, true);
});

test("selection questions return the existing editor verdict; partial edits are rejected", async (t) => {
  const { service, editSelectedText } = await editor(t);
  let response = "__OPENWHISPR_SELECTION_QUESTION__";
  t.mock.method(service, "processText", async () => response);
  const options = { signal: new AbortController().signal };
  assert.equal(await editSelectedText("Explain this", "Original text", options), null);
  response = "Truncated replacement";
  await assert.rejects(editSelectedText("Rewrite this", "Original text", options), {
    code: "SELECTION_EDIT_INVALID_RESPONSE",
  });
});

test("the local editor uses its JSON contract and drops an answer after cancellation", async (t) => {
  const { service, editSelectedText } = await editor(t, {
    dictationAgentMode: "local",
    dictationAgentProvider: "local",
    dictationAgentModel: "qwen3.5-4b",
  });
  const controller = new AbortController();
  let config;
  t.mock.method(service, "processText", async (_text, _model, _name, options) => {
    config = options;
    return '{"replacement":"Edited locally."}';
  });
  assert.equal(
    await editSelectedText("Rewrite", "Original", { signal: controller.signal }),
    "Edited locally."
  );
  assert.equal(config.responseFormat.type, "json_object");
  assert.equal(config.disableThinking, true);
  controller.abort();
  await assert.rejects(editSelectedText("Rewrite", "Original", { signal: controller.signal }), {
    name: "AbortError",
  });
});

for (const mode of ["providers", "local"]) {
  test(`the ${mode} selection editor preserves the selected app's Tone & Style`, async (t) => {
    const { service, editSelectedText } = await editor(t, {
      dictationAgentMode: mode,
      toneStyleEnabled: true,
      toneStyles: { personal: "very_casual", work: "formal", email: "formal", other: "formal" },
    });
    let prompt;
    t.mock.method(service, "processText", async (_text, _model, _name, config) => {
      prompt = config.systemPrompt;
      const marker = prompt.match(/__OPENWHISPR_SELECTION_COMPLETE_[\w-]+__/)?.[0] ?? "";
      return mode === "local" ? '{"replacement":"edited"}' : `edited${marker}`;
    });
    await editSelectedText("Rewrite this", "Original", {
      appCategory: "personal",
      signal: new AbortController().signal,
    });
    assert.match(prompt, /user's personal message style/);
    assert.match(prompt, /all lowercase/);
    assert.match(prompt, /code and commands.*never restyled/);
  });
}
