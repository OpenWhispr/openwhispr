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

let CloudApiError;
let SpaceSettingsDialog;
let createRoot;
let happyWindow;
let vite;
let ui;

test.before(async (t) => {
  ({ happyWindow, createRoot } = await installHappyDom());
  ui = interactions(happyWindow);
  vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-space-settings-dialog-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": ENGLISH_I18N_MOCK,
      // The API client reads the language from here, and the real one starts i18next.
      "/i18n": "export default { t: (key) => key, language: 'en' };",
      "/hooks/useAuth": 'export const useAuth = () => ({ user: { id: "me" } });',
      "/ui/useToast":
        "export const useToast = () => ({ toast: (toast) => globalThis.__toasts.push(toast) });",
      "/stores/workspaceStore": `
        export const useWorkspaceStore = Object.assign(
          (selector) => selector(globalThis.__store),
          { getState: () => globalThis.__store }
        );
      `,
      // The real directory hook runs over this, so the retry and the reload are the real ones.
      "/services/SpacesService": `
        export const SpacesService = {
          listInWorkspace: (workspaceId) => globalThis.__listInWorkspace(workspaceId),
        };
      `,
      "/services/spaceActions": `
        export const renameSpace = (...args) => globalThis.__actions.renameSpace(...args);
        export const setSpaceAccessFlags = (...args) => globalThis.__actions.setSpaceAccessFlags(...args);
        export const leaveSpace = (...args) => globalThis.__actions.leaveSpace(...args);
        export const leaveTeam = (...args) => globalThis.__actions.leaveTeam(...args);
        export const deleteSpace = (...args) => globalThis.__actions.deleteSpace(...args);
      `,
      // The real picker loads emoji data; the dialog only needs to be handed a choice.
      "/ui/EmojiPicker": `
        import React from "react";
        import { PopoverContent } from "/components/ui/popover.tsx";
        export const EmojiPickerContent = ({ onSelect }) =>
          React.createElement(
            PopoverContent,
            null,
            React.createElement("button", { type: "button", onClick: () => onSelect("🎯") }, "pick-target")
          );
      `,
      "/SpaceMembersPanel": `
        import React from "react";
        export default function Mock(props) {
          globalThis.__panelProps = props;
          return React.createElement("div", { "data-members-panel": "" }, "Members panel");
        }
      `,
    },
  });
  ({ CloudApiError } = await vite.ssrLoadModule("/services/cloudApi.ts"));
  ({ default: SpaceSettingsDialog } = await vite.ssrLoadModule(
    "/components/notes/SpaceSettingsDialog.tsx"
  ));
});

test.after(async () => {
  await happyWindow.happyDOM.close();
});

const h = React.createElement;
const doc = () => happyWindow.document;
const dialogs = () => [...doc().querySelectorAll('[role="dialog"]')];
const settings = () => dialogs()[0] ?? null;
const top = () => dialogs().at(-1) ?? null;
const switches = () => [...(settings()?.querySelectorAll('[role="switch"]') ?? [])];
const switchStates = () => switches().map((control) => control.getAttribute("aria-checked"));
const switchNamed = (label) =>
  switches().find((control) => control.getAttribute("aria-label") === label);
const settingsButton = (label) =>
  [...settings().querySelectorAll("button")].find((button) => text(button) === label);
const topButton = (label) =>
  [...top().querySelectorAll("button")].find((button) => text(button) === label);
const topButtons = () => [...top().querySelectorAll("button")].map(text);
const nameInput = () => settings()?.querySelector("input") ?? null;
const descriptionInput = () => settings()?.querySelector("textarea") ?? null;
const tabNamed = (label) =>
  [...settings().querySelectorAll('[role="tab"]')].find((tab) => text(tab) === label);
const toastTitles = () => globalThis.__toasts.map((toast) => readable(toast.title));
const heading = () => top() && text(top().querySelector("h2"));

const capabilities = (overrides) => ({
  manage_members: true,
  manage_teams: true,
  create_spaces: true,
  manage_settings: true,
  manage_billing: false,
  delete_workspace: false,
  transfer_ownership: false,
  leave: true,
  ...overrides,
});

// The role is deliberately not what decides anything: capabilities do.
const workspaceWith = (overrides) => ({
  id: "w1",
  name: "Acme",
  role: "member",
  capabilities: capabilities(overrides),
});

const spaceCapabilities = (overrides) => ({
  edit_notes: true,
  manage_members: true,
  manage_settings: true,
  leave: true,
  ...overrides,
});

const DESCRIPTION = "Recordings and summaries from sales and support calls, one note per call.";

const cloudSpace = (overrides = {}) => ({
  id: 7,
  client_space_id: "client-7",
  cloud_space_id: "cloud-1",
  workspace_id: "w1",
  kind: "team",
  name: "Customer Calls",
  emoji: "📞",
  my_role: "admin",
  my_direct_role: "admin",
  capabilities: spaceCapabilities(),
  teams: [],
  ...overrides,
});

const admin = (userId, name) => ({
  user_id: userId,
  name,
  email: `${userId}@openronnie.com`,
  image: null,
});

// What the directory says about the teamspace above.
const directoryRow = (overrides = {}) => ({
  id: "cloud-1",
  workspace_id: "w1",
  name: "Customer Calls",
  description: DESCRIPTION,
  emoji: "📞",
  member_count: 4,
  teams: [],
  is_default: true,
  is_open: false,
  admins: [admin("me", "Ronnie"), admin("misa", "Misa")],
  my_role: "admin",
  my_direct_role: "admin",
  capabilities: spaceCapabilities(),
  can_join: false,
  sole_admin: false,
  ...overrides,
});

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

// What a test steers: how the fakes answer. Each test gets its own calls log.
async function mount(
  t,
  {
    space = cloudSpace(),
    workspace = workspaceWith({}),
    listInWorkspace = async () => [directoryRow()],
    actions = {},
    props = {},
  } = {}
) {
  const calls = [];
  const events = [];
  const hostApi = { setSpace: () => {}, reopen: () => {} };
  globalThis.__store = { workspaces: [workspace] };
  globalThis.__toasts = [];
  globalThis.__listInWorkspace = async (workspaceId) => {
    calls.push(["list", workspaceId]);
    return listInWorkspace(workspaceId);
  };
  const answer =
    (name, fallback) =>
    async (...args) => {
      calls.push([name, ...args]);
      return (actions[name] ?? fallback)(...args);
    };
  globalThis.__actions = {
    // The store gives the row back with what was saved, as the real action does before it answers.
    renameSpace: answer("renameSpace", async (_target, updates) => {
      hostApi.setSpace((current) => ({ ...current, name: updates.name, emoji: updates.emoji }));
      return { success: true };
    }),
    setSpaceAccessFlags: answer("setSpaceAccessFlags", async () => {}),
    leaveSpace: answer("leaveSpace", async () => ({ removed: true, still_via_teams: [] })),
    leaveTeam: answer("leaveTeam", async () => {}),
    deleteSpace: answer("deleteSpace", async () => ({ success: true })),
  };

  function Host() {
    const [current, setSpace] = React.useState(space);
    const [open, setOpen] = React.useState(true);
    hostApi.setSpace = setSpace;
    hostApi.reopen = () => setOpen(true);
    return h(SpaceSettingsDialog, {
      space: current,
      open,
      onOpenChange: (next) => {
        events.push(next);
        setOpen(next);
      },
      ...props,
    });
  }
  const container = doc().createElement("div");
  doc().body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => {
    await React.act(async () => root.unmount());
    container.remove();
    for (const name of ["__store", "__toasts", "__listInWorkspace", "__actions", "__panelProps"]) {
      delete globalThis[name];
    }
  });
  await React.act(async () => {
    root.render(h(Host));
  });
  await ui.settle();
  return {
    calls,
    events,
    callsTo: (name) => calls.filter(([call]) => call === name),
    reopen: () => ui.act(() => hostApi.reopen()),
  };
}

test("switches show what the server says, and flip and save", async (t) => {
  const row = directoryRow();
  const save = deferred();
  const { callsTo } = await mount(t, {
    listInWorkspace: async () => [{ ...row }],
    actions: {
      setSpaceAccessFlags: async (_id, flags) => {
        await save.promise;
        Object.assign(row, flags);
      },
    },
  });

  assert.deepEqual(
    switches().map((control) => control.getAttribute("aria-label")),
    ["Default teamspace", "Open teamspace"]
  );
  assert.deepEqual(switchStates(), ["true", "false"]);
  assert.match(text(settings()), /Add new workspace members automatically\./);
  assert.match(text(settings()), /Let workspace members join\./);
  assert.deepEqual(callsTo("list"), [["list", "w1"]]);

  await ui.click(switchNamed("Open teamspace"));

  assert.deepEqual(switchStates(), ["true", "true"], "it flips at once");
  assert.deepEqual(callsTo("setSpaceAccessFlags"), [
    ["setSpaceAccessFlags", "cloud-1", { is_open: true }],
  ]);
  assert.equal(switchNamed("Open teamspace").disabled, true, "one save at a time per switch");

  save.resolve();
  await ui.settle();

  assert.deepEqual(switchStates(), ["true", "true"]);
  assert.equal(switchNamed("Open teamspace").disabled, false);
  assert.equal(callsTo("list").length, 2, "the directory is read again so it stays current");
  assert.deepEqual(toastTitles(), []);

  await ui.click(switchNamed("Default teamspace"));
  await ui.settle();

  assert.deepEqual(callsTo("setSpaceAccessFlags").at(-1), [
    "setSpaceAccessFlags",
    "cloud-1",
    { is_default: false },
  ]);
  assert.deepEqual(switchStates(), ["false", "true"]);
});

test("a failed save flips back and says so", async (t) => {
  const { callsTo } = await mount(t, {
    actions: {
      setSpaceAccessFlags: async () => {
        throw new CloudApiError("API error: 500", 500);
      },
    },
  });

  await ui.click(switchNamed("Open teamspace"));
  await ui.settle();

  assert.equal(callsTo("setSpaceAccessFlags").length, 1);
  assert.deepEqual(switchStates(), ["true", "false"], "back to what the server has");
  assert.equal(switchNamed("Open teamspace").disabled, false, "and ready for another try");
  assert.deepEqual(toastTitles(), ["Couldn't save that. Try again."]);
  assert.equal(globalThis.__toasts[0].variant, "destructive");
});

test("Default is read-only for a teamspace admin without manage_settings", async (t) => {
  const { callsTo } = await mount(t, { workspace: workspaceWith({ manage_settings: false }) });

  assert.equal(switchNamed("Default teamspace").disabled, true);
  assert.match(text(settings()), /Only workspace admins can change this\./);
  assert.equal(switchNamed("Open teamspace").disabled, false, "a teamspace admin still opens it");

  await ui.click(switchNamed("Default teamspace"));

  assert.equal(callsTo("setSpaceAccessFlags").length, 0);
  assert.deepEqual(switchStates(), ["true", "false"]);
});

test("a workspace admin changes Default, and isn't told otherwise", async (t) => {
  await mount(t);

  assert.equal(switchNamed("Default teamspace").disabled, false);
  assert.doesNotMatch(text(settings()), /Only workspace admins can change this\./);
});

test("switches wait for the directory, with a retry when it fails, and everything else still works", async (t) => {
  const first = deferred();
  let reads = 0;
  const { callsTo } = await mount(t, {
    listInWorkspace: () => (reads++ === 0 ? first.promise : Promise.resolve([directoryRow()])),
  });

  // Still loading: the switches are there but can't be pressed, and nothing has failed yet.
  assert.deepEqual(
    switches().map((control) => control.disabled),
    [true, true]
  );
  assert.doesNotMatch(text(settings()), /Couldn't load these settings\./);
  assert.equal(descriptionInput().readOnly, true, "the description isn't the directory's yet");

  first.reject(new CloudApiError("Cloud API request failed", 0));
  await ui.settle();

  assert.match(text(settings()), /Couldn't load these settings\./);
  assert.deepEqual(
    switches().map((control) => control.disabled),
    [true, true]
  );
  assert.equal(descriptionInput(), null, "no empty box standing in for a description it can't see");
  // The rest of the dialog works from the local copy.
  assert.ok(settingsButton("Delete teamspace"), "delete is still there");
  await ui.type(nameInput(), "Customer Voices");
  await ui.press(nameInput(), "Enter");
  await ui.settle();
  assert.equal(callsTo("renameSpace").length, 1);

  await ui.click(settingsButton("Try again"));
  await ui.settle();

  assert.equal(callsTo("list").length, 2);
  assert.doesNotMatch(text(settings()), /Couldn't load these settings\./);
  assert.deepEqual(
    switches().map((control) => control.disabled),
    [false, false]
  );
  assert.deepEqual(switchStates(), ["true", "false"]);
  assert.equal(descriptionInput().readOnly, false);
  assert.equal(descriptionInput().value, DESCRIPTION);
});

test("a local teamspace shows neither switch and asks the directory nothing", async (t) => {
  const { callsTo } = await mount(t, {
    space: cloudSpace({
      cloud_space_id: null,
      workspace_id: null,
      capabilities: undefined,
      my_direct_role: null,
    }),
  });

  assert.equal(switches().length, 0);
  assert.equal(settings().querySelector('[role="tab"]'), null, "no Members for a local space");
  assert.deepEqual(callsTo("list"), []);
  assert.ok(nameInput(), "its name is still editable");
  assert.equal(descriptionInput(), null, "a local space has no description to keep");
  assert.match(
    text(settings()),
    /Permanently deletes this space with its folders and notes on this device\./
  );
});

test("admins rename in the header", async (t) => {
  const { callsTo } = await mount(t);

  assert.equal(nameInput().value, "Customer Calls");
  assert.equal(nameInput().getAttribute("dir"), "auto");
  assert.equal(descriptionInput().value, DESCRIPTION);
  assert.equal(descriptionInput().getAttribute("dir"), "auto");

  await ui.type(nameInput(), "Customer Voices");
  await ui.press(nameInput(), "Enter");
  await ui.settle();
  await ui.blur(nameInput());
  await ui.settle();

  assert.deepEqual(
    callsTo("renameSpace").map(([, , updates]) => updates),
    [{ name: "Customer Voices", emoji: "📞" }]
  );
  assert.equal(callsTo("renameSpace").length, 1, "blurring a saved name sends nothing more");

  await ui.typeText(descriptionInput(), "  Calls with customers  ");
  await ui.blur(descriptionInput());
  await ui.settle();

  assert.deepEqual(callsTo("renameSpace").at(-1)[2], {
    name: "Customer Voices",
    emoji: "📞",
    description: "Calls with customers",
  });
  assert.equal(descriptionInput().value, "Calls with customers");
  assert.equal(callsTo("list").length, 2, "the directory is read again to keep the copy current");

  await ui.typeText(descriptionInput(), "");
  await ui.blur(descriptionInput());
  await ui.settle();

  assert.deepEqual(callsTo("renameSpace").at(-1)[2], {
    name: "Customer Voices",
    emoji: "📞",
    description: null,
  });

  await ui.click(settings().querySelector('button[aria-label="Change emoji"]'));
  await ui.click(
    [...doc().querySelectorAll("button")].find((button) => text(button) === "pick-target")
  );
  await ui.settle();

  assert.deepEqual(callsTo("renameSpace").at(-1)[2], { name: "Customer Voices", emoji: "🎯" });
  assert.deepEqual(toastTitles(), []);
});

test("an empty name goes back to what it was, and Enter saves a description", async (t) => {
  const { callsTo } = await mount(t);

  await ui.type(nameInput(), "   ");
  await ui.blur(nameInput());
  await ui.settle();

  assert.equal(callsTo("renameSpace").length, 0);
  assert.equal(nameInput().value, "Customer Calls");

  await ui.typeText(descriptionInput(), "Calls");
  await ui.press(descriptionInput(), "Enter");
  await ui.settle();

  assert.equal(callsTo("renameSpace").length, 1);
  assert.equal(callsTo("renameSpace")[0][2].description, "Calls");
});

test("a rename that fails says so and puts the text back", async (t) => {
  await mount(t, {
    actions: { renameSpace: async () => ({ success: false, error: "offline" }) },
  });

  await ui.type(nameInput(), "Customer Voices");
  await ui.blur(nameInput());
  await ui.settle();
  assert.equal(nameInput().value, "Customer Calls");

  await ui.typeText(descriptionInput(), "Calls with customers");
  await ui.blur(descriptionInput());
  await ui.settle();
  assert.equal(descriptionInput().value, DESCRIPTION);

  assert.equal(toastTitles().length, 2);
  assert.equal(toastTitles()[0], "Couldn't rename space");
  assert.equal(toastTitles()[1], "Couldn't save that. Try again.");
});

test("members read the header", async (t) => {
  await mount(t, {
    workspace: workspaceWith({ manage_settings: false }),
    space: cloudSpace({
      my_role: "member",
      my_direct_role: "member",
      capabilities: spaceCapabilities({ manage_settings: false, manage_members: false }),
    }),
  });

  assert.equal(nameInput(), null, "no field to type in");
  assert.equal(descriptionInput(), null);
  assert.equal(settings().querySelector('button[aria-label="Change emoji"]'), null);
  assert.equal(text(settings().querySelector("h2")), "Customer Calls");
  assert.equal(text(settings().querySelector('p[dir="auto"]')), DESCRIPTION);
  // They read the switches too, without being able to move them.
  assert.deepEqual(
    switches().map((control) => control.disabled),
    [true, true]
  );
  assert.deepEqual(switchStates(), ["true", "false"]);
  assert.equal(settingsButton("Delete teamspace"), undefined, "only managers delete");
  assert.ok(settingsButton("Leave teamspace"), "any member can leave");
});

test("workspace admins don't see Leave", async (t) => {
  await mount(t);

  assert.equal(settingsButton("Leave teamspace"), undefined);
  assert.ok(settingsButton("Delete teamspace"));
});

test("the only admin sees the block, and Manage members opens the Members tab", async (t) => {
  const { callsTo } = await mount(t, {
    workspace: workspaceWith({ manage_settings: false }),
    listInWorkspace: async () => [
      directoryRow({ sole_admin: true, admins: [admin("me", "Ronnie")] }),
    ],
  });

  await ui.click(settingsButton("Leave teamspace"));

  assert.equal(heading(), "Add another admin first");
  assert.deepEqual(topButtons(), ["Manage members", "Cancel"]);
  assert.equal(callsTo("leaveSpace").length, 0);

  await ui.click(topButton("Manage members"));

  assert.equal(dialogs().length, 1, "the block is gone, the settings stay");
  assert.equal(tabNamed("Members").getAttribute("aria-selected"), "true");
  assert.ok(settings().querySelector("[data-members-panel]"));
  assert.equal(switches().length, 0);
});

test("the server's refusal opens the block when the row never loaded", async (t) => {
  const { callsTo } = await mount(t, {
    workspace: workspaceWith({ manage_settings: false }),
    listInWorkspace: async () => {
      throw new CloudApiError("Cloud API request failed", 0);
    },
    actions: {
      leaveSpace: async () => {
        throw new CloudApiError("You are the only admin", 409, "last_space_admin");
      },
    },
  });

  await ui.click(settingsButton("Leave teamspace"));
  assert.equal(heading(), "Leave Customer Calls?", "without the row, it asks by trying");

  await ui.click(topButton("Leave teamspace"));
  await ui.settle();

  assert.equal(callsTo("leaveSpace").length, 1);
  assert.equal(heading(), "Add another admin first");
});

test("leaving asks first, and closes the settings once it's done", async (t) => {
  const { callsTo, events } = await mount(t, {
    workspace: workspaceWith({ manage_settings: false }),
  });

  await ui.click(settingsButton("Leave teamspace"));

  assert.equal(heading(), "Leave Customer Calls?");
  assert.equal(callsTo("leaveSpace").length, 0);
  // Misa carries on as an admin, so the frame's wording applies.
  assert.match(text(top()), /Another admin will continue managing this teamspace\./);

  await ui.click(topButton("Leave teamspace"));
  await ui.settle();

  assert.equal(callsTo("leaveSpace").length, 1);
  assert.equal(callsTo("leaveSpace")[0][2], "me");
  assert.deepEqual(toastTitles(), ["You left Customer Calls."]);
  assert.deepEqual(events, [false]);
  assert.equal(dialogs().length, 0);
});

test("an admin the directory lists alone reads the plain leave wording", async (t) => {
  await mount(t, {
    workspace: workspaceWith({ manage_settings: false }),
    listInWorkspace: async () => [directoryRow({ admins: [admin("me", "Ronnie")] })],
  });

  await ui.click(settingsButton("Leave teamspace"));

  assert.equal(heading(), "Leave Customer Calls?");
  assert.match(text(top()), /Your direct membership will end\./);
  assert.doesNotMatch(text(top()), /Another admin will continue managing this teamspace/);
});

test("deleting a cloud teamspace stacks over the settings, and a delete closes both", async (t) => {
  const { callsTo, events } = await mount(t);

  await ui.click(settingsButton("Delete teamspace"));

  assert.equal(dialogs().length, 2);
  assert.equal(heading(), "Delete Customer Calls?");
  assert.deepEqual(events, [], "the settings stay open behind the confirm");

  await ui.click(topButton("Cancel"));
  assert.equal(dialogs().length, 1);
  assert.deepEqual(events, []);

  await ui.click(settingsButton("Delete teamspace"));
  await ui.click(topButton("Delete teamspace"));
  await ui.settle();

  assert.equal(callsTo("deleteSpace").length, 1);
  assert.deepEqual(toastTitles(), ["Customer Calls was deleted."]);
  assert.deepEqual(events, [false]);
  assert.equal(dialogs().length, 0);
});

test("a delete that fails keeps the settings open behind its Try again", async (t) => {
  const { events } = await mount(t, {
    actions: {
      deleteSpace: async () => ({ success: false, error: "offline", failure: { kind: "failed" } }),
    },
  });

  await ui.click(settingsButton("Delete teamspace"));
  await ui.click(topButton("Delete teamspace"));
  await ui.settle();

  assert.equal(heading(), "Couldn't delete Customer Calls");
  assert.deepEqual(events, []);
  assert.equal(dialogs().length, 2);
});

test("a local teamspace steps aside for the dialog that asks for its name", async (t) => {
  const { events } = await mount(t, {
    space: cloudSpace({ cloud_space_id: null, workspace_id: null, capabilities: undefined }),
  });

  await ui.click(settingsButton("Delete teamspace"));
  await ui.settle();

  assert.deepEqual(events, [false]);
  assert.equal(heading(), "Delete space?");
  assert.ok(top().querySelector("input"), "the name is asked for");
});

test("the dialog opens on the tab it was asked for, and goes back to it when reopened", async (t) => {
  const { reopen, events } = await mount(t, { props: { initialTab: "members" } });

  assert.equal(tabNamed("Members").getAttribute("aria-selected"), "true");
  assert.ok(settings().querySelector("[data-members-panel]"));

  await ui.pressTab(tabNamed("General"));
  assert.equal(tabNamed("General").getAttribute("aria-selected"), "true");

  await ui.click(
    [...settings().querySelectorAll("button")].find((button) => text(button) === "Close")
  );
  assert.deepEqual(events, [false]);
  await reopen();

  assert.equal(tabNamed("Members").getAttribute("aria-selected"), "true");
});

test("the Members tab gives the panel its teamspace and nothing to close for", async (t) => {
  const space = cloudSpace();
  await mount(t, { space, props: { initialTab: "members" } });

  assert.deepEqual(Object.keys(globalThis.__panelProps), ["space"]);
  assert.equal(globalThis.__panelProps.space, space);
});
