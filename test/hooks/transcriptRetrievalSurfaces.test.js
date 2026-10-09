const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const {
  createRendererServer,
  installBrowserGlobals,
  SIGNED_OUT_AUTH_MOCK,
} = require("../lib/rendererTestHarness");
const { installInteractiveDom } = require("../lib/interactiveDom");
const noop = () => {};
const TRANSCRIPT =
  "Alex: Review the agenda. ".repeat(3000) + "Priya: The launch code is violet heron.";
const REQUEST = "What is the launch code?";

for (const surface of ["note chat", "assistant panel"]) {
  for (const provider of ["cloud", "byok"]) {
    test(`${surface}, ${provider}: bounded evidence reaches the reply and survives conversation reopen`, async (t) => {
      let root;
      let reasoning;
      t.after(async () => {
        if (root) await React.act(async () => root.unmount());
        reasoning?.destroy();
      });
      const stored = {
        id: 7,
        title: "Launch",
        content: "Bring a notebook.",
        enhanced_content: "Discussed the agenda.",
        transcript: TRANSCRIPT,
        space_id: 1,
      };
      const savedMessages = [];
      installBrowserGlobals(t, {
        initialStorage: { isSubscribed: "false" },
        window: {
          clearInterval: noop,
          electronAPI: {
            getNote: async () => ({ ...stored }),
            semanticSearchNotes: async () => [],
            getConversationsForNote: async () => [],
            createAgentConversation: async () => ({ id: 1 }),
            getAgentConversation: async () => ({
              id: 1,
              messages: savedMessages.map((m, id) => ({
                id,
                role: m[1],
                content: m[2],
                metadata: m[3],
              })),
            }),
            addAgentMessage: async (...args) => savedMessages.push(args),
          },
        },
      });
      const container = installInteractiveDom(t);
      const vite = await createRendererServer(t, {
        mockModules: {
          ...SIGNED_OUT_AUTH_MOCK,
          "/ui/useToast": `export function useToast() { return { toast() {} }; }`,
          "/chat/ChatInput": `export function ChatInput() { return null; }`,
        },
      });
      const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
      const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
      usePolicyStore.setState({ status: "unmanaged", policy: null });
      useSettingsStore.setState({
        isSignedIn: true,
        chatAgentMode: provider === "cloud" ? "openwhispr" : "providers",
        chatAgentProvider: "openai",
        chatAgentModel: "gpt-5-mini",
        dictationAgentMode: provider === "cloud" ? "openwhispr" : "providers",
        dictationAgentProvider: "openai",
        dictationAgentModel: "gpt-5-mini",
      });
      reasoning = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
      await (await vite.ssrLoadModule("/i18n.ts")).default.changeLanguage("en");
      let request;
      let actionRequest = false;
      const respond = (messages, config, execute) =>
        (async function* () {
          request = { messages, config };
          assert.equal(config.systemPrompt.includes(TRANSCRIPT), actionRequest);
          if (actionRequest) assert.ok(config.systemPrompt.includes('"summary":""'));
          if (surface === "note chat") {
            if (!actionRequest)
              assert.ok(config.systemPrompt.includes('"transcript_truncated":true'));
            assert.ok(config.systemPrompt.includes(stored.content));
            assert.ok(config.systemPrompt.includes(stored.enhanced_content));
          }
          const call = {
            id: "read",
            name: "get_note",
            arguments: JSON.stringify({ id: 7, transcript_query: "launch code" }),
          };
          yield { type: "tool_calls", calls: [call] };
          const result = await execute(call.name, JSON.parse(call.arguments));
          assert.match(result.transcript, /Priya: The launch code is violet heron/);
          assert.ok(result.transcript.length <= 500);
          yield {
            type: "tool_result",
            callId: call.id,
            toolName: call.name,
            displayText: "Retrieved transcript passage",
            metadata: result,
          };
          yield { type: "content", text: "Priya said the launch code is violet heron." };
          yield { type: "done", finishReason: "stop" };
        })();
      t.mock.method(reasoning, "processTextStreamingCloud", (messages, config) =>
        respond(messages, config, async (name, args) =>
          JSON.parse((await config.executeToolCall(name, JSON.stringify(args), name)).data)
        )
      );
      t.mock.method(
        reasoning,
        "processTextStreamingAI",
        (messages, _model, _provider, config, tools) =>
          respond(messages, config, (name, args) =>
            tools[name].execute(args, { toolCallId: name, messages: [] })
          )
      );
      let chat;
      let settled = false;
      const { useEmbeddedChat } = await vite.ssrLoadModule("/hooks/useEmbeddedChat.ts");
      const { AssistantPanel } = await vite.ssrLoadModule(
        "/components/dictation/AssistantPanel.tsx"
      );
      function Harness() {
        chat = useEmbeddedChat({
          noteId: 7,
          folderId: null,
          noteTitle: stored.title,
          noteContent: stored.content,
          noteSummary: stored.enhanced_content,
          noteTranscript: stored.transcript,
        });
        return null;
      }
      root = createRoot(container);
      await React.act(async () =>
        root.render(
          surface === "note chat"
            ? React.createElement(Harness)
            : React.createElement(AssistantPanel, {
                pendingCommand: {
                  id: 1,
                  text: REQUEST,
                  attachment: null,
                  selectedContext: null,
                  delivery: null,
                },
                initialConversationId: null,
                onCommandConsumed: noop,
                onCommandDiscarded: noop,
                onCommandSettled: () => {
                  settled = true;
                },
                onConversationIdChange: noop,
                onClose: noop,
                onBusyChange: noop,
                onResponseReadyChange: noop,
                onResponseContent: noop,
                onConversationReset: noop,
                onSelectionContextChange: noop,
                voiceState: "idle",
                thinking: false,
                open: true,
                footerPhase: "actions",
                horizontalDirection: "left",
              })
        )
      );
      if (surface === "note chat") await React.act(async () => chat.sendMessage(REQUEST));
      else {
        for (let i = 0; !settled && i < 100; i++)
          await React.act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
          });
        assert.equal(settled, true);
      }
      assert.equal(stored.transcript, TRANSCRIPT);
      assert.equal(request.messages.at(-1).content, REQUEST);
      assert.ok(savedMessages.some((m) => m[1] === "assistant" && m[2].includes("violet heron")));
      if (surface === "note chat") {
        await React.act(async () => chat.startNewChat());
        await React.act(async () => chat.switchConversation(1));
        assert.ok(
          chat.messages.some((m) => m.role === "assistant" && m.content.includes("violet heron"))
        );
        // A TL;DR/custom action still sees the whole source when no saved summary exists.
        actionRequest = true;
        stored.enhanced_content = "";
        await React.act(async () => root.render(React.createElement(Harness)));
        await React.act(async () => chat.startNewChat());
        await React.act(async () =>
          chat.sendMessage("Write TL;DR", {
            requestText: "Summarize this entire meeting, preserving owners and decisions.",
            keepNotesUnchanged: true,
          })
        );
        assert.ok(request.config.systemPrompt.includes(TRANSCRIPT));
      }
    });
  }
}

for (const boundary of ["note read"]) {
  test(`switching notes during ${boundary} drops cancelled transcript evidence before it reaches another note`, async (t) => {
    let root;
    let reasoning;
    t.after(async () => {
      if (root) await React.act(async () => root.unmount());
      reasoning?.destroy();
    });
    const notes = new Map(
      [7, 8].map((id) => [
        id,
        {
          id,
          title: `Note ${id}`,
          content: `Personal ${id}`,
          enhanced_content: "## Decisions Made\nKeep me",
          transcript: "Source",
        },
      ])
    );
    let releaseRead;
    let readStarted;
    const started = new Promise((resolve) => {
      readStarted = resolve;
    });
    const pause = async () => {
      readStarted();
      await new Promise((resolve) => {
        releaseRead = resolve;
      });
    };
    const writes = [];
    let requests = 0;
    const replies = [];
    installBrowserGlobals(t, {
      window: {
        electronAPI: {
          getConversationsForNote: async () => [],
          createAgentConversation: async () => {
            if (boundary === "conversation creation") await pause();
            return { id: 1 };
          },
          getAgentConversation: async () => {
            await pause();
            return { id: 99, messages: [{ role: "user", content: "Old conversation" }] };
          },
          addAgentMessage: async (_id, role, text) => {
            if (role === "assistant") replies.push(text);
          },
          getNote: async (id) => {
            if (boundary === "note read") await pause();
            return notes.get(id);
          },
          updateNote: async (id, updates) => {
            writes.push({ id, updates });
            Object.assign(notes.get(id), updates);
            return { success: true };
          },
        },
      },
    });
    const container = installInteractiveDom(t);
    const vite = await createRendererServer(t, { mockModules: SIGNED_OUT_AUTH_MOCK });
    const { useSettingsStore } = await vite.ssrLoadModule("/stores/settingsStore.ts");
    const { usePolicyStore } = await vite.ssrLoadModule("/stores/policyStore.ts");
    usePolicyStore.setState({ status: "unmanaged", policy: null });
    useSettingsStore.setState({ isSignedIn: true, chatAgentMode: "openwhispr" });
    reasoning = (await vite.ssrLoadModule("/services/ReasoningService.ts")).default;
    t.mock.method(reasoning, "processTextStreamingCloud", (_messages, config) =>
      (async function* () {
        requests += 1;
        await config.executeToolCall(
          "get_note",
          JSON.stringify({ id: 7, transcript_query: "Source" }),
          "read"
        );
        yield { type: "content", text: "Stale transcript answer." };
        yield { type: "done", finishReason: "stop" };
      })()
    );
    const { useEmbeddedChat } = await vite.ssrLoadModule("/hooks/useEmbeddedChat.ts");
    let chat;
    function Harness({ id }) {
      const note = notes.get(id);
      chat = useEmbeddedChat({
        noteId: id,
        folderId: null,
        noteTitle: note.title,
        noteContent: note.content,
        noteSummary: note.enhanced_content,
      });
      return null;
    }
    root = createRoot(container);
    await React.act(async () => root.render(React.createElement(Harness, { id: 7 })));
    let sending;
    await React.act(async () => {
      sending =
        boundary === "conversation load"
          ? chat.switchConversation(99)
          : chat.sendMessage("What did the source say?");
      await started;
    });
    await React.act(async () => root.render(React.createElement(Harness, { id: 8 })));
    // Returning to the original note must not revive its earlier submission.
    await React.act(async () => root.render(React.createElement(Harness, { id: 7 })));
    await React.act(async () => {
      releaseRead();
      await sending;
    });
    assert.equal(requests, boundary === "note read" ? 1 : 0);
    assert.deepEqual(writes, []);
    assert.deepEqual(replies, []);
    assert.deepEqual(chat.messages, []);
    assert.equal(chat.activeConversationId, null);
    for (const note of notes.values())
      assert.equal(note.enhanced_content, "## Decisions Made\nKeep me");
  });
}

test("models without retrieval tools retain the current note's full source context", async (t) => {
  installBrowserGlobals(t);
  let context;
  globalThis.__captureTranscriptContext = (value) => {
    context = value;
  };
  t.after(() => {
    delete globalThis.__captureTranscriptContext;
  });
  const vite = await createRendererServer(t, {
    mockModules: {
      "/chat/useChatStreaming": `export function useChatStreaming(options) {
      globalThis.__captureTranscriptContext(options.openNote);
      return { agentState: "idle", cancelStream() {}, sendToAI: async () => {} };
    }`,
    },
  });
  const { useEmbeddedChat } = await vite.ssrLoadModule("/hooks/useEmbeddedChat.ts");
  function Harness() {
    useEmbeddedChat({
      noteId: 7,
      folderId: null,
      noteTitle: "Launch",
      noteContent: "Personal",
      noteTranscript: TRANSCRIPT,
    });
    return null;
  }
  require("react-dom/server").renderToStaticMarkup(React.createElement(Harness));
  assert.ok(context(false).includes(TRANSCRIPT));
  assert.ok(!context(true).includes(TRANSCRIPT));
  assert.ok(context(true).includes('"transcript_truncated":true'));
});
