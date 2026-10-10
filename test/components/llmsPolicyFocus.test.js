const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer } = require("../lib/rendererTestHarness");
const { mountAuditDom } = require("../lib/settingsAuditHarness");

test("LLM policy removal restores only owned, visible panel focus in StrictMode", async (t) => {
  const { dom, container, root } = await mountAuditDom(t);
  const outside = dom.document.createElement("button");
  outside.textContent = "Outside Settings";
  dom.document.body.appendChild(outside);
  const state = (globalThis.__llmFocus = { editors: {}, beforePaint: [] });
  t.after(() => delete globalThis.__llmFocus);

  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-llm-policy-focus-",
    noExternal: ["react-i18next"],
    mockModules: {
      "react-i18next": `export const useTranslation = () => ({ t: (key) => key });`,
      "/components/icons": `export const BookOpen = () => null; export const Languages = () => null;
          export const MessageSquare = () => null; export const Sparkles = () => null; export const Wand2 = () => null;`,
      "/stores/policyStore": `
          import { create } from "zustand";
          export const usePolicyStore = create(() => ({ agentAllowed: true }));
          globalThis.__llmFocus.policy = usePolicyStore;
        `,
      "/stores/policyRules": `export const isAgentAllowed = (state) => state.agentAllowed;`,
      "/stores/settingsStore": `
          import { create } from "zustand";
          export const useSettingsStore = create(() => ({ useCleanupModel: false, autoGenerateNoteTitle: false }));
        `,
      "/ProviderIcon": `export const ProviderIcon = () => null;`,
      "/ui/SettingsSection": `
          export const SettingsPanel = ({ children }) => children;
          export const SettingsPanelRow = ({ children }) => children;
          export const SettingsRow = ({ children }) => children;
          export const SectionHeader = () => null;
        `,
      "/ui/toggle": `export const Toggle = () => null;`,
      "/ui/useToast": `export const useToast = () => ({ toast() {} });`,
      "focus-editor": `
          import React, { useLayoutEffect, useState } from "react";
          import { createPortal } from "react-dom";
          export function Editor({ kind }) {
            const [draft, setDraft] = useState("");
            const [showNested, setShowNested] = useState(true);
            const record = globalThis.__llmFocus.editors[kind] ??= { mounts: 0, unmounts: 0 };
            record.setDraft = setDraft;
            record.removeNested = () => setShowNested(false);
            useLayoutEffect(() => {
              record.mounts++;
              return () => {
                record.unmounts++;
                globalThis.__llmFocus.onRemoval?.();
              };
            }, []);
            return React.createElement("div", { "data-editor": kind },
              React.createElement("textarea", { "aria-label": kind,
                value: draft, onChange: (e) => setDraft(e.target.value) }),
              showNested && React.createElement("div", null, React.createElement("button", {
                type: "button", "data-nested": kind, onFocus: (e) => e.stopPropagation()
              }, "Nested control")),
              kind === "dictationAgent" && createPortal(
                React.createElement("button", { type: "button", "data-agent-portal": true }, "Portal control"), document.body)
            );
          }
        `,
      "/ui/PromptStudio": `import React from "react"; import { Editor } from "focus-editor";
          export default function PromptStudio() { return React.createElement(Editor, { kind: "dictationCleanup" }); }`,
      "/DictationAgentSettings": `import React from "react"; import { Editor } from "focus-editor";
          export default function DictationAgentSettings() { return React.createElement(Editor, { kind: "dictationAgent" }); }`,
      "/DictationTranslationSettings": `import React from "react"; import { Editor } from "focus-editor";
          export default function DictationTranslationSettings() { return React.createElement(Editor, { kind: "dictationTranslation" }); }`,
      "/ChatAgentSettings": `import React from "react"; import { Editor } from "focus-editor";
          export default function ChatAgentSettings() { return React.createElement(Editor, { kind: "chatIntelligence" }); }`,
      "/GpuDeviceSelector": `export default function GpuDeviceSelector() { return null; }`,
      "/InferenceConfigEditor": `export default function InferenceConfigEditor() { return null; }`,
    },
  });
  const { default: LlmsKeepAlive } = await vite.ssrLoadModule(
    "/components/settings/LlmsSection.tsx"
  );
  const { createSettingsNavigationStore } = await vite.ssrLoadModule(
    "/stores/settingsNavigationStore.ts"
  );
  const navigation = createSettingsNavigationStore(
    "llms",
    () => state.policy.getState().agentAllowed
  );
  const unsubscribe = state.policy.subscribe(navigation.getState().reconcilePolicy);
  t.after(unsubscribe);
  function Harness() {
    const allowed = state.policy((value) => value.agentAllowed);
    React.useLayoutEffect(() => {
      state.beforePaint.push(dom.document.activeElement);
    }, [allowed]);
    return React.createElement(LlmsKeepAlive, { navigation });
  }
  await React.act(async () =>
    root.render(React.createElement(React.StrictMode, null, React.createElement(Harness)))
  );
  const policy = (agentAllowed) => React.act(async () => state.policy.setState({ agentAllowed }));
  const select = (tab) => React.act(async () => navigation.getState().selectLlmTab(tab));
  const section = (name) => React.act(async () => navigation.getState().openSettings(name));
  const focus = (element) => React.act(async () => element.focus());
  const choice = (tab) => container.querySelector(`[data-tab-id="${tab}"]`);
  const draft = (tab) => container.querySelector(`textarea[aria-label="${tab}"]`);
  const cleanup = draft("dictationCleanup");
  const cleanupMounts = state.editors.dictationCleanup.mounts;
  await React.act(async () => state.editors.dictationCleanup.setDraft("unsaved cleanup"));
  await select("dictationTranslation");
  const translation = draft("dictationTranslation");
  const translationMounts = state.editors.dictationTranslation.mounts;
  await React.act(async () => state.editors.dictationTranslation.setDraft("unsaved translation"));

  for (const tab of ["dictationAgent", "chatIntelligence"]) {
    await select(tab);
    await React.act(async () => state.editors[tab].setDraft(`unsaved ${tab}`));
    const input = draft(tab);
    await focus(input);
    await policy(false);
    assert.equal(input.isConnected, false, "the forbidden panel is removed");
    assert.equal(draft(tab), null);
    assert.equal(choice(tab), null);
    assert.equal(navigation.getState().llmTab, "dictationCleanup");
    assert.equal(dom.document.activeElement, choice("dictationCleanup"));
    assert.equal(
      state.beforePaint.at(-1),
      choice("dictationCleanup"),
      "focus is restored in the layout phase"
    );
    const mountsAfterRemoval = state.editors[tab].mounts;
    await policy(true);
    assert.equal(
      dom.document.activeElement,
      choice("dictationCleanup"),
      "reallowing does not steal focus"
    );
    assert.equal(navigation.getState().llmTab, "dictationCleanup", "fallback remains sticky");
    assert.equal(draft(tab).value, "", "only a policy-removed editor loses its draft");
    assert.ok(state.editors[tab].mounts > mountsAfterRemoval);

    await select(tab);
    await focus(container.querySelector(`[data-nested="${tab}"]`));
    await policy(false);
    assert.equal(
      dom.document.activeElement,
      choice("dictationCleanup"),
      "panel removal owns deeply nested focus even if bubbling stops"
    );
    await policy(true);

    await select(tab);
    await focus(draft(tab));
    await focus(outside);
    await policy(false);
    assert.equal(dom.document.activeElement, outside, "focus leaving the shell is not reclaimed");
    await policy(true);

    await select(tab);
    await focus(draft(tab));
    await focus(choice("dictationTranslation"));
    await policy(false);
    assert.equal(
      dom.document.activeElement,
      choice("dictationTranslation"),
      "a surviving choice keeps focus"
    );
    await policy(true);

    await select(tab);
    const nested = container.querySelector(`[data-nested="${tab}"]`);
    await focus(nested);
    await React.act(async () => state.editors[tab].removeNested());
    assert.equal(nested.isConnected, false);
    assert.equal(dom.document.activeElement, dom.document.body);
    await policy(false);
    assert.equal(
      dom.document.activeElement,
      dom.document.body,
      "an earlier nested-control removal is not policy-removal focus"
    );
    await policy(true);

    await select(tab);
    await focus(draft(tab));
    await React.act(async () => draft(tab).blur());
    await policy(false);
    assert.equal(
      dom.document.activeElement,
      dom.document.body,
      "an explicitly blurred control no longer owns focus"
    );
    await policy(true);

    await select(tab);
    await focus(draft(tab));
    await section("general");
    // Hidden shells remove focus to body, exercising the stale-capture guard.
    await policy(false);
    assert.notEqual(
      dom.document.activeElement,
      choice("dictationCleanup"),
      "hidden LLM controls never receive restoration"
    );
    await policy(true);
    await section("llms");
    assert.notEqual(
      dom.document.activeElement,
      choice("dictationCleanup"),
      "revisit does not replay a hidden removal"
    );
  }

  await select("dictationTranslation");
  await focus(translation);
  await policy(false);
  assert.equal(dom.document.activeElement, translation, "a surviving editor keeps its focus");
  await policy(true);

  await select("dictationAgent");
  await focus(draft("dictationAgent"));
  await focus(dom.document.querySelector("[data-agent-portal]"));
  await policy(false);
  assert.equal(
    dom.document.activeElement,
    dom.document.body,
    "React portal focus is not DOM-panel ownership"
  );
  await policy(true);

  await select("chatIntelligence");
  await focus(draft("chatIntelligence"));
  state.onRemoval = () => outside.focus();
  await policy(false);
  delete state.onRemoval;
  assert.equal(dom.document.activeElement, outside, "a commit-time focus handoff takes precedence");
  await policy(true);

  assert.equal(draft("dictationCleanup"), cleanup);
  assert.equal(cleanup.value, "unsaved cleanup");
  assert.equal(state.editors.dictationCleanup.mounts, cleanupMounts);
  assert.equal(draft("dictationTranslation"), translation);
  assert.equal(translation.value, "unsaved translation");
  assert.equal(state.editors.dictationTranslation.mounts, translationMounts);
  assert.equal(state.editors.dictationCleanup.unmounts, 1);
  await section("general");
  await section("llms");
  assert.equal(draft("dictationCleanup"), cleanup, "section changes retain allowed editors");
  await React.act(async () => root.render(null));
  assert.equal(cleanup.isConnected, false, "modal lifetime still owns the editor tree");
  await focus(outside);
  await policy(false);
  assert.equal(dom.document.activeElement, outside, "no focus work survives unmount");
  await policy(true);
  await React.act(async () =>
    root.render(React.createElement(React.StrictMode, null, React.createElement(Harness)))
  );
  assert.equal(
    dom.document.activeElement,
    outside,
    "reopening does not replay prior focus capture"
  );
  assert.notEqual(draft("dictationCleanup"), cleanup);
  assert.equal(draft("dictationCleanup").value, "", "a new modal starts new drafts");
});
