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

// Mounts the dialog with the real Radix dialog in happy-dom, over a fake leave the tests steer.

let CloudApiError;
let LeaveTeamDialog;
let createRoot;
let happyWindow;
let vite;
let ui;

test.before(async (t) => {
  ({ happyWindow, createRoot } = await installHappyDom());
  ui = interactions(happyWindow);
  vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-leave-team-dialog-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": ENGLISH_I18N_MOCK,
      "/i18n": "export default { t: (key) => key, language: 'en' };",
      "/ui/useToast":
        "export const useToast = () => ({ toast: (toast) => globalThis.__toasts.push(toast) });",
      "/services/spaceActions":
        "export const leaveTeam = (...args) => globalThis.__leaveTeam(...args);",
    },
  });
  ({ CloudApiError } = await vite.ssrLoadModule("/services/cloudApi.ts"));
  ({ default: LeaveTeamDialog } = await vite.ssrLoadModule(
    "/components/settings/LeaveTeamDialog.tsx"
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
const toastTitles = () => globalThis.__toasts.map((toast) => readable(toast.title));

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
  { soleAdmin = false, otherAdmins = true, leaveTeam = async () => {} } = {}
) {
  const calls = [];
  const events = [];
  globalThis.__toasts = [];
  globalThis.__leaveTeam = async (...args) => {
    calls.push(["leaveTeam", ...args]);
    return leaveTeam(...args);
  };
  function Host() {
    const [open, setOpen] = React.useState(true);
    return h(LeaveTeamDialog, {
      team: TEAM,
      userId: "me",
      open,
      onOpenChange: (next) => {
        events.push(["open", next]);
        setOpen(next);
      },
      // null: the row never loaded, so the dialog is told nothing (undefined).
      soleAdmin: soleAdmin ?? undefined,
      otherAdmins,
      onManageMembers: () => events.push(["manageMembers"]),
      onLeft: () => events.push(["left"]),
    });
  }
  const container = doc().createElement("div");
  doc().body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => {
    await React.act(async () => root.unmount());
    container.remove();
    for (const name of ["__toasts", "__leaveTeam"]) delete globalThis[name];
  });
  await React.act(async () => {
    root.render(h(Host));
  });
  await ui.settle();
  return { calls, events };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("the only admin is blocked and sent to Members", async (t) => {
  const { calls, events } = await mount(t, { soleAdmin: true });

  assert.equal(heading(), "Add another admin first");
  assert.equal(
    body(),
    "You're the only admin of Sales. Make another member an admin before you leave."
  );
  assert.deepEqual(buttons().map(text), ["Manage members", "Cancel"]);

  await ui.click(buttonNamed("Manage members"));

  assert.deepEqual(events, [["open", false], ["manageMembers"]]);
  assert.deepEqual(calls, [], "nothing was sent");
});

test("another admin can leave, and the body says who stays", async (t) => {
  const { calls, events } = await mount(t);

  assert.equal(heading(), "Leave Sales?");
  assert.equal(
    body(),
    "You'll be removed from this team and lose access granted through it. Another admin will continue managing the team."
  );
  assert.deepEqual(buttons().map(text), ["Leave team", "Cancel"]);
  assert.deepEqual(calls, [], "pressing Leave only asks");

  await ui.click(buttonNamed("Leave team"));
  await ui.settle();

  assert.deepEqual(calls, [["leaveTeam", "t1", "me"]]);
  assert.deepEqual(toastTitles(), ["You left Sales."]);
  assert.deepEqual(events, [["open", false], ["left"]]);
});

test("a workspace admin with nobody to carry on isn't told someone will", async (t) => {
  await mount(t, { otherAdmins: false });

  assert.equal(body(), "You'll be removed from this team and lose access granted through it.");
});

test("a failed leave offers Try again", async (t) => {
  const first = deferred();
  const answers = [first, null];
  const { calls, events } = await mount(t, {
    leaveTeam: () => {
      const next = answers.shift();
      return next ? next.promise : Promise.resolve();
    },
  });

  await ui.click(buttonNamed("Leave team"));
  assert.deepEqual(buttons().map(text), ["Leave team"], "running: no Cancel");
  assert.equal(buttons()[0].disabled, true);

  first.reject(new CloudApiError("API error: 500", 500));
  await ui.settle();

  assert.equal(heading(), "Couldn't leave Sales");
  assert.equal(body(), "You're still a member of this team. Check your connection and try again.");
  assert.deepEqual(buttons().map(text), ["Try again", "Cancel"]);
  assert.deepEqual(toastTitles(), []);

  await ui.click(buttonNamed("Try again"));
  await ui.settle();

  assert.equal(calls.length, 2);
  assert.deepEqual(toastTitles(), ["You left Sales."]);
  assert.deepEqual(events, [["open", false], ["left"]]);
});

test("the server's refusal opens the block when the row never loaded", async (t) => {
  const { calls, events } = await mount(t, {
    soleAdmin: null,
    leaveTeam: async () => {
      throw new CloudApiError("You are the only admin", 409, "last_team_admin");
    },
  });
  assert.equal(heading(), "Leave Sales?", "an unknown row is asked by trying");

  await ui.click(buttonNamed("Leave team"));
  await ui.settle();

  assert.equal(calls.length, 1);
  assert.equal(heading(), "Add another admin first");
  assert.deepEqual(buttons().map(text), ["Manage members", "Cancel"]);
  assert.deepEqual(toastTitles(), [], "the block is the answer, not a toast");

  await ui.click(buttonNamed("Manage members"));
  assert.deepEqual(events, [["open", false], ["manageMembers"]]);
});

test("a lost answer on a team already left counts as left", async (t) => {
  const { events } = await mount(t, {
    leaveTeam: async () => {
      throw new CloudApiError("Team not found", 404);
    },
  });

  await ui.click(buttonNamed("Leave team"));
  await ui.settle();

  assert.deepEqual(toastTitles(), ["You left Sales."]);
  assert.deepEqual(events, [["open", false], ["left"]]);
});
