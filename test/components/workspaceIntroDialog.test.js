const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function loadIntro(t) {
  t.after(() => {
    delete globalThis.__onOpenChange;
  });
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-workspace-intro-dialog-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        export function useTranslation() {
          return { t: (key, params) => (params ? key + "|" + JSON.stringify(params) : key) };
        }
      `,
      // Renders the dialog open and hands the test its dismissal callback.
      "/ui/dialog": `
        import React from "react";
        export const Dialog = ({ open, children, onOpenChange }) => {
          globalThis.__onOpenChange = onOpenChange;
          return open ? React.createElement("div", null, children) : null;
        };
        export const DialogContent = ({ children }) => React.createElement("div", null, children);
        export const DialogTitle = ({ children }) => React.createElement("h2", null, children);
        export const DialogDescription = ({ children }) => React.createElement("p", null, children);
      `,
    },
  });
  const mod = await vite.ssrLoadModule("/components/workspace/WorkspaceIntroDialog.tsx");
  const renderDialog = (props = {}) =>
    renderToStaticMarkup(
      createElement(mod.WorkspaceIntroDialog, {
        open: true,
        workspaceId: "acme",
        workspaceName: "Acme Studio",
        onFinish: () => {},
        ...props,
      })
    );
  const renderCard = (props = {}) =>
    renderToStaticMarkup(
      createElement(mod.WorkspaceIntroCard, {
        step: 0,
        workspaceName: "Acme Studio",
        onNext: () => {},
        onFinish: () => {},
        ...props,
      })
    );
  return { mod, renderDialog, renderCard };
}

const progressBars = (markup) => (markup.match(/data-intro-progress="/g) ?? []).length;

test("step 1 shows Skip and Next with three progress bars", async (t) => {
  const { renderDialog } = await loadIntro(t);

  const markup = renderDialog();

  assert.match(markup, /workspaces\.intro\.workspace\.title/);
  assert.match(markup, /workspaces\.intro\.workspace\.body/);
  assert.match(markup, /common\.skip/);
  assert.match(markup, /common\.next/);
  assert.doesNotMatch(markup, /workspaces\.intro\.getStarted/);
  assert.equal(progressBars(markup), 3);
  assert.equal((markup.match(/data-intro-progress="active"/g) ?? []).length, 1);
  assert.match(
    markup,
    /aria-label="workspaces\.intro\.progress\|\{&quot;current&quot;:1,&quot;total&quot;:3\}"/
  );
});

test("last step shows Get started and no Skip", async (t) => {
  const { renderCard } = await loadIntro(t);

  const markup = renderCard({ step: 2 });

  assert.match(markup, /workspaces\.intro\.teams\.title/);
  assert.match(markup, /workspaces\.intro\.getStarted/);
  assert.doesNotMatch(markup, /common\.skip/);
  assert.doesNotMatch(markup, /common\.next/);
  assert.equal(progressBars(markup), 3);
});

test("the mock switcher shows the real workspace name", async (t) => {
  const { renderDialog } = await loadIntro(t);

  const markup = renderDialog({ workspaceName: "Globex Research" });

  assert.match(markup, /Globex Research/);
  assert.match(markup, /notes\.spaces\.personal/);
  assert.match(markup, /workspaces\.switcher\.add/);
  // The mock is decoration; screen readers get the title and body only.
  assert.match(markup, /aria-hidden="true"[^>]*>(?:(?!<\/div>).)*Globex Research/s);
});

test("illustrations are decorative and sized for their slot", async (t) => {
  const { mod, renderCard } = await loadIntro(t);

  assert.deepEqual(
    mod.WORKSPACE_INTRO_STEPS.map((step) => step.id),
    ["workspace", "teamspaces", "teams"]
  );
  for (const step of [0, 1, 2]) {
    const img = renderCard({ step }).match(/<img[^>]*>/)?.[0] ?? "";
    assert.match(img, /alt=""/);
    assert.match(img, /aria-hidden="true"/);
    assert.match(img, /width="500"/);
    assert.match(img, /height="320"/);
  }
});

test("dismissing the dialog finishes the intro for its workspace", async (t) => {
  const { renderDialog } = await loadIntro(t);
  const finished = [];

  renderDialog({ onFinish: (workspaceId) => finished.push(workspaceId) });
  globalThis.__onOpenChange(false);

  assert.deepEqual(finished, ["acme"]);
  assert.equal(renderDialog({ open: false }), "");
});

test("Next and Get started take the first focus, not Skip", async (t) => {
  const { renderCard } = await loadIntro(t);
  const focused = (markup) => markup.match(/<button[^>]*autofocus=""[^>]*>([^<]*)/g) ?? [];

  const first = focused(renderCard({ step: 0 }));
  assert.equal(first.length, 1);
  assert.match(first[0], /common\.next/);
  assert.match(focused(renderCard({ step: 2 }))[0], /workspaces\.intro\.getStarted/);
});
