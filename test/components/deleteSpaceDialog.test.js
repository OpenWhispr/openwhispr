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

// Mounts the dialog with the real Radix dialog in happy-dom, over a fake delete the tests steer.

let DeleteSpaceDialog;
let createRoot;
let happyWindow;
let vite;
let ui;

test.before(async (t) => {
  ({ happyWindow, createRoot } = await installHappyDom());
  ui = interactions(happyWindow);
  vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-delete-space-dialog-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": ENGLISH_I18N_MOCK,
      // The API client reads the language from here, and the real one starts i18next.
      "/i18n": "export default { t: (key) => key, language: 'en' };",
      "/ui/useToast":
        "export const useToast = () => ({ toast: (toast) => `toast-${globalThis.__toasts.push(toast)}`, dismiss: (id) => globalThis.__dismissed.push(id) });",
      "/services/spaceActions":
        "export const deleteSpace = (...args) => globalThis.__deleteSpace(...args); export const restoreSpace = (...args) => globalThis.__restoreSpace(...args);",
    },
  });
  ({ default: DeleteSpaceDialog } = await vite.ssrLoadModule(
    "/components/notes/DeleteSpaceDialog.tsx"
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
const nameField = () => dialog()?.querySelector("input") ?? null;
const toasts = () => globalThis.__toasts;
const toastTitles = () => toasts().map((toast) => readable(toast.title));

const CLOUD_SPACE = {
  id: 7,
  client_space_id: "client-7",
  cloud_space_id: "cloud-1",
  workspace_id: "w1",
  kind: "team",
  name: "Customer Calls",
  emoji: "📞",
  my_role: "admin",
  teams: [],
};
const LOCAL_SPACE = { ...CLOUD_SPACE, id: 8, cloud_space_id: null, workspace_id: null };

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function mount(
  t,
  {
    space = CLOUD_SPACE,
    deleteSpace = async () => ({ success: true }),
    restoreSpace = async () => {},
  } = {}
) {
  const calls = [];
  const events = [];
  globalThis.__toasts = [];
  globalThis.__dismissed = [];
  globalThis.__restoreSpace = async (cloudSpaceId) => {
    calls.push(["restoreSpace", cloudSpaceId]);
    return restoreSpace(cloudSpaceId);
  };
  globalThis.__deleteSpace = async (target) => {
    calls.push(["deleteSpace", target]);
    return deleteSpace(target);
  };
  function Host() {
    const [target, setTarget] = React.useState(space);
    return h(DeleteSpaceDialog, {
      space: target,
      onClose: () => {
        events.push(["close"]);
        setTarget(null);
      },
      onDeleted: () => events.push(["deleted"]),
    });
  }
  const container = doc().createElement("div");
  doc().body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => {
    await React.act(async () => root.unmount());
    container.remove();
    for (const name of ["__toasts", "__dismissed", "__deleteSpace", "__restoreSpace"]) {
      delete globalThis[name];
    }
  });
  await React.act(async () => {
    root.render(h(Host));
  });
  await ui.settle();
  return { calls, events };
}

test("deleting a cloud teamspace has no type-the-name, and blocks Esc while running", async (t) => {
  const answer = deferred();
  const { calls, events } = await mount(t, { deleteSpace: () => answer.promise });

  assert.equal(heading(), "Delete Customer Calls?");
  assert.equal(body(), "This removes Customer Calls from the workspace for everyone.");
  assert.equal(nameField(), null, "a plain confirm: nothing to type");
  assert.deepEqual(buttons().map(text), ["Delete teamspace", "Cancel"]);

  await ui.click(buttonNamed("Delete teamspace"));

  assert.deepEqual(calls, [["deleteSpace", CLOUD_SPACE]]);
  assert.equal(heading(), "Deleting Customer Calls…");
  assert.equal(body(), "Keep this window open while the teamspace is deleted.");
  assert.deepEqual(buttons().map(text), ["Deleting…"], "no Cancel while the request runs");
  assert.equal(buttons()[0].disabled, true);

  await ui.press(doc().activeElement ?? dialog(), "Escape");
  assert.ok(dialog(), "Escape doesn't close a running delete");
  assert.deepEqual(events, []);
  assert.deepEqual(toasts(), []);

  answer.resolve({ success: true });
  await ui.settle();

  assert.deepEqual(toastTitles(), ["Customer Calls was deleted."]);
  assert.deepEqual(events, [["deleted"], ["close"]]);
  assert.equal(dialog(), null);
});

async function deleteAndGetUndo(t, options) {
  const mounted = await mount(t, options);
  await ui.click(buttonNamed("Delete teamspace"));
  await ui.settle();
  const [deleted] = toasts();
  return { ...mounted, deleted, undo: deleted.actions[0] };
}

test("the delete toast offers Undo for ten seconds and stays up while it runs", async (t) => {
  const { deleted, undo } = await deleteAndGetUndo(t);

  assert.equal(deleted.duration, 10_000);
  assert.equal(undo.label, "Undo");
  assert.equal(undo.dismissOnClick, false, "a failed restore keeps it up for another try");
});

test("Undo restores the teamspace and says so", async (t) => {
  const { calls, undo } = await deleteAndGetUndo(t);

  await undo.onClick();

  assert.deepEqual(calls.at(-1), ["restoreSpace", "cloud-1"]);
  assert.deepEqual(globalThis.__dismissed, ["toast-1"]);
  assert.equal(readable(toasts()[1].title), "Customer Calls restored");
});

test("a failed Undo keeps the toast up and says so", async (t) => {
  const { undo } = await deleteAndGetUndo(t, {
    restoreSpace: async () => {
      throw new Error("offline");
    },
  });

  await undo.onClick();

  assert.deepEqual(globalThis.__dismissed, []);
  assert.equal(readable(toasts()[1].title), "Couldn't restore Customer Calls. Try again.");
  assert.equal(toasts()[1].variant, "destructive");
});

test("Undo into a taken name says why", async (t) => {
  const { CloudApiError } = await vite.ssrLoadModule("/services/cloudApi.ts");
  const { undo } = await deleteAndGetUndo(t, {
    restoreSpace: async () => {
      throw new CloudApiError(
        "A teamspace called Customer Calls already exists",
        409,
        "space_name_taken"
      );
    },
  });

  await undo.onClick();

  assert.deepEqual(globalThis.__dismissed, []);
  assert.equal(
    readable(toasts()[1].title),
    "Couldn't restore Customer Calls. Another teamspace has that name."
  );
});

test("pressing Undo twice restores once", async (t) => {
  const answer = deferred();
  const { calls, undo } = await deleteAndGetUndo(t, { restoreSpace: () => answer.promise });

  const first = undo.onClick();
  await undo.onClick();
  answer.resolve();
  await first;

  assert.equal(calls.filter((call) => call[0] === "restoreSpace").length, 1);
  assert.equal(toasts().length, 2, "one delete toast, one restored toast");
});

test("a failed delete offers Try again and keeps the teamspace", async (t) => {
  const answers = [
    { success: false, error: "offline", failure: { kind: "failed" } },
    { success: true },
  ];
  const { calls, events } = await mount(t, { deleteSpace: async () => answers.shift() });

  await ui.click(buttonNamed("Delete teamspace"));
  await ui.settle();

  assert.equal(heading(), "Couldn't delete Customer Calls");
  assert.equal(body(), "The teamspace is still available. Check your connection and try again.");
  assert.deepEqual(buttons().map(text), ["Try again", "Cancel"]);
  assert.deepEqual(toasts(), []);
  assert.deepEqual(events, [], "nothing closed, nothing reported as deleted");

  await ui.click(buttonNamed("Try again"));
  await ui.settle();

  assert.equal(calls.length, 2);
  assert.deepEqual(toastTitles(), ["Customer Calls was deleted."]);
  assert.deepEqual(events, [["deleted"], ["close"]]);
});

test("a delete that throws reads as a failure, not a hang", async (t) => {
  const { events } = await mount(t, {
    deleteSpace: async () => {
      throw new Error("database unavailable");
    },
  });

  await ui.click(buttonNamed("Delete teamspace"));
  await ui.settle();

  assert.equal(heading(), "Couldn't delete Customer Calls");
  assert.deepEqual(events, []);
});

test("a refusal that carries a reason shows it under the failure", async (t) => {
  await mount(t, {
    deleteSpace: async () => ({
      success: false,
      error: "The default teamspace can't be deleted",
      failure: { kind: "refused", message: "The default teamspace can't be deleted" },
    }),
  });

  await ui.click(buttonNamed("Delete teamspace"));
  await ui.settle();

  assert.equal(
    text(dialog().querySelector('[role="alert"]')),
    "The default teamspace can't be deleted"
  );
});

test("Cancel closes the confirm and deletes nothing", async (t) => {
  const { calls, events } = await mount(t);

  await ui.click(buttonNamed("Cancel"));

  assert.deepEqual(events, [["close"]]);
  assert.equal(calls.length, 0);
  assert.equal(dialog(), null);
});

test("a local teamspace still asks for the name", async (t) => {
  const { calls, events } = await mount(t, { space: LOCAL_SPACE });

  assert.equal(heading(), "Delete space?");
  assert.match(body(), /permanently deletes Customer Calls with all of its folders and notes/i);
  const confirm = buttonNamed("Delete space");
  assert.equal(confirm.disabled, true, "disabled until the name is typed");
  assert.ok(nameField(), "the name is asked for");

  await ui.type(nameField(), "Customer");
  assert.equal(buttonNamed("Delete space").disabled, true);
  await ui.type(nameField(), "Customer Calls");
  assert.equal(buttonNamed("Delete space").disabled, false);

  await ui.click(buttonNamed("Delete space"));
  await ui.settle();

  assert.deepEqual(calls, [["deleteSpace", LOCAL_SPACE]]);
  // The local flow closes first and reports through a toast, as it always did.
  assert.ok(events.length > 0 && events.every(([name]) => name === "close"));
  assert.deepEqual(toastTitles(), ["Deleted Customer Calls"]);
});
