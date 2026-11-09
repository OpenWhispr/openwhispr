const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function renderCard(t, props) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-toast-card-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        const t = (key) => key;
        export function useTranslation() { return { t }; }
        export const initReactI18next = { type: "3rdParty", init() {} };
      `,
    },
  });
  const { ToastCard } = await vite.ssrLoadModule("/components/ui/ToastCard.tsx");
  return renderToStaticMarkup(
    React.createElement(ToastCard, { title: "Saved", actions: [], onAction() {}, ...props })
  );
}

test("a success or error toast carries its status icon in that colour", async (t) => {
  assert.match(await renderCard(t, { tone: "success" }), /text-success/);
  assert.match(await renderCard(t, { tone: "error" }), /text-destructive/);
});

test("a toast that is neither success nor failure has no status icon", async (t) => {
  assert.doesNotMatch(await renderCard(t, {}), /text-success|text-destructive|<svg/);
});

test("the close button shows on hover or keyboard focus, and only with a way to dismiss", async (t) => {
  const html = await renderCard(t, { onDismiss() {} });
  const button = html.match(/<button[^>]*aria-label="common\.close"[^>]*>/)?.[0] ?? "";
  assert.match(button, /\bopacity-0\b/);
  assert.match(button, /group-hover:opacity-100/);
  assert.match(button, /focus-visible:opacity-100/);
  assert.doesNotMatch(await renderCard(t, {}), /common\.close/);
});

test("the timer stays on the straight top edge, inset by the corner radius", async (t) => {
  const html = await renderCard(t, { progressDuration: 5000 });
  assert.match(html, /absolute inset-x-4 top-0/);
  assert.match(html, /toast-progress 5000ms/);
  assert.doesNotMatch(html, /<svg|<path/);
});

test("a single action wraps under the text instead of squeezing it", async (t) => {
  const action = { label: "Open Settings", onClick() {} };
  const html = await renderCard(t, { actions: [action] });
  assert.match(html, /flex flex-wrap items-center justify-end/);
  assert.match(html, /grow basis-64/);
});
