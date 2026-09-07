const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function renderCard(t, props) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-hold-migration-card-test-",
  });
  const mod = await vite.ssrLoadModule("/components/dictation/HoldMigrationCard.tsx");
  return renderToStaticMarkup(
    createElement(mod.HoldMigrationCard, {
      hotkey: "Control+`",
      align: "right",
      inPlaceOfPill: false,
      onDismiss: () => {},
      ...props,
    })
  );
}

test("the card carries the approved copy, the dictation keycaps, an X and nothing else", async (t) => {
  const markup = await renderCard(t);

  assert.match(markup, /app\.holdMigrationCard\.badge/);
  assert.match(markup, /app\.holdMigrationCard\.title/);
  assert.match(markup, /app\.holdMigrationCard\.description/);
  assert.match(markup, /app\.holdMigrationCard\.gesture/);
  assert.equal((markup.match(/<kbd/g) || []).length, 2);
  assert.match(markup, /aria-label="common\.dismiss"/);
  // No button beyond the X, no countdown arc: the next press is the practice.
  assert.equal((markup.match(/<button/g) || []).length, 1);
  assert.doesNotMatch(markup, /toast-border-progress/);
});

test("the card shares the tip card's placement rules", async (t) => {
  assert.match(await renderCard(t, { align: "right" }), /bottom-full[^"]*right-0|right-0[^"]*bottom-full/);
  assert.match(await renderCard(t, { align: "left" }), /left-0/);
  assert.match(await renderCard(t, { inPlaceOfPill: true }), /bottom-0/);
});
