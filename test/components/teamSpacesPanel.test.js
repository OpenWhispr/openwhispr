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

// Mounts the real panel with the real Radix popover in happy-dom. The directory hook, the action
// and the create dialog are fakes the tests steer; strings come from the English file.

let CloudApiError;
let TeamSpacesPanel;
let createRoot;
let happyWindow;
let ui;
let vite;

test.before(async (t) => {
  ({ happyWindow, createRoot } = await installHappyDom());
  ui = interactions(happyWindow);
  vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-team-spaces-panel-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": ENGLISH_I18N_MOCK,
      "/i18n": "export default { t: (key) => key, language: 'en' };",
      "/ui/useToast":
        "export const useToast = () => ({ toast: (toast) => globalThis.__toasts.push(toast) });",
      "/hooks/useWorkspaceSpaces": `
        import { useState } from "react";
        export const useWorkspaceSpaces = () => {
          const [spaces, setSpaces] = useState(globalThis.__server.spaces());
          return {
            status: globalThis.__server.status,
            spaces,
            stale: false,
            loads: 1,
            reload: async () => {
              globalThis.__calls.push(["reload"]);
              if (globalThis.__server.reload) return globalThis.__server.reload(setSpaces);
              const next = globalThis.__server.spaces();
              setSpaces(next);
              return next;
            },
          };
        };
      `,
      "/services/spaceActions": `
        export const assignTeamToSpaces = (...args) => globalThis.__actions.assignTeamToSpaces(...args);
      `,
      "/notes/CreateSpaceDialog": `
        import React from "react";
        export default function Mock(props) {
          globalThis.__createProps.push(props);
          return props.open
            ? React.createElement("div", { "data-create-dialog": "" }, "Create dialog")
            : null;
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
  ({ default: TeamSpacesPanel } = await vite.ssrLoadModule(
    "/components/settings/TeamSpacesPanel.tsx"
  ));
});

test.after(async () => {
  await happyWindow.happyDOM.close();
});

const h = React.createElement;
const doc = () => happyWindow.document;
const field = () => doc().querySelector('input[role="combobox"]');
const options = () => [...doc().querySelectorAll('[role="option"]')];
const optionTexts = () => options().map(text);
const rows = () => [...doc().querySelectorAll('[data-testid="assigned-space"]')].map(text);
const buttons = () => [...doc().querySelectorAll("button")];
const buttonNamed = (label) => buttons().find((button) => text(button) === label);
const optionNamed = (label) => options().find((option) => text(option) === label);
const titles = (toasts) => toasts.map((toast) => readable(toast.title));
const panelText = () => text(doc().body);

// ---- fixtures

const TEAM = {
  id: "t1",
  workspace_id: "w1",
  name: "Sales",
  slug: "sales",
  description: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const space = (id, name, { emoji = null, manage = true, teams = [] } = {}) => ({
  id,
  workspace_id: "w1",
  name,
  description: null,
  emoji,
  member_count: 3,
  teams,
  capabilities: { edit_notes: true, manage_members: manage, manage_settings: manage, leave: true },
});

const SALES = { id: "t1", name: "Sales", access: "member" };
const OTHER_TEAM = { id: "t9", name: "Design", access: "member" };

const workspaceWith = (createSpaces = true) => ({
  id: "w1",
  name: "Acme",
  role: "admin",
  capabilities: {
    manage_members: true,
    manage_teams: true,
    create_teams: true,
    create_spaces: createSpaces,
    manage_settings: true,
    manage_billing: false,
    delete_workspace: false,
    transfer_ownership: false,
    leave: true,
  },
});

// What a test steers: the directory the server lists and how the assignment answers.
async function mount(
  t,
  { spaces = [], createSpaces = true, status = "ready", team = TEAM, assign, reload } = {}
) {
  const calls = [];
  const events = [];
  const state = { spaces };
  globalThis.__calls = calls;
  globalThis.__server = { spaces: () => state.spaces, status, reload };
  globalThis.__toasts = [];
  globalThis.__createProps = [];
  globalThis.__actions = {
    assignTeamToSpaces: async (teamId, spaceIds) => {
      calls.push(["assign", teamId, spaceIds]);
      if (assign) return assign(teamId, spaceIds, state);
      state.spaces = state.spaces.map((entry) =>
        spaceIds.includes(entry.id) ? { ...entry, teams: [...entry.teams, SALES] } : entry
      );
      return { failures: [] };
    },
  };
  const container = doc().createElement("div");
  doc().body.appendChild(container);
  const root = createRoot(container);
  let mounted = true;
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await React.act(async () => root.unmount());
  };
  t.after(async () => {
    await unmount();
    container.remove();
    for (const name of ["__calls", "__server", "__toasts", "__createProps", "__actions"]) {
      delete globalThis[name];
    }
  });
  await React.act(async () => {
    root.render(
      h(TeamSpacesPanel, {
        team,
        workspace: workspaceWith(createSpaces),
        onChanged: () => events.push(["changed"]),
        onGone: () => events.push(["gone"]),
      })
    );
  });
  await ui.settle();
  return { calls, events, unmount, toasts: () => globalThis.__toasts };
}

const openPicker = async () => {
  await ui.focus(field());
  await ui.click(field());
};
const choose = async (label) => ui.click(optionNamed(label));

const SPACES = [
  space("s1", "Customer Calls", { emoji: "📞", teams: [SALES] }),
  space("s2", "Engineering", { emoji: "🔧", teams: [SALES, OTHER_TEAM] }),
  space("s3", "Planning", { emoji: "🚀" }),
  space("s4", "Product", { emoji: "📦" }),
  space("s5", "C-Suite", { emoji: "🏢", manage: false }),
  space("s6", "Other Team Only", { teams: [OTHER_TEAM] }),
];

// ---- tests

test("the assigned list shows the team's teamspaces", async (t) => {
  await mount(t, { spaces: SPACES });

  assert.deepEqual(rows(), ["Customer Calls", "Engineering"]);
  // Emoji and name only, no counts or actions.
  const glyphs = [...doc().querySelectorAll('[data-testid="assigned-space"] [data-glyph]')];
  assert.deepEqual(
    glyphs.map((glyph) => glyph.getAttribute("data-glyph")),
    ["📞", "🔧"]
  );
  assert.equal(field().getAttribute("placeholder"), "Find teamspaces to add");
  assert.ok(buttonNamed("Add teamspaces"));
});

test("only teamspaces the caller administers are offered", async (t) => {
  await mount(t, { spaces: SPACES });
  await openPicker();

  // Administered and not yet assigned. C-Suite isn't administered, and Customer Calls and
  // Engineering already hold the team.
  assert.deepEqual(optionTexts(), ["Planning", "Product", "Other Team Only"]);
  assert.equal(field().getAttribute("placeholder"), "Find teamspaces");
});

test("someone who administers none reads the list", async (t) => {
  await mount(t, {
    spaces: [
      space("s1", "Customer Calls", { manage: false, teams: [SALES] }),
      space("s3", "Planning", { manage: false }),
    ],
  });

  assert.deepEqual(rows(), ["Customer Calls"]);
  assert.equal(field(), null);
  assert.equal(buttonNamed("Add teamspaces"), undefined);
});

test("no teamspaces at all offers Create with create_spaces", async (t) => {
  await mount(t, { spaces: [] });

  assert.match(panelText(), /No teamspaces yet/);
  await ui.click(buttonNamed("Create teamspace"));
  const open = globalThis.__createProps.at(-1);
  assert.equal(open.open, true);
  assert.equal(open.initialTeam.id, "t1");
  assert.equal(open.initialWorkspaceId, "w1");
  assert.equal(open.revealOnCreate, false);
});

test("no teamspaces at all offers no Create without create_spaces", async (t) => {
  await mount(t, { spaces: [], createSpaces: false });

  assert.match(panelText(), /No teamspaces yet/);
  assert.equal(buttonNamed("Create teamspace"), undefined);
});

test("no assignments with choices invites adding, and the button opens the picker", async (t) => {
  await mount(t, { spaces: [space("s3", "Planning"), space("s4", "Product")] });

  assert.match(panelText(), /Not in any teamspace yet/);
  assert.equal(field(), null);
  await ui.click(buttonNamed("Add to teamspace"));
  assert.ok(field());
  assert.deepEqual(optionTexts(), ["Planning", "Product"]);
});

test("someone who administers nothing and has no assignments reads the empty text without a button", async (t) => {
  await mount(t, { spaces: [space("s3", "Planning", { manage: false })], createSpaces: false });

  assert.match(panelText(), /Not in any teamspace yet/);
  assert.equal(buttonNamed("Add to teamspace"), undefined);
  assert.equal(field(), null);
});

test("choosing teamspaces joins their names in the field and stages the add", async (t) => {
  await mount(t, { spaces: SPACES });
  await openPicker();
  await choose("Planning");
  await choose("Product");

  assert.equal(field().getAttribute("value") ?? field().value, "");
  await ui.press(field(), "Escape");
  assert.equal(field().value, "Planning, Product");
  assert.match(panelText(), /2 teamspaces selected/);
  assert.match(panelText(), /Add Sales to Planning and Product\./);
  assert.deepEqual(rows(), []);
});

test("Add assigns each teamspace in one call, clears, reloads and tells the table", async (t) => {
  const { calls, events, toasts } = await mount(t, { spaces: SPACES });
  await openPicker();
  await choose("Planning");
  await choose("Product");
  await ui.click(buttonNamed("Add teamspaces"));
  await ui.settle();

  assert.deepEqual(calls[0], ["assign", "t1", ["s3", "s4"]]);
  assert.deepEqual(titles(toasts()), ["Added Sales to 2 teamspaces."]);
  assert.deepEqual(rows(), ["Customer Calls", "Engineering", "Planning", "Product"]);
  assert.ok(calls.some(([name]) => name === "reload"));
  assert.deepEqual(events, [["changed"]]);
  assert.equal(field().value, "");
});

test("all failed keeps the selections", async (t) => {
  const { events, toasts } = await mount(t, {
    spaces: SPACES,
    assign: async (_team, spaceIds) => ({
      failures: spaceIds.map((spaceId) => ({ spaceId, error: new Error("offline") })),
    }),
  });
  await openPicker();
  await choose("Planning");
  await choose("Product");
  await ui.click(buttonNamed("Add teamspaces"));
  await ui.settle();

  // Inline while the panel is there, not a second time as a toast.
  assert.deepEqual(toasts(), []);
  assert.match(panelText(), /Couldn't add Sales\. Your selections are kept\. Try again\./);
  assert.match(panelText(), /2 teamspaces selected/);
  assert.ok(buttonNamed("Add teamspaces"));
  assert.deepEqual(events, []);
});

test("some failed keeps only those and names them", async (t) => {
  const { calls, toasts } = await mount(t, {
    spaces: SPACES,
    assign: async (_team, spaceIds, state) => {
      state.spaces = state.spaces.map((entry) =>
        entry.id === "s3" ? { ...entry, teams: [SALES] } : entry
      );
      return { failures: [{ spaceId: "s4", error: new Error("offline") }] };
    },
  });
  await openPicker();
  await choose("Planning");
  await choose("Product");
  await ui.click(buttonNamed("Add teamspaces"));
  await ui.settle();

  assert.deepEqual(toasts(), []);
  assert.match(panelText(), /Added Sales to Planning\. Couldn't add it to Product\. Try again\./);
  assert.match(panelText(), /1 teamspace selected/);
  assert.match(panelText(), /Couldn't add it to Product/);
  await ui.press(field(), "Escape");
  assert.equal(field().value, "Product");

  // Try again sends only what failed.
  await ui.click(buttonNamed("Add teamspaces"));
  await ui.settle();
  assert.deepEqual(calls.filter(([name]) => name === "assign").at(-1), ["assign", "t1", ["s4"]]);
});

test("a team that is gone is reported and closes the dialog", async (t) => {
  const { events, toasts } = await mount(t, {
    spaces: SPACES,
    assign: async (_team, spaceIds) => ({
      failures: spaceIds.map((spaceId) => ({
        spaceId,
        error: new CloudApiError("Team is not available in this workspace", 400),
      })),
    }),
  });
  await openPicker();
  await choose("Planning");
  await ui.click(buttonNamed("Add teamspaces"));
  await ui.settle();

  assert.deepEqual(titles(toasts()), ["Sales no longer exists."]);
  assert.deepEqual(events, [["gone"]]);
});

test("losing space admin is worded as that, not as a connection problem", async (t) => {
  const { toasts } = await mount(t, {
    spaces: SPACES,
    assign: async (_team, spaceIds) => ({
      failures: spaceIds.map((spaceId) => ({
        spaceId,
        error: new CloudApiError("Insufficient role", 403),
      })),
    }),
  });
  await openPicker();
  await choose("Planning");
  await ui.click(buttonNamed("Add teamspaces"));
  await ui.settle();

  assert.deepEqual(toasts(), []);
  assert.match(panelText(), /You can no longer manage Planning\./);
});

test("an answer that lands after the tab closed is still reported, and closes nothing", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { events, toasts, unmount } = await mount(t, {
    spaces: SPACES,
    assign: async (_team, spaceIds) => {
      await gate;
      return {
        failures: spaceIds.map((spaceId) => ({
          spaceId,
          error: new CloudApiError("Team is not available in this workspace", 400),
        })),
      };
    },
  });
  await openPicker();
  await choose("Planning");
  await ui.click(buttonNamed("Add teamspaces"));
  await unmount();
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(titles(toasts()), ["Sales no longer exists."]);
  assert.deepEqual(events, []);
});

test("no matches offers Create new, with the team staged", async (t) => {
  await mount(t, { spaces: SPACES });
  await openPicker();
  await ui.type(field(), "Research");

  assert.deepEqual(optionTexts(), []);
  assert.match(text(doc().body), /No matching teamspaces/);
  await ui.click(buttonNamed("Create new teamspace"));

  const props = globalThis.__createProps.at(-1);
  assert.equal(props.open, true);
  assert.equal(props.initialTeam.id, "t1");
  assert.equal(props.initialWorkspaceId, "w1");
  assert.equal(props.revealOnCreate, false);
});

test("Create new is also offered while teamspaces match, and only with create_spaces", async (t) => {
  await mount(t, { spaces: SPACES, createSpaces: false });
  await openPicker();

  assert.equal(options().length, 3);
  assert.equal(buttonNamed("Create new teamspace"), undefined);
});

test("a failed directory read offers Try again", async (t) => {
  await mount(t, { spaces: SPACES, status: "failed" });

  assert.match(panelText(), /Couldn't load teamspaces/);
  assert.ok(buttonNamed("Try again"));
});

const addPlanning = async () => {
  await openPicker();
  await choose("Planning");
  await ui.click(buttonNamed("Add teamspaces"));
};

test("a teamspace just added reads as assigned while the directory read is still out", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await mount(t, { spaces: SPACES, reload: () => gate });
  await addPlanning();
  await ui.settle();

  assert.deepEqual(rows(), ["Customer Calls", "Engineering", "Planning"]);
  await openPicker();
  assert.deepEqual(optionTexts(), ["Product", "Other Team Only"]);
  release(null);
});

test("a teamspace just added stays assigned and unoffered when the read fails", async (t) => {
  await mount(t, { spaces: SPACES, reload: async () => null });
  await addPlanning();
  await ui.settle();

  assert.deepEqual(rows(), ["Customer Calls", "Engineering", "Planning"]);
  await openPicker();
  assert.deepEqual(optionTexts(), ["Product", "Other Team Only"]);
});

test("focus returns to the field once an attempt settles", async (t) => {
  await mount(t, { spaces: SPACES });
  await addPlanning();
  await ui.settle();

  assert.equal(doc().activeElement, field());
});

test("a failure that outlived the panel is a toast", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { toasts, unmount } = await mount(t, {
    spaces: SPACES,
    assign: async (_team, spaceIds) => {
      await gate;
      return { failures: spaceIds.map((spaceId) => ({ spaceId, error: new Error("offline") })) };
    },
  });
  await addPlanning();
  await unmount();
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(titles(toasts()), ["Couldn't add Sales. Your selections are kept. Try again."]);
});

test("arrow keys walk the options, Enter toggles, and ArrowUp from nowhere starts at the last", async (t) => {
  await mount(t, { spaces: SPACES });
  await openPicker();
  const active = () => field().getAttribute("aria-activedescendant");
  const activeText = () => text(doc().getElementById(active()));

  await ui.press(field(), "ArrowUp");
  // Last row is "Create new teamspace", after the three options.
  assert.equal(activeText(), "Create new teamspace");
  await ui.press(field(), "ArrowUp");
  assert.equal(activeText(), "Other Team Only");
  await ui.press(field(), "ArrowDown");
  await ui.press(field(), "ArrowDown");
  assert.equal(activeText(), "Planning");
  await ui.press(field(), "Enter");
  assert.equal(optionNamed("Planning").getAttribute("aria-selected"), "true");
  await ui.press(field(), "Enter");
  assert.equal(optionNamed("Planning").getAttribute("aria-selected"), "false");
});

test("Create new is reachable from the keyboard", async (t) => {
  await mount(t, { spaces: SPACES });
  await openPicker();
  await ui.press(field(), "ArrowUp");
  await ui.press(field(), "Enter");

  const props = globalThis.__createProps.at(-1);
  assert.equal(props.open, true);
  assert.equal(props.initialTeam.id, "t1");
});

test("Space types into the search rather than choosing", async (t) => {
  await mount(t, { spaces: SPACES });
  await openPicker();
  await ui.press(field(), "ArrowDown");
  await ui.press(field(), " ");

  assert.equal(optionNamed("Planning").getAttribute("aria-selected"), "false");
});
