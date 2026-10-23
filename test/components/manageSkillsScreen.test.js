const test = require("node:test");
const assert = require("node:assert/strict");

const { findElement } = require("../lib/interactiveDom");
const {
  ariaLabel,
  click,
  cloudBackup,
  findAll,
  label,
  mountSkillsComponent,
  settle,
  skill,
  typeInto,
} = require("../lib/skillsHarness");

const COPIED = "\uFEFF---\r\nname: x\r\n---\r\n";

async function renderManage(t, { skills, api = {}, backup = false }) {
  const calls = { opened: [], focusedAtOpen: [], back: 0, revealed: [], clipboard: [], switched: [] };
  const mounted = await mountSkillsComponent(t, {
    modulePath: "/components/skills/ManageSkillsScreen.tsx",
    exportName: "ManageSkillsScreen",
    skills,
    mocks: cloudBackup(backup),
    props: {
      onOpenSkill: (name, confirmUninstall) => {
        calls.opened.push([name, confirmUninstall]);
        calls.focusedAtOpen.push(globalThis.document.activeElement);
      },
      onBack: () => calls.back++,
    },
    api: {
      skillsReveal: async (name) => {
        calls.revealed.push(name);
        return { ok: true };
      },
      skillsGet: async (name) => ({ ...skill(name), markdown: COPIED, files: [] }),
      writeClipboard: async (text) => {
        calls.clipboard.push(text);
        return { success: true };
      },
      skillsSetEnabled: async (name, enabled) => {
        calls.switched.push([name, enabled]);
        return { ok: true };
      },
      ...api,
    },
  });
  return { ...mounted, calls };
}

// A row is the element holding the skill's open button, badge, menu and switch.
const rows = (container) =>
  findAll(
    container,
    (node) =>
      node.tagName === "DIV" &&
      node.childNodes.some((child) => child.getAttribute?.("role") === "switch")
  );
const rowFor = (container, name) => rows(container).find((row) => label(row).startsWith(name));
const button = (root, text) =>
  findElement(root, (node) => node.tagName === "BUTTON" && label(node) === text);

test(
  "Manage lists every skill with its menu and switch, and a row opens the detail",
  async (t) => {
    const skills = [
      ...Array.from({ length: 7 }, (_, index) => skill(`skill-${index + 1}`)),
      skill("paused", { enabled: false }),
      skill("broken", { valid: false, problem: { code: "nameMismatch" } }),
    ];
    const { container, calls } = await renderManage(t, { skills });

    const crumbs = findElement(container, (node) => node.tagName === "NAV");
    assert.equal(ariaLabel(crumbs), "skills.breadcrumb.label");
    assert.match(label(crumbs), /^skills\.breadcrumb\.root\s*skills\.manage\.title$/);
    await click(button(crumbs, "skills.breadcrumb.root"));
    assert.equal(calls.back, 1);

    assert.equal(rows(container).length, 9);
    for (const row of rows(container)) {
      // Every skill here is the user's own, so no row carries a badge saying so.
      assert.doesNotMatch(label(row), /skills\.manage\.personal/);
      assert.ok(findElement(row, (node) => ariaLabel(node).startsWith("skills.detail.more")));
    }
    const switchOf = (name) =>
      findElement(rowFor(container, name), (node) => node.getAttribute("role") === "switch");
    assert.equal(switchOf("paused").getAttribute("aria-checked"), "false");
    assert.equal(switchOf("skill 1").getAttribute("aria-checked"), "true");
    assert.equal(switchOf("broken").getAttribute("disabled"), "");
    assert.equal(
      ariaLabel(switchOf("broken")),
      'skills.detail.problem{"reason":"skills.problems.nameMismatch"}'
    );

    const open = findElement(rowFor(container, "skill 3"), (node) => node.tagName === "BUTTON");
    await click(open);
    await click(button(rowFor(container, "skill 4"), "skills.menu.uninstall"));
    assert.deepEqual(calls.opened, [
      ["skill-3", false],
      ["skill-4", true],
    ]);

    await click(switchOf("paused"));
    await settle();
    assert.deepEqual(calls.switched, [["paused", true]]);
  }
);

test("a row's switch that can't be saved says so", async (t) => {
  const { container, toasts } = await renderManage(t, {
    skills: [skill("paused", { enabled: false })],
    api: { skillsSetEnabled: async () => ({ ok: false, error: "unknown" }) },
  });
  const toggle = findElement(rowFor(container, "paused"), (node) => {
    return node.getAttribute("role") === "switch";
  });

  await click(toggle);
  await settle();

  assert.deepEqual(toasts, [{ title: "skills.toasts.writeFailed", variant: "destructive" }]);
});

test("a skill that needs fixing says so on its row, and its switch shows off", async (t) => {
  const skills = [skill("broken", { valid: false, problem: { code: "nameMismatch" } })];
  const { container } = await renderManage(t, { skills });

  const row = rowFor(container, "broken");
  assert.match(label(row), /skills\.pane\.needsFix/);
  const toggle = findElement(row, (node) => node.getAttribute("role") === "switch");
  assert.equal(toggle.getAttribute("aria-checked"), "false");
});

test("the menu reveals the folder and copies the markdown exactly", async (t) => {
  const { container, toasts, calls } = await renderManage(t, { skills: [skill("recap")] });

  await click(button(container, "controlPanel.history.showInFolder"));
  await click(button(container, "skills.menu.copyMarkdown"));
  await settle();

  assert.deepEqual(calls.revealed, ["recap"]);
  assert.deepEqual(calls.clipboard, [COPIED]);
  assert.deepEqual(toasts, [{ title: "skills.toasts.copiedMarkdown", variant: "success" }]);
});

test("a folder that can't be shown says so", async (t) => {
  const { container, toasts } = await renderManage(t, {
    skills: [skill("recap")],
    api: { skillsReveal: async () => ({ ok: false }) },
  });

  await click(button(container, "controlPanel.history.showInFolder"));
  await settle();

  assert.deepEqual(toasts, [{ title: "skills.toasts.revealFailed", variant: "destructive" }]);
});

test("a copy that fails says so", async (t) => {
  const { container, toasts } = await renderManage(t, {
    skills: [skill("recap")],
    api: {
      writeClipboard: async () => ({ success: false }),
    },
  });

  await click(button(container, "skills.menu.copyMarkdown"));
  await settle();

  assert.deepEqual(toasts, [{ title: "skills.toasts.copyFailed", variant: "destructive" }]);
});

// The pop-up returns focus to what had it when it opened, and a menu item goes away with its
// menu, so the row's ⋯ button takes focus first.
test("Uninstall from a row's menu leaves focus on that row's ⋯ button", async (t) => {
  const { container, calls } = await renderManage(t, { skills: [skill("recap"), skill("notes")] });

  await click(button(rowFor(container, "notes"), "skills.menu.uninstall"));

  const more = findElement(rowFor(container, "notes"), (node) => {
    return ariaLabel(node).startsWith("skills.detail.more");
  });
  assert.deepEqual(calls.opened, [["notes", true]]);
  assert.equal(calls.focusedAtOpen[0] === more, true);
});

test("a copy whose skill can't be read says so", async (t) => {
  const { container, toasts } = await renderManage(t, {
    skills: [skill("recap")],
    api: {
      skillsGet: async () => {
        throw new Error("Error invoking remote method 'skills-get'");
      },
    },
  });

  await click(button(container, "skills.menu.copyMarkdown"));
  await settle();

  assert.deepEqual(toasts, [{ title: "skills.toasts.copyFailed", variant: "destructive" }]);
});

test("search narrows the list and says when nothing matches", async (t) => {
  const { container } = await renderManage(t, {
    skills: [
      skill("meeting-prep", { description: "Briefs me before calls" }),
      skill("weekly-recap", { description: "Friday note" }),
    ],
  });
  const search = findElement(container, (node) => node.tagName === "INPUT");
  assert.deepEqual(
    [ariaLabel(search), search.getAttribute("dir")],
    ["skills.pane.search", "auto"]
  );

  await typeInto(search, "calls");
  assert.equal(rows(container).length, 1);
  assert.ok(rowFor(container, "meeting prep"));

  await typeInto(search, "zzz");
  assert.equal(rows(container).length, 0);
  assert.match(label(container), /skills\.manage\.noMatches\{"query":"zzz"\}/);
});

test("an empty library says so", async (t) => {
  const { container } = await renderManage(t, { skills: [] });
  assert.match(label(container), /skills\.manage\.none/);
});

test("Manage marks a skill too large to back up", async (t) => {
  const { container } = await renderManage(t, {
    backup: true,
    skills: [skill("big-one", { tooLargeToSync: true }), skill("small-one")],
  });

  assert.match(label(rowFor(container, "big one")), /skills\.sync\.tooLarge/);
  assert.doesNotMatch(label(rowFor(container, "small one")), /skills\.sync\.tooLarge/);
  assert.match(label(container), /skills\.manage\.descriptionBackedUp/);
});

test("free plans see no sync copy", async (t) => {
  const { container } = await renderManage(t, {
    backup: false,
    skills: [skill("big-one", { tooLargeToSync: true })],
  });

  assert.doesNotMatch(label(container), /skills\.sync\.|descriptionBackedUp/);
  assert.match(label(container), /skills\.manage\.description/);
});
