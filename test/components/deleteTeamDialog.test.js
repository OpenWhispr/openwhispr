const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer } = require("../lib/rendererTestHarness");
const {
  ENGLISH_I18N_MOCK,
  installHappyDom,
  interactions,
  readable,
  text,
} = require("../lib/happyDomDialog");

// Mounts the dialog with the real Radix dialog in happy-dom, over a fake held delete the tests steer.

let DeleteTeamDialog;
let createRoot;
let happyWindow;
let vite;
let ui;

test.before(async (t) => {
  ({ happyWindow, createRoot } = await installHappyDom());
  ui = interactions(happyWindow);
  vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-delete-team-dialog-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": ENGLISH_I18N_MOCK,
      "/i18n": "export default { t: (key) => key, language: 'en' };",
      "/ui/useToast":
        "export const useToast = () => ({ toast: (toast) => `toast-${globalThis.__toasts.push(toast)}`, dismiss: (id) => globalThis.__dismissed.push(id) });",
      "/services/spaceActions":
        "export const holdTeamDelete = (...args) => globalThis.__holdTeamDelete(...args);",
    },
  });
  ({ default: DeleteTeamDialog } = await vite.ssrLoadModule(
    "/components/settings/DeleteTeamDialog.tsx"
  ));
});

test.after(async () => {
  await happyWindow.happyDOM.close();
});

const h = React.createElement;
const doc = () => happyWindow.document;
const dialog = () => [...doc().querySelectorAll('[role="dialog"]')].at(-1) ?? null;
const buttons = () => [...(dialog()?.querySelectorAll("button") ?? [])];
const buttonNamed = (label) => buttons().find((button) => text(button) === label);
const heading = () => dialog() && text(dialog().querySelector("h2"));
const body = () => dialog() && text(dialog().querySelector("p"));
const toasts = () => globalThis.__toasts;
const toastTitles = () => toasts().map((toast) => readable(toast.title));

const TEAM = {
  id: "t1",
  workspace_id: "w1",
  name: "Sales",
  slug: "sales",
  description: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

async function mount(
  t,
  { commit = async () => ({ success: true }), undo = async () => true, again = null } = {}
) {
  const calls = [];
  const events = [];
  globalThis.__toasts = [];
  globalThis.__dismissed = [];
  globalThis.__holdTeamDelete = (target) => {
    calls.push(["hold", target]);
    return {
      undo: async () => {
        calls.push(["undo"]);
        return undo();
      },
      commit: async () => {
        calls.push(["commit"]);
        return commit();
      },
      again: () => (again ? again() : globalThis.__holdTeamDelete(target)),
    };
  };
  function Host() {
    const [target, setTarget] = React.useState(TEAM);
    return target
      ? h(DeleteTeamDialog, {
          team: target,
          onClose: () => {
            events.push(["close"]);
            setTarget(null);
          },
          onDeleted: () => events.push(["deleted"]),
        })
      : null;
  }
  const container = doc().createElement("div");
  doc().body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => {
    await React.act(async () => root.unmount());
    container.remove();
    for (const name of ["__toasts", "__dismissed", "__holdTeamDelete"]) delete globalThis[name];
  });
  await React.act(async () => {
    root.render(h(Host));
  });
  await ui.settle();
  return { calls, events };
}

async function confirmDelete(t, options) {
  const mounted = await mount(t, options);
  await ui.click(buttonNamed("Delete team"));
  return { ...mounted, deleted: toasts()[0], undo: toasts()[0]?.actions[0] };
}

test("confirm hides the row and sends nothing", async (t) => {
  const { calls, events } = await mount(t);

  assert.equal(heading(), "Delete Sales?");
  assert.equal(
    body(),
    "The team will be removed for everyone. Access granted through Sales will end. People, teamspaces, and notes won't be deleted."
  );
  assert.deepEqual(buttons().map(text), ["Delete team", "Cancel"]);

  await ui.click(buttonNamed("Delete team"));

  assert.deepEqual(calls, [["hold", TEAM]], "held, not committed");
  assert.deepEqual(events, [["deleted"], ["close"]]);
  assert.equal(dialog(), null);
  assert.deepEqual(toastTitles(), [
    "Sales was deleted. Its people and teamspaces are still available.",
  ]);
  assert.equal(toasts()[0].duration, 10_000, "the same window as a teamspace delete");
  assert.equal(toasts()[0].actions[0].label, "Undo");
});

test("Cancel closes without holding anything", async (t) => {
  const { calls, events } = await mount(t);

  await ui.click(buttonNamed("Cancel"));

  assert.deepEqual(calls, []);
  assert.deepEqual(events, [["close"]]);
});

test("Undo sends nothing", async (t) => {
  const { calls, deleted, undo } = await confirmDelete(t);

  await undo.onClick();
  // The real hold does nothing for a commit after an undo; the toast still settles.
  deleted.onSettled();
  await ui.settle();

  assert.deepEqual(calls.slice(1, 2), [["undo"]]);
  assert.deepEqual(globalThis.__dismissed, ["toast-1"]);
  assert.equal(undo.dismissOnClick, false, "dismissing first would let the delete go ahead");
});

test("the window ending sends the delete once", async (t) => {
  const { calls, deleted } = await confirmDelete(t);

  deleted.onSettled();
  await ui.settle();

  assert.deepEqual(
    calls.filter(([name]) => name === "commit"),
    [["commit"]]
  );
  assert.equal(toasts().length, 1, "success says nothing more");
});

test("a failure brings the row back and offers Try again", async (t) => {
  let answer = { success: false, failure: { kind: "failed" } };
  const { calls, deleted } = await confirmDelete(t, { commit: async () => answer });

  deleted.onSettled();
  await ui.settle();

  const failed = toasts()[1];
  assert.equal(readable(failed.title), "Couldn't delete Sales");
  assert.equal(
    readable(failed.description),
    "The team and its access settings are unchanged. Check your connection and try again."
  );
  assert.equal(failed.variant, "destructive");
  assert.equal(failed.actions[0].label, "Try again");

  answer = { success: true };
  const before = calls.length;
  await failed.actions[0].onClick();
  await ui.settle();
  assert.deepEqual(calls.slice(before), [["hold", TEAM], ["commit"]]);
  assert.equal(toasts().length, 2);
});

test("a refusal offers no retry", async (t) => {
  const { deleted } = await confirmDelete(t, {
    commit: async () => ({ success: false, failure: { kind: "notAllowed" } }),
  });

  deleted.onSettled();
  await ui.settle();

  assert.equal(toasts()[1].actions, undefined);
});
