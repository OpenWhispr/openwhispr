const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer } = require("../lib/rendererTestHarness");

// Mounts the field with the real Radix popover, dropdown and dialog in happy-dom, so the focus,
// layering and Escape behaviour under test are Radix's own. Strings come from the English file.

const DOM_GLOBALS = [
  "document",
  "navigator",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
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

const ROSTER = [
  member("ethan", "Ethan"),
  member("saket", "Saket"),
  member("bob", "Bob", "bov@openronnie.com"),
];
const GROUPS = [group("sales", "Sales", 5), group("design", "Design Team", 2, "🎨")];

let createRoot;
let happyWindow;
let vite;
let SpacePeopleField;
let Dialog;
let DialogContent;
let DialogTitle;
let DialogDescription;

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
    cachePrefix: "openwhispr-space-people-field-",
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
        export const useTranslation = () => ({ t });
      `,
    },
  });
  ({ SpacePeopleField } = await vite.ssrLoadModule("/components/notes/SpacePeopleField.tsx"));
  ({ Dialog, DialogContent, DialogTitle, DialogDescription } = await vite.ssrLoadModule(
    "/components/ui/dialog.tsx"
  ));
});

test.after(async () => {
  await happyWindow.happyDOM.close();
});

const h = React.createElement;
const doc = () => happyWindow.document;
const input = () => doc().querySelector('input[role="combobox"]');
const listbox = () => doc().querySelector('[role="listbox"]');
const options = () => [...doc().querySelectorAll('[role="option"]')];
const chips = () => [...doc().querySelectorAll("[data-chip]")];
// The text a person reads: aria-hidden decoration (avatars, tiles) is left out, neighbouring
// elements are one space apart, and the bidi isolates that wrap names and addresses inside
// sentences are dropped.
const readable = (value) =>
  value
    .replace(/[\u2068\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
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
const optionTexts = () => options().map(text);
// Compared as a boolean: a failed assert.equal on DOM nodes spends minutes printing the document.
const assertFocused = (message = "focus is in the field") =>
  assert.ok(doc().activeElement === input(), message);
const selected = () => options().map((option) => option.getAttribute("aria-selected"));
// The row the arrow keys are on, which the field names with aria-activedescendant.
const highlighted = () =>
  options().findIndex((option) => option.id === input().getAttribute("aria-activedescendant"));
// A picked row ends in a check; a member's or group's row has no other drawn icon.
const checked = () => options().map((option) => option.querySelector("svg") !== null);
const chipTexts = () => chips().map(text);

const act = (fn) => React.act(async () => fn());
const focus = (element) => act(() => element.focus());
const click = (element) => {
  assert.ok(element, "the control exists");
  return act(() =>
    element.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true, detail: 1 }))
  );
};
const type = (element, value) =>
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      happyWindow.HTMLInputElement.prototype,
      "value"
    ).set;
    setter.call(element, value);
    element.dispatchEvent(new happyWindow.Event("input", { bubbles: true }));
  });
const press = (element, key) =>
  act(() =>
    element.dispatchEvent(
      new happyWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
    )
  );
const leaveField = (element, relatedTarget = null) =>
  act(() =>
    element.dispatchEvent(new happyWindow.FocusEvent("focusout", { bubbles: true, relatedTarget }))
  );
// Focusing the focused field is a no-op in a browser as it is here, so a field that was left
// (see leaveField) is left for real before it is entered again.
const refocus = async () => {
  await act(() => input().blur());
  await focus(input());
};
// Resolves to whether the field took the paste over from the browser.
const paste = async (element, pasted) => {
  const event = new happyWindow.Event("paste", { bubbles: true, cancelable: true });
  event.clipboardData = { getData: () => pasted };
  await act(() => element.dispatchEvent(event));
  return event.defaultPrevented;
};

// A controlled host, like the dialogs that will own the staged list.
async function mount(t, props = {}, { dialog = false, onDialogOpenChange = () => {} } = {}) {
  const changes = [];
  function Host() {
    const [picked, setPicked] = React.useState(props.picked ?? []);
    const field = h(SpacePeopleField, {
      id: "people",
      roster: ROSTER,
      groups: GROUPS,
      canInvite: true,
      inviteRoleChoice: false,
      placeholder: "Names, emails, or groups",
      ...props,
      picked,
      onChange: (next) => {
        changes.push(next);
        setPicked(next);
      },
    });
    if (!dialog) return field;
    return h(
      Dialog,
      { open: true, onOpenChange: onDialogOpenChange },
      h(
        DialogContent,
        null,
        h(DialogTitle, null, "Create teamspace"),
        h(DialogDescription, null, "A shared area."),
        field
      )
    );
  }
  const container = doc().createElement("div");
  doc().body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => {
    await React.act(async () => root.unmount());
    container.remove();
  });
  await React.act(async () => {
    root.render(h(Host));
  });
  const lastChange = () => changes.at(-1);
  return { changes, lastChange };
}

test("focusing the empty field lists people and groups, with a group's count", async (t) => {
  await mount(t);
  assert.ok(listbox() === null, "closed until the field has focus");
  await focus(input());
  assert.deepEqual(optionTexts(), [
    "Ethan ethan@openronnie.com",
    "Saket saket@openronnie.com",
    "Bob bov@openronnie.com",
    "Sales 5 people",
    "Design Team 2 people",
  ]);
  assert.equal(input().getAttribute("aria-expanded"), "true");
});

test("picking adds a chip and clears the query", async (t) => {
  const { lastChange } = await mount(t);
  await focus(input());
  await type(input(), "sa");
  assert.deepEqual(optionTexts(), ["Saket saket@openronnie.com", "Sales 5 people"]);

  await click(options()[0]);
  assert.deepEqual(lastChange(), [
    { kind: "member", userId: "saket", label: "Saket", email: "saket@openronnie.com" },
  ]);
  assert.equal(input().value, "", "the query is cleared");
  assert.deepEqual(chipTexts(), ["Saket"]);
  assert.ok(input().closest("[data-chip]") === null, "chips sit under the field, never inside it");
  // The field keeps focus and the list stays open: Saket is still there, with a check.
  assertFocused();
  assert.ok(listbox(), "the list stays open after a pick");
  assert.deepEqual(optionTexts(), [
    "Ethan ethan@openronnie.com",
    "Saket saket@openronnie.com",
    "Bob bov@openronnie.com",
    "Sales 5 people",
    "Design Team 2 people",
  ]);
  assert.deepEqual(selected(), ["false", "true", "false", "false", "false"]);
  assert.deepEqual(checked(), [false, true, false, false, false]);

  // A group becomes a chip with its size.
  await click(options()[3]);
  assert.deepEqual(lastChange().at(-1), {
    kind: "group",
    teamId: "sales",
    label: "Sales",
    memberCount: 5,
  });
  assert.deepEqual(chipTexts(), ["Saket", "Sales · 5 people"]);
  assert.deepEqual(selected(), ["false", "true", "false", "true", "false"]);
});

test("picking a checked row removes its chip", async (t) => {
  const { changes, lastChange } = await mount(t);
  await focus(input());
  await click(options()[1]);
  await click(options()[3]);
  assert.deepEqual(chipTexts(), ["Saket", "Sales · 5 people"]);

  // Pressing the row takes the person out again, and the check goes with the chip. The query
  // clears for this as for any pick.
  await type(input(), "sa");
  assert.deepEqual(selected(), ["true", "true"]);
  await click(options()[0]);
  assert.equal(input().value, "");
  assert.deepEqual(
    lastChange().map((recipient) => recipient.kind),
    ["group"]
  );
  assert.deepEqual(chipTexts(), ["Sales · 5 people"]);
  assert.deepEqual(selected(), ["false", "false", "false", "true", "false"]);
  assert.deepEqual(checked(), [false, false, false, true, false]);
  assert.ok(listbox(), "the list stays open");

  // So does Enter on the highlighted row; a group is taken out the same way.
  await type(input(), "sal");
  await press(input(), "ArrowDown");
  assert.equal(highlighted(), 0, "Sales is the only row, and it is checked");
  await press(input(), "Enter");
  assert.deepEqual(lastChange(), []);
  assert.deepEqual(chipTexts(), []);
  assert.equal(input().value, "", "the query clears as after any pick");
  assert.deepEqual(selected(), ["false", "false", "false", "false", "false"]);

  // Picking it once more stages it again: the row toggles.
  await click(options()[0]);
  assert.deepEqual(lastChange(), [
    { kind: "member", userId: "ethan", label: "Ethan", email: "ethan@openronnie.com" },
  ]);
  assert.equal(changes.length, 5);
});

test("chips show who they are: a name, a group's glyph, an address", async (t) => {
  await mount(t, {
    inviteRoleChoice: true,
    picked: [
      { kind: "group", teamId: "design", label: "Design Team", memberCount: 2 },
      { kind: "group", teamId: "sales", label: "Sales", memberCount: 5 },
      { kind: "email", email: "alex@example.com", role: "admin", valid: true },
    ],
  });
  assert.deepEqual(chipTexts(), [
    "Design Team · 2 people",
    "Sales · 5 people",
    "alex@example.com · Admin",
  ]);
  // The group's own emoji, else its initial, and a mail glyph for an address.
  const glyphs = chips().map((chip) => chip.querySelector('[aria-hidden="true"]'));
  assert.equal(glyphs[0].textContent, "🎨");
  assert.equal(glyphs[1].textContent, "S");
  assert.ok(glyphs[2].querySelector("svg"));
  assert.equal(chips().filter((chip) => chip.hasAttribute("data-invalid")).length, 0);
});

test("Enter in the field never submits the dialog around it", async (t) => {
  await mount(t, {}, { dialog: true });
  await focus(input());
  const event = new happyWindow.KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
  });
  await act(() => input().dispatchEvent(event));
  assert.equal(event.defaultPrevented, true);
});

test("a chip's × takes the person out again", async (t) => {
  const { lastChange } = await mount(t, {
    picked: [
      { kind: "member", userId: "saket", label: "Saket", email: "saket@openronnie.com" },
      { kind: "group", teamId: "sales", label: "Sales", memberCount: 1 },
    ],
  });
  assert.deepEqual(chipTexts(), ["Saket", "Sales · 1 person"]);
  const remove = chips()[0].querySelector("button");
  assert.equal(readable(remove.getAttribute("aria-label")), "Remove Saket");
  await click(remove);
  assert.deepEqual(lastChange(), [
    { kind: "group", teamId: "sales", label: "Sales", memberCount: 1 },
  ]);
  assert.deepEqual(chipTexts(), ["Sales · 1 person"]);
});

test("arrow keys move over the rows that can be picked and Enter picks", async (t) => {
  const { lastChange } = await mount(t, { accessUserIds: new Set(["saket"]) });
  await focus(input());
  assert.equal(highlighted(), -1, "nothing is highlighted until an arrow key");

  await press(input(), "ArrowDown");
  assert.equal(highlighted(), 0);
  // Saket already has access: the arrow steps over him.
  await press(input(), "ArrowDown");
  assert.equal(highlighted(), 2);
  await press(input(), "ArrowUp");
  await press(input(), "ArrowUp");
  assert.equal(highlighted(), 4, "wraps around");
  // Highlighting is not picking: aria-selected says who is picked.
  assert.deepEqual(selected(), ["false", "false", "false", "false", "false"]);

  await press(input(), "Enter");
  assert.equal(lastChange()[0].kind, "group");
  assert.equal(lastChange()[0].teamId, "design");
  assert.deepEqual(selected(), ["false", "false", "false", "false", "true"]);
});

test("someone with access shows disabled and can't be picked", async (t) => {
  const { changes } = await mount(t, {
    accessUserIds: new Set(["ethan"]),
    accessGroupIds: new Set(["sales"]),
  });
  await focus(input());
  assert.deepEqual(optionTexts(), [
    "Ethan Already has access",
    "Saket saket@openronnie.com",
    "Bob bov@openronnie.com",
    "Sales Already has access · 5 people",
    "Design Team 2 people",
  ]);
  const [ethan, , , sales] = options();
  assert.equal(ethan.getAttribute("aria-disabled"), "true");
  assert.equal(sales.getAttribute("aria-disabled"), "true");
  await click(ethan);
  await click(sales);
  assert.equal(changes.length, 0);
});

test("an address with no match offers an invite only to those who can", async (t) => {
  await mount(t, { canInvite: false });
  await focus(input());
  await type(input(), "alex@example.com");
  assert.equal(options().length, 0, "no row to invite");
  assert.equal(
    text(doc().querySelector('[role="status"]')),
    "No people or groups found Try another name."
  );
});

test("without a role choice the invite row says no member and stages a Member", async (t) => {
  const { lastChange } = await mount(t, { inviteRoleChoice: false });
  await focus(input());
  await type(input(), "alex@example.com");
  assert.deepEqual(optionTexts(), ["alex@example.com No member found Invite to workspace"]);
  assert.equal(
    doc().querySelector('[role="option"] [aria-haspopup="menu"]'),
    null,
    "no role menu on this surface"
  );

  await click(options()[0]);
  assert.deepEqual(lastChange(), [
    { kind: "email", email: "alex@example.com", role: "member", valid: true },
  ]);
  assert.equal(input().value, "");
  // The role is only part of the chip when the surface offers a choice of it.
  assert.deepEqual(chipTexts(), ["alex@example.com"]);
});

test("Select stages the address with its chosen role", async (t) => {
  const { lastChange } = await mount(t, { inviteRoleChoice: true });
  await focus(input());
  await type(input(), "alex@example.com");
  assert.deepEqual(optionTexts(), [
    "alex@example.com New to workspace Workspace role Member Select",
  ]);

  // The role menu opens in the list, and opening it keeps the list and the typed address.
  const trigger = doc().querySelector('[role="option"] [aria-haspopup="menu"]');
  assert.ok(trigger, "the invite row has a role menu");
  await press(trigger, "ArrowDown");
  const items = [...doc().querySelectorAll('[role="menuitemradio"]')];
  assert.deepEqual(items.map(text), [
    "Workspace Member Can view and edit notes.",
    "Workspace Admin Manages members, invites, teams, and settings.",
  ]);
  assert.equal(items[0].getAttribute("aria-checked"), "true", "Member by default");
  await click(items[1]);
  assert.equal(input().value, "alex@example.com", "choosing a role stages nothing");
  assert.equal(doc().querySelectorAll('[role="menuitemradio"]').length, 0);
  assert.deepEqual(optionTexts(), [
    "alex@example.com New to workspace Workspace role Admin Select",
  ]);

  const select = [...doc().querySelectorAll("button")].find((button) => text(button) === "Select");
  await click(select);
  assert.deepEqual(lastChange(), [
    { kind: "email", email: "alex@example.com", role: "admin", valid: true },
  ]);
  assert.deepEqual(chipTexts(), ["alex@example.com · Admin"]);

  // The next address starts from Member again, so an admin is never invited by carry-over.
  await type(input(), "kim@example.com");
  assert.deepEqual(optionTexts(), [
    "kim@example.com New to workspace Workspace role Member Select",
  ]);
});

test("a member's address picks the member, in any capitalisation", async (t) => {
  const { lastChange } = await mount(t, { inviteRoleChoice: true });
  await focus(input());
  await type(input(), "ETHAN@OpenRonnie.com");
  // The row is the member, and there is nobody to invite.
  assert.deepEqual(optionTexts(), ["Ethan ethan@openronnie.com"]);
  await press(input(), "Enter");
  assert.deepEqual(lastChange(), [
    { kind: "member", userId: "ethan", label: "Ethan", email: "ethan@openronnie.com" },
  ]);
  assert.equal(input().value, "");
});

test("no results tell the inviter they can enter an address, and others they can't", async (t) => {
  await mount(t, { canInvite: true });
  await focus(input());
  await type(input(), "Research");
  assert.equal(options().length, 0);
  const status = doc().querySelector('[role="status"]');
  assert.equal(
    text(status),
    "No people or groups found Try another name or enter a full email address."
  );
  assert.equal(input().getAttribute("aria-controls"), null);
});

test("no results without the right to invite say only to try another name", async (t) => {
  await mount(t, { canInvite: false });
  await focus(input());
  await type(input(), "Research");
  assert.equal(
    text(doc().querySelector('[role="status"]')),
    "No people or groups found Try another name."
  );
});

test("an address nobody matches is not staged by someone who can't invite", async (t) => {
  const { changes } = await mount(t, { canInvite: false });
  await focus(input());
  await type(input(), "alex@example.com");
  await press(input(), "Enter");
  assert.equal(changes.length, 0, "nothing staged");
  assert.equal(input().value, "alex@example.com", "the text stays, so it is clear nothing took it");
  // A member's address still works.
  await type(input(), "saket@openronnie.com");
  await press(input(), "Enter");
  assert.equal(changes.at(-1)[0].userId, "saket");
});

test("Escape closes the list and keeps the dialog", async (t) => {
  const dialogChanges = [];
  await mount(t, {}, { dialog: true, onDialogOpenChange: (open) => dialogChanges.push(open) });
  await focus(input());
  assert.ok(listbox(), "the list is open");

  await press(input(), "Escape");
  assert.ok(listbox() === null, "the list closed");
  assert.ok(doc().querySelector('[role="dialog"]'), "the dialog is still there");
  assert.deepEqual(dialogChanges, [], "the dialog was not asked to close");
  assertFocused("focus stays in the field");

  // With the list closed, Escape is the dialog's again.
  await press(input(), "Escape");
  assert.deepEqual(dialogChanges, [false]);
});

test("typing or an arrow key brings the list back after Escape", async (t) => {
  await mount(t, {}, { dialog: true });
  await focus(input());
  await press(input(), "Escape");
  assert.ok(listbox() === null, "the list is closed");
  await type(input(), "e");
  assert.ok(listbox(), "typing reopens it");
  await press(input(), "Escape");
  assert.ok(listbox() === null, "the list is closed");
  await press(input(), "ArrowDown");
  assert.ok(listbox(), "so does an arrow key");
});

test("an invalid address marks the field", async (t) => {
  const { lastChange } = await mount(t, { inviteRoleChoice: true });
  await focus(input());
  assert.equal(input().getAttribute("aria-invalid"), null);

  await type(input(), "saket@");
  await leaveField(input());
  assert.deepEqual(lastChange(), [
    { kind: "email", email: "saket@", role: "member", valid: false },
  ]);
  assert.equal(input().value, "", "chipped on blur, as the invite dialog does");
  assert.equal(input().getAttribute("aria-invalid"), "true");
  const [chip] = chips();
  assert.equal(text(chip), "saket@ · Member");
  assert.match(chip.className, /destructive/);
  assert.equal(readable(chip.getAttribute("title")), "saket@ isn't a valid email");

  // Taking it out clears the mark.
  await click(chip.querySelector("button"));
  assert.equal(input().getAttribute("aria-invalid"), null);
  assert.equal(chips().length, 0);
});

test("a valid chip leaves the field unmarked, and a name is never chipped on blur", async (t) => {
  const { changes } = await mount(t);
  await focus(input());
  await type(input(), "alex@example.com");
  await leaveField(input());
  assert.equal(changes.at(-1)[0].valid, true);
  assert.equal(input().getAttribute("aria-invalid"), null);

  await type(input(), "Sa");
  await leaveField(input());
  assert.equal(changes.length, 1, "half a name is a search, not an address");
  assert.equal(input().value, "Sa");
});

test("moving into the list or its role menu is not leaving the field", async (t) => {
  const { changes } = await mount(t, { inviteRoleChoice: true });
  await focus(input());
  await type(input(), "alex@example.com");
  const trigger = doc().querySelector('[role="option"] [aria-haspopup="menu"]');
  // Focus moving to the role menu must not chip the address it is choosing a role for.
  await leaveField(input(), trigger);
  assert.equal(changes.length, 0);
  assert.equal(input().value, "alex@example.com");
  assert.ok(listbox(), "the list stays open");
});

test("typing a separator after an address chips it", async (t) => {
  const { lastChange } = await mount(t);
  await focus(input());
  await type(input(), "a@x.io,");
  assert.deepEqual(lastChange(), [{ kind: "email", email: "a@x.io", role: "member", valid: true }]);
  assert.equal(input().value, "");
  // A comma inside a name search is no address list.
  await type(input(), "Smith, ");
  assert.equal(input().value, "Smith, ");
});

test("pasting a list makes one chip each", async (t) => {
  const { lastChange } = await mount(t);
  await focus(input());
  const prevented = await paste(input(), "Name <a@x.io>, ethan@openronnie.com; bad");
  assert.equal(prevented, true);
  assert.deepEqual(lastChange(), [
    { kind: "email", email: "a@x.io", role: "member", valid: true },
    { kind: "member", userId: "ethan", label: "Ethan", email: "ethan@openronnie.com" },
    { kind: "email", email: "bad", role: "member", valid: false },
  ]);
  assert.equal(input().getAttribute("aria-invalid"), "true");

  // One address, or a name, pastes into the field like any text.
  assert.equal(await paste(input(), "kim@example.com"), false);
  assert.equal(await paste(input(), "Kim"), false);
});

test("a disabled field takes no input and no removals", async (t) => {
  await mount(t, {
    disabled: true,
    picked: [{ kind: "group", teamId: "sales", label: "Sales", memberCount: 5 }],
  });
  assert.equal(input().disabled, true);
  assert.equal(chips()[0].querySelector("button").disabled, true);
});

test("the placeholder and id reach the input", async (t) => {
  await mount(t, { id: "create-people", placeholder: "Names, emails, or groups" });
  assert.equal(input().id, "create-people");
  assert.equal(input().getAttribute("placeholder"), "Names, emails, or groups");
});

// Resolves to whether the field kept the key from the browser's own handling of it.
const pressKey = async (element, key) => {
  const event = new happyWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(() => element.dispatchEvent(event));
  return event.defaultPrevented;
};
const roleText = () => doc().querySelector('[role="option"] [aria-live="polite"]')?.textContent;
const roleMenuTrigger = () => doc().querySelector('[role="option"] [aria-haspopup="menu"]');
const chooseRole = async (label) => {
  await press(roleMenuTrigger(), "ArrowDown");
  const item = [...doc().querySelectorAll('[role="menuitemradio"]')].find((entry) =>
    text(entry).startsWith(label)
  );
  await click(item);
  // Radix returns focus from a timer once the menu has unmounted.
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
};

test("the list can be wheel-scrolled inside a modal dialog", async (t) => {
  await mount(t, {}, { dialog: true });
  await focus(input());
  const wheel = async (target) => {
    const event = new happyWindow.WheelEvent("wheel", {
      deltaY: 40,
      bubbles: true,
      cancelable: true,
    });
    await act(() => target.dispatchEvent(event));
    return event.defaultPrevented;
  };
  // The dialog's scroll lock is on: it stops the wheel anywhere outside the dialog itself.
  assert.equal(await wheel(doc().body), true, "the lock is active");
  // The list sits in the body, outside the dialog, and must still scroll.
  assert.equal(await wheel(listbox()), false);
  assert.equal(await wheel(options()[0]), false);
});

test("the highlighted row is scrolled into view", async (t) => {
  const calls = [];
  const proto = happyWindow.Element.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, "scrollIntoView");
  Object.defineProperty(proto, "scrollIntoView", {
    configurable: true,
    writable: true,
    value(argument) {
      calls.push({ id: this.id, argument });
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(proto, "scrollIntoView", original);
    else delete proto.scrollIntoView;
  });

  await mount(t);
  await focus(input());
  assert.deepEqual(calls, [], "nothing is highlighted, so nothing scrolls");
  await press(input(), "ArrowDown");
  assert.deepEqual(calls.at(-1), { id: options()[0].id, argument: { block: "nearest" } });
  await press(input(), "ArrowDown");
  assert.equal(calls.at(-1).id, options()[1].id);
  // Wrapping to the last row, which may be below the fold, scrolls to it too.
  await press(input(), "ArrowUp");
  await press(input(), "ArrowUp");
  assert.equal(calls.at(-1).id, options().at(-1).id);
});

test("the role of an invitation is chosen from the keyboard, and read out", async (t) => {
  const { lastChange } = await mount(t, { inviteRoleChoice: true });
  await focus(input());
  await type(input(), "alex@example.com");
  assert.equal(roleText(), "Member");
  assert.equal(
    doc().querySelector('[role="option"] [aria-live="polite"]').getAttribute("aria-live"),
    "polite"
  );

  // Left and right belong to the field until the invite row is the highlighted one.
  assert.equal(await pressKey(input(), "ArrowRight"), false);
  await press(input(), "ArrowDown");
  assert.equal(highlighted(), 0);
  assert.equal(await pressKey(input(), "ArrowRight"), true);
  assert.equal(roleText(), "Admin");
  assert.equal(await pressKey(input(), "ArrowLeft"), true);
  assert.equal(roleText(), "Member");
  await press(input(), "ArrowRight");
  assert.equal(roleText(), "Admin");
  assert.equal(input().value, "alex@example.com", "nothing is staged by choosing a role");

  await press(input(), "Enter");
  assert.deepEqual(lastChange(), [
    { kind: "email", email: "alex@example.com", role: "admin", valid: true },
  ]);
  assert.deepEqual(chipTexts(), ["alex@example.com · Admin"]);
});

test("left and right leave the field alone on any other row, and without a role choice", async (t) => {
  await mount(t, { inviteRoleChoice: true });
  await focus(input());
  await press(input(), "ArrowDown");
  assert.equal(highlighted(), 0, "Ethan is highlighted");
  assert.equal(await pressKey(input(), "ArrowRight"), false);
  assert.equal(await pressKey(input(), "ArrowLeft"), false);
});

test("without a role choice left and right don't touch the invite row", async (t) => {
  await mount(t, { inviteRoleChoice: false });
  await focus(input());
  await type(input(), "alex@example.com");
  await press(input(), "ArrowDown");
  assert.equal(await pressKey(input(), "ArrowRight"), false);
});

test("the field keeps focus after a role is chosen and after Select", async (t) => {
  await mount(t, { inviteRoleChoice: true });
  await focus(input());
  await type(input(), "alex@example.com");
  await chooseRole("Workspace Admin");
  assert.equal(roleText(), "Admin");
  assertFocused("the menu hands focus back to the field");

  const select = [...doc().querySelectorAll("button")].find((button) => text(button) === "Select");
  // A button takes focus from the field when it is pressed with the keyboard or a touch.
  await act(() => select.focus());
  await click(select);
  assert.deepEqual(chipTexts(), ["alex@example.com · Admin"]);
  assertFocused("the row is gone, and focus did not go with it");
});

test("the role shown is the role Enter, blur and a pasted list stage", async (t) => {
  const { lastChange } = await mount(t, { inviteRoleChoice: true });
  await focus(input());

  // Enter with no highlighted row.
  await type(input(), "alex@example.com");
  await chooseRole("Workspace Admin");
  await press(input(), "Enter");
  assert.deepEqual(chipTexts(), ["alex@example.com · Admin"]);
  // It was for that address: the next one starts as Member.
  await type(input(), "kim@example.com");
  assert.equal(roleText(), "Member");

  // Blur.
  await chooseRole("Workspace Admin");
  await leaveField(input());
  assert.deepEqual(chipTexts(), ["alex@example.com · Admin", "kim@example.com · Admin"]);

  // A typed separator.
  await refocus();
  await type(input(), "lee@example.com");
  await chooseRole("Workspace Admin");
  await type(input(), "lee@example.com,");
  assert.equal(chipTexts().at(-1), "lee@example.com · Admin");

  // A pasted list: everyone in it gets the role shown, and the typed address stays to be staged.
  await type(input(), "max@example.com");
  await chooseRole("Workspace Admin");
  await paste(input(), "p@x.io, q@x.io");
  assert.deepEqual(chipTexts().slice(-2), ["p@x.io · Admin", "q@x.io · Admin"]);
  assert.equal(input().value, "max@example.com");
  assert.equal(roleText(), "Admin", "still the choice for the address that is left");

  // A member's address and the role: members have no workspace role to choose.
  await type(input(), "ethan@openronnie.com");
  await press(input(), "Enter");
  assert.equal(lastChange().at(-1).kind, "member");
});

test("typing an address again never downgrades its role; choosing its row does", async (t) => {
  await mount(t, { inviteRoleChoice: true });
  await focus(input());
  await type(input(), "alex@example.com");
  await chooseRole("Workspace Admin");
  await press(input(), "Enter");
  assert.deepEqual(chipTexts(), ["alex@example.com · Admin"]);

  // Typed again with the role showing Member: the chip is left as it was.
  await type(input(), "alex@example.com");
  await press(input(), "Enter");
  assert.deepEqual(chipTexts(), ["alex@example.com · Admin"]);
  await type(input(), "alex@example.com");
  await leaveField(input());
  assert.deepEqual(chipTexts(), ["alex@example.com · Admin"]);
  assert.equal(input().value, "", "the address is consumed, not left behind");
  await paste(input(), "alex@example.com, kim@example.com");
  assert.deepEqual(chipTexts(), ["alex@example.com · Admin", "kim@example.com · Member"]);

  // Choosing the invite row is a decision about this address's role.
  await refocus();
  await type(input(), "alex@example.com");
  await press(input(), "ArrowDown");
  await press(input(), "Enter");
  assert.deepEqual(chipTexts(), ["alex@example.com · Member", "kim@example.com · Member"]);
});

test("the list says several rows can be selected", async (t) => {
  await mount(t);
  await focus(input());
  assert.equal(listbox().getAttribute("aria-multiselectable"), "true");
});

test("an address with an invitation pending shows as pending and stages nothing", async (t) => {
  const { changes } = await mount(t, {
    inviteRoleChoice: true,
    pendingEmails: new Set(["clark@gmail.com"]),
  });
  await focus(input());
  await type(input(), "Clark@Gmail.com");
  // A disabled row, with no invite and no role to choose.
  assert.deepEqual(optionTexts(), ["Clark@Gmail.com Invitation pending"]);
  assert.equal(options()[0].getAttribute("aria-disabled"), "true");
  assert.ok(roleMenuTrigger() === null, "no role to choose");
  assert.ok(doc().querySelector('[role="status"]') === null, "it is not an empty result");

  await press(input(), "ArrowDown");
  assert.equal(highlighted(), -1, "the arrow keys step over it");
  await click(options()[0]);
  await press(input(), "Enter");
  await leaveField(input());
  assert.equal(changes.length, 0, "typing the address stages nothing");
  // Left in the field, so it is clear it was not taken; addresses are kept in lower case.
  assert.equal(input().value, "clark@gmail.com");

  // A separator after it, and a pasted list that has it in.
  await refocus();
  await type(input(), "clark@gmail.com,");
  assert.equal(changes.length, 0);
  assert.equal(input().value, "clark@gmail.com");
  await paste(input(), "a@x.io, clark@gmail.com");
  assert.deepEqual(chipTexts(), ["a@x.io · Member"]);
  assert.equal(input().value, "clark@gmail.com");

  // An address nobody invited yet is still offered.
  await type(input(), "alex@example.com");
  assert.deepEqual(optionTexts(), [
    "alex@example.com New to workspace Workspace role Member Select",
  ]);
});

test("a pending address reads as pending to someone who can't invite too", async (t) => {
  await mount(t, { canInvite: false, pendingEmails: new Set(["clark@gmail.com"]) });
  await focus(input());
  await type(input(), "clark@gmail.com");
  assert.deepEqual(optionTexts(), ["clark@gmail.com Invitation pending"]);
});
