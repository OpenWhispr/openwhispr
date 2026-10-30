const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { createRoot } = require("react-dom/client");

const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { findElement, installInteractiveDom } = require("../lib/interactiveDom");

const STYLES = path.join(__dirname, "../../src/styles/skill-icon.css");
const APP_STYLES = path.join(__dirname, "../../src/index.css");

async function mountIcon(t) {
  let root = null;
  // Registered first, so it runs before the browser globals are taken down
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-skill-icon-test-" });
  const { SkillIcon } = await vite.ssrLoadModule("/components/skills/SkillIcon.tsx");
  root = createRoot(container);
  return {
    render: (props) =>
      React.act(async () => root.render(React.createElement(SkillIcon, props))),
    svg: () => findElement(container, (node) => node.tagName === "SVG"),
  };
}

const playing = (svg) => /(^|\s)skill-icon-play(\s|$)/.test(svg.getAttribute("class") ?? "");

test("the icon plays only when its play count changes", async (t) => {
  const { render, svg } = await mountIcon(t);

  // A card mounted after earlier plays doesn't replay them
  await render({ playKey: 3 });
  const first = svg();
  assert.equal(playing(first), false);
  await render({ playKey: 3 });
  assert.equal(svg() === first, true);

  await render({ playKey: 4 });
  const played = svg();
  // A new svg element, so the drop starts from its first frame
  assert.equal(played === first, false);
  assert.equal(playing(played), true);

  await render({ playKey: 4, className: "text-primary" });
  assert.equal(svg() === played, true);
  assert.match(svg().getAttribute("class"), /text-primary/);
});

test("the glyph has three layers and no bars", async (t) => {
  const { render, svg } = await mountIcon(t);
  await render({ size: 20 });

  assert.deepEqual(
    svg()
      .querySelectorAll("[data-layer]")
      .map((layer) => layer.getAttribute("data-layer")),
    ["3", "2", "1"]
  );
  assert.deepEqual(
    svg()
      .querySelectorAll("path")
      .map((stroke) => stroke.getAttribute("d")),
    ["M2.5 16.5 12 21.5l9.5-5", "M2.5 12 12 17l9.5-5", "M12 2 2.5 7 12 12l9.5-5L12 2z"]
  );
  assert.equal(svg().querySelectorAll("rect").length, 0);
  assert.deepEqual(
    [svg().getAttribute("width"), svg().getAttribute("data-icon")],
    ["20", "skill-stack"]
  );
});

test("reduced motion fades instead of dropping", () => {
  const css = fs.readFileSync(STYLES, "utf8").replace(/\s+/g, " ");
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{(.*)\}\s*$/)?.[1] ?? "";

  assert.match(
    reduced,
    /\.skill-icon-play \{ animation: reduced-motion-fade-in 150ms [^}]*!important; \}/
  );
  assert.match(reduced, /\.skill-icon-play \[data-layer\] \{ animation: none !important; \}/);
  // The fade is the app's own reduced-motion keyframe, so it must still exist there
  assert.match(fs.readFileSync(APP_STYLES, "utf8"), /@keyframes reduced-motion-fade-in \{/);
});
