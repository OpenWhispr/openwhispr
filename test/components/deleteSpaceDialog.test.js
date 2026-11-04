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
        "export const deleteSpace = (...args) => globalThis.__deleteSpace(...args); export const holdSpaceDelete = (...args) => globalThis.__holdSpaceDelete(...args);",
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

async function mount(
  t,
  {
    space = CLOUD_SPACE,
    deleteSpace = async () => ({ success: true }),
    commit = async () => ({ success: true }),
    undo = async () => true,
    again = null,
  } = {}
) {
  const calls = [];
  const events = [];
  globalThis.__toasts = [];
  globalThis.__dismissed = [];
  globalThis.__holdSpaceDelete = (target) => {
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
      again: () => (again ? again() : globalThis.__holdSpaceDelete(target)),
    };
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
    for (const name of ["__toasts", "__dismissed", "__deleteSpace", "__holdSpaceDelete"]) {
      delete globalThis[name];
    }
  });
  await React.act(async () => {
    root.render(h(Host));
  });
  await ui.settle();
  return { calls, events };
}

test("confirming a cloud teamspace holds the delete: nothing goes out yet", async (t) => {
  const { calls, events } = await mount(t);

  assert.equal(heading(), "Delete Customer Calls?");
  assert.equal(body(), "This removes Customer Calls from the workspace for everyone.");
  assert.equal(nameField(), null, "a plain confirm: nothing to type");
  assert.deepEqual(buttons().map(text), ["Delete teamspace", "Cancel"]);

  await ui.click(buttonNamed("Delete teamspace"));

  assert.deepEqual(calls, [["hold", CLOUD_SPACE]]);
  assert.deepEqual(events, [["deleted"], ["close"]]);
  assert.equal(dialog(), null);
});

async function confirmDelete(t, options) {
  const mounted = await mount(t, options);
  await ui.click(buttonNamed("Delete teamspace"));
  return { ...mounted, deleted: toasts()[0], undo: toasts()[0].actions[0] };
}

test("the delete toast offers Undo for ten seconds", async (t) => {
  const { deleted, undo } = await confirmDelete(t);

  assert.deepEqual(toastTitles(), ["Customer Calls was deleted."]);
  assert.equal(deleted.duration, 10_000);
  assert.equal(undo.label, "Undo");
  assert.equal(undo.dismissOnClick, false, "dismissing first would let the delete go ahead");
});

test("Undo brings the teamspace back and says so, and sends nothing", async (t) => {
  const { calls, deleted, undo } = await confirmDelete(t);

  await undo.onClick();
  // The real hold does nothing for a commit after an undo; the toast still settles.
  deleted.onSettled();

  assert.deepEqual(calls.slice(1, 2), [["undo"]]);
  assert.deepEqual(globalThis.__dismissed, ["toast-1"]);
  assert.deepEqual(toastTitles(), ["Customer Calls was deleted.", "Customer Calls restored"]);
});

test("Undo that found nothing to bring back claims nothing", async (t) => {
  const { undo } = await confirmDelete(t, { undo: async () => false });

  await undo.onClick();

  assert.deepEqual(globalThis.__dismissed, ["toast-1"]);
  assert.deepEqual(toastTitles(), ["Customer Calls was deleted."]);
});

test("after the delete, it says how many unsynced notes moved to Personal", async (t) => {
  const { deleted } = await confirmDelete(t, {
    commit: async () => ({ success: true, relocatedCount: 2 }),
  });

  deleted.onSettled();
  await ui.settle();

  assert.equal(
    toastTitles().at(-1),
    "2 notes that hadn't synced were moved to your Personal space."
  );
});

test("Try again after another account signed in does nothing", async (t) => {
  const { calls, deleted } = await confirmDelete(t, {
    commit: async () => ({ success: false, failure: { kind: "failed" } }),
    again: () => null,
  });

  deleted.onSettled();
  await ui.settle();
  const before = calls.length;
  toasts()[1].actions[0].onClick();
  await ui.settle();

  assert.equal(calls.length, before);
});

test("the delete goes out when the toast goes, and success says nothing more", async (t) => {
  const { calls, deleted } = await confirmDelete(t);

  deleted.onSettled();
  await ui.settle();

  assert.deepEqual(calls.at(-1), ["commit"]);
  assert.equal(toasts().length, 1);
});

test("a delete with nothing to report stays quiet", async (t) => {
  const { deleted } = await confirmDelete(t, { commit: async () => null });

  deleted.onSettled();
  await ui.settle();

  assert.equal(toasts().length, 1);
});

test("a failed delete says the teamspace is still there and offers Try again", async (t) => {
  let answer = { success: false, failure: { kind: "failed" } };
  const { calls, deleted } = await confirmDelete(t, { commit: async () => answer });

  deleted.onSettled();
  await ui.settle();

  const failed = toasts()[1];
  assert.equal(readable(failed.title), "Couldn't delete Customer Calls");
  assert.equal(
    readable(failed.description),
    "The teamspace is still available. Check your connection and try again."
  );
  assert.equal(failed.variant, "destructive");
  assert.equal(failed.actions[0].label, "Try again");

  answer = { success: true };
  const before = calls.length;
  await failed.actions[0].onClick();
  await ui.settle();
  assert.deepEqual(calls.slice(before), [["hold", CLOUD_SPACE], ["commit"]]);
  assert.equal(toasts().length, 2);
});

test("a refusal that carries a reason shows it", async (t) => {
  const { deleted } = await confirmDelete(t, {
    commit: async () => ({
      success: false,
      failure: { kind: "refused", message: "This teamspace is locked." },
    }),
  });

  deleted.onSettled();
  await ui.settle();

  assert.equal(readable(toasts()[1].description), "This teamspace is locked.");
  assert.equal(toasts()[1].actions[0].label, "Try again");
});

test("no permission is said plainly, with nothing to try again", async (t) => {
  for (const kind of ["notAllowed", "ssoRequired"]) {
    const { deleted } = await confirmDelete(t, {
      commit: async () => ({ success: false, failure: { kind } }),
    });

    deleted.onSettled();
    await ui.settle();

    assert.equal(
      readable(toasts()[1].description),
      "You don't have permission to delete Customer Calls."
    );
    assert.equal(toasts()[1].actions, undefined);
  }
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
