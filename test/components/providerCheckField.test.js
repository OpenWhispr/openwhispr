const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const { installInteractiveDom, findElement } = require("../lib/interactiveDom");

const LABEL = "onboarding.rehaul.provider.apiKey";

async function loadField(t) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-provider-check-field-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        const t = (key) => key;
        export function useTranslation() { return { t }; }
      `,
    },
  });
  const module = await vite.ssrLoadModule("/components/onboarding/ProviderCheckField.tsx");
  return module.ProviderCheckField;
}

const markup = (Field, check, invalidOn = "credentialsRejected") =>
  renderToStaticMarkup(
    React.createElement(Field, {
      label: LABEL,
      check: { failure: null, retry() {}, ...check },
      invalidOn,
      type: "password",
      value: "sk-test",
      readOnly: true,
    })
  );

const failed = (errorCode) => ({
  phase: "failed",
  failure: { success: false, ...(errorCode && { errorCode, status: 400 }) },
});

test("an idle field shows no status but keeps its reason target", async (t) => {
  const html = markup(await loadField(t), { phase: "idle" });
  assert.doesNotMatch(html, /<svg/);
  assert.doesNotMatch(html, /aria-invalid="/);
  assert.doesNotMatch(html, /\bpe-9\b/);
  const reasonId = html.match(/aria-describedby="([^"]+)"/)[1];
  assert.match(html, new RegExp(`<span id="${reasonId}" role="alert"></span>`));
});

test("the status sits at the field's own end and changes with the check", async (t) => {
  const Field = await loadField(t);
  for (const [phase, state] of [
    ["waiting", "checking"],
    ["checking", "checking"],
    ["connected", "connected"],
  ]) {
    const html = markup(Field, { phase });
    assert.match(html, new RegExp(`data-state="${state}"`), phase);
    assert.match(html, /<span dir="ltr" class="relative block">/);
    const input = html.match(/<input[^>]*>/)[0];
    assert.match(input, /dir="ltr"/);
    assert.match(input, /\bpe-9\b/);
    assert.match(html, /class="connection-status-icon pointer-events-none absolute end-2\.5/);
    assert.match(html, /role="alert"><\/span>/, "no reason while not failed");
  }
});

test("the field's own failure shows the reason, Retry and aria-invalid", async (t) => {
  const Field = await loadField(t);
  for (const errorCode of ["credentialsRejected", "modelNotFound"]) {
    const html = markup(Field, failed(errorCode), errorCode);
    assert.match(html, /data-state="failed"/);
    assert.match(html, /aria-invalid="true"/);
    const reason = `role="alert">onboarding\\.rehaul\\.provider\\.errors\\.${errorCode}<`;
    assert.match(html, new RegExp(reason));
    assert.match(html, /<button type="button"[^>]*>common\.retry<\/button>/);
  }
});

test("a failure about another field shows its reason but leaves this value valid", async (t) => {
  const Field = await loadField(t);
  for (const [errorCode, invalidOn] of [
    ["modelNotFound", "credentialsRejected"],
    ["credentialsRejected", "modelNotFound"],
  ]) {
    const html = markup(Field, failed(errorCode), invalidOn);
    assert.doesNotMatch(html, /aria-invalid="/, `${errorCode} in a ${invalidOn} field`);
    assert.match(html, new RegExp(`errors\\.${errorCode}<`));
  }
});

test("network, timeout and status failures never mark the value invalid", async (t) => {
  const Field = await loadField(t);
  for (const errorCode of ["network", "timeout", "providerStatus", "endpointNotFound"]) {
    const html = markup(Field, failed(errorCode));
    assert.doesNotMatch(html, /aria-invalid="/, errorCode);
    assert.match(html, new RegExp(`errors\\.${errorCode}<`));
  }
  const unverified = markup(Field, failed());
  assert.match(unverified, /role="alert">onboarding\.rehaul\.provider\.connectionFailed</);
});

test("Retry runs the check again, and the icon changes state in place", async (t) => {
  let root;
  t.after(() => root && React.act(async () => root.unmount())); // first: before globals go
  const Field = await loadField(t);
  const container = installInteractiveDom(t);
  root = createRoot(container);
  let retries = 0;
  const render = (check) =>
    React.act(async () =>
      root.render(
        React.createElement(Field, {
          label: LABEL,
          check: { failure: null, retry: () => (retries += 1), ...check },
          invalidOn: "credentialsRejected",
          value: "sk-test",
          readOnly: true,
        })
      )
    );
  const icon = () => findElement(container, (element) => element.tagName === "SVG");
  await render({ phase: "checking" });
  const first = icon();
  await render(failed("network"));
  assert.ok(icon() === first, "the same SVG moves from spinning to failed");
  assert.equal(first.getAttribute("data-state"), "failed");
  const retry = findElement(container, (element) => element.tagName === "BUTTON");
  await React.act(async () => retry.dispatchEvent({ type: "click", bubbles: true }));
  assert.equal(retries, 1);
  const input = findElement(container, (element) => element.tagName === "INPUT");
  assert.ok(container.ownerDocument.activeElement === input, "focus moves off Retry to the field");
});
