const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/tools/snippetTool.ts");

const snippets = [
  { trigger: "investor ask", replacement: "We are raising a $2M seed round." },
  { trigger: "Sign-off", replacement: "Best,\nGabe" },
];

test("the description lists every saved trigger so the model can pick one without a call", async () => {
  const { createSnippetTool } = await load();
  const tool = createSnippetTool(snippets);

  assert.equal(tool.name, "get_snippet");
  assert.equal(tool.readOnly, true);
  assert.match(tool.description, /Saved triggers: "investor ask", "Sign-off"\./);
  assert.doesNotMatch(tool.description, /seed round/);
});

test("a trigger resolves case-insensitively to its saved text", async () => {
  const { createSnippetTool } = await load();
  const tool = createSnippetTool(snippets);

  const result = await tool.execute({ trigger: " sign-off " });

  assert.deepEqual(result, {
    success: true,
    data: { trigger: "Sign-off", text: "Best,\nGabe" },
    displayText: 'Snippet "Sign-off"',
  });
});

test("an unknown trigger fails with the saved triggers so the model can retry", async () => {
  const { createSnippetTool } = await load();
  const tool = createSnippetTool(snippets);

  const result = await tool.execute({ trigger: "intro" });

  assert.equal(result.success, false);
  assert.equal(result.data, null);
  assert.equal(
    result.displayText,
    'No snippet with trigger "intro". Saved triggers: "investor ask", "Sign-off"'
  );
});

function vocabulary(current) {
  const writes = [];
  return {
    writes,
    actions: {
      getDictionary: () => [],
      updateDictionary: () => {},
      getSnippets: () => current,
      setSnippets: (next) => writes.push(next),
    },
  };
}

test("registry exposes the vocabulary tools, and get_snippet only when snippets exist", async () => {
  const { createToolRegistry } = await import("../../src/services/tools/index.ts");
  const settings = {
    isSignedIn: false,
    calendarConnected: false,
    cloudBackupEnabled: false,
    webSearchEnabled: false,
  };

  const withSnippets = createToolRegistry({
    ...settings,
    vocabulary: vocabulary(snippets).actions,
  });
  const withoutSnippets = createToolRegistry({ ...settings, vocabulary: vocabulary([]).actions });
  const noVocabulary = createToolRegistry(settings);

  assert.match(withSnippets.get("get_snippet")?.description ?? "", /"investor ask"/);
  assert.equal(withSnippets.get("update_dictionary")?.readOnly, false);
  assert.equal(withSnippets.get("update_snippets")?.readOnly, false);
  assert.equal(withoutSnippets.get("get_snippet"), undefined);
  assert.equal(withoutSnippets.get("update_snippets")?.readOnly, false);
  assert.equal(noVocabulary.get("update_dictionary"), undefined);
});

test("update_snippets replaces an existing trigger, adds a new one, and removes by trigger", async () => {
  const { createUpdateSnippetsTool } = await load();
  const { actions, writes } = vocabulary(snippets);
  const tool = createUpdateSnippetsTool(actions);

  const result = await tool.execute({
    add: [
      { trigger: "SIGN-OFF", replacement: "Cheers,\nGabe" },
      { trigger: "intro", replacement: "Hi, I'm Gabe." },
    ],
    remove: ["Investor Ask"],
  });

  assert.deepEqual(writes, [
    [
      { trigger: "SIGN-OFF", replacement: "Cheers,\nGabe" },
      { trigger: "intro", replacement: "Hi, I'm Gabe." },
    ],
  ]);
  assert.deepEqual(result.data, {
    added: ["intro"],
    replaced: ["Sign-off"],
    removed: ["investor ask"],
    notFound: [],
  });
  assert.equal(result.displayText, 'Added "intro"; Replaced "Sign-off"; Removed "investor ask"');
});

test("update_snippets refuses incomplete snippets and unknown triggers without writing", async () => {
  const { createUpdateSnippetsTool } = await load();
  const { actions, writes } = vocabulary(snippets);
  const tool = createUpdateSnippetsTool(actions);

  const incomplete = await tool.execute({ add: [{ trigger: "intro" }] });
  const tooLong = await tool.execute({ add: [{ trigger: "x".repeat(101), replacement: "y" }] });
  const unknown = await tool.execute({ remove: ["outro"] });

  assert.equal(writes.length, 0);
  assert.equal(incomplete.success, false);
  assert.equal(tooLong.success, false);
  assert.equal(unknown.success, false);
  assert.equal(unknown.displayText, 'No snippet with trigger "outro"');
});

test("the agent prompt tells the model when to fetch a snippet", async () => {
  const { getAgentSystemPrompt } = await import("../../src/config/prompts.ts");

  const prompt = getAgentSystemPrompt(["get_snippet"]);

  assert.match(prompt, /Use get_snippet whenever the user names one of their saved snippets/);
  assert.match(prompt, /reproduce the returned text verbatim/);
  assert.doesNotMatch(getAgentSystemPrompt(["copy_to_clipboard"]), /get_snippet/);
});
