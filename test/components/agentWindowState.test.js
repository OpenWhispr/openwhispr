const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/components/agent/agentWindowState.ts");

const context = { text: "2. Demo — a raw recording", sourceMessageId: "m1" };

test("the draft and the selected context survive every layout and input change", async () => {
  const { agentWindowReducer, INITIAL_AGENT_WINDOW_STATE } = await load();
  let state = agentWindowReducer(INITIAL_AGENT_WINDOW_STATE, {
    type: "show",
    layout: "pill",
    input: "voice",
  });
  state = agentWindowReducer(state, { type: "setDraft", draft: "Write the hero copy" });
  state = agentWindowReducer(state, { type: "setContext", context });

  const changes = [
    { type: "useKeyboard" },
    { type: "expand" },
    { type: "useVoice" },
    { type: "collapse" },
    { type: "expand" },
    { type: "useKeyboard" },
    { type: "collapse" },
    { type: "useVoice" },
    { type: "show", layout: "typing", input: "keyboard" },
  ];
  const layouts = [];
  for (const action of changes) {
    state = agentWindowReducer(state, action);
    layouts.push(`${state.layout}/${state.input}`);
    assert.equal(state.draft, "Write the hero copy", action.type);
    assert.deepEqual(state.selectedContext, context, action.type);
  }
  assert.deepEqual(layouts, [
    "typing/keyboard",
    "modal/keyboard",
    "modal/voice",
    "pill/voice",
    "modal/voice",
    "modal/keyboard",
    "typing/keyboard",
    "pill/voice",
    "typing/keyboard",
  ]);
});

test("a typed request opens the modal and clears the draft; a spoken one keeps both where they are", async () => {
  const { agentWindowReducer, INITIAL_AGENT_WINDOW_STATE } = await load();
  const typing = {
    ...INITIAL_AGENT_WINDOW_STATE,
    visible: true,
    layout: "typing",
    input: "keyboard",
    draft: "typed",
    selectedContext: context,
    attachment: { image: "AAAA", mediaType: "image/jpeg" },
  };

  const typed = agentWindowReducer(typing, { type: "submitted", typed: true });
  assert.equal(typed.layout, "modal");
  assert.equal(typed.draft, "");
  assert.equal(typed.selectedContext, null);
  assert.equal(typed.attachment, null);

  const spoken = agentWindowReducer(
    { ...typing, layout: "pill", input: "voice" },
    { type: "submitted", typed: false }
  );
  assert.equal(spoken.layout, "pill");
  assert.equal(spoken.draft, "typed");
  assert.equal(spoken.selectedContext, null);
  assert.equal(spoken.attachment, null);
});

test("a take switched to typing lands in the draft after what was typed", async () => {
  const { agentWindowReducer, INITIAL_AGENT_WINDOW_STATE } = await load();
  let state = agentWindowReducer(INITIAL_AGENT_WINDOW_STATE, {
    type: "appendDraft",
    text: "first",
  });
  state = agentWindowReducer(state, { type: "appendDraft", text: "second" });
  assert.equal(state.draft, "first second");
});

test("closing returns to the voice pill, keeps the draft and drops what rode with one request", async () => {
  const { agentWindowReducer, INITIAL_AGENT_WINDOW_STATE } = await load();
  const closed = agentWindowReducer(
    {
      ...INITIAL_AGENT_WINDOW_STATE,
      visible: true,
      layout: "modal",
      input: "keyboard",
      draft: "keep me",
      selectedContext: context,
      attachment: { image: "AAAA", mediaType: "image/jpeg" },
      notice: "agentWindow.notices.nothingHeard",
    },
    { type: "hide" }
  );
  assert.deepEqual(closed, {
    ...INITIAL_AGENT_WINDOW_STATE,
    draft: "keep me",
  });
});

test("a press while the modal is open stays in the modal", async () => {
  const { agentWindowReducer, INITIAL_AGENT_WINDOW_STATE } = await load();
  const open = { ...INITIAL_AGENT_WINDOW_STATE, visible: true, layout: "modal", input: "keyboard" };
  const pressed = agentWindowReducer(open, { type: "show", layout: "pill", input: "voice" });
  assert.equal(pressed.layout, "modal");
  assert.equal(pressed.input, "voice");
});

test("the pill's controls follow the reference states", async () => {
  const { resolveAgentPillControls } = await load();
  const controls = (...args) => resolveAgentPillControls(...args);

  assert.deepEqual(controls("compact", "listening"), {
    waveform: true,
    thinking: false,
    waiting: false,
    buttons: ["expand", "keyboard", "close"],
  });
  assert.deepEqual(controls("compact", "thinking").buttons, ["keyboard", "close"]);
  assert.equal(controls("compact", "thinking").thinking, true);
  assert.deepEqual(controls("compact", "transcribing").buttons, ["keyboard", "close"]);
  assert.deepEqual(controls("modal", "transcribing").buttons, ["keyboard", "close"]);
  assert.deepEqual(controls("typing", "idle").buttons, ["expand", "mic", "close"]);
  assert.deepEqual(controls("modal", "listening").buttons, ["keyboard", "close"]);
  assert.deepEqual(controls("modal", "streaming").buttons, ["keyboard", "stop", "close"]);
  assert.deepEqual(controls("modal", "idle").buttons, ["mic", "keyboard", "close"]);
  assert.deepEqual(controls("compact", "idle", true).buttons, ["mic", "close"]);
  assert.deepEqual(controls("modal", "idle", true).buttons, ["mic", "keyboard", "close"]);
});

test("in the modal a reply can be stopped before it has anything to show", async () => {
  const { resolveAgentPillControls } = await load();
  const thinking = resolveAgentPillControls("modal", "thinking");
  assert.equal(thinking.thinking, true);
  assert.deepEqual(thinking.buttons, ["keyboard", "stop", "close"]);
});

test("a pending card that needs typing asks for the keyboard, even after a spoken request", async () => {
  const { awaitsTypedAnswer } = await load();
  const reply = (interaction) => ({ toolCalls: [{ id: "1", name: "ask_user", interaction }] });
  const questions = (kind) => ({
    kind: "questions",
    questions: [{ id: "q", kind, prompt: "Which?", options: [{ id: "a", label: "A" }] }],
  });

  assert.equal(awaitsTypedAnswer([reply({ state: "pending", payload: questions("text") })]), true);
  assert.equal(
    awaitsTypedAnswer([
      reply({
        state: "pending",
        payload: { kind: "apiKey", provider: "groq", providerName: "Groq" },
      }),
    ]),
    true
  );
  assert.equal(
    awaitsTypedAnswer([reply({ state: "pending", payload: questions("single") })]),
    false
  );
  assert.equal(awaitsTypedAnswer([reply({ state: "settled", payload: questions("text") })]), false);
  assert.equal(awaitsTypedAnswer([{ toolCalls: undefined }]), false);
});

test("a request that arrives while a reply runs waits in the composer with what it brought", async () => {
  const { agentWindowReducer, INITIAL_AGENT_WINDOW_STATE } = await load();
  const attachment = { image: "AAAA", mediaType: "image/jpeg" };
  const held = agentWindowReducer(
    {
      ...INITIAL_AGENT_WINDOW_STATE,
      visible: true,
      layout: "modal",
      input: "voice",
      draft: "Also",
    },
    { type: "held", text: "summarize this", context, attachment }
  );
  assert.equal(held.input, "keyboard");
  assert.equal(held.layout, "modal");
  assert.equal(held.draft, "Also summarize this");
  assert.deepEqual(held.selectedContext, context);
  assert.deepEqual(held.attachment, attachment);

  const fromPill = agentWindowReducer(
    { ...INITIAL_AGENT_WINDOW_STATE, visible: true },
    { type: "held", text: "hi", context: null, attachment: null }
  );
  assert.equal(fromPill.layout, "typing");
});

test("a card that arrives while compact shows above the pill, and the pill comes back after", async () => {
  const { agentWindowReducer, INITIAL_AGENT_WINDOW_STATE } = await load();
  const pill = { ...INITIAL_AGENT_WINDOW_STATE, visible: true, layout: "pill", input: "voice" };
  const standalone = agentWindowReducer(pill, { type: "showCard", asks: true });
  assert.equal(standalone.layout, "standalone");
  assert.equal(agentWindowReducer(standalone, { type: "cardSettled" }).layout, "pill");
  // An answer card waits behind the pill.
  assert.equal(agentWindowReducer(pill, { type: "showCard", asks: false }).layout, "pill");

  // From the typing layout with nothing typed too, and back to it once the card is answered.
  const typing = { ...pill, layout: "typing", input: "keyboard", draft: "" };
  const asked = agentWindowReducer(typing, { type: "showCard", asks: true });
  assert.equal(asked.layout, "standalone");
  assert.equal(agentWindowReducer(asked, { type: "cardSettled" }).layout, "typing");
  // An answer card from typing opens in the modal: the keyboard stays with the window.
  const answer = agentWindowReducer(typing, { type: "showCard", asks: false });
  assert.deepEqual([answer.layout, answer.input], ["modal", "keyboard"]);
  // So does a card that asks while a message is being written: the message keeps the keyboard.
  const writing = agentWindowReducer(
    { ...typing, draft: "and also check my cal" },
    { type: "showCard", asks: true }
  );
  assert.deepEqual([writing.layout, writing.draft], ["modal", "and also check my cal"]);
  // A card above the pill the user is typing on counts as typing; with voice input it doesn't.
  const typedCard = { ...pill, layout: "standalone", input: "keyboard", draft: "" };
  assert.equal(agentWindowReducer(typedCard, { type: "showCard", asks: false }).layout, "modal");
  const spokenCard = { ...pill, layout: "standalone", input: "voice", draft: "" };
  assert.equal(agentWindowReducer(spokenCard, { type: "showCard", asks: false }).layout, "pill");

  // The modal already shows the card.
  const modal = { ...pill, layout: "modal" };
  assert.equal(agentWindowReducer(modal, { type: "showCard", asks: true }), modal);
  assert.equal(agentWindowReducer(modal, { type: "cardSettled" }), modal);
});

test("with a card waiting, minimize leaves the waiting pill and Keyboard opens the card", async () => {
  const { agentWindowReducer, INITIAL_AGENT_WINDOW_STATE } = await load();
  const modal = {
    ...INITIAL_AGENT_WINDOW_STATE,
    visible: true,
    layout: "modal",
    input: "keyboard",
  };
  assert.equal(agentWindowReducer(modal, { type: "collapse", pending: true }).layout, "pill");
  assert.equal(agentWindowReducer(modal, { type: "collapse", pending: false }).layout, "typing");

  const standalone = { ...modal, layout: "standalone", input: "voice" };
  const typed = agentWindowReducer(standalone, { type: "useKeyboard", pending: true });
  assert.deepEqual([typed.layout, typed.input], ["modal", "keyboard"]);
  const waitingPill = { ...standalone, layout: "pill" };
  assert.equal(
    agentWindowReducer(waitingPill, { type: "useKeyboard", pending: true }).layout,
    "modal"
  );
  // Expand keeps voice: no composer appears.
  const expanded = agentWindowReducer(standalone, { type: "expand" });
  assert.deepEqual([expanded.layout, expanded.input], ["modal", "voice"]);
});

test("waiting for an answer, the pill says so and keeps the way to the card", async () => {
  const { resolveAgentPillControls } = await load();
  assert.deepEqual(resolveAgentPillControls("compact", "waiting"), {
    waveform: false,
    thinking: false,
    waiting: true,
    buttons: ["keyboard", "expand", "close"],
  });
  assert.deepEqual(resolveAgentPillControls("modal", "waiting").buttons, ["keyboard", "close"]);
});

test("the pending card is the first open question or answer card on screen", async () => {
  const { findPendingCard } = await load();
  const call = (id, name) => ({ id, name, arguments: "{}", status: "executing" });
  const messages = [
    { id: "m1", toolCalls: [call("c1", "slack_send_message")] },
    { id: "m2", toolCalls: [call("c2", "search_notes"), call("c3", "ask_user")] },
  ];
  const questions = { kind: "questions", questions: [] };
  assert.equal(findPendingCard(messages, {}, {}), null);

  const interaction = { "m2::c3": { state: "pending", payload: questions } };
  assert.deepEqual(findPendingCard(messages, interaction, {}), {
    key: "m2::c3",
    id: "m2::c3:questions",
    messageId: "m2",
    toolCall: messages[1].toolCalls[1],
    interaction: "questions",
  });
  // An answer card waiting on Send, earlier in the chat, comes first.
  const approval = { "m1::c1": { state: "pending" } };
  assert.equal(findPendingCard(messages, interaction, approval).key, "m1::c1");
  assert.equal(findPendingCard(messages, interaction, approval).interaction, null);
  // An answer card is a card of its own, after a connect on the same call.
  const connect = { "m1::c1": { state: "settled", payload: { kind: "connection" } } };
  assert.equal(findPendingCard(messages, connect, approval).id, "m1::c1:approval");

  // A card restored from a turn that ended: nothing waits on it.
  const restored = { "m2::c3": { state: "pending", payload: questions, restored: true } };
  assert.equal(findPendingCard(messages, restored, {}), null);

  // Sending, sent, or failed with nothing waiting: not waiting on the user.
  for (const entry of [{ state: "committing" }, { state: "sent" }, { state: "failed" }]) {
    assert.equal(findPendingCard(messages, {}, { "m1::c1": entry }), null, entry.state);
  }
  assert.equal(
    findPendingCard(messages, {}, { "m1::c1": { state: "failed", awaitingRetry: true } }).key,
    "m1::c1"
  );
  assert.equal(
    findPendingCard(messages, { "m2::c3": { state: "settled", payload: questions } }, {}),
    null
  );
  // A card of another chat's message never counts.
  assert.equal(findPendingCard([], interaction, approval), null);
});

test("a skill proposal waits above the assistant pill and stops waiting after its Save", async () => {
  const { findPendingCard } = await load();
  const messages = [
    {
      id: "m1",
      toolCalls: [{ id: "c1", name: "propose_skill", arguments: "{}", status: "executing" }],
    },
  ];
  const skillApprovals = { "m1::c1": { state: "pending" } };
  assert.equal(findPendingCard(messages, {}, {}, { skillApprovals }).id, "m1::c1:skill");
  assert.equal(
    findPendingCard(messages, {}, {}, { skillApprovals: { "m1::c1": { state: "saved" } } }),
    null
  );
  assert.equal(findPendingCard([], {}, {}, { skillApprovals }), null);
});
