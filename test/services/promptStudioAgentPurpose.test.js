const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { mountPromptStudio } = require("../lib/promptStudioFixture");

test("Prompt Studio tests are request-local and cannot revert concurrent saves", async (t) => {
  const mounted = await mountPromptStudio(t);
  const { container, observed, PromptStudio, resolvePrompt, click } = mounted;
  let root = mounted.root;
  const draft = "Test {{agentName}} to {{targetLanguage}}";
  for (const kind of ["cleanup", "dictationAgent", "translate"]) {
    for (const action of kind === "cleanup" ? ["different", "failure"] : ["different"]) {
      await t.test(`${kind}: ${action}`, async (subtest) => {
        subtest.after(async () => {
          await React.act(async () => observed.pending?.resolve("settled"));
        });
        await React.act(async () => {
          observed.store.setState({ customPrompts: { [kind]: "Saved {{agentName}}" } });
          root.render(React.createElement(PromptStudio, { kind, key: `${kind}-${action}` }));
        });
        await click("promptStudio.tabs.customize");
        await React.act(async () => observed.edit.onChange({ target: { value: draft } }));
        await click("promptStudio.tabs.test");
        const writes = observed.writes.length;
        await click("promptStudio.test.run");
        assert.equal(observed.writes.length, writes, "testing never writes shared settings");
        assert.equal(
          resolvePrompt(kind, { agentName: "Whisper" }),
          "Saved Whisper",
          "a simultaneous ordinary request still resolves the saved prompt"
        );
        const config = observed.calls.at(-1)[3];
        if (kind === "cleanup") {
          assert.equal(config.cleanupPrompt, draft);
          assert.equal(
            config.systemPrompt,
            undefined,
            "cleanup must not become an agent-style request"
          );
          assert.equal(config.inferenceScope, "dictationCleanup");
          assert.equal(config.disableThinking, true);
        } else {
          assert.match(config.systemPrompt, /Test Whisper/);
          assert.match(config.systemPrompt, /OpenWhispr/);
          if (kind === "dictationAgent") {
            assert.equal(config.requiresAgent, true, "agent policy enforcement stays enabled");
            assert.equal(config.inferenceScope, "dictationAgent");
            assert.match(config.systemPrompt, /French|français/i);
          } else {
            assert.match(config.systemPrompt, /Spanish/);
            assert.equal(config.inferenceScope, "dictationTranslation");
          }
        }
        await click("promptStudio.tabs.customize");
        const saved = action === "different" ? "Different saved text" : draft;
        await React.act(async () => observed.edit.onChange({ target: { value: saved } }));
        await click("promptStudio.common.save");
        const afterSave = observed.writes.length;
        await React.act(async () => {
          if (action === "failure") observed.pending.reject(new Error("test failure"));
          else observed.pending.resolve("result");
        });
        assert.equal(observed.store.getState().customPrompts[kind], saved);
        assert.equal(observed.writes.length, afterSave, "settling never restores an old prompt");
        await click("promptStudio.tabs.test");
        assert.match(
          container.textContent,
          action === "failure" ? /promptStudio.test.failed/ : /result/
        );
      });
    }
  }

  for (const kind of ["cleanup", "dictationAgent", "translate"]) {
    await t.test(
      `${kind}: narrow subscriptions keep hidden drafts and read fresh test settings`,
      async (subtest) => {
        subtest.after(async () => {
          container.hidden = false;
          await React.act(async () => observed.pending?.resolve("settled"));
        });
        const modelKey =
          kind === "translate"
            ? "translationModel"
            : kind === "dictationAgent"
              ? "dictationAgentModel"
              : "cleanupModel";
        let commits = 0;
        await React.act(async () => {
          observed.policy.setState({ patch: {} });
          observed.store.setState({
            uiLanguage: "en",
            isSignedIn: true,
            useCleanupModel: true,
            useDictationAgent: true,
            useDictationTranslation: true,
            cleanupModel: "cleanup",
            dictationAgentModel: "agent",
            translationModel: "translate",
            dictationAgentProvider: "openwhispr",
            translationProvider: "openwhispr",
            customPrompts: { cleanup: "Saved", dictationAgent: "Saved", translate: "Saved" },
          });
          root.render(
            React.createElement(
              React.Profiler,
              { id: kind, onRender: () => commits++ },
              React.createElement(PromptStudio, { kind, key: `subscriptions-${kind}` })
            )
          );
        });
        await click("promptStudio.tabs.customize");
        await React.act(async () => observed.edit.onChange({ target: { value: draft } }));
        container.hidden = true;
        const before = commits;
        const otherScope =
          kind === "cleanup"
            ? {
                dictationAgentModel: "other-agent",
                dictationAgentProvider: "anthropic",
                translationModel: "other-translation",
              }
            : { cleanupModel: "other-cleanup", cleanupMode: "providers" };
        await React.act(async () =>
          observed.store.setState({
            ...otherScope,
            theme: "dark",
            hotkey: "F9",
            whisperModel: "large",
            customDictionary: ["FreshDictionary"],
            preferredLanguage: "de",
            cleanupDisableThinking: false,
            dictationAgentCustomApiKey: "fresh-agent-key",
            dictationAgentRemoteUrl: "http://localhost:8080/v1",
            translationCustomApiKey: "fresh-translation-key",
            translationRemoteUrl: "http://localhost:9090/v1",
          })
        );
        assert.equal(
          commits,
          before,
          "unrelated/cross-scope/test-only writes do not render a hidden editor"
        );
        assert.equal(observed.edit.value, draft);
        await React.act(async () => observed.store.setState({ [modelKey]: "chosen-model" }));
        assert.ok(commits > before, "the current kind's model stays reactive");
        let previous = commits;
        await React.act(async () => observed.store.setState({ isSignedIn: false }));
        assert.ok(commits > previous, "auth-derived cloud mode stays reactive");
        previous = commits;
        await React.act(async () =>
          observed.policy.setState({ patch: { [modelKey]: "policy-model" } })
        );
        assert.ok(commits > previous, "policy-effective selection stays reactive");
        previous = commits;
        await React.act(async () => observed.store.setState({ uiLanguage: "es" }));
        assert.ok(commits > previous, "default-prompt language stays reactive");
        assert.equal(observed.edit.value, draft, "relevant updates do not reset the draft");
        container.hidden = false;
        await click("promptStudio.tabs.test");
        assert.match(container.textContent, /policy-model/);
        await click("promptStudio.test.run");
        const [, model, , config] = observed.calls.at(-1);
        assert.equal(model, "policy-model");
        if (kind === "cleanup") {
          assert.equal(
            config.disableThinking,
            false,
            "Test uses the latest non-subscribed sampling setting"
          );
          assert.equal(config.cleanupPrompt, draft);
        } else {
          assert.match(config.systemPrompt, /FreshDictionary/);
          assert.equal(
            config.customApiKey,
            kind === "dictationAgent" ? "fresh-agent-key" : "fresh-translation-key"
          );
          assert.equal(
            config.lanUrl,
            kind === "dictationAgent" ? "http://localhost:8080/v1" : "http://localhost:9090/v1"
          );
          if (kind === "dictationAgent") assert.match(config.systemPrompt, /German|Deutsch/i);
        }
        await React.act(async () => observed.pending.resolve("result"));
      }
    );
  }
});
