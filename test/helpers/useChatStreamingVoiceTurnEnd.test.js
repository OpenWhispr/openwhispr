const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const fs = require("node:fs");
const path = require("node:path");
const {
  createRendererServer,
  installBrowserGlobals,
  installHookDom,
} = require("../lib/rendererTestHarness");

// A voice turn ends when the voice tap hears the response is done. A failed
// request never said so, so the turn stayed open: nothing was spoken, the session
// never went back to listening and its idle stop never fired.

function makeVoiceTap({ dryRunWrites = false } = {}) {
  const heard = { responseDone: 0, writes: [] };
  return {
    heard,
    tap: {
      onContentDelta() {},
      onResponseDone: () => (heard.responseDone += 1),
      onToolCall() {},
      onToolsAvailable() {},
      onWriteToolResult: (name, ok) => heard.writes.push([name, ok]),
      dryRunWrites,
      brainOverride: null,
      cancelRef: { current: null },
    },
  };
}

async function mountChatStreaming(t, { settings, electronAPI = {} }) {
  let unmount;
  t.after(async () => {
    await unmount?.();
  });
  installBrowserGlobals(t, { window: { electronAPI } });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-voice-turn-end-test-",
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
  usePolicyStore.setState({ status: "unmanaged", appVersion: "1.8.3", policy: null });
  useSettingsStore.setState(settings);

  const { useChatStreaming } = await vite.ssrLoadModule("/components/chat/useChatStreaming.ts");
  const reasoningService = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
  t.after(() => reasoningService.destroy());

  let messages = [];
  const setMessages = (updater) => {
    messages = typeof updater === "function" ? updater(messages) : updater;
  };
  const completed = { count: 0 };
  let captured = null;
  function Harness() {
    captured = useChatStreaming({
      messages,
      setMessages,
      onStreamComplete: () => (completed.count += 1),
    });
    return null;
  }
  const { createRoot } = require("react-dom/client");
  const root = createRoot(container);
  await React.act(async () => root.render(React.createElement(Harness)));
  unmount = () => React.act(async () => root.unmount());

  return {
    hook: () => captured,
    messages: () => messages,
    reasoningService,
    usePolicyStore,
    useSettingsStore,
    completed,
  };
}

// Stands in for a real stream: `run` is where it would call tools or fail.
async function* streamAfter(run) {
  await run();
  yield { type: "content", text: "" };
}

const LOCAL_TOOL_MODEL = {
  chatAgentMode: "self-hosted",
  chatAgentProvider: "lan",
  chatAgentModel: "qwen3-4b-q4_k_m",
  chatAgentRemoteUrl: "http://127.0.0.1:11434/v1",
  chatAgentDisableThinking: true,
  isSignedIn: false,
};

test("a failed request ends the voice turn", async (t) => {
  const { hook, reasoningService, completed } = await mountChatStreaming(t, {
    settings: LOCAL_TOOL_MODEL,
  });
  t.mock.method(reasoningService, "processTextStreamingAI", () =>
    streamAfter(() => {
      throw new Error("llama-server failed to start");
    })
  );
  const { tap, heard } = makeVoiceTap();

  await React.act(async () => {
    await hook().sendToAI("what's on my calendar", [], { voiceTap: tap });
  });

  assert.equal(heard.responseDone, 1);
  assert.equal(completed.count, 0);
});

test("a request the org policy blocks ends the voice turn", async (t) => {
  const { hook, usePolicyStore } = await mountChatStreaming(t, { settings: LOCAL_TOOL_MODEL });
  usePolicyStore.setState({ status: "managed", policy: null });
  const { tap, heard } = makeVoiceTap();

  await React.act(async () => {
    await hook().sendToAI("what's on my calendar", [], { voiceTap: tap });
  });

  assert.equal(heard.responseDone, 1);
});

test("a cancelled request doesn't end the turn (barge-in already ended it)", async (t) => {
  const { hook, reasoningService } = await mountChatStreaming(t, { settings: LOCAL_TOOL_MODEL });
  t.mock.method(reasoningService, "processTextStreamingAI", () =>
    streamAfter(() => {
      hook().cancelStream();
      throw new Error("aborted");
    })
  );
  const { tap, heard } = makeVoiceTap();

  await React.act(async () => {
    await hook().sendToAI("what's on my calendar", [], { voiceTap: tap });
  });

  assert.equal(heard.responseDone, 0);
});

const CLOUD = { chatAgentMode: "openwhispr", chatAgentModel: "", isSignedIn: true };
const NOTE_ARGS = JSON.stringify({ title: "Dentist", content: "Call the dentist on Friday" });

test("harness dry-run writes change nothing on the OpenWhispr Cloud path either", async (t) => {
  const savedNotes = [];
  const { hook, reasoningService } = await mountChatStreaming(t, {
    settings: CLOUD,
    electronAPI: {
      saveNote: async (...args) => {
        savedNotes.push(args);
        return { success: true, note: { id: 1 } };
      },
    },
  });
  const toolResults = [];
  t.mock.method(reasoningService, "processTextStreamingCloud", (_messages, options) =>
    streamAfter(async () => {
      toolResults.push(await options.executeToolCall("create_note", NOTE_ARGS, "call-1"));
    })
  );

  await React.act(async () => {
    await hook().sendToAI("make a note to call the dentist", [], {
      voiceTap: makeVoiceTap({ dryRunWrites: true }).tap,
    });
  });

  assert.equal(toolResults.length, 1);
  assert.match(toolResults[0].data, /"dryRun":true/);
  assert.deepEqual(savedNotes, [], "the harness must not write the user's notes");
});

test("a repeat write the guard blocked tells the model and leaves no tool chip", async (t) => {
  const { hook, messages, reasoningService } = await mountChatStreaming(t, { settings: CLOUD });
  const toolResults = [];
  t.mock.method(reasoningService, "processTextStreamingCloud", async function* (_m, options) {
    for (const id of ["call-1", "call-2"]) {
      yield { type: "tool_calls", calls: [{ id, name: "create_note", arguments: NOTE_ARGS }] };
      const result = await options.executeToolCall("create_note", NOTE_ARGS, id);
      toolResults.push(result);
      yield { type: "tool_result", callId: id, displayText: result.displayText };
    }
  });

  await React.act(async () => {
    await hook().sendToAI("make two notes", [], {
      voiceTap: makeVoiceTap({ dryRunWrites: true }).tap,
    });
  });

  assert.match(toolResults[1].data, /NOT run/);
  const assistant = messages().find((message) => message.role === "assistant");
  assert.deepEqual(
    assistant.toolCalls.map((call) => call.id),
    ["call-1"]
  );
});

test("a write that settles after the request was cancelled isn't credited to any turn", async (t) => {
  const { hook, reasoningService } = await mountChatStreaming(t, {
    settings: CLOUD,
    electronAPI: {
      saveNote: async () => {
        // The user barges in while the note is being written.
        hook().cancelStream();
        return { success: true, note: { id: 1, title: "Dentist" } };
      },
    },
  });
  t.mock.method(reasoningService, "processTextStreamingCloud", (_messages, options) =>
    streamAfter(() => options.executeToolCall("create_note", NOTE_ARGS, "call-1"))
  );
  const { tap, heard } = makeVoiceTap();

  await React.act(async () => {
    await hook().sendToAI("make a note to call the dentist", [], { voiceTap: tap });
  });

  assert.deepEqual(heard.writes, []);
});

test("chunks that arrive after a barge-in cancelled the answer aren't spoken", async (t) => {
  const { hook, reasoningService } = await mountChatStreaming(t, { settings: LOCAL_TOOL_MODEL });
  t.mock.method(reasoningService, "processTextStreamingAI", async function* () {
    yield { type: "content", text: "It's sunny" };
    hook().cancelStream();
    yield { type: "content", text: " and warm." };
  });
  const spoken = [];
  const { tap } = makeVoiceTap();
  tap.onContentDelta = (delta) => spoken.push(delta);

  await React.act(async () => {
    await hook().sendToAI("what's the weather", [], { voiceTap: tap });
  });

  assert.deepEqual(spoken, ["It's sunny"]);
});

test("only a local model's voice turn is capped, and loosely enough for a dictated note", async (t) => {
  const { hook, reasoningService, useSettingsStore } = await mountChatStreaming(t, {
    settings: LOCAL_TOOL_MODEL,
  });
  const caps = [];
  t.mock.method(
    reasoningService,
    "processTextStreamingAI",
    (_messages, _model, _provider, opts) => {
      caps.push(opts.maxTokens);
      return streamAfter(() => {});
    }
  );
  const send = (options) =>
    React.act(async () => {
      await hook().sendToAI("take a note", [], options);
    });

  await send({ voiceTap: makeVoiceTap().tap });
  await send(undefined);
  useSettingsStore.setState({
    chatAgentMode: "providers",
    chatAgentProvider: "openai",
    chatAgentModel: "gpt-5-mini",
  });
  await send({ voiceTap: makeVoiceTap().tap });

  // Local voice turn; typed chat is never capped; a BYOK model may spend tokens thinking.
  assert.deepEqual(caps, [1024, undefined, undefined]);
});

test("on a local model a repeated write runs once, tells the model it didn't run, and leaves one chip", async (t) => {
  const savedNotes = [];
  const { hook, messages, reasoningService } = await mountChatStreaming(t, {
    settings: LOCAL_TOOL_MODEL,
    electronAPI: {
      saveNote: async (title) => {
        savedNotes.push(title);
        return { success: true, note: { id: savedNotes.length, title } };
      },
    },
  });
  const toolResults = [];
  t.mock.method(
    reasoningService,
    "processTextStreamingAI",
    async function* (_messages, _model, _provider, _options, tools) {
      for (const id of ["call-1", "call-2"]) {
        const args = { title: "Dentist", content: "Call the dentist on Friday" };
        yield {
          type: "tool_calls",
          calls: [{ id, name: "create_note", arguments: JSON.stringify(args) }],
        };
        const result = await tools.create_note.execute(args, { toolCallId: id, messages: [] });
        toolResults.push(result);
        yield { type: "tool_result", callId: id, displayText: "Done" };
      }
    }
  );
  const { tap, heard } = makeVoiceTap();

  await React.act(async () => {
    await hook().sendToAI("make a note to call the dentist", [], { voiceTap: tap });
  });

  assert.deepEqual(savedNotes, ["Dentist"], "the note is written once");
  assert.match(toolResults[1].note, /NOT run/);
  assert.deepEqual(heard.writes, [["create_note", true]]);
  const assistant = messages().find((message) => message.role === "assistant");
  assert.deepEqual(
    assistant.toolCalls.map((call) => call.id),
    ["call-1"]
  );
});
