const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer } = require("../lib/rendererTestHarness");

// Mounts the dialog with the real Radix dialog and popover in happy-dom. The services and the
// store are fakes the tests steer; strings come from the English file, so a missing key shows up
// as a missing label.

const DOM_GLOBALS = [
  "document",
  "navigator",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "MutationObserver",
  "getComputedStyle",
  "KeyboardEvent",
  "MouseEvent",
  "PointerEvent",
  "FocusEvent",
  "Event",
  "CustomEvent",
  "ResizeObserver",
  "DOMRect",
];

const member = (userId, name, email = `${userId}@openronnie.com`) => ({
  user_id: userId,
  role: "member",
  joined_at: "2026-01-01T00:00:00Z",
  email,
  name,
  image: null,
});

// The creator is on the roster, as in any workspace; the field must not offer them.
const ROSTER = [
  member("me", "Ronnie", "ronnie@openronnie.com"),
  member("ethan", "Ethan"),
  member("saket", "Saket"),
];

const capabilities = (overrides) => ({
  manage_members: true,
  manage_teams: true,
  create_teams: true,
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
  role: "admin",
  capabilities: capabilities(overrides),
});

const createdTeam = (name = "Sales") => ({ id: "t9", workspace_id: "w1", name, slug: "sales" });

let CloudApiError;
let CreateTeamDialog;
let inviteAfterCreate;
let createRoot;
let happyWindow;
let vite;

test.before(async (t) => {
  const { Window } = await import("happy-dom");
  happyWindow = new Window();
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  define("window", happyWindow);
  for (const name of DOM_GLOBALS) define(name, happyWindow[name]);
  for (const name of ["requestAnimationFrame", "cancelAnimationFrame"]) {
    define(name, happyWindow[name].bind(happyWindow));
  }
  define("IS_REACT_ACT_ENVIRONMENT", true);
  ({ createRoot } = require("react-dom/client"));

  vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-create-team-dialog-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `
        import en from "/locales/en/translation.json";
        const lookup = (key) => key.split(".").reduce((value, part) => value?.[part], en);
        const t = (key, values = {}) => {
          let text = lookup(key);
          if (text === undefined && typeof values.count === "number") {
            text = lookup(key + "_" + new Intl.PluralRules("en").select(values.count));
          }
          if (typeof text !== "string") return key;
          return text.replace(/{{\\s*(\\w+)\\s*}}/g, (_, name) => String(values[name] ?? ""));
        };
        export const useTranslation = () => ({ t, i18n: { language: "en" } });
      `,
      "/i18n": "export default { t: (key) => key, language: 'en' };",
      "/stores/workspaceStore": `
        export const useWorkspaceStore = Object.assign(
          (selector) => selector(globalThis.__store),
          { getState: () => globalThis.__store }
        );
      `,
      "/hooks/useAuth": 'export const useAuth = () => ({ user: { id: "me" } });',
      "/ui/useToast":
        "export const useToast = () => ({ toast: (toast) => globalThis.__toasts.push(toast) });",
      "/services/spaceActions":
        "export const createTeam = (...args) => globalThis.__createTeam(...args);",
      "/services/invitePeople": `
        export const invitePeople = {
          sendInvitations: (input) => globalThis.__sendInvitations(input),
        };
      `,
    },
  });
  ({ CloudApiError } = await vite.ssrLoadModule("/services/cloudApi.ts"));
  ({ default: CreateTeamDialog } = await vite.ssrLoadModule("/components/CreateTeamDialog.tsx"));
  ({ inviteAfterCreate } = await vite.ssrLoadModule("/lib/inviteAfterCreate.ts"));
});

test.after(async () => {
  await happyWindow.happyDOM.close();
});

const h = React.createElement;
const doc = () => happyWindow.document;
const dialog = () => doc().querySelector('[role="dialog"]');
const nameInput = () => doc().getElementById("create-team-name");
const peopleInput = () => dialog()?.querySelector('input[role="combobox"]') ?? null;
const options = () => [...doc().querySelectorAll('[role="option"]')];
const chips = () => [...doc().querySelectorAll("[data-chip]")];
const buttons = () => [...dialog().querySelectorAll("button")];

const readable = (value) => value.replace(/[⁨⁩]/g, "").replace(/\s+/g, " ").trim();
const text = (node) => {
  const parts = [];
  const walk = (current) => {
    if (current.nodeType === 3) parts.push(current.nodeValue);
    else if (current.getAttribute?.("aria-hidden") !== "true")
      [...current.childNodes].forEach(walk);
  };
  walk(node);
  return readable(parts.join(" "));
};
const chipTexts = () => chips().map(text);
const optionTexts = () => options().map(text);
const alertTexts = () => [...dialog().querySelectorAll('[role="alert"]')].map(text);
const buttonNamed = (label) => buttons().find((button) => text(button) === label);
const createButton = () => buttonNamed("Create team");

const act = (fn) => React.act(async () => fn());
const click = (element) => {
  assert.ok(element, "the control exists");
  return act(() =>
    element.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true, detail: 1 }))
  );
};
const type = (element, value) =>
  act(() => {
    Object.getOwnPropertyDescriptor(happyWindow.HTMLInputElement.prototype, "value").set.call(
      element,
      value
    );
    element.dispatchEvent(new happyWindow.Event("input", { bubbles: true }));
  });
const press = (element, key) =>
  act(() =>
    element.dispatchEvent(
      new happyWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
    )
  );
const focus = (element) => act(() => element.focus());
const leaveField = (element) =>
  act(() =>
    element.dispatchEvent(
      new happyWindow.FocusEvent("focusout", { bubbles: true, relatedTarget: null })
    )
  );
const settle = () =>
  React.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function pickPerson(label) {
  await focus(peopleInput());
  await click(options().find((option) => text(option).startsWith(label)));
}

async function addAddress(address) {
  await focus(peopleInput());
  await type(peopleInput(), address);
  await press(peopleInput(), "Enter");
}

async function mount(
  t,
  {
    props = {},
    canManageMembers = true,
    createTeam = async () => createdTeam(),
    rosterFails = false,
    sendInvitations = async ({ emails, onResult }) => {
      for (const email of emails) onResult(email, { ok: true, emailSent: true });
    },
  } = {}
) {
  const calls = [];
  const closes = [];
  const workspace = workspaceWith({ manage_members: canManageMembers });
  const store = {
    members: [],
    membersWorkspaceId: null,
    refreshMembers: async (workspaceId) => {
      if (rosterFails) throw new Error("offline");
      store.members = ROSTER;
      store.membersWorkspaceId = workspaceId;
    },
    refresh: async (options) => {
      calls.push(["refresh", options]);
    },
  };
  globalThis.__store = store;
  globalThis.__toasts = [];
  globalThis.__createTeam = async (workspaceId, input) => {
    calls.push(["createTeam", workspaceId, input]);
    return createTeam(workspaceId, input);
  };
  globalThis.__sendInvitations = async (input) => {
    calls.push(["sendInvitations", input]);
    return sendInvitations(input);
  };

  let reopen = () => {};
  function Host() {
    const [open, setOpen] = React.useState(true);
    reopen = () => setOpen(true);
    return h(CreateTeamDialog, {
      workspace,
      open,
      onOpenChange: (next) => {
        closes.push(next);
        setOpen(next);
      },
      onCreated: (team, outcome) => calls.push(["created", team.id, outcome]),
      // As the Teams page does: the form closes and the paywall takes its place.
      onPlanRequired: () => {
        calls.push(["planRequired"]);
        setOpen(false);
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
    for (const name of ["__store", "__toasts", "__createTeam", "__sendInvitations"]) {
      delete globalThis[name];
    }
  });
  await React.act(async () => {
    root.render(h(Host));
  });
  await settle();
  return {
    calls,
    closes,
    reopen: () => act(() => reopen()),
    toasts: () => globalThis.__toasts,
    callsTo: (name) => calls.filter(([call]) => call === name),
  };
}

test("an empty name says so and sends nothing", async (t) => {
  const { calls } = await mount(t);
  assert.match(text(dialog()), /Create team A shortcut for adding several people at once\./);
  assert.equal(nameInput().getAttribute("placeholder"), "Team name");
  assert.equal(peopleInput().getAttribute("placeholder"), "Names or emails");
  assert.equal(dialog().querySelector('button[aria-label="Close"]'), null, "no close button");

  await type(nameInput(), "   ");
  await click(createButton());
  assert.deepEqual(alertTexts(), ["Enter a team name."]);
  assert.equal(nameInput().getAttribute("aria-invalid"), "true");
  assert.deepEqual(
    calls.filter(([call]) => call !== "refresh"),
    []
  );

  // Typing takes the message back.
  await type(nameInput(), "Sales");
  assert.deepEqual(alertTexts(), []);
});

test("a bad address says so and blocks Create", async (t) => {
  const { callsTo } = await mount(t);
  await type(nameInput(), "Sales");
  await focus(peopleInput());
  await type(peopleInput(), "alex@");
  await leaveField(peopleInput());

  assert.deepEqual(chipTexts(), ["alex@ · Workspace Member"]);
  assert.deepEqual(alertTexts(), ["Enter a valid email address."]);
  assert.equal(createButton().disabled, true);
  await press(nameInput(), "Enter");
  assert.equal(callsTo("createTeam").length, 0);

  await click(chips()[0].querySelector("button"));
  assert.deepEqual(alertTexts(), []);
  assert.equal(createButton().disabled, false);
});

test("the creator isn't offered", async (t) => {
  await mount(t);
  await focus(peopleInput());
  assert.deepEqual(
    optionTexts()
      .map((option) => option.split(" ")[0])
      .sort(),
    ["Ethan", "Saket"]
  );
});

test("people and the name go in one request", async (t) => {
  const { callsTo, closes, toasts } = await mount(t);
  await type(nameInput(), " Sales ");
  await pickPerson("Ethan");
  await pickPerson("Saket");
  assert.match(
    text(dialog()),
    /You're added as the team's admin\. Invitations send when you create the team\./
  );
  await click(createButton());

  assert.deepEqual(callsTo("createTeam"), [
    ["createTeam", "w1", { name: "Sales", memberIds: ["ethan", "saket"] }],
  ]);
  assert.equal(callsTo("sendInvitations").length, 0);
  assert.equal(readable(toasts()[0].title), "Created Sales. Added Ethan and Saket.");
  assert.deepEqual(closes, [false]);
  assert.deepEqual(callsTo("created"), [["created", "t9", { memberCount: 2 }]]);
});

test("addresses go out after the create, with the team id", async (t) => {
  const { calls, callsTo, toasts } = await mount(t);
  await type(nameInput(), "Sales");
  await pickPerson("Ethan");
  await addAddress("alex@example.com");
  await click(createButton());

  assert.deepEqual(
    calls
      .map(([call]) => call)
      .filter((call) => call === "createTeam" || call === "sendInvitations"),
    ["createTeam", "sendInvitations"],
    "the team exists before anyone is invited into it"
  );
  const [, invitation] = callsTo("sendInvitations")[0];
  assert.equal(invitation.workspaceId, "w1");
  assert.deepEqual(invitation.emails, ["alex@example.com"]);
  assert.equal(invitation.role, "member");
  assert.deepEqual(invitation.teamIds, ["t9"]);
  assert.equal(invitation.spaceIds, undefined);
  assert.equal(
    readable(toasts()[0].title),
    "Created Sales. Added Ethan and invited alex@example.com."
  );
});

test("more than two names fall back to a count", async (t) => {
  const { toasts } = await mount(t);
  await type(nameInput(), "Sales");
  await pickPerson("Ethan");
  for (const address of ["a@example.com", "b@example.com", "c@example.com"]) {
    await addAddress(address);
  }
  await click(createButton());
  assert.equal(readable(toasts()[0].title), "Created Sales with 4 members");
});

test("Cancel sends nothing, with an address staged", async (t) => {
  const { calls, closes } = await mount(t);
  await type(nameInput(), "Sales");
  await addAddress("alex@example.com");
  await click(buttonNamed("Cancel"));

  assert.deepEqual(
    calls.filter(([call]) => call !== "refresh"),
    []
  );
  assert.deepEqual(closes, [false]);
});

test("a failed invitation still reports the team as created", async (t) => {
  const { closes, toasts, callsTo } = await mount(t, {
    sendInvitations: async ({ emails, onResult }) => {
      for (const email of emails) onResult(email, { ok: false, kind: "requestFailed" });
    },
  });
  await type(nameInput(), "Sales");
  await addAddress("alex@example.com");
  await click(createButton());

  assert.equal(readable(toasts()[0].title), "Created Sales. Couldn't invite 1 person.");
  assert.match(readable(toasts()[0].description), /alex@example\.com/);
  assert.deepEqual(closes, [false]);
  assert.equal(callsTo("created").length, 1);
});

test("a taken name stays on the form", async (t) => {
  const { closes } = await mount(t, {
    createTeam: async () => {
      throw new CloudApiError("exists", 409, "team_name_taken");
    },
  });
  await type(nameInput(), "Sales");
  await pickPerson("Ethan");
  await click(createButton());

  assert.deepEqual(alertTexts(), ["A team called Sales already exists."]);
  assert.equal(doc().activeElement, nameInput());
  assert.deepEqual(closes, []);
  assert.deepEqual(chipTexts(), ["Ethan"]);
  // The primary is still Create team: the fix is the name, not another try.
  assert.ok(createButton());
});

test("a failed create keeps everything entered", async (t) => {
  let attempts = 0;
  const { callsTo, closes } = await mount(t, {
    createTeam: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("socket hang up");
      return createdTeam();
    },
  });
  await type(nameInput(), "Sales");
  await pickPerson("Ethan");
  await addAddress("alex@example.com");
  await click(createButton());

  assert.deepEqual(alertTexts(), ["Couldn't create the team. Your entries are kept."]);
  assert.equal(nameInput().value, "Sales");
  assert.deepEqual(chipTexts(), ["Ethan", "alex@example.com · Workspace Member"]);
  assert.equal(createButton(), undefined);
  assert.deepEqual(closes, []);

  assert.ok(buttonNamed("Try again").querySelector("svg"), "Try again keeps the + mark");
  await click(buttonNamed("Try again"));
  assert.equal(callsTo("createTeam").length, 2);
  assert.deepEqual(closes, [false]);
});

test("the server's refusal opens the paywall and refreshes", async (t) => {
  const { callsTo, closes, toasts, reopen } = await mount(t, {
    createTeam: async () => {
      throw new CloudApiError("Upgrade to create teams", 403, "team_plan_required");
    },
  });
  await type(nameInput(), "Sales");
  await click(createButton());

  assert.equal(callsTo("planRequired").length, 1);
  assert.deepEqual(callsTo("refresh"), [["refresh", { fresh: true }]]);
  assert.deepEqual(toasts(), []);
  // Closing is the Teams page's call, and the form goes with its entries: upgrading takes the
  // person to another page, so they start again from the Teams page.
  assert.deepEqual(closes, []);
  assert.equal(dialog(), null);
  await reopen();
  await settle();
  assert.equal(nameInput().value, "");
  assert.deepEqual(chipTexts(), []);
});

test("someone who can't invite gets no invite row", async (t) => {
  await mount(t, { canManageMembers: false });
  await focus(peopleInput());
  await type(peopleInput(), "new@example.com");
  assert.deepEqual(optionTexts(), []);
});

test("a selection's people start as chips, with the short note ahead of them", async (t) => {
  const { callsTo } = await mount(t, {
    props: { initialPeople: [ROSTER[0], ROSTER[1], ROSTER[2]] },
  });
  // The creator is the team's admin already, so they never become a chip.
  assert.deepEqual(chipTexts(), ["Ethan", "Saket"]);
  assert.match(text(dialog()), /You're added as the team's admin\./);
  assert.doesNotMatch(text(dialog()), /Invitations send/);
  const note = [...dialog().querySelectorAll("p")].find((p) => text(p).startsWith("You're added"));
  assert.ok(
    note.compareDocumentPosition(chips()[0]) & happyWindow.Node.DOCUMENT_POSITION_FOLLOWING,
    "the note comes before the chips"
  );

  await type(nameInput(), "Engineering");
  await click(createButton());
  assert.deepEqual(callsTo("createTeam")[0][2], {
    name: "Engineering",
    memberIds: ["ethan", "saket"],
  });
});

test("the selection arrives as chips, whether or not the roster read succeeded", async (t) => {
  await mount(t, { rosterFails: true, props: { initialPeople: [ROSTER[1], ROSTER[2]] } });
  assert.deepEqual(chipTexts(), ["Ethan", "Saket"]);
  assert.match(text(dialog()), /Couldn't load/i);
  assert.match(text(dialog()), /You're added as the team's admin\./);
});

test("the creator isn't among them", async (t) => {
  const { callsTo } = await mount(t, {
    rosterFails: true,
    props: { initialPeople: [ROSTER[0], ROSTER[1]] },
  });
  assert.deepEqual(chipTexts(), ["Ethan"]);
  await type(nameInput(), "Engineering");
  await click(createButton());
  assert.deepEqual(callsTo("createTeam")[0][2].memberIds, ["ethan"]);
});

test("Created names the team and counts the people", async (t) => {
  const { toasts, callsTo } = await mount(t, {
    createTeam: async () => createdTeam("Engineering"),
    props: { initialPeople: [ROSTER[0], ROSTER[1], ROSTER[2]] },
  });
  await type(nameInput(), "Engineering");
  await click(createButton());

  assert.equal(toasts().length, 1, "one toast");
  assert.equal(readable(toasts()[0].title), "Created Engineering with 2 members");
  assert.deepEqual(callsTo("created")[0][2], { memberCount: 2 });
});

test("a selection of one is counted too", async (t) => {
  const { toasts } = await mount(t, { props: { initialPeople: [ROSTER[1]] } });
  await type(nameInput(), "Sales");
  await click(createButton());
  assert.equal(readable(toasts()[0].title), "Created Sales with 1 member");
});

test("someone who left since the selection comes off, with the server's words", async (t) => {
  const { closes } = await mount(t, {
    rosterFails: true,
    props: { initialPeople: [ROSTER[1], ROSTER[2]] },
    createTeam: async () => {
      throw new CloudApiError(
        "Ethan is no longer in this workspace",
        400,
        "not_workspace_members",
        { user_ids: ["ethan"] }
      );
    },
  });
  await type(nameInput(), "Sales");
  await click(createButton());

  assert.deepEqual(chipTexts(), ["Saket"]);
  assert.deepEqual(alertTexts(), ["Ethan is no longer in this workspace"]);
  assert.deepEqual(closes, []);
});

test("invitations go out one batch per role, never throwing", async () => {
  const batches = [];
  globalThis.__sendInvitations = async ({ emails, role, teamIds, onResult }) => {
    batches.push([role, emails, teamIds]);
    if (role === "admin") throw new Error("offline");
    for (const email of emails) onResult(email, { ok: true, emailSent: false });
  };
  const result = await inviteAfterCreate({
    workspaceId: "w1",
    target: { teamIds: ["t9"] },
    recipients: [
      { email: "a@example.com", role: "member" },
      { email: "b@example.com", role: "admin" },
    ],
  });
  delete globalThis.__sendInvitations;

  assert.deepEqual(batches, [
    ["member", ["a@example.com"], ["t9"]],
    ["admin", ["b@example.com"], ["t9"]],
  ]);
  assert.deepEqual(result, {
    invited: ["a@example.com"],
    failed: ["b@example.com"],
    undelivered: 1,
  });
});

test("a pending create locks the form and ignores a second press", async (t) => {
  let finish;
  const { callsTo, closes } = await mount(t, {
    createTeam: () =>
      new Promise((resolve) => {
        finish = () => resolve(createdTeam());
      }),
  });
  await type(nameInput(), "Sales");
  await addAddress("alex@example.com");
  await click(createButton());

  assert.equal(nameInput().readOnly, true);
  assert.equal(peopleInput().disabled, true);
  assert.equal(buttonNamed("Cancel").disabled, true);
  assert.equal(
    doc().querySelector('[role="status"]') && text(doc().querySelector('[role="status"]')),
    "Creating Sales and sending 1 invitation…"
  );
  const creating = buttonNamed("Creating…");
  assert.ok(creating.disabled && creating.querySelector("svg"), "Creating… is dimmed and keeps +");

  await press(nameInput(), "Enter");
  await press(nameInput(), "Escape");
  assert.equal(callsTo("createTeam").length, 1);
  assert.deepEqual(closes, []);
  assert.ok(dialog(), "Esc doesn't close a create under way");

  await act(() => finish());
  await settle();
  assert.deepEqual(closes, [false]);
  assert.equal(callsTo("sendInvitations").length, 1);
});

test("people who left the workspace come off the form, with the server's words", async (t) => {
  const { closes } = await mount(t, {
    createTeam: async () => {
      throw new CloudApiError(
        "Ethan is no longer in this workspace",
        400,
        "not_workspace_members",
        {
          user_ids: ["ethan"],
        }
      );
    },
  });
  await type(nameInput(), "Sales");
  await pickPerson("Ethan");
  await pickPerson("Saket");
  await click(createButton());

  assert.deepEqual(chipTexts(), ["Saket"]);
  assert.deepEqual(alertTexts(), ["Ethan is no longer in this workspace"]);
  assert.deepEqual(closes, []);
  // The primary stays Create team: what to fix is already off the form.
  assert.ok(createButton());
});

test("a failed invitation is reported beside who was added", async (t) => {
  const { toasts } = await mount(t, {
    sendInvitations: async ({ emails, onResult }) => {
      for (const email of emails) onResult(email, { ok: false, kind: "requestFailed" });
    },
  });
  await type(nameInput(), "Sales");
  await pickPerson("Ethan");
  await addAddress("alex@example.com");
  await click(createButton());

  assert.equal(readable(toasts()[0].title), "Created Sales. Couldn't invite 1 person.");
  assert.equal(toasts()[0].actions.length, 1, "Copy addresses");
});

test("a second try after a failed one sends the people on the form then, and invites once", async (t) => {
  let attempts = 0;
  const { callsTo } = await mount(t, {
    createTeam: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("socket hang up");
      return createdTeam();
    },
  });
  await type(nameInput(), "Sales");
  await pickPerson("Ethan");
  await addAddress("alex@example.com");
  await click(createButton());
  await pickPerson("Saket");
  await click(buttonNamed("Try again"));

  assert.deepEqual(
    callsTo("createTeam").map(([, , input]) => input.memberIds),
    [["ethan"], ["ethan", "saket"]]
  );
  assert.equal(callsTo("sendInvitations").length, 1);
});
