const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// Chat answers routinely come back as GFM tables. react-markdown follows
// CommonMark, which has no table syntax, so without remark-gfm the whole table
// collapsed into one paragraph of literal pipes.
const TABLE_MARKDOWN = [
  "| Theme | Note | Meaning |",
  "|:------|:----:|--------:|",
  "| **Activation** | 63 | Week-one drop-off |",
  "| Accuracy | 65 | Four distinct causes |",
  "",
].join("\n");

async function renderMarkdown(t, content) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-markdown-renderer-test-",
  });
  const mod = await vite.ssrLoadModule("/components/ui/MarkdownRenderer.tsx");
  return renderToStaticMarkup(createElement(mod.default, { content }));
}

test("a GFM table renders as a real table, not literal pipes", async (t) => {
  const html = await renderMarkdown(t, TABLE_MARKDOWN);

  assert.ok(html.includes("<table"), "renders a table element");
  assert.ok(html.includes("<th"), "renders header cells");
  assert.equal((html.match(/<tr/g) || []).length, 3, "one header row plus two body rows");
  assert.ok(!html.includes("|"), "no literal pipe survives into the output");
});

test("column alignment from the separator row is preserved", async (t) => {
  const html = await renderMarkdown(t, TABLE_MARKDOWN);

  assert.ok(html.includes("text-align:left"), "left-aligned column");
  assert.ok(html.includes("text-align:center"), "centre-aligned column");
  assert.ok(html.includes("text-align:right"), "right-aligned column");
});

test("a wide table scrolls instead of stretching its container", async (t) => {
  const html = await renderMarkdown(t, TABLE_MARKDOWN);

  assert.ok(html.includes("overflow-x-auto"), "table sits in a scrollable wrapper");
});

test("inline markdown inside cells still renders", async (t) => {
  const html = await renderMarkdown(t, TABLE_MARKDOWN);

  assert.ok(html.includes("<strong"), "bold inside a cell is parsed");
});

test("non-table markdown is unchanged", async (t) => {
  const html = await renderMarkdown(t, "## Heading\n\n- one\n- two\n\n**bold** and `code`\n");

  assert.ok(html.includes("<h2"), "headings still render");
  assert.ok(html.includes("<ul"), "lists still render");
  assert.ok(html.includes("<strong"), "bold still renders");
  assert.ok(html.includes("<code"), "inline code still renders");
  assert.ok(!html.includes("prose"), "no typography-plugin classes: the plugin is not installed");
});

test("GFM extras the plugin enables render as elements, not literal syntax", async (t) => {
  const html = await renderMarkdown(
    t,
    "~~gone~~ and https://openwhispr.com\n\n- [ ] open\n- [x] done\n"
  );

  assert.ok(html.includes("<del"), "strikethrough renders as del");
  assert.ok(!html.includes("~~"), "no literal tildes survive");
  assert.ok(
    html.includes('href="https://openwhispr.com"'),
    "a bare URL is autolinked"
  );
  assert.equal((html.match(/type="checkbox"/g) || []).length, 2, "task list renders two checkboxes");
});

test("URL sanitisation is unchanged with the plugin enabled", async (t) => {
  const html = await renderMarkdown(
    t,
    "[click](javascript:alert(1)) [data](data:text/html,hi) <img src=x onerror=alert(1)>\n"
  );

  assert.ok(!html.includes("javascript:"), "javascript: href is stripped");
  assert.ok(!html.includes("data:text"), "data: href is stripped");
  assert.ok(!html.includes("<img"), "raw HTML stays escaped");
});
