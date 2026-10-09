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

const SUMMARY =
  "## Overview\nWorkshop planning.\n\n## Decisions Made\nUse the small room.\n\n## Next steps\nAlex sends the poll by Sunday.";
const EDITED = "## Overview\nWorkshop planning.\n\n## Next steps\nAlex sends the poll by Sunday.";
const REQUEST = "Remove the Decisions Made section from note 7's summary.";
const PRIOR = [
  { role: "user", content: "Open an email draft with the meeting follow-up." },
  {
    role: "assistant",
    content: "Opened a draft for review.",
    metadata: JSON.stringify({
      toolCalls: [
        {
          id: "earlier-draft",
          name: "email_draft",
          arguments: "{}",
          status: "completed",
          metadata: { status: "draft_opened" },
        },
      ],
    }),
  },
];
const noop = () => {};

// Mounts both real entry points, their persistence/sender/streaming hooks and note
// tools. Only the provider transport and Electron IPC are fake. Scripted tool
// choices verify execution and request contracts, not a live model's judgment.
for (const surface of ["note chat", "assistant panel"]) {
  for (const priorEmail of [false, true]) {
    for (const provider of ["cloud", "byok"]) {
      test(`${surface}, ${provider}, ${priorEmail ? "after email" : "fresh"}: edit the summary without opening email`, async (t) => {
        let root;
        let reasoning;
        t.after(async () => {
          if (root) await React.act(async () => root.unmount());
          reasoning?.destroy();
        });
        const stored = {
          id: 7,
          title: "Workshop",
          content: "Bring a notebook.",
          enhanced_content: SUMMARY,
          transcript: "Source transcript only.",
          space_id: 1,
        };
        const savedMessages = [];
        const externalActions = [];
        installBrowserGlobals(t, {
          initialStorage: { isSubscribed: "true" },
          window: {
            clearInterval: noop,
            electronAPI: {
              getNote: async () => ({ ...stored }),
              updateNote: async (_id, updates, options) => {
                assert.equal(options.undoable, true);
                assert.equal(options.expected.id, stored.id);
                Object.assign(stored, updates);
                return { success: true };
              },
              semanticSearchNotes: async () => [],
              getConversationsForNote: async () => [],
              createAgentConversation: async () => ({ id: 1 }),
              getAgentConversation: async () => ({ id: 1, messages: priorEmail ? PRIOR : [] }),
              addAgentMessage: async (...args) => savedMessages.push(args),
              connectorStatus: async () => [],
              onConnectorStatusChanged: () => noop,
              connectorPrepare: async (...args) => {
                externalActions.push(args);
                throw new Error("Unexpected email action");
              },
              connectorConfirm: async (...args) => {
                externalActions.push(args);
                throw new Error("Unexpected send");
              },
              connectorRunDirect: async (...args) => {
                externalActions.push(args);
                throw new Error("Unexpected compose");
              },
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
        const { syncService } = await vite.ssrLoadModule("/services/SyncService.ts");
        t.mock.method(syncService, "debouncedPush", noop);
        await (await vite.ssrLoadModule("/i18n.ts")).default.changeLanguage("en");
        let request;
        const respond = (messages, config, execute) =>
          (async function* () {
            request = { messages, config };
            const current = await execute("get_note", { id: 7 });
            assert.equal(current.content, "Bring a notebook.");
            assert.equal(current.summary, SUMMARY);
            assert.equal(current.transcript, "Source transcript only.");
            const call = {
              id: "edit",
              name: "update_note",
              arguments: JSON.stringify({ id: 7, summary: EDITED }),
            };
            yield { type: "tool_calls", calls: [call] };
            const saved = await execute(call.name, JSON.parse(call.arguments));
            assert.deepEqual(saved.updatedFields, ["summary"]);
            const renamed = await execute("update_note", {
              id: 7,
              title: "Renamed workshop",
              content: "",
              summary: "",
            });
            assert.deepEqual(renamed.updatedFields, ["title"]);
            assert.deepEqual(renamed.ignoredFields, ["content", "summary"]);
            assert.match(renamed.guidance, /nothing was cleared.*clear_fields/);
            assert.equal(stored.content, "Bring a notebook.");
            assert.equal(stored.enhanced_content, EDITED);
            yield {
              type: "tool_result",
              callId: "edit",
              name: call.name,
              displayText: "Updated note",
              metadata: saved,
            };
            yield { type: "content", text: "Removed Decisions Made from the saved summary." };
            yield { type: "done", finishReason: "stop" };
          })();
        t.mock.method(reasoning, "processTextStreamingCloud", (messages, config) =>
          respond(messages, config, async (name, args) => {
            const result = await config.executeToolCall(name, JSON.stringify(args), name);
            return JSON.parse(result.data);
          })
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
        function NoteHarness() {
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
              ? React.createElement(NoteHarness)
              : React.createElement(AssistantPanel, {
                  pendingCommand: {
                    id: 1,
                    text: REQUEST,
                    attachment: null,
                    selectedContext: null,
                    delivery: null,
                  },
                  initialConversationId: priorEmail ? 1 : null,
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
        if (surface === "note chat") {
          if (priorEmail) await React.act(async () => chat.switchConversation(1));
          await React.act(async () => chat.sendMessage(REQUEST));
        } else {
          for (let i = 0; !settled && i < 100; i++)
            await React.act(async () => {
              await new Promise((resolve) => setTimeout(resolve, 10));
            });
          assert.equal(settled, true);
        }
        assert.equal(stored.enhanced_content, EDITED);
        assert.equal(stored.title, "Renamed workshop");
        assert.equal(stored.content, "Bring a notebook.");
        assert.equal(stored.transcript, "Source transcript only.");
        assert.deepEqual(externalActions, []);
        assert.ok(
          savedMessages.some((m) => m[1] === "assistant" && m[2].includes("saved summary"))
        );
        assert.equal(request.messages.at(-1).content, REQUEST);
        assert.match(
          request.config.systemPrompt,
          /previous email interaction does not authorize another email action/
        );
        assert.match(request.config.systemPrompt, /ask which document before acting/);
        if (priorEmail)
          assert.match(JSON.stringify(request.messages), /email_draft \(draft opened\)/);
        if (surface === "note chat") {
          assert.match(request.config.systemPrompt, /Note fields \(JSON\)/);
          if (provider === "cloud") assert.equal(request.config.noteChat, true);
        } else if (provider === "byok")
          assert.equal(request.config.inferenceScope, "dictationAgent");
      });
    }
  }
}
