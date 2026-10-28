const test = require("node:test");
const assert = require("node:assert/strict");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

async function loadDialog(t) {
  t.after(() => {
    delete globalThis.__actionDialogProps;
  });
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-workspace-exit-dialog-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        export function useTranslation() {
          return { t: (key, params) => (params ? key + "|" + JSON.stringify(params) : key) };
        }
      `,
      // Captures what the exit dialog hands to the shared shell, so a test can
      // press its buttons, and renders the texts a user would read.
      "/WorkspaceActionDialog": `
        import React from "react";
        export function WorkspaceActionDialog(props) {
          globalThis.__actionDialogProps = props;
          return React.createElement(
            "div",
            { "data-icon": props.icon },
            React.createElement("h2", null, props.title),
            React.createElement("p", null, props.body),
            props.error ? React.createElement("p", { role: "alert" }, props.error) : null,
            React.createElement(
              "button",
              { id: "primary", disabled: props.busy || props.primary.disabled || undefined },
              props.primary.label
            ),
            props.cancelLabel && !props.busy
              ? React.createElement("button", { id: "cancel" }, props.cancelLabel)
              : null
          );
        }
      `,
    },
  });
  const { WorkspaceExitDialog } = await vite.ssrLoadModule(
    "/components/workspace/WorkspaceExitDialog.tsx"
  );
  const { CloudApiError } = await vite.ssrLoadModule("/services/cloudApi.ts");
  const events = [];
  const failures = [];
  const render = (state, overrides = {}) =>
    renderToStaticMarkup(
      createElement(WorkspaceExitDialog, {
        state,
        dispatch: (event) => {
          events.push(event.type);
          if (event.type === "failed") failures.push(event.reason);
        },
        onConfirmLeave: async () => {},
        onConfirmDelete: async () => {},
        onChooseWorkspace: () => {},
        ...overrides,
      })
    );
  return { render, events, failures, CloudApiError };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("closed renders nothing", async (t) => {
  const { render } = await loadDialog(t);

  assert.equal(render({ kind: "closed" }), "");
});

test("confirmLeave shows the leave copy with the workspace name", async (t) => {
  const { render } = await loadDialog(t);

  const markup = render({ kind: "confirmLeave", name: "Acme" });

  assert.match(markup, /workspaces\.exit\.leave\.title\|\{&quot;name&quot;:&quot;Acme&quot;\}/);
  assert.match(markup, /workspaces\.exit\.leave\.body/);
  assert.match(markup, /settingsPage\.workspace\.general\.leave</);
  assert.match(markup, /common\.cancel/);
  assert.equal(globalThis.__actionDialogProps.primary.tone, "destructive");
  assert.equal(globalThis.__actionDialogProps.icon, "info");
});

test("confirming dispatches confirm, runs the bound action, then succeeded", async (t) => {
  const { render, events } = await loadDialog(t);
  let ran = 0;

  render(
    { kind: "confirmLeave", name: "Acme" },
    {
      onConfirmLeave: async () => {
        ran++;
      },
    }
  );
  globalThis.__actionDialogProps.primary.onClick();
  await tick();

  assert.equal(ran, 1);
  assert.deepEqual(events, ["confirm", "succeeded"]);
});

test("a rejected action dispatches failed", async (t) => {
  const { render, events } = await loadDialog(t);

  render(
    { kind: "confirmDelete", name: "Acme" },
    {
      onConfirmDelete: async () => {
        throw new Error("offline");
      },
    }
  );
  globalThis.__actionDialogProps.primary.onClick();
  await tick();

  assert.deepEqual(events, ["confirm", "failed"]);
});

test("a failure carries the server's refusal, and only a refusal", async (t) => {
  const { render, failures, CloudApiError } = await loadDialog(t);
  const failWith = async (error) => {
    render(
      { kind: "confirmLeave", name: "Acme" },
      {
        onConfirmLeave: async () => {
          throw error;
        },
      }
    );
    globalThis.__actionDialogProps.primary.onClick();
    await tick();
  };

  await failWith(new CloudApiError("Workspace owners cannot leave", 400));
  await failWith(new CloudApiError("Cloud API request failed", 0));
  await failWith(new CloudApiError("Bad gateway", 502));
  await failWith(new CloudApiError("Session expired", 401));
  await failWith(new CloudApiError("API error: 404", 404));
  await failWith(new Error("offline"));

  assert.deepEqual(failures, ["Workspace owners cannot leave", null, null, null, null, null]);
});

test("a refusal replaces the check-your-connection copy", async (t) => {
  const { render } = await loadDialog(t);

  const leave = render({ kind: "leaveFailed", name: "Acme", reason: "Owners can't leave" });
  assert.match(leave, /role="alert"[^>]*>Owners can&#x27;t leave</);
  assert.doesNotMatch(leave, /workspaces\.exit\.leave\.failed/);

  const remove = render({ kind: "deleteFailed", name: "Acme", reason: "Not allowed" });
  assert.match(remove, /<p>Not allowed<\/p>/);
  assert.doesNotMatch(remove, /workspaces\.exit\.deleteFailed\.body/);
});

test("leaving is busy with the leaving label", async (t) => {
  const { render } = await loadDialog(t);

  const markup = render({ kind: "leaving", name: "Acme" });

  assert.match(markup, /settingsPage\.workspace\.general\.leaving/);
  assert.doesNotMatch(markup, /common\.cancel/);
  assert.equal(globalThis.__actionDialogProps.busy, true);
});

test("leaveFailed shows the error line with Try again and Cancel", async (t) => {
  const { render } = await loadDialog(t);

  const markup = render({ kind: "leaveFailed", name: "Acme", reason: null });

  assert.match(markup, /role="alert"[^>]*>workspaces\.exit\.leave\.failed\|/);
  assert.match(markup, /workspaces\.exit\.tryAgain/);
  assert.match(markup, /common\.cancel/);
});

test("confirmDelete uses the trash icon and the delete copy", async (t) => {
  const { render } = await loadDialog(t);

  const markup = render({ kind: "confirmDelete", name: "Acme" });

  assert.match(markup, /data-icon="trash"/);
  assert.match(markup, /workspaces\.exit\.delete\.title/);
  assert.match(markup, /workspaces\.exit\.delete\.body/);
  assert.match(markup, /settingsPage\.workspace\.general\.delete</);
});

test("deleting is busy: no Cancel, primary disabled", async (t) => {
  const { render } = await loadDialog(t);

  const markup = render({ kind: "deleting", name: "Acme" });

  assert.match(markup, /workspaces\.exit\.deleting\.title/);
  assert.match(markup, /settingsPage\.workspace\.general\.deleting/);
  assert.doesNotMatch(markup, /common\.cancel/);
  assert.match(
    markup,
    /<button[^>]*id="primary"[^>]*disabled=""|<button[^>]*disabled=""[^>]*id="primary"/
  );
});

test("deleteFailed offers Try again and Cancel", async (t) => {
  const { render } = await loadDialog(t);

  const markup = render({ kind: "deleteFailed", name: "Acme", reason: null });

  assert.match(markup, /workspaces\.exit\.deleteFailed\.title/);
  assert.match(markup, /workspaces\.exit\.deleteFailed\.body\|/);
  assert.match(markup, /workspaces\.exit\.tryAgain/);
  assert.match(markup, /common\.cancel/);
});

test("left offers only Choose workspace, then dismisses", async (t) => {
  const { render, events } = await loadDialog(t);
  const order = [];

  const markup = render(
    { kind: "left", name: "Acme" },
    {
      dispatch: (event) => order.push(event.type),
      onChooseWorkspace: () => order.push("choose"),
    }
  );

  assert.match(markup, /workspaces\.exit\.left\.title/);
  assert.match(markup, /workspaces\.exit\.chooseAnother/);
  assert.match(markup, /workspaces\.exit\.chooseWorkspace/);
  assert.doesNotMatch(markup, /common\.cancel/);
  assert.deepEqual(events, []);

  globalThis.__actionDialogProps.primary.onClick();
  assert.deepEqual(order, ["choose", "dismiss"]);

  // Esc does what the primary does.
  order.length = 0;
  globalThis.__actionDialogProps.onDismiss();
  assert.deepEqual(order, ["choose", "dismiss"]);
});

test("deleted names the deleted workspace and offers Choose workspace", async (t) => {
  const { render } = await loadDialog(t);

  const markup = render({ kind: "deleted", name: "Acme" });

  assert.match(markup, /workspaces\.exit\.deleted\.title\|/);
  assert.match(markup, /workspaces\.exit\.chooseWorkspace/);
  assert.doesNotMatch(markup, /common\.cancel/);
});
