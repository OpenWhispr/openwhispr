const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { findElement } = require("../lib/interactiveDom");
const {
  ariaLabel,
  click,
  findAll,
  label,
  mountSkillsComponent,
  settle,
  skill,
  typeInto,
} = require("../lib/skillsHarness");

const CREATE_WITH_ASSISTANT = "skills.pane.addMenu.createWithAssistant";
const MEETING_PREP = skill("meeting-prep", { displayName: "Meeting prep" });
const EMPTY_WITH_ASSISTANT = /skills\.pane\.empty\.description(?!NoAssistant)/;

// The library starts empty; `install` adds a skill the way the pane's next read sees it.
async function renderPane(t, { props = {}, wrap } = {}) {
  let library = [];
  const mounted = await mountSkillsComponent(t, {
    modulePath: "/components/integrations/SkillsPane.tsx",
    exportName: "SkillsPane",
    props: { title: "Skills", active: true, ...props },
    wrap,
    api: {
      skillsList: async () => ({ skills: library }),
      skillsGet: async (name) => ({
        ...library.find((entry) => entry.name === name),
        markdown: "---\nname: x\n---\n",
        files: [],
      }),
    },
  });
  const { container, store } = mounted;
  const find = (predicate) => findElement(container, predicate);
  return {
    ...mounted,
    find,
    buttons: (text) =>
      findAll(container, (node) => node.tagName === "BUTTON" && label(node) === text),
    dialog: () => find((node) => node.getAttribute("role") === "dialog"),
    field: (labelKey) => {
      const fieldLabel = find((node) => node.tagName === "LABEL" && label(node) === labelKey);
      return find((node) => node.getAttribute("id") === fieldLabel.getAttribute("for"));
    },
    install: async (entry) => {
      library = [entry];
      await React.act(async () => store.useSkillsStore.setState({ skills: library }));
      await settle();
    },
    openCard: async () => {
      await click(find((node) => ariaLabel(node).startsWith("skills.pane.cardLabel")));
      await settle();
    },
  };
}

const menuItems = (container) =>
  findAll(container, (node) => node.getAttribute("role") === "menuitem").map(label);

test("the Add menu, empty state, detail and Create offer the chat entry points", async (t) => {
  const starts = [];
  const pane = await renderPane(t, { props: { onStartSkillChat: (start) => starts.push(start) } });
  const { container, store, buttons } = pane;

  assert.equal(menuItems(container)[0], CREATE_WITH_ASSISTANT, "first in the Add menu");
  assert.match(label(container), EMPTY_WITH_ASSISTANT);
  const emptyState = buttons(CREATE_WITH_ASSISTANT).find(
    (node) => node.getAttribute("role") !== "menuitem"
  );
  assert.ok(emptyState, "the empty state's primary button");
  await click(emptyState);
  assert.deepEqual(starts.at(-1), { kind: "create" });

  await pane.install(MEETING_PREP);
  await pane.openCard();
  await click(buttons("skills.detail.tryNow")[0]);
  await settle();
  assert.deepEqual(starts.at(-1), {
    kind: "try",
    name: "meeting-prep",
    displayName: "Meeting prep",
  });
  assert.equal(pane.dialog(), null, "the pop-up closes");

  await click(buttons("skills.pane.addMenu.create")[0]);
  await typeInto(pane.field("skills.create.name"), "Weekly report");
  await click(buttons("skills.create.draftWithAssistant")[0]);

  assert.deepEqual(starts.at(-1), {
    kind: "create",
    draft: { title: "Weekly report", description: "", instructions: "", fileNames: [] },
  });
  assert.equal(store.useSkillsStore.getState().createDraft?.title, "Weekly report");
  assert.doesNotMatch(container.textContent, /skills\.create\.unsaved/);
});

test("they are hidden when the assistant isn't allowed by policy", async (t) => {
  const pane = await renderPane(t);
  const { container, buttons } = pane;

  assert.ok(!menuItems(container).includes(CREATE_WITH_ASSISTANT));
  assert.equal(buttons(CREATE_WITH_ASSISTANT).length, 0);
  // The empty state doesn't suggest the assistant the user can't use.
  assert.doesNotMatch(label(container), EMPTY_WITH_ASSISTANT);
  assert.match(label(container), /skills\.pane\.empty\.descriptionNoAssistant/);

  await pane.install(MEETING_PREP);
  await pane.openCard();
  assert.ok(pane.dialog());
  assert.equal(buttons("skills.detail.tryNow").length, 0);

  await click(buttons("skills.pane.addMenu.create")[0]);
  assert.equal(buttons("skills.create.draftWithAssistant").length, 0);
});

test("an open-skill request goes home and opens that skill", async (t) => {
  let setRequest;
  let handled = 0;
  function Harness({ Component }) {
    const [request, set] = React.useState(null);
    setRequest = set;
    return React.createElement(Component, {
      title: "Skills",
      active: true,
      openSkillRequest: request,
      onOpenSkillRequestHandled: () => (handled += 1),
    });
  }
  const pane = await renderPane(t, {
    wrap: (Component) => React.createElement(Harness, { Component }),
  });
  await pane.install(MEETING_PREP);
  await click(pane.find((node) => ariaLabel(node) === "skills.pane.manage"));
  assert.match(pane.container.textContent, /skills\.manage\.title/);

  await React.act(async () => setRequest({ id: 1, name: "meeting-prep" }));
  await settle();

  assert.doesNotMatch(pane.container.textContent, /skills\.manage\.title/, "back on home");
  assert.match(label(pane.dialog()), /Meeting prep/);
  assert.equal(handled, 1);
});
