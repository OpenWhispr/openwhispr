const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");

const { findElement } = require("../lib/interactiveDom");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");
const {
  ariaLabel,
  click,
  dispatch,
  label,
  mountSkillsComponent,
  pressEscape,
  settle,
  skill,
} = require("../lib/skillsHarness");

const MARKDOWN = "---\r\nname: meeting-prep\r\ndescription: Briefs me.\r\n---\r\n\r\n## Steps\r\n";
const FILES = [
  { path: "assets/logo.png", size: 3, text: false, script: false },
  { path: "references/notes.md", size: 5, text: true, script: false },
  { path: "scripts/export.sh", size: 11, text: true, script: true },
];

async function openDetail(t, { summary = skill("meeting-prep"), confirm = false, api = {} } = {}) {
  const calls = { openChange: [], uninstalled: 0, read: [], clipboard: [], switched: [] };
  const mounted = await mountSkillsComponent(t, {
    modulePath: "/components/skills/SkillDetailDialog.tsx",
    exportName: "SkillDetailDialog",
    skills: [summary],
    api: {
      skillsGet: async (name) => ({ ...summary, name, markdown: MARKDOWN, files: FILES }),
      skillsSetEnabled: async (name, enabled) => {
        calls.switched.push([name, enabled]);
        return summary.valid ? { ok: true } : { ok: false, error: "invalid" };
      },
      skillsUninstall: async () => ({ ok: true }),
      skillsReadFile: async (name, path) => {
        calls.read.push([name, path]);
        return { text: `text of ${path}` };
      },
      writeClipboard: async (text) => {
        calls.clipboard.push(text);
        return { success: true };
      },
      ...api,
    },
    wrap: (SkillDetailDialog) => {
      function Harness() {
        const [open, setOpen] = React.useState(true);
        return React.createElement(SkillDetailDialog, {
          name: summary.name,
          open,
          initialConfirmUninstall: confirm,
          onOpenChange: (next) => {
            calls.openChange.push(next);
            setOpen(next);
          },
          focusFallback: () => calls.uninstalled++,
        });
      }
      return React.createElement(Harness);
    },
  });
  return { ...mounted, calls };
}

const byRole = (role) => (root) => findElement(root, (node) => node.getAttribute("role") === role);
const dialog = byRole("dialog");
const alert = byRole("alert");
const toggle = byRole("switch");
const button = (root, text) =>
  findElement(root, (node) => node.tagName === "BUTTON" && label(node) === text);

test("the pop-up renders the instructions without the header block", async (t) => {
  const { container } = await openDetail(t, {
    summary: skill("meeting-prep", { displayName: "Meeting prep", description: "Briefs me." }),
  });

  const markdown = findElement(container, (node) => node.getAttribute("data-markdown") !== null);
  assert.deepEqual(
    [markdown.getAttribute("data-markdown"), markdown.textContent],
    ["hide-frontmatter", MARKDOWN]
  );
  assert.match(label(dialog(container)), /Meeting prep\s*skills\.detail\.skillLabel/);
  const withText = (text) => findElement(container, (node) => label(node) === text);
  assert.equal(withText("Meeting prep").getAttribute("dir"), "auto");
  assert.equal(withText("Briefs me.").getAttribute("dir"), "auto");
});

test("Uninstall asks in the footer first and then removes the skill", async (t) => {
  const uninstalled = [];
  const { container, toasts, calls } = await openDetail(t, {
    summary: skill("meeting-prep", { displayName: "Meeting prep" }),
    api: {
      skillsUninstall: async (name) => {
        uninstalled.push(name);
        return { ok: true };
      },
    },
  });

  await click(button(container, "skills.detail.uninstall"));
  assert.equal(
    label(alert(container)),
    'skills.detail.uninstallConfirm{"name":"Meeting prep"}common.cancelskills.detail.uninstall'
  );
  const focused = () => container.ownerDocument.activeElement;
  assert.equal(focused() === button(alert(container), "common.cancel"), true);
  assert.deepEqual(uninstalled, []);

  await click(button(alert(container), "skills.detail.uninstall"));
  await settle();

  assert.deepEqual(uninstalled, ["meeting-prep"]);
  assert.deepEqual(calls.openChange, [false]);
  assert.equal(calls.uninstalled, 1);
  assert.deepEqual(toasts, [
    {
      title: 'skills.toasts.uninstalled{"name":"Meeting prep"}',
      description: "skills.toasts.removedFromComputer",
      variant: "success",
    },
  ]);
});

test("pressing Uninstall again while it runs uninstalls once", async (t) => {
  const uninstalled = [];
  const { container, toasts } = await openDetail(t, {
    api: {
      skillsUninstall: async (name) => {
        uninstalled.push(name);
        return { ok: true };
      },
    },
  });
  await click(button(container, "skills.detail.uninstall"));
  const confirm = button(alert(container), "skills.detail.uninstall");

  await React.act(async () => {
    dispatch(confirm, "click");
    dispatch(confirm, "click");
  });
  await settle();

  assert.deepEqual(uninstalled, ["meeting-prep"]);
  assert.equal(toasts.length, 1);
});

test("Copy markdown copies what the pop-up shows, without reading the skill again", async (t) => {
  const reads = [];
  const { container, calls, toasts } = await openDetail(t, {
    api: {
      skillsGet: async (name) => {
        reads.push(name);
        return { ...skill(name), markdown: MARKDOWN, files: FILES };
      },
    },
  });

  await click(button(container, "skills.menu.copyMarkdown"));
  await settle();

  assert.deepEqual(reads, ["meeting-prep"]);
  assert.deepEqual(calls.clipboard, [MARKDOWN]);
  assert.deepEqual(toasts, [{ title: "skills.toasts.copiedMarkdown", variant: "success" }]);
});

test("a file that can't be copied says so", async (t) => {
  const { container, toasts } = await openDetail(t, { api: { skillsReadFile: async () => null } });
  const copy = findElement(container, (node) =>
    ariaLabel(node).startsWith("skills.detail.copyFile")
  );

  await click(copy);
  await settle();

  assert.deepEqual(toasts, [{ title: "skills.toasts.copyFailed", variant: "destructive" }]);
});

test("a failed uninstall keeps the pop-up open and says why", async (t) => {
  const { container, toasts, calls } = await openDetail(t, {
    api: { skillsUninstall: async () => ({ ok: false, error: "permission" }) },
  });

  await click(button(container, "skills.detail.uninstall"));
  await click(button(alert(container), "skills.detail.uninstall"));
  await settle();

  assert.deepEqual(calls.openChange, []);
  assert.deepEqual(toasts, [
    {
      title: "skills.toasts.writeFailed",
      description: "skills.toasts.writeFailedPermission",
      variant: "destructive",
    },
  ]);
});

test("Esc in the confirm cancels it, and Esc again closes the pop-up", async (t) => {
  const { container, calls } = await openDetail(t);

  await click(button(container, "skills.detail.uninstall"));
  await pressEscape(button(alert(container), "common.cancel"));
  assert.equal(alert(container), null);
  assert.deepEqual(calls.openChange, []);
  const uninstall = button(container, "skills.detail.uninstall");
  assert.equal(container.ownerDocument.activeElement === uninstall, true);

  await pressEscape(uninstall);
  assert.deepEqual(calls.openChange, [false]);
  assert.equal(dialog(container), null);
});

// Manage's ⋯ Uninstall opens the pop-up on its confirm: backing out returns to Manage.
test("Cancel on a confirm opened from Manage's menu closes the pop-up", async (t) => {
  const { container, calls } = await openDetail(t, { confirm: true });

  await click(button(alert(container), "common.cancel"));

  assert.deepEqual(calls.openChange, [false]);
  assert.equal(dialog(container), null);
});

test("Esc on a confirm opened from Manage's menu closes the pop-up", async (t) => {
  const { container, calls } = await openDetail(t, { confirm: true });

  await pressEscape(button(alert(container), "common.cancel"));

  assert.deepEqual(calls.openChange, [false]);
  assert.equal(dialog(container), null);
});

test("opening on its confirm focuses Cancel", async (t) => {
  const { container } = await openDetail(t, { confirm: true });

  const cancel = button(alert(container), "common.cancel");
  assert.equal(container.ownerDocument.activeElement === cancel, true);
});

test("scripts say OpenWhispr never runs them and binary files have no Copy button", async (t) => {
  const { container, calls } = await openDetail(t);
  const row = (path) =>
    findElement(
      container,
      (node) =>
        node.tagName === "DIV" &&
        node.childNodes.some((child) => child.tagName === "SPAN" && label(child) === path)
    );
  const copyButton = (path) =>
    findElement(row(path), (node) => node.tagName === "BUTTON" && ariaLabel(node).includes(path));

  assert.match(label(row("scripts/export.sh")), /skills\.detail\.neverRun/);
  assert.doesNotMatch(label(row("references/notes.md")), /skills\.detail\.neverRun/);
  assert.equal(copyButton("assets/logo.png"), null);
  for (const path of FILES.map((file) => file.path)) {
    const pathText = findElement(
      row(path),
      (node) => node.tagName === "SPAN" && label(node) === path
    );
    assert.equal(pathText.getAttribute("dir"), "ltr", path);
  }

  const copy = copyButton("references/notes.md");
  assert.equal(ariaLabel(copy), 'skills.detail.copyFile{"path":"references/notes.md"}');
  await click(copy);
  await settle();
  assert.deepEqual(calls.read, [["meeting-prep", "references/notes.md"]]);
  assert.deepEqual(calls.clipboard, ["text of references/notes.md"]);
  const copied = findElement(row("references/notes.md"), (node) => node.tagName === "BUTTON");
  assert.equal(ariaLabel(copied), "common.copied");
});

test("switching a skill on plays its icon once; switching it off doesn't", async (t) => {
  const { container, store, calls } = await openDetail(t, {
    summary: skill("meeting-prep", { enabled: false }),
  });
  const icon = () =>
    findElement(dialog(container), (node) => node.getAttribute("data-icon") === "skill-stack");
  const playing = () => /skill-icon-play/.test(icon().getAttribute("class") ?? "");
  assert.equal(playing(), false);
  assert.equal(ariaLabel(toggle(container)), 'skills.detail.toggle{"name":"meeting prep"}');

  await click(toggle(container));
  await settle();
  assert.equal(playing(), true);
  const played = icon();

  await click(toggle(container));
  await settle();
  assert.deepEqual(calls.switched, [
    ["meeting-prep", true],
    ["meeting-prep", false],
  ]);
  assert.equal(icon() === played, true);
  assert.equal(store.useSkillsStore.getState().iconPlays["meeting-prep"], 1);
});

test("a switch that can't be saved says so", async (t) => {
  const { container, toasts } = await openDetail(t, {
    api: { skillsSetEnabled: async () => ({ ok: false, error: "unknown" }) },
  });

  await click(toggle(container));
  await settle();

  assert.deepEqual(toasts, [{ title: "skills.toasts.writeFailed", variant: "destructive" }]);
});

test("an invalid skill's switch is off and disabled, and its problem is shown", async (t) => {
  const { container } = await openDetail(t, {
    summary: skill("broken", { valid: false, problem: { code: "missingDescription" } }),
  });

  assert.equal(toggle(container).getAttribute("aria-checked"), "false");
  assert.equal(toggle(container).getAttribute("disabled"), "");
  assert.match(
    label(dialog(container)),
    /skills\.detail\.problem\{"reason":"skills\.problems\.missingDescription"\}/
  );
});

// The list still shows it as fine: its files were readable when the folder was last listed.
test("a skill whose files can't be read says so, and its switch is off and disabled", async (t) => {
  const summary = skill("meeting-prep");
  const unreadable = { valid: false, problem: { code: "unreadable" }, markdown: "", files: [] };
  const { container } = await openDetail(t, {
    summary,
    api: { skillsGet: async () => ({ ...summary, ...unreadable }) },
  });

  assert.equal(toggle(container).getAttribute("aria-checked"), "false");
  assert.equal(toggle(container).getAttribute("disabled"), "");
  assert.match(
    label(dialog(container)),
    /skills\.detail\.problem\{"reason":"skills\.problems\.unreadable"\}/
  );
  // No empty box where the instructions would be.
  const markdown = findElement(container, (node) => node.getAttribute("data-markdown") !== null);
  assert.equal(markdown, null);
});

// As when the chat's Open skill opens it: the button pressed is gone, so the page had focus.
test("a pop-up opened while the page had focus hands focus to the fallback when it closes", async (t) => {
  let fallbacks = 0;
  const { container } = await mountSkillsComponent(t, {
    modulePath: "/components/skills/SkillDetailDialog.tsx",
    exportName: "SkillDetailDialog",
    skills: [skill("meeting-prep")],
    api: { skillsGet: async (name) => ({ ...skill(name), markdown: MARKDOWN, files: [] }) },
    wrap: (SkillDetailDialog) => {
      const { body } = globalThis.document;
      body.isConnected = true;
      globalThis.document.activeElement = body;
      function Harness() {
        const [open, setOpen] = React.useState(true);
        return React.createElement(SkillDetailDialog, {
          name: "meeting-prep",
          open,
          onOpenChange: setOpen,
          focusFallback: () => fallbacks++,
        });
      }
      return React.createElement(Harness);
    },
  });

  await pressEscape(dialog(container));

  assert.equal(fallbacks, 1);
});

test("a reread that fails stops showing the earlier read", async (t) => {
  let fails = false;
  const summary = skill("meeting-prep");
  const { container, store } = await openDetail(t, {
    summary,
    api: {
      skillsGet: async (name) => {
        if (fails) throw new Error("Error invoking remote method 'skills-get'");
        return { ...summary, name, markdown: MARKDOWN, files: FILES };
      },
    },
  });
  const markdown = () =>
    findElement(container, (node) => node.getAttribute("data-markdown") !== null);
  assert.ok(markdown());

  fails = true;
  await React.act(async () =>
    store.useSkillsStore.setState({ skills: [{ ...summary, updatedAt: "2026-10-22T10:00:00Z" }] })
  );
  await settle();

  assert.equal(markdown(), null);
});

test("the reveal label follows the platform", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-platform-label-test-" });
  const { showInFolderLabelKey } = await vite.ssrLoadModule("/utils/platform.ts");

  assert.deepEqual(
    ["darwin", "win32", "linux"].map((platform) => showInFolderLabelKey(platform)),
    [
      "controlPanel.history.showInFolder",
      "controlPanel.history.showInFolderWindows",
      "controlPanel.history.showInFolderLinux",
    ]
  );
});
