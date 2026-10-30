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
