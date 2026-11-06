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

// Mounts the real panel with the real Radix menus, field and dialogs in happy-dom. The services
// and stores are fakes the tests steer; strings come from the English file.

let CloudApiError;
let TeamMembersPanel;
let createRoot;
let happyWindow;
let ui;
let vite;

test.before(async (t) => {
  ({ happyWindow, createRoot } = await installHappyDom());
  ui = interactions(happyWindow);
  vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-team-members-panel-",
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
      "/services/TeamsService": `
        export const TeamsService = {
          listMembers: (id) => globalThis.__teams.listMembers(id),
          listInvitations: (id) => globalThis.__teams.listInvitations(id),
        };
      `,
      "/services/InvitationsService": `
        export const InvitationsService = {
          resend: (workspaceId, id) => globalThis.__actions.resend(workspaceId, id),
        };
      `,
      "/services/spaceActions": `
        const call = (name) => (...args) => globalThis.__actions[name](...args);
        export const addPeopleToTeam = call("addPeopleToTeam");
        export const setTeamMemberRole = call("setTeamMemberRole");
        export const removeTeamMember = call("removeTeamMember");
      `,
      "/services/invitePeople": `
        export const invitePeople = {
          sendInvitations: (input) => globalThis.__actions.sendInvitations(input),
        };
      `,
    },
  });
  ({ CloudApiError } = await vite.ssrLoadModule("/services/cloudApi.ts"));
  ({ default: TeamMembersPanel } = await vite.ssrLoadModule(
    "/components/settings/TeamMembersPanel.tsx"
  ));
});

test.after(async () => {
  await happyWindow.happyDOM.close();
});

const h = React.createElement;
const doc = () => happyWindow.document;

// ---- fixtures

const member = (userId, name, role = "member") => ({
  user_id: userId,
  role,
  joined_at: "2026-01-01T00:00:00Z",
  email: `${userId}@openronnie.com`,
  name,
  image: null,
});

const workspaceMember = (userId, name, email = `${userId}@openronnie.com`) => ({
  user_id: userId,
  role: "member",
  joined_at: "2026-01-01T00:00:00Z",
  email,
  name,
  image: null,
});

const invitation = (id, email, workspaceRole = "member") => ({
  id,
  email,
  workspace_role: workspaceRole,
  expires_at: "2026-02-01T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z",
});

// The signed-in user is Ronnie, the team's only admin. The server's order is kept.
const MEMBERS = [
  member("me", "Ronnie", "admin"),
  member("misa", "Misa"),
  member("ravi", "Ravi"),
  member("jin", "Jin"),
  member("lila", "Lila"),
];

const ROSTER = [
  workspaceMember("me", "Ronnie", "ronnie@openronnie.com"),
  workspaceMember("misa", "Misa"),
  workspaceMember("ravi", "Ravi"),
  workspaceMember("jin", "Jin"),
  workspaceMember("lila", "Lila"),
  workspaceMember("ethan", "Ethan"),
  workspaceMember("saket", "Saket"),
];

const teamFor = (canManage, overrides = {}) => ({
  id: "t1",
  workspace_id: "w1",
  name: "Sales",
  slug: "sales",
  description: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  capabilities: { manage_members: canManage, manage_settings: canManage, leave: true },
  ...overrides,
});

// The role is deliberately not what decides anything: capabilities do.
const workspaceWith = (manageMembers) => ({
  id: "w1",
  name: "Acme",
  role: "member",
  capabilities: {
    manage_members: manageMembers,
    manage_teams: manageMembers,
    create_teams: true,
    create_spaces: false,
    manage_settings: false,
    manage_billing: false,
    delete_workspace: false,
    transfer_ownership: false,
    leave: true,
  },
});

const ok = (emails, onResult) => {
  for (const email of emails) onResult(email, { ok: true, emailSent: true });
};

// What a test steers: how the fakes answer. Each test gets its own calls log and server state.
async function mount(
  t,
  {
    canManage = true,
    workspaceAdmin = true,
    managed = false,
    members = MEMBERS,
    invitations = [],
    listInvitations,
    listMembers,
    actions = {},
  } = {}
) {
  const calls = [];
  const events = [];
  const state = { members: [...members], invitations: [...invitations] };
  const team = teamFor(canManage, managed ? { directory_synced: true } : {});
  const store = {
    members: ROSTER,
    membersWorkspaceId: "w1",
    refreshMembers: async (workspaceId) => {
      calls.push(["roster", workspaceId]);
    },
  };
  globalThis.__store = store;
  globalThis.__toasts = [];
  globalThis.__teams = {
    listMembers: async (id) => {
      calls.push(["members", id]);
      if (listMembers) return listMembers(state);
      return [...state.members];
    },
    listInvitations: async (id) => {
      calls.push(["invitations", id]);
      if (listInvitations) return listInvitations(state);
      return [...state.invitations];
    },
  };
  globalThis.__actions = {
    addPeopleToTeam: async (teamId, userIds) => {
      calls.push(["addPeopleToTeam", teamId, userIds]);
      if (actions.addPeopleToTeam) return actions.addPeopleToTeam(teamId, userIds, state);
      for (const id of userIds) state.members.push(member(id, id));
      return { added: userIds, already_members: [] };
    },
    setTeamMemberRole: async (teamId, userId, role) => {
      calls.push(["setTeamMemberRole", teamId, userId, role]);
      if (actions.setTeamMemberRole) return actions.setTeamMemberRole(teamId, userId, role, state);
      state.members = state.members.map((entry) =>
        entry.user_id === userId ? { ...entry, role } : entry
      );
    },
    removeTeamMember: async (teamId, userId) => {
      calls.push(["removeTeamMember", teamId, userId]);
      if (actions.removeTeamMember) return actions.removeTeamMember(teamId, userId, state);
      state.members = state.members.filter((entry) => entry.user_id !== userId);
    },
    sendInvitations: async (input) => {
      calls.push(["sendInvitations", input]);
      if (actions.sendInvitations) return actions.sendInvitations(input, state);
      ok(input.emails, input.onResult);
      for (const email of input.emails) {
        state.invitations.push(invitation(`inv-${email}`, email, input.role));
      }
    },
    resend: async (workspaceId, id) => {
      calls.push(["resend", workspaceId, id]);
      if (actions.resend) return actions.resend(workspaceId, id);
      return { email_sent: true };
    },
  };
  const workspace = workspaceWith(workspaceAdmin);
  store.workspaces = [workspace];

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
    for (const name of ["__store", "__toasts", "__teams", "__actions"]) delete globalThis[name];
  });
  const render = (props = {}) =>
    React.act(async () => {
      root.render(
        h(TeamMembersPanel, {
          team,
          workspace,
          managed,
          onChanged: () => events.push(["changed"]),
          onGone: () => events.push(["gone"]),
          ...props,
        })
      );
    });
  await render();
  await ui.settle();
  return {
    state,
    calls,
    events,
    unmount,
    // Renders again with another team row, as the host does after `onChanged`.
    rerender: async (teamChanges) => {
      await render({ team: { ...team, ...teamChanges } });
      await ui.settle();
    },
    callsTo: (name) => calls.filter(([call]) => call === name),
  };
}

// ---- reading the screen

const tableRows = () => [...doc().querySelectorAll("tbody tr")];
const rowTexts = () => tableRows().map(text);
const rowFor = (label) => tableRows().find((row) => text(row).startsWith(label));
const roleTrigger = (row) => row?.querySelector("button[aria-haspopup='menu']") ?? null;
const roleTriggers = () => [...doc().querySelectorAll("tbody button[aria-haspopup='menu']")];
const peopleInput = () => doc().querySelector('input[role="combobox"]');
const options = () => [...doc().querySelectorAll('[role="option"]')];
const chipTexts = () => [...doc().querySelectorAll("[data-chip]")].map(text);
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
const pendingSection = () => doc().querySelector("section");
const pendingRows = () => [...(pendingSection()?.querySelectorAll("li") ?? [])];

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

test("members read in the server's order, with their team role", async (t) => {
  await mount(t);

  assert.deepEqual(
    rowTexts().map((row) => row.split(" ")[0]),
    ["Ronnie", "Misa", "Ravi", "Jin", "Lila"]
  );
  assert.deepEqual([...doc().querySelectorAll("thead th")].map(text), ["Name", "Team role"]);
  assert.equal(text(rowFor("Ronnie")), "Ronnie me@openronnie.com Admin");
  assert.equal(text(rowFor("Misa")), "Misa misa@openronnie.com Member");
  assert.ok(rowFor("Misa").querySelector('bdi[dir="ltr"]'), "an email stays left-to-right");
});

test("invitations sit in their own list under the table", async (t) => {
  await mount(t, { invitations: [invitation("inv-1", "alex@example.com")] });

  assert.equal(rowTexts().length, 5, "the table holds only members");
  const section = pendingSection();
  assert.ok(section, "the pending list exists");
  assert.ok(
    doc().querySelector("table").compareDocumentPosition(section) &
      happyWindow.Node.DOCUMENT_POSITION_FOLLOWING,
    "and follows the table"
  );
  assert.match(text(section), /^Pending invitation/);
  assert.equal(
    text(pendingRows()[0]),
    "alex@example.com Joins team after accepting · Member Invited Resend"
  );
  assert.ok(pendingRows()[0].querySelector('bdi[dir="ltr"]'));
});

test("a pending admin invitation says which workspace role it carries", async (t) => {
  await mount(t, { invitations: [invitation("inv-1", "alex@example.com", "admin")] });

  assert.match(text(pendingRows()[0]), /Joins team after accepting · Admin/);
});

test("a member reads the table with no field or menus", async (t) => {
  const { callsTo } = await mount(t, { canManage: false, workspaceAdmin: false });

  assert.equal(peopleInput(), null);
  assert.equal(addButton(), undefined, "no Add members button");
  assert.equal(roleTriggers().length, 0);
  assert.equal(text(rowFor("Misa")), "Misa misa@openronnie.com Member");
  assert.equal(callsTo("invitations").length, 0, "only managers read invitations");
  assert.equal(callsTo("roster").length, 0, "nothing to pick from, so the roster isn't read");
  assert.equal(pendingSection(), null);
});

test("a directory team is read-only", async (t) => {
  // Every capability on: the directory, not the capabilities, is what makes it read-only.
  const { callsTo } = await mount(t, {
    managed: true,
    invitations: [invitation("inv-1", "alex@example.com")],
  });

  assert.equal(peopleInput(), null);
  assert.equal(roleTriggers().length, 0);
  assert.equal(text(rowFor("Misa")), "Misa misa@openronnie.com Member");
  assert.equal(callsTo("invitations").length, 0);
});

test("a team admin who isn't a workspace admin adds but gets no invite row and no Resend", async (t) => {
  await mount(t, {
    workspaceAdmin: false,
    invitations: [invitation("inv-1", "alex@example.com")],
  });

  await ui.focus(peopleInput());
  await ui.type(peopleInput(), "new@example.com");
  assert.ok(
    !options().some((option) => /new@example\.com/.test(text(option))),
    "no invite row is offered for an unknown address"
  );
  await ui.type(peopleInput(), "eth");
  assert.ok(
    options().some((option) => text(option).startsWith("Ethan")),
    "people already in the workspace can be added"
  );

  assert.equal(pendingRows().length, 1, "the invitation is listed");
  assert.equal(buttonNamed("Resend"), undefined, "the server's resend is for workspace admins");
});

test("an old API's missing invitations route leaves the table showing", async (t) => {
  await mount(t, {
    listInvitations: async () => {
      throw new CloudApiError("Not found", 404);
    },
  });

  assert.equal(rowTexts().length, 5);
  assert.equal(pendingSection(), null);
  assert.equal(lineText(), null, "the failure says nothing");
});

test("a team deleted since the list was read says so and closes, with no Retry", async (t) => {
  const { events } = await mount(t, {
    listMembers: async () => {
      throw new CloudApiError("Team not found", 404);
    },
  });
  await ui.settle();

  assert.deepEqual(toastTitles(), ["Sales no longer exists."]);
  assert.deepEqual(events, [["gone"]]);
});

test("a failed member read says so and reads again", async (t) => {
  let failures = 1;
  const { callsTo } = await mount(t, {
    listMembers: async (state) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("offline");
      }
      return [...state.members];
    },
  });

  assert.match(doc().body.textContent, /Couldn't load members/);
  await ui.click(buttonNamed("Retry"));
  await ui.settle();

  assert.equal(callsTo("members").length, 2);
  assert.ok(rowFor("Misa"));
});

test("a team nobody is in says so", async (t) => {
  await mount(t, { members: [] });
  assert.deepEqual(rowTexts(), ["No one has been added yet"]);
});

// ---- adding

test("people and addresses go together, in one batch for each", async (t) => {
  const { calls, events } = await mount(t);

  await pickPerson("Ethan");
  await addAddress("alex@example.com");
  assert.deepEqual(chipTexts().length, 2);
  assert.match(
    doc().body.textContent,
    /New people get a workspace invitation when you add them\./,
    "the note shows while an address is staged"
  );
  await ui.click(addButton());
  await ui.settle();

  assert.deepEqual(
    calls.filter(([name]) => name === "addPeopleToTeam"),
    [["addPeopleToTeam", "t1", ["ethan"]]],
    "one batch of people, never the single-member upsert"
  );
  const sends = calls.filter(([name]) => name === "sendInvitations");
  assert.equal(sends.length, 1);
  assert.equal(sends[0][1].workspaceId, "w1");
  assert.deepEqual(sends[0][1].emails, ["alex@example.com"]);
  assert.equal(sends[0][1].role, "member");
  assert.deepEqual(sends[0][1].teamIds, ["t1"]);
  assert.equal(sends[0][1].spaceIds, undefined);
  assert.equal(calls.filter(([name]) => name === "setTeamMemberRole").length, 0);

  assert.deepEqual(toastTitles(), ["Added Ethan and invited alex@example.com."]);
  assert.deepEqual(chipTexts(), [], "everything went, so nothing stays staged");
  assert.ok(rowFor("ethan"), "the new member joins the table");
  assert.equal(pendingRows().length, 1, "and the invitation joins the list");
  assert.deepEqual(events, [["changed"]], "the host hears about the roster change");
});

test("addresses go out one batch for each role", async (t) => {
  const { callsTo } = await mount(t);

  await addAddress("a@example.com");
  await ui.focus(peopleInput());
  await ui.type(peopleInput(), "b@example.com");
  await ui.press(peopleInput(), "ArrowDown");
  await ui.press(peopleInput(), "ArrowRight");
  await ui.press(peopleInput(), "Enter");
  await ui.click(addButton());
  await ui.settle();

  assert.deepEqual(
    callsTo("sendInvitations").map(([, input]) => [input.role, input.emails]),
    [
      ["member", ["a@example.com"]],
      ["admin", ["b@example.com"]],
    ]
  );
  assert.equal(callsTo("addPeopleToTeam").length, 0, "nobody to add, so nothing to send");
});

test("an address alone is invited, and says so", async (t) => {
  await mount(t);

  await addAddress("alex@example.com");
  await ui.click(addButton());
  await ui.settle();

  assert.deepEqual(toastTitles(), ["Invited alex@example.com."]);
});

test("people alone are added, and say so", async (t) => {
  await mount(t);

  await pickPerson("Ethan");
  await ui.click(addButton());
  await ui.settle();

  assert.deepEqual(toastTitles(), ["Added Ethan."]);
});

test("someone the server says was already on the team isn't reported as added", async (t) => {
  await mount(t, {
    actions: {
      addPeopleToTeam: async () => ({ added: ["ethan"], already_members: ["saket"] }),
    },
  });

  await pickPerson("Ethan");
  await pickPerson("Saket");
  await ui.click(addButton());
  await ui.settle();

  assert.deepEqual(toastTitles(), ["Added Ethan."]);
  assert.deepEqual(chipTexts(), [], "the one already on the team isn't kept staged");
});

test("everyone already on the team says that, never that they were added", async (t) => {
  const { events } = await mount(t, {
    actions: {
      addPeopleToTeam: async () => ({ added: [], already_members: ["ethan"] }),
    },
  });

  await pickPerson("Ethan");
  await ui.click(addButton());
  await ui.settle();

  assert.deepEqual(toastTitles(), ["They're already on Sales."]);
  assert.deepEqual(events, [], "nothing changed, so the host isn't told");
});

test("the line says who is going while it runs", async (t) => {
  let release;
  await mount(t, {
    actions: {
      addPeopleToTeam: () =>
        new Promise((resolve) => {
          release = () => resolve({ added: ["ethan"], already_members: [] });
        }),
    },
  });

  await pickPerson("Ethan");
  await addAddress("alex@example.com");
  await ui.click(addButton());
  assert.equal(lineText(), "Adding Ethan and sending 1 invitation…");
  assert.equal(text(addButton()), "Adding…");

  await React.act(async () => release());
  await ui.settle();
  assert.equal(lineText(), null);
});

test("the line counts invitations, and names nobody when only addresses go", async (t) => {
  let release;
  await mount(t, {
    actions: {
      sendInvitations: (input) =>
        new Promise((resolve) => {
          release = () => {
            ok(input.emails, input.onResult);
            resolve();
          };
        }),
    },
  });

  await addAddress("a@example.com");
  await addAddress("b@example.com");
  await ui.click(addButton());
  assert.equal(lineText(), "Sending 2 invitations…");
  await React.act(async () => release());
  await ui.settle();
});

test("a partial failure keeps only what failed", async (t) => {
  const { events } = await mount(t, {
    actions: {
      addPeopleToTeam: async () => {
        throw new CloudApiError("Server error", 500);
      },
    },
  });

  await pickPerson("Ethan");
  await addAddress("alex@example.com");
  await ui.click(addButton());
  await ui.settle();

  assert.deepEqual(chipTexts(), ["Ethan"], "the address went; the person stays staged");
  assert.equal(lineText(), "Invited alex@example.com. Couldn't finish adding members. Try again.");
  assert.equal(text(addButton()), "Try again");
  assert.deepEqual(toastTitles(), [], "a line with a Try again is the report, not a toast");
  assert.deepEqual(events, [["changed"]], "the invitation did change the pending list");
});

test("Try again sends only that", async (t) => {
  let failing = true;
  const { callsTo } = await mount(t, {
    actions: {
      addPeopleToTeam: async (_teamId, userIds, state) => {
        if (failing) throw new CloudApiError("Server error", 500);
        for (const id of userIds) state.members.push(member(id, id));
        return { added: userIds, already_members: [] };
      },
    },
  });

  await pickPerson("Ethan");
  await addAddress("alex@example.com");
  await ui.click(addButton());
  await ui.settle();
  failing = false;
  await ui.click(addButton());
  await ui.settle();

  assert.equal(callsTo("addPeopleToTeam").length, 2);
  assert.deepEqual(callsTo("addPeopleToTeam")[1], ["addPeopleToTeam", "t1", ["ethan"]]);
  assert.equal(callsTo("sendInvitations").length, 1, "the address isn't sent again");
  assert.deepEqual(toastTitles(), ["Added Ethan."]);
  assert.deepEqual(chipTexts(), []);
});

test("everything failing says so and keeps every chip", async (t) => {
  await mount(t, {
    actions: {
      addPeopleToTeam: async () => {
        throw new CloudApiError("Server error", 500);
      },
      sendInvitations: async () => {
        throw new CloudApiError("Server error", 500);
      },
    },
  });

  await pickPerson("Ethan");
  await addAddress("alex@example.com");
  await ui.click(addButton());
  await ui.settle();

  assert.equal(lineText(), "Couldn't finish adding members. Try again.");
  assert.equal(chipTexts().length, 2);
  assert.equal(text(addButton()), "Try again");
});

test("an already-invited address counts as invited", async (t) => {
  const { callsTo } = await mount(t, {
    actions: {
      sendInvitations: async (input) => {
        for (const email of input.emails) {
          input.onResult(email, { ok: false, kind: "alreadyInvited", grantsAdded: true });
        }
      },
    },
  });

  await addAddress("alex@example.com");
  await ui.click(addButton());
  await ui.settle();

  assert.deepEqual(toastTitles(), ["Invited alex@example.com."]);
  assert.deepEqual(chipTexts(), []);
  assert.equal(callsTo("sendInvitations").length, 1);
});

test("an already-invited address the team's list shows was invited by an earlier try", async (t) => {
  await mount(t, {
    actions: {
      // The earlier try's invitation is there, though its answer was lost.
      sendInvitations: async (input, state) => {
        for (const email of input.emails) {
          state.invitations.push(invitation(`inv-${email}`, email));
          input.onResult(email, { ok: false, kind: "alreadyInvited" });
        }
      },
    },
  });

  await addAddress("alex@example.com");
  await ui.click(addButton());
  await ui.settle();

  assert.deepEqual(toastTitles(), ["Invited alex@example.com."]);
  assert.deepEqual(chipTexts(), []);
});

test("a refused invitation says its own reason", async (t) => {
  await mount(t, {
    actions: {
      sendInvitations: async (input) => {
        for (const email of input.emails) input.onResult(email, { ok: false, kind: "invalid" });
      },
    },
  });

  await addAddress("alex@example.com");
  await ui.click(addButton());
  await ui.settle();

  assert.match(lineText(), /alex@example\.com/);
  assert.equal(lineElement().getAttribute("role"), "alert");
});

test("losing the team while adding closes through onGone", async (t) => {
  const { events } = await mount(t, {
    actions: {
      addPeopleToTeam: async () => {
        throw new CloudApiError("Team not found", 404);
      },
    },
  });

  await pickPerson("Ethan");
  await ui.click(addButton());
  await ui.settle();

  assert.deepEqual(toastTitles(), ["Sales no longer exists."]);
  assert.deepEqual(events, [["gone"]]);
});

// ---- roles

test("a role change sends the explicit role", async (t) => {
  const { callsTo, events } = await mount(t);

  await openMenu(roleTrigger(rowFor("Misa")));
  assert.deepEqual(
    menuItems().map((item) => text(item)),
    [
      "Team Member Gets access wherever the team is added.",
      "Team Admin Manages this team's roster.",
      "Remove from team",
    ]
  );
  await ui.click(menuItem("Team Admin"));
  await ui.settle();

  assert.deepEqual(callsTo("setTeamMemberRole"), [["setTeamMemberRole", "t1", "misa", "admin"]]);
  assert.equal(text(rowFor("Misa")), "Misa misa@openronnie.com Admin");
  assert.deepEqual(events, [["changed"]]);
});

test("the only admin stepping down stays admin and is told why", async (t) => {
  const { events } = await mount(t, {
    actions: {
      setTeamMemberRole: async () => {
        throw new CloudApiError("Last admin", 409, "last_team_admin");
      },
    },
  });

  await openMenu(roleTrigger(rowFor("Ronnie")));
  await ui.click(menuItem("Team Member"));
  await ui.settle();

  assert.deepEqual(toastTitles(), [
    "You're the only admin of Sales. Make another member an admin before you leave.",
  ]);
  assert.equal(text(rowFor("Ronnie")), "Ronnie me@openronnie.com Admin");
  assert.deepEqual(events, []);
});

test("a failed role change says whose", async (t) => {
  await mount(t, {
    actions: {
      setTeamMemberRole: async () => {
        throw new CloudApiError("Server error", 500);
      },
    },
  });

  await openMenu(roleTrigger(rowFor("Misa")));
  await ui.click(menuItem("Team Admin"));
  await ui.settle();

  assert.deepEqual(toastTitles(), ["Couldn't change Misa's role. Try again."]);
  assert.equal(text(rowFor("Misa")), "Misa misa@openronnie.com Member");
});

test("a role change for someone removed meanwhile says so and drops their row", async (t) => {
  const { events } = await mount(t, {
    actions: {
      setTeamMemberRole: async (_teamId, userId, _role, state) => {
        state.members = state.members.filter((entry) => entry.user_id !== userId);
        throw new CloudApiError("Member not found", 404);
      },
    },
  });

  await openMenu(roleTrigger(rowFor("Misa")));
  await ui.click(menuItem("Team Admin"));
  await ui.settle();

  assert.deepEqual(toastTitles(), ["Misa is no longer on Sales."]);
  assert.equal(rowFor("Misa"), undefined, "the list is read again");
  assert.deepEqual(events, [["changed"]], "the team stays open");
});

test("losing permission while changing a role closes through onGone", async (t) => {
  const { events } = await mount(t, {
    actions: {
      setTeamMemberRole: async () => {
        throw new CloudApiError("Forbidden", 403);
      },
    },
  });

  await openMenu(roleTrigger(rowFor("Misa")));
  await ui.click(menuItem("Team Admin"));
  await ui.settle();

  assert.deepEqual(toastTitles(), ["You can no longer manage Sales."]);
  assert.deepEqual(events, [["gone"]]);
});

// ---- removing

test("removing asks, and a failure offers Try again", async (t) => {
  let failing = true;
  const { callsTo, events } = await mount(t, {
    actions: {
      removeTeamMember: async (_teamId, userId, state) => {
        if (failing) throw new CloudApiError("Server error", 500);
        state.members = state.members.filter((entry) => entry.user_id !== userId);
      },
    },
  });

  await openMenu(roleTrigger(rowFor("Lila")));
  await ui.click(menuItem("Remove from team"));
  assert.match(dialogText(), /^Remove Lila from Sales\?/);
  assert.match(
    dialogText(),
    /Lila will lose access granted through this team\. They'll remain in the workspace and keep any access granted directly or through other teams\./
  );
  assert.equal(callsTo("removeTeamMember").length, 0, "nothing is sent before the confirm");

  await ui.click(dialogButton("Remove member"));
  await ui.settle();
  assert.match(dialogText(), /^Couldn't remove Lila/);
  assert.match(
    dialogText(),
    /Lila is still a member of Sales\. Check your connection and try again\./
  );
  assert.deepEqual(events, [], "nothing changed");

  failing = false;
  await ui.click(dialogButton("Try again"));
  await ui.settle();

  assert.equal(callsTo("removeTeamMember").length, 2);
  assert.deepEqual(callsTo("removeTeamMember")[1], ["removeTeamMember", "t1", "lila"]);
  assert.equal(dialogs().length, 0);
  assert.deepEqual(toastTitles(), ["Lila was removed from Sales."]);
  assert.ok(!rowFor("Lila"));
  assert.deepEqual(events, [["changed"]]);
});

test("Cancel leaves the member alone", async (t) => {
  const { callsTo } = await mount(t);

  await openMenu(roleTrigger(rowFor("Lila")));
  await ui.click(menuItem("Remove from team"));
  await ui.click(dialogButton("Cancel"));

  assert.equal(dialogs().length, 0);
  assert.equal(callsTo("removeTeamMember").length, 0);
});

test("you can't remove yourself here", async (t) => {
  await mount(t);

  await openMenu(roleTrigger(rowFor("Ronnie")));
  assert.ok(menuItem("Team Admin"), "the role menu is there");
  assert.equal(menuItem("Remove from team"), undefined, "Leave is how you go");
});

test("removing from a team that is gone closes through onGone", async (t) => {
  const { events } = await mount(t, {
    actions: {
      removeTeamMember: async () => {
        throw new CloudApiError("Team not found", 404);
      },
    },
  });

  await openMenu(roleTrigger(rowFor("Lila")));
  await ui.click(menuItem("Remove from team"));
  await ui.click(dialogButton("Remove member"));
  await ui.settle();

  assert.equal(dialogs().length, 0);
  assert.deepEqual(toastTitles(), ["Sales no longer exists."]);
  assert.deepEqual(events, [["gone"]]);
});

test("losing permission while removing closes through onGone", async (t) => {
  const { events } = await mount(t, {
    actions: {
      removeTeamMember: async () => {
        throw new CloudApiError("Forbidden", 403);
      },
    },
  });

  await openMenu(roleTrigger(rowFor("Lila")));
  await ui.click(menuItem("Remove from team"));
  await ui.click(dialogButton("Remove member"));
  await ui.settle();

  assert.equal(dialogs().length, 0);
  assert.deepEqual(toastTitles(), ["You can no longer manage Sales."]);
  assert.deepEqual(events, [["gone"]]);
});

// ---- resending

test("Resend reports either way", async (t) => {
  let sent = true;
  const { callsTo } = await mount(t, {
    invitations: [invitation("inv-1", "alex@example.com")],
    actions: {
      resend: async () => {
        if (!sent) throw new CloudApiError("Server error", 500);
        return { email_sent: true };
      },
    },
  });

  await ui.click(buttonNamed("Resend"));
  await ui.settle();
  sent = false;
  await ui.click(buttonNamed("Resend"));
  await ui.settle();

  assert.deepEqual(callsTo("resend"), [
    ["resend", "w1", "inv-1"],
    ["resend", "w1", "inv-1"],
  ]);
  assert.deepEqual(toastTitles(), [
    "Resent the invitation to alex@example.com.",
    "Couldn't resend the invitation to alex@example.com.",
  ]);
  assert.equal(globalThis.__toasts[1].variant, "destructive");
});

test("an invitation whose email didn't go out is reported as not resent", async (t) => {
  await mount(t, {
    invitations: [invitation("inv-1", "alex@example.com")],
    actions: { resend: async () => ({ email_sent: false }) },
  });

  await ui.click(buttonNamed("Resend"));
  await ui.settle();

  assert.deepEqual(toastTitles(), ["Couldn't resend the invitation to alex@example.com."]);
});

// ---- fix round 1

test("an invitation whose email didn't send says so in a line", async (t) => {
  await mount(t, {
    actions: {
      sendInvitations: async (input) => {
        for (const email of input.emails) input.onResult(email, { ok: true, emailSent: false });
      },
    },
  });

  await addAddress("alex@example.com");
  await ui.click(addButton());
  await ui.settle();

  assert.equal(
    lineText(),
    "Invited alex@example.com, but the email didn't send. Use Resend below."
  );
  assert.equal(lineElement().getAttribute("role"), "alert");
  assert.deepEqual(toastTitles(), []);
});

test("a skipped address is said once and nothing is left to try again", async (t) => {
  await mount(t, {
    actions: {
      sendInvitations: async (input) => {
        for (const email of input.emails) {
          input.onResult(email, { ok: false, kind: "alreadyInvited" });
        }
      },
    },
  });

  await addAddress("alex@example.com");
  await ui.click(addButton());
  await ui.settle();

  assert.equal(
    lineText(),
    "Not added to Sales: alex@example.com. They already have a workspace invitation."
  );
  assert.equal(text(addButton()), "Add members", "nothing to retry");
  assert.deepEqual(chipTexts(), []);
});

test("the invite note sits under the chips and gives way to the line", async (t) => {
  await mount(t, {
    actions: {
      sendInvitations: async () => {
        throw new CloudApiError("Server error", 500);
      },
    },
  });

  await addAddress("alex@example.com");
  const note = [...doc().querySelectorAll("p")].find((p) =>
    /New people get a workspace invitation/.test(text(p))
  );
  assert.ok(note);
  const list = doc().querySelector("ul");
  assert.ok(
    list.compareDocumentPosition(note) & happyWindow.Node.DOCUMENT_POSITION_FOLLOWING,
    "after the chips"
  );
  await ui.click(addButton());
  await ui.settle();
  assert.doesNotMatch(doc().body.textContent, /New people get a workspace invitation/);
  assert.equal(lineText(), "Couldn't finish adding members. Try again.");
});

test("people added but invitations failing keeps only the addresses staged", async (t) => {
  const { callsTo } = await mount(t, {
    actions: {
      sendInvitations: async () => {
        throw new CloudApiError("Server error", 500);
      },
    },
  });

  await pickPerson("Ethan");
  await addAddress("alex@example.com");
  await ui.click(addButton());
  await ui.settle();
  assert.deepEqual(chipTexts().length, 1);
  assert.match(chipTexts()[0], /alex@example\.com/);
  await ui.click(addButton());
  await ui.settle();

  assert.equal(callsTo("addPeopleToTeam").length, 1, "nobody is added twice");
  assert.equal(callsTo("sendInvitations").length, 2);
});

test("single sign-on required on an add says so and hands the button focus back", async (t) => {
  await mount(t, {
    actions: {
      addPeopleToTeam: async () => {
        throw new CloudApiError("SSO", 403, "SSO_REQUIRED");
      },
    },
  });

  await pickPerson("Ethan");
  await ui.click(addButton());
  await ui.settle();

  assert.match(lineText(), /single sign-on|sign-on|SSO/i);
  assert.equal(text(addButton()), "Add members");
  assert.equal(doc().activeElement, addButton());
});

test("a closed dialog doesn't let a late answer act for another team", async (t) => {
  let fail;
  const { events, unmount } = await mount(t, {
    actions: {
      addPeopleToTeam: () =>
        new Promise((_resolve, reject) => {
          fail = () => reject(new CloudApiError("Forbidden", 403));
        }),
    },
  });

  await pickPerson("Ethan");
  await ui.click(addButton());
  await unmount();
  await React.act(async () => fail());
  await ui.settle();

  assert.deepEqual(events, [], "no onGone for a dialog that moved on");
  assert.deepEqual(toastTitles(), []);
});

test("closing mid-add still reports a failed batch as a toast", async (t) => {
  let release;
  const { unmount } = await mount(t, {
    actions: {
      sendInvitations: (input) =>
        new Promise((resolve) => {
          release = () => {
            for (const email of input.emails) input.onResult(email, { ok: false, kind: "invalid" });
            resolve();
          };
        }),
    },
  });

  await addAddress("alex@example.com");
  await ui.click(addButton());
  await unmount();
  await React.act(async () => release());
  await ui.settle();

  assert.equal(toastTitles().length, 1);
  assert.match(toastTitles()[0], /alex@example\.com/);
  assert.equal(globalThis.__toasts[0].variant, "destructive");
});

test("losing manage_members after stepping down removes the field and menus", async (t) => {
  const { rerender } = await mount(t);
  assert.ok(peopleInput());
  assert.ok(roleTriggers().length > 0);

  await rerender({ capabilities: { manage_members: false, manage_settings: false, leave: true } });

  assert.equal(peopleInput(), null);
  assert.equal(roleTriggers().length, 0);
  assert.equal(text(rowFor("Misa")), "Misa misa@openronnie.com Member");
});

test("a Resend answering gone reads the invitations again", async (t) => {
  const { state, callsTo } = await mount(t, {
    invitations: [invitation("inv-1", "alex@example.com")],
    actions: {
      resend: async () => {
        throw new CloudApiError("Invitation not found", 404);
      },
    },
  });
  state.invitations = [];

  await ui.click(buttonNamed("Resend"));
  await ui.settle();

  assert.equal(callsTo("invitations").length, 2);
  assert.equal(pendingRows().length, 0, "the stale row goes");
});
