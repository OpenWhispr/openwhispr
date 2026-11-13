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
    const marker = args[3].systemPrompt.match(/__OPENWHISPR_SELECTION_COMPLETE_[0-9a-f-]+/)[0];
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

test("the completion marker's instruction stays last, after the screen-context block", async (t) => {
  const { service, editSelectedText } = await editor(t);
  const configs = [];
  t.mock.method(service, "processText", async (...args) => {
    configs.push(args[3]);
    if (configs.length === 1) throw new Error("image rejected");
    return `Revised.${args[3].systemPrompt.match(/__OPENWHISPR_SELECTION_COMPLETE_[0-9a-f-]+/)[0]}`;
  });
  await editSelectedText("Elaborate this", "Short.", {
    attachment: { image: "fixture-image", mediaType: "image/jpeg" },
    signal: new AbortController().signal,
  });
  assert.equal(configs.length, 2);
  for (const { systemPrompt } of configs) {
    const lastLine = systemPrompt.trimEnd().split("\n").at(-1);
    assert.match(lastLine, /append this exact completion marker.*__OPENWHISPR_SELECTION_COMPLETE_/);
  }
  const withScreen = configs[0].systemPrompt;
  assert.ok(withScreen.indexOf("SCREEN CONTEXT:") < withScreen.indexOf("SELECTION EDITING MODE:"));
});

test("a Cloud screenshot edit validates its JSON envelope; text-only and BYOK require a nonce", async (t) => {
  const cloud = await editor(t, { dictationAgentMode: "openwhispr", isSignedIn: true });
  let response = '{"replacement":"Revised paragraph."}';
  const calls = [];
  t.mock.method(cloud.service, "processText", async (...args) => {
    calls.push(args);
    return response;
  });
  const signal = new AbortController().signal;
  const attachment = { image: "fixture-image", mediaType: "image/jpeg" };
  assert.equal(
    await cloud.editSelectedText("Elaborate this", "Short.", { attachment, signal }),
    "Revised paragraph."
  );
  assert.equal(calls.length, 1);
  assert.ok(calls[0][3].screenContext);
  assert.equal(calls[0][3].responseFormat, undefined);
  assert.match(calls[0][0], /Selected document \(JSON string\):\n"Short\."/);
  assert.match(calls[0][3].systemPrompt, /Return exactly one JSON object/);
  const literalDocument = '  "quoted" \\path\n```ts\nconst value = "literal";\n```\n';
  response = JSON.stringify({ replacement: literalDocument });
  assert.equal(
    await cloud.editSelectedText("Rewrite this", "Short.", { attachment, signal }),
    literalDocument
  );
  for (response of [
    "Revised paragraph.",
    '{"replacement":"Only the first paragraph',
    '{"replacement":"Only the first paragraph"',
    '{"replacement":""}',
  ]) {
    await assert.rejects(
      cloud.editSelectedText("Elaborate this", "Short.", { attachment, signal })
    );
  }
  response = '{"replacement":"Revised paragraph."}';
  await assert.rejects(cloud.editSelectedText("Elaborate this", "Short.", { signal }), {
    code: "SELECTION_EDIT_INVALID_RESPONSE",
  });
  response = '{"replacement":"__OPENWHISPR_SELECTION_QUESTION__"}';
  assert.equal(
    await cloud.editSelectedText("Explain this", "Short.", { attachment, signal }),
    null
  );

  const byok = await editor(t);
  t.mock.method(byok.service, "processText", async () => "Revised paragraph.");
  await assert.rejects(byok.editSelectedText("Elaborate this", "Short.", { attachment, signal }), {
    code: "SELECTION_EDIT_INVALID_RESPONSE",
  });
});

test("a Cloud screenshot retry rejects raw prose and keeps the complete JSON contract", async (t) => {
  const { service, editSelectedText } = await editor(t, {
    dictationAgentMode: "openwhispr",
    isSignedIn: true,
  });
  let response = "I can't see your screen, but here is a fuller version.";
  const configs = [];
  t.mock.method(service, "processText", async (_text, _model, _agent, config) => {
    configs.push(config);
    if (config.screenContext) throw new Error("image rejected");
    return response;
  });
  await assert.rejects(
    editSelectedText("Elaborate this", "Short.", {
      attachment: { image: "fixture-image", mediaType: "image/jpeg" },
      signal: new AbortController().signal,
    }),
    { code: "SELECTION_EDIT_INVALID_RESPONSE" }
  );
  assert.equal(configs.length, 2);
  response = '{"replacement":"Complete fuller version."}';
  assert.equal(
    await editSelectedText("Elaborate this", "Short.", {
      attachment: { image: "fixture-image", mediaType: "image/jpeg" },
      signal: new AbortController().signal,
    }),
    "Complete fuller version."
  );
  assert.equal(configs.length, 4);
  assert.match(configs[2].systemPrompt, /SCREEN CONTEXT:/);
  assert.doesNotMatch(configs[3].systemPrompt, /SCREEN CONTEXT:/);
  for (const config of configs) assert.match(config.systemPrompt, /Return exactly one JSON object/);
});

test("a screenshot the model refuses costs the edit nothing: it runs once more without it", async (t) => {
  const { service, editSelectedText } = await editor(t);
  const configs = [];
  t.mock.method(service, "processText", async (...args) => {
    configs.push(args[3]);
    if (configs.length === 1) throw new Error("image rejected");
    const marker = args[3].systemPrompt.match(/__OPENWHISPR_SELECTION_COMPLETE_[0-9a-f-]+/)[0];
    return `Revised.${marker}`;
  });
  const attachment = { image: "fixture-image", mediaType: "image/jpeg" };
  const result = await editSelectedText("Elaborate this", "Short.", {
    attachment,
    signal: new AbortController().signal,
  });
  assert.equal(result, "Revised.");
  assert.equal(configs.length, 2);
  assert.ok(configs[0].screenContext);
  assert.match(configs[0].systemPrompt, /SCREEN CONTEXT:/);
  assert.equal(configs[1].screenContext, undefined);
  assert.doesNotMatch(configs[1].systemPrompt, /SCREEN CONTEXT:/);
  assert.match(configs[1].systemPrompt, /__OPENWHISPR_SELECTION_COMPLETE_/);

  // Without a screenshot, or once cancelled, a failure is the answer.
  for (const [options, controller] of [
    [{}, new AbortController()],
    [{ attachment }, new AbortController()],
  ]) {
    configs.length = 0;
    t.mock.method(service, "processText", async (...args) => {
      configs.push(args[3]);
      if (options.attachment) controller.abort();
      throw new Error("provider down");
    });
    await assert.rejects(
      editSelectedText("Elaborate this", "Short.", { ...options, signal: controller.signal })
    );
    assert.equal(configs.length, 1);
  }
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

test("an edit ending at the nonce, with no closing underscores, is accepted; a partial one is not", async (t) => {
  const { service, editSelectedText } = await editor(t);
  let cut = 0;
  t.mock.method(service, "processText", async (...args) => {
    const nonce = args[3].systemPrompt.match(/__OPENWHISPR_SELECTION_COMPLETE_[0-9a-f-]+/)[0];
    return `Revised.${nonce.slice(0, nonce.length - cut)}`;
  });
  const options = { signal: new AbortController().signal };
  assert.equal(await editSelectedText("Rewrite this", "Original.", options), "Revised.");
  cut = 1;
  await assert.rejects(editSelectedText("Rewrite this", "Original.", options), {
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

for (const mode of ["providers", "local", "openwhispr"]) {
  test(`the ${mode} selection editor preserves the selected app's Tone & Style`, async (t) => {
    const { service, editSelectedText } = await editor(t, {
      dictationAgentMode: mode,
      isSignedIn: mode === "openwhispr",
      toneStyleEnabled: true,
      toneStyles: { personal: "very_casual", work: "formal", email: "formal", other: "formal" },
      customDictionary: ["ZephyrWidget"],
      customPrompts: { dictationAgent: "Use British spelling for {{agentName}}." },
    });
    let prompt;
    t.mock.method(service, "processText", async (_text, _model, _name, config) => {
      prompt = config.systemPrompt;
      const marker = prompt.match(/__OPENWHISPR_SELECTION_COMPLETE_[0-9a-f-]+/)?.[0] ?? "";
      return mode === "providers" ? `edited${marker}` : '{"replacement":"edited"}';
    });
    await editSelectedText("Rewrite this", "Original", {
      appCategory: "personal",
      ...(mode === "openwhispr"
        ? { attachment: { image: "fixture-image", mediaType: "image/jpeg" } }
        : {}),
      signal: new AbortController().signal,
    });
    assert.match(prompt, /user's personal message style/);
    assert.match(prompt, /all lowercase/);
    assert.match(prompt, /code and commands.*never restyled/);
    assert.match(prompt, /Use British spelling/);
    assert.match(prompt, /ZephyrWidget/);
  });
}
