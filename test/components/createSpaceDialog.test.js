const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer } = require("../lib/rendererTestHarness");

// Mounts the dialog with the real Radix dialog, popover and dropdown in happy-dom, so closing,
// Escape and the people list behave as they do on screen. The services and stores are fakes the
// tests steer; strings come from the English file, so a missing key shows up as a missing label.

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

const team = (id, name, memberCount, emoji = null) => ({
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

// The creator is on the roster, as in any workspace; the field must not offer them.
const ROSTER = [
  member("me", "Ronnie", "ronnie@openronnie.com"),
  member("ethan", "Ethan"),
  member("saket", "Saket"),
];
const TEAMS = [team("sales", "Sales", 5), team("design", "Design Team", 2, "🎨")];

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
  role: "admin",
  capabilities: capabilities(overrides),
});

const localSpace = (overrides = {}) => ({ id: 7, cloud_space_id: "cloud-1", ...overrides });

let CloudApiError;
let CreateSpaceDialog;
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
  // React DOM decides at load time whether the DOM supports input events.
  ({ createRoot } = require("react-dom/client"));

  vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-create-space-dialog-",
    noExternal: ["react-i18next"],
    mockModules: {
      // Real English, with plural forms and interpolation, so a test reads what a person reads.
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
      // The API client reads the language from here, and the real one starts i18next.
      "/i18n": "export default { t: (key) => key, language: 'en' };",
      "/stores/workspaceStore": `
        export const useWorkspaceStore = Object.assign(
          (selector) => selector(globalThis.__store),
          { getState: () => globalThis.__store }
        );
      `,
      "/hooks/useWorkspace": "export const useWorkspace = () => globalThis.__workspaceHook;",
      "/hooks/useAuth": 'export const useAuth = () => ({ user: { id: "me" } });',
      "/ui/useToast":
        "export const useToast = () => ({ toast: (toast) => globalThis.__toasts.push(toast) });",
      "/services/spaceActions":
        "export const createSpace = (...args) => globalThis.__createSpace(...args);",
      "/services/invitePeople": `
        export const invitePeople = {
          sendInvitations: (input) => globalThis.__sendInvitations(input),
        };
      `,
      "/services/TeamsService":
        "export const TeamsService = { list: (id) => globalThis.__listTeams(id) };",
      "/services/WorkspacesService": `
        export const WorkspacesService = {
          previewSeats: async () => {
            throw new Error("no subscription");
          },
        };
      `,
      "/stores/noteStore": `
        export const revealContainer = (...args) => {
          if (globalThis.__revealThrows) throw new Error("store unavailable");
          globalThis.__navigation.push(["reveal", ...args]);
        };
        export const setActiveContext = (...args) => globalThis.__navigation.push(["context", ...args]);
      `,
      "/CreateWorkspaceDialog": `
        export default function CreateWorkspaceDialog() { return null; }
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
    },
  });
  ({ CloudApiError } = await vite.ssrLoadModule("/services/cloudApi.ts"));
  ({ default: CreateSpaceDialog } = await vite.ssrLoadModule(
    "/components/notes/CreateSpaceDialog.tsx"
  ));
});

test.after(async () => {
  await happyWindow.happyDOM.close();
});

const h = React.createElement;
const doc = () => happyWindow.document;
const dialog = () => doc().querySelector('[role="dialog"]');
const nameInput = () => doc().getElementById("create-space-name");
const descriptionInput = () => dialog()?.querySelector("textarea") ?? null;
const peopleInput = () => dialog()?.querySelector('input[role="combobox"]') ?? null;
const options = () => [...doc().querySelectorAll('[role="option"]')];
const chips = () => [...doc().querySelectorAll("[data-chip]")];
const switches = () => [...dialog().querySelectorAll('[role="switch"]')];
const buttons = () => [...dialog().querySelectorAll("button")];

// The text a person reads: aria-hidden decoration is left out, neighbouring elements are one
// space apart, and the bidi isolates that wrap names inside sentences are dropped.
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
const switchStates = () => switches().map((control) => control.getAttribute("aria-checked"));
const buttonNamed = (label) => buttons().find((button) => text(button) === label);
const createButton = () => buttonNamed("Create teamspace");
const retryButton = () => buttonNamed("Try again");

const act = (fn) => React.act(async () => fn());
const click = (element) => {
  assert.ok(element, "the control exists");
  return act(() =>
    element.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true, detail: 1 }))
  );
};
const setValue = (element, value, prototype) =>
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
    element.dispatchEvent(new happyWindow.Event("input", { bubbles: true }));
  });
const type = (element, value) => setValue(element, value, happyWindow.HTMLInputElement.prototype);
const typeText = (element, value) =>
  setValue(element, value, happyWindow.HTMLTextAreaElement.prototype);
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
// Lets the promises a click starts (the service calls and what follows them) run to the end.
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

// What a test steers: how the fakes answer. Each test gets its own calls log.
async function mount(
  t,
  {
    props = {},
    canManageMembers = true,
    createSpace = async () => localSpace(),
    sendInvitations = async ({ emails, onResult }) => {
      for (const email of emails) onResult(email, { ok: true, emailSent: true });
    },
    rosterFailures = 0,
    teamFailures = 0,
    workspaceFields = {},
  } = {}
) {
  const calls = [];
  const closes = [];
  const refreshes = [];
  const workspace = { ...workspaceWith({ manage_members: canManageMembers }), ...workspaceFields };
  const store = {
    error: null,
    loading: false,
    members: [],
    membersWorkspaceId: null,
    workspaces: [workspace],
    refreshMembers: async (workspaceId) => {
      calls.push(["roster", workspaceId]);
      if (rosterFailures > 0) {
        rosterFailures -= 1;
        throw new Error("offline");
      }
      store.members = ROSTER;
      store.membersWorkspaceId = workspaceId;
    },
    refresh: async (options) => {
      refreshes.push(options);
    },
  };
  globalThis.__store = store;
  globalThis.__workspaceHook = {
    workspaces: [workspace],
    active: workspace,
    loaded: true,
    refresh: async () => {},
  };
  globalThis.__toasts = [];
  globalThis.__navigation = [];
  globalThis.__listTeams = async (workspaceId) => {
    calls.push(["teams", workspaceId]);
    if (teamFailures > 0) {
      teamFailures -= 1;
      throw new Error("offline");
    }
    return TEAMS;
  };
  globalThis.__createSpace = async (workspaceId, input, access) => {
    calls.push(["createSpace", workspaceId, input, access]);
    return createSpace(workspaceId, input, access);
  };
  globalThis.__sendInvitations = async (input) => {
    calls.push(["sendInvitations", input]);
    return sendInvitations(input);
  };

  let reopen = () => {};
  function Host() {
    const [open, setOpen] = React.useState(true);
    reopen = () => setOpen(true);
    return h(CreateSpaceDialog, {
      open,
      onOpenChange: (next) => {
        closes.push(next);
        setOpen(next);
      },
      initialWorkspaceId: "w1",
      ...props,
    });
  }
  const container = doc().createElement("div");
  doc().body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => {
    await React.act(async () => root.unmount());
    container.remove();
    for (const name of [
      "__store",
      "__workspaceHook",
      "__toasts",
      "__navigation",
      "__listTeams",
      "__createSpace",
      "__sendInvitations",
    ]) {
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
    refreshes,
    reopen: () => act(() => reopen()),
    rerender: () => act(() => root.render(h(Host))),
    toasts: () => globalThis.__toasts,
    navigation: () => globalThis.__navigation,
    callsTo: (name) => calls.filter(([call]) => call === name),
  };
}

test("a new address says what it costs before the teamspace is made, and Create still goes", async (t) => {
  const { refreshes } = await mount(t, {
    workspaceFields: { has_subscription: true, seats: 8, seats_used: 8, billing_manager: "Olivia" },
  });
  await type(nameInput(), "Customer Calls");
  await pickPerson("Ethan");
  assert.doesNotMatch(text(dialog()), /Using 8 of 8 seats/, "people take no seat");

  await addAddress("new@example.com");
  await settle();

  assert.match(text(dialog()), /Using 8 of 8 seats/);
  assert.match(text(dialog()), /No seats left\. Ask Olivia to add seats\./);
  assert.deepEqual(refreshes, [{ fresh: true }]);
  assert.equal(createButton().disabled, false);
});

test("a fresh workspace list doesn't reload the people field under a typed address", async (t) => {
  const { callsTo, rerender } = await mount(t);
  await addAddress("new@example.com");
  const rosterReads = callsTo("roster").length;
  const groupReads = callsTo("groups").length;

  const fresh = { ...globalThis.__workspaceHook.active };
  globalThis.__workspaceHook = {
    ...globalThis.__workspaceHook,
    workspaces: [fresh],
    active: fresh,
  };
  globalThis.__store.workspaces = [fresh];
  await rerender();
  await settle();

  assert.equal(callsTo("roster").length, rosterReads);
  assert.equal(callsTo("groups").length, groupReads);
  assert.ok(peopleInput(), "the field stays");
});

test("Default and Open start off and travel in the request", async (t) => {
  const { callsTo } = await mount(t);
  assert.deepEqual(switchStates(), ["false", "false"]);
  assert.deepEqual(
    switches().map((control) => control.getAttribute("aria-label")),
    ["Default teamspace", "Open teamspace"]
  );
  assert.match(text(dialog()), /Add new workspace members automatically\./);
  assert.match(text(dialog()), /Let workspace members join\./);
  // A short window scrolls the form instead of pushing Create off the screen.
  assert.match(dialog().className, /max-h-\[calc\(100vh-32px\)\]/);
  assert.match(dialog().className, /overflow-y-auto/);

  await type(nameInput(), "Customer Calls");
  await click(createButton());

  assert.equal(callsTo("createSpace").length, 1);
  const [, workspaceId, input, access] = callsTo("createSpace")[0];
  assert.equal(workspaceId, "w1");
  assert.deepEqual(input, {
    name: "Customer Calls",
    emoji: null,
    is_default: false,
    is_open: false,
  });
  assert.deepEqual(access, { memberIds: [], teamIds: [] });
});

test("turning Default and Open on sends them on, with the description trimmed", async (t) => {
  const { callsTo } = await mount(t);
  await type(nameInput(), "  Customer Calls ");
  await typeText(descriptionInput(), "  Recordings from sales calls.  ");
  assert.equal(descriptionInput().getAttribute("dir"), "auto");
  assert.equal(descriptionInput().getAttribute("maxlength"), "280");
  assert.equal(
    descriptionInput().getAttribute("placeholder"),
    "Recordings and summaries from sales and support calls, one note per call."
  );

  await click(switches()[0]);
  assert.deepEqual(switchStates(), ["true", "false"]);
  await click(switches()[1]);
  assert.deepEqual(switchStates(), ["true", "true"]);
  await click(createButton());

  assert.deepEqual(callsTo("createSpace")[0][2], {
    name: "Customer Calls",
    emoji: null,
    description: "Recordings from sales calls.",
    is_default: true,
    is_open: true,
  });
});

test("a team waiting out its delete Undo isn't offered", async (t) => {
  const held = await vite.ssrLoadModule("/lib/heldTeamDeletes.ts");
  held.holdTeam("sales");
  t.after(() => held.forgetHeldTeams());
  await mount(t);

  await focus(peopleInput());
  assert.ok(!optionTexts().some((option) => option.startsWith("Sales")));
  assert.ok(optionTexts().some((option) => option.startsWith("Design Team")));
});

test("members and teams go in the create body, addresses as invitations afterward", async (t) => {
  const { calls, callsTo, closes, navigation, toasts, reopen } = await mount(t);
  await type(nameInput(), "Customer Calls");

  await focus(peopleInput());
  assert.ok(
    !optionTexts().some((option) => option.startsWith("Ronnie")),
    "the creator is their teamspace's admin already, so they are never offered"
  );
  await click(options().find((option) => text(option).startsWith("Saket")));
  await click(options().find((option) => text(option).startsWith("Sales")));
  await addAddress("newcomer@example.com");
  assert.deepEqual(chipTexts(), ["Saket", "Sales · 5 people", "newcomer@example.com"]);

  await click(createButton());

  assert.deepEqual(
    calls.map(([call]) => call).filter((call) => call !== "roster" && call !== "teams"),
    ["createSpace", "sendInvitations"],
    "the teamspace exists before anyone is invited into it"
  );
  assert.deepEqual(callsTo("createSpace")[0][3], { memberIds: ["saket"], teamIds: ["sales"] });
  const [, invitation] = callsTo("sendInvitations")[0];
  assert.equal(invitation.workspaceId, "w1");
  assert.deepEqual(invitation.emails, ["newcomer@example.com"]);
  assert.equal(invitation.role, "member");
  assert.deepEqual(invitation.spaceIds, ["cloud-1"]);

  assert.deepEqual(navigation(), [
    ["reveal", 7, null],
    ["context", 7, null],
  ]);
  assert.equal(readable(toasts()[0].title), "Created Customer Calls");
  assert.equal(toasts().length, 1);
  assert.deepEqual(closes, [false]);
  assert.ok(dialog() === null, "the dialog is gone");

  // The next teamspace starts from nothing.
  await reopen();
  await settle();
  assert.equal(nameInput().value, "");
  assert.equal(descriptionInput().value, "");
  assert.deepEqual(chipTexts(), []);
  assert.deepEqual(switchStates(), ["false", "false"]);
});

test("an invalid address blocks Create and shows the bar", async (t) => {
  const { callsTo } = await mount(t);
  await type(nameInput(), "Customer Calls");
  assert.equal(createButton().disabled, false);
  assert.deepEqual(alertTexts(), []);

  await focus(peopleInput());
  await type(peopleInput(), "saket@");
  await leaveField(peopleInput());
  assert.deepEqual(chipTexts(), ["saket@"]);
  assert.deepEqual(alertTexts(), ["Invalid email"]);
  assert.equal(createButton().disabled, true);
  // Enter in the name field is Create's shortcut, and it is blocked the same way.
  await press(nameInput(), "Enter");
  assert.equal(callsTo("createSpace").length, 0);

  // The bar sits at the top of the form, above Name & icon.
  const bar = dialog().querySelector('[role="alert"]');
  assert.ok(
    bar.compareDocumentPosition(nameInput()) & happyWindow.Node.DOCUMENT_POSITION_FOLLOWING,
    "the bar comes before the name field"
  );

  await click(chips()[0].querySelector("button"));
  assert.deepEqual(alertTexts(), []);
  assert.equal(createButton().disabled, false);
});

test("Create needs a name", async (t) => {
  const { callsTo } = await mount(t);
  assert.equal(createButton().disabled, true);
  await type(nameInput(), "   ");
  assert.equal(createButton().disabled, true);
  await press(nameInput(), "Enter");
  assert.equal(callsTo("createSpace").length, 0);
  await type(nameInput(), "Customer Calls");
  assert.equal(createButton().disabled, false);
});

test("a failure keeps every detail and offers Try again", async (t) => {
  let attempts = 0;
  const { callsTo, closes, toasts } = await mount(t, {
    createSpace: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("socket hang up");
      return localSpace();
    },
  });

  await click(dialog().querySelector('button[aria-label="Change emoji"]'));
  // The picker opens in a portal, outside the dialog's own markup.
  await click(
    [...doc().querySelectorAll("button")].find((button) => text(button) === "pick-target")
  );
  await type(nameInput(), "Customer Calls");
  await typeText(descriptionInput(), "Recordings from sales calls.");
  await click(switches()[0]);
  await click(switches()[1]);
  await pickPerson("Saket");
  await addAddress("newcomer@example.com");
  await click(createButton());

  assert.ok(dialog(), "the dialog stays open");
  assert.deepEqual(closes, []);
  assert.equal(nameInput().value, "Customer Calls");
  assert.match(text(dialog().querySelector('button[aria-label="Change emoji"]')), /🎯/);
  assert.equal(descriptionInput().value, "Recordings from sales calls.");
  assert.deepEqual(chipTexts(), ["Saket", "newcomer@example.com"]);
  assert.deepEqual(switchStates(), ["true", "true"]);
  assert.equal(callsTo("sendInvitations").length, 0, "nobody is invited into what wasn't made");

  // A centered destructive line above the switches, in place of a toast that would vanish.
  const line = dialog().querySelector('[role="alert"]');
  assert.equal(text(line), "Couldn't create teamspace. Your details are saved. Try again.");
  assert.match(line.className, /destructive/);
  assert.match(line.className, /text-center/);
  assert.ok(
    line.compareDocumentPosition(switches()[0]) & happyWindow.Node.DOCUMENT_POSITION_FOLLOWING,
    "the line sits above the switches"
  );
  assert.deepEqual(toasts(), []);
  assert.ok(retryButton(), "the primary reads Try again");
  assert.ok(!createButton());
  assert.equal(retryButton().disabled, false);

  await click(retryButton());
  assert.equal(callsTo("createSpace").length, 2);
  assert.deepEqual(
    callsTo("createSpace")[1].slice(1),
    callsTo("createSpace")[0].slice(1),
    "the same request again"
  );
  assert.deepEqual(callsTo("createSpace")[1][2], {
    name: "Customer Calls",
    emoji: "🎯",
    description: "Recordings from sales calls.",
    is_default: true,
    is_open: true,
  });
  assert.equal(callsTo("sendInvitations").length, 1);
  assert.deepEqual(closes, [false]);
});

test("a taken name points at the name field, and editing clears it", async (t) => {
  let attempts = 0;
  const { callsTo, closes } = await mount(t, {
    createSpace: async () => {
      attempts += 1;
      if (attempts === 1) throw new CloudApiError("Name taken", 409, "space_name_taken");
      return localSpace();
    },
  });
  await type(nameInput(), "Customer Calls");
  await typeText(descriptionInput(), "Recordings from sales calls.");
  await pickPerson("Saket");
  await click(createButton());

  assert.ok(dialog(), "the dialog stays open");
  assert.deepEqual(closes, []);
  const errorId = nameInput().getAttribute("aria-describedby");
  assert.ok(errorId, "the name field names its error");
  const error = doc().getElementById(errorId);
  assert.equal(text(error), "A teamspace called Customer Calls already exists");
  assert.equal(nameInput().getAttribute("aria-invalid"), "true");
  assert.ok(
    nameInput().parentElement.compareDocumentPosition(error) &
      happyWindow.Node.DOCUMENT_POSITION_FOLLOWING,
    "the error is under the name"
  );
  assert.ok(doc().activeElement === nameInput(), "focus returns to the name to fix it");
  // The rest is kept, and this is a name to change, not a retry of the same request.
  assert.equal(descriptionInput().value, "Recordings from sales calls.");
  assert.deepEqual(chipTexts(), ["Saket"]);
  assert.ok(createButton(), "the primary still reads Create teamspace");
  assert.ok(!retryButton());
  assert.deepEqual(
    alertTexts().filter((line) => line.includes("Couldn't create")),
    []
  );

  await type(nameInput(), "Customer Calls 2");
  assert.equal(nameInput().getAttribute("aria-describedby"), null);
  assert.equal(nameInput().getAttribute("aria-invalid"), null);
  assert.ok(doc().getElementById(errorId) === null, "editing clears the error");

  await click(createButton());
  assert.equal(callsTo("createSpace")[1][2].name, "Customer Calls 2");
  assert.deepEqual(closes, [false]);
});

test("a refusal shows the server's own message in the bar", async (t) => {
  const { closes } = await mount(t, {
    createSpace: async () => {
      throw new CloudApiError("Your plan allows 3 teamspaces", 400);
    },
  });
  await type(nameInput(), "Customer Calls");
  await click(createButton());

  assert.deepEqual(alertTexts(), ["Your plan allows 3 teamspaces"]);
  assert.ok(dialog(), "the dialog stays open");
  assert.deepEqual(closes, []);
  assert.equal(nameInput().value, "Customer Calls");
  assert.ok(
    dialog().querySelector('[role="alert"]').compareDocumentPosition(nameInput()) &
      happyWindow.Node.DOCUMENT_POSITION_FOLLOWING,
    "the bar is at the top of the form"
  );
});

test("someone who left the workspace is dropped, so Try again can succeed", async (t) => {
  let attempts = 0;
  const { callsTo, closes } = await mount(t, {
    createSpace: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new CloudApiError("Not workspace members", 400, "not_workspace_members", {
          user_ids: ["saket"],
        });
      }
      return localSpace();
    },
  });
  await type(nameInput(), "Customer Calls");
  await pickPerson("Saket");
  await pickPerson("Ethan");
  await addAddress("newcomer@example.com");
  await click(createButton());

  assert.deepEqual(closes, []);
  assert.deepEqual(chipTexts(), ["Ethan", "newcomer@example.com"], "only the one who left goes");
  assert.match(text(dialog()), /Saket left the workspace, so they weren't added\./);

  await click(createButton());
  assert.deepEqual(callsTo("createSpace")[1][3], { memberIds: ["ethan"], teamIds: [] });
  assert.deepEqual(closes, [false]);
});

test("a team deleted since the list loaded is dropped and named", async (t) => {
  let attempts = 0;
  const { callsTo, closes } = await mount(t, {
    createSpace: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new CloudApiError("Teams unavailable", 400, "teams_not_available", {
          team_ids: ["sales"],
        });
      }
      return localSpace();
    },
  });
  await type(nameInput(), "Customer Calls");
  await pickPerson("Sales");
  await pickPerson("Ethan");
  await click(createButton());

  assert.deepEqual(chipTexts(), ["Ethan"]);
  assert.match(text(dialog()), /Sales is no longer available, so it wasn't added\./);

  await click(createButton());
  assert.deepEqual(callsTo("createSpace")[1][3], { memberIds: ["ethan"], teamIds: [] });
  assert.deepEqual(closes, [false]);
});

test("initialTeam is staged and sent", async (t) => {
  const { callsTo } = await mount(t, { props: { initialTeam: TEAMS[0] } });

  assert.deepEqual(chipTexts(), ["Sales · 5 people"]);

  await type(nameInput(), "Research");
  await click(createButton());

  assert.deepEqual(callsTo("createSpace")[0][3], { memberIds: [], teamIds: ["sales"] });
});

test("a team no longer available drops with today's message", async (t) => {
  let attempts = 0;
  const { callsTo, closes } = await mount(t, {
    props: { initialTeam: TEAMS[0] },
    createSpace: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new CloudApiError("Teams unavailable", 400, "teams_not_available", {
          team_ids: ["sales"],
        });
      }
      return localSpace();
    },
  });
  await type(nameInput(), "Research");
  await click(createButton());

  assert.deepEqual(chipTexts(), []);
  assert.match(text(dialog()), /Sales is no longer available, so it wasn't added\./);

  await click(createButton());
  assert.deepEqual(callsTo("createSpace")[1][3], { memberIds: [], teamIds: [] });
  assert.deepEqual(closes, [false]);
});

test("a refusal naming nobody keeps the general failure and its retry", async (t) => {
  const { closes } = await mount(t, {
    createSpace: async () => {
      throw new CloudApiError("Not workspace members", 400, "not_workspace_members", {});
    },
  });
  await type(nameInput(), "Customer Calls");
  await pickPerson("Saket");
  await click(createButton());

  assert.deepEqual(closes, []);
  assert.deepEqual(chipTexts(), ["Saket"]);
  assert.ok(retryButton());
});

test("needing SSO says so, with nothing to try again", async (t) => {
  const { closes } = await mount(t, {
    createSpace: async () => {
      throw new CloudApiError("SSO required", 403, "SSO_REQUIRED");
    },
  });
  await type(nameInput(), "Customer Calls");
  await click(createButton());

  assert.deepEqual(closes, []);
  assert.match(
    text(dialog()),
    /Your organization requires company SSO\. Sign in with SSO and try again\./
  );
  assert.ok(!retryButton());
  assert.ok(createButton());
});

test("failed invitations still report the teamspace as created, refused ones included", async (t) => {
  const outcomes = {
    "ok@example.com": { ok: true, emailSent: true },
    "broken@example.com": { ok: false, kind: "requestFailed" },
    "full@example.com": { ok: false, kind: "seatLimit" },
    // Neither person is in it: a member is refused outright, and an older API attaches no
    // teamspace to an invitation that already exists.
    "member@example.com": { ok: false, kind: "alreadyMember" },
    "waiting@example.com": { ok: false, kind: "alreadyInvited" },
  };
  const { closes, navigation, toasts } = await mount(t, {
    sendInvitations: async ({ emails, onResult }) => {
      for (const email of emails) onResult(email, outcomes[email]);
    },
  });
  await type(nameInput(), "Customer Calls");
  for (const address of Object.keys(outcomes)) await addAddress(address);
  await click(createButton());

  assert.equal(
    readable(toasts()[0].title),
    "Created Customer Calls. Couldn't invite 4 people. Invite them from Members."
  );
  assert.equal(toasts().length, 1, "one message, not a success and an error");
  assert.deepEqual(closes, [false], "the teamspace exists, so the dialog closes");
  assert.deepEqual(navigation(), [
    ["reveal", 7, null],
    ["context", 7, null],
  ]);
});

test("an address whose invitation took the teamspace counts as invited", async (t) => {
  const { toasts } = await mount(t, {
    sendInvitations: async ({ emails, onResult }) => {
      for (const email of emails) {
        onResult(email, { ok: false, kind: "alreadyInvited", grantsAdded: true });
      }
    },
  });
  await type(nameInput(), "Customer Calls");
  await addAddress("waiting@example.com");
  await click(createButton());

  assert.equal(readable(toasts()[0].title), "Created Customer Calls");
});

test("only the invitations that didn't take the teamspace are counted as not invited", async (t) => {
  const outcomes = {
    "added@example.com": { ok: false, kind: "alreadyInvited", grantsAdded: true },
    "waiting@example.com": { ok: false, kind: "alreadyInvited" },
  };
  const { toasts } = await mount(t, {
    sendInvitations: async ({ emails, onResult }) => {
      for (const email of emails) onResult(email, outcomes[email]);
    },
  });
  await type(nameInput(), "Customer Calls");
  for (const address of Object.keys(outcomes)) await addAddress(address);
  await click(createButton());

  assert.equal(
    readable(toasts()[0].title),
    "Created Customer Calls. Couldn't invite 1 person. Invite them from Members."
  );
});

test("a reveal that throws doesn't leave the dialog stuck on Creating", async (t) => {
  const errors = [];
  t.mock.method(console, "error", (...args) => errors.push(args));
  const { closes } = await mount(t);
  globalThis.__revealThrows = true;
  t.after(() => delete globalThis.__revealThrows);
  await type(nameInput(), "Customer Calls");
  await click(createButton());

  assert.deepEqual(closes, [false], "the teamspace exists, so the way out stays open");
  assert.equal(errors.length, 1);
});

test("the toast names who wasn't invited, and can copy them all", async (t) => {
  const writes = [];
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value) => writes.push(value) },
  });
  t.after(() => delete globalThis.navigator.clipboard);
  const addresses = Array.from({ length: 7 }, (_, index) => `p${index}@example.com`);
  const { toasts } = await mount(t, {
    sendInvitations: async ({ emails, onResult }) => {
      for (const email of emails) onResult(email, { ok: false, kind: "requestFailed" });
    },
  });
  await type(nameInput(), "Customer Calls");
  for (const address of addresses) await addAddress(address);
  await click(createButton());

  assert.match(
    readable(toasts()[0].description),
    /^Not invited: p0@example\.com.*p4@example\.com +\+2\.$/
  );
  assert.equal(toasts()[0].actions[0].label, "Copy addresses");
  assert.equal(toasts()[0].actions[0].dismissOnClick, false);

  assert.equal(await toasts()[0].actions[0].onClick(), true);
  assert.deepEqual(writes, [addresses.join("\n")]);
});

test("an invitation whose email didn't arrive isn't reported as a plain success", async (t) => {
  const { toasts } = await mount(t, {
    sendInvitations: async ({ emails, onResult }) => {
      for (const email of emails) onResult(email, { ok: true, emailSent: false });
    },
  });
  await type(nameInput(), "Customer Calls");
  await addAddress("alex@example.com");
  await click(createButton());

  assert.equal(readable(toasts()[0].title), "Created Customer Calls");
  assert.equal(
    readable(toasts()[0].description),
    "1 invitation was created, but its email couldn't be delivered. Resend it from Invitations."
  );
});

test("more addresses than one invitation batch takes blocks Create and says why", async (t) => {
  const { callsTo } = await mount(t);
  await type(nameInput(), "Customer Calls");
  await focus(peopleInput());
  const addresses = Array.from({ length: 101 }, (_, index) => `p${index}@example.com`);
  await type(peopleInput(), `${addresses.join(", ")},`);

  assert.equal(chips().length, 101);
  assert.match(text(dialog()), /You can invite up to 100 people at a time\./);
  assert.equal(createButton().disabled, true);
  assert.equal(callsTo("createSpace").length, 0);
});

test("one failed invitation reads in the singular", async (t) => {
  const { toasts } = await mount(t, {
    sendInvitations: async ({ emails, onResult }) => {
      for (const email of emails) onResult(email, { ok: false, kind: "requestFailed" });
    },
  });
  await type(nameInput(), "Customer Calls");
  await addAddress("broken@example.com");
  await click(createButton());
  assert.equal(
    readable(toasts()[0].title),
    "Created Customer Calls. Couldn't invite 1 person. Invite them from Members."
  );
});

test("a teamspace with no cloud id can't take invitations, and says so", async (t) => {
  const { callsTo, closes, toasts } = await mount(t, {
    createSpace: async () => localSpace({ cloud_space_id: null }),
  });
  await type(nameInput(), "Customer Calls");
  await addAddress("a@example.com");
  await addAddress("b@example.com");
  await click(createButton());

  assert.equal(callsTo("sendInvitations").length, 0);
  assert.equal(
    readable(toasts()[0].title),
    "Created Customer Calls. Couldn't invite 2 people. Invite them from Members."
  );
  assert.deepEqual(closes, [false]);
});

test("no addresses sends no invitation", async (t) => {
  const { callsTo, closes, toasts } = await mount(t);
  await type(nameInput(), "Customer Calls");
  await pickPerson("Saket");
  await click(createButton());

  assert.equal(callsTo("createSpace").length, 1);
  assert.equal(callsTo("sendInvitations").length, 0);
  assert.equal(readable(toasts()[0].title), "Created Customer Calls");
  assert.deepEqual(closes, [false]);
});

test("Creating blocks closing", async (t) => {
  let finish;
  const { callsTo, closes } = await mount(t, {
    createSpace: () => new Promise((resolve) => (finish = resolve)),
  });
  await type(nameInput(), "Customer Calls");
  await click(createButton());

  assert.equal(callsTo("createSpace").length, 1);
  const primary = buttonNamed("Creating");
  assert.ok(primary, "the primary reads Creating");
  assert.equal(primary.disabled, true);
  assert.equal(buttonNamed("Cancel").disabled, true);
  assert.ok(
    switches().every((control) => control.disabled),
    "the switches wait too"
  );

  // Neither Esc nor a click on the overlay closes it, and Enter doesn't send it twice.
  await press(nameInput(), "Escape");
  await act(() =>
    doc()
      .querySelector("div.inset-0")
      .dispatchEvent(new happyWindow.PointerEvent("pointerdown", { bubbles: true }))
  );
  await press(nameInput(), "Enter");
  assert.deepEqual(closes, []);
  assert.ok(dialog(), "still open");
  assert.equal(callsTo("createSpace").length, 1);

  await act(() => finish(localSpace()));
  await settle();
  assert.deepEqual(closes, [false]);
});

test("a dialog that isn't creating closes on Escape and Cancel", async (t) => {
  const { closes, callsTo, reopen } = await mount(t);
  await type(nameInput(), "Customer Calls");
  await press(nameInput(), "Escape");
  assert.deepEqual(closes, [false]);
  assert.ok(dialog() === null);

  await reopen();
  await settle();
  assert.ok(dialog(), "the dialog is back");
  await click(buttonNamed("Cancel"));
  assert.deepEqual(closes, [false, false]);
  assert.ok(dialog() === null);
  assert.equal(callsTo("createSpace").length, 0);
});

test("the Settings page's create doesn't reveal", async (t) => {
  const { closes, navigation, toasts } = await mount(t, { props: { revealOnCreate: false } });
  await type(nameInput(), "Customer Calls");
  await click(createButton());

  assert.deepEqual(
    navigation(),
    [],
    "revealing a container behind the modal would only move Notes"
  );
  assert.equal(readable(toasts()[0].title), "Created Customer Calls");
  assert.deepEqual(closes, [false]);
});

test("someone who can't manage members is never offered to invite an address", async (t) => {
  await mount(t, { canManageMembers: false });
  await focus(peopleInput());
  await type(peopleInput(), "new@example.com");
  assert.deepEqual(optionTexts(), []);
  assert.match(text(doc().querySelector('[role="status"]')), /Try another name\./);
});

test("a roster that fails to load offers a retry in place of the field", async (t) => {
  const { callsTo } = await mount(t, { rosterFailures: 1 });
  assert.ok(peopleInput() === null, "no field to pick from while nothing loaded");
  assert.match(text(dialog()), /Couldn't load members/);

  // Creating without people never waits on the roster.
  await type(nameInput(), "Customer Calls");
  assert.equal(createButton().disabled, false);

  await click(buttonNamed("Retry"));
  await settle();
  assert.ok(peopleInput(), "the field is back once the roster is");
  assert.equal(callsTo("roster").length, 2);
});

test("teams that fail to load offer a retry too", async (t) => {
  const { callsTo } = await mount(t, { teamFailures: 1 });
  assert.ok(peopleInput() === null);
  assert.match(text(dialog()), /Couldn't load teams/);

  await click(buttonNamed("Retry"));
  await settle();
  assert.ok(peopleInput());
  assert.equal(callsTo("teams").length, 2);
  await focus(peopleInput());
  assert.ok(optionTexts().some((option) => option.startsWith("Sales")));
});
