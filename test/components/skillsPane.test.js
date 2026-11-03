const test = require("node:test");
const assert = require("node:assert/strict");

const React = require("react");

const { findElement } = require("../lib/interactiveDom");
const {
  ariaLabel,
  click,
  dispatch,
  label,
  mountSkillsComponent,
  pressEscape,
  settle,
  skill,
  typeInto,
} = require("../lib/skillsHarness");

async function renderPane(t, skills) {
  return mountSkillsComponent(t, {
    modulePath: "/components/integrations/SkillsPane.tsx",
    exportName: "SkillsPane",
    skills,
    props: { title: "Skills", active: true },
    api: {
      skillsGet: async (name) => ({
        ...skills.find((entry) => entry.name === name),
        markdown: "---\nname: x\n---\n",
        files: [],
      }),
      skillsUninstall: async () => ({ ok: true }),
    },
  });
}

const find = (root, predicate) => findElement(root, predicate);
const heading = (container) => find(container, (node) => node.tagName === "H2");
const gear = (container) => find(container, (node) => ariaLabel(node) === "skills.pane.manage");
const buttonStarting = (root, text) =>
  find(root, (node) => node.tagName === "BUTTON" && label(node).startsWith(text));
const dialog = (container) => find(container, (node) => node.getAttribute("role") === "dialog");
const focused = (container) => container.ownerDocument.activeElement;

test("the gear opens Manage and the breadcrumb comes back to it", async (t) => {
  const { container } = await renderPane(t, [skill("meeting-prep")]);
  assert.equal(label(heading(container)), "Skills");

  await click(gear(container));
  assert.equal(label(heading(container)), "skills.manage.title");

  await click(buttonStarting(container, "skills.breadcrumb.root"));
  assert.equal(label(heading(container)), "Skills");
  assert.equal(focused(container) === gear(container), true);
});

test("Esc on a screen goes back, and focus returns to the See link that opened it", async (t) => {
  const seven = Array.from({ length: 7 }, (_, index) => skill(`skill-${index + 1}`));
  const { container } = await renderPane(t, seven);

  await click(buttonStarting(container, "skills.pane.seeOne"));
  assert.equal(label(heading(container)), "skills.manage.title");

  await pressEscape(find(container, (node) => node.tagName === "INPUT"));
  assert.equal(label(heading(container)), "Skills");
  assert.equal(focused(container) === buttonStarting(container, "skills.pane.seeOne"), true);
});

const searchBox = (container) =>
  find(container, (node) => node.tagName === "INPUT" && ariaLabel(node) === "skills.pane.search");

test("Esc in Manage's search clears it first, then goes back", async (t) => {
  const { container } = await renderPane(t, [skill("meeting-prep"), skill("meeting-decisions")]);
  await click(gear(container));
  await typeInto(searchBox(container), "decision");

  await pressEscape(searchBox(container));
  assert.equal(label(heading(container)), "skills.manage.title");
  assert.equal(searchBox(container).value, "");

  await pressEscape(searchBox(container));
  assert.equal(label(heading(container)), "Skills");
});

test("an Esc that ends text composition neither clears the search nor leaves", async (t) => {
  const { container } = await renderPane(t, [skill("meeting-prep")]);
  await click(gear(container));
  await typeInto(searchBox(container), "会議");

  await React.act(async () =>
    dispatch(searchBox(container), "keydown", { key: "Escape", isComposing: true })
  );

  assert.equal(searchBox(container).value, "会議");
  assert.equal(label(heading(container)), "skills.manage.title");
});

// The control that opened a screen is gone once it opens, so without this the keyboard
// would be left on the page body, where Esc can't reach the pane.
test("a screen opens with focus on its heading, so Esc goes back from there", async (t) => {
  const { container } = await renderPane(t, [skill("meeting-prep")]);
  for (const [open, title] of [
    [() => gear(container), "skills.manage.title"],
    [() => buttonStarting(container, "skills.pane.addMenu.upload"), "skills.upload.title"],
    [() => buttonStarting(container, "skills.pane.addMenu.create"), "skills.create.title"],
  ]) {
    await click(open());
    assert.equal(label(heading(container)), title);
    assert.equal(focused(container) === heading(container), true, title);

    await pressEscape(heading(container));
    assert.equal(label(heading(container)), "Skills", title);
  }
});

test("a card on home opens its detail pop-up", async (t) => {
  const { container } = await renderPane(t, [skill("meeting-prep")]);

  await click(find(container, (node) => ariaLabel(node).startsWith("skills.pane.cardLabel")));
  await settle();

  assert.match(label(dialog(container)), /meeting prep/);
});

// Reads that answer late, fail, or find the skill gone: each pop-up shows only its own skill.
async function renderPaneWithReads(t, skills, reads) {
  return mountSkillsComponent(t, {
    modulePath: "/components/integrations/SkillsPane.tsx",
    exportName: "SkillsPane",
    skills,
    props: { title: "Skills", active: true },
    api: { skillsGet: async (name) => reads[name]() },
  });
}

const detailOf = (name) => ({
  ...skill(name),
  markdown: `${name.toUpperCase()} INSTRUCTIONS`,
  files: [{ path: `references/${name}.md`, size: 3, text: true, script: false }],
});
const card = (container, name) =>
  find(container, (node) => node.tagName === "BUTTON" && ariaLabel(node).includes(`"${name}"`));

test("a pop-up never shows another skill's instructions or files", async (t) => {
  const skills = [skill("alpha"), skill("beta"), skill("gamma")];
  const { container } = await renderPaneWithReads(t, skills, {
    alpha: async () => detailOf("alpha"),
    beta: () => new Promise(() => {}),
    gamma: async () => {
      throw new Error("Error invoking remote method 'skills-get'");
    },
  });
  await click(card(container, "alpha"));
  await settle();
  assert.match(label(dialog(container)), /ALPHA INSTRUCTIONS/);
  await pressEscape(dialog(container));

  for (const name of ["beta", "gamma"]) {
    await click(card(container, name));
    await settle();
    assert.doesNotMatch(label(dialog(container)), /ALPHA|alpha\.md/, name);
    await pressEscape(dialog(container));
  }
});

test("a skill removed outside the app closes its pop-up", async (t) => {
  let alpha = detailOf("alpha");
  const { container, store } = await renderPaneWithReads(t, [skill("alpha"), skill("beta")], {
    alpha: async () => alpha,
  });
  await click(card(container, "alpha"));
  await settle();
  assert.ok(dialog(container));

  alpha = null;
  await React.act(async () => store.useSkillsStore.setState({ skills: [skill("beta")] }));
  await settle();

  assert.equal(dialog(container), null);
});

test("Esc in the detail pop-up closes it without leaving Manage", async (t) => {
  const { container } = await renderPane(t, [skill("meeting-prep")]);
  await click(gear(container));
  await click(buttonStarting(container, "meeting prep"));
  await settle();
  assert.ok(dialog(container));

  await pressEscape(find(dialog(container), (node) => node.getAttribute("role") === "switch"));

  assert.equal(dialog(container), null);
  assert.equal(label(heading(container)), "skills.manage.title");
});

test("after an uninstall from the pop-up, focus moves to the screen's heading", async (t) => {
  const { container } = await renderPane(t, [skill("meeting-prep")]);
  await click(gear(container));
  await click(find(container, (node) => label(node) === "skills.menu.uninstall"));
  await settle();
  const confirm = find(container, (node) => node.getAttribute("role") === "alert");

  await click(buttonStarting(confirm, "skills.detail.uninstall"));
  await settle();

  assert.equal(dialog(container), null);
  assert.equal(focused(container) === heading(container), true);
});

test("an upload goes home, plays each new icon and focuses the first new card", async (t) => {
  let listed = [];
  const file = { name: "a.md", size: 3, arrayBuffer: async () => new ArrayBuffer(3) };
  const { container, store } = await mountSkillsComponent(t, {
    modulePath: "/components/integrations/SkillsPane.tsx",
    exportName: "SkillsPane",
    props: { title: "Skills", active: true },
    api: {
      skillsList: async () => ({ skills: listed }),
      skillsPreviewUpload: async () => ({
        items: [
          {
            fileName: "a.md",
            status: "ready",
            token: "token-a",
            name: "weekly-recap",
            displayName: "Weekly recap",
            problems: [],
            warnings: [],
          },
        ],
      }),
      skillsCommitUpload: async () => {
        listed = [skill("weekly-recap"), skill("older-skill")];
        return { installed: ["weekly-recap"], failed: [] };
      },
    },
  });

  await click(buttonStarting(container, "skills.pane.addMenu.upload"));
  assert.equal(label(heading(container)), "skills.upload.title");
  const zone = find(container, (node) => node.getAttribute("role") === "button");
  await React.act(async () => dispatch(zone, "drop", { dataTransfer: { files: [file] } }));
  await settle();
  await click(buttonStarting(container, "skills.upload.submitCount"));
  await settle();

  assert.equal(label(heading(container)), "Skills");
  const first = find(container, (node) => ariaLabel(node).startsWith("skills.pane.cardLabel"));
  assert.match(ariaLabel(first), /weekly recap/);
  assert.equal(focused(container) === first, true);
  assert.deepEqual(store.useSkillsStore.getState().iconPlays, { "weekly-recap": 1 });
});

test("Create keeps a half-written skill on Esc, and a saved one lands on home", async (t) => {
  let listed = [];
  const { container, store } = await mountSkillsComponent(t, {
    modulePath: "/components/integrations/SkillsPane.tsx",
    exportName: "SkillsPane",
    props: { title: "Skills", active: true },
    api: {
      skillsList: async () => ({ skills: listed }),
      skillsCreate: async () => {
        listed = [skill("weekly-recap")];
        return { ok: true, name: "weekly-recap" };
      },
    },
  });
  await click(buttonStarting(container, "skills.pane.addMenu.create"));
  assert.equal(label(heading(container)), "skills.create.title");
  const control = (labelKey) => {
    const fieldLabel = find(
      container,
      (node) => node.tagName === "LABEL" && label(node) === labelKey
    );
    return find(container, (node) => node.getAttribute("id") === fieldLabel.getAttribute("for"));
  };

  await typeInto(control("skills.create.name"), "Weekly recap");
  await pressEscape(control("skills.create.name"));
  assert.equal(label(heading(container)), "skills.create.title");
  assert.ok(find(container, (node) => node.getAttribute("role") === "alert"));

  await typeInto(control("skills.create.descriptionLabel"), "Writes my recap.");
  await typeInto(control("skills.create.instructions"), "Go");
  await click(buttonStarting(container, "skills.create.submit"));
  await settle();

  assert.equal(label(heading(container)), "Skills");
  const card = find(container, (node) => ariaLabel(node).startsWith("skills.pane.cardLabel"));
  assert.equal(focused(container) === card, true);
  assert.deepEqual(store.useSkillsStore.getState().iconPlays, { "weekly-recap": 1 });
});

async function renderPaneWith(t, { skillsList, active = true }) {
  let setActive;
  const listeners = new Set();
  const mounted = await mountSkillsComponent(t, {
    modulePath: "/components/integrations/SkillsPane.tsx",
    exportName: "SkillsPane",
    skills: [],
    api: { skillsList },
    wrap: (SkillsPane) => {
      // The window's focus listeners are kept here, so a test can focus the window.
      const target = globalThis.window;
      const { addEventListener, removeEventListener } = target;
      target.addEventListener = (type, listener, options) =>
        type === "focus"
          ? listeners.add(listener)
          : addEventListener?.call(target, type, listener, options);
      target.removeEventListener = (type, listener, options) =>
        type === "focus"
          ? listeners.delete(listener)
          : removeEventListener?.call(target, type, listener, options);
      function Harness() {
        const [shown, setShown] = React.useState(active);
        setActive = setShown;
        return React.createElement(SkillsPane, { title: "Skills", active: shown });
      }
      return React.createElement(Harness);
    },
  });
  const focusWindow = async () => {
    for (const listener of [...listeners]) listener();
    await settle();
  };
  const show = (next) => React.act(async () => setActive(next));
  return { ...mounted, focusWindow, show, listeners };
}

// Opening the pane reloads the list; a later failure keeps the last list, so a toast says so.
test("a first load that fails shows its card alone, and a later one says so in a toast", async (t) => {
  let fails = true;
  const { container, toasts, show, store } = await renderPaneWith(t, {
    active: false,
    skillsList: async () => {
      if (fails) throw new Error("Error invoking remote method 'skills-list'");
      return { skills: [skill("recap")] };
    },
  });
  await React.act(async () => store.useSkillsStore.setState({ skills: [], loaded: false }));
  const reopen = async () => {
    await show(false);
    await show(true);
    await settle();
  };
  await show(true);
  await settle();
  assert.match(label(container), /common\.retry/);
  assert.deepEqual(toasts, []);

  fails = false;
  await reopen();
  fails = true;
  await reopen();

  assert.deepEqual(toasts, [{ title: "skills.toasts.loadFailed", variant: "destructive" }]);
  assert.match(label(container), /recap/);
});

test("a window focus rereads the skills only while the pane shows", async (t) => {
  let lists = 0;
  const { focusWindow, show, listeners } = await renderPaneWith(t, {
    active: false,
    skillsList: async () => {
      lists += 1;
      return { skills: [] };
    },
  });
  await focusWindow();
  assert.equal(lists, 0);

  await show(true);
  await settle();
  const opened = lists;
  await focusWindow();
  assert.equal(lists, opened + 1);

  await show(false);
  await focusWindow();
  assert.equal(lists, opened + 1);
  assert.equal(listeners.size, 0);
});
