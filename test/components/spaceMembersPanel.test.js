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

// Mounts the real panel with the real Radix menus, popover and dialog in happy-dom. The services
// and stores are fakes the tests steer; strings come from the English file, so a missing key
// shows up as a missing label.

let CloudApiError;
let SpaceMembersPanel;
let createRoot;
let happyWindow;
let ui;
let vite;

test.before(async (t) => {
  ({ happyWindow, createRoot } = await installHappyDom());
  ui = interactions(happyWindow);
  vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-space-members-panel-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": ENGLISH_I18N_MOCK,
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
      "/services/SpacesService": `
        export const SpacesService = {
          listMembers: (id) => globalThis.__spaces.listMembers(id),
          listInvitations: (id) => globalThis.__spaces.listInvitations(id),
        };
      `,
      "/services/TeamsService":
        "export const TeamsService = { list: (id) => globalThis.__spaces.listTeams(id) };",
      "/services/spaceActions": `
        const call = (name) => (...args) => globalThis.__actions[name](...args);
        export const addPeopleToSpace = call("addPeopleToSpace");
        export const assignTeamToSpace = call("assignTeamToSpace");
        export const setSpaceTeamAccess = call("setSpaceTeamAccess");
        export const unassignTeamFromSpace = call("unassignTeamFromSpace");
        export const setSpaceMemberRole = call("setSpaceMemberRole");
        export const removeSpaceMember = call("removeSpaceMember");
        export const leaveSpace = call("leaveSpace");
        export const requestSpacesResync = call("requestSpacesResync");
      `,
      "/services/invitePeople": `
        export const invitePeople = {
          sendInvitations: (input) => globalThis.__actions.sendInvitations(input),
        };
      `,
    },
  });
  ({ CloudApiError } = await vite.ssrLoadModule("/services/cloudApi.ts"));
  ({ default: SpaceMembersPanel } = await vite.ssrLoadModule(
    "/components/notes/SpaceMembersPanel.tsx"
  ));
});

test.after(async () => {
  await happyWindow.happyDOM.close();
});

const h = React.createElement;
const doc = () => happyWindow.document;

// ---- fixtures

const entry = (userId, name, overrides = {}) => ({
  user_id: userId,
  role: "member",
  joined_at: "2026-01-01T00:00:00Z",
  email: `${userId}@openronnie.com`,
  name,
  image: null,
  direct_role: "member",
  via_teams: [],
  ...overrides,
});

const workspaceMember = (userId, name, email = `${userId}@openronnie.com`) => ({
  user_id: userId,
  role: "member",
  joined_at: "2026-01-01T00:00:00Z",
  email,
  name,
  image: null,
});

const group = (id, name, memberCount, emoji = null) => ({
  id,
  workspace_id: "w1",
  name,
  slug: id,
  description: null,
  emoji,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  member_count: memberCount,
});

const invitation = (id, email, role = "member") => ({
  id,
  email,
  role,
  expires_at: "2026-02-01T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z",
});

// The current user is Ronnie, the teamspace's only admin.
const MEMBERS = [
  entry("me", "Ronnie", { role: "admin", direct_role: "admin" }),
  entry("misa", "Misa"),
  entry("ravi", "Ravi"),
  entry("lila", "Lila"),
  entry("jin", "Jin", {
    direct_role: null,
    via_teams: [{ team_id: "sales", name: "Sales", role: "member", access: "member" }],
  }),
];

// Everyone in the workspace, whether or not they are in the teamspace yet.
const ROSTER = [
  workspaceMember("me", "Ronnie", "ronnie@openronnie.com"),
  workspaceMember("misa", "Misa"),
  workspaceMember("ravi", "Ravi"),
  workspaceMember("lila", "Lila"),
  workspaceMember("jin", "Jin"),
  workspaceMember("ethan", "Ethan"),
  workspaceMember("saket", "Saket"),
];
const GROUPS = [group("sales", "Sales", 5), group("design", "Design Team", 2, "🎨")];
const INVITATIONS = [invitation("inv-1", "clark@gmail.com")];

const workspaceCapabilities = (overrides) => ({
  manage_members: true,
  manage_teams: true,
  create_spaces: true,
  manage_settings: false,
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
  capabilities: workspaceCapabilities(overrides),
});

const spaceFor = (canManage, overrides = {}) => ({
  id: 7,
  cloud_space_id: "cloud-1",
  workspace_id: "w1",
  name: "Customer Calls",
  emoji: "📞",
  my_role: canManage ? "admin" : "member",
  my_direct_role: canManage ? "admin" : "member",
  capabilities: {
    edit_notes: true,
    manage_members: canManage,
    manage_settings: canManage,
    leave: true,
  },
  teams: [{ id: "sales", name: "Sales", access: "member" }],
  ...overrides,
});

const ok = (emails, onResult) => {
  for (const email of emails) onResult(email, { ok: true, emailSent: true });
};

// What a test steers: how the fakes answer. Each test gets its own calls log and server state.
async function mount(
  t,
  {
    canManage = true,
    canInvite = true,
    workspaceAdmin = false,
    members = MEMBERS,
    invitations = INVITATIONS,
    groups = GROUPS,
    spaceTeams,
    listMembers,
    listInvitations,
    listTeams,
    refreshMembers,
    actions = {},
  } = {}
) {
  const calls = [];
  const state = { members: [...members], invitations: [...invitations] };
  const space = spaceFor(canManage, spaceTeams ? { teams: spaceTeams } : {});
  const store = {
    workspaces: [workspaceWith({ manage_members: canInvite, manage_settings: workspaceAdmin })],
    members: ROSTER,
    membersWorkspaceId: "w1",
    refreshMembers: async (workspaceId) => {
      calls.push(["roster", workspaceId]);
      await refreshMembers?.(workspaceId, store);
    },
  };
  globalThis.__store = store;
  globalThis.__toasts = [];
  globalThis.__spaces = {
    listMembers: async (id) => {
      calls.push(["members", id]);
      if (listMembers) return listMembers(state);
      return [...state.members];
    },
    listInvitations: async (id) => {
      calls.push(["invitations", id]);
      if (listInvitations) return listInvitations(state);
      // A read answers with its own list, as a request does.
      return [...state.invitations];
    },
    listTeams: async (id) => {
      calls.push(["teams", id]);
      if (listTeams) return listTeams();
      return groups;
    },
  };
  globalThis.__actions = {
    addPeopleToSpace: async (cloudSpaceId, userIds) => {
      calls.push(["addPeopleToSpace", cloudSpaceId, userIds]);
      return actions.addPeopleToSpace
        ? actions.addPeopleToSpace(cloudSpaceId, userIds, state)
        : { added: userIds, already_members: [] };
    },
    assignTeamToSpace: async (spaceArg, teamId) => {
      calls.push(["assignTeamToSpace", spaceArg, teamId]);
      return actions.assignTeamToSpace?.(spaceArg, teamId, state);
    },
    setSpaceTeamAccess: async (spaceArg, teamId, access) => {
      calls.push(["setSpaceTeamAccess", spaceArg, teamId, access]);
      return actions.setSpaceTeamAccess?.(spaceArg, teamId, access, state);
    },
    unassignTeamFromSpace: async (spaceArg, teamId) => {
      calls.push(["unassignTeamFromSpace", spaceArg, teamId]);
      return actions.unassignTeamFromSpace?.(spaceArg, teamId, state);
    },
    setSpaceMemberRole: async (spaceArg, userId, role) => {
      calls.push(["setSpaceMemberRole", spaceArg, userId, role]);
      return actions.setSpaceMemberRole?.(spaceArg, userId, role, state);
    },
    removeSpaceMember: async (spaceArg, userId) => {
      calls.push(["removeSpaceMember", spaceArg, userId]);
      if (actions.removeSpaceMember) return actions.removeSpaceMember(spaceArg, userId, state);
      state.members = state.members.filter((member) => member.user_id !== userId);
      return { removed: true, still_via_teams: [] };
    },
    leaveSpace: async (spaceArg, userId) => {
      calls.push(["leaveSpace", spaceArg, userId]);
      if (actions.leaveSpace) return actions.leaveSpace(spaceArg, userId, state);
      state.members = state.members.filter((member) => member.user_id !== userId);
      return { removed: true, still_via_teams: [] };
    },
    requestSpacesResync: () => {
      calls.push(["requestSpacesResync"]);
    },
    sendInvitations: async (input) => {
      calls.push(["sendInvitations", input]);
      if (actions.sendInvitations) return actions.sendInvitations(input, state);
      return ok(input.emails, input.onResult);
    },
  };

  const container = doc().createElement("div");
  doc().body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => {
    await React.act(async () => root.unmount());
    container.remove();
    for (const name of ["__store", "__toasts", "__spaces", "__actions"]) delete globalThis[name];
  });
  const lefts = [];
  const onLeft = () => lefts.push(true);
  await React.act(async () => {
    root.render(h(SpaceMembersPanel, { space, onLeft }));
  });
  await ui.settle();
  return {
    space,
    state,
    calls,
    lefts,
    callsTo: (name) => calls.filter(([call]) => call === name),
    rerender: async () => {
      await React.act(async () => root.render(h(SpaceMembersPanel, { space, onLeft })));
      await ui.settle();
    },
  };
}

// ---- reading the screen

const tableRows = () => [...doc().querySelectorAll("tbody tr")];
const rowTexts = () => tableRows().map(text);
const rowFor = (label) => tableRows().find((row) => text(row).startsWith(label));
const roleTrigger = (row) => row.querySelector("button[aria-haspopup='menu']") ?? null;
const roleTriggers = () => [...doc().querySelectorAll("tbody button[aria-haspopup='menu']")];
const peopleInput = () => doc().querySelector('input[role="combobox"]');
const options = () => [...doc().querySelectorAll('[role="option"]')];
const chips = () => [...doc().querySelectorAll("[data-chip]")];
const chipTexts = () => chips().map(text);
const buttons = () => [...doc().querySelectorAll("button")];
const buttonNamed = (label) => buttons().find((button) => text(button) === label);
const addButton = () =>
  buttonNamed("Add members") ?? buttonNamed("Adding…") ?? buttonNamed("Try again");
const lineElement = () => doc().querySelector('p[role="alert"], p[role="status"]');
const lineText = () => (lineElement() ? text(lineElement()) : null);
const toastTitles = () => globalThis.__toasts.map((toast) => readable(toast.title ?? ""));
const dialogs = () => [...doc().querySelectorAll('[role="dialog"]')];
const dialogText = () => (dialogs().at(-1) ? text(dialogs().at(-1)) : null);
const dialogButton = (label) =>
  [...(dialogs().at(-1)?.querySelectorAll("button") ?? [])].find(
    (button) => text(button) === label
  );

async function pickPerson(label) {
  await ui.focus(peopleInput());
  await ui.click(options().find((option) => text(option).startsWith(label)));
}

async function addAddress(address) {
  await ui.focus(peopleInput());
  await ui.type(peopleInput(), address);
  await ui.press(peopleInput(), "Enter");
}

// Radix opens a dropdown on ArrowDown from its trigger.
async function openMenu(trigger) {
  await ui.press(trigger, "ArrowDown");
  await ui.settle();
}

const menuItems = () => [...doc().querySelectorAll('[role="menuitemradio"], [role="menuitem"]')];
const menuItem = (label) => menuItems().find((item) => text(item).startsWith(label));

// ---- the table

test("admins, invitations, groups, then everyone else", async (t) => {
  await mount(t);

  assert.deepEqual(
    tableRows().map((row) => text(row).split(" ")[0]),
    ["Ronnie", "clark@gmail.com", "Sales", "Misa", "Ravi", "Lila", "Jin"]
  );
  const headers = [...doc().querySelectorAll("thead th")].map(text);
  assert.deepEqual(headers, ["Name", "Teamspace role"]);
});

test("each kind of row says what it is", async (t) => {
  await mount(t);

  assert.equal(text(rowFor("Ronnie")), "Ronnie me@openronnie.com Admin");
  assert.equal(text(rowFor("Misa")), "Misa misa@openronnie.com Member");
  assert.equal(text(rowFor("clark@gmail.com")), "clark@gmail.com Invitation pending Member");
  assert.equal(text(rowFor("Sales")), "Sales 5 people Member");
  assert.equal(
    text(rowFor("Jin")),
    "Jin jin@openronnie.com · Sales Member · via Sales",
    "an inherited person names the group beside the email and in the role cell"
  );
});

test("an email stays left-to-right and names keep their own direction", async (t) => {
  await mount(t);

  assert.ok(rowFor("clark@gmail.com").querySelector('bdi[dir="ltr"]'));
  assert.ok(rowFor("Misa").querySelector('bdi[dir="ltr"]'));
  assert.equal(rowFor("Misa").querySelector("[dir='auto']").textContent, "Misa");
});

test("an inherited admin reads Admin via its group", async (t) => {
  await mount(t, {
    members: [
      entry("me", "Ronnie", { role: "admin", direct_role: "admin" }),
      entry("jin", "Jin", {
        role: "admin",
        direct_role: null,
        via_teams: [{ team_id: "sales", name: "Sales", role: "admin", access: "admin" }],
      }),
    ],
  });

  assert.equal(text(rowFor("Jin")), "Jin jin@openronnie.com · Sales Admin · via Sales");
});

test("an inherited person has no menu; an invitation has no menu; a person with a direct role has one", async (t) => {
  await mount(t);

  assert.equal(roleTrigger(rowFor("Jin")), null);
  assert.equal(roleTrigger(rowFor("clark@gmail.com")), null);
  assert.ok(roleTrigger(rowFor("Misa")));
  assert.ok(roleTrigger(rowFor("Sales")), "a group's access has one too");
  assert.equal(roleTriggers().length, 5, "Ronnie, Sales, Misa, Ravi and Lila");
});

test("a member sees the table without the field or menus", async (t) => {
  const { callsTo } = await mount(t, { canManage: false });

  assert.equal(peopleInput(), null);
  assert.ok(!addButton(), "no Add members button");
  assert.equal(roleTriggers().length, 0);
  assert.equal(text(rowFor("Misa")), "Misa misa@openronnie.com Member");
  assert.equal(text(rowFor("Sales")), "Sales 5 people Member");
  // Only someone who manages the teamspace can read its invitations.
  assert.equal(callsTo("invitations").length, 0);
  assert.ok(!rowFor("clark@gmail.com"));
  assert.equal(callsTo("roster").length, 0, "nothing to pick from, so the roster isn't read");
});

test("only the rows scroll: the header and the field stay put", async (t) => {
  await mount(t);

  const scroller = doc().querySelector("tbody").closest("[class*='overflow-y-auto']");
  assert.ok(scroller, "the rows sit in a scroller");
  assert.match(scroller.className, /max-h-/);
  assert.ok(
    scroller.contains(doc().querySelector("thead")),
    "the sticky header scrolls with its table"
  );
  assert.ok(!scroller.contains(peopleInput()), "the field is outside the scroller");
});

test("a group's count is left out when the groups can't be read", async (t) => {
  await mount(t, {
    listTeams: async () => {
      throw new Error("offline");
    },
  });

  assert.equal(text(rowFor("Sales")), "Sales Member");
});

test("a failed invitation read still shows members", async (t) => {
  await mount(t, {
    listInvitations: async () => {
      throw new Error("offline");
    },
  });

  assert.equal(rowTexts().length, 6, "everything but the invitation");
  assert.ok(rowFor("Misa"));
  assert.ok(!rowFor("clark@gmail.com"));
  assert.equal(lineText(), null, "the failure says nothing");
});

test("invitations that can't be read again are hidden, not shown out of date", async (t) => {
  let reads = 0;
  await mount(t, {
    listInvitations: async (state) => {
      reads += 1;
      if (reads > 1) throw new Error("offline");
      return state.invitations;
    },
  });
  assert.ok(rowFor("clark@gmail.com"));

  await addAddress("alex@example.com");
  await ui.click(addButton());
  await ui.settle();

  assert.ok(!rowFor("clark@gmail.com"));
  assert.ok(rowFor("Misa"), "the members stay");
});

test("a teamspace nobody is in says so", async (t) => {
  await mount(t, { members: [], invitations: [], spaceTeams: [] });
  assert.deepEqual(rowTexts(), ["No one has been added yet"]);
});

test("the first read shows a placeholder, never the empty message", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await mount(t, {
    listMembers: async (state) => {
      await gate;
      return state.members;
    },
  });

  assert.deepEqual(rowTexts(), [""]);
  assert.ok(!doc().body.textContent.includes("No one has been added yet"));

  await React.act(async () => release());
  await ui.settle();
  assert.ok(rowFor("Misa"));
});

test("a failed member read says so and retries", async (t) => {
  let failures = 1;
  const { callsTo } = await mount(t, {
    listMembers: async (state) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("offline");
      }
      return state.members;
    },
  });

  assert.equal(tableRows().length, 1, "one row says what happened");
  assert.match(text(tableRows()[0]), /Couldn't load members\./);

  await ui.click(buttonNamed("Retry"));
  await ui.settle();

  assert.equal(callsTo("members").length, 2);
  assert.ok(rowFor("Misa"));
});

// ---- the people field

test("Add members waits for something to add, and for the groups and people to load", async (t) => {
  await mount(t);

  const button = addButton();
  assert.equal(text(button), "Add members");
  assert.equal(button.disabled, true);
  assert.equal(peopleInput().getAttribute("placeholder"), "Names, emails, or groups");

  await pickPerson("Ethan");
  assert.equal(addButton().disabled, false);
});

test("the field offers who isn't here yet, and shows who is", async (t) => {
  await mount(t);

  await ui.focus(peopleInput());
  const texts = options().map(text);
  assert.ok(texts.includes("Ethan ethan@openronnie.com"));
  assert.ok(texts.includes("Misa Already has access"));
  assert.ok(texts.includes("Sales Already has access · 5 people"));
  assert.ok(texts.includes("Design Team 2 people"));
});

test("an address with an invitation already waiting reads as pending, not offered again", async (t) => {
  await mount(t);

  await ui.focus(peopleInput());
  await ui.type(peopleInput(), "Clark@Gmail.com");

  assert.deepEqual(options().map(text), ["Clark@Gmail.com Invitation pending"]);
});

test("people who can't invite aren't offered an address", async (t) => {
  await mount(t, { canInvite: false });

  await ui.focus(peopleInput());
  await ui.type(peopleInput(), "alex@example.com");

  assert.deepEqual(options().map(text), []);
  assert.match(text(doc().querySelector('[role="status"]')), /No people or groups found/);
  assert.match(text(doc().querySelector('[role="status"]')), /Try another name\./);
});

test("someone who can invite chooses the invitation's role", async (t) => {
  await mount(t);

  await ui.focus(peopleInput());
  await ui.type(peopleInput(), "alex@example.com");

  assert.match(text(options()[0]), /New to workspace/);
  assert.ok(options()[0].querySelector('[aria-haspopup="menu"]'), "the invite row has a role menu");
});

test("Add members sits beside the field, and the chips go under both", async (t) => {
  await mount(t);
  await pickPerson("Ethan");

  const fieldRoot = peopleInput().parentElement.parentElement;
  assert.ok(fieldRoot.contains(addButton()), "the button is part of the field's row");
  assert.equal(chips()[0].closest("ul").parentElement, fieldRoot);
  assert.ok(!chips()[0].closest("ul").contains(addButton()));
});

test("what is staged is explained under the field", async (t) => {
  await mount(t);
  assert.equal(lineText(), null, "nothing staged, nothing said");

  await addAddress("alex@example.com");
  assert.equal(
    lineText(),
    "New people are invited when you add them. Teamspace access starts after they accept."
  );

  await pickPerson("Design Team");
  assert.equal(
    lineText(),
    "New people are invited when you add them. Teamspace access starts after they accept. " +
      "Everyone in Design Team will inherit Member access to Customer Calls."
  );
});

test("a group alone says what it grants, and several say so together", async (t) => {
  await mount(t, { spaceTeams: [] });

  await pickPerson("Design Team");
  assert.equal(lineText(), "Everyone in Design Team will inherit Member access to Customer Calls.");

  await pickPerson("Sales");
  assert.equal(
    lineText(),
    "Everyone in these groups will inherit Member access to Customer Calls."
  );
});

test("an invalid address blocks Add members and says the rest are kept", async (t) => {
  await mount(t);

  await pickPerson("Ethan");
  await ui.type(peopleInput(), "alex@");
  await ui.press(peopleInput(), "Enter");

  assert.deepEqual(chipTexts(), ["Ethan", "alex@ · Workspace Member"]);
  assert.equal(lineText(), "Enter a valid email address. Your selected people are kept.");
  assert.equal(lineElement().getAttribute("role"), "alert");
  assert.match(lineElement().className, /text-destructive/);
  assert.equal(addButton().disabled, true);

  // Removing it brings the button back, with the others untouched.
  await ui.click(chips()[1].querySelector("button"));
  assert.deepEqual(chipTexts(), ["Ethan"]);
  assert.equal(addButton().disabled, false);
});

// ---- adding

test("success clears the chips and says who went", async (t) => {
  const { callsTo } = await mount(t);

  await pickPerson("Ethan");
  await addAddress("alex@example.com");
  assert.deepEqual(chipTexts(), ["Ethan", "alex@example.com · Workspace Member"]);
  const rowsBefore = callsTo("members").length;

  // A real press moves focus to the button, which then waits (disabled) while it runs.
  await ui.focus(addButton());
  await ui.click(addButton());
  await ui.settle();

  assert.deepEqual(callsTo("addPeopleToSpace"), [["addPeopleToSpace", "cloud-1", ["ethan"]]]);
  assert.equal(callsTo("sendInvitations").length, 1);
  assert.deepEqual(chipTexts(), []);
  assert.equal(lineText(), "Added Ethan. Sent alex@example.com a workspace invitation.");
  assert.equal(addButton().disabled, true);
  assert.equal(text(addButton()), "Add members");
  // A boolean, never the element: a failing assert that prints a happy-dom element is very slow.
  assert.ok(doc().activeElement === peopleInput(), "focus is back in the field");
  assert.equal(options().length, 0, "with its list closed, so the line stays readable");
  assert.ok(callsTo("members").length > rowsBefore, "the rows are read again");
  assert.ok(callsTo("invitations").length > 1, "and so are the invitations");
});

test("while it runs the button, field and chips wait, and the line says what is happening", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await mount(t, {
    actions: {
      addPeopleToSpace: async (id, userIds) => {
        await gate;
        return { added: userIds, already_members: [] };
      },
    },
  });
  await pickPerson("Ethan");
  await addAddress("alex@example.com");

  await ui.click(addButton());

  assert.equal(text(addButton()), "Adding…");
  assert.equal(addButton().disabled, true);
  assert.equal(peopleInput().disabled, true);
  assert.ok(chips().every((chip) => chip.querySelector("button").disabled));
  assert.equal(lineText(), "Adding Ethan and sending 1 invitation…");

  // A second press while it runs sends nothing more.
  await ui.click(addButton());

  await React.act(async () => release());
  await ui.settle();
  assert.equal(lineText(), "Added Ethan. Sent alex@example.com a workspace invitation.");
});

test("the progress line names people and groups together", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await mount(t, { spaceTeams: [], actions: { assignTeamToSpace: async () => gate } });
  await pickPerson("Ethan");
  await pickPerson("Design Team");

  await ui.click(addButton());
  assert.equal(lineText(), "Adding Ethan and Design Team…");

  await React.act(async () => release());
  await ui.settle();
});

test("the progress line counts invitations when there is nobody else", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await mount(t, {
    actions: {
      sendInvitations: async ({ emails, onResult }) => {
        await gate;
        ok(emails, onResult);
      },
    },
  });
  await addAddress("alex@example.com");
  await addAddress("kim@example.com");

  await ui.click(addButton());
  assert.equal(lineText(), "Sending 2 invitations…");

  await React.act(async () => release());
  await ui.settle();
});

test("a group is assigned and its line says what that means", async (t) => {
  const { callsTo, space } = await mount(t, { spaceTeams: [] });

  await pickPerson("Design Team");
  await ui.click(addButton());
  await ui.settle();

  assert.equal(callsTo("assignTeamToSpace").length, 1);
  assert.equal(callsTo("assignTeamToSpace")[0][1], space);
  assert.equal(callsTo("assignTeamToSpace")[0][2], "design");
  assert.equal(callsTo("addPeopleToSpace").length, 0, "no people, no batch call");
  assert.equal(callsTo("sendInvitations").length, 0, "no addresses, no invitations");
  assert.equal(lineText(), "Added Design Team. Its members now have Member access.");
  assert.deepEqual(chipTexts(), []);
});

test("several groups are added together", async (t) => {
  const { callsTo } = await mount(t, { spaceTeams: [] });

  await pickPerson("Design Team");
  await pickPerson("Sales");
  await ui.click(addButton());
  await ui.settle();

  assert.deepEqual(
    callsTo("assignTeamToSpace").map((call) => call[2]),
    ["design", "sales"]
  );
  assert.equal(lineText(), "Added Design Team and Sales. Their members now have Member access.");
});

test("addresses go out once per role", async (t) => {
  const { callsTo } = await mount(t);

  await addAddress("alex@example.com");
  await addAddress("kim@example.com");
  // One address is made an admin from the invite row's role menu.
  await ui.focus(peopleInput());
  await ui.type(peopleInput(), "noor@example.com");
  await ui.press(doc().querySelector('[role="option"] [aria-haspopup="menu"]'), "ArrowDown");
  await ui.click(
    [...doc().querySelectorAll('[role="menuitemradio"]')].find((item) =>
      text(item).startsWith("Workspace Admin")
    )
  );
  await ui.click(buttonNamed("Select"));
  assert.deepEqual(chipTexts(), [
    "alex@example.com · Workspace Member",
    "kim@example.com · Workspace Member",
    "noor@example.com · Workspace Admin",
  ]);

  await ui.click(addButton());
  await ui.settle();

  const sends = callsTo("sendInvitations").map(([, input]) => input);
  assert.equal(sends.length, 2);
  const byRole = Object.fromEntries(sends.map((input) => [input.role, input]));
  assert.deepEqual(byRole.member.emails, ["alex@example.com", "kim@example.com"]);
  assert.deepEqual(byRole.admin.emails, ["noor@example.com"]);
  for (const input of sends) {
    assert.equal(input.workspaceId, "w1");
    assert.deepEqual(input.spaceIds, ["cloud-1"], "each invitation carries the teamspace");
  }
  assert.equal(callsTo("addPeopleToSpace").length, 0);
  assert.equal(
    lineText(),
    "Sent alex@example.com, kim@example.com, and noor@example.com a workspace invitation."
  );
});

test("a partial failure keeps only what failed", async (t) => {
  let sendOutcome = { ok: false, kind: "requestFailed" };
  const { callsTo } = await mount(t, {
    actions: {
      sendInvitations: async ({ emails, onResult }) => {
        for (const email of emails) onResult(email, sendOutcome);
      },
    },
  });

  await pickPerson("Ethan");
  await addAddress("alex@example.com");
  await ui.click(addButton());
  await ui.settle();

  assert.deepEqual(
    chipTexts(),
    ["alex@example.com · Workspace Member"],
    "Ethan went, so only Alex stays"
  );
  assert.equal(
    lineText(),
    "Ethan was added. alex@example.com's invitation didn't send. Try again."
  );
  assert.equal(lineElement().getAttribute("role"), "alert");
  assert.match(lineElement().className, /text-destructive/);
  assert.equal(text(addButton()), "Try again");
  assert.equal(addButton().disabled, false);
  assert.ok(doc().activeElement === addButton(), "focus goes where the next press is");

  // Try again sends only what failed.
  sendOutcome = { ok: true, emailSent: true };
  await ui.click(addButton());
  await ui.settle();

  assert.equal(callsTo("addPeopleToSpace").length, 1, "Ethan isn't added twice");
  const sends = callsTo("sendInvitations");
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[1][1].emails, ["alex@example.com"]);
  assert.deepEqual(chipTexts(), []);
  assert.equal(lineText(), "Sent alex@example.com a workspace invitation.");
});

test("several that went and several that didn't read in the plural", async (t) => {
  await mount(t, {
    actions: {
      sendInvitations: async ({ emails, onResult }) => {
        for (const email of emails) onResult(email, { ok: false, kind: "requestFailed" });
      },
    },
  });

  await pickPerson("Ethan");
  await pickPerson("Saket");
  await addAddress("alex@example.com");
  await addAddress("kim@example.com");
  await ui.click(addButton());
  await ui.settle();

  assert.deepEqual(chipTexts(), [
    "alex@example.com · Workspace Member",
    "kim@example.com · Workspace Member",
  ]);
  assert.equal(
    lineText(),
    "Ethan and Saket were added. " +
      "Invitations to alex@example.com and kim@example.com didn't send. Try again."
  );
});

test("a failed people batch keeps those people while the invitations still go", async (t) => {
  const { callsTo } = await mount(t, {
    actions: {
      addPeopleToSpace: async () => {
        throw new Error("offline");
      },
    },
  });

  await pickPerson("Ethan");
  await pickPerson("Saket");
  await addAddress("alex@example.com");
  await ui.click(addButton());
  await ui.settle();

  assert.equal(callsTo("sendInvitations").length, 1, "the invitation doesn't wait on the batch");
  assert.deepEqual(chipTexts(), ["Ethan", "Saket"]);
  assert.equal(
    lineText(),
    "Sent alex@example.com a workspace invitation. Couldn't add Ethan and Saket. Try again."
  );
});

test("one group can fail alone", async (t) => {
  await mount(t, {
    spaceTeams: [],
    actions: {
      assignTeamToSpace: async (space, teamId) => {
        if (teamId === "sales") throw new Error("offline");
      },
    },
  });

  await pickPerson("Design Team");
  await pickPerson("Sales");
  await ui.click(addButton());
  await ui.settle();

  assert.deepEqual(chipTexts(), ["Sales · 5 people"]);
  assert.equal(lineText(), "Design Team was added. Couldn't add Sales. Try again.");
});

test("a full failure keeps everything and offers Try again", async (t) => {
  const { callsTo } = await mount(t, {
    actions: {
      addPeopleToSpace: async () => {
        throw new Error("offline");
      },
      sendInvitations: async ({ emails, onResult }) => {
        for (const email of emails) onResult(email, { ok: false, kind: "requestFailed" });
      },
    },
  });

  await pickPerson("Ethan");
  await addAddress("alex@example.com");
  await ui.click(addButton());
  await ui.settle();

  assert.deepEqual(chipTexts(), ["Ethan", "alex@example.com · Workspace Member"]);
  assert.equal(lineText(), "Couldn't add members. Your selections are kept. Try again.");
  assert.equal(lineElement().getAttribute("role"), "alert");
  assert.equal(text(addButton()), "Try again");
  assert.equal(callsTo("addPeopleToSpace").length, 1);

  await ui.click(addButton());
  await ui.settle();
  assert.equal(callsTo("addPeopleToSpace").length, 2, "Try again asks for all of it again");
  assert.equal(callsTo("sendInvitations").length, 2);
});

test("editing what is staged after a failure starts over", async (t) => {
  await mount(t, {
    actions: {
      addPeopleToSpace: async () => {
        throw new Error("offline");
      },
    },
  });

  await pickPerson("Ethan");
  await ui.click(addButton());
  await ui.settle();
  assert.equal(text(addButton()), "Try again");

  await ui.click(chips()[0].querySelector("button"));
  await pickPerson("Saket");

  assert.equal(text(addButton()), "Add members");
  assert.equal(lineText(), null, "the failure was about the earlier selection");
});

test("an address that already has an invitation isn't done: it is dropped and said so", async (t) => {
  const { callsTo } = await mount(t, {
    actions: {
      sendInvitations: async ({ emails, onResult }) => {
        for (const email of emails) {
          onResult(
            email,
            email === "alex@example.com"
              ? { ok: false, kind: "alreadyInvited" }
              : { ok: true, emailSent: true }
          );
        }
      },
    },
  });

  await pickPerson("Ethan");
  await addAddress("alex@example.com");
  await addAddress("kim@example.com");
  await ui.click(addButton());
  await ui.settle();

  assert.deepEqual(chipTexts(), [], "nothing is left to retry");
  assert.equal(
    lineText(),
    "Added Ethan. Sent kim@example.com a workspace invitation. " +
      "alex@example.com already has a workspace invitation, so they weren't added to this teamspace."
  );
  assert.equal(
    lineElement().getAttribute("role"),
    "status",
    "nothing failed, so it isn't an error"
  );
  assert.ok(callsTo("invitations").length > 1, "the invitations are read again");
});

test("an address whose invitation took the teamspace counts as invited", async (t) => {
  await mount(t, {
    actions: {
      sendInvitations: async ({ emails, onResult }) => {
        for (const email of emails) {
          onResult(email, { ok: false, kind: "alreadyInvited", grantsAdded: true });
        }
      },
    },
  });

  await addAddress("alex@example.com");
  await ui.click(addButton());
  await ui.settle();

  assert.deepEqual(chipTexts(), [], "nothing is left to retry");
  assert.equal(lineText(), "Sent alex@example.com a workspace invitation.");
  assert.equal(lineElement().getAttribute("role"), "status");
});

test("beside one that took the teamspace, an older API's answer is still said", async (t) => {
  await mount(t, {
    actions: {
      sendInvitations: async ({ emails, onResult }) => {
        for (const email of emails) {
          onResult(
            email,
            email === "alex@example.com"
              ? { ok: false, kind: "alreadyInvited", grantsAdded: true }
              : { ok: false, kind: "alreadyInvited" }
          );
        }
      },
    },
  });

  await addAddress("alex@example.com");
  await addAddress("kim@example.com");
  await ui.click(addButton());
  await ui.settle();

  assert.equal(
    lineText(),
    "Sent alex@example.com a workspace invitation. " +
      "kim@example.com already has a workspace invitation, so they weren't added to this teamspace."
  );
});

test("several addresses with invitations are named together", async (t) => {
  await mount(t, {
    actions: {
      sendInvitations: async ({ emails, onResult }) => {
        for (const email of emails) onResult(email, { ok: false, kind: "alreadyInvited" });
      },
    },
  });

  await addAddress("alex@example.com");
  await addAddress("kim@example.com");
  await ui.click(addButton());
  await ui.settle();

  assert.deepEqual(chipTexts(), []);
  assert.equal(
    lineText(),
    "alex@example.com and kim@example.com already have workspace invitations, so they weren't added to this teamspace."
  );
});

test("an address that is already a member means the roster was stale: it is read again and the chip stays failed", async (t) => {
  const { callsTo } = await mount(t, {
    actions: {
      sendInvitations: async ({ emails, onResult }) => {
        for (const email of emails) onResult(email, { ok: false, kind: "alreadyMember" });
      },
    },
  });
  const rosterReads = callsTo("roster").length;

  await addAddress("alex@example.com");
  await ui.click(addButton());
  await ui.settle();

  assert.deepEqual(chipTexts(), ["alex@example.com · Workspace Member"]);
  assert.equal(lineText(), "Couldn't add members. Your selections are kept. Try again.");
  assert.equal(callsTo("roster").length, rosterReads + 1, "the roster is reloaded");
});

test("a send that throws leaves its addresses failed", async (t) => {
  await mount(t, {
    actions: {
      sendInvitations: async () => {
        throw new Error("boom");
      },
    },
  });

  await addAddress("alex@example.com");
  await ui.click(addButton());
  await ui.settle();

  assert.deepEqual(chipTexts(), ["alex@example.com · Workspace Member"]);
  assert.equal(text(addButton()), "Try again");
});

// ---- refusals a second try can't change

// How a refused batch comes back: the same answer for every address in it.
const refuseInvites =
  (failure) =>
  async ({ emails, onResult }) => {
    for (const email of emails) onResult(email, { ok: false, ...failure });
  };

const DROPPED_REFUSALS = [
  {
    name: "a seat limit with no room left",
    failure: { kind: "seatLimit", available: 0 },
    line: "This workspace has reached its seat limit. alex@example.com wasn't invited.",
  },
  {
    name: "a seat limit that doesn't say how much room is left",
    failure: { kind: "seatLimit" },
    line: "This workspace has reached its seat limit. alex@example.com wasn't invited.",
  },
  {
    name: "single sign-on",
    failure: { kind: "ssoRequired" },
    line:
      "Sign in with your company's single sign-on to invite people to Acme. " +
      "alex@example.com wasn't invited.",
  },
  {
    name: "no permission",
    failure: { kind: "notAllowed" },
    line: "You can no longer invite people to Acme. alex@example.com wasn't invited.",
  },
  {
    name: "the directory",
    failure: { kind: "directoryRequired" },
    line: "Assign alex@example.com in your identity provider first.",
  },
  {
    name: "an address the server calls invalid",
    failure: { kind: "invalid" },
    line: "alex@example.com isn't a valid email",
  },
  {
    name: "the server's own reason",
    failure: { kind: "refused", message: "Nope" },
    line: "Couldn't invite alex@example.com: Nope",
  },
];

for (const { name, failure, line } of DROPPED_REFUSALS) {
  test(`${name} drops the address and says why, with no Try again`, async (t) => {
    const { callsTo } = await mount(t, {
      actions: { sendInvitations: refuseInvites(failure) },
    });

    await addAddress("alex@example.com");
    await ui.click(addButton());
    await ui.settle();

    assert.equal(lineText(), line);
    assert.equal(lineElement().getAttribute("role"), "alert");
    assert.deepEqual(chipTexts(), [], "nothing is held for a retry that would be refused again");
    assert.equal(text(addButton()), "Add members");
    assert.equal(addButton().disabled, true);
    assert.equal(callsTo("sendInvitations").length, 1);
  });
}

const KEPT_REFUSALS = [
  {
    name: "a rate limit",
    failure: { kind: "rateLimited" },
    line: "Too many invitations right now. Try again later.",
  },
  {
    name: "an expired sign-in",
    failure: { kind: "sessionExpired" },
    line:
      "Couldn't invite alex@example.com: your sign-in expired or changed. " +
      "Sign in again, then try again.",
  },
];

for (const { name, failure, line } of KEPT_REFUSALS) {
  test(`${name} keeps the address and can be tried again`, async (t) => {
    const { callsTo } = await mount(t, {
      actions: { sendInvitations: refuseInvites(failure) },
    });

    await addAddress("alex@example.com");
    await ui.click(addButton());
    await ui.settle();

    assert.equal(lineText(), line);
    assert.equal(lineElement().getAttribute("role"), "alert");
    assert.deepEqual(chipTexts(), ["alex@example.com · Workspace Member"]);
    assert.equal(text(addButton()), "Try again");

    await ui.click(addButton());
    await ui.settle();
    assert.equal(callsTo("sendInvitations").length, 2);
  });
}

test("a seat limit with room left keeps the addresses to trim, without Try again", async (t) => {
  await mount(t, {
    actions: { sendInvitations: refuseInvites({ kind: "seatLimit", available: 1 }) },
  });

  await addAddress("alex@example.com");
  await addAddress("noor@example.com");
  await ui.click(addButton());
  await ui.settle();

  assert.equal(lineText(), "You can invite 1 more person. Remove 1 to continue.");
  assert.equal(lineElement().getAttribute("role"), "alert");
  assert.deepEqual(chipTexts(), [
    "alex@example.com · Workspace Member",
    "noor@example.com · Workspace Member",
  ]);
  assert.equal(text(addButton()), "Add members");
  assert.equal(addButton().disabled, false, "trimming is what lets the rest go");
});

test("a batch's refusal is said once and names everyone in it", async (t) => {
  await mount(t, {
    actions: { sendInvitations: refuseInvites({ kind: "seatLimit", available: 0 }) },
  });

  await addAddress("alex@example.com");
  await addAddress("noor@example.com");
  await ui.click(addButton());
  await ui.settle();

  assert.equal(
    lineText(),
    "This workspace has reached its seat limit. alex@example.com and noor@example.com weren't invited."
  );
});

test("what went is still said beside a refusal", async (t) => {
  await mount(t, {
    actions: { sendInvitations: refuseInvites({ kind: "seatLimit", available: 0 }) },
  });

  await pickPerson("Ethan");
  await addAddress("alex@example.com");
  await ui.click(addButton());
  await ui.settle();

  assert.equal(
    lineText(),
    "Added Ethan. This workspace has reached its seat limit. alex@example.com wasn't invited."
  );
  assert.equal(lineElement().getAttribute("role"), "alert");
  assert.deepEqual(chipTexts(), []);
});

test("Try again is only for what can go: a refused address beside a failed person isn't sent again", async (t) => {
  let attempts = 0;
  const { callsTo } = await mount(t, {
    actions: {
      addPeopleToSpace: async (cloudSpaceId, userIds) => {
        attempts += 1;
        if (attempts === 1) throw new Error("offline");
        return { added: userIds, already_members: [] };
      },
      sendInvitations: refuseInvites({ kind: "notAllowed" }),
    },
  });

  await pickPerson("Ethan");
  await addAddress("alex@example.com");
  await ui.click(addButton());
  await ui.settle();

  assert.equal(
    lineText(),
    "Couldn't add Ethan. Try again. You can no longer invite people to Acme. " +
      "alex@example.com wasn't invited."
  );
  assert.deepEqual(chipTexts(), ["Ethan"]);
  assert.equal(text(addButton()), "Try again");

  await ui.click(addButton());
  await ui.settle();
  assert.equal(callsTo("sendInvitations").length, 1, "the refused address isn't sent again");
  assert.equal(lineText(), "Added Ethan.");
});

test("two different refusals each say their own reason", async (t) => {
  const { callsTo } = await mount(t, {
    actions: {
      sendInvitations: async ({ emails, role, onResult }) => {
        const failure =
          role === "admin" ? { kind: "directoryRequired" } : { kind: "seatLimit", available: 0 };
        for (const email of emails) onResult(email, { ok: false, ...failure });
      },
    },
  });

  await addAddress("alex@example.com");
  // The other address is made an admin from the invite row's role menu, so it goes on its own.
  await ui.focus(peopleInput());
  await ui.type(peopleInput(), "noor@example.com");
  await ui.press(doc().querySelector('[role="option"] [aria-haspopup="menu"]'), "ArrowDown");
  await ui.click(
    [...doc().querySelectorAll('[role="menuitemradio"]')].find((item) =>
      text(item).startsWith("Workspace Admin")
    )
  );
  await ui.click(buttonNamed("Select"));
  await ui.click(addButton());
  await ui.settle();

  assert.equal(callsTo("sendInvitations").length, 2);
  assert.equal(
    lineText(),
    "This workspace has reached its seat limit. alex@example.com wasn't invited. " +
      "Assign noor@example.com in your identity provider first."
  );
});

// ---- a teamspace deleted or closed to this user while adding

const ARCHIVED = () => new CloudApiError("Space archived", 410, "space_archived");
const REVOKED = () => new CloudApiError("Space access revoked", 403, "space_access_revoked");
const NOT_FOUND = () => new CloudApiError("Space not found", 404, "space_not_found");
const NO_ROLE = () => new CloudApiError("Insufficient role", 403);
const SSO = () => new CloudApiError("Sign in with SSO", 403, "SSO_REQUIRED");

const throwing = (makeError) => async () => {
  throw makeError();
};

test("a teamspace deleted meanwhile closes the panel, says so, and catches the mirror up", async (t) => {
  const { callsTo, lefts } = await mount(t, {
    actions: { addPeopleToSpace: throwing(ARCHIVED) },
  });

  await pickPerson("Ethan");
  await pickPerson("Design Team");
  await addAddress("alex@example.com");
  await ui.click(addButton());
  await ui.settle();

  assert.deepEqual(lefts, [true], "what hosts the panel closes");
  assert.deepEqual(toastTitles(), ["Customer Calls was deleted."]);
  assert.equal(globalThis.__toasts[0].variant, "destructive");
  assert.equal(callsTo("requestSpacesResync").length, 1);
  assert.equal(callsTo("assignTeamToSpace").length, 0, "nothing else is tried");
  assert.equal(callsTo("sendInvitations").length, 0);
});

test("a group finding the teamspace deleted ends the attempt the same way", async (t) => {
  const { callsTo, lefts } = await mount(t, {
    spaceTeams: [],
    actions: { assignTeamToSpace: throwing(ARCHIVED) },
  });

  await pickPerson("Sales");
  await pickPerson("Design Team");
  await addAddress("alex@example.com");
  await ui.click(addButton());
  await ui.settle();

  assert.deepEqual(lefts, [true]);
  assert.deepEqual(toastTitles(), ["Customer Calls was deleted."]);
  assert.equal(callsTo("assignTeamToSpace").length, 1, "the next group isn't tried");
  assert.equal(callsTo("sendInvitations").length, 0);
});

test("a teamspace the server can't find for this user closes too, without claiming it was deleted", async (t) => {
  const { callsTo, lefts } = await mount(t, {
    actions: { addPeopleToSpace: throwing(NOT_FOUND) },
  });

  await pickPerson("Ethan");
  await ui.click(addButton());
  await ui.settle();

  assert.deepEqual(lefts, [true]);
  assert.deepEqual(toastTitles(), ["You no longer have access to Customer Calls"]);
  assert.equal(callsTo("requestSpacesResync").length, 1);
});

const ADD_DEAD_ENDS = [
  {
    name: "access revoked",
    makeError: REVOKED,
    line: "You no longer have permission to manage members of Customer Calls.",
  },
  {
    name: "a role that no longer lets them",
    makeError: NO_ROLE,
    line: "You no longer have permission to manage members of Customer Calls.",
  },
  {
    name: "single sign-on",
    makeError: SSO,
    line: "Sign in with your company's single sign-on to manage people in Acme.",
  },
];

for (const { name, makeError, line } of ADD_DEAD_ENDS) {
  test(`${name} ends an add with a line and no Try again, and the panel stays`, async (t) => {
    const { callsTo, lefts } = await mount(t, {
      actions: { addPeopleToSpace: throwing(makeError) },
    });

    await pickPerson("Ethan");
    await pickPerson("Design Team");
    await addAddress("alex@example.com");
    await ui.click(addButton());
    await ui.settle();

    assert.equal(lineText(), line);
    assert.equal(lineElement().getAttribute("role"), "alert");
    assert.deepEqual(chipTexts(), [], "nothing is held for a retry that can't work");
    assert.equal(text(addButton()), "Add members");
    assert.equal(addButton().disabled, true);
    assert.deepEqual(lefts, []);
    assert.deepEqual(toastTitles(), []);
    assert.equal(callsTo("assignTeamToSpace").length, 0, "nothing else is tried");
    assert.equal(callsTo("sendInvitations").length, 0);
  });
}

test("access revoked partway keeps what was said about what went, and drops the rest", async (t) => {
  await mount(t, {
    spaceTeams: [],
    actions: {
      assignTeamToSpace: async (space, teamId) => {
        if (teamId === "sales") throw new Error("offline");
        if (teamId === "design") throw REVOKED();
      },
    },
  });

  await pickPerson("Ethan");
  await pickPerson("Sales");
  await pickPerson("Design Team");
  await ui.click(addButton());
  await ui.settle();

  assert.equal(
    lineText(),
    "Added Ethan. You no longer have permission to manage members of Customer Calls."
  );
  assert.deepEqual(chipTexts(), [], "the group that failed first can't go either");
  assert.equal(text(addButton()), "Add members");
});

test("people already in come back as already members and count as added", async (t) => {
  // A retry after a lost answer meets the people the first try already added.
  const { callsTo } = await mount(t, {
    actions: {
      addPeopleToSpace: async (id, userIds) => ({ added: [], already_members: userIds }),
    },
  });

  await pickPerson("Ethan");
  await ui.click(addButton());
  await ui.settle();

  assert.equal(callsTo("addPeopleToSpace").length, 1);
  assert.deepEqual(chipTexts(), []);
  assert.equal(lineText(), "Added Ethan.");
});

test("someone who left the workspace is dropped and named; the others are kept to retry", async (t) => {
  let attempts = 0;
  const { callsTo } = await mount(t, {
    actions: {
      addPeopleToSpace: async (id, userIds) => {
        attempts += 1;
        if (attempts === 1) {
          throw new CloudApiError("Not workspace members", 400, "not_workspace_members", {
            user_ids: ["saket"],
          });
        }
        return { added: userIds, already_members: [] };
      },
    },
  });
  const rosterReads = callsTo("roster").length;

  await pickPerson("Ethan");
  await pickPerson("Saket");
  await ui.click(addButton());
  await ui.settle();

  assert.deepEqual(chipTexts(), ["Ethan"], "only the person who can still be added stays");
  assert.equal(
    lineText(),
    "Couldn't add members. Your selections are kept. Try again. " +
      "Saket left the workspace, so they weren't added."
  );
  assert.equal(text(addButton()), "Try again");
  assert.equal(callsTo("roster").length, rosterReads + 1, "the roster is read again");

  await ui.click(addButton());
  await ui.settle();

  assert.deepEqual(callsTo("addPeopleToSpace")[1], ["addPeopleToSpace", "cloud-1", ["ethan"]]);
  assert.deepEqual(chipTexts(), []);
  assert.equal(lineText(), "Added Ethan.");
});

test("one person who left and nobody else to add leaves nothing to retry", async (t) => {
  await mount(t, {
    actions: {
      addPeopleToSpace: async () => {
        throw new CloudApiError("Not workspace members", 400, "not_workspace_members", {
          user_ids: ["saket"],
        });
      },
    },
  });

  await pickPerson("Saket");
  await ui.click(addButton());
  await ui.settle();

  assert.deepEqual(chipTexts(), []);
  assert.equal(lineText(), "Saket left the workspace, so they weren't added.");
  assert.equal(addButton().disabled, true);
});

test("a refusal that names nobody is an ordinary failure", async (t) => {
  await mount(t, {
    actions: {
      addPeopleToSpace: async () => {
        throw new CloudApiError("Not workspace members", 400, "not_workspace_members");
      },
    },
  });

  await pickPerson("Ethan");
  await ui.click(addButton());
  await ui.settle();

  assert.deepEqual(chipTexts(), ["Ethan"]);
  assert.equal(lineText(), "Couldn't add members. Your selections are kept. Try again.");
});

test("an address that turns out to be a member becomes that member for Try again", async (t) => {
  let rosterReads = 0;
  const { callsTo } = await mount(t, {
    refreshMembers: async (workspaceId, store) => {
      rosterReads += 1;
      // The second read, after the refusal, now knows them.
      if (rosterReads === 2) {
        store.members = [...ROSTER, workspaceMember("alex", "Alex", "alex@example.com")];
      }
    },
    actions: {
      sendInvitations: async ({ emails, onResult }) => {
        for (const email of emails) onResult(email, { ok: false, kind: "alreadyMember" });
      },
    },
  });

  await addAddress("alex@example.com");
  await ui.click(addButton());
  await ui.settle();

  assert.deepEqual(chipTexts(), ["Alex"], "the chip is the person now");
  assert.equal(lineText(), "Couldn't add members. Your selections are kept. Try again.");
  assert.equal(text(addButton()), "Try again");

  await ui.click(addButton());
  await ui.settle();

  assert.deepEqual(callsTo("addPeopleToSpace"), [["addPeopleToSpace", "cloud-1", ["alex"]]]);
  assert.equal(callsTo("sendInvitations").length, 1, "no second invitation for a member");
  assert.deepEqual(chipTexts(), []);
  assert.equal(lineText(), "Added Alex.");
});

test("an address the roster still doesn't know stays an address chip", async (t) => {
  await mount(t, {
    actions: {
      sendInvitations: async ({ emails, onResult }) => {
        for (const email of emails) onResult(email, { ok: false, kind: "alreadyMember" });
      },
    },
  });

  await addAddress("alex@example.com");
  await ui.click(addButton());
  await ui.settle();

  assert.deepEqual(chipTexts(), ["alex@example.com · Workspace Member"]);
});

test("an invitation whose answer was lost counts as sent when this teamspace lists it", async (t) => {
  const { callsTo } = await mount(t, {
    actions: {
      // The first send went through and attached the teamspace; its answer never arrived.
      sendInvitations: async ({ emails, onResult }, state) => {
        state.invitations.push(invitation("inv-alex", "alex@example.com"));
        for (const email of emails) onResult(email, { ok: false, kind: "alreadyInvited" });
      },
    },
  });

  await addAddress("alex@example.com");
  await ui.click(addButton());
  await ui.settle();

  assert.deepEqual(chipTexts(), []);
  assert.equal(lineText(), "Sent alex@example.com a workspace invitation.");
  assert.equal(lineElement().getAttribute("role"), "status");
  assert.ok(rowFor("alex@example.com"), "and it is listed as pending");
  assert.ok(callsTo("invitations").length > 1);
});

test("an invitation this teamspace doesn't list is still skipped", async (t) => {
  await mount(t, {
    actions: {
      sendInvitations: async ({ emails, onResult }) => {
        for (const email of emails) onResult(email, { ok: false, kind: "alreadyInvited" });
      },
    },
  });

  await addAddress("alex@example.com");
  await ui.click(addButton());
  await ui.settle();

  assert.equal(
    lineText(),
    "alex@example.com already has a workspace invitation, so they weren't added to this teamspace."
  );
});

// ---- changing roles

test("a person's role changes from their row", async (t) => {
  const { callsTo, space } = await mount(t);

  await openMenu(roleTrigger(rowFor("Misa")));
  assert.deepEqual(menuItems().map(text), [
    "Teamspace Member Can view and edit notes",
    "Teamspace Admin Manages this teamspace and its assigned groups.",
    "Remove from teamspace",
  ]);
  assert.equal(menuItems()[0].getAttribute("aria-checked"), "true");
  await ui.click(menuItem("Teamspace Admin"));
  await ui.settle();

  assert.deepEqual(callsTo("setSpaceMemberRole"), [["setSpaceMemberRole", space, "misa", "admin"]]);
  assert.deepEqual(toastTitles(), ["Role updated"]);
  assert.ok(callsTo("members").length > 1, "the rows are read again");
});

test("someone who is admin through a group can't be made a plain member here", async (t) => {
  const { callsTo } = await mount(t, {
    members: [
      entry("me", "Ronnie", { role: "admin", direct_role: "admin" }),
      entry("misa", "Misa", {
        role: "admin",
        direct_role: "member",
        via_teams: [
          { team_id: "sales", name: "Sales", role: "admin", access: "admin" },
          { team_id: "design", name: "Design Team", role: "admin", access: "admin" },
        ],
      }),
    ],
  });

  await openMenu(roleTrigger(rowFor("Misa")));
  const member = menuItem("Teamspace Member");
  assert.equal(member.getAttribute("aria-checked"), "false");
  assert.equal(member.getAttribute("aria-disabled"), "true");
  assert.equal(
    text(member),
    "Teamspace Member Admin through Sales and Design Team. Change it there."
  );
  assert.equal(menuItem("Teamspace Admin").getAttribute("aria-disabled"), null);

  await ui.click(member);
  await ui.settle();

  assert.equal(callsTo("setSpaceMemberRole").length, 0);
  assert.deepEqual(toastTitles(), [], "nothing was changed, so nothing is said");
});

test("a group that only caps access at Member doesn't lock the role", async (t) => {
  await mount(t, {
    members: [
      entry("me", "Ronnie", { role: "admin", direct_role: "admin" }),
      entry("misa", "Misa", {
        direct_role: "member",
        via_teams: [{ team_id: "sales", name: "Sales", role: "admin", access: "member" }],
      }),
    ],
  });

  await openMenu(roleTrigger(rowFor("Misa")));

  assert.equal(menuItem("Teamspace Member").getAttribute("aria-disabled"), null);
  assert.equal(text(menuItem("Teamspace Member")), "Teamspace Member Can view and edit notes");
});

test("choosing the role someone already has changes nothing", async (t) => {
  const { callsTo } = await mount(t);

  await openMenu(roleTrigger(rowFor("Misa")));
  await ui.click(menuItem("Teamspace Member"));
  await ui.settle();

  assert.equal(callsTo("setSpaceMemberRole").length, 0);
});

test("a failed role change says so and leaves the role", async (t) => {
  await mount(t, {
    actions: {
      setSpaceMemberRole: async () => {
        throw new CloudApiError("Cloud API request failed", 0);
      },
    },
  });

  await openMenu(roleTrigger(rowFor("Misa")));
  await ui.click(menuItem("Teamspace Admin"));
  await ui.settle();

  assert.equal(globalThis.__toasts[0].variant, "destructive");
  assert.equal(text(rowFor("Misa")).endsWith("Member"), true);
});

test("stepping down asks first, and Cancel changes nothing", async (t) => {
  const { callsTo } = await mount(t);

  await openMenu(roleTrigger(rowFor("Ronnie")));
  await ui.click(menuItem("Teamspace Member"));
  await ui.settle();

  assert.match(dialogText(), /^Step down as admin of Customer Calls\?/);
  assert.equal(callsTo("setSpaceMemberRole").length, 0);

  await ui.click(dialogButton("Cancel"));
  await ui.settle();

  assert.equal(callsTo("setSpaceMemberRole").length, 0);
});

test("confirming steps down", async (t) => {
  const { callsTo } = await mount(t);

  await openMenu(roleTrigger(rowFor("Ronnie")));
  await ui.click(menuItem("Teamspace Member"));
  await ui.settle();
  await ui.click(dialogButton("Step down"));
  await ui.settle();

  assert.equal(callsTo("setSpaceMemberRole").length, 1);
  assert.equal(callsTo("setSpaceMemberRole")[0][2], "me");
  assert.equal(callsTo("setSpaceMemberRole")[0][3], "member");
});

test("a workspace admin changes their own row without being asked", async (t) => {
  const { callsTo } = await mount(t, { workspaceAdmin: true });

  await openMenu(roleTrigger(rowFor("Ronnie")));
  await ui.click(menuItem("Teamspace Member"));
  await ui.settle();

  assert.equal(callsTo("setSpaceMemberRole").length, 1);
});

test("someone else's demotion isn't asked about", async (t) => {
  const { callsTo } = await mount(t, {
    members: [
      entry("me", "Ronnie", { role: "admin", direct_role: "admin" }),
      entry("misa", "Misa", { role: "admin", direct_role: "admin" }),
    ],
  });

  await openMenu(roleTrigger(rowFor("Misa")));
  await ui.click(menuItem("Teamspace Member"));
  await ui.settle();

  assert.equal(callsTo("setSpaceMemberRole").length, 1);
});

const VIA_SALES = [{ team_id: "sales", name: "Sales", role: "member", access: "member" }];

test("the only admin with everyone else in a group can make one of them an admin", async (t) => {
  const { callsTo } = await mount(t, {
    members: [
      entry("me", "Ronnie", { role: "admin", direct_role: "admin" }),
      entry("jin", "Jin", { direct_role: null, via_teams: VIA_SALES }),
    ],
  });

  await openMenu(roleTrigger(rowFor("Jin")));
  assert.equal(menuItem("Remove"), undefined, "there is no direct grant of theirs to remove");
  await ui.click(menuItem("Teamspace Admin"));
  await ui.settle();

  assert.equal(callsTo("setSpaceMemberRole").length, 1);
  assert.equal(callsTo("setSpaceMemberRole")[0][2], "jin");
  assert.equal(callsTo("setSpaceMemberRole")[0][3], "admin");
});

test("a workspace admin isn't blocked from leaving, so group people stay read-only", async (t) => {
  await mount(t, {
    workspaceAdmin: true,
    members: [
      entry("me", "Ronnie", { role: "admin", direct_role: "admin" }),
      entry("jin", "Jin", { direct_role: null, via_teams: VIA_SALES }),
    ],
  });

  assert.equal(roleTrigger(rowFor("Jin")), null);
});

test("group people stay read-only while someone direct could be made an admin", async (t) => {
  await mount(t);

  assert.equal(roleTrigger(rowFor("Jin")), null);
});

test("group people stay read-only when another admin can carry on", async (t) => {
  await mount(t, {
    members: [
      entry("me", "Ronnie", { role: "admin", direct_role: "admin" }),
      entry("jin", "Jin", { direct_role: null, via_teams: VIA_SALES }),
      entry("kim", "Kim", {
        role: "admin",
        direct_role: null,
        via_teams: [{ team_id: "ops", name: "Ops", role: "admin", access: "admin" }],
      }),
    ],
  });

  assert.equal(roleTrigger(rowFor("Jin")), null);
});

test("removing someone a group also reaches says that access stays", async (t) => {
  await mount(t, {
    members: [
      entry("me", "Ronnie", { role: "admin", direct_role: "admin" }),
      entry("lila", "Lila", { via_teams: VIA_SALES }),
    ],
  });

  await openMenu(roleTrigger(rowFor("Lila")));
  await ui.click(menuItem("Remove"));
  await ui.settle();

  assert.match(dialogText(), /Access through a group will remain\./);
});

test("an invitation whose email didn't arrive says so, and who", async (t) => {
  await mount(t, {
    actions: {
      sendInvitations: async ({ emails, onResult }) => {
        for (const email of emails) {
          onResult(email, { ok: true, emailSent: email !== "alex@example.com" });
        }
      },
    },
  });

  await addAddress("alex@example.com");
  await addAddress("kim@example.com");
  await ui.click(addButton());
  await ui.settle();

  assert.equal(
    lineText(),
    "Sent kim@example.com a workspace invitation. Created invitations for alex@example.com, but the email couldn't be delivered. Resend it from Invitations."
  );
  assert.equal(lineElement().getAttribute("role"), "alert");
});

test("more addresses than one invitation batch takes blocks Add members and says why", async (t) => {
  await mount(t);
  await ui.focus(peopleInput());
  const addresses = Array.from({ length: 101 }, (_, index) => `p${index}@example.com`);
  await ui.type(peopleInput(), `${addresses.join(", ")},`);
  await ui.settle();

  assert.equal(chips().length, 101);
  assert.equal(lineText(), "You can invite up to 100 people at a time.");
  assert.equal(addButton().disabled, true);
});

test("a pending invitation for a workspace admin says so", async (t) => {
  await mount(t, {
    invitations: [{ ...invitation("inv-2", "boss@example.com"), workspace_role: "admin" }],
  });

  assert.match(text(rowFor("boss@example.com")), /Invitation pending · Workspace Admin/);
});

test("the only admin stepping down is told why", async (t) => {
  await mount(t, {
    actions: {
      setSpaceMemberRole: async () => {
        throw new CloudApiError("You are the only admin", 409, "last_space_admin");
      },
    },
  });

  await openMenu(roleTrigger(rowFor("Ronnie")));
  await ui.click(menuItem("Teamspace Member"));
  await ui.settle();
  await ui.click(dialogButton("Step down"));
  await ui.settle();

  assert.deepEqual(toastTitles(), [
    "You're the only admin of Customer Calls. Make another member an admin before you leave.",
  ]);
  assert.equal(globalThis.__toasts[0].variant, "destructive");
});

test("a group's access changes from its row", async (t) => {
  const { callsTo, space } = await mount(t);

  await openMenu(roleTrigger(rowFor("Sales")));
  assert.equal(menuItem("Teamspace Member").getAttribute("aria-checked"), "true");
  await ui.click(menuItem("Teamspace Admin"));
  await ui.settle();

  assert.deepEqual(callsTo("setSpaceTeamAccess"), [
    ["setSpaceTeamAccess", space, "sales", "admin"],
  ]);
  assert.deepEqual(toastTitles(), ["Access for Sales updated"]);
  assert.ok(callsTo("members").length > 1, "the people it brings are read again");
});

// ---- removing

test("removal asks, runs, fails with Try again, and toasts", async (t) => {
  let attempts = 0;
  const { callsTo, space } = await mount(t, {
    actions: {
      removeSpaceMember: async (spaceArg, userId, state) => {
        attempts += 1;
        if (attempts === 1) throw new CloudApiError("Cloud API request failed", 0);
        state.members = state.members.filter((member) => member.user_id !== userId);
        return { removed: true, still_via_teams: [] };
      },
    },
  });

  await openMenu(roleTrigger(rowFor("Lila")));
  await ui.click(menuItem("Remove from teamspace"));

  assert.equal(
    dialogText(),
    "Remove Lila from Customer Calls? " +
      "Lila will lose access to this teamspace and its notes. They'll stay in the workspace. " +
      "Remove member Cancel"
  );
  assert.equal(callsTo("removeSpaceMember").length, 0, "asking removes nothing");

  await ui.click(dialogButton("Remove member"));
  await ui.settle();

  assert.equal(
    dialogText(),
    "Couldn't remove Lila " +
      "Lila's membership in Customer Calls is unchanged. Check your connection and try again. " +
      "Try again Cancel"
  );
  assert.ok(rowFor("Lila"), "she is still listed");
  assert.deepEqual(toastTitles(), []);

  await ui.click(dialogButton("Try again"));
  await ui.settle();

  assert.deepEqual(callsTo("removeSpaceMember"), [
    ["removeSpaceMember", space, "lila"],
    ["removeSpaceMember", space, "lila"],
  ]);
  assert.equal(dialogs().length, 0, "the dialog is gone");
  assert.deepEqual(toastTitles(), ["Lila's direct membership in Customer Calls was removed."]);
  assert.ok(!rowFor("Lila"), "and so is she");
});

test("Cancel leaves the person where they are", async (t) => {
  const { callsTo } = await mount(t);

  await openMenu(roleTrigger(rowFor("Lila")));
  await ui.click(menuItem("Remove from teamspace"));
  await ui.click(dialogButton("Cancel"));

  assert.equal(dialogs().length, 0);
  assert.equal(callsTo("removeSpaceMember").length, 0);
  assert.ok(rowFor("Lila"));
});

test("a group that keeps access toasts that instead", async (t) => {
  await mount(t, {
    actions: {
      removeSpaceMember: async () => ({
        removed: true,
        still_via_teams: [
          { team_id: "sales", name: "Sales" },
          { team_id: "design", name: "Design Team" },
        ],
      }),
    },
  });

  await openMenu(roleTrigger(rowFor("Misa")));
  await ui.click(menuItem("Remove from teamspace"));
  await ui.click(dialogButton("Remove member"));
  await ui.settle();

  assert.deepEqual(toastTitles(), ["Misa still has access through Sales and Design Team"]);
  assert.equal(dialogs().length, 0);
});

test("someone already gone closes the dialog and reads the rows again", async (t) => {
  const { callsTo } = await mount(t, {
    actions: {
      removeSpaceMember: async () => {
        throw new CloudApiError("Member not found", 404);
      },
    },
  });
  const reads = callsTo("members").length;

  await openMenu(roleTrigger(rowFor("Lila")));
  await ui.click(menuItem("Remove from teamspace"));
  await ui.click(dialogButton("Remove member"));
  await ui.settle();

  assert.equal(dialogs().length, 0);
  assert.deepEqual(toastTitles(), []);
  assert.ok(callsTo("members").length > reads);
});

test("the only admin removing themselves is told why, and can still try again", async (t) => {
  const { lefts } = await mount(t, {
    actions: {
      leaveSpace: async () => {
        throw new CloudApiError("You are the only admin", 409, "last_space_admin");
      },
    },
  });

  await openMenu(roleTrigger(rowFor("Ronnie")));
  await ui.click(menuItem("Remove from teamspace"));
  await ui.click(dialogButton("Remove member"));
  await ui.settle();

  assert.match(dialogText(), /Couldn't remove Ronnie/);
  assert.match(
    dialogText(),
    /You're the only admin of Customer Calls\. Make another member an admin before you leave\./
  );
  assert.deepEqual(lefts, []);
});

test("removing from a teamspace deleted meanwhile closes everything and says so", async (t) => {
  const { callsTo, lefts } = await mount(t, {
    actions: { removeSpaceMember: throwing(ARCHIVED) },
  });

  await openMenu(roleTrigger(rowFor("Lila")));
  await ui.click(menuItem("Remove from teamspace"));
  await ui.click(dialogButton("Remove member"));
  await ui.settle();

  assert.equal(dialogs().length, 0, "no Try again to offer");
  assert.deepEqual(toastTitles(), ["Customer Calls was deleted."]);
  assert.deepEqual(lefts, [true]);
  assert.equal(callsTo("requestSpacesResync").length, 1);
});

test("leaving a teamspace deleted meanwhile closes the same way", async (t) => {
  const { lefts } = await mount(t, {
    actions: { leaveSpace: throwing(ARCHIVED) },
  });

  await openMenu(roleTrigger(rowFor("Ronnie")));
  await ui.click(menuItem("Remove from teamspace"));
  await ui.click(dialogButton("Remove member"));
  await ui.settle();

  assert.equal(dialogs().length, 0);
  assert.deepEqual(toastTitles(), ["Customer Calls was deleted."]);
  assert.deepEqual(lefts, [true]);
});

test("removing a group from a teamspace deleted meanwhile closes the same way", async (t) => {
  const { lefts } = await mount(t, {
    actions: { unassignTeamFromSpace: throwing(ARCHIVED) },
  });

  await openMenu(roleTrigger(rowFor("Sales")));
  await ui.click(menuItem("Remove from teamspace"));
  await ui.click(dialogButton("Remove from teamspace"));
  await ui.settle();

  assert.equal(dialogs().length, 0);
  assert.deepEqual(toastTitles(), ["Customer Calls was deleted."]);
  assert.deepEqual(lefts, [true]);
});

const REMOVAL_DEAD_ENDS = [
  {
    name: "access revoked",
    makeError: REVOKED,
    line: "You no longer have permission to manage members of Customer Calls.",
  },
  {
    name: "a role that no longer lets them",
    makeError: NO_ROLE,
    line: "You no longer have permission to manage members of Customer Calls.",
  },
  {
    name: "single sign-on",
    makeError: SSO,
    line: "Sign in with your company's single sign-on to manage people in Acme.",
  },
];

for (const { name, makeError, line } of REMOVAL_DEAD_ENDS) {
  test(`${name} ends a removal with a line and Close, never Try again`, async (t) => {
    const { callsTo, lefts } = await mount(t, {
      actions: { removeSpaceMember: throwing(makeError) },
    });

    await openMenu(roleTrigger(rowFor("Lila")));
    await ui.click(menuItem("Remove from teamspace"));
    await ui.click(dialogButton("Remove member"));
    await ui.settle();

    assert.equal(dialogText(), `Couldn't remove Lila ${line} Close`);
    assert.equal(dialogButton("Try again"), undefined);
    assert.deepEqual(lefts, []);
    assert.equal(callsTo("removeSpaceMember").length, 1);

    await ui.click(dialogButton("Close"));
    await ui.settle();
    assert.equal(dialogs().length, 0);
    assert.equal(callsTo("removeSpaceMember").length, 1, "Close doesn't run it again");
    assert.ok(rowFor("Lila"), "she is still listed");
  });
}

test("removing your own row leaves the teamspace and closes the settings", async (t) => {
  const { callsTo, space, lefts } = await mount(t);

  await openMenu(roleTrigger(rowFor("Ronnie")));
  await ui.click(menuItem("Remove from teamspace"));
  await ui.click(dialogButton("Remove member"));
  await ui.settle();

  // Leaving drops cached content the grant no longer reaches, which a plain removal doesn't.
  assert.deepEqual(callsTo("leaveSpace"), [["leaveSpace", space, "me"]]);
  assert.equal(callsTo("removeSpaceMember").length, 0);
  assert.deepEqual(toastTitles(), ["You left Customer Calls."]);
  assert.deepEqual(lefts, [true], "the settings close, as after Leave");
  assert.equal(dialogs().length, 0);
});

test("a workspace admin removing their own row is a plain removal: they keep implicit access", async (t) => {
  const { callsTo, space, lefts } = await mount(t, { workspaceAdmin: true });

  await openMenu(roleTrigger(rowFor("Ronnie")));
  await ui.click(menuItem("Remove from teamspace"));
  await ui.click(dialogButton("Remove member"));
  await ui.settle();

  assert.equal(callsTo("leaveSpace").length, 0, "nothing is left, so nothing is purged");
  assert.deepEqual(callsTo("removeSpaceMember"), [["removeSpaceMember", space, "me"]]);
  assert.deepEqual(toastTitles(), ["Ronnie's direct membership in Customer Calls was removed."]);
  assert.deepEqual(lefts, [], "they can still open it, so the settings stay");
  assert.equal(dialogs().length, 0);
  assert.ok(!rowFor("Ronnie"), "the direct row is gone");
});

test("removing your own row while a group still reaches you stays open and says so", async (t) => {
  const { lefts } = await mount(t, {
    actions: {
      leaveSpace: async (space, userId, state) => {
        state.members = state.members.filter((member) => member.user_id !== userId);
        return { removed: true, still_via_teams: [{ team_id: "sales", name: "Sales" }] };
      },
    },
  });

  await openMenu(roleTrigger(rowFor("Ronnie")));
  await ui.click(menuItem("Remove from teamspace"));
  await ui.click(dialogButton("Remove member"));
  await ui.settle();

  assert.deepEqual(toastTitles(), ["You still have access to Customer Calls through Sales."]);
  assert.deepEqual(lefts, [], "they are still in, so the settings stay");
  assert.equal(dialogs().length, 0, "only the confirm closes");
  assert.ok(!rowFor("Ronnie"), "the direct row is gone");
});

test("removing someone else never leaves", async (t) => {
  const { callsTo, lefts } = await mount(t);

  await openMenu(roleTrigger(rowFor("Lila")));
  await ui.click(menuItem("Remove from teamspace"));
  await ui.click(dialogButton("Remove member"));
  await ui.settle();

  assert.equal(callsTo("leaveSpace").length, 0);
  assert.equal(callsTo("removeSpaceMember").length, 1);
  assert.deepEqual(lefts, []);
});

test("removing a group asks first", async (t) => {
  const { callsTo, space } = await mount(t);

  await openMenu(roleTrigger(rowFor("Sales")));
  await ui.click(menuItem("Remove from teamspace"));

  assert.equal(
    dialogText(),
    "Remove Sales from Customer Calls? " +
      "Its 5 people lose access through this group. The group stays in the workspace. " +
      "Remove from teamspace Cancel"
  );
  assert.equal(callsTo("unassignTeamFromSpace").length, 0);

  await ui.click(dialogButton("Remove from teamspace"));
  await ui.settle();

  assert.deepEqual(callsTo("unassignTeamFromSpace"), [["unassignTeamFromSpace", space, "sales"]]);
  assert.equal(dialogs().length, 0);
  assert.deepEqual(toastTitles(), ["Sales removed from Customer Calls"]);
  assert.ok(callsTo("members").length > 1, "the people it brought are read again");
});

test("a group of one person and one with no count say it as they are", async (t) => {
  await mount(t, {
    groups: [group("sales", "Sales", 1)],
  });
  await openMenu(roleTrigger(rowFor("Sales")));
  await ui.click(menuItem("Remove from teamspace"));
  assert.match(dialogText(), /Its 1 person loses access through this group\./);
});

test("a group whose count is unknown doesn't make one up", async (t) => {
  await mount(t, {
    listTeams: async () => {
      throw new Error("offline");
    },
  });
  await openMenu(roleTrigger(rowFor("Sales")));
  await ui.click(menuItem("Remove from teamspace"));

  assert.match(dialogText(), /Its people lose access through this group\./);
});

test("a group that failed to leave offers Try again", async (t) => {
  let attempts = 0;
  await mount(t, {
    actions: {
      unassignTeamFromSpace: async () => {
        attempts += 1;
        if (attempts === 1) throw new CloudApiError("Cloud API request failed", 0);
      },
    },
  });

  await openMenu(roleTrigger(rowFor("Sales")));
  await ui.click(menuItem("Remove from teamspace"));
  await ui.click(dialogButton("Remove from teamspace"));
  await ui.settle();

  assert.match(dialogText(), /Couldn't remove Sales/);
  assert.ok(dialogButton("Try again"));
  await ui.click(dialogButton("Try again"));
  await ui.settle();
  assert.equal(dialogs().length, 0);
});
