const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function loadHighlight(t) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-highlight-match-" });
  const { HighlightMatch } = await vite.ssrLoadModule("/components/ui/HighlightMatch.tsx");
  return (text, query) => renderToStaticMarkup(createElement(HighlightMatch, { text, query }));
}

test("the matched part of a name is marked, whatever its case", async (t) => {
  const render = await loadHighlight(t);

  assert.match(render("Oliver Quinn", "LI"), /^O<mark[^>]*>li<\/mark>ver Quinn$/);
});

test("every occurrence is marked", async (t) => {
  const render = await loadHighlight(t);

  assert.equal(render("banana", "an").match(/<mark/g)?.length, 2);
});

test("an empty or blank query leaves the text plain", async (t) => {
  const render = await loadHighlight(t);

  assert.equal(render("Oliver", ""), "Oliver");
  assert.equal(render("Oliver", "   "), "Oliver");
});

test("a query with nothing to match leaves the text plain", async (t) => {
  const render = await loadHighlight(t);

  assert.equal(render("Oliver", "zed"), "Oliver");
});

test("the match is a soft fill, never a colour", async (t) => {
  const render = await loadHighlight(t);

  const markup = render("rowan@example.com", "rowan");
  assert.match(markup, /bg-foreground\/10/);
  assert.doesNotMatch(markup, /text-(primary|link|blue)/);
});
