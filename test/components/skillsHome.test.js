const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");

const { findElement } = require("../lib/interactiveDom");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { SKILL_LIMITS } = require("../../src/helpers/skills/skillFormat");
const {
  ariaLabel,
  dispatch,
  findAll,
  label,
  mountSkillsComponent,
  settle,
  skill,
  typeInto,
} = require("../lib/skillsHarness");

const RECOMMENDED_DIR = path.join(__dirname, "../../src/helpers/skills/recommended");

const cards = (container) =>
  findAll(
    container,
    (node) => node.tagName === "BUTTON" && ariaLabel(node).startsWith("skills.pane.cardLabel")
  );
const cardNames = (container) =>
  cards(container).map((card) => JSON.parse(ariaLabel(card).slice(21)).name);
const recommendedIds = (container) =>
  findAll(
    container,
    (node) => node.tagName === "BUTTON" && ariaLabel(node).startsWith("skills.pane.addRecommended")
  ).map((button) => ariaLabel(button).match(/skills\.recommended\.([a-z-]+)\.title/)[1]);
const buttonWithText = (container, text) =>
  findElement(container, (node) => node.tagName === "BUTTON" && label(node).startsWith(text));

async function renderHome(t, { skills = [], api = {} } = {}) {
  const calls = { opened: [], manage: 0, create: 0, upload: 0 };
  const mounted = await mountSkillsComponent(t, {
    modulePath: "/components/skills/SkillsHome.tsx",
    exportName: "SkillsHome",
    skills,
    api,
    props: {
      title: "Skills",
      onOpenSkill: (name) => calls.opened.push(name),
      onManage: () => calls.manage++,
      onCreate: () => calls.create++,
      onUpload: () => calls.upload++,
    },
  });
  return { ...mounted, calls };
}

test("the home grid shows six installed skills, then a See link naming the next two", async (t) => {
  const skills = Array.from({ length: 9 }, (_, index) => skill(`skill-${index + 1}`));
  const { container, calls } = await renderHome(t, { skills });

  assert.deepEqual(cardNames(container), [1, 2, 3, 4, 5, 6].map((n) => `skill ${n}`));
  const seeMore = buttonWithText(container, "skills.pane.seeMore");
  assert.equal(
    label(seeMore),
    'skills.pane.seeMore{"first":"skill 7","second":"skill 8","count":1}'
  );

  await React.act(async () => dispatch(seeMore, "click"));
  assert.equal(calls.manage, 1);

  // Searching shows every match, so nothing is left to see
  const search = findElement(container, (node) => node.tagName === "INPUT");
  await typeInto(search, "skill");
  assert.equal(cards(container).length, 9);
  assert.equal(buttonWithText(container, "skills.pane.see"), null);
});

test("one or two hidden skills are named in full", async (t) => {
  const seven = Array.from({ length: 7 }, (_, index) => skill(`skill-${index + 1}`));
  const { container, store } = await renderHome(t, { skills: seven });

  assert.equal(
    label(buttonWithText(container, "skills.pane.see")),
    'skills.pane.seeOne{"first":"skill 7"}'
  );

  await React.act(async () =>
    store.useSkillsStore.setState({ skills: [...seven, skill("skill-8")] })
  );
  assert.equal(
    label(buttonWithText(container, "skills.pane.see")),
    'skills.pane.seeTwo{"first":"skill 7","second":"skill 8"}'
  );
});

test("search filters installed and recommended skills by name and description", async (t) => {
  const { container } = await renderHome(t, {
    skills: [
      skill("meeting-prep", { displayName: "Meeting prep", description: "Briefs me first" }),
      skill("weekly-recap", { displayName: "Weekly recap", description: "Writes my Friday note" }),
    ],
  });
  const search = findElement(container, (node) => node.tagName === "INPUT");
  assert.deepEqual(
    [search.getAttribute("aria-label"), search.getAttribute("dir")],
    ["skills.pane.search", "auto"]
  );
  assert.equal(recommendedIds(container).length, 4);

  await typeInto(search, "FRIDAY");
  assert.deepEqual([cardNames(container), recommendedIds(container)], [["Weekly recap"], []]);

  await typeInto(search, "prep");
  assert.deepEqual(
    [cardNames(container), recommendedIds(container)],
    [["Meeting prep"], ["one-on-one-prep"]]
  );

  await typeInto(search, "linear");
  assert.deepEqual(
    [cardNames(container), recommendedIds(container)],
    [[], ["action-items-to-linear"]]
  );
  assert.match(container.textContent, /skills\.pane\.noMatches\{"query":"linear"\}/);
});

test("the empty library shows the empty state and still recommends skills", async (t) => {
  const { container, calls } = await renderHome(t, { skills: [] });

  assert.match(container.textContent, /skills\.pane\.empty\.title/);
  assert.match(container.textContent, /skills\.pane\.empty\.description/);
  assert.deepEqual(recommendedIds(container).sort(), fs.readdirSync(RECOMMENDED_DIR).sort());
  // The header keeps only Add: there is nothing to search or manage yet
  assert.equal(findElement(container, (node) => node.tagName === "INPUT"), null);
  assert.equal(
    findElement(container, (node) => ariaLabel(node) === "skills.pane.manage"),
    null
  );
  assert.ok(buttonWithText(container, "skills.pane.add"));

  const uploads = findAll(
    container,
    (node) => node.tagName === "BUTTON" && label(node) === "skills.pane.addMenu.upload"
  );
  await React.act(async () => dispatch(uploads.at(-1), "click"));
  assert.equal(calls.upload, 1);
});

test(
  "adding a recommended skill uses the localized title and description, plays its icon and toasts",
  async (t) => {
    const added = [];
    let listed = [];
    const { container, toasts, store } = await renderHome(t, {
      skills: [],
      api: {
        skillsAddRecommended: async (id, copy) => {
          added.push([id, copy]);
          listed = [skill(id, { displayName: "Meeting decisions" })];
          return { ok: true, name: id };
        },
        skillsList: async () => ({ skills: listed }),
      },
    });
    const add = findElement(
      container,
      (node) =>
        ariaLabel(node) ===
        'skills.pane.addRecommended{"name":"skills.recommended.meeting-decisions.title"}'
    );

    await React.act(async () => dispatch(add, "click"));

    assert.deepEqual(added, [
      [
        "meeting-decisions",
        {
          title: "skills.recommended.meeting-decisions.title",
          description: "skills.recommended.meeting-decisions.description",
        },
      ],
    ]);
    assert.deepEqual(cardNames(container), ["Meeting decisions"]);
    assert.equal(store.useSkillsStore.getState().iconPlays["meeting-decisions"], 1);
    assert.deepEqual(toasts, [
      {
        title: 'skills.toasts.added{"name":"skills.recommended.meeting-decisions.title"}',
        variant: "success",
      },
    ]);
    assert.equal(container.ownerDocument.activeElement === cards(container)[0], true);
    assert.equal(recommendedIds(container).includes("meeting-decisions"), false);
  }
);

test("a library that can't be read says so and offers Retry", async (t) => {
  let lists = 0;
  const { container, store } = await renderHome(t, {
    api: {
      skillsList: async () => {
        lists += 1;
        return { skills: [skill("recap")] };
      },
    },
  });
  await React.act(async () =>
    store.useSkillsStore.setState({ skills: [], loaded: false, loadError: true })
  );
  assert.match(label(container), /skills\.toasts\.loadFailed/);
  const retry = findElement(
    container,
    (node) => node.tagName === "BUTTON" && label(node) === "common.retry"
  );

  await React.act(async () => dispatch(retry, "click"));
  await settle();

  assert.equal(lists, 1);
  assert.deepEqual(cardNames(container), ["recap"]);
  // The card holding Retry is gone, so the heading takes focus.
  assert.equal(container.ownerDocument.activeElement?.tagName, "H2");
});

test("a Retry that fails again says so", async (t) => {
  const { container, store, toasts } = await renderHome(t, {
    api: {
      skillsList: async () => {
        throw new Error("Error invoking remote method 'skills-list'");
      },
    },
  });
  await React.act(async () =>
    store.useSkillsStore.setState({ skills: [], loaded: false, loadError: true })
  );
  const retry = findElement(
    container,
    (node) => node.tagName === "BUTTON" && label(node) === "common.retry"
  );

  await React.act(async () => dispatch(retry, "click"));
  await settle();

  assert.deepEqual(toasts, [{ title: "skills.toasts.loadFailed", variant: "destructive" }]);
  assert.match(label(container), /common\.retry/);
});

test("pressing + again while a skill is being added adds it once", async (t) => {
  const added = [];
  const { container, toasts, pushes } = await renderHome(t, {
    api: {
      skillsAddRecommended: async (id) => {
        added.push(id);
        return { ok: true, name: id };
      },
    },
  });
  const add = findElement(container, (node) =>
    ariaLabel(node).startsWith("skills.pane.addRecommended")
  );

  await React.act(async () => {
    dispatch(add, "click");
    dispatch(add, "click");
  });
  await settle();

  assert.equal(added.length, 1);
  assert.equal(toasts.length, 1);
  assert.deepEqual(pushes, ["syncSkillsNow"], "backed up once");
});

test("a failed add says why", async (t) => {
  const { container, toasts, pushes } = await renderHome(t, {
    api: { skillsAddRecommended: async () => ({ ok: false, error: "noSpace" }) },
  });
  const add = findElement(container, (node) =>
    ariaLabel(node).startsWith("skills.pane.addRecommended")
  );

  await React.act(async () => dispatch(add, "click"));

  assert.deepEqual(toasts, [
    {
      title: "skills.toasts.writeFailed",
      description: "skills.toasts.writeFailedNoSpace",
      variant: "destructive",
    },
  ]);
  assert.deepEqual(pushes, []);
});

test("an add refused because a skill already has that title says so", async (t) => {
  const refusal = { code: "nameTaken", values: { name: "Meeting decisions" } };
  const { container, toasts } = await renderHome(t, {
    api: { skillsAddRecommended: async () => ({ ok: false, problems: [refusal] }) },
  });
  const add = findElement(container, (node) =>
    ariaLabel(node).startsWith("skills.pane.addRecommended")
  );

  await React.act(async () => dispatch(add, "click"));

  assert.deepEqual(toasts, [
    {
      title: "skills.toasts.writeFailed",
      description: 'skills.problems.nameTaken{"name":"Meeting decisions"}',
      variant: "destructive",
    },
  ]);
});

test("a skill that needs fixing says so on its card", async (t) => {
  const { container } = await renderHome(t, {
    skills: [
      skill("broken", { valid: false, problem: { code: "missingDescription" } }),
      skill("paused", { enabled: false }),
      skill("working"),
    ],
  });

  const [broken, paused, working] = cards(container);
  assert.equal(
    ariaLabel(broken),
    'skills.pane.cardLabel{"name":"broken","state":"skills.pane.stateNeedsFix"}'
  );
  assert.match(label(broken), /skills\.pane\.needsFix$/);
  assert.ok(findElement(broken, (node) => node.getAttribute("data-icon") === "alert-triangle"));
  assert.match(label(paused), /skills\.pane\.off$/);
  assert.match(ariaLabel(paused), /"state":"skills\.pane\.stateOff"/);
  assert.ok(findElement(working, (node) => node.getAttribute("data-icon") === "check"));
  assert.match(ariaLabel(working), /"state":"skills\.pane\.stateOn"/);
  for (const card of [broken, paused, working]) {
    const texts = findAll(card, (node) => node.tagName === "P");
    assert.deepEqual(
      texts.map((text) => text.getAttribute("dir")),
      ["auto", "auto"]
    );
  }
});

test("the gear opens Manage and the Add menu offers Create skill and Upload skill", async (t) => {
  const { container, calls } = await renderHome(t, { skills: [skill("meeting-prep")] });

  const gear = findElement(container, (node) => ariaLabel(node) === "skills.pane.manage");
  assert.equal(gear.getAttribute("title"), "skills.pane.manage");
  await React.act(async () => dispatch(gear, "click"));
  const menuItem = (text) => buttonWithText(container, `skills.pane.addMenu.${text}`);
  await React.act(async () => dispatch(menuItem("create"), "click"));
  await React.act(async () => dispatch(menuItem("upload"), "click"));
  await React.act(async () => dispatch(cards(container)[0], "click"));

  assert.deepEqual(calls, { opened: ["meeting-prep"], manage: 1, create: 1, upload: 1 });
});

test("the screens' size cap is the library's", async (t) => {
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-skill-copy-test-" });
  const { MAX_SKILL_BYTES } = await vite.ssrLoadModule("/components/skills/skillCopy.ts");

  assert.equal(MAX_SKILL_BYTES, SKILL_LIMITS.maxBytes);
});

test("the recommended skills are the ones the app ships", async (t) => {
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-skill-copy-test-" });
  const { RECOMMENDED_SKILL_IDS } = await vite.ssrLoadModule("/components/skills/skillCopy.ts");

  assert.deepEqual([...RECOMMENDED_SKILL_IDS].sort(), fs.readdirSync(RECOMMENDED_DIR).sort());
});
