const AUTHORIZATION_BOUNDARY_CHANGED = "AUTHORIZATION_BOUNDARY_CHANGED";
const MANAGED_CONFIG_UNAVAILABLE = "MANAGED_CONFIG_UNAVAILABLE";
const MANAGED_MODEL_REQUIRED = "MANAGED_MODEL_REQUIRED";
const POLICY_RESTRICTED = "POLICY_RESTRICTED";
const { compareAppVersions } = require("./appVersion");

function authorizationError(code, message) {
  return Object.assign(new Error(message), { code });
}

function normalizeModel(model) {
  return typeof model === "string" && model.length > 0 ? model : null;
}

function createBinding(context, requestedMode, requestedProvider, requestedModel) {
  return Object.freeze({
    accountId: context?.accountId ?? null,
    workspaceId: context?.workspaceId ?? null,
    authGeneration: context?.authGeneration ?? null,
    configGeneration: context?.configGeneration ?? null,
    policyRevision: context?.policyRevision ?? null,
    category: "transcription",
    transcriptionMode: requestedMode,
    provider: requestedProvider,
    model: normalizeModel(requestedModel),
    managed: context?.managed === true,
  });
}

function assertCurrentContext(
  context,
  requestedMode,
  requestedProvider,
  requestedModel,
  currentAuthGeneration
) {
  if (
    !context ||
    context.category !== "transcription" ||
    typeof context.accountId !== "string" ||
    typeof context.workspaceId !== "string" ||
    !Number.isSafeInteger(context.policyRevision) ||
    typeof context.provider !== "string" ||
    context.authGeneration !== currentAuthGeneration ||
    context.transcriptionMode !== requestedMode ||
    context.provider !== requestedProvider ||
    context.model !== normalizeModel(requestedModel)
  ) {
    throw authorizationError(
      AUTHORIZATION_BOUNDARY_CHANGED,
      "Transcription authorization changed. Retry the request."
    );
  }
}

function policyProvider(requestedProvider) {
  if (requestedProvider === "openai-realtime") return "openai";
  if (requestedProvider === "tinfoil-realtime") return "tinfoil";
  return requestedProvider.replace(/-realtime$/, "");
}

async function assertWorkspacePolicy({
  context,
  requestedMode,
  requestedProvider,
  resolvePolicy,
  currentAppVersion,
}) {
  let resolved;
  try {
    resolved = await resolvePolicy(context);
  } catch {
    throw authorizationError(
      POLICY_RESTRICTED,
      "Transcription is restricted by your workspace policy."
    );
  }
  if (!resolved?.success || typeof resolved.revision !== "number") {
    throw authorizationError(
      POLICY_RESTRICTED,
      "Transcription is restricted by your workspace policy."
    );
  }
  if (
    resolved.accountId !== context.accountId ||
    resolved.authGeneration !== context.authGeneration ||
    resolved.revision !== context.policyRevision
  ) {
    throw authorizationError(
      AUTHORIZATION_BOUNDARY_CHANGED,
      "Transcription authorization changed. Retry the request."
    );
  }
  if (!resolved.managed) return resolved;
  const transcription = resolved.policy?.transcription;
  if (
    (resolved.policy?.minAppVersion &&
      compareAppVersions(currentAppVersion, resolved.policy.minAppVersion) < 0) ||
    !transcription?.allowedModes?.includes(requestedMode) ||
    (requestedMode === "providers" &&
      !transcription.allowedByokProviders?.includes(policyProvider(requestedProvider)))
  ) {
    throw authorizationError(
      POLICY_RESTRICTED,
      "Transcription is restricted by your workspace policy."
    );
  }
  return resolved;
}

function assertResolvedIdentity(context, resolved) {
  if (
    resolved.accountId !== context.accountId ||
    resolved.workspaceId !== context.workspaceId ||
    resolved.authGeneration !== context.authGeneration
  ) {
    throw authorizationError(
      AUTHORIZATION_BOUNDARY_CHANGED,
      "Transcription authorization changed. Retry the request."
    );
  }
}

async function authorizeManagedTranscription({
  context,
  requestedMode,
  requestedProvider,
  requestedModel,
  currentAuthGeneration,
  currentAppVersion,
  resolveConfig,
  resolvePolicy,
}) {
  if (currentAuthGeneration === null) {
    if (
      context &&
      (context.managed !== false ||
        context.category !== "transcription" ||
        context.accountId !== null ||
        context.workspaceId !== null ||
        context.authGeneration !== null ||
        context.configGeneration !== null ||
        context.policyRevision !== null ||
        context.transcriptionMode !== requestedMode ||
        typeof context.provider !== "string" ||
        context.provider !== requestedProvider ||
        context.model !== normalizeModel(requestedModel))
    ) {
      throw authorizationError(
        AUTHORIZATION_BOUNDARY_CHANGED,
        "Transcription authorization changed. Retry the request."
      );
    }
    return createBinding(context, requestedMode, requestedProvider, requestedModel);
  }

  assertCurrentContext(
    context,
    requestedMode,
    requestedProvider,
    requestedModel,
    currentAuthGeneration
  );

  let resolved;
  try {
    resolved = await resolveConfig(context);
  } catch (cause) {
    throw authorizationError(
      MANAGED_CONFIG_UNAVAILABLE,
      "Managed transcription configuration is unavailable."
    );
  }

  if (!resolved || typeof resolved !== "object") {
    throw authorizationError(
      MANAGED_CONFIG_UNAVAILABLE,
      "Managed transcription configuration is unavailable."
    );
  }

  assertResolvedIdentity(context, resolved);
  let enterpriseAuthorized = false;
  if (!resolved.success) {
    if (
      resolved.enforcementRequired === false &&
      context.managed === false &&
      context.configGeneration === null
    ) {
      enterpriseAuthorized = true;
    } else if (resolved.enforcementRequired === false) {
      throw authorizationError(
        AUTHORIZATION_BOUNDARY_CHANGED,
        "Transcription authorization changed. Retry the request."
      );
    } else {
      throw authorizationError(
        MANAGED_CONFIG_UNAVAILABLE,
        "Managed transcription configuration is unavailable."
      );
    }
  } else {
    if (
      resolved.config?.workspaceId !== context.workspaceId ||
      resolved.config?.generation !== context.configGeneration
    ) {
      throw authorizationError(
        AUTHORIZATION_BOUNDARY_CHANGED,
        "Transcription authorization changed. Retry the request."
      );
    }

    const approvedModels = resolved.config.localModels?.transcription || [];
    if (approvedModels.length === 0) {
      if (context.managed === false) enterpriseAuthorized = true;
      else {
        throw authorizationError(
          AUTHORIZATION_BOUNDARY_CHANGED,
          "Transcription authorization changed. Retry the request."
        );
      }
    } else {
      const approved = approvedModels.some(
        (selection) =>
          selection.provider === requestedProvider &&
          selection.modelId === normalizeModel(requestedModel)
      );
      if (context.managed !== true || !approved) {
        throw authorizationError(
          MANAGED_MODEL_REQUIRED,
          "A workspace-managed local transcription model is required."
        );
      }
      enterpriseAuthorized = true;
    }
  }
  if (!enterpriseAuthorized) {
    throw authorizationError(
      MANAGED_CONFIG_UNAVAILABLE,
      "Managed transcription configuration is unavailable."
    );
  }
  await assertWorkspacePolicy({
    context,
    requestedMode,
    requestedProvider,
    resolvePolicy,
    currentAppVersion,
  });
  return createBinding(context, requestedMode, requestedProvider, requestedModel);
}

module.exports = {
  AUTHORIZATION_BOUNDARY_CHANGED,
  MANAGED_CONFIG_UNAVAILABLE,
  MANAGED_MODEL_REQUIRED,
  POLICY_RESTRICTED,
  authorizeManagedTranscription,
};
