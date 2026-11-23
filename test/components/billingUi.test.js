const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function load(t) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-billing-ui-" });
  return vite.ssrLoadModule("/components/settings/billing/BillingUi.tsx");
}

async function loadTones(t) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-billing-tones-" });
  return vite.ssrLoadModule("/components/settings/billing/billingTones.ts");
}

const TONES = ["neutral", "info", "warning", "destructive"];

test("tone classes are distinct per tone and name their token", async (t) => {
  const ui = await loadTones(t);
  const badges = TONES.map(ui.badgeToneClass);
  assert.equal(new Set(badges).size, 4);
  assert.match(ui.badgeToneClass("destructive"), /destructive/);
  assert.match(ui.badgeToneClass("info"), /primary/);
  assert.match(ui.titleToneClass("warning"), /warning/);
  assert.match(ui.bannerToneClass("warning"), /warning/);
});

test("UsageMeterRow clamps percent to 0-100", async (t) => {
  const ui = await load(t);
  const render = (percent) =>
    renderToStaticMarkup(createElement(ui.UsageMeterRow, { label: "Words", value: "1", percent }));
  assert.match(render(140), /width:100%/);
  assert.match(render(-5), /width:0%/);
  assert.match(render(40), /width:40%/);
});

test("BillingBanner renders its action only when given", async (t) => {
  const ui = await load(t);
  const without = renderToStaticMarkup(
    createElement(ui.BillingBanner, { tone: "warning", title: "T", body: "B" })
  );
  assert.doesNotMatch(without, /<button/);
  const withAction = renderToStaticMarkup(
    createElement(ui.BillingBanner, {
      tone: "destructive",
      title: "T",
      action: createElement(ui.PillButton, { variant: "secondary" }, "Fix"),
    })
  );
  assert.match(withAction, /<button/);
  assert.match(withAction, /Fix/);
});

test("BillingBanner announces a destructive tone as an alert, any other as a status", async (t) => {
  const ui = await load(t);
  const render = (tone) =>
    renderToStaticMarkup(createElement(ui.BillingBanner, { tone, title: "T" }));
  assert.match(render("destructive"), /role="alert"/);
  for (const tone of ["neutral", "info", "warning"]) assert.match(render(tone), /role="status"/);
});

test("PlanName's badge uses a logical margin, for right-to-left languages", async (t) => {
  const ui = await load(t);
  const html = renderToStaticMarkup(
    createElement(ui.PlanName, {
      icon: () => null,
      name: "Pro",
      badge: { label: "Monthly", tone: "info" },
    })
  );
  assert.match(html, /\bms-1\.5\b/);
  assert.doesNotMatch(html, /\bml-1\.5\b/);
});

test("PillButton busy is disabled, spins and keeps its label", async (t) => {
  const ui = await load(t);
  const html = renderToStaticMarkup(
    createElement(ui.PillButton, { variant: "primary", busy: true }, "Upgrade")
  );
  assert.match(html, /<button[^>]*\sdisabled(=""|\s|>)/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /animate-spin/);
  assert.match(html, /Upgrade/);
  const idle = renderToStaticMarkup(
    createElement(ui.PillButton, { variant: "primary" }, "Upgrade")
  );
  assert.doesNotMatch(idle, /\sdisabled=""/);
  assert.doesNotMatch(idle, /aria-busy/);
});

test("PillButton names its variant, so a test reads it without parsing classes", async (t) => {
  const ui = await load(t);
  const primary = renderToStaticMarkup(createElement(ui.PillButton, { variant: "primary" }, "A"));
  const secondary = renderToStaticMarkup(
    createElement(ui.PillButton, { variant: "secondary" }, "B")
  );
  assert.match(primary, /data-variant="primary"/);
  assert.match(secondary, /data-variant="secondary"/);
});

test("UsageValueRow takes a node, and its value inherits the row's direction", async (t) => {
  const ui = await load(t);
  const html = renderToStaticMarkup(
    createElement(ui.UsageValueRow, {
      label: "الأعضاء",
      value: createElement("bdi", null, "12"),
    })
  );
  assert.match(html, /<bdi>12<\/bdi>/);
  // A number alone would resolve dir="auto" to LTR and sit on the wrong side of an RTL label.
  const valueSpan = html.match(/<span[^>]*>(?:(?!<span).)*<bdi>/)?.[0] ?? "";
  assert.doesNotMatch(valueSpan, /dir="auto"/);
  // The label still finds its own direction.
  assert.match(html, /<span dir="auto"[^>]*>الأعضاء<\/span>/);
});

test("markup holds no hard-coded colours", async (t) => {
  const ui = await load(t);
  const html = [
    createElement(ui.BillingBlock, { title: "A" }, createElement(ui.BillingBox, null, "x")),
    createElement(ui.PlanName, {
      icon: () => null,
      name: "Pro",
      badge: { label: "Monthly", tone: "info" },
    }),
    createElement(ui.UsageValueRow, { label: "a", value: "b" }),
    createElement(ui.DetailRows, { rows: [{ label: "a", value: "b" }] }),
    createElement(ui.UsageMeterRow, { label: "a", value: "b", percent: 50, tone: "warning" }),
  ]
    .map((el) => renderToStaticMarkup(el))
    .join("");
  assert.doesNotMatch(html, /#[0-9a-fA-F]{3,8}\b|rgb\(/);
});
