const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const {
  createRendererServer,
  installBrowserGlobals,
  installHappyDom,
} = require("../lib/rendererTestHarness");

// i18n is not initialized, so labels render as their keys: the fork chip is
// "chat.forkedFrom".

async function renderList(t, { messages, forkOrigin }) {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-agent-message-list-" });
  const { AgentMessageList } = await vite.ssrLoadModule("/components/agent/AgentMessages.tsx");
  const noop = () => {};
  return renderToStaticMarkup(
    React.createElement(AgentMessageList, {
      messages,
      forkOrigin,
      onOpenParent: noop,
      busy: false,
      readAloud: { available: false, speakingId: null, toggle: noop },
      onRegenerate: noop,
      onFork: noop,
      onFollowUp: noop,
      onContinue: noop,
      emptyState: null,
    })
  );
}

const message = (id, role, content) => ({
  id,
  dbId: Number(id.slice(1)),
  role,
  content,
  isStreaming: false,
});
const MESSAGES = [
  message("m1", "user", "Draft the plan"),
  message("m2", "assistant", "Here is the plan."),
  message("m3", "user", "Shorter, please"),
  message("m4", "assistant", "A shorter plan."),
];

test("a fork shows its chip above its own turns", async (t) => {
  const markup = await renderList(t, {
    messages: MESSAGES.slice(2),
    forkOrigin: {
      parentConversationId: 1,
      parentTitle: "Plan",
      context: null,
      copiedMessageCount: 2,
    },
  });
  assert.ok(markup.indexOf("chat.forkedFrom") < markup.indexOf("Shorter, please"));
});

test("the selection toolbar is placed again when Fork from here appears", async (t) => {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const happyWindow = await installHappyDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-agent-message-list-",
    // Counts the placements; the real math is covered on its own.
    mockModules: {
      "/selectionToolbarPlacement": `
        globalThis.__placements = 0;
        export function placeSelectionToolbar() {
          globalThis.__placements += 1;
          return { top: 0, left: 0 };
        }
      `,
    },
  });
  const { AgentMessageList } = await vite.ssrLoadModule("/components/agent/AgentMessages.tsx");
  const { createRoot } = require("react-dom/client");
  const host = happyWindow.document.createElement("div");
  happyWindow.document.body.append(host);
  root = createRoot(host);
  const noop = () => {};
  const render = (answerDbId) =>
    React.act(async () =>
      root.render(
        React.createElement(AgentMessageList, {
          messages: [
            message("m1", "user", "Draft the plan"),
            { ...message("m2", "assistant", "Here is the plan."), dbId: answerDbId },
          ],
          forkOrigin: null,
          onOpenParent: noop,
          busy: false,
          readAloud: { available: false, speakingId: null, toggle: noop },
          onRegenerate: noop,
          onFork: noop,
          onFollowUp: noop,
          onContinue: noop,
          emptyState: null,
        })
      )
    );
  const forkButton = () =>
    [...host.querySelectorAll("button")].find((b) => b.textContent === "agentWindow.forkFromHere");

  // The answer selected before it is saved: Follow up only.
  await render(undefined);
  const range = happyWindow.document.createRange();
  range.selectNodeContents(host.querySelector("[data-agent-answer]"));
  happyWindow.getSelection().addRange(range);
  await React.act(async () => {
    happyWindow.document.dispatchEvent(new happyWindow.MouseEvent("mouseup", { bubbles: true }));
  });
  assert.ok(host.querySelector('[role="toolbar"]'), "the toolbar shows");
  assert.ok(!forkButton());
  const placed = globalThis.__placements;

  // The save lands while the text stays selected: Fork from here widens it.
  await render(2);
  assert.ok(forkButton());
  assert.ok(globalThis.__placements > placed, "placed again for its new width");
});

test("a streaming reply lays out its actions out of sight, so they don't push it up as it ends", async (t) => {
  // The Copy button's row: hidden while the reply streams, shown once it ends.
  const actionRow = (markup) =>
    markup.match(/<div class="([^"]*)">(?:(?!<div).)*?aria-label="common.copy"/)?.[1];
  const streaming = { ...message("m2", "assistant", "Here is the"), isStreaming: true };
  const running = await renderList(t, { messages: [MESSAGES[0], streaming], forkOrigin: null });
  assert.match(actionRow(running) ?? "", /\binvisible\b/);

  const done = await renderList(t, { messages: MESSAGES.slice(0, 2), forkOrigin: null });
  assert.ok(actionRow(done) !== undefined && !/\binvisible\b/.test(actionRow(done)));
});

// The list mounted in a DOM, with the real card stores.
async function mountLiveList(t) {
  let root = null;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
  });
  const happyWindow = await installHappyDom(t);
  const vite = await createRendererServer(t, { cachePrefix: "openwhispr-agent-message-list-" });
  const { AgentMessageList } = await vite.ssrLoadModule("/components/agent/AgentMessages.tsx");
  const { useAgentInteractionStore } = await vite.ssrLoadModule("/stores/agentInteractionStore.ts");
  const { useSkillApprovalStore } = await vite.ssrLoadModule("/stores/skillApprovalStore.ts");
  const { createRoot } = require("react-dom/client");
  const host = happyWindow.document.createElement("div");
  happyWindow.document.body.append(host);
  root = createRoot(host);
  const noop = () => {};
  const render = (messages) =>
    React.act(async () =>
      root.render(
        React.createElement(AgentMessageList, {
          messages,
          forkOrigin: null,
          onOpenParent: noop,
          busy: true,
          readAloud: { available: false, speakingId: null, toggle: noop },
          onRegenerate: noop,
          onFork: noop,
          onFollowUp: noop,
          onContinue: noop,
          emptyState: null,
        })
      )
    );
  const setInteractions = (entries) =>
    React.act(async () => useAgentInteractionStore.setState({ entries }));
  const setSkills = (entries) => React.act(async () => useSkillApprovalStore.setState({ entries }));
  return { host, render, setInteractions, setSkills };
}

for (const [name, kind] of [
  ["propose_skill", "create"],
  ["update_skill", "update"],
]) {
  test(`the modal shows a pending ${name} card and its saved receipt`, async (t) => {
    const { host, render, setSkills } = await mountLiveList(t);
    const draft = {
      title: "Follow up",
      description: "Draft follow-ups.",
      instructions: "Be brief.",
      files: [],
    };
    const call = { id: "skill", name, arguments: "{}", status: "executing" };
    const entry = {
      key: "m2::skill",
      messageId: "m2",
      toolCallId: "skill",
      kind,
      name: "follow-up",
      state: "pending",
      draft,
      original: draft,
      checkedTitle: draft.title,
      displayName: draft.title,
      intent: "Keep follow-ups brief.",
      removals: [],
      learnedFrom: null,
      current: { description: "Draft follow-ups.", instructions: "Write a follow-up.", files: {} },
    };
    const answer = (step) => ({ ...message("m2", "assistant", ""), toolCalls: [step] });
    await render([MESSAGES[0], answer(call)]);
    assert.equal(host.querySelector("[data-approval-card]"), null);
    await setSkills({ [entry.key]: entry });
    assert.ok(host.querySelector('[data-approval-card="m2::skill"]'));
    const buttons = [...host.querySelectorAll("button")].map((button) => button.textContent);
    assert.ok(buttons.includes(`skills.approval.${kind === "create" ? "save" : "update"}`));
    assert.ok(buttons.includes("common.skip"));

    await setSkills({});
    await render([
      MESSAGES[0],
      answer({
        ...call,
        status: "completed",
        metadata: { status: "saved", kind, name: entry.name, title: draft.title, versionId: "v1" },
      }),
    ]);
    assert.ok(host.querySelector('[data-skill-card-record="follow-up"][data-state="saved"]'));
    assert.ok(
      [...host.querySelectorAll("button")].some(
        (button) => button.textContent === "skills.approval.undo"
      )
    );
  });
}

const QUESTION = {
  key: "m2::c1",
  messageId: "m2",
  toolCallId: "c1",
  state: "pending",
  draft: {},
  typedAnswers: {},
  step: 0,
  payload: {
    kind: "questions",
    questions: [
      {
        id: "who",
        kind: "single",
        prompt: "Who should it go to?",
        options: [
          { id: "sam", label: "Sam" },
          { id: "alex", label: "Alex" },
        ],
      },
    ],
  },
};
const askUser = { id: "c1", name: "ask_user", arguments: "{}", status: "executing" };

test("an answered question leaves a line with the answer in place of its card", async (t) => {
  const { host, render, setInteractions } = await mountLiveList(t);
  await setInteractions({ [QUESTION.key]: QUESTION });
  await render([
    MESSAGES[0],
    { ...message("m2", "assistant", ""), isStreaming: true, toolCalls: [askUser] },
  ]);
  assert.ok(host.querySelector("[data-interaction-card]"));

  // A question left blank says nothing in the line.
  const questions = [
    ...QUESTION.payload.questions,
    { id: "note", kind: "text", prompt: "Anything to add?" },
    { id: "when", kind: "text", prompt: "When?" },
  ];
  await setInteractions({
    [QUESTION.key]: {
      ...QUESTION,
      payload: { kind: "questions", questions },
      state: "settled",
      result: { status: "answered", answers: { who: "sam", note: "", when: "Friday" } },
    },
  });
  assert.equal(host.querySelector("[data-interaction-card]"), null);
  const outcome = host.querySelector('[data-interaction-outcome="m2::c1"]');
  assert.equal(outcome?.textContent, "agentMode.interactions.status.answered · Sam · Friday");
});

test("text written before a card stays above it, and what follows goes below", async (t) => {
  const { host, render, setInteractions } = await mountLiveList(t);
  await setInteractions({ [QUESTION.key]: QUESTION });
  const before = "One question first.";
  const after = "Sending it to Sam.";
  const reply = (call) => ({
    ...message("m2", "assistant", `${before}\n\n${after}`),
    isStreaming: true,
    toolCalls: [call],
  });
  const order = () => {
    const text = host.textContent;
    return [before, "Who should it go to?", after].map((part) => text.indexOf(part));
  };

  await render([MESSAGES[0], reply({ ...askUser, textOffset: before.length })]);
  const [textBefore, card, textAfter] = order();
  assert.ok(textBefore < card && card < textAfter, "the card between the two");
  assert.equal(host.querySelectorAll("[data-agent-answer]").length, 2);

  // A reply saved before calls kept their place: the card first, as it always showed.
  await render([MESSAGES[0], reply(askUser)]);
  const [oldBefore, oldCard, oldAfter] = order();
  assert.ok(oldCard < oldBefore && oldBefore < oldAfter);
  assert.equal(host.querySelectorAll("[data-agent-answer]").length, 1);
});
