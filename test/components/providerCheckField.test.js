const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");
const { installInteractiveDom, findElement } = require("../lib/interactiveDom");

const LABEL = "onboarding.rehaul.provider.apiKey";

async function loadField(t) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-provider-check-field-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        const t = (key, options) => (options?.reason ? key + "(" + options.reason + ")" : key);
        export function useTranslation() { return { t }; }
      `,
    },
  });
  const module = await vite.ssrLoadModule("/components/ui/ProviderCheckField.tsx");
  return module.ProviderCheckField;
}

const markup = (Field, check, extra = {}) =>
  renderToStaticMarkup(
    React.createElement(Field, {
      label: LABEL,
      check: { failure: null, retry() {}, ...check },
      invalidOn: "credentialsRejected",
      type: "password",
      value: "sk-test",
      readOnly: true,
      ...extra,
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
    const html = markup(Field, failed(errorCode), { invalidOn: errorCode });
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
    const html = markup(Field, failed(errorCode), { invalidOn });
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

const SAVED_KEY = "sk-proj-abcd1234wxyz";
const SAVED_KEY_ENDS = /<span aria-hidden="true" class="pointer-events-none[^"]*">sk-\.\.\.wxyz</;
const LOOK = ["onboarding-provider-input", "h-9", "rounded-xl!", "text-xs", "shadow-none!"];
const CAPTION = /^<div><label class="block"><span class="mb-1\.5 block text-xs[^"]*">/;
const source = (relativePath) =>
  fs.readFileSync(path.join(__dirname, "../..", relativePath), "utf8");
const inputTag = (html) => html.match(/<input[^>]*>/)[0];

function findAll(node, predicate, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found);
  } else if (node && typeof node === "object") {
    if (predicate(node)) found.push(node);
    findAll(node.props?.children, predicate, found);
  }
  return found;
}

// Runs the field's own hooks with its children unmounted, as the step harness does: the
// element tree is the test boundary.
async function mountField(t, props) {
  let root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  }); // first: before globals go
  const Field = await loadField(t);
  const container = installHookDom(t);
  let tree;
  function Harness() {
    tree = Field(props);
    return null;
  }
  root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  const find = (predicate) => findAll(tree, predicate);
  const input = () => find((node) => typeof node.props?.onBlur === "function")[0];
  return {
    input,
    mask: () => find((node) => node.type === "span" && node.props["aria-hidden"] === "true")[0],
    focus: (element) => React.act(async () => input().props.onFocus({ currentTarget: element })),
    blur: (element) => React.act(async () => input().props.onBlur({ currentTarget: element })),
  };
}

test("the field brings its look, falling back to the app theme outside onboarding", async (t) => {
  const Field = await loadField(t);
  const props = { "aria-label": "common.apiKey", value: "", readOnly: true };
  const input = inputTag(renderToStaticMarkup(React.createElement(Field, props)));
  for (const name of LOOK) {
    assert.match(input, new RegExp(`[" ]${name}[" ]`), name);
  }
  const css = source("src/index.css");
  const rule = css.slice(
    css.indexOf(".onboarding-provider-input,"),
    css.indexOf(".onboarding-provider-icon-monochrome")
  );
  for (const [token, fallback] of [
    ["--onboarding-control-border", "--color-border"],
    ["--onboarding-surface-secondary", "--color-muted"],
    ["--onboarding-text-primary", "--color-foreground"],
    ["--onboarding-text-secondary", "--color-muted-foreground"],
  ]) {
    assert.match(rule, new RegExp(`var\\(${token}, var\\(${fallback}\\)\\)`), token);
  }
  const field = source("src/components/ui/ProviderCheckField.tsx");
  assert.match(field, /var\(--onboarding-accent,var\(--color-primary\)\)/);
  assert.match(field, /var\(--onboarding-text-primary,var\(--color-foreground\)\)/);
});

test("Settings names a field from its heading; onboarding keeps its caption", async (t) => {
  const Field = await loadField(t);
  const settings = renderToStaticMarkup(
    React.createElement(Field, { "aria-label": "common.apiKey", value: "", readOnly: true })
  );
  assert.doesNotMatch(settings, /<label/);
  assert.match(inputTag(settings), /aria-label="common\.apiKey"/);
  const onboarding = renderToStaticMarkup(
    React.createElement(Field, { label: LABEL, value: "", readOnly: true })
  );
  assert.match(onboarding, CAPTION);
  assert.match(onboarding, />onboarding\.rehaul\.provider\.apiKey<\/span>/);
});

test("a field without a check is the field alone", async (t) => {
  const Field = await loadField(t);
  const html = renderToStaticMarkup(
    React.createElement(Field, { "aria-label": "Client ID", value: "corti-id", readOnly: true })
  );
  assert.doesNotMatch(html, /<svg|role="alert"|aria-describedby|\bpe-9\b/);
});

test("a saved secret shows its first three and last four characters until focused", async (t) => {
  const Field = await loadField(t);
  const render = (props) =>
    renderToStaticMarkup(
      React.createElement(Field, { "aria-label": "common.apiKey", readOnly: true, ...props })
    );
  const saved = render({ type: "password", value: SAVED_KEY });
  assert.match(saved, SAVED_KEY_ENDS);
  assert.match(inputTag(saved), /text-transparent!/);
  assert.match(render({ type: "password", value: "sk-short" }), />••••••••</);
  for (const props of [
    { type: "password", value: "" },
    { type: "text", value: SAVED_KEY },
  ]) {
    const html = render(props);
    assert.doesNotMatch(html, /aria-hidden="true"/, JSON.stringify(props));
    assert.doesNotMatch(html, /text-transparent!/);
  }
});

test("focusing a saved secret selects all of it, so a paste replaces it", async (t) => {
  const field = await mountField(t, {
    "aria-label": "common.apiKey",
    type: "password",
    value: SAVED_KEY,
    readOnly: true,
  });
  assert.ok(field.mask());
  let selects = 0;
  const element = { select: () => (selects += 1), contains: (node) => node === element };
  element.ownerDocument = { activeElement: element };
  await field.focus(element);
  assert.equal(selects, 1);
  assert.equal(field.mask(), undefined);
  assert.doesNotMatch(field.input().props.className, /text-transparent!/);
  await field.blur(element); // the window lost focus; the field is still the page's focus
  assert.equal(field.mask(), undefined, "switching apps keeps the field open");
  await field.focus(element);
  assert.equal(selects, 1, "coming back keeps the caret where it was");
  element.ownerDocument = { activeElement: null };
  await field.blur(element);
  assert.ok(field.mask(), "leaving the field shows the ends again");
});

test("the caller's own focus handlers still run", async (t) => {
  const calls = [];
  const field = await mountField(t, {
    label: "onboarding.rehaul.provider.endpointUrl",
    value: "http://127.0.0.1:8791/v1",
    onFocus: () => calls.push("focus"),
    onBlur: () => calls.push("blur"),
  });
  const element = { select() {}, contains: (node) => node === element };
  element.ownerDocument = { activeElement: null };
  await field.focus(element);
  await field.blur(element);
  assert.deepEqual(calls, ["focus", "blur"]);
});

test("a reason override replaces the default text and leaves the field valid", async (t) => {
  const Field = await loadField(t);
  const html = markup(Field, failed("credentialsRejected"), {
    failureReason: "reasoning.custom.endpointUnauthorized",
  });
  assert.match(html, /role="alert">reasoning\.custom\.endpointUnauthorized</);
  assert.doesNotMatch(html, /aria-invalid="/, "the value is not what is wrong");
  const plain = markup(Field, failed("credentialsRejected"));
  assert.match(plain, /aria-invalid="true"/, "without an override, a rejection marks it");
});

test("no verdict shows its reason in amber with Retry, and the value stays valid", async (t) => {
  const Field = await loadField(t);
  for (const errorCode of ["timeout", "network", "providerStatus"]) {
    const html = markup(Field, {
      phase: "unverified",
      failure: { success: false, errorCode, status: 503, unverified: true },
    });
    assert.match(html, /data-state="unverified"/, errorCode);
    assert.doesNotMatch(html, /aria-invalid="/, errorCode);
    assert.match(
      html,
      /<p class="mt-1 px-1 text-xs leading-\[1\.4\] text-amber-700 dark:text-amber-300">/,
      errorCode
    );
    const reason = `role="alert">onboarding\\.rehaul\\.provider\\.unverified\\(onboarding\\.rehaul\\.provider\\.errors\\.${errorCode}\\)<`;
    assert.match(html, new RegExp(reason), errorCode);
    assert.match(html, /<button type="button"[^>]*>common\.retry<\/button>/, errorCode);
  }
  assert.match(
    markup(Field, failed("credentialsRejected")),
    /<p class="mt-1 px-1 text-xs leading-\[1\.4\] text-destructive">/
  );
});
