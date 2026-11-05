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

// Mounts the real split button, menus and dialog with the real Radix primitives in happy-dom. The
// services and the store are fakes the tests steer; strings come from the English file, so a
// missing key shows up as a missing label.

let CloudApiError;
let PeopleAddMenu;
let MemberRoleMenu;
let useAddPeopleToTeam;
let teamCoverage;
let createRoot;
let happyWindow;
let ui;
let vite;

test.before(async (t) => {
  ({ happyWindow, createRoot } = await installHappyDom());
  ui = interactions(happyWindow);
  vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-people-add-menu-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": ENGLISH_I18N_MOCK,
      "/i18n": "export default { t: (key) => key, language: 'en' };",
      "/ui/useToast":
        "export const useToast = () => ({ toast: (toast) => globalThis.__toasts.push(toast) });",
      "/stores/workspaceStore": `
        export const useWorkspaceStore = Object.assign(
          (selector) => selector(globalThis.__store),
          { getState: () => globalThis.__store }
        );
      `,
      "/services/TeamsService": `
        export const TeamsService = { list: (id) => globalThis.__api.listTeams(id) };
      `,
      "/services/SpacesService": `
        export const SpacesService = {
          listInWorkspace: (id) => globalThis.__api.listInWorkspace(id),
          coverage: (id, userIds) => globalThis.__api.coverage(id, userIds),
        };
      `,
      "/services/spaceActions": `
        export const addPeopleToTeam = (id, userIds) => globalThis.__api.addPeopleToTeam(id, userIds);
        export const addTeamMembers = (...args) => globalThis.__api.addTeamMembers(...args);
        export const addPeopleToSpace = (id, userIds) => globalThis.__api.addPeopleToSpace(id, userIds);
        export const localSpaceIdFor = (id) => globalThis.__api.localSpaceIdFor(id);
      `,
    },
  });
  ({ CloudApiError } = await vite.ssrLoadModule("/services/cloudApi.ts"));
  ({ PeopleAddMenu, useAddPeopleToTeam, teamCoverage } = await vite.ssrLoadModule(
    "/components/workspace/PeopleAddMenu.tsx"
  ));
  ({ MemberRoleMenu } = await vite.ssrLoadModule("/components/settings/MemberRoleMenu.tsx"));
});

test.after(async () => {
  await happyWindow.happyDOM.close();
});

const h = React.createElement;
const doc = () => happyWindow.document;

// ---- fixtures

const team = (id, name, overrides = {}) => ({
  id,
  workspace_id: "w1",
  name,
  slug: name.toLowerCase(),
  description: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  capabilities: { manage_members: true, manage_settings: true, leave: false },
  ...overrides,
});

// Deliberately out of name order.
const TEAMS = [team("t-sales", "Sales"), team("t-design", "Design"), team("t-eng", "Engineering")];

const WORKSPACE = { id: "w1", name: "Acme", role: "admin" };

const person = (userId, name, teams = []) => ({
  user_id: userId,
  name,
  email: `${userId}@openronnie.com`,
  image: null,
  role: "member",
  joined_at: "2026-01-01T00:00:00Z",
  teams,
});
const SALES = { id: "t-sales", name: "Sales" };
const ENG = { id: "t-eng", name: "Engineering" };
const LUCAS = person("lucas", "Lucas");
const MASON = person("mason", "Mason");
const NOAH = person("noah", "Noah", [SALES]);

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const networkError = () => new CloudApiError("Cloud API request failed", 0);

// What a test steers: how the fakes answer. Each test gets its own calls log.
async function mount(t, options = {}) {
  const {
    people = [LUCAS, MASON],
    teams = TEAMS,
    api = {},
    withCreateTeam = false,
    // A host that goes away mid-run, as the People page does when the selection empties.
    unmountable = false,
  } = options;
  const calls = [];
  const added = [];
  globalThis.__toasts = [];
  globalThis.__store = {
    refreshMembers: async (workspaceId) => {
      calls.push(["roster", workspaceId]);
    },
  };
  globalThis.__api = {
    listTeams: async (workspaceId) => {
      calls.push(["teams", workspaceId]);
      if (api.listTeams) return api.listTeams(workspaceId);
      return teams;
    },
    listInWorkspace: async () => [],
    coverage: async () => [],
    addPeopleToTeam: async (teamId, userIds) => {
      calls.push(["addBatch", teamId, userIds]);
      if (api.addPeopleToTeam) return api.addPeopleToTeam(teamId, userIds);
      return { added: userIds, already_members: [] };
    },
    // The single-member route: it lowers an admin to member, so the menu must never reach it.
    addTeamMembers: async (...args) => {
      calls.push(["upsert", ...args]);
      return { added: [], already_members: [] };
    },
    addPeopleToSpace: async () => ({ added: [], already_members: [] }),
    localSpaceIdFor: async () => null,
  };

  const container = doc().createElement("div");
  doc().body.appendChild(container);
  const root = createRoot(container);
  let unmounted = false;
  t.after(async () => {
    if (!unmounted) await React.act(async () => root.unmount());
    container.remove();
    for (const name of ["__toasts", "__store", "__api"]) delete globalThis[name];
  });
  const props = {
    workspace: WORKSPACE,
    people,
    onAdded: () => {
      calls.push(["cleared"]);
      added.push(people.map((member) => member.user_id));
    },
    onCreateTeam: withCreateTeam ? () => calls.push(["createTeam"]) : undefined,
  };
  await React.act(async () => {
    root.render(h(PeopleAddMenu, props));
  });
  await ui.settle();
  return {
    calls,
    added,
    callsTo: (name) => calls.filter(([call]) => call === name),
    rerender: async (nextPeople) => {
      await React.act(async () => root.render(h(PeopleAddMenu, { ...props, people: nextPeople })));
      await ui.settle();
    },
    unmount: async () => {
      assert.ok(unmountable, "this mount was not made unmountable");
      unmounted = true;
      await React.act(async () => root.unmount());
    },
  };
}

// ---- reading the screen

const buttons = () => [...doc().querySelectorAll("button")];
const labelButton = () => buttons().find((button) => text(button) === "Add to team");
const chevron = () => doc().querySelector("button[aria-label='More options']");
const items = () => [...doc().querySelectorAll('[role="menuitem"]')];
const itemNamed = (name) => items().find((item) => text(item) === name);
const rows = () => [...doc().querySelectorAll('[role="menuitemcheckbox"]')];
const rowFor = (name) => rows().find((row) => text(row).startsWith(name));
const dialogs = () => [...doc().querySelectorAll('[role="dialog"]')];
const dialogText = () => (dialogs().at(-1) ? text(dialogs().at(-1)) : null);
const dialogButton = (label) =>
  [...(dialogs().at(-1)?.querySelectorAll("button") ?? [])].find(
    (button) => text(button) === label
  );
const toastTitles = () => globalThis.__toasts.map((toast) => readable(toast.title ?? ""));
const menus = () => [...doc().querySelectorAll('[role="menu"]')];

// Radix opens a dropdown on ArrowDown from its trigger, and a submenu on ArrowRight from its item.
async function openLabelMenu() {
  await ui.press(labelButton(), "ArrowDown");
  await ui.settle();
}
async function openChevronMenu() {
  await ui.press(chevron(), "ArrowDown");
  await ui.settle();
}
async function openTeamSubmenu() {
  await openChevronMenu();
  await ui.press(itemNamed("Add to team"), "ArrowRight");
  await ui.settle();
}

async function choose(name) {
  await ui.click(rowFor(name));
  await ui.settle();
}

// ---- teamCoverage

test("teamCoverage counts only the selected people on that team", () => {
  const people = [
    person("a", "A", [SALES]),
    person("b", "B", [SALES, ENG]),
    person("c", "C", [ENG]),
    person("d", "D"),
  ];
  assert.equal(teamCoverage(people, "t-sales"), 2);
  assert.equal(teamCoverage(people, "t-eng"), 2);
  assert.equal(teamCoverage(people, "t-none"), 0);
  assert.equal(teamCoverage([], "t-sales"), 0);
});

test("teamCoverage: a roster with no teams field counts zero", () => {
  const { teams: _omitted, ...bare } = LUCAS;
  assert.equal(teamCoverage([bare, { ...bare, user_id: "x" }], "t-sales"), 0);
});

// ---- the split button and its menus

test("the bar's menu has both submenus", async (t) => {
  const { callsTo } = await mount(t, { withCreateTeam: true });

  assert.equal(callsTo("teams").length, 0, "teams are read when a menu first opens");
  await openChevronMenu();

  assert.deepEqual(items().map(text), [
    "Add to team",
    "Add to teamspace",
    "Create team with selected",
  ]);
  assert.equal(itemNamed("Add to team").getAttribute("aria-haspopup"), "menu");
  assert.equal(itemNamed("Add to teamspace").getAttribute("aria-haspopup"), "menu");
});

test("Create team with selected is hidden until something handles it", async (t) => {
  await mount(t);
  await openChevronMenu();
  assert.deepEqual(items().map(text), ["Add to team", "Add to teamspace"]);
});

test("Create team with selected calls the page's handler", async (t) => {
  const { callsTo } = await mount(t, { withCreateTeam: true });
  await openChevronMenu();
  await ui.click(itemNamed("Create team with selected"));
  await ui.settle();
  assert.equal(callsTo("createTeam").length, 1);
});

test("the label opens the team list itself, in name order", async (t) => {
  const { callsTo } = await mount(t);

  await openLabelMenu();

  assert.equal(callsTo("teams").length, 1);
  assert.deepEqual(rows().map(text), ["Design", "Engineering", "Sales"]);
  // No second level: the list is the menu.
  assert.deepEqual(items().map(text), []);
});

test("the team list is reachable from the chevron's submenu by keyboard", async (t) => {
  await mount(t);

  await openTeamSubmenu();

  assert.deepEqual(rows().map(text), ["Design", "Engineering", "Sales"]);
  // ArrowLeft closes only the submenu, leaving the parent menu to move through.
  await ui.press(rowFor("Design"), "ArrowLeft");
  await ui.settle();
  assert.equal(rows().length, 0);
  assert.ok(itemNamed("Add to team"), "the parent menu is still open");
});

test("a loading, failed or empty list says so", async (t) => {
  const listing = deferred();
  let attempts = 0;
  await mount(t, {
    api: {
      listTeams: () => {
        attempts += 1;
        return attempts === 1 ? listing.promise : [];
      },
    },
  });

  await openLabelMenu();
  assert.equal(readable(menus()[0].textContent), "Loading teams…");

  await React.act(async () => listing.reject(networkError()));
  await ui.settle();
  assert.match(readable(menus()[0].textContent), /Couldn't load teams/);
  await ui.click(
    [...doc().querySelectorAll('[role="menuitem"]')].find((i) => text(i) === "Try again")
  );
  await ui.settle();

  const none = items().find((item) => text(item) === "No teams yet");
  assert.ok(none, "an empty workspace says so");
  assert.equal(none.getAttribute("aria-disabled"), "true");
});

test("directory teams and teams the caller can't manage aren't offered", async (t) => {
  await mount(t, {
    teams: [
      team("t-sales", "Sales"),
      team("t-dir", "Directory", { directory_synced: true }),
      team("t-ro", "Read only", {
        capabilities: { manage_members: false, manage_settings: false, leave: true },
      }),
    ],
  });

  await openLabelMenu();
  assert.deepEqual(rows().map(text), ["Sales"]);
});

test("a partly covered team says how many are already on it", async (t) => {
  await mount(t, { people: [NOAH, LUCAS] });

  await openLabelMenu();

  assert.equal(text(rowFor("Sales")), "Sales · 1 of 2 already added");
  assert.equal(rowFor("Sales").getAttribute("aria-checked"), "mixed");
  assert.equal(rowFor("Design").getAttribute("aria-checked"), "false");
  assert.equal(text(rowFor("Design")), "Design");
});

test("a team everyone is already on is checked and can't be picked", async (t) => {
  const { callsTo } = await mount(t, { people: [NOAH, person("ana", "Ana", [SALES])] });

  await openLabelMenu();
  const sales = rowFor("Sales");
  assert.equal(sales.getAttribute("aria-checked"), "true");
  assert.equal(sales.getAttribute("aria-disabled"), "true");
  assert.equal(text(sales), "Sales");
  await ui.click(sales);
  await ui.settle();

  assert.equal(callsTo("addBatch").length, 0);
  assert.equal(dialogs().length, 0);
});

// ---- adding

test("adding uses the batch, never the upsert", async (t) => {
  const request = deferred();
  const { callsTo, calls } = await mount(t, { api: { addPeopleToTeam: () => request.promise } });

  await openLabelMenu();
  await choose("Sales");

  assert.deepEqual(callsTo("addBatch"), [["addBatch", "t-sales", ["lucas", "mason"]]]);
  // The menu closed and a dialog holds the screen while it runs.
  assert.equal(menus().length, 0);
  assert.match(dialogText(), /Adding 2 people…/);
  assert.match(dialogText(), /Keep this window open while they're added to Sales\./);
  assert.equal(dialogButton("Adding…").disabled, true);
  assert.equal(dialogButton("Cancel"), undefined);

  await React.act(async () => request.resolve({ added: ["lucas", "mason"], already_members: [] }));
  await ui.settle();
  assert.equal(dialogs().length, 0);
  assert.equal(calls.filter(([call]) => call === "upsert").length, 0);
});

test("the roster is read again before the selection clears", async (t) => {
  const { calls } = await mount(t);

  await openLabelMenu();
  await choose("Design");

  assert.deepEqual(
    calls.map(([call]) => call).filter((call) => call === "roster" || call === "cleared"),
    ["roster", "cleared"]
  );
  assert.deepEqual(toastTitles(), ["Added 2 members to Design"]);
});

test("a double click sends one request", async (t) => {
  const request = deferred();
  const { callsTo } = await mount(t, { api: { addPeopleToTeam: () => request.promise } });

  await openLabelMenu();
  const row = rowFor("Design");
  await React.act(async () => {
    row.click();
    row.click();
  });
  await ui.settle();
  await React.act(async () => request.resolve({ added: ["lucas", "mason"], already_members: [] }));
  await ui.settle();

  assert.equal(callsTo("addBatch").length, 1);
});

test("one person added, one already there reads as the frame does", async (t) => {
  await mount(t, {
    people: [NOAH, LUCAS],
    api: { addPeopleToTeam: async () => ({ added: ["lucas"], already_members: ["noah"] }) },
  });

  await openLabelMenu();
  await choose("Sales");

  assert.deepEqual(toastTitles(), ["Added Lucas to Sales. Noah was already a member."]);
});

test("several already there reads in the plural, and a crowd falls back to a count", async (t) => {
  const answers = [
    { added: ["lucas"], already_members: ["noah", "ana"] },
    { added: ["a", "b", "c"], already_members: ["lucas"] },
  ];
  await mount(t, {
    people: [NOAH, person("ana", "Ana"), LUCAS],
    api: { addPeopleToTeam: async () => answers.shift() },
  });

  await openLabelMenu();
  await choose("Design");
  assert.deepEqual(toastTitles(), ["Added Lucas to Design. Noah and Ana were already members."]);

  await openLabelMenu();
  await choose("Design");
  assert.deepEqual(toastTitles().at(-1), "Added 3 members to Design");
});

test("nobody new counts everyone selected", async (t) => {
  await mount(t, {
    api: { addPeopleToTeam: async () => ({ added: [], already_members: ["lucas", "mason"] }) },
  });

  await openLabelMenu();
  await choose("Design");

  assert.deepEqual(toastTitles(), ["Added 2 members to Design"]);
});

test("a failure keeps the selection and offers Try again", async (t) => {
  let attempts = 0;
  const { callsTo, added } = await mount(t, {
    api: {
      addPeopleToTeam: async (_id, userIds) => {
        attempts += 1;
        if (attempts === 1) throw networkError();
        return { added: userIds, already_members: [] };
      },
    },
  });

  await openLabelMenu();
  await choose("Design");

  assert.match(dialogText(), /Couldn't add 2 people/);
  assert.match(dialogText(), /They haven't been added to Design\. Your selection is kept\./);
  assert.deepEqual(added, []);
  assert.deepEqual(toastTitles(), []);

  await ui.click(dialogButton("Try again"));
  await ui.settle();

  assert.deepEqual(callsTo("addBatch"), [
    ["addBatch", "t-design", ["lucas", "mason"]],
    ["addBatch", "t-design", ["lucas", "mason"]],
  ]);
  assert.equal(dialogs().length, 0);
  assert.deepEqual(added, [["lucas", "mason"]]);
  assert.deepEqual(toastTitles(), ["Added 2 members to Design"]);
});

test("a lost answer on Try again counts the people this action added", async (t) => {
  // The first request landed for Lucas and Mason but its answer was lost; the retry finds both in.
  // Noah was on the team before this action started, so he alone was already a member.
  const answers = [
    () => {
      throw networkError();
    },
    () => ({ added: [], already_members: ["lucas", "mason", "noah"] }),
  ];
  const { added } = await mount(t, {
    people: [NOAH, LUCAS, MASON],
    api: { addPeopleToTeam: async () => answers.shift()() },
  });

  await openLabelMenu();
  await choose("Design");
  await ui.click(dialogButton("Try again"));
  await ui.settle();

  // Design, not Sales: Noah is on Sales only. Everyone selected, with nobody "already there".
  assert.deepEqual(toastTitles(), ["Added 3 members to Design"]);
  assert.equal(added.length, 1);
});

test("on Try again, only people who were on the team before count as already there", async (t) => {
  const answers = [
    () => {
      throw networkError();
    },
    () => ({ added: [], already_members: ["lucas", "noah"] }),
  ];
  await mount(t, {
    people: [NOAH, LUCAS],
    api: { addPeopleToTeam: async () => answers.shift()() },
  });

  await openLabelMenu();
  await choose("Sales");
  await ui.click(dialogButton("Try again"));
  await ui.settle();

  assert.deepEqual(toastTitles(), ["Added Lucas to Sales. Noah was already a member."]);
});

test("Cancel on a failure keeps the selection and hands focus back to the button", async (t) => {
  const { added } = await mount(t, {
    api: {
      addPeopleToTeam: async () => {
        throw networkError();
      },
    },
  });

  await openChevronMenu();
  await ui.press(itemNamed("Add to team"), "ArrowRight");
  await ui.settle();
  await choose("Design");
  await ui.click(dialogButton("Cancel"));
  await ui.settle();
  await React.act(async () => {
    await new Promise((resolve) => happyWindow.requestAnimationFrame(resolve));
  });

  assert.equal(dialogs().length, 0);
  assert.deepEqual(added, []);
  assert.deepEqual(toastTitles(), []);
  // Compared as a boolean: a failed assert.equal on DOM nodes spends minutes printing the document.
  assert.ok(doc().activeElement === chevron(), "focus is on the button that opened the menu");
});

test("someone who left is named by the server's text and the roster refreshes", async (t) => {
  const { callsTo, added } = await mount(t, {
    api: {
      addPeopleToTeam: async () => {
        throw new CloudApiError(
          "Mason is no longer a member of Acme",
          400,
          "not_workspace_members",
          { user_ids: ["mason"] }
        );
      },
    },
  });

  await openLabelMenu();
  await choose("Design");

  assert.match(dialogText(), /Couldn't add 2 people/);
  assert.match(dialogText(), /Mason is no longer a member of Acme/);
  assert.deepEqual(callsTo("roster"), [["roster", "w1"]]);
  assert.deepEqual(added, []);

  // Try again adds whoever is left.
  await ui.click(dialogButton("Try again"));
  await ui.settle();
  assert.deepEqual(callsTo("addBatch").at(-1), ["addBatch", "t-design", ["lucas"]]);
});

test("a team deleted meanwhile says so and the list is read again", async (t) => {
  const { callsTo, added } = await mount(t, {
    api: {
      addPeopleToTeam: async () => {
        throw new CloudApiError("Team not found", 404);
      },
    },
  });

  await openLabelMenu();
  await choose("Design");

  // Nothing a retry would change, so the dialog gives way to a toast.
  assert.equal(dialogs().length, 0);
  assert.deepEqual(toastTitles(), ["Design no longer exists."]);
  assert.equal(globalThis.__toasts[0].variant, "destructive");
  assert.deepEqual(added, []);
  assert.equal(callsTo("teams").length, 2);
});

test("losing the right to manage says that, not that the team is gone", async (t) => {
  await mount(t, {
    api: {
      addPeopleToTeam: async () => {
        throw new CloudApiError("Insufficient role", 403);
      },
    },
  });

  await openLabelMenu();
  await choose("Design");

  assert.equal(dialogs().length, 0);
  assert.deepEqual(toastTitles(), ["You can no longer manage Design."]);
});

test("a directory-managed team shows the server's reason on the dialog", async (t) => {
  await mount(t, {
    api: {
      addPeopleToTeam: async () => {
        throw new CloudApiError("Team membership is managed by directory sync", 409);
      },
    },
  });

  await openLabelMenu();
  await choose("Design");

  assert.match(dialogText(), /Team membership is managed by directory sync/);
});

test("a failure after the page moved on still reaches the user as a toast", async (t) => {
  const request = deferred();
  const { added, unmount } = await mount(t, {
    unmountable: true,
    api: { addPeopleToTeam: () => request.promise },
  });

  await openLabelMenu();
  await choose("Design");
  await unmount();
  await React.act(async () => request.reject(networkError()));
  await ui.settle();

  assert.deepEqual(toastTitles(), ["Couldn't add 2 people"]);
  assert.equal(globalThis.__toasts[0].variant, "destructive");
  assert.deepEqual(added, []);
});

test("a success after the page moved on still toasts, and never clears a selection that's gone", async (t) => {
  const request = deferred();
  const { added, unmount } = await mount(t, {
    unmountable: true,
    api: { addPeopleToTeam: () => request.promise },
  });

  await openLabelMenu();
  await choose("Design");
  await unmount();
  await React.act(async () => request.resolve({ added: ["lucas", "mason"], already_members: [] }));
  await ui.settle();

  assert.deepEqual(toastTitles(), ["Added 2 members to Design"]);
  assert.deepEqual(added, []);
});

// ---- Add to teamspace, now a submenu of the same button

test("Add to teamspace still works from its submenu", async (t) => {
  await mount(t);
  globalThis.__api.listInWorkspace = async () => [
    { id: "cloud-calls", workspace_id: "w1", name: "Customer Calls", emoji: "📞", teams: [] },
  ];
  globalThis.__api.addPeopleToSpace = async (id, userIds) => {
    globalThis.__spaceCall = [id, userIds];
    return { added: userIds, already_members: [] };
  };

  await openChevronMenu();
  await ui.press(itemNamed("Add to teamspace"), "ArrowRight");
  await ui.settle();
  await choose("Customer Calls");

  assert.deepEqual(globalThis.__spaceCall, ["cloud-calls", ["lucas", "mason"]]);
  assert.deepEqual(toastTitles(), ["Added 2 people to Customer Calls"]);
  delete globalThis.__spaceCall;
});

// ---- the row menu

test("the row menu adds one person", async (t) => {
  const calls = [];
  globalThis.__toasts = [];
  globalThis.__store = {
    refreshMembers: async (workspaceId) => {
      calls.push(["roster", workspaceId]);
    },
  };
  globalThis.__api = {
    listTeams: async () => TEAMS,
    addPeopleToTeam: async (teamId, userIds) => {
      calls.push(["addBatch", teamId, userIds]);
      return { added: userIds, already_members: [] };
    },
    addTeamMembers: async () => {
      calls.push(["upsert"]);
      return { added: [], already_members: [] };
    },
  };
  const container = doc().createElement("div");
  doc().body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => {
    await React.act(async () => root.unmount());
    container.remove();
    for (const name of ["__toasts", "__store", "__api"]) delete globalThis[name];
  });

  // What the People page wires: one controller for the rows, its dialog beside the table.
  function Rows() {
    const teamAdd = useAddPeopleToTeam(WORKSPACE);
    return h(
      React.Fragment,
      null,
      h(MemberRoleMenu, {
        member: NOAH,
        isSelf: false,
        canManage: true,
        canTransfer: false,
        pending: false,
        onRoleChange: () => {},
        onTransfer: () => {},
        onRemove: () => {},
        workspace: WORKSPACE,
        teamAdd,
      }),
      teamAdd.dialog
    );
  }
  await React.act(async () => root.render(h(Rows)));
  await ui.settle();

  await ui.press(doc().querySelector("button[aria-haspopup='menu']"), "ArrowDown");
  await ui.settle();
  await ui.press(itemNamed("Add to team"), "ArrowRight");
  await ui.settle();

  // Noah is on Sales already, so for one person it is a ticked, disabled row.
  assert.equal(rowFor("Sales").getAttribute("aria-checked"), "true");
  assert.equal(rowFor("Sales").getAttribute("aria-disabled"), "true");
  await choose("Design");

  assert.deepEqual(
    calls.filter(([call]) => call === "addBatch"),
    [["addBatch", "t-design", ["noah"]]]
  );
  assert.equal(calls.filter(([call]) => call === "upsert").length, 0);
  assert.deepEqual(toastTitles(), ["Added 1 member to Design"]);
});
