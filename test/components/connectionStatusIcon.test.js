const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer } = require("../lib/rendererTestHarness");

const repoRoot = path.join(__dirname, "../..");
const source = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
const ICON_CSS = "src/styles/connection-status-icon.css";

async function loadIcon(t) {
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-status-icon-" });
  const module = await vite.ssrLoadModule("/components/ui/ConnectionStatusIcon.tsx");
  return module.ConnectionStatusIcon;
}

test("one decorative SVG carries every state, so a change animates in place", async (t) => {
  const ConnectionStatusIcon = await loadIcon(t);
  for (const state of ["checking", "connected", "unverified", "failed"]) {
    const markup = renderToStaticMarkup(React.createElement(ConnectionStatusIcon, { state }));
    const root = markup.match(/^<svg[^>]*>/)?.[0] ?? "";
    assert.match(root, /aria-hidden="true"/, state);
    assert.match(root, new RegExp(`data-state="${state}"`));
    assert.match(root, /class="connection-status-icon"/);
    for (const part of ["spin", "ring", "tick", "bang", "dot"]) {
      assert.match(markup, new RegExp(`class="connection-status-icon-${part}"`));
    }
    assert.equal(markup.match(/pathLength="100"/g)?.length, 3);
    assert.doesNotMatch(markup, />[^<]+</, "the icon carries no words");
  }
});

test("it uses the onboarding grey and the app's readable status colours", () => {
  const css = source(ICON_CSS);
  assert.match(css, /var\(--onboarding-text-secondary, var\(--color-muted-foreground\)\)/);
  assert.match(css, /color: var\(--color-success\);/);
  assert.match(css, /color: var\(--color-destructive\);/);
  assert.match(css, /\[data-state="unverified"\] \{\s*color: var\(--color-warning\);/);
  assert.doesNotMatch(css, /--onboarding-(success|danger)/);
  assert.match(css, /animation: spinner-rotate 0\.75s linear infinite/);
  assert.match(source("src/index.css"), /@keyframes spinner-rotate \{[\s\S]*?rotate\(360deg\)/);
});

test("reduced motion stops the spin and settles the shapes at once", () => {
  // The icon relies on the app-wide block; it must not fight it.
  assert.doesNotMatch(source(ICON_CSS), /!important|prefers-reduced-motion/);
  const css = source("src/index.css");
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  const properties = reduced.match(/transition-property:\s*([^;]+);/)[1];
  for (const fade of ["opacity", "color", "stroke"]) {
    assert.match(properties, new RegExp(`\\b${fade}\\b`), fade);
  }
  assert.doesNotMatch(properties, /stroke-dash|transform/);
  assert.match(reduced, /animation-duration: 0\.01ms !important;/);
  assert.match(reduced, /animation-iteration-count: 1 !important;/);
});
