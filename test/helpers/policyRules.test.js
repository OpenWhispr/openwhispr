const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/stores/policyRules.ts");

const policy = {
  version: 1,
  transcription: {
    allowedModes: ["openwhispr", "local"],
    allowedByokProviders: ["openai"],
  },
  llm: {
    allowedModes: ["openwhispr", "providers"],
    allowedByokProviders: ["openai"],
    allowedEnterpriseProviders: [],
  },
  features: { agentEnabled: true, webSearchEnabled: true },
  sharing: { externalLinkSharing: "allowed" },
  dataRetention: {
    audioRetentionMaxDays: null,
    localHistoryMode: "user_choice",
    cloudBackupAllowed: true,
  },
  minAppVersion: null,
};

test("update-required derives from the org minimum and known app version", async () => {
  const { isUpdateRequiredByOrg } = await load();
  const managedWithMin = (minAppVersion, appVersion) => ({
    status: "managed",
    policy: { ...policy, minAppVersion },
    appVersion,
  });

  assert.equal(isUpdateRequiredByOrg(managedWithMin("2.0.0", "1.8.1")), true);
  assert.equal(isUpdateRequiredByOrg(managedWithMin("1.0.0", "1.8.1")), false);
  assert.equal(isUpdateRequiredByOrg(managedWithMin(null, "1.8.1")), false);
  assert.equal(isUpdateRequiredByOrg(managedWithMin("2.0.0", null)), false);
  assert.equal(
    isUpdateRequiredByOrg({ status: "unmanaged", policy: null, appVersion: "1.8.1" }),
    false
  );
});

test("allows guests and resolved unmanaged accounts", async () => {
  const { isPolicyActionAllowed } = await load();

  assert.equal(isPolicyActionAllowed({ status: "idle", policy: null, appVersion: null }), true);
  assert.equal(
    isPolicyActionAllowed({ status: "unmanaged", policy: null, appVersion: null }),
    true
  );
});

test("blocks authenticated actions while policy is loading or unavailable", async () => {
  const { isPolicyActionAllowed } = await load();

  assert.equal(
    isPolicyActionAllowed({ status: "loading", policy: null, appVersion: "1.8.1" }),
    false
  );
  assert.equal(
    isPolicyActionAllowed({ status: "error", policy: null, appVersion: "1.8.1" }),
    false
  );
});

test("enforces the managed minimum app version", async () => {
  const { isPolicyActionAllowed } = await load();
  const versionedPolicy = { ...policy, minAppVersion: "1.9.0" };

  assert.equal(
    isPolicyActionAllowed({ status: "managed", policy: versionedPolicy, appVersion: "1.8.1" }),
    false
  );
  assert.equal(
    isPolicyActionAllowed({ status: "managed", policy: versionedPolicy, appVersion: "1.9.0" }),
    true
  );
  assert.equal(
    isPolicyActionAllowed({ status: "managed", policy: versionedPolicy, appVersion: null }),
    false
  );
});

test("mode and provider decisions fail closed for empty allowlists", async () => {
  const { isModeAllowedByPolicy, isProviderAllowedByPolicy } = await load();
  const emptyPolicy = {
    ...policy,
    transcription: { allowedModes: [], allowedByokProviders: [] },
  };
  const snapshot = { status: "managed", policy: emptyPolicy, appVersion: "1.8.1" };

  assert.equal(isModeAllowedByPolicy(snapshot, "transcription", "local"), false);
  assert.equal(isProviderAllowedByPolicy(snapshot, "transcription", "openai"), false);
});

test("managed mode lists hide denied options while unmanaged lists remain unchanged", async () => {
  const { filterModeOptionsByPolicy } = await load();
  const options = [
    { id: "openwhispr", label: "Cloud" },
    { id: "providers", label: "Providers" },
    { id: "local", label: "Local" },
    { id: "self-hosted", label: "Self-hosted" },
  ];
  const managed = { status: "managed", policy, appVersion: "1.8.1" };
  const unmanaged = { status: "unmanaged", policy: null, appVersion: "1.8.1" };

  assert.deepEqual(
    filterModeOptionsByPolicy(options, "transcription", managed).map((option) => option.id),
    ["openwhispr", "local"]
  );
  assert.deepEqual(filterModeOptionsByPolicy(options, "transcription", unmanaged), options);
});

test("provider-backed modes are hidden when their provider allowlist is empty", async () => {
  const { filterModeOptionsByPolicy, reconcilePolicyModeSelection } = await load();
  const noProviderPolicy = {
    ...policy,
    transcription: { allowedModes: ["providers", "local"], allowedByokProviders: [] },
    llm: {
      allowedModes: ["enterprise", "local"],
      allowedByokProviders: [],
      allowedEnterpriseProviders: [],
    },
  };
  const managed = { status: "managed", policy: noProviderPolicy, appVersion: "1.8.1" };
  const transcriptionOptions = [{ id: "providers" }, { id: "local" }];
  const llmOptions = [{ id: "enterprise" }, { id: "local" }];

  assert.deepEqual(
    filterModeOptionsByPolicy(transcriptionOptions, "transcription", managed).map(
      (option) => option.id
    ),
    ["local"]
  );
  assert.deepEqual(
    filterModeOptionsByPolicy(llmOptions, "llm", managed).map((option) => option.id),
    ["local"]
  );
  assert.equal(
    reconcilePolicyModeSelection(transcriptionOptions, "transcription", managed, "providers"),
    "local"
  );
});

test("provider-backed modes are hidden when policy providers are unavailable in the surface", async () => {
  const { filterModeOptionsByPolicy, reconcilePolicyModeSelection } = await load();
  const unknownProviderPolicy = {
    ...policy,
    transcription: {
      allowedModes: ["providers", "local"],
      allowedByokProviders: ["server-only-provider"],
    },
  };
  const snapshot = {
    status: "managed",
    policy: unknownProviderPolicy,
    appVersion: "1.8.1",
  };
  const options = [{ id: "providers" }, { id: "local" }];
  const catalog = { byokProviders: ["openai", "custom"] };

  assert.deepEqual(
    filterModeOptionsByPolicy(options, "transcription", snapshot, catalog).map(
      (option) => option.id
    ),
    ["local"]
  );
  assert.equal(
    reconcilePolicyModeSelection(options, "transcription", snapshot, "providers", catalog),
    "local"
  );
});

test("enterprise mode stays hidden when policy allows only unavailable desktop providers", async () => {
  const { filterModeOptionsByPolicy } = await load();
  const unavailableEnterprisePolicy = {
    ...policy,
    llm: {
      allowedModes: ["enterprise"],
      allowedByokProviders: [],
      allowedEnterpriseProviders: ["vertex"],
    },
  };

  assert.deepEqual(
    filterModeOptionsByPolicy([{ id: "enterprise" }], "llm", {
      status: "managed",
      policy: unavailableEnterprisePolicy,
      appVersion: "1.8.1",
    }),
    []
  );
});

test("denied managed modes fall back in visible catalog order", async () => {
  const { reconcilePolicyModeSelection } = await load();
  const options = [
    { id: "openwhispr" },
    { id: "providers" },
    { id: "local" },
    { id: "self-hosted" },
  ];
  const managed = { status: "managed", policy, appVersion: "1.8.1" };

  assert.equal(
    reconcilePolicyModeSelection(options, "transcription", managed, "providers"),
    "openwhispr"
  );
  assert.equal(reconcilePolicyModeSelection(options, "transcription", managed, "local"), null);
});

test("mode fallback skips unavailable choices and never invents an empty-allowlist choice", async () => {
  const { reconcilePolicyModeSelection } = await load();
  const options = [{ id: "openwhispr", disabled: true }, { id: "local" }];
  const managed = { status: "managed", policy, appVersion: "1.8.1" };
  const emptyPolicy = {
    ...policy,
    transcription: { allowedModes: [], allowedByokProviders: [] },
  };

  assert.equal(
    reconcilePolicyModeSelection(options, "transcription", managed, "providers"),
    "local"
  );
  assert.equal(
    reconcilePolicyModeSelection(
      options,
      "transcription",
      { status: "managed", policy: emptyPolicy, appVersion: "1.8.1" },
      "providers"
    ),
    null
  );
});

test("managed provider lists hide denied BYOK and enterprise providers", async () => {
  const { filterByokProviderOptionsByPolicy, filterEnterpriseProviderOptionsByPolicy } =
    await load();
  const byokOptions = [{ id: "openai" }, { id: "groq" }, { id: "custom" }];
  const enterpriseOptions = [{ id: "bedrock" }, { id: "azure" }];
  const managed = { status: "managed", policy, appVersion: "1.8.1" };

  assert.deepEqual(
    filterByokProviderOptionsByPolicy(byokOptions, "llm", managed).map((option) => option.id),
    ["openai"]
  );
  assert.deepEqual(filterEnterpriseProviderOptionsByPolicy(enterpriseOptions, managed), []);
});

test("provider fallback preserves an allowed selection and chooses the first visible alternative", async () => {
  const { reconcileProviderSelection } = await load();
  const allowedProviders = [{ id: "bedrock" }, { id: "azure", disabled: true }];

  assert.equal(reconcileProviderSelection("bedrock", allowedProviders), null);
  assert.equal(reconcileProviderSelection("vertex", allowedProviders), "bedrock");
  assert.equal(reconcileProviderSelection("vertex", []), null);
});

test("effective managed selections use allowed modes and providers without changing unmanaged choices", async () => {
  const { resolveEffectivePolicySelection } = await load();
  const managed = { status: "managed", policy, appVersion: "1.8.1" };
  const unmanaged = { status: "unmanaged", policy: null, appVersion: "1.8.1" };
  const catalog = {
    modes: ["openwhispr", "providers", "local", "self-hosted"],
    byokProviders: ["openai", "groq", "custom"],
  };

  assert.deepEqual(
    resolveEffectivePolicySelection(
      managed,
      "transcription",
      { mode: "providers", provider: "groq" },
      catalog
    ),
    { mode: "openwhispr", provider: "groq" }
  );
  assert.deepEqual(
    resolveEffectivePolicySelection(
      unmanaged,
      "transcription",
      { mode: "providers", provider: "groq" },
      catalog
    ),
    { mode: "providers", provider: "groq" }
  );
});

test("effective managed provider selection falls back inside an allowed provider mode", async () => {
  const { resolveEffectivePolicySelection } = await load();
  const providersPolicy = {
    ...policy,
    transcription: {
      allowedModes: ["providers"],
      allowedByokProviders: ["openai"],
    },
  };

  assert.deepEqual(
    resolveEffectivePolicySelection(
      { status: "managed", policy: providersPolicy, appVersion: "1.8.1" },
      "transcription",
      { mode: "providers", provider: "groq" },
      {
        modes: ["openwhispr", "providers", "local", "self-hosted"],
        byokProviders: ["openai", "groq", "custom"],
      }
    ),
    { mode: "providers", provider: "openai" }
  );
});

test("effective selection skips policy providers unavailable to a narrower surface", async () => {
  const { resolveEffectivePolicySelection } = await load();
  const meetingPolicy = {
    ...policy,
    transcription: {
      allowedModes: ["providers", "local"],
      allowedByokProviders: ["groq"],
    },
  };

  assert.deepEqual(
    resolveEffectivePolicySelection(
      { status: "managed", policy: meetingPolicy, appVersion: "1.8.1" },
      "transcription",
      { mode: "providers", provider: "groq" },
      {
        modes: ["openwhispr", "providers", "local", "self-hosted"],
        byokProviders: ["openai", "corti", "tinfoil"],
      }
    ),
    { mode: "local", provider: "groq" }
  );

  assert.deepEqual(
    resolveEffectivePolicySelection(
      { status: "managed", policy: meetingPolicy, appVersion: "1.8.1" },
      "transcription",
      { mode: "self-hosted", provider: "openai" },
      {
        modes: ["openwhispr", "providers", "local"],
        byokProviders: ["openai", "corti", "tinfoil"],
      }
    ),
    { mode: "local", provider: "openai" }
  );
});

test("empty managed scope allowlists make that scope unavailable", async () => {
  const { isLlmSelectionAllowed } = await load();
  const emptyLlmPolicy = {
    ...policy,
    llm: { allowedModes: [], allowedByokProviders: [], allowedEnterpriseProviders: [] },
  };
  const snapshot = { status: "managed", policy: emptyLlmPolicy, appVersion: "1.8.1" };

  assert.equal(isLlmSelectionAllowed(snapshot, { mode: "providers", provider: "openai" }), false);
  assert.equal(
    isLlmSelectionAllowed(
      { status: "unmanaged", policy: null, appVersion: null },
      { mode: "providers", provider: "openai" }
    ),
    true
  );
});

test("LLM dispatch requires an allowed mode and provider", async () => {
  const { isLlmSelectionAllowed } = await load();
  const noProviderPolicy = {
    ...policy,
    llm: {
      allowedModes: ["providers", "local"],
      allowedByokProviders: [],
      allowedEnterpriseProviders: [],
    },
  };
  const snapshot = { status: "managed", policy: noProviderPolicy, appVersion: "1.8.1" };

  assert.equal(isLlmSelectionAllowed(snapshot, { mode: "providers", provider: "openai" }), false);
  assert.equal(isLlmSelectionAllowed(snapshot, { mode: "local", provider: "local" }), true);
  assert.equal(isLlmSelectionAllowed(snapshot, { mode: "enterprise", provider: "bedrock" }), false);
});

test("blocks transcription contexts whose stored mode is disallowed", async () => {
  const { isTranscriptionSelectionAllowed } = await load();
  const snapshot = { status: "managed", policy, appVersion: "1.8.1" };

  assert.equal(
    isTranscriptionSelectionAllowed(snapshot, { mode: "self-hosted", provider: "" }),
    false
  );
  assert.equal(isTranscriptionSelectionAllowed(snapshot, { mode: "local", provider: "" }), true);
});

test("blocks BYOK transcription when no provider is allowed", async () => {
  const { isTranscriptionSelectionAllowed } = await load();
  const noProviderPolicy = {
    ...policy,
    transcription: { allowedModes: ["providers"], allowedByokProviders: [] },
  };
  const snapshot = { status: "managed", policy: noProviderPolicy, appVersion: "1.8.1" };

  assert.equal(
    isTranscriptionSelectionAllowed(snapshot, { mode: "providers", provider: "openai" }),
    false
  );
});

test("does not require a BYOK provider for local transcription", async () => {
  const { isTranscriptionSelectionAllowed } = await load();
  const localOnlyPolicy = {
    ...policy,
    transcription: { allowedModes: ["local"], allowedByokProviders: [] },
  };
  const snapshot = { status: "managed", policy: localOnlyPolicy, appVersion: "1.8.1" };

  assert.equal(
    isTranscriptionSelectionAllowed(snapshot, { mode: "local", provider: "openai" }),
    true
  );
});

test("domain-only sharing permits only private recovery and domain visibility", async () => {
  const { isShareActionAllowed, isShareVisibilityAllowed } = await load();
  const snapshot = {
    status: "managed",
    policy: {
      ...policy,
      sharing: { externalLinkSharing: "domain_only" },
    },
    appVersion: "1.8.1",
  };

  assert.equal(isShareVisibilityAllowed(snapshot, "private"), true);
  assert.equal(isShareVisibilityAllowed(snapshot, "domain"), true);
  assert.equal(isShareVisibilityAllowed(snapshot, "invited"), false);
  assert.equal(isShareVisibilityAllowed(snapshot, "link"), false);
  assert.equal(isShareActionAllowed(snapshot, "copy-link", "link"), false);
  assert.equal(isShareActionAllowed(snapshot, "rotate-link", "link"), false);
  assert.equal(isShareActionAllowed(snapshot, "invite", "private"), false);
  // A domain share's link stays copyable — it is scoped to the allowed domain.
  assert.equal(isShareActionAllowed(snapshot, "copy-link", "domain"), true);
  assert.equal(isShareActionAllowed(snapshot, "rotate-link", "domain"), true);
  assert.equal(isShareActionAllowed(snapshot, "copy-link", "invited"), false);
});

test("share visibility lists hide policy-denied choices", async () => {
  const { filterShareVisibilityOptions } = await load();
  const options = [{ id: "private" }, { id: "invited" }, { id: "link" }, { id: "domain" }];
  const domainOnlyPolicy = {
    ...policy,
    sharing: { externalLinkSharing: "domain_only" },
  };
  const disabledPolicy = {
    ...policy,
    sharing: { externalLinkSharing: "disabled" },
  };

  assert.deepEqual(
    filterShareVisibilityOptions(options, {
      status: "managed",
      policy: domainOnlyPolicy,
      appVersion: "1.8.1",
    }).map((option) => option.id),
    ["private", "domain"]
  );
  assert.deepEqual(
    filterShareVisibilityOptions(options, {
      status: "managed",
      policy: disabledPolicy,
      appVersion: "1.8.1",
    }).map((option) => option.id),
    ["private"]
  );
});

test("domain-only sharing is usable only when the owner can offer a domain choice", async () => {
  const { hasUsableExternalShareVisibility } = await load();
  const snapshot = {
    status: "managed",
    policy: { ...policy, sharing: { externalLinkSharing: "domain_only" } },
    appVersion: "1.8.1",
  };

  assert.equal(hasUsableExternalShareVisibility(snapshot, true), true);
  assert.equal(hasUsableExternalShareVisibility(snapshot, false), false);
});

test("provider fallback persistence is limited to resolved unmanaged and signed-out idle users", async () => {
  const { shouldPersistProviderFallback } = await load();

  assert.equal(
    shouldPersistProviderFallback({ status: "unmanaged", policy: null, appVersion: "1.8.1" }, true),
    true
  );
  assert.equal(
    shouldPersistProviderFallback({ status: "idle", policy: null, appVersion: null }, false),
    true
  );
  assert.equal(
    shouldPersistProviderFallback({ status: "idle", policy: null, appVersion: null }, true),
    false
  );
  assert.equal(
    shouldPersistProviderFallback({ status: "managed", policy, appVersion: "1.8.1" }, true),
    false
  );
});

test("copying an existing share link follows its own visibility", async () => {
  const { isShareActionAllowed } = await load();
  const unmanaged = { status: "unmanaged", policy: null, appVersion: "1.8.1" };
  const allowed = { status: "managed", policy, appVersion: "1.8.1" };

  for (const snapshot of [unmanaged, allowed]) {
    for (const visibility of ["link", "domain", "invited"]) {
      assert.equal(isShareActionAllowed(snapshot, "copy-link", visibility), true);
      assert.equal(isShareActionAllowed(snapshot, "rotate-link", visibility), true);
    }
    // Nothing to copy before a link exists; the dialog asks for create-link.
    assert.equal(isShareActionAllowed(snapshot, "copy-link", "private"), false);
  }
});

test("sharing recovery remains available when exposure-increasing actions are blocked", async () => {
  const { isShareActionAllowed } = await load();
  const blockedSnapshots = [
    { status: "loading", policy: null, appVersion: "1.8.1" },
    {
      status: "managed",
      policy: { ...policy, sharing: { externalLinkSharing: "disabled" } },
      appVersion: "1.8.1",
    },
    {
      status: "managed",
      policy: { ...policy, minAppVersion: "2.0.0" },
      appVersion: "1.8.1",
    },
  ];

  for (const snapshot of blockedSnapshots) {
    assert.equal(isShareActionAllowed(snapshot, "make-private", "link"), true);
    assert.equal(isShareActionAllowed(snapshot, "revoke-invitation", "invited"), true);
    assert.equal(isShareActionAllowed(snapshot, "remove-grant", "invited"), true);
    assert.equal(isShareActionAllowed(snapshot, "create-link", "private"), false);
  }
});

test("derives local history from policy without changing the personal preference", async () => {
  const { effectiveLocalHistoryEnabled } = await load();
  const unmanaged = { status: "unmanaged", policy: null, appVersion: "1.8.1" };
  const alwaysOn = {
    status: "managed",
    policy: {
      ...policy,
      dataRetention: { ...policy.dataRetention, localHistoryMode: "always_on" },
    },
    appVersion: "1.8.1",
  };
  const alwaysOff = {
    status: "managed",
    policy: {
      ...policy,
      dataRetention: { ...policy.dataRetention, localHistoryMode: "always_off" },
    },
    appVersion: "1.8.1",
  };

  assert.equal(effectiveLocalHistoryEnabled(unmanaged, false), false);
  assert.equal(effectiveLocalHistoryEnabled(unmanaged, true), true);
  assert.equal(effectiveLocalHistoryEnabled(alwaysOn, false), true);
  assert.equal(effectiveLocalHistoryEnabled(alwaysOff, true), false);
});

test("caps effective audio retention while preserving disabled and raw values", async () => {
  const { effectiveAudioRetentionDays } = await load();
  const unmanaged = { status: "unmanaged", policy: null, appVersion: "1.8.1" };
  const capped = {
    status: "managed",
    policy: {
      ...policy,
      dataRetention: { ...policy.dataRetention, audioRetentionMaxDays: 7 },
    },
    appVersion: "1.8.1",
  };

  assert.equal(effectiveAudioRetentionDays(unmanaged, 90), 90);
  assert.equal(effectiveAudioRetentionDays(capped, 90), 7);
  assert.equal(effectiveAudioRetentionDays(capped, 3), 3);
  assert.equal(effectiveAudioRetentionDays(capped, 0), 0);
});

test("an enabled cloud-backup preference can always be turned off", async () => {
  const { canChangeCloudBackupPreference } = await load();

  assert.equal(canChangeCloudBackupPreference(false, true), true);
  assert.equal(canChangeCloudBackupPreference(false, false), false);
  assert.equal(canChangeCloudBackupPreference(true, false), true);
});

test("re-entering providers mode replaces a dormant policy-disallowed provider", async () => {
  const { reconcileCloudProviderSelection } = await load();
  const allowedProviders = [
    { id: "openai", models: [{ id: "whisper-1" }] },
    { id: "mistral", models: [{ id: "voxtral-mini" }] },
  ];

  assert.deepEqual(
    reconcileCloudProviderSelection({
      selectedProvider: "groq",
      selectedModel: "whisper-large-v3",
      allowedProviders,
      customAllowed: false,
      hasCustomUrl: false,
    }),
    { provider: "openai", model: "whisper-1" }
  );
  assert.equal(
    reconcileCloudProviderSelection({
      selectedProvider: "mistral",
      selectedModel: "voxtral-mini",
      allowedProviders,
      customAllowed: false,
      hasCustomUrl: false,
    }),
    null
  );

  assert.deepEqual(
    reconcileCloudProviderSelection({
      selectedProvider: "openai",
      selectedModel: "whisper-large-v3",
      allowedProviders,
      customAllowed: false,
      hasCustomUrl: false,
    }),
    { provider: "openai", model: "whisper-1" }
  );

  assert.deepEqual(
    reconcileCloudProviderSelection({
      selectedProvider: "groq",
      selectedModel: "whisper-large-v3",
      allowedProviders: [],
      customAllowed: true,
      hasCustomUrl: false,
    }),
    { provider: "custom", model: "whisper-large-v3" }
  );
});

// The STT picker feeds reconcile the browsed tab (browsedCloudProvider ??
// selectedCloudProvider) while the committed pair stays untouched in the store.
test("a browsed provider resolves for display without leaking the committed model", async () => {
  const { reconcileCloudProviderSelection } = await load();
  const allowedProviders = [
    { id: "openai", models: [{ id: "whisper-1" }] },
    { id: "groq", models: [{ id: "whisper-large-v3" }] },
  ];

  // Browsing an allowed tab: the display lands on the browsed provider with
  // its own default — the committed model (openai's) never leaks into it.
  assert.deepEqual(
    reconcileCloudProviderSelection({
      selectedProvider: "groq",
      selectedModel: "whisper-1",
      allowedProviders,
      customAllowed: false,
      hasCustomUrl: false,
    }),
    { provider: "groq", model: "whisper-large-v3" }
  );

  // Browsing the Custom tab is always a valid input (null = no correction);
  // the caller must echo the browsed input, not the committed pair.
  assert.equal(
    reconcileCloudProviderSelection({
      selectedProvider: "custom",
      selectedModel: "whisper-1",
      allowedProviders,
      customAllowed: true,
      hasCustomUrl: false,
    }),
    null
  );

  // A browsed provider that policy has since disallowed falls back. The
  // component can't browse there directly (handleCloudProviderChange guards
  // providerAllowed); this state is only reachable when policy flips while
  // the tab is already being browsed.
  assert.deepEqual(
    reconcileCloudProviderSelection({
      selectedProvider: "xai",
      selectedModel: "whisper-1",
      allowedProviders,
      customAllowed: false,
      hasCustomUrl: false,
    }),
    { provider: "openai", model: "whisper-1" }
  );
});

test("active control-panel views reroute on their specific policy capability", async () => {
  const { isControlPanelViewAllowed } = await load();

  assert.equal(isControlPanelViewAllowed("chat", false, true), false);
  assert.equal(isControlPanelViewAllowed("chat", true, true), true);
  assert.equal(isControlPanelViewAllowed("upload", true, false), false);
  assert.equal(isControlPanelViewAllowed("upload", false, true), true);
  assert.equal(isControlPanelViewAllowed("home", false, false), true);
});

test("screen context is allowed unless a managed policy turns it off", async () => {
  const { isScreenContextAllowed } = await load();

  assert.equal(isScreenContextAllowed({ status: "idle", policy: null, appVersion: null }), true);
  assert.equal(
    isScreenContextAllowed({ status: "unmanaged", policy: null, appVersion: null }),
    true
  );
  // Fail closed while the managed verdict is unknown.
  assert.equal(
    isScreenContextAllowed({ status: "loading", policy: null, appVersion: null }),
    false
  );
  assert.equal(isScreenContextAllowed({ status: "error", policy: null, appVersion: null }), false);

  // The shared fixture omits the field — the old-server contract: allowed.
  assert.equal(isScreenContextAllowed({ status: "managed", policy, appVersion: null }), true);
  const withFlag = (screenContextEnabled) => ({
    status: "managed",
    policy: { ...policy, features: { ...policy.features, screenContextEnabled } },
    appVersion: null,
  });
  assert.equal(isScreenContextAllowed(withFlag(true)), true);
  assert.equal(isScreenContextAllowed(withFlag(false)), false);

  // An org-required update denies everything, screen context included.
  assert.equal(
    isScreenContextAllowed({
      status: "managed",
      policy: { ...policy, minAppVersion: "9.9.9" },
      appVersion: "1.8.1",
    }),
    false
  );
});

test("cloud-backup resume fires only on a denial-to-grant transition", async () => {
  const { cloudBackupResumed } = await load();
  const unmanaged = { status: "unmanaged", policy: null, appVersion: null };
  const loading = { status: "loading", policy: null, appVersion: null };
  const managedAllowed = { status: "managed", policy, appVersion: null };
  const managedDenied = {
    status: "managed",
    policy: {
      ...policy,
      dataRetention: { ...policy.dataRetention, cloudBackupAllowed: false },
    },
    appVersion: null,
  };

  assert.equal(cloudBackupResumed(managedDenied, managedAllowed), true);
  assert.equal(cloudBackupResumed(loading, unmanaged), true);
  assert.equal(cloudBackupResumed(managedAllowed, managedDenied), false);
  // A periodic refresh that keeps the grant unchanged must not kick a resync.
  assert.equal(cloudBackupResumed(unmanaged, unmanaged), false);
  assert.equal(cloudBackupResumed(managedAllowed, managedAllowed), false);
});

test("required local models resolve only for managed policies", async () => {
  const { requiredLocalModelIds } = await load();
  const required = ["base", "parakeet-tdt-0.6b-v3"];
  const managed = {
    status: "managed",
    policy: { ...policy, requiredLocalModels: required },
    appVersion: "1.9.0",
  };

  assert.deepEqual(requiredLocalModelIds(managed), required);
  for (const status of ["idle", "loading", "unmanaged", "error"]) {
    assert.deepEqual(requiredLocalModelIds({ status, policy: null, appVersion: null }), [], status);
  }
  // Absent field (older server) and empty list both mean nothing is required.
  assert.deepEqual(requiredLocalModelIds({ status: "managed", policy, appVersion: null }), []);
  assert.deepEqual(
    requiredLocalModelIds({
      status: "managed",
      policy: { ...policy, requiredLocalModels: [] },
      appVersion: null,
    }),
    []
  );
});

test("required local models drop ids the registry does not know, with a warning", async () => {
  const { requiredLocalModelIds } = await load();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const managed = {
      status: "managed",
      policy: {
        ...policy,
        requiredLocalModels: ["base", "a-model-from-the-future", "turbo", "base"],
      },
      appVersion: null,
    };
    // Unknown ids are filtered (forward compat) and duplicates collapse.
    assert.deepEqual(requiredLocalModelIds(managed), ["base", "turbo"]);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(
    warnings.some((line) => line.includes("a-model-from-the-future")),
    true
  );
});

test("missing required models is a pure set difference over disk truth", async () => {
  const { missingRequiredLocalModels } = await load();

  assert.deepEqual(missingRequiredLocalModels([], []), []);
  assert.deepEqual(missingRequiredLocalModels(["base"], []), ["base"]);
  assert.deepEqual(
    missingRequiredLocalModels(["base", "turbo"], ["turbo", "small"]),
    ["base"]
  );
  assert.deepEqual(missingRequiredLocalModels(["base"], ["base"]), []);
});
