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

// Mounts the dialog with the real Radix dialog in happy-dom, over fake services the tests steer.

let CloudApiError;
let LeaveSpaceDialog;
let createRoot;
let happyWindow;
let vite;
let ui;

test.before(async (t) => {
  ({ happyWindow, createRoot } = await installHappyDom());
  ui = interactions(happyWindow);
  vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-leave-space-dialog-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": ENGLISH_I18N_MOCK,
      // The API client reads the language from here, and the real one starts i18next.
      "/i18n": "export default { t: (key) => key, language: 'en' };",
      "/ui/useToast":
        "export const useToast = () => ({ toast: (toast) => globalThis.__toasts.push(toast) });",
      "/services/spaceActions": `
        export const leaveSpace = (...args) => globalThis.__leaveSpace(...args);
        export const leaveTeam = (...args) => globalThis.__leaveTeam(...args);
      `,
    },
  });
  ({ CloudApiError } = await vite.ssrLoadModule("/services/cloudApi.ts"));
  ({ LeaveSpaceDialog } = await vite.ssrLoadModule("/components/notes/LeaveSpaceDialog.tsx"));
});

test.after(async () => {
  await happyWindow.happyDOM.close();
});

const h = React.createElement;
const doc = () => happyWindow.document;
const dialogs = () => [...doc().querySelectorAll('[role="dialog"]')];
const dialog = () => dialogs().at(-1) ?? null;
const buttons = () => [...(dialog()?.querySelectorAll("button") ?? [])];
const buttonNamed = (label) => buttons().find((button) => text(button) === label);
const heading = () => dialog() && text(dialog().querySelector("h2"));
const body = () => dialog() && text(dialog().querySelector("p"));
const toastTitles = () => globalThis.__toasts.map((toast) => readable(toast.title));

const SPACE = {
  id: 7,
  client_space_id: "client-7",
  cloud_space_id: "cloud-1",
  workspace_id: "w1",
  kind: "team",
  name: "Customer Calls",
  emoji: "📞",
  my_role: "admin",
  my_direct_role: "admin",
  teams: [],
};

// What a test steers: how the fakes answer, and what the dialog was told to show.
async function mount(
  t,
  {
    space = SPACE,
    // null: the directory row never loaded, so the dialog is told nothing (undefined).
    soleAdmin = false,
    otherAdmins = true,
    leaveSpace = async () => ({ removed: true, still_via_teams: [] }),
    leaveTeam = async () => {},
  } = {}
) {
  const calls = [];
  const events = [];
  globalThis.__toasts = [];
  globalThis.__leaveSpace = async (...args) => {
    calls.push(["leaveSpace", ...args]);
    return leaveSpace(...args);
  };
  globalThis.__leaveTeam = async (...args) => {
    calls.push(["leaveTeam", ...args]);
    return leaveTeam(...args);
  };

  let reopen = () => {};
  function Host() {
    const [open, setOpen] = React.useState(true);
    reopen = () => setOpen(true);
    return h(LeaveSpaceDialog, {
      space,
      userId: "me",
      open,
      onOpenChange: (next) => {
        events.push(["open", next]);
        setOpen(next);
      },
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
    for (const name of ["__toasts", "__leaveSpace", "__leaveTeam"]) delete globalThis[name];
  });
  await React.act(async () => {
    root.render(h(Host));
  });
  await ui.settle();
  return {
    calls,
    events,
    reopen: () => ui.act(() => reopen()),
    callsTo: (name) => calls.filter(([call]) => call === name),
  };
}

// An answer that stays pending until the test lets it go.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("the only admin sees the block, and Manage members opens the Members tab", async (t) => {
  const { callsTo, events } = await mount(t, { soleAdmin: true });

  assert.equal(heading(), "Add another admin first");
  assert.equal(
    body(),
    "You're the only admin of Customer Calls. Make another member an admin before you leave."
  );
  assert.deepEqual(
    buttons().map(text),
    ["Manage members", "Cancel"],
    "the block offers the way out, not a Leave"
  );

  await ui.click(buttonNamed("Manage members"));

  assert.deepEqual(events, [["open", false], ["manageMembers"]]);
  assert.equal(callsTo("leaveSpace").length, 0, "nothing was sent");
  assert.equal(dialog(), null);
});

test("Cancel on the block closes without moving to Members", async (t) => {
  const { events } = await mount(t, { soleAdmin: true });

  await ui.click(buttonNamed("Cancel"));

  assert.deepEqual(events, [["open", false]]);
});

test("the server's refusal opens the block when the row never loaded", async (t) => {
  const { callsTo, events } = await mount(t, {
    soleAdmin: null,
    leaveSpace: async () => {
      throw new CloudApiError("You are the only admin", 409, "last_space_admin");
    },
  });
  assert.equal(heading(), "Leave Customer Calls?", "an unknown row is asked by trying");

  await ui.click(buttonNamed("Leave teamspace"));
  await ui.settle();

  assert.equal(callsTo("leaveSpace").length, 1);
  assert.equal(heading(), "Add another admin first");
  assert.deepEqual(buttons().map(text), ["Manage members", "Cancel"]);
  assert.deepEqual(toastTitles(), [], "the block is the answer, not a toast");

  await ui.click(buttonNamed("Manage members"));
  assert.deepEqual(events, [["open", false], ["manageMembers"]]);
});

test("leaving asks, runs, fails with Try again, and succeeds with a toast", async (t) => {
  const first = deferred();
  const answers = [first, null];
  const { callsTo, events } = await mount(t, {
    leaveSpace: () => {
      const next = answers.shift();
      return next ? next.promise : Promise.resolve({ removed: true, still_via_teams: [] });
    },
  });

  // A direct admin with others to carry on: the frame's wording.
  assert.equal(heading(), "Leave Customer Calls?");
  assert.equal(
    body(),
    "You'll lose access to Customer Calls and its notes. Another admin will continue managing this teamspace."
  );
  assert.deepEqual(buttons().map(text), ["Leave teamspace", "Cancel"]);
  assert.equal(callsTo("leaveSpace").length, 0, "pressing Leave only asks");

  await ui.click(buttonNamed("Leave teamspace"));
  assert.deepEqual(callsTo("leaveSpace"), [["leaveSpace", SPACE, "me"]]);
  // Running: the request can't be taken back, so there is no Cancel and Escape does nothing.
  assert.deepEqual(buttons().map(text), ["Leave teamspace"]);
  assert.equal(buttons()[0].disabled, true);
  await ui.press(doc().activeElement ?? dialog(), "Escape");
  assert.ok(dialog(), "Escape doesn't close a running leave");
  assert.deepEqual(events, []);

  first.reject(new CloudApiError("API error: 500", 500));
  await ui.settle();

  assert.equal(heading(), "Couldn't leave Customer Calls");
  assert.equal(body(), "Your membership is unchanged. Check your connection and try again.");
  assert.deepEqual(buttons().map(text), ["Try again", "Cancel"]);
  assert.deepEqual(toastTitles(), []);

  await ui.click(buttonNamed("Try again"));
  await ui.settle();

  assert.equal(callsTo("leaveSpace").length, 2);
  assert.deepEqual(toastTitles(), ["You left Customer Calls."]);
  assert.deepEqual(events, [["open", false], ["left"]]);
  assert.equal(dialog(), null);
});

test("a direct member, or an admin with nobody to carry on, is told they lose access", async (t) => {
  await mount(t, { otherAdmins: false });

  assert.equal(body(), "You'll lose access to Customer Calls and its notes.");
});

test("a direct grant beside a group names the group that keeps access", async (t) => {
  await mount(t, {
    otherAdmins: true,
    space: { ...SPACE, teams: [{ id: "g1", name: "Sales", my_role: "member" }] },
  });

  assert.equal(
    body(),
    "Your direct membership will end. You'll keep access through Sales. Another admin will continue managing this teamspace."
  );
});

test("a member who isn't an admin hears nothing about who manages it", async (t) => {
  await mount(t, { space: { ...SPACE, my_role: "member", my_direct_role: "member" } });

  assert.equal(body(), "You'll lose access to Customer Calls and its notes.");
});

test("someone with a group keeps the group-access wording", async (t) => {
  const space = {
    ...SPACE,
    my_role: "member",
    my_direct_role: null,
    teams: [
      { id: "g1", name: "Sales", my_role: "member" },
      { id: "g2", name: "Support", my_role: "admin" },
      { id: "g3", name: "Others", my_role: null },
    ],
  };
  const { callsTo, events } = await mount(t, { space, otherAdmins: false });

  assert.equal(
    body(),
    "You'll be removed from Sales and Support and lose access to any other spaces those groups can open."
  );

  await ui.click(buttonNamed("Leave teamspace"));
  await ui.settle();

  assert.equal(callsTo("leaveSpace").length, 0, "there is no direct grant to drop");
  assert.deepEqual(callsTo("leaveTeam"), [
    ["leaveTeam", "g1", "me"],
    ["leaveTeam", "g2", "me"],
  ]);
  assert.deepEqual(toastTitles(), ["You left Customer Calls."]);
  assert.deepEqual(events, [["open", false], ["left"]]);
});

test("a group that fails stops the leave and offers Try again", async (t) => {
  const space = {
    ...SPACE,
    my_direct_role: null,
    teams: [
      { id: "g1", name: "Sales", my_role: "member" },
      { id: "g2", name: "Support", my_role: "member" },
    ],
  };
  const { callsTo, events } = await mount(t, {
    space,
    leaveTeam: async (teamId) => {
      if (teamId === "g1") throw new CloudApiError("API error: 500", 500);
    },
  });

  await ui.click(buttonNamed("Leave teamspace"));
  await ui.settle();

  assert.deepEqual(
    callsTo("leaveTeam").map(([, teamId]) => teamId),
    ["g1"]
  );
  assert.equal(heading(), "Couldn't leave Customer Calls");
  assert.deepEqual(events, []);
});

test("access that remains through a group keeps its toast and the settings open", async (t) => {
  const { events } = await mount(t, {
    leaveSpace: async () => ({
      removed: true,
      still_via_teams: [
        { team_id: "g1", name: "Sales" },
        { team_id: "g2", name: "Support" },
      ],
    }),
  });

  await ui.click(buttonNamed("Leave teamspace"));
  await ui.settle();

  assert.deepEqual(toastTitles(), [
    "You still have access to Customer Calls through Sales and Support.",
  ]);
  // The dialog goes, but this isn't a leave: the settings behind it have nothing to close.
  assert.deepEqual(events, [["open", false]]);
  assert.equal(dialog(), null);
});

test("a refusal that carries a reason shows it under the failure", async (t) => {
  await mount(t, {
    leaveSpace: async () => {
      throw new CloudApiError("Members synced from a directory can't leave", 400);
    },
  });

  await ui.click(buttonNamed("Leave teamspace"));
  await ui.settle();

  assert.equal(heading(), "Couldn't leave Customer Calls");
  assert.equal(
    text(dialog().querySelector('[role="alert"]')),
    "Members synced from a directory can't leave"
  );
});

test("Cancel closes the confirm and sends nothing", async (t) => {
  const { callsTo, events } = await mount(t);

  await ui.click(buttonNamed("Cancel"));

  assert.deepEqual(events, [["open", false]]);
  assert.equal(callsTo("leaveSpace").length, 0);
  assert.equal(dialog(), null);
});

test("reopening after a failure starts at the confirm again", async (t) => {
  const { events, reopen } = await mount(t, {
    leaveSpace: async () => {
      throw new CloudApiError("API error: 500", 500);
    },
  });
  await ui.click(buttonNamed("Leave teamspace"));
  await ui.settle();
  assert.equal(heading(), "Couldn't leave Customer Calls");

  await ui.click(buttonNamed("Cancel"));
  assert.equal(dialog(), null);
  await reopen();

  assert.equal(heading(), "Leave Customer Calls?");
  assert.deepEqual(buttons().map(text), ["Leave teamspace", "Cancel"]);
  assert.deepEqual(events, [["open", false]]);
});

test("reopening after the block starts at the block only when the row says so", async (t) => {
  const { reopen } = await mount(t, {
    soleAdmin: null,
    leaveSpace: async () => {
      throw new CloudApiError("You are the only admin", 409, "last_space_admin");
    },
  });
  await ui.click(buttonNamed("Leave teamspace"));
  await ui.settle();
  assert.equal(heading(), "Add another admin first");

  await ui.click(buttonNamed("Cancel"));
  await reopen();

  assert.equal(heading(), "Leave Customer Calls?", "the server's answer isn't remembered");
});
