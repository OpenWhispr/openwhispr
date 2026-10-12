const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom, findElement } = require("../lib/interactiveDom");

const FIELDS = {
  to: ["josh@acme.test", "dana@acme.test"],
  cc: [],
  subject: "Q3 numbers",
  body: "Line one\nLine two",
};

async function loadFields(t) {
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-email-fields-test-" });
  return vite.ssrLoadModule("/components/chat/EmailApprovalFields.tsx");
}

// React's change event reads the new value from the element, then an input event.
function type(element, value) {
  element.value = value;
  element.dispatchEvent({
    type: "input",
    bubbles: true,
    defaultPrevented: false,
    cancelBubble: false,
    preventDefault() {},
    stopPropagation() {
      this.cancelBubble = true;
    },
  });
}

// No i18next instance is initialized, so labels render as their keys.
const field = (root, labelKey) =>
  findElement(
    root,
    (element) => element.getAttribute?.("aria-label") === `connectors.approval.email.${labelKey}`
  );

test("outside edit mode the fields are shown, Cc only when it has addresses", async (t) => {
  installBrowserGlobals(t);
  const { EmailApprovalFields } = await loadFields(t);
  const render = (fields) =>
    renderToStaticMarkup(
      React.createElement(EmailApprovalFields, {
        fields,
        editing: false,
        onChange() {},
      })
    );

  const markup = render(FIELDS);
  assert.match(markup, /josh@acme\.test, dana@acme\.test/);
  assert.match(markup, /Q3 numbers/);
  assert.match(markup, /Line one\nLine two/);
  assert.doesNotMatch(markup, /connectors\.approval\.email\.ccLabel/);
  assert.doesNotMatch(markup, /<input|<textarea/);
  assert.match(render({ ...FIELDS, cc: ["sam@acme.test"] }), /sam@acme\.test/);
});

test("outside edit mode a non-ASCII domain also shows its punycode form", async (t) => {
  installBrowserGlobals(t);
  const { EmailApprovalFields } = await loadFields(t);
  const markup = renderToStaticMarkup(
    React.createElement(EmailApprovalFields, {
      fields: { ...FIELDS, to: ["a@müller.de"], cc: ["b@müller.de"] },
      editing: false,
      onChange() {},
    })
  );
  // recipientLabel's punycode annotation, same form the approval card's
  // destinationLabel uses, so a single-script look-alike domain can't pass
  // as the real one on the card either.
  assert.match(markup, /a@müller\.de \(xn--mller-kva\.de\)/);
  assert.match(markup, /b@müller\.de \(xn--mller-kva\.de\)/);
});

test("in edit mode To and Cc show the raw address, not its punycode form", async (t) => {
  const { container } = await mountEditor(t, { ...FIELDS, to: ["a@müller.de"], cc: [] });
  assert.equal(field(container, "toLabel").value, "a@müller.de");
});

async function mountEditor(t, initial = FIELDS) {
  let root = null;
  // Registered before installBrowserGlobals's cleanup, which removes window.
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  installBrowserGlobals(t);
  const container = installInteractiveDom(t);
  const { EmailApprovalFields } = await loadFields(t);
  const patches = [];
  function Harness() {
    const [fields, setFields] = React.useState(initial);
    return React.createElement(EmailApprovalFields, {
      fields,
      editing: true,
      onChange: (patch) => {
        patches.push(patch);
        setFields((current) => ({ ...current, ...patch }));
      },
    });
  }
  const { createRoot } = require("react-dom/client");
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  return { container, patches };
}

test("typing in To reports the parsed list and keeps the comma the user just typed", async (t) => {
  const { container, patches } = await mountEditor(t);
  const to = field(container, "toLabel");
  assert.equal(to.value, "josh@acme.test, dana@acme.test");

  await React.act(async () => type(to, "josh@acme.test,"));
  assert.deepEqual(patches.at(-1), { to: ["josh@acme.test"] });
  assert.equal(field(container, "toLabel").value, "josh@acme.test,");

  // A pasted "Name <address>" reaches the draft as the address Send uses,
  // while the input keeps what the user pasted.
  await React.act(async () => type(field(container, "ccLabel"), "sam@acme.test, Sam <s@x.test>"));
  assert.deepEqual(patches.at(-1), { cc: ["sam@acme.test", "s@x.test"] });
  assert.equal(field(container, "ccLabel").value, "sam@acme.test, Sam <s@x.test>");
});

test("a line break typed or pasted into Subject becomes a space; Body keeps its lines", async (t) => {
  const { container, patches } = await mountEditor(t);

  await React.act(async () =>
    type(field(container, "subjectLabel"), "Q3\r\nBcc: evil@attacker.test")
  );
  assert.deepEqual(patches.at(-1), { subject: "Q3 Bcc: evil@attacker.test" });
  assert.equal(field(container, "subjectLabel").value, "Q3 Bcc: evil@attacker.test");

  await React.act(async () => type(field(container, "bodyLabel"), "Hi\n\nThanks"));
  assert.deepEqual(patches.at(-1), { body: "Hi\n\nThanks" });
});
