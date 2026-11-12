const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/services/tools/webSearchTool.ts");

function stubSearch(t, answer) {
  const previous = global.window;
  global.window = { electronAPI: { agentWebSearch: async () => answer } };
  t.after(() => {
    global.window = previous;
  });
}

test("a failed search reports the failure, not results", async (t) => {
  const { webSearchTool } = await load();
  stubSearch(t, { success: false, error: "Weekly Cloud limit reached", code: "LIMIT_REACHED" });

  const result = await webSearchTool.execute({ query: "today's news" });

  assert.deepEqual(result, {
    success: false,
    data: null,
    displayText: "Web search failed: Weekly Cloud limit reached",
  });
});

test("results keep their fields, with the text cut to 500 characters", async (t) => {
  const { webSearchTool } = await load();
  stubSearch(t, {
    success: true,
    results: [{ title: "A", url: "https://a.example", text: "x".repeat(600) }],
  });

  const result = await webSearchTool.execute({ query: "a" });

  assert.equal(result.success, true);
  assert.equal(result.displayText, 'Found web results for "a"');
  assert.deepEqual(result.data, [
    { title: "A", url: "https://a.example", text: "x".repeat(500), publishedDate: null },
  ]);
});
