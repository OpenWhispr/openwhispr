const assert = require("node:assert/strict");
const test = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer } = require("../lib/rendererTestHarness");

test("shared field primitives inherit unless a consumer declares its content direction", async (t) => {
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-field-direction-primitives-",
  });
  const { Input } = await vite.ssrLoadModule("/components/ui/input.tsx");
  const { Textarea } = await vite.ssrLoadModule("/components/ui/textarea.tsx");

  const inherited = renderToStaticMarkup(
    React.createElement(Input, { value: "مرحبا OpenWhispr 2.0", readOnly: true })
  );
  assert.doesNotMatch(inherited, /\sdir=/);
  assert.match(inherited, /value="مرحبا OpenWhispr 2.0"/);

  const technicalPassword = renderToStaticMarkup(
    React.createElement(Input, {
      dir: "ltr",
      type: "password",
      value: "سر-sk_ABC/123",
      readOnly: true,
    })
  );
  assert.match(technicalPassword, /\sdir="ltr"/);
  assert.match(technicalPassword, /value="سر-sk_ABC\/123"/);

  const prose = renderToStaticMarkup(
    React.createElement(Textarea, {
      dir: "auto",
      value: "مرحبا OpenWhispr 2.0",
      readOnly: true,
    })
  );
  assert.match(prose, /\sdir="auto"/);
  assert.match(prose, />مرحبا OpenWhispr 2.0<\/textarea>/);
});
