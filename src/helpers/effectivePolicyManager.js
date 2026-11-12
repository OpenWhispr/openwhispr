const { compareAppVersions } = require("./appVersion");
const { isValidPolicyShape } = require("./policyValidation");

function mergePolicies(policies) {
  if (!policies.length) return null;
  if (policies.some((policy) => !isValidPolicyShape(policy)))
    throw new Error("Invalid policy source");
  const intersect = (lists) =>
    lists.reduce((result, list) => result.filter((item) => list.includes(item)));
  const modes = (scope) => intersect(policies.map((policy) => policy[scope].allowedModes));
  const restrictive = (values, order) => order.find((value) => values.includes(value));
  const caps = policies
    .map((policy) => policy.dataRetention.audioRetentionMaxDays)
    .filter((value) => value !== null);
  const versions = policies.map((policy) => policy.minAppVersion).filter(Boolean);
  // Null is unrestricted, so only the lists that restrict are intersected.
  const localModels = (scope) => {
    const lists = policies.map((policy) => policy[scope].allowedLocalModels).filter(Boolean);
    return lists.length ? intersect(lists) : null;
  };
  // Absent means allowed, for the flags this build knows and any it doesn't.
  const features = [...new Set(policies.flatMap((policy) => Object.keys(policy.features)))];
  return {
    version: 1,
    transcription: {
      allowedLocalModels: localModels("transcription"),
      allowedModes: modes("transcription"),
      allowedByokProviders: intersect(
        policies.map((policy) => policy.transcription.allowedByokProviders)
      ),
      allowedEnterpriseProviders: intersect(
        policies.map((policy) => policy.transcription.allowedEnterpriseProviders ?? [])
      ),
    },
    llm: {
      allowedLocalModels: localModels("llm"),
      allowedModes: modes("llm"),
      allowedByokProviders: intersect(policies.map((policy) => policy.llm.allowedByokProviders)),
      allowedEnterpriseProviders: intersect(
        policies.map((policy) => policy.llm.allowedEnterpriseProviders)
      ),
    },
    features: Object.fromEntries(
      features.map((feature) => [
        feature,
        policies.every((policy) => policy.features[feature] !== false),
      ])
    ),
    // Any start other than automatic, known to this build or not, is manual.
    meetings: {
      transcriptionStart:
        policies
          .map((policy) => policy.meetings?.transcriptionStart ?? "automatic")
          .find((start) => start !== "automatic") ?? "automatic",
    },
    sharing: {
      externalLinkSharing: restrictive(
        policies.map((policy) => policy.sharing.externalLinkSharing),
        ["disabled", "domain_only", "allowed"]
      ),
    },
    dataRetention: {
      audioRetentionMaxDays: caps.length ? Math.min(...caps) : null,
      localHistoryMode: restrictive(
        policies.map((policy) => policy.dataRetention.localHistoryMode),
        ["always_off", "always_on", "user_choice"]
      ),
      cloudBackupAllowed: policies.every((policy) => policy.dataRetention.cloudBackupAllowed),
    },
    requiredLocalModels: [
      ...new Set(policies.flatMap((policy) => policy.requiredLocalModels ?? [])),
    ].sort(),
    minAppVersion: versions.length
      ? versions.reduce((a, b) => (compareAppVersions(a, b) >= 0 ? a : b))
      : null,
    updates: {
      mode:
        restrictive(
          policies.map((policy) => policy.updates?.mode ?? "user_choice"),
          ["it_managed", "always_on", "user_choice"]
        ) ?? "user_choice",
    },
  };
}

function localOnlyPolicy(policy) {
  const result = structuredClone(policy);
  for (const scope of ["transcription", "llm"]) {
    result[scope].allowedModes = result[scope].allowedModes.filter((mode) => mode === "local");
    result[scope].allowedByokProviders = [];
    result[scope].allowedEnterpriseProviders = [];
  }
  result.features.webSearchEnabled = false;
  result.features.connectorsEnabled = false;
  result.sharing.externalLinkSharing = "disabled";
  result.dataRetention.cloudBackupAllowed = false;
  return result;
}

const ABSENT_DEVICE = { status: "absent", managed: false, policy: null };

function resolveEffectivePolicy(device, workspace, scope) {
  const metadata = {
    accountId: scope.accountId,
    authGeneration: scope.authGeneration,
    deviceManaged: device.managed === true,
    workspaceManaged: workspace?.managed === true,
    workspaceRequired: scope.authenticated,
    deviceReady: device.status !== "loading",
    requireSignIn: device.requireSignIn === true,
    localOnly: device.localOnly === true,
  };
  // On a failure `managed` is the evidence that something manages this
  // identity: a device policy, a server that called its policy unresolvable,
  // or a failed lookup for an account last seen managed. Without it a failed
  // lookup restricts nothing: the identity is unmanaged, for updates as for
  // everything else. Only the first two settle the verdict.
  const settledManaged = device.managed === true || workspace?.code === "POLICY_UNRESOLVABLE";
  const managed = settledManaged || workspace?.managed === true;
  const failure = (status, code, policy = null) => ({
    ...metadata,
    success: false,
    status,
    managed,
    policy,
    code,
  });
  if (device.status === "loading") return failure("loading", "DEVICE_POLICY_LOADING");
  if (device.status === "invalid") return failure("error", "DEVICE_POLICY_INVALID");
  try {
    let policy = mergePolicies([
      ...(device.managed ? [device.policy] : []),
      ...(workspace?.success && workspace.managed ? [workspace.policy] : []),
    ]);
    if (policy && device.localOnly) policy = localOnlyPolicy(policy);
    if (scope.authenticated && !workspace) return failure("loading", "POLICY_LOADING", policy);
    // The device's restrictions are known even while this credential's
    // workspace verdict is not. Only that unknown source remains pending.
    if (scope.authenticated && !workspace.success && managed)
      return failure(
        settledManaged ? "error" : "loading",
        workspace.code ?? "POLICY_UNRESOLVABLE",
        settledManaged ? null : policy
      );
    if (!scope.authenticated && device.requireSignIn)
      return failure("error", "POLICY_SIGN_IN_REQUIRED");
    return {
      ...metadata,
      success: true,
      status: policy ? "managed" : "unmanaged",
      managed: Boolean(policy),
      policy,
      policyUpdatedAt: workspace?.policyUpdatedAt ?? null,
    };
  } catch {
    return failure("error", "POLICY_UNRESOLVABLE");
  }
}

// What the updater obeys. A device policy that can't be read contributes
// nothing, and as it also keeps the workspace off the network, its held
// verdict or none decides.
function resolveUpdatePolicy(device, workspace, scope) {
  const invalidDevice = device.status === "invalid";
  return resolveEffectivePolicy(
    invalidDevice ? ABSENT_DEVICE : device,
    invalidDevice ? (workspace ?? { success: false }) : workspace,
    scope
  );
}

function createEffectivePolicyManager({
  devicePolicy,
  workspacePolicyManager,
  getScope,
  broadcast = () => {},
}) {
  let workspace = null;
  let current = null;
  let updates = null;
  let signature;
  let revision = 0;
  const workspaceFor = (scope) =>
    workspace?.accountId === scope.accountId && workspace?.authGeneration === scope.authGeneration
      ? workspace
      : null;
  function getCurrent() {
    const scope = getScope();
    const device = devicePolicy.getSnapshot();
    const next = resolveEffectivePolicy(device, workspaceFor(scope), scope);
    if (
      next.status === "loading" &&
      next.deviceReady &&
      next.accountId !== null &&
      next.accountId === current?.accountId
    ) {
      next.policy = mergePolicies([current.policy, next.policy].filter(Boolean));
      if (next.policy) {
        next.managed = true;
        next.workspaceManaged ||= current.workspaceManaged;
      }
    }
    const nextUpdates = resolveUpdatePolicy(device, workspaceFor(scope), scope);
    const nextSignature = JSON.stringify([next, nextUpdates]);
    if (nextSignature !== signature) {
      signature = nextSignature;
      revision += 1;
      current = { ...next, revision };
      updates = { ...nextUpdates, revision };
      broadcast(current, updates);
    }
    return current;
  }
  function updateWorkspace(snapshot) {
    const scope = getScope();
    if (snapshot.accountId !== scope.accountId || snapshot.authGeneration !== scope.authGeneration)
      return;
    // A failed lookup says nothing new about a verdict already held, nor
    // lifts one the server called unresolvable: only the server calling it
    // unresolvable replaces a held verdict with a failure.
    if (
      !snapshot.success &&
      snapshot.code !== "POLICY_UNRESOLVABLE" &&
      (workspace?.success || workspace?.code === "POLICY_UNRESOLVABLE") &&
      workspace.accountId === snapshot.accountId &&
      workspace.authGeneration === snapshot.authGeneration
    )
      return;
    workspace = snapshot;
    getCurrent();
  }
  const unsubscribe = devicePolicy.subscribe(() => getCurrent());
  return {
    getCurrent,
    getUpdatePolicy() {
      getCurrent();
      return updates;
    },
    updateWorkspace,
    invalidate() {
      workspace = null;
      return getCurrent();
    },
    // `held` reads only what is already held for the identity. So does a
    // device that keeps it local or whose policy can't be read: neither
    // contacts the server. Otherwise an identity with no verdict yet (just
    // started, or invalidated) takes the one it last had while the network
    // refreshes it.
    async getPolicy({ held = false, ...request } = {}) {
      const device = devicePolicy.getSnapshot();
      if (device.status === "loading") return getCurrent();
      const scope = getScope();
      if (scope.authenticated) {
        const offline = held || device.localOnly || device.status === "invalid";
        const result =
          offline || !workspaceFor(scope) ? workspacePolicyManager.heldPolicy(request) : null;
        if (result) updateWorkspace(result);
        else if (device.localOnly)
          updateWorkspace({
            success: false,
            code: "POLICY_UNRESOLVABLE",
            accountId: scope.accountId,
            authGeneration: scope.authGeneration,
          });
        if (!offline) updateWorkspace(await workspacePolicyManager.getPolicy(request));
      }
      return getCurrent();
    },
    peekPolicy(request = {}) {
      const scope = getScope();
      if (
        scope.authenticated &&
        (request.accountId !== scope.accountId ||
          request.expectedAuthGeneration !== scope.authGeneration)
      )
        return null;
      return getCurrent();
    },
    stop: unsubscribe,
  };
}

module.exports = {
  createEffectivePolicyManager,
  localOnlyPolicy,
  mergePolicies,
  resolveEffectivePolicy,
  resolveUpdatePolicy,
};
