const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { renderToStaticMarkup } = require("react-dom/server");
const { createInstance } = require("i18next");
const { I18nextProvider } = require("react-i18next");
const { useDirection } = require("@radix-ui/react-direction");
const { installBrowserGlobals, installHookDom } = require("../lib/rendererTestHarness");

test("the app provider supplies the active i18n direction through real Radix context", async () => {
  const { I18nDirectionProvider } = await import(
    "../../src/components/I18nDirectionProvider.tsx"
  );
  const i18n = createInstance();
  await i18n.init({
    lng: "ar",
    fallbackLng: "en",
    resources: { ar: { translation: {} }, en: { translation: {} } },
  });

  function DirectionProbe() {
    return React.createElement("span", { "data-radix-direction": useDirection() });
  }
  const renderDirection = () =>
    renderToStaticMarkup(
      React.createElement(
        I18nextProvider,
        { i18n },
        React.createElement(
          I18nDirectionProvider,
          null,
          React.createElement(DirectionProbe)
        )
      )
    );

  assert.match(renderDirection(), /data-radix-direction="rtl"/);
  await i18n.changeLanguage("en");
  assert.match(renderDirection(), /data-radix-direction="ltr"/);
});

test("Radix direction reacts to language changes without remounting the app", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installHookDom(t);
  const { I18nDirectionProvider } = await import(
    "../../src/components/I18nDirectionProvider.tsx"
  );
  const i18n = createInstance();
  await i18n.init({
    lng: "ar",
    fallbackLng: "en",
    resources: { ar: { translation: {} }, en: { translation: {} } },
  });
  const observed = [];

  function DirectionProbe() {
    observed.push(useDirection());
    return null;
  }

  await React.act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        I18nextProvider,
        { i18n },
        React.createElement(
          I18nDirectionProvider,
          null,
          React.createElement(DirectionProbe)
        )
      )
    );
  });
  assert.equal(observed.at(-1), "rtl");

  await React.act(async () => {
    await i18n.changeLanguage("en");
  });
  assert.equal(observed.at(-1), "ltr");
});
