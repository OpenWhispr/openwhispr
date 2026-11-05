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
      "/TeamRosterSection": `
        import React from "react";
        export default function Mock(props) {
          globalThis.__rosterProps = props;
          return React.createElement("div", { "data-roster": "" }, "Roster");
        }
      `,
      "/InviteTeammateDialog": "export default function Mock() { return null; }",
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

async function mount(t, { team: subject, ws = workspace(false), renameTeam } = {}) {
  const calls = [];
  const events = [];
  globalThis.__toasts = [];
  globalThis.__listMembers = async () => [];
  globalThis.__actions = {
    renameTeam: async (...args) => {
      calls.push(["renameTeam", ...args]);
      return renameTeam ? renameTeam(...args) : { ...subject, name: args[1] };
    },
    leaveTeam: async () => {},
    holdTeamDelete: () => ({}),
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
    for (const name of ["__toasts", "__listMembers", "__actions", "__rosterProps"]) {
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
  assert.deepEqual(tabs, ["General", "Members"], "Teamspaces stays hidden until its tab lands");

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
  await mount(t, {
    team: team(
      { manage_settings: false, manage_members: false, leave: false },
      { directory_synced: true }
    ),
    ws: workspace(true),
  });

  assert.equal(nameInput(), null);
  assert.match(text(dialog()), /Managed by your directory/);
  assert.equal(buttonNamed("Leave team"), undefined);
  assert.equal(buttonNamed("Delete team"), undefined);
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
    buttonTexts().filter((label) => /team/i.test(label)),
    []
  );
  assert.deepEqual(toastTitles(), []);
});
