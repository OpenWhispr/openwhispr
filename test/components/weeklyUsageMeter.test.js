const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const i18next = require("i18next");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function meterRenderer(t, language = "en") {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t);
  const { I18nextProvider } = await vite.ssrLoadModule("react-i18next");
  const { default: WeeklyUsageMeter } = await vite.ssrLoadModule(
    "/components/WeeklyUsageMeter.tsx"
  );
  const instance = i18next.createInstance();
  await instance.init({
    lng: language,
    fallbackLng: "en",
    resources: {
      [language]: { translation: require(`../../src/locales/${language}/translation.json`) },
      en: { translation: require("../../src/locales/en/translation.json") },
    },
    interpolation: { escapeValue: false },
  });
  return (props) =>
    renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n: instance },
        createElement(WeeklyUsageMeter, {
          wordsUsed: 860,
          limit: 2000,
          nextWordsAvailableAt: null,
          onRefresh: async () => {},
          ...props,
        })
      )
    );
}

test("partial usage stays blue and reports a determinate accessible percentage", async (t) => {
  const render = await meterRenderer(t);
  const markup = render({ wordsUsed: 1999 });
  assert.match(markup, /bg-primary/);
  assert.doesNotMatch(markup, /bg-destructive|bg-warning/);
  assert.match(markup, /aria-valuenow="99.95"/);
  assert.match(markup, /aria-valuetext="1,999 \/ 2,000 words this week"/);
  assert.match(markup, />99%<\/span>/);
  assert.doesNotMatch(markup, />100%<\/span>/);
});

test("exhausted and exceeded allowances use red and cap the percentage at 100", async (t) => {
  const render = await meterRenderer(t);
  for (const wordsUsed of [2000, 2400]) {
    const markup = render({ wordsUsed });
    assert.match(markup, /bg-destructive/);
    assert.match(markup, /aria-valuenow="100"/);
    assert.match(markup, />100%<\/span>/);
  }
});

test("exact whole percentages do not lose a point to floating-point division", async (t) => {
  const render = await meterRenderer(t);
  for (const [wordsUsed, percentage] of [
    [580, 29],
    [1140, 57],
    [1160, 58],
  ]) {
    assert.match(render({ wordsUsed }), new RegExp(`>${percentage}%</span>`));
  }
});

test("timing precedes the percentage and is absent without authoritative active usage", async (t) => {
  const now = Date.parse("2026-09-21T12:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now });
  const render = await meterRenderer(t);
  const nextWordsAvailableAt = "2026-09-22T12:00:00Z";
  const markup = render({ nextWordsAvailableAt });
  assert.match(markup, /Words return in 1 day/);
  assert.ok(markup.indexOf("Words return in 1 day") < markup.indexOf(">43%"));
  for (const props of [
    { nextWordsAvailableAt: null },
    { nextWordsAvailableAt: "rolling" },
    { nextWordsAvailableAt: "2026-09-20T12:00:00Z" },
    { wordsUsed: 0, nextWordsAvailableAt },
  ]) {
    assert.doesNotMatch(render(props), /Words return in/);
  }
  for (const limit of [0, -1]) assert.equal(render({ limit }), "");
});

test("countdown and percentage use the selected language", async (t) => {
  const now = Date.parse("2026-09-21T12:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now });
  const render = await meterRenderer(t, "fr");
  const markup = render({ nextWordsAvailableAt: "2026-09-23T12:00:00Z" });
  assert.match(markup, /Les mots seront à nouveau disponibles dans 2 jours/);
  assert.ok(markup.includes(new Intl.NumberFormat("fr", { style: "percent" }).format(0.43)));
});
