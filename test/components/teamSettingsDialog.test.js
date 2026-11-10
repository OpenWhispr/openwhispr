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
let TeamSettingsDialog;
let createRoot;
let happyWindow;
let vite;
let ui;

test.before(async (t) => {
  ({ happyWindow, createRoot } = await installHappyDom());
  ui = interactions(happyWindow);
  vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-team-settings-dialog-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": ENGLISH_I18N_MOCK,
      "/i18n": "export default { t: (key) => key, language: 'en' };",
      "/hooks/useAuth": 'export const useAuth = () => ({ user: { id: "me" } });',
      "/ui/useToast":
        "export const useToast = () => ({ toast: (toast) => globalThis.__toasts.push(toast), dismiss: () => {} });",
      "/stores/workspaceStore": `
        export const useWorkspaceStore = Object.assign(
          (selector) => selector({ members: [], membersWorkspaceId: "w1", refreshMembers: async () => {} }),
          { getState: () => ({}) }
        );
      `,
      "/services/TeamsService": `
        export const TeamsService = { listMembers: (id) => globalThis.__listMembers(id) };
      `,
      "/services/spaceActions": `
        export const renameTeam = (...args) => globalThis.__actions.renameTeam(...args);
        export const leaveTeam = (...args) => globalThis.__actions.leaveTeam(...args);
        export const holdTeamDelete = (...args) => globalThis.__actions.holdTeamDelete(...args);
      `,
      "/TeamMembersPanel": `
        import React from "react";
        export default function Mock(props) {
          globalThis.__panelProps = props;
          return React.createElement("div", { "data-members-panel": "" }, "Members panel");
        }
      `,
      "/TeamSpacesPanel": `
        import React from "react";
        export default function Mock(props) {
          globalThis.__spacesProps = props;
          return React.createElement("div", { "data-spaces-panel": "" }, "Teamspaces panel");
        }
      `,
      "/notes/SpaceNameField": `
        import React from "react";
        export const TileGlyph = ({ emoji, name }) =>
          React.createElement("span", { "data-glyph": emoji ?? name });
        export default function SpaceNameField() { return null; }
      `,
    },
  });
  ({ CloudApiError } = await vite.ssrLoadModule("/services/cloudApi.ts"));
  ({ default: TeamSettingsDialog } = await vite.ssrLoadModule(
    "/components/settings/TeamSettingsDialog.tsx"
  ));
});

test.after(async () => {
  await happyWindow.happyDOM.close();
});

const h = React.createElement;
const doc = () => happyWindow.document;
const dialog = () => [...doc().querySelectorAll('[role="dialog"]')][0] ?? null;
const top = () => [...doc().querySelectorAll('[role="dialog"]')].at(-1) ?? null;
const topButton = (label) =>
  [...top().querySelectorAll("button")].find((button) => text(button) === label);
const tabNamed = (label) =>
  [...dialog().querySelectorAll('[role="tab"]')].find((tab) => text(tab) === label);
const buttonTexts = () => [...(dialog()?.querySelectorAll("button") ?? [])].map(text);
const buttonNamed = (label) =>
  [...dialog().querySelectorAll("button")].find((button) => text(button) === label);
const nameInput = () => dialog()?.querySelector("input") ?? null;
const heading = () => dialog() && text(dialog().querySelector("h2"));
const toastTitles = () => globalThis.__toasts.map((toast) => readable(toast.title));

const workspace = (manageTeams) => ({
  id: "w1",
  name: "Acme",
  role: "member",
  capabilities: {
    manage_members: manageTeams,
    manage_teams: manageTeams,
    create_teams: true,
    create_spaces: false,
    manage_settings: false,
    manage_billing: false,
    delete_workspace: false,
    transfer_ownership: false,
    leave: true,
  },
});

const team = (capabilities, overrides = {}) => ({
  id: "t1",
  workspace_id: "w1",
  name: "Sales",
  slug: "sales",
  description: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  capabilities: { manage_members: false, manage_settings: false, leave: false, ...capabilities },
  ...overrides,
});

async function mount(
  t,
  {
    team: subject,
    ws = workspace(false),
    renameTeam,
    listMembers = async () => [],
    leaveTeam = async () => {},
  } = {}
) {
  const calls = [];
  const events = [];
  globalThis.__toasts = [];
  globalThis.__listMembers = async (...args) => {
    calls.push(["listMembers", ...args]);
    return listMembers(...args);
  };
  globalThis.__actions = {
    renameTeam: async (...args) => {
      calls.push(["renameTeam", ...args]);
      return renameTeam ? renameTeam(...args) : { ...subject, name: args[1] };
    },
    leaveTeam: async (...args) => {
      calls.push(["leaveTeam", ...args]);
      return leaveTeam(...args);
    },
    holdTeamDelete: (target) => {
      calls.push(["hold", target.id]);
      return { undo: async () => true, commit: async () => null, again: () => null };
    },
  };
  function Host() {
    const [open, setOpen] = React.useState(true);
    return h(TeamSettingsDialog, {
      team: subject,
      workspace: ws,
      open,
      onOpenChange: (next) => {
        events.push(["open", next]);
        setOpen(next);
      },
      onChanged: () => events.push(["changed"]),
      onGone: () => events.push(["gone"]),
    });
  }
  const container = doc().createElement("div");
  doc().body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => {
    await React.act(async () => root.unmount());
    container.remove();
    for (const name of ["__toasts", "__listMembers", "__actions", "__panelProps"]) {
      delete globalThis[name];
    }
  });
  await React.act(async () => {
    root.render(h(Host));
  });
  await ui.settle();
  return { calls, events };
}

test("an admin renames in place, and a taken name stays editable", async (t) => {
  const { calls, events } = await mount(t, {
    team: team({ manage_settings: true, leave: true }),
    renameTeam: async (_id, name) => {
      if (name === "Marketing") throw new CloudApiError("Taken", 409, "team_name_taken");
      return { name };
    },
  });
  const tabs = [...dialog().querySelectorAll('[role="tab"]')].map(text);
  assert.deepEqual(tabs, ["General", "Members", "Teamspaces"]);

  await ui.type(nameInput(), "Sales EMEA");
  await ui.act(() =>
    nameInput().dispatchEvent(
      new happyWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true })
    )
  );
  await ui.settle();

  assert.deepEqual(calls, [["renameTeam", "t1", "Sales EMEA"]]);
  assert.deepEqual(events, [["changed"]]);

  await ui.type(nameInput(), "Marketing");
  await ui.blur(nameInput());
  await ui.settle();

  assert.equal(nameInput().value, "Marketing", "the name stays for the user to change");
  assert.match(text(dialog()), /A team called Marketing already exists\./);
  assert.deepEqual(events, [["changed"]]);

  // Esc puts the saved name back and keeps the dialog open.
  await ui.press(nameInput(), "Escape");
  assert.equal(nameInput().value, "Sales EMEA");
  assert.ok(dialog());
  assert.doesNotMatch(text(dialog()), /already exists/);
});

test("a member reads plain text", async (t) => {
  await mount(t, { team: team({ leave: true }) });

  assert.equal(nameInput(), null);
  assert.equal(heading(), "Sales");
});

test("a directory team is read-only, with a line saying why", async (t) => {
  // Every capability on: the directory, not the capabilities, is what makes it read-only.
  await mount(t, {
    team: team(
      { manage_settings: true, manage_members: true, leave: true },
      { directory_synced: true }
    ),
    ws: workspace(true),
  });

  assert.equal(nameInput(), null);
  assert.match(text(dialog()), /Managed by your directory/);
  assert.equal(buttonNamed("Leave team"), undefined);
  assert.equal(buttonNamed("Delete team"), undefined);

  await ui.pressTab(tabNamed("Members"));
  assert.equal(globalThis.__panelProps.managed, true, "the panel is told the directory owns it");
});

test("Leave shows only with the capability", async (t) => {
  await mount(t, { team: team({ manage_settings: false, leave: true }) });

  assert.ok(buttonNamed("Leave team"));
  assert.equal(buttonNamed("Delete team"), undefined);
});

test("Delete shows only with the capability", async (t) => {
  await mount(t, { team: team({ manage_settings: true, leave: false }) });

  assert.ok(buttonNamed("Delete team"));
  assert.equal(buttonNamed("Leave team"), undefined);
});

test("with neither capability there is nothing but the header", async (t) => {
  await mount(t, { team: team({}) });

  assert.deepEqual(
    // The Teamspaces tab is always there; it is a tab, not an action.
    buttonTexts().filter((label) => /team/i.test(label) && label !== "Teamspaces"),
    []
  );
  assert.deepEqual(toastTitles(), []);
});

const me = (role) => ({ user_id: "me", role });
const ethan = (role) => ({ user_id: "ethan", role });

test("Manage members switches to the Members tab", async (t) => {
  await mount(t, {
    team: team({ leave: true }, { sole_admin: true }),
    listMembers: async () => [me("admin"), ethan("member")],
  });

  await ui.click(buttonNamed("Leave team"));
  await ui.settle();
  assert.equal(text(top().querySelector("h2")), "Add another admin first");

  await ui.click(topButton("Manage members"));

  assert.equal(tabNamed("Members").getAttribute("aria-selected"), "true");
  assert.ok(globalThis.__panelProps, "the members panel is showing");
});

test("after making another admin, Leave opens the confirm instead of the block", async (t) => {
  let members = [me("admin"), ethan("member")];
  const { events } = await mount(t, {
    team: team({ leave: true }, { sole_admin: true }),
    listMembers: async () => members,
  });

  await ui.click(buttonNamed("Leave team"));
  await ui.settle();
  await ui.click(topButton("Manage members"));

  // The panel reports every roster change it makes.
  members = [me("admin"), ethan("admin")];
  await ui.act(() => globalThis.__panelProps.onChanged());
  assert.deepEqual(events, [["changed"]]);

  await ui.pressTab(tabNamed("General"));
  await ui.click(buttonNamed("Leave team"));
  await ui.settle();

  assert.equal(text(top().querySelector("h2")), "Leave Sales?");
});

test("the members panel gets the team and reports a lost team through onGone", async (t) => {
  const { events } = await mount(t, { team: team({ manage_members: true }) });

  await ui.pressTab(tabNamed("Members"));
  assert.equal(globalThis.__panelProps.team.id, "t1");
  assert.equal(globalThis.__panelProps.managed, false);
  await ui.act(() => globalThis.__panelProps.onGone());

  assert.deepEqual(events, [["gone"]]);
});

test("the Teamspaces tab shows its panel with the team, and carries onChanged and onGone", async (t) => {
  const { events } = await mount(t, { team: team({ manage_members: true }) });

  await ui.pressTab(tabNamed("Teamspaces"));
  assert.ok(doc().querySelector("[data-spaces-panel]"));
  assert.equal(globalThis.__spacesProps.team.id, "t1");
  await ui.act(() => globalThis.__spacesProps.onChanged());
  await ui.act(() => globalThis.__spacesProps.onGone());

  assert.deepEqual(events, [["changed"], ["gone"]]);
});

test("a failed roster read leaves the answer to the row", async (t) => {
  await mount(t, {
    team: team({ leave: true }, { sole_admin: true }),
    listMembers: async () => {
      throw new Error("offline");
    },
  });

  await ui.click(buttonNamed("Leave team"));
  await ui.settle();

  assert.equal(text(top().querySelector("h2")), "Add another admin first");
});

test("a workspace admin who leaves stays; anyone else is gone", async (t) => {
  const admin = await mount(t, {
    team: team({ leave: true }),
    ws: workspace(true),
    listMembers: async () => [me("admin"), ethan("admin")],
  });
  await ui.click(buttonNamed("Leave team"));
  await ui.settle();
  await ui.click(topButton("Leave team"));
  await ui.settle();
  assert.deepEqual(
    admin.calls.filter(([name]) => name === "leaveTeam"),
    [["leaveTeam", "t1", "me"]]
  );
  assert.deepEqual(admin.events, [["changed"]]);
});

test("a team member who leaves reports the team gone", async (t) => {
  const { events } = await mount(t, {
    team: team({ leave: true }),
    listMembers: async () => [me("admin"), ethan("admin")],
  });
  await ui.click(buttonNamed("Leave team"));
  await ui.settle();
  await ui.click(topButton("Leave team"));
  await ui.settle();
  assert.deepEqual(events, [["gone"]]);
});

test("a workspace admin who is the only explicit admin gets the shorter body", async (t) => {
  await mount(t, {
    team: team({ leave: true }),
    ws: workspace(true),
    listMembers: async () => [me("admin"), ethan("member")],
  });

  await ui.click(buttonNamed("Leave team"));
  await ui.settle();

  assert.equal(text(top().querySelector("h2")), "Leave Sales?");
  assert.equal(
    text(top().querySelector("p")),
    "You'll be removed from this team and lose access granted through it."
  );
});

test("Delete is off while the roster is being read", async (t) => {
  let release;
  await mount(t, {
    team: team({ leave: true, manage_settings: true }),
    listMembers: () =>
      new Promise((resolve) => (release = () => resolve([me("admin"), ethan("admin")]))),
  });

  await ui.click(buttonNamed("Leave team"));
  assert.equal(buttonNamed("Delete team").disabled, true);
  release();
  await ui.settle();
  assert.equal(text(top().querySelector("h2")), "Leave Sales?");
});

test("deleting reports the team gone once", async (t) => {
  const { calls, events } = await mount(t, { team: team({ manage_settings: true }) });

  await ui.click(buttonNamed("Delete team"));
  await ui.click(topButton("Delete team"));

  assert.deepEqual(
    calls.filter(([name]) => name === "hold"),
    [["hold", "t1"]]
  );
  assert.deepEqual(events, [["gone"]], "one signal, so the host reloads once");
});

test("renaming a team that no longer exists reports it", async (t) => {
  const { events } = await mount(t, {
    team: team({ manage_settings: true }),
    renameTeam: async () => {
      throw new CloudApiError("Team not found", 404);
    },
  });

  await ui.type(nameInput(), "Other");
  await ui.blur(nameInput());
  await ui.settle();

  assert.deepEqual(toastTitles(), ["Sales no longer exists."]);
  assert.deepEqual(events, [["gone"]]);
});

test("Enter then the blur that follows save once", async (t) => {
  const { calls } = await mount(t, { team: team({ manage_settings: true }) });

  await ui.type(nameInput(), "Revenue");
  await ui.press(nameInput(), "Enter");
  await ui.blur(nameInput());
  await ui.settle();

  assert.equal(calls.filter(([name]) => name === "renameTeam").length, 1);
});

test("a refused name keeps its message when the field is left again", async (t) => {
  await mount(t, {
    team: team({ manage_settings: true }),
    renameTeam: async () => {
      throw new CloudApiError("Taken", 409, "team_name_taken");
    },
  });

  await ui.type(nameInput(), "Marketing");
  await ui.blur(nameInput());
  await ui.settle();
  await ui.type(nameInput(), "Other");
  assert.doesNotMatch(text(dialog()), /already exists/);
  await ui.type(nameInput(), "Marketing");
  await ui.blur(nameInput());
  await ui.settle();

  assert.match(text(dialog()), /A team called Marketing already exists\./);
});

test("closing while a taken name is saving still says it was refused", async (t) => {
  const { events } = await mount(t, {
    team: team({ manage_settings: true }),
    renameTeam: async () => {
      throw new CloudApiError("Taken", 409, "team_name_taken");
    },
  });

  await ui.type(nameInput(), "Marketing");
  await ui.click(buttonNamed("Close"));
  await ui.settle();

  assert.deepEqual(events.at(0), ["open", false]);
  assert.deepEqual(toastTitles().slice(-1), ["A team called Marketing already exists."]);
});

test("the second Esc closes", async (t) => {
  const { events } = await mount(t, { team: team({ manage_settings: true }) });

  await ui.type(nameInput(), "Revenue");
  await ui.press(nameInput(), "Escape");
  assert.equal(nameInput().value, "Sales");
  assert.deepEqual(events, []);

  await ui.press(nameInput(), "Escape");
  assert.deepEqual(events.at(-1), ["open", false]);
});

test("Esc while a rename is saving keeps the new name, and closing doesn't send the old one", async (t) => {
  let answer;
  const { calls, events } = await mount(t, {
    team: team({ manage_settings: true }),
    renameTeam: (_id, name) =>
      new Promise((resolve) => {
        answer = () => resolve({ ...team({ manage_settings: true }), name });
      }),
  });

  await ui.type(nameInput(), "Revenue");
  await ui.press(nameInput(), "Enter");
  await ui.type(nameInput(), "Revenue 2");
  await ui.press(nameInput(), "Escape");
  assert.equal(nameInput().value, "Revenue", "Esc puts back the name being saved, not the old one");
  assert.deepEqual(events, []);

  await ui.act(() => answer());
  await ui.settle();
  await ui.click(buttonNamed("Close"));
  await ui.settle();
  const renames = calls.filter(([name]) => name === "renameTeam").map(([, , value]) => value);
  assert.deepEqual(renames, ["Revenue"]);
});

test("Esc while a rename is saving closes when nothing else was typed", async (t) => {
  const { calls, events } = await mount(t, {
    team: team({ manage_settings: true }),
    renameTeam: () => new Promise(() => {}),
  });

  await ui.type(nameInput(), "Revenue");
  await ui.press(nameInput(), "Enter");
  await ui.press(nameInput(), "Escape");
  assert.deepEqual(events.at(-1), ["open", false]);
  assert.equal(calls.filter(([name]) => name === "renameTeam").length, 1);
});
