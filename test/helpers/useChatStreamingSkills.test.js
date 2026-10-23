const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const {
  SIGNED_OUT_AUTH_MOCK,
  addTeardown,
  createRendererServer,
  installBrowserGlobals,
} = require("../lib/rendererTestHarness");

const summary = (name, displayName, description, extra = {}) => ({
  name,
  displayName,
  description,
  enabled: true,
  valid: true,
  addedAt: "2026-10-01T09:00:00.000Z",
  updatedAt: "2026-10-01T09:00:00.000Z",
  lastUsedAt: null,
  ...extra,
});

const SKILLS = [
  summary("meeting-prep", "Meeting prep", "Briefs me before meetings."),
  summary("weekly-recap", "Weekly recap", "Recaps my week on Fridays."),
];

const forModel = (name, displayName, body, files = []) => ({ name, displayName, body, files });
const READABLE = {
  "meeting-prep": forModel("meeting-prep", "Meeting prep", "Steps for meeting prep.\n"),
  "weekly-recap": forModel("weekly-recap", "Weekly recap", "Steps for the recap.\n"),
  "builtin:skill-creator": forModel("skill-creator", "Skill creator", "# Skill creator\nAsk.\n"),
};

const MEETING_PREP_BLOCK =
  '<skill_content name="meeting-prep" title="Meeting prep">\nSteps for meeting prep.\n' +
  "</skill_content>";

// The library as main serves it: the list, and a read that names only switched-on skills.
function skillsApi({ skills = SKILLS, readable = READABLE } = {}) {
  const calls = { list: 0, reads: [] };
  return {
    calls,
    api: {
      skillsList: async () => {
        calls.list += 1;
        return { skills };
      },
      skillsReadForModel: async (ref) => {
        calls.reads.push(ref);
        return readable[ref.builtin ? `builtin:${ref.name}` : ref.name] ?? null;
      },
      skillsMarkUsed: async () => {},
    },
  };
}

// Drives the real useChatStreaming hook (one synchronous render, then its sendToAI
// closure), with the stream stubbed so the test can read what each send hands the model.
// With `sender`, useChatMessageSender sits in front of it, as in the chat view.
async function renderChat(t, hookOptions = {}, { settings = {}, electronAPI = {} } = {}) {
  installBrowserGlobals(t, {
    initialStorage: { isSubscribed: "true" },
    window: { electronAPI },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-chat-streaming-skills-test-",
    mockModules: SIGNED_OUT_AUTH_MOCK,
  });
  const [{ default: viteI18next }, { initReactI18next }] = await Promise.all([
    vite.ssrLoadModule("i18next"),
    vite.ssrLoadModule("react-i18next"),
  ]);
  if (!viteI18next.isInitialized) {
    const translation = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../src/locales/en/translation.json"), "utf8")
    );
    await viteI18next.use(initReactI18next).init({
      lng: "en",
      resources: { en: { translation } },
      interpolation: { escapeValue: false },
    });
  }

  const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
  const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.10.0", policy: null });
  useSettingsStore.setState({ chatAgentMode: "openwhispr", isSignedIn: true, ...settings });

  const { useChatStreaming } = await vite.ssrLoadModule("/components/chat/useChatStreaming.ts");
  const { useChatMessageSender } = await vite.ssrLoadModule(
    "/components/chat/useChatMessageSender.ts"
  );
  await (await vite.ssrLoadModule("/i18n.ts")).default.changeLanguage("en");
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  addTeardown(t, () => reasoningService.destroy());

  const offeredTools = [];
  const toolDefinitions = [];
  const sentMessages = [];
  const endStream = async function* () {
    yield { type: "done", finishReason: "stop" };
  };
  t.mock.method(reasoningService, "processTextStreamingCloud", (messages, config) => {
    sentMessages.push(messages);
    offeredTools.push((config.tools ?? []).map((tool) => tool.name));
    toolDefinitions.push(config.tools ?? []);
    return endStream();
  });
  t.mock.method(
    reasoningService,
    "processTextStreamingAI",
    (messages, _model, _provider, _config, tools) => {
      sentMessages.push(messages);
      offeredTools.push(Object.keys(tools ?? {}));
      return endStream();
    }
  );

  let messages = [];
  const setMessages = (updater) => {
    messages = typeof updater === "function" ? updater(messages) : updater;
  };
  const saved = [];
  const persistence = {
    get messages() {
      return messages;
    },
    setMessages,
    saveUserMessage: async (text) => saved.push(text),
    getSessionVersion: () => 1,
  };
  let captured = null;
  let send = null;
  function Harness() {
    captured = useChatStreaming({ messages, setMessages, ...hookOptions });
    send = useChatMessageSender({
      conversationId: 1,
      persistence,
      streaming: captured,
      createConversation: async () => 1,
    });
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));
  return {
    captured,
    send,
    saved,
    offeredTools,
    toolDefinitions,
    sentMessages,
    reasoningService,
    getMessages: () => messages,
    vite,
  };
}

const SKILLS_ON = { skillsEnabled: true };
const MEETING_PREP = { attachedSkill: { name: "meeting-prep" } };
const BYOK = {
  chatAgentMode: "providers",
  chatAgentProvider: "openai",
  chatAgentModel: "gpt-5-mini",
};
const LOCAL_SMALL = {
  chatAgentMode: "local",
  chatAgentProvider: "qwen",
  chatAgentModel: "qwen3-1.7b-q4_k_m",
};

const userMessage = (id, content) => ({ id, role: "user", content, isStreaming: false });
const assistantMessage = (id, content) => ({ id, role: "assistant", content, isStreaming: false });
const userTurns = (sent) => sent.filter((message) => message.role === "user");
const latestUserText = (sent) => userTurns(sent).at(-1).content;
const withRequest = (block, request) => `${block}\n\nUser request:\n${request}`;

test("the saved user message is exactly what was typed", async (t) => {
  const { api } = skillsApi();
  const { send, saved, sentMessages, getMessages } = await renderChat(t, SKILLS_ON, {
    electronAPI: api,
  });

  await send("prep me for my 2pm", MEETING_PREP);

  assert.deepEqual(saved, ["prep me for my 2pm"]);
  assert.equal(getMessages()[0].content, "prep me for my 2pm");
  assert.equal(
    latestUserText(sentMessages[0]),
    withRequest(MEETING_PREP_BLOCK, "prep me for my 2pm")
  );
});

test("the skill block rides only in the latest user turn sent to the model", async (t) => {
  const { api } = skillsApi();
  const { captured, sentMessages } = await renderChat(t, SKILLS_ON, { electronAPI: api });
  const history = [
    userMessage("u1", "Hi"),
    assistantMessage("a1", "Hello! What can I do?"),
    userMessage("u2", "prep me"),
  ];

  await captured.sendToAI("prep me", history, MEETING_PREP);

  const [system, ...turns] = sentMessages[0];
  assert.doesNotMatch(system.content, /<skill_content name=|Steps for meeting prep/);
  assert.deepEqual(
    turns.map((turn) => turn.content),
    ["Hi", "Hello! What can I do?", withRequest(MEETING_PREP_BLOCK, "prep me")]
  );
});

test("an earlier turn's skill block is not replayed", async (t) => {
  const { api } = skillsApi();
  const { captured, sentMessages } = await renderChat(t, SKILLS_ON, { electronAPI: api });
  const first = [userMessage("u1", "prep me")];
  await captured.sendToAI("prep me", first, MEETING_PREP);

  const second = [...first, assistantMessage("a1", "Done."), userMessage("u2", "and the agenda?")];
  await captured.sendToAI("and the agenda?", second, MEETING_PREP);

  assert.deepEqual(
    userTurns(sentMessages[1]).map((turn) => turn.content),
    ["prep me", withRequest(MEETING_PREP_BLOCK, "and the agenda?")]
  );
});

for (const [mode, settings] of Object.entries({ cloud: {}, byok: BYOK, local: LOCAL_SMALL })) {
  test(`an attached skill is sent on the ${mode} path`, async (t) => {
    const { api, calls } = skillsApi();
    const { captured, sentMessages, reasoningService } = await renderChat(t, SKILLS_ON, {
      settings,
      electronAPI: api,
    });

    await captured.sendToAI("prep me", [userMessage("u1", "prep me")], MEETING_PREP);

    const stream =
      mode === "cloud"
        ? reasoningService.processTextStreamingCloud
        : reasoningService.processTextStreamingAI;
    assert.equal(stream.mock.callCount(), 1);
    assert.equal(latestUserText(sentMessages[0]), withRequest(MEETING_PREP_BLOCK, "prep me"));
    // A model without tools can't ask for a file, so its files come with the skill.
    assert.deepEqual(calls.reads, [{ name: "meeting-prep", withFiles: mode === "local" }]);
  });
}

test("an attached skill on a local model is cut to 2,500 tokens, files first", async (t) => {
  const { estimateNoteTokens } = await import("../../src/helpers/noteChunking.js");
  const body = Array.from({ length: 150 }, (_, index) => `Step ${index + 1}: check it.`).join("\n");
  const file = (filePath, content) => ({
    path: filePath,
    size: content.length,
    text: true,
    script: false,
    content,
  });
  const { api } = skillsApi({
    readable: {
      "meeting-prep": forModel("meeting-prep", "Meeting prep", body, [
        file("references/a.md", "A".repeat(3_000)),
        file("references/b.md", "B".repeat(9_000)),
      ]),
    },
  });
  const { captured, sentMessages } = await renderChat(t, SKILLS_ON, {
    settings: LOCAL_SMALL,
    electronAPI: api,
  });

  await captured.sendToAI("prep me", [userMessage("u1", "prep me")], MEETING_PREP);

  const [block] = latestUserText(sentMessages[0]).split("\n\nUser request:\n");
  assert.ok(estimateNoteTokens(block) <= 2_500, String(estimateNoteTokens(block)));
  assert.ok(block.includes(`${body}\n<skill_file path="references/a.md">`), "the body is whole");
  assert.ok(block.includes("[Left out to fit: references/b.md]"));
});

test("with skills off, nothing changes", async (t) => {
  const { api, calls } = skillsApi();
  const history = [userMessage("u1", "prep me")];
  const off = await renderChat(t, {}, { electronAPI: api });
  await off.captured.sendToAI("prep me", history, MEETING_PREP);
  const today = await renderChat(t, {}, { electronAPI: {} });
  await today.captured.sendToAI("prep me", history);

  assert.deepEqual(off.sentMessages, today.sentMessages);
  assert.deepEqual(off.offeredTools, today.offeredTools);
  assert.deepEqual(calls, { list: 0, reads: [] });
});

test("a request text or selection and an attached skill compose in that order", async (t) => {
  const { api } = skillsApi();
  const { captured, sentMessages, vite } = await renderChat(t, SKILLS_ON, { electronAPI: api });
  const { buildAgentRequestText } = await vite.ssrLoadModule("/utils/agentSelectionContext.ts");
  const selectedContext = { text: "The long paragraph.", sourceMessageId: "a1" };

  await captured.sendToAI("Summary", [userMessage("u1", "Summary")], {
    ...MEETING_PREP,
    requestText: "Summarize the open note.",
  });
  await captured.sendToAI("shorter", [userMessage("u1", "shorter")], {
    ...MEETING_PREP,
    selectedContext,
  });

  assert.equal(
    latestUserText(sentMessages[0]),
    withRequest(MEETING_PREP_BLOCK, "Summarize the open note.")
  );
  assert.equal(
    latestUserText(sentMessages[1]),
    withRequest(MEETING_PREP_BLOCK, buildAgentRequestText("shorter", selectedContext))
  );
});

// The chat shows the creator's opening question before the user's first message.
const OPENING =
  'The chat opened by asking the user: "What do you do over and over? ' +
  'Talk me through the last time, or pick a note to start from."';

test("the attached creator learns the user's skills, connected apps and tool use", async (t) => {
  const creator = { attachedSkill: { name: "skill-creator", builtin: true } };
  const cloud = skillsApi();
  const tools = await renderChat(
    t,
    { ...SKILLS_ON, allowConnectors: true },
    {
      electronAPI: cloud.api,
    }
  );
  const { useConnectorStatusStore } = await tools.vite.ssrLoadModule(
    "/stores/connectorStatusStore.ts"
  );
  useConnectorStatusStore.setState({
    statuses: { slack: { id: "slack", connected: true }, linear: { id: "linear" } },
    loaded: true,
  });
  await tools.captured.sendToAI("Make a skill", [userMessage("u1", "Make a skill")], creator);

  const block = latestUserText(tools.sentMessages[0]).split("\n\nUser request:\n")[0];
  assert.ok(block.startsWith('<skill_content name="skill-creator" title="Skill creator">\n'));
  assert.ok(
    block.endsWith(
      `</skill_content>\n${OPENING}\nThe user's skills (name: when to use it):\n` +
        "<skill_catalog>\n- meeting-prep: Briefs me before meetings.\n" +
        "- weekly-recap: Recaps my week on Fridays.\n</skill_catalog>\nConnected apps: Slack"
    ),
    block
  );
  assert.deepEqual(cloud.calls.reads, [{ name: "skill-creator", builtin: true, withFiles: false }]);

  // Connected but not usable here: a surface without connectors lists none.
  const local = skillsApi({ skills: [] });
  const noTools = await renderChat(t, SKILLS_ON, {
    settings: LOCAL_SMALL,
    electronAPI: local.api,
  });
  const localStatus = await noTools.vite.ssrLoadModule("/stores/connectorStatusStore.ts");
  localStatus.useConnectorStatusStore.setState({
    statuses: { slack: { id: "slack", connected: true } },
    loaded: true,
  });
  await noTools.captured.sendToAI("Make a skill", [userMessage("u1", "Make a skill")], creator);
  assert.ok(
    latestUserText(noTools.sentMessages[0]).includes(
      `</skill_content>\n${OPENING}\nThe user has no skills yet.\nConnected apps: none\n` +
        "This model can't call tools.\n\nUser request:\nMake a skill"
    )
  );
});

// ---- Picking a skill from its description (load_skill) ----

const LOCAL_LARGE = { ...LOCAL_SMALL, chatAgentModel: "qwen3-8b-q4_k_m" };
const systemPromptOf = (sent) => sent.find((message) => message.role === "system").content;
const CATALOG_INTRO =
  "The user's skills (name: when to use it). Check this list before you answer and before " +
  "you ask the user a follow-up question: when a request fits a skill, call load_skill with " +
  "its name first, then follow it, since the skill may say how to settle what the request " +
  "leaves open. Load only the skills the request needs.";
const catalogOf = (sent) => {
  const prompt = systemPromptOf(sent);
  const start = prompt.indexOf(`${CATALOG_INTRO}\n`);
  if (start < 0) return null;
  const rest = prompt.slice(start + CATALOG_INTRO.length + 1);
  const fenced = rest.slice(0, rest.indexOf("\n\n"));
  assert.match(fenced, /^<skill_catalog>\n[\s\S]*\n<\/skill_catalog>$/);
  return fenced.slice("<skill_catalog>\n".length, -"\n</skill_catalog>".length);
};
const loadSkillEnum = (definitions) =>
  definitions.find((tool) => tool.name === "load_skill")?.parameters.properties.name.enum;
const loadedEarlier = (name) => ({
  id: "a1",
  role: "assistant",
  content: "Here is your prep.",
  isStreaming: false,
  toolCalls: [
    {
      id: "c1",
      name: "load_skill",
      arguments: JSON.stringify({ name }),
      status: "completed",
      result: "Meeting prep",
    },
  ],
});

test("a matching request on a tool-capable model offers load_skill and the catalog", async (t) => {
  const { api, calls } = skillsApi();
  const { captured, sentMessages, offeredTools } = await renderChat(t, SKILLS_ON, {
    electronAPI: api,
  });

  await captured.sendToAI("prep me for my 2pm", [userMessage("u1", "prep me for my 2pm")]);

  assert.ok(offeredTools[0].includes("load_skill"));
  assert.equal(
    catalogOf(sentMessages[0]),
    "- meeting-prep: Briefs me before meetings.\n- weekly-recap: Recaps my week on Fridays."
  );
  assert.match(systemPromptOf(sentMessages[0]), /Skills are instructions the user saved/);
  assert.equal(latestUserText(sentMessages[0]), "prep me for my 2pm");
  assert.deepEqual(calls.reads, []);
});

test("load_skill's enum lists only enabled, valid skills", async (t) => {
  const skills = [
    SKILLS[0],
    { ...SKILLS[1], enabled: false },
    summary("broken", "Broken", "", { valid: false, problem: { code: "missingDescription" } }),
  ];
  const { api } = skillsApi({ skills });
  const { captured, toolDefinitions } = await renderChat(t, SKILLS_ON, { electronAPI: api });

  await captured.sendToAI("prep me", [userMessage("u1", "prep me")]);

  assert.deepEqual(loadSkillEnum(toolDefinitions[0]), ["meeting-prep"]);
});

test("an invalid skill is left out of the catalog and the load_skill enum", async (t) => {
  const broken = summary("broken-prep", "Broken prep", "Preps meetings, badly.", {
    valid: false,
    problem: { code: "nameMismatch" },
  });
  const { api } = skillsApi({ skills: [broken, SKILLS[0]] });
  const { captured, sentMessages, toolDefinitions } = await renderChat(t, SKILLS_ON, {
    electronAPI: api,
  });

  await captured.sendToAI("prep me", [userMessage("u1", "prep me")]);

  assert.equal(catalogOf(sentMessages[0]), "- meeting-prep: Briefs me before meetings.");
  assert.deepEqual(loadSkillEnum(toolDefinitions[0]), ["meeting-prep"]);
});

test("a skill loaded in an earlier turn is re-sent in the next turn's model-only text", async (t) => {
  const { api, calls } = skillsApi();
  const { captured, sentMessages } = await renderChat(t, SKILLS_ON, { electronAPI: api });
  const history = [
    userMessage("u1", "prep me"),
    loadedEarlier("meeting-prep"),
    userMessage("u2", "and the agenda?"),
  ];

  await captured.sendToAI("and the agenda?", history);

  assert.equal(latestUserText(sentMessages[0]), withRequest(MEETING_PREP_BLOCK, "and the agenda?"));
  assert.equal(userTurns(sentMessages[0])[0].content, "prep me");
  assert.deepEqual(calls.reads, [{ name: "meeting-prep", withFiles: false }]);
});

test("a skill the user took off the chat isn't re-sent, though the model loaded it", async (t) => {
  const { api, calls } = skillsApi();
  const { captured, sentMessages } = await renderChat(t, SKILLS_ON, { electronAPI: api });
  const history = [
    userMessage("u1", "prep me"),
    loadedEarlier("meeting-prep"),
    userMessage("u2", "what's the capital of France?"),
  ];

  await captured.sendToAI("what's the capital of France?", history, {
    removedSkills: ["meeting-prep"],
  });

  assert.equal(latestUserText(sentMessages[0]), "what's the capital of France?");
  assert.deepEqual(calls.reads, []);
});

test("a skill read that fails sends the turn without that skill", async (t) => {
  const { api } = skillsApi();
  api.skillsReadForModel = async () => {
    throw new Error("EACCES: permission denied");
  };
  const { captured, sentMessages } = await renderChat(t, SKILLS_ON, { electronAPI: api });

  await captured.sendToAI("prep me", [userMessage("u1", "prep me")], {
    attachedSkill: { name: "meeting-prep" },
  });

  assert.equal(latestUserText(sentMessages[0]), "prep me");
});

test("switching a skill off mid-conversation stops re-sending it", async (t) => {
  const { api, calls } = skillsApi({ skills: [{ ...SKILLS[0], enabled: false }, SKILLS[1]] });
  const { captured, sentMessages, toolDefinitions } = await renderChat(t, SKILLS_ON, {
    electronAPI: api,
  });
  const history = [
    userMessage("u1", "prep me"),
    loadedEarlier("meeting-prep"),
    userMessage("u2", "and the agenda?"),
  ];

  await captured.sendToAI("and the agenda?", history);

  assert.equal(latestUserText(sentMessages[0]), "and the agenda?");
  assert.deepEqual(calls.reads, []);
  assert.deepEqual(loadSkillEnum(toolDefinitions[0]), ["weekly-recap"]);
});

test("the cached load_skill knows which skills each send already carries", async (t) => {
  const { api, calls } = skillsApi();
  const { captured, reasoningService } = await renderChat(t, SKILLS_ON, { electronAPI: api });
  const results = [];
  reasoningService.processTextStreamingCloud.mock.mockImplementation(async function* (_m, c) {
    results.push(await c.executeToolCall("load_skill", '{"name":"meeting-prep"}', "call-1"));
    yield { type: "done", finishReason: "stop" };
  });

  await captured.sendToAI("prep me", [userMessage("u1", "prep me")]);
  const history = [userMessage("u1", "prep me"), loadedEarlier("meeting-prep")];
  await captured.sendToAI("more", [...history, userMessage("u2", "more")]);

  assert.equal(results[0].displayText, "Meeting prep");
  assert.match(results[0].data, /^<skill_content name="meeting-prep"/);
  assert.equal(
    results[1].data,
    "The meeting-prep skill is already loaded in this conversation. Follow it as given."
  );
  assert.deepEqual(calls.reads, [
    { name: "meeting-prep" },
    { name: "meeting-prep", withFiles: false },
  ]);
});

test("a load_skill that fails is marked failed, and its step keeps the mark", async (t) => {
  const { api } = skillsApi();
  const { captured, reasoningService, getMessages } = await renderChat(t, SKILLS_ON, {
    electronAPI: api,
  });
  const results = [];
  reasoningService.processTextStreamingCloud.mock.mockImplementation(async function* (_m, c) {
    const calls = [
      { id: "call-1", name: "load_skill", arguments: '{"name":"meeting-prep"}' },
      { id: "call-2", name: "load_skill", arguments: '{"name":"meeting-perp"}' },
    ];
    yield { type: "tool_calls", calls };
    for (const call of calls) {
      const result = await c.executeToolCall(call.name, call.arguments, call.id);
      results.push(result);
      // What ReasoningService yields for the executor's result.
      yield {
        type: "tool_result",
        callId: call.id,
        toolName: call.name,
        displayText: result.displayText,
        ...(result.failed ? { failed: true } : {}),
      };
    }
    yield { type: "done", finishReason: "stop" };
  });

  await captured.sendToAI("prep me", [userMessage("u1", "prep me")]);

  assert.deepEqual(
    results.map((result) => [result.displayText, result.failed]),
    [
      ["Meeting prep", undefined],
      ['No skill named "meeting-perp"', true],
    ]
  );
  const steps = getMessages().find((message) => message.role === "assistant").toolCalls;
  assert.deepEqual(
    steps.map((step) => [step.status, step.result, step.failed]),
    [
      ["completed", "Meeting prep", undefined],
      ["completed", 'No skill named "meeting-perp"', true],
    ]
  );
});

test("a skill cut to fit is left to load_skill, not marked loaded", async (t) => {
  // About 5 tokens a line: Meeting prep takes most of the 16,000, and Weekly recap can't fit.
  const lines = (count, word) =>
    Array.from({ length: count }, (_, index) => `${word} step ${index + 1} done.`).join("\n");
  const readable = {
    ...READABLE,
    "meeting-prep": forModel("meeting-prep", "Meeting prep", lines(2_900, "Prep")),
    "weekly-recap": forModel("weekly-recap", "Weekly recap", lines(400, "Recap")),
  };
  const { api } = skillsApi({ readable });
  const { captured, sentMessages, reasoningService } = await renderChat(t, SKILLS_ON, {
    electronAPI: api,
  });
  const results = [];
  reasoningService.processTextStreamingCloud.mock.mockImplementation(async function* (m, c) {
    sentMessages.push(m);
    results.push(await c.executeToolCall("load_skill", '{"name":"weekly-recap"}', "call-9"));
    yield { type: "done", finishReason: "stop" };
  });
  const recapEarlier = { ...loadedEarlier("weekly-recap"), id: "a0" };
  const history = [
    userMessage("u1", "recap"),
    recapEarlier,
    userMessage("u2", "prep me"),
    loadedEarlier("meeting-prep"),
    userMessage("u3", "both please"),
  ];

  await captured.sendToAI("both please", history);

  const sent = latestUserText(sentMessages[0]);
  assert.match(sent, /<skill_content name="meeting-prep"/);
  assert.doesNotMatch(sent, /<skill_content name="weekly-recap"/, "no partial block");
  assert.match(results[0].data, /^<skill_content name="weekly-recap"/);
});

test("a first skill cut to fit is still sent, and load_skill can give it whole", async (t) => {
  const steps = Array.from({ length: 4_000 }, (_, index) => `Prep step ${index + 1} done.`);
  const long = forModel("meeting-prep", "Meeting prep", steps.join("\n"));
  const readable = { ...READABLE, "meeting-prep": long };
  const { api } = skillsApi({ readable });
  const { captured, sentMessages, reasoningService } = await renderChat(t, SKILLS_ON, {
    electronAPI: api,
  });
  const results = [];
  reasoningService.processTextStreamingCloud.mock.mockImplementation(async function* (m, c) {
    sentMessages.push(m);
    results.push(await c.executeToolCall("load_skill", '{"name":"meeting-prep"}', "call-8"));
    yield { type: "done", finishReason: "stop" };
  });

  await captured.sendToAI("prep me", [userMessage("u1", "prep me")], {
    attachedSkill: { name: "meeting-prep" },
  });

  assert.match(latestUserText(sentMessages[0]), /The rest of this skill was cut to fit/);
  assert.match(results[0].data, /^<skill_content name="meeting-prep"/, "not 'already loaded'");
});

test("a local model above the 4B gate gets a 330-token catalog", async (t) => {
  const { estimateNoteTokens } = await import("../../src/helpers/noteChunking.js");
  const skills = Array.from({ length: 30 }, (_, index) =>
    summary(`skill-${index + 1}`, `Skill ${index + 1}`, `Handles task number ${index + 1} well.`)
  );
  const { api } = skillsApi({ skills });
  const { sentMessages, offeredTools, captured } = await renderChat(t, SKILLS_ON, {
    settings: LOCAL_LARGE,
    electronAPI: api,
  });

  await captured.sendToAI("help", [userMessage("u1", "help")]);

  const catalog = catalogOf(sentMessages[0]);
  assert.ok(offeredTools[0].includes("load_skill"));
  assert.ok(estimateNoteTokens(catalog) <= 330, String(estimateNoteTokens(catalog)));
  for (const skill of skills) assert.match(catalog, new RegExp(`^- ${skill.name}(:|$)`, "m"));
  assert.match(catalog, /^- skill-1: Handles task number 1 well\.$/m);
});

// ---- One skill picked by the app for a model without tools ----

const PREP_REQUEST = "prep me for my 2pm meeting";

async function sendPicking(t, { skills, settings = LOCAL_SMALL, readable, options = {} } = {}) {
  const { api, calls } = skillsApi({ skills, readable });
  const chat = await renderChat(t, SKILLS_ON, { settings, electronAPI: api });
  const picked = [];
  await chat.captured.sendToAI(PREP_REQUEST, [userMessage("u1", PREP_REQUEST)], {
    onSkillPicked: (skill) => picked.push(skill),
    ...options,
  });
  return { ...chat, calls, picked };
}

test("a sub-4B local model gets one picked skill and the surface hears which", async (t) => {
  const { sentMessages, calls, picked } = await sendPicking(t);

  assert.equal(latestUserText(sentMessages[0]), withRequest(MEETING_PREP_BLOCK, PREP_REQUEST));
  assert.deepEqual(picked, [{ name: "meeting-prep", displayName: "Meeting prep" }]);
  assert.deepEqual(calls.reads, [{ name: "meeting-prep", withFiles: true }]);
});

test("the app never picks a skill the user took off the chat", async (t) => {
  const { sentMessages, picked } = await sendPicking(t, {
    options: { removedSkills: ["meeting-prep"] },
  });

  assert.equal(latestUserText(sentMessages[0]), PREP_REQUEST);
  assert.deepEqual(picked, []);
});

test("a picked skill never adds more than 2,500 estimated tokens", async (t) => {
  const { estimateNoteTokens } = await import("../../src/helpers/noteChunking.js");
  const body = Array.from({ length: 2_000 }, (_, index) => `Step ${index + 1}: check it.`);
  const readable = {
    "meeting-prep": forModel("meeting-prep", "Meeting prep", body.join("\n")),
  };

  const { sentMessages } = await sendPicking(t, { readable });

  const [block] = latestUserText(sentMessages[0]).split("\n\nUser request:\n");
  assert.ok(estimateNoteTokens(block) <= 2_500, String(estimateNoteTokens(block)));
  assert.ok(block.includes("[The rest of this skill was cut to fit.]"));
});

test("the local pick never picks a disabled skill", async (t) => {
  const skills = [{ ...SKILLS[0], enabled: false }, SKILLS[1]];

  const { sentMessages, calls, picked } = await sendPicking(t, { skills });

  assert.equal(latestUserText(sentMessages[0]), PREP_REQUEST);
  assert.deepEqual([calls.reads, picked], [[], []]);
});

test("an attached skill turns the pick off", async (t) => {
  const options = { attachedSkill: { name: "weekly-recap" } };

  const { sentMessages, calls, picked } = await sendPicking(t, { options });

  assert.match(latestUserText(sentMessages[0]), /^<skill_content name="weekly-recap"/);
  assert.deepEqual(calls.reads, [{ name: "weekly-recap", withFiles: true }]);
  assert.deepEqual(picked, []);
});

test("allowSkillPick false picks nothing", async (t) => {
  const { sentMessages, calls, picked } = await sendPicking(t, {
    options: { allowSkillPick: false },
  });

  assert.equal(latestUserText(sentMessages[0]), PREP_REQUEST);
  assert.deepEqual([calls.reads, picked], [[], []]);
});

test("an unparsed model id counts as no tools and picks", async (t) => {
  const settings = {
    chatAgentMode: "local",
    chatAgentProvider: "gemma",
    chatAgentModel: "gemma-4-e2b-it-q4_k_m",
  };

  const { sentMessages, offeredTools, picked } = await sendPicking(t, { settings });

  assert.deepEqual(offeredTools[0], []);
  assert.equal(latestUserText(sentMessages[0]), withRequest(MEETING_PREP_BLOCK, PREP_REQUEST));
  assert.deepEqual(picked, [{ name: "meeting-prep", displayName: "Meeting prep" }]);
});
