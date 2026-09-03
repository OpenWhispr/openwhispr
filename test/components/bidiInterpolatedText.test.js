const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer } = require("../lib/rendererTestHarness");

test("technical values are isolated without changing localized sentence order", async (t) => {
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-bidi-interpolation-",
  });
  const { BIDI_VALUE_TOKEN, BidiInterpolatedText } = await vite.ssrLoadModule(
    "/components/ui/BidiInterpolatedText.tsx"
  );

  const markup = renderToStaticMarkup(
    React.createElement(BidiInterpolatedText, {
      text: `قبل ${BIDI_VALUE_TOKEN} بعد`,
      value: "v1.9.2-beta.1",
    })
  );

  assert.equal(markup, 'قبل <bdi dir="ltr">v1.9.2-beta.1</bdi> بعد');
});

test("a missing interpolation marker fails closed to the translated text", async (t) => {
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-bidi-interpolation-fallback-",
  });
  const { BidiInterpolatedText } = await vite.ssrLoadModule(
    "/components/ui/BidiInterpolatedText.tsx"
  );

  const markup = renderToStaticMarkup(
    React.createElement(BidiInterpolatedText, {
      text: "نص بلا قيمة",
      value: "ignored@example.com",
    })
  );

  assert.equal(markup, "نص بلا قيمة");
});
