const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

// The harness renders i18n keys verbatim (no i18next instance is initialized),
// so assertions match on the raw translation key rather than resolved copy.
async function renderCard(t, props) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-hands-free-tip-card-test-",
  });
  const mod = await vite.ssrLoadModule("/components/dictation/HandsFreeTipCard.tsx");
  return renderToStaticMarkup(
    createElement(mod.HandsFreeTipCard, {
      hotkey: "Control+`",
      align: "right",
      inPlaceOfPill: false,
      progressDuration: 6000,
      progressPaused: false,
      onDismiss: () => {},
      ...props,
    })
  );
}

test("the tip renders its copy with one keycap per hotkey part", async (t) => {
  const markup = await renderCard(t);

  assert.match(markup, /app\.handsFreeTip\.badge/);
  assert.match(markup, /app\.handsFreeTip\.title/);
  assert.match(markup, /app\.handsFreeTip\.description/);
  assert.equal((markup.match(/<kbd/g) || []).length, 2);
  assert.match(markup, /aria-label="common\.dismiss"/);
  assert.match(markup, /toast-border-progress 6000ms/);
});

test("the tip sits above the pill on the pill's docked edge", async (t) => {
  assert.match(
    await renderCard(t, { align: "right" }),
    /bottom-full[^"]*right-0|right-0[^"]*bottom-full/
  );
  assert.match(
    await renderCard(t, { align: "left" }),
    /bottom-full[^"]*left-0|left-0[^"]*bottom-full/
  );
  assert.match(await renderCard(t, { align: "center" }), /left-1\/2/);
});

test("with the pill hidden the tip takes the pill's place", async (t) => {
  const markup = await renderCard(t, { inPlaceOfPill: true });

  assert.match(markup, /bottom-0/);
  assert.doesNotMatch(markup, /bottom-full/);
});

// The card renders in the pill window under the app's text direction. Arabic
// puts the badge at the inline start, so the dismiss button and the badge
// padding must be logical: a physical right-hand X lands on the badge in RTL.
// (align stays physical on purpose — it tracks the pill's screen edge.)
test("the shell's controls follow the writing direction, not the screen side", async (t) => {
  const markup = await renderCard(t);

  assert.match(markup, /aria-label="common\.dismiss"[^>]*class="[^"]*\bend-4\.5\b/);
  assert.match(markup, /hands-free-tip-badge[^"]*\bps-2\b[^"]*\bpe-2\.5\b/);
  assert.doesNotMatch(markup, /\b(right|left)-4\.5\b/);
  assert.doesNotMatch(markup, /\bp[lr]-2(\.5)?\b/);
});
