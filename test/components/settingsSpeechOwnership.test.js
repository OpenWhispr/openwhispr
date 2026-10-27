const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { deferred } = require("../lib/settingsAuditHarness");
const { mountSettingsPageOwner } = require("../lib/settingsPageOwnerHarness");

test("Settings checkout controls render pending progress and surface current failures", async (t) => {
  const { container, render, SettingsPage, navigation, observed } = await mountSettingsPageOwner(
    t,
    { section: "plansBilling" }
  );
  const requests = [];
  observed.authGeneration = 7;
  observed.usage = {
    status: "success",
    plan: "free",
    wordsUsed: 0,
    wordsRemaining: 2000,
    limit: 2000,
    entitledWorkspaceIds: [],
    openCheckout: (options) => {
      const reply = deferred();
      requests.push({ options, reply });
      return reply.promise;
    },
  };
  await render(React.createElement(SettingsPage, { navigation }));
  const button = (label) =>
    Array.from(container.querySelectorAll("button")).find((node) => node.textContent === label);
  const upgrade = () => button("settingsPage.account.checkout.upgradeToPro");
  const card = () => button("settingsPage.account.pricing.pro.cta");
  const click = (node) => React.act(async () => node.click());
  const settle = (result) => React.act(async () => requests.at(-1).reply.resolve(result));
  const failure = {
    title: "settingsPage.account.checkout.couldNotOpenTitle",
    description: "settingsPage.account.checkout.couldNotOpenDescription",
  };

  // Each control renders pending progress from the generation-keyed checkoutProgress and surfaces a current failure.
  await click(upgrade());
  assert.ok(button("settingsPage.account.checkout.opening").disabled);
  await settle({ success: false, error: "current checkout failure" });
  assert.deepEqual(observed.toasts, [{ ...failure, variant: "destructive" }]);
  assert.equal(upgrade().disabled, false);

  const cardControl = card();
  await click(cardControl);
  assert.equal(cardControl.disabled, true);
  await settle({ success: false, error: "current checkout failure" });
  assert.deepEqual(observed.toasts, [{ ...failure, variant: "destructive" }, failure]);
  assert.equal(card().disabled, false);
  assert.ok(requests.every(({ options }) => options.plan === "annual" && options.tier === "pro"));
});

test("SettingsPage retains Speech state and current section actions", async (t) => {
  const mounted = await mountSettingsPageOwner(t, {
    section: "workspace",
    speech: true,
    extraMocks: {
      "/settings/ProfileSection": "export default function Stub() { return null; }",
      "/stores/noteStore.js": `export const useMigration = () => ({}); export const startMigration = () => {}; export const loadFolders = () => {}; export const initializeNotesTree = () => {};`,
      "/lib/accountDeletionRequest": `export const deleteAccount = async generation => { globalThis.__settingsPageOwner.deletions.push(generation); throw new Error("fake remote refusal"); };`,
      "/lib/usageStore": `export const highestPlan = () => "free";`,
    },
  });
  const { dom, container, observed, SettingsPage, vite } = mounted;
  let root = mounted.root;
  t.after(async () => {
    if (root) await React.act(async () => root.unmount());
    root = null;
  });
  dom.electronAPI.updateHotkey = async (key) => {
    observed.registered.push(key);
    return { success: true };
  };
  dom.electronAPI.onLinuxPttPermissionDenied = (listener) => {
    observed.onDenial = listener;
    return () => {
      if (observed.onDenial === listener) observed.onDenial = null;
    };
  };
  const { createSettingsNavigationStore } = await vite.ssrLoadModule(
    "/stores/settingsNavigationStore.ts"
  );
  let navigation, previousRoot;
  const render = (activeSection, initialSubTab) =>
    React.act(async () => {
      if (previousRoot !== root) {
        navigation = createSettingsNavigationStore();
        previousRoot = root;
      }
      const actions = navigation.getState();
      actions.openSettings(activeSection);
      if (initialSubTab && activeSection === "speechToText") actions.selectSpeechTab(initialSubTab);
      if (initialSubTab && activeSection === "llms") actions.selectLlmTab(initialSubTab);
      root.render(React.createElement(SettingsPage, { navigation }));
    });
  const update = (values) => React.act(async () => observed.store.setState(values));

  await render("workspace");
  assert.equal(observed.mounted, 0, "Speech does not mount before first visit");
  await render("speechToText");
  assert.equal(observed.mounted, 3);
  assert.deepEqual(
    observed.activity,
    { dictation: true, meeting: false, upload: false },
    "real SettingsPage scopes routine reads to its visible Speech tab"
  );
  await React.act(async () => observed.pickers.dictation.setDraft("unsaved"));
  await render("workspace");
  assert.deepEqual(
    observed.activity,
    { dictation: false, meeting: false, upload: false },
    "real section exit pauses all retained routine readers"
  );
  await update({ customDictionary: ["OpenWhispr"] });
  await update({ notificationsEnabled: true });
  await update({ whisperModel: "small" });
  assert.equal(observed.pickers.dictation.props.selectedLocalModel, "small");
  await update({ meetingWhisperModel: "medium" });
  assert.equal(observed.pickers.meeting.props.selectedLocalModel, "medium");
  await update({ uploadWhisperModel: "tiny" });
  assert.equal(observed.pickers.upload.props.selectedLocalModel, "tiny");
  await update({ uploadTranscriptionMode: "providers" });
  assert.deepEqual(
    {
      context: observed.pickers.upload.props.transcriptionContext,
      mode: observed.pickers.upload.props.mode,
    },
    { context: "upload", mode: "cloud" },
    "Upload BYOK uses a cloud picker in the upload context, independently of local Dictation/Meeting"
  );
  await update({ uploadTranscriptionMode: "local" });
  const disposalsAfterUploadModeChange = observed.disposed;
  await React.act(async () => observed.pickers.dictation.setProgress(42));
  assert.equal(observed.pickers.dictation.draft, "unsaved");
  assert.equal(observed.pickers.dictation.progress, 42, "hidden child work stays live");

  const vadCount = () =>
    container.textContent.split("settingsPage.transcription.vad.title").length - 1;
  await update({ localTranscriptionProvider: "nvidia" });
  assert.equal(vadCount(), 1, "Meeting VAD is independent of Dictation provider");
  await update({ meetingLocalTranscriptionProvider: "nvidia" });
  assert.equal(vadCount(), 0);
  await update({
    localTranscriptionProvider: "whisper",
    meetingLocalTranscriptionProvider: "whisper",
  });
  assert.equal(vadCount(), 2);
  const threshold = observed.inputs.findLast((input) => input.min === "0.1");
  await React.act(async () => threshold.onChange({ target: { value: "0.7" } }));
  assert.equal(observed.store.getState().whisperVadThreshold, 0.7);

  await React.act(async () => observed.auth.setState({ isSignedIn: false }));
  assert.equal(observed.modes.at(-1).modes.find((mode) => mode.id === "openwhispr").disabled, true);
  await React.act(async () => observed.locale.setState({ t: (key) => "translated:" + key }));
  assert.match(container.textContent, /translated:settingsPage.transcription.vad.title/);
  await render("speechToText", "upload", {});
  assert.equal(observed.tabs.selectedId, "upload");
  assert.deepEqual(observed.activity, { dictation: false, meeting: false, upload: true });
  await render("speechToText", "dictation", {});
  assert.equal(observed.tabs.selectedId, "dictation");
  assert.equal(observed.pickers.dictation.draft, "unsaved");
  assert.equal(
    observed.disposed,
    disposalsAfterUploadModeChange,
    "section and subtab changes retain picker lifetimes"
  );
  await React.act(async () => observed.policy.setState({ forcedMode: "openwhispr" }));
  assert.equal(
    observed.disposed,
    disposalsAfterUploadModeChange + 3,
    "a policy mode change still reaches retained children"
  );
  await React.act(async () => observed.policy.setState({ forcedMode: undefined }));
  await React.act(async () => root.unmount());
  root = null;
  assert.equal(observed.disposed, observed.mounted, "Settings close releases every mounted picker");

  await t.test("Hotkeys owns subscriptions and pending writes", async (scope) => {
    scope.after(async () => {
      if (root) await React.act(async () => root.unmount());
      root = null;
      delete globalThis.window.electronAPI.getHotkeyModeInfo;
      delete globalThis.window.electronAPI.getEffectiveDefaultHotkey;
      globalThis.window.electronAPI.updateHotkey = async (key) => {
        observed.registered.push(key);
        return { success: true };
      };
    });
    observed.locale.setState({ t: (key) => key });
    const api = globalThis.window.electronAPI;
    const modes = [];
    const defaults = [];
    const pending = (queue) => new Promise((resolve, reject) => queue.push({ resolve, reject }));
    api.getHotkeyModeInfo = () => pending(modes);
    api.getEffectiveDefaultHotkey = () => pending(defaults);
    const normalMode = {
      isUsingNativeShortcut: false,
      isUsingHyprland: false,
      supportsPushToTalk: true,
      pushToTalkUnavailableReason: null,
      linuxInputAccessDenied: false,
    };
    let prefix = "";
    const hotkey = (slot) => observed.hotkeys[prefix + `settingsPage.general.${slot}.title`];
    root = createRoot(container);
    await render("speechToText");
    await React.act(async () => observed.pickers.dictation.setDraft("hotkey-safe"));
    await render("workspace");
    const speechLifetimes = { mounted: observed.mounted, disposed: observed.disposed };
    await update({ customDictionary: ["new word"], dictationKey: "F8", activationMode: "push" });
    assert.equal(modes.length, 0, "no Hotkeys diagnostic before the first visit");
    assert.equal(defaults.length, 0);
    assert.equal(typeof observed.onDenial, "function");
    await React.act(async () => observed.onDenial());
    assert.equal(
      observed.store.getState().activationMode,
      "tap",
      "Linux denial remains Settings-wide before the first Hotkeys visit"
    );
    assert.equal(observed.toasts.at(-1).variant, "destructive");

    await render("hotkeys");
    assert.equal(modes.length, 1);
    assert.equal(defaults.length, 1);
    await React.act(async () => {
      modes[0].resolve(normalMode);
      defaults[0].resolve("F12");
    });
    assert.equal(container.querySelectorAll("[data-hotkey]").length, 4);
    await update({ customDictionary: ["another word"], whisperVadThreshold: 0.8 });
    await update({ voiceAgentKey: "F9" });
    assert.equal(hotkey("voiceAgentHotkey").value, "F9");
    for (const [slot, conflict] of [
      ["hotkey", "F7"],
      ["meetingHotkey", "F8"],
      ["voiceAgentHotkey", "F5"],
      ["translationHotkey", "F9"],
    ]) {
      assert.equal(hotkey(slot).validate(conflict), "hotkey.errors.slotConflict");
      assert.equal(hotkey(slot).validate("F10"), null);
    }
    await React.act(async () =>
      observed.auth.setState({ isSignedIn: false, user: { id: "other" } })
    );
    assert.equal(
      hotkey("voiceAgentHotkey").value,
      "F9",
      "auth refresh does not remount key controls"
    );
    await React.act(async () => observed.locale.setState({ t: (key) => "translated:" + key }));
    prefix = "translated:";
    assert.ok(
      container.querySelector('[data-hotkey="translated:settingsPage.general.hotkey.title"]')
    );
    await React.act(async () => observed.policy.setState({ status: "loading" }));
    assert.equal(
      container.querySelector(
        '[data-hotkey="translated:settingsPage.general.voiceAgentHotkey.title"]'
      ),
      null
    );
    await React.act(async () => observed.policy.setState({ status: "unmanaged" }));
    assert.equal(hotkey("voiceAgentHotkey").value, "F9");
    await React.act(async () => observed.locale.setState({ t: (key) => key }));
    prefix = "";
    await render("workspace");
    await update({
      meetingKey: "F4",
      translationKey: "F3",
      meetingHotkeyLayoutMode: "full-width",
    });
    assert.equal(
      observed.hotkeyDisposed,
      observed.hotkeyMounts,
      "capture controls unmount on section exit"
    );
    await render("hotkeys");
    assert.equal(hotkey("meetingHotkey").value, "F4");
    assert.equal(hotkey("translationHotkey").value, "F3");
    assert.equal(modes.length, 1, "visibility alone does not recreate the registration owner");

    let finishRegistration;
    let calls = 0;
    api.updateHotkey = () => {
      calls++;
      return new Promise((resolve) => {
        finishRegistration = resolve;
      });
    };
    let saving;
    await React.act(async () => {
      saving = hotkey("hotkey").onChange("F13");
    });
    assert.equal(hotkey("hotkey").disabled, true);
    await render("workspace");
    await render("hotkeys");
    assert.equal(
      hotkey("hotkey").disabled,
      true,
      "in-flight registration lock survives leave/re-entry"
    );
    let duplicate;
    await React.act(async () => {
      duplicate = await hotkey("hotkey").onChange("F12");
    });
    assert.equal(duplicate, false);
    assert.equal(calls, 1);
    await render("workspace");
    await React.act(async () => {
      finishRegistration({ success: true });
      await saving;
    });
    assert.equal(
      observed.store.getState().dictationKey,
      "F13",
      "hidden native write still persists the registered key"
    );
    await render("hotkeys");
    assert.equal(hotkey("hotkey").disabled, false);
    assert.equal(hotkey("hotkey").value, "F13");

    api.updateHotkey = async () => ({ success: false, message: "native refusal" });
    let accepted;
    await React.act(async () => {
      accepted = await hotkey("hotkey").onChange("F12");
    });
    assert.equal(accepted, false);
    assert.equal(
      observed.alerts.at(-1).description,
      "native refusal",
      "errors still use the shared alert owner"
    );
    observed.agentWrite = async () => ({ success: false, message: "agent refusal" });
    await React.act(async () => {
      accepted = await hotkey("voiceAgentHotkey").onChange("F12");
    });
    assert.equal(accepted, false);
    assert.equal(observed.store.getState().voiceAgentKey, "F9");
    assert.equal(observed.alerts.at(-1).description, "agent refusal");
    await React.act(async () => hotkey("translationHotkey").onClear());
    assert.equal(observed.store.getState().translationKey, "");
    api.registerMeetingHotkey = async () => ({ success: true });
    await React.act(async () => hotkey("meetingHotkey").onChange("F2"));
    assert.equal(observed.store.getState().meetingKey, "F2");
    await React.act(async () => hotkey("meetingHotkey").onClear());
    assert.equal(observed.store.getState().meetingKey, "");

    const olderMode = modes.at(-1);
    await update({ dictationKey: "F12" });
    await React.act(async () =>
      modes.at(-1).resolve({
        ...normalMode,
        isUsingNativeShortcut: true,
        supportsPushToTalk: false,
        pushToTalkUnavailableReason: "Input access denied",
        linuxInputAccessDenied: true,
      })
    );
    await React.act(async () => olderMode.resolve(normalMode));
    assert.equal(
      hotkey("hotkey").maxHotkeys,
      1,
      "obsolete mode replies cannot replace a newer key's diagnostics"
    );
    assert.equal(observed.ptt.isAvailable, false);
    const deniedHold = container.querySelector('button[title="Input access denied"]');
    assert.ok(deniedHold);
    assert.equal(deniedHold.disabled, true);
    assert.equal(deniedHold.getAttribute("aria-label"), "common.hold: Input access denied");
    assert.equal(container.textContent.includes("Input access denied"), false);
    await update({ dictationKey: "F13" });
    const closedMode = modes.at(-1);
    await React.act(async () => observed.pickers.dictation.setProgress(73));
    assert.equal(observed.pickers.dictation.draft, "hotkey-safe");
    assert.equal(observed.pickers.dictation.progress, 73);
    assert.deepEqual({ mounted: observed.mounted, disposed: observed.disposed }, speechLifetimes);
    const lateDefault = defaults.at(-1);
    await React.act(async () => root.unmount());
    root = null;
    assert.equal(observed.onDenial, null, "Settings close releases its shared denial listener");
    await React.act(async () => lateDefault.resolve("F1"));
    root = createRoot(container);
    await render("hotkeys");
    await React.act(async () => closedMode.resolve({ ...normalMode, isUsingNativeShortcut: true }));
    assert.equal(
      hotkey("hotkey").maxHotkeys,
      undefined,
      "a fresh owner has not adopted old mode replies"
    );
    await React.act(async () => {
      modes.at(-1).resolve({
        ...normalMode,
        isUsingNativeShortcut: true,
        supportsPushToTalk: false,
        pushToTalkUnavailableReason: "Hold needs a regular key",
      });
      defaults.at(-1).resolve("F10");
    });
    const regularKeyHold = container.querySelector('button[title="Hold needs a regular key"]');
    assert.ok(regularKeyHold);
    assert.equal(regularKeyHold.disabled, true);
    assert.equal(
      regularKeyHold.getAttribute("aria-label"),
      "common.hold: Hold needs a regular key"
    );
    assert.ok(container.textContent.includes("Hold needs a regular key"));
    assert.equal(hotkey("hotkey").footerEnd.props.children.props.value, "F10");
    await React.act(async () => root.unmount());
    root = null;
    await React.act(async () => {
      observed.auth.setState({ isSignedIn: true });
      observed.policy.setState({ status: "unmanaged" });
    });
  });

  await t.test(
    "General's Chinese script control preserves native options and store updates",
    async () => {
      await update({ preferredLanguage: "auto", chineseScriptPreference: "simplified" });
      observed.locale.setState({ t: (key) => key });
      root = createRoot(container);
      await render("general");
      const select = container.querySelector(
        'select[aria-label="settings.language.chineseScriptLabel"]'
      );
      assert.ok(select);
      assert.equal(select.value, "simplified");
      assert.deepEqual(
        [...select.options].map((option) => option.value),
        ["as-transcribed", "simplified", "traditional"]
      );
      await React.act(async () => {
        select.value = "traditional";
        select.dispatchEvent(new dom.Event("change", { bubbles: true }));
      });
      assert.equal(observed.store.getState().chineseScriptPreference, "traditional");
      await update({ preferredLanguage: "en" });
      assert.equal(
        container.querySelector('select[aria-label="settings.language.chineseScriptLabel"]'),
        null
      );
      await update({ preferredLanguage: "auto" });
      assert.equal(
        container.querySelector('select[aria-label="settings.language.chineseScriptLabel"]').value,
        "traditional"
      );
      await React.act(async () => root.unmount());
      root = null;
    }
  );

  await t.test(
    "Settings reads ignore older entries and preserve completed startup read-back",
    async (scope) => {
      scope.after(async () => {
        if (root) await React.act(async () => root.unmount());
        root = null;
      });
      observed.locale.setState({ t: (key) => key });
      await update({ dictationKey: "F8", noteFilesEnabled: true, noteFilesPath: "" });
      const api = globalThis.window.electronAPI;
      const startup = [];
      const paths = [];
      const diagnostics = [];
      const defaults = [];
      const pending = (queue) => new Promise((resolve, reject) => queue.push({ resolve, reject }));
      api.getAutoStartEnabled = () => pending(startup);
      api.setAutoStartEnabled = async () => ({ success: true });
      api.noteFilesGetDefaultPath = () => pending(paths);
      api.getYdotoolStatus = () => pending(diagnostics);
      api.getEffectiveDefaultHotkey = () => pending(defaults);
      const toggle = () =>
        container.querySelector('[aria-label="settingsPage.general.startup.launchAtLogin"]');
      root = createRoot(container);
      await render("workspace");
      assert.deepEqual(
        [startup.length, paths.length, diagnostics.length, defaults.length],
        [0, 0, 0, 0]
      );
      await render("general");
      assert.equal(defaults.length, 0, "General does not read the Hotkeys default");
      await React.act(async () => startup[0].resolve({ enabled: false, requiresApproval: false }));
      assert.equal(toggle().disabled, false);
      await render("workspace");
      await render("general");
      assert.equal(
        toggle().disabled,
        true,
        "a fresh entry is pending, not a usable stale OS value"
      );
      await render("workspace");
      await render("general");
      await React.act(async () => {
        startup[2].resolve({ enabled: false, requiresApproval: false });
        paths[2].resolve("/fresh-notes");
        diagnostics[2].resolve({
          isLinux: true,
          isWayland: true,
          hasYdotool: true,
          hasYdotoold: true,
          hasWtype: true,
          daemonRunning: true,
          hasUinput: true,
          hasUdevRule: true,
          hasGroup: true,
          isWlroots: true,
        });
      });
      await React.act(async () => toggle().click());
      assert.equal(startup.length, 4, "successful startup write reads the OS back");
      await React.act(async () => startup[3].resolve({ enabled: true, requiresApproval: true }));
      await React.act(async () => {
        startup[1].resolve({ enabled: false, requiresApproval: false });
        paths[1].resolve("/obsolete-notes");
        diagnostics[1].resolve({ isLinux: false, isWayland: false });
      });
      assert.equal(toggle().getAttribute("aria-checked"), "true");
      assert.equal(toggle().disabled, false);
      const pathHint = () =>
        observed.rows.findLast((row) => row.label === "settings.noteFiles.path").description.props
          .children;
      assert.equal(pathHint(), "/fresh-notes");
      assert.ok(container.textContent.includes("settingsPage.general.waylandPaste.title"));
      assert.ok(
        container.querySelector('[aria-label="settingsPage.general.waylandPaste.recheck"]')
      );
      await render("hotkeys");
      await render("workspace");
      await render("hotkeys");
      await React.act(async () => defaults[1].resolve("F10"));
      await React.act(async () => defaults[0].resolve("F9"));
      const reset = [...container.querySelectorAll("button")].find((button) =>
        button.textContent.includes("resetToDefault")
      );
      await React.act(async () => reset.click());
      assert.equal(observed.registered.at(-1), "F10");
      await render("general");
      await React.act(async () => {
        startup.at(-1).reject(new Error("unavailable"));
        paths.at(-1).reject(new Error("unavailable"));
        diagnostics.at(-1).reject(new Error("unavailable"));
      });
      assert.equal(
        toggle().getAttribute("aria-checked"),
        "true",
        "failed reads retain valid state"
      );
      assert.equal(toggle().disabled, false);
      assert.equal(pathHint(), "/fresh-notes");
      let finishWrite;
      api.setAutoStartEnabled = () =>
        new Promise((resolve) => {
          finishWrite = resolve;
        });
      await React.act(async () => toggle().click());
      await render("workspace");
      const readsBeforeHiddenWrite = startup.length;
      await React.act(async () => finishWrite({ success: true }));
      assert.equal(
        startup.length,
        readsBeforeHiddenWrite + 1,
        "completed hidden write still reconciles OS state"
      );
      await React.act(async () =>
        startup.at(-1).resolve({ enabled: false, requiresApproval: false })
      );
      await render("general");
      await React.act(async () =>
        startup.at(-1).resolve({ enabled: true, requiresApproval: false })
      );
      await React.act(async () => toggle().click());
      await React.act(async () => root.unmount());
      root = null;
      const readsAtClose = startup.length;
      await React.act(async () => finishWrite({ success: true }));
      assert.equal(startup.length, readsAtClose, "closed owner cannot start a late read-back");
      await React.act(async () => {
        paths[0].resolve("/closed-notes");
        diagnostics[0].resolve({ isLinux: false, isWayland: false });
      });
      api.getAutoStartEnabled = async () => ({ enabled: false, requiresApproval: false });
      api.noteFilesGetDefaultPath = async () => "/reopened-notes";
      api.getYdotoolStatus = async () => ({ isLinux: false, isWayland: false });
      root = createRoot(container);
      await render("general");
      assert.equal(toggle().getAttribute("aria-checked"), "false");
      assert.equal(pathHint(), "/reopened-notes");
      await React.act(async () => root.unmount());
      root = null;
    }
  );

  await t.test("Settings sign-out awaits the meeting before clearing scope", async () => {
    observed.locale.setState({ t: (key) => key });
    const calls = [];
    let finishStop;
    observed.stopRecording = () =>
      new Promise((resolve) => {
        calls.push("stop requested");
        finishStop = () => {
          calls.push("meeting stopped");
          resolve();
        };
      });
    observed.purgeTeamSpaces = async () => {
      calls.push("team spaces purged");
    };
    observed.signOut = async () => {
      calls.push("signed out");
    };
    t.mock.method(dom.location, "reload", () => {
      calls.push("reloaded");
    });
    await React.act(async () =>
      observed.auth.setState({ isSignedIn: true, user: { id: "account-a" } })
    );
    root = createRoot(container);
    await render("account");
    const button = [...container.querySelectorAll("button")].find(
      (entry) => entry.textContent.trim() === "settingsPage.account.signOut.signOut"
    );
    assert.ok(button, container.textContent);
    await React.act(async () => button.click());
    assert.deepEqual(
      calls,
      ["stop requested"],
      "account scope must remain until the meeting stop settles"
    );
    await React.act(async () => finishStop());
    assert.deepEqual(calls, [
      "stop requested",
      "meeting stopped",
      "team spaces purged",
      "signed out",
      "reloaded",
    ]);
    await React.act(async () => root.unmount());
    root = null;
  });

  await t.test(
    "delete consent belongs to its opening account and credential generation",
    async (scope) => {
      scope.after(async () => {
        if (root) await React.act(async () => root.unmount());
        root = null;
      });
      if (root) await React.act(async () => root.unmount());
      root = createRoot(container);
      observed.locale.setState({ t: (key) => key });
      observed.deletions = [];
      observed.authGeneration = 7;
      await React.act(async () =>
        observed.auth.setState({ isSignedIn: true, user: { id: "account-a" } })
      );
      await render("account");
      const open = () =>
        observed.buttons
          .findLast((button) =>
            React.Children.toArray(button.children).includes(
              "settingsPage.account.deleteAccount.button"
            )
          )
          .onClick();
      await React.act(async () => open());
      assert.equal(observed.deleteDialog.open, true);
      const oldConfirm = observed.deleteDialog.onConfirm;
      await React.act(async () => observed.auth.setState({ user: { id: "account-b" } }));
      assert.equal(observed.deleteDialog.open, false);
      await React.act(async () => oldConfirm());
      assert.deepEqual(
        observed.deletions,
        [],
        "live account binding matters even with the same generation"
      );
      observed.authGeneration = 8;
      await React.act(async () => observed.auth.setState({ user: { id: "account-b" } }));
      await React.act(async () => open());
      observed.authGeneration = 9;
      await React.act(async () => observed.auth.setState({ user: { id: "account-b" } }));
      assert.equal(
        observed.deleteDialog.open,
        false,
        "same-account token replacement invalidates consent"
      );
      await React.act(async () => open());
      await React.act(async () => observed.auth.setState({ isSignedIn: false, user: null }));
      assert.equal(observed.deleteDialog.open, false);
      await React.act(async () =>
        observed.auth.setState({ isSignedIn: true, user: { id: "account-b" } })
      );
      assert.equal(observed.deleteDialog.open, false, "sign-in does not resurrect old consent");
      await React.act(async () => open());
      const checkbox = container.querySelector('input[type="checkbox"]');
      await React.act(async () => checkbox.click());
      assert.equal(checkbox.checked, true);
      await React.act(async () => observed.deleteDialog.onOpenChange(false));
      await React.act(async () => open());
      assert.equal(
        container.querySelector('input[type="checkbox"]').checked,
        false,
        "reopen requires fresh erasure opt-in"
      );
      await React.act(async () => observed.deleteDialog.onConfirm());
      assert.deepEqual(
        observed.deletions,
        [9],
        "valid consent dispatches only its captured generation"
      );
      observed.authGeneration = null;
      await React.act(async () => observed.auth.setState({ user: { id: "account-b" } }));
      const deleteButton = observed.buttons.findLast((button) =>
        React.Children.toArray(button.children).includes(
          "settingsPage.account.deleteAccount.button"
        )
      );
      assert.equal(
        deleteButton.disabled,
        true,
        "unvalidated identities cannot open deletion consent"
      );
      await React.act(async () => root.unmount());
      root = null;
    }
  );

  await t.test(
    "Privacy refreshes audio usage and reports partial deletion instead of success",
    async () => {
      observed.locale.setState({
        t: (key, options) => (options?.count ? `${key}:${options.count}` : key),
      });
      const api = globalThis.window.electronAPI;
      api.getAudioStorageUsage = async () => ({ fileCount: 5, totalBytes: 500 });
      root = createRoot(container);
      await render("privacyData");
      await render("workspace");
      let resolveOldUsage;
      api.getAudioStorageUsage = () =>
        new Promise((resolve) => {
          resolveOldUsage = resolve;
        });
      await render("privacyData");
      let usageReads = 0;
      api.getAudioStorageUsage = async () => {
        usageReads++;
        return { fileCount: 2, totalBytes: 100 };
      };
      api.deleteAllAudio = async () => ({ deleted: 3, failed: true });
      const clearButton = () =>
        observed.buttons.findLast(
          (button) => button.children === "settingsPage.privacy.clearAllAudio"
        );
      assert.equal(clearButton().disabled, false);
      await React.act(async () => clearButton().onClick());
      assert.equal(usageReads, 1);
      assert.deepEqual(observed.toasts.at(-1), { title: "common.error", variant: "destructive" });
      const usageRow = () =>
        observed.rows.findLast((row) => row.label === "settingsPage.privacy.audioStorageUsage");
      assert.equal(usageRow().description, "settingsPage.privacy.audioStorageFiles:2");
      await React.act(async () => resolveOldUsage({ fileCount: 20, totalBytes: 2000 }));
      assert.equal(
        usageRow().description,
        "settingsPage.privacy.audioStorageFiles:2",
        "old mount usage cannot overwrite post-delete evidence"
      );
      assert.equal(clearButton().disabled, false);
      api.deleteAllAudio = async () => ({ deleted: 2, failed: false });
      api.getAudioStorageUsage = async () => ({ fileCount: 0, totalBytes: 0 });
      await React.act(async () => clearButton().onClick());
      assert.deepEqual(observed.toasts.at(-1), {
        title: "settingsPage.privacy.clearAllAudio",
        variant: "default",
      });
      assert.equal(usageRow().description, "settingsPage.privacy.audioStorageEmpty");
      assert.equal(clearButton().disabled, true);
      await React.act(async () => root.unmount());
      root = null;
    }
  );
});
