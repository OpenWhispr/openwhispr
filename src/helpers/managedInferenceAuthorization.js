const { resolveManagedEnterpriseScope } = require("./enterpriseManagedConfig.mjs");

const AUTHORIZATION_BOUNDARY_CHANGED = "AUTHORIZATION_BOUNDARY_CHANGED";
const MANAGED_CONFIG_UNAVAILABLE = "MANAGED_CONFIG_UNAVAILABLE";
const MANAGED_WORKSPACE_REQUIRED = "MANAGED_WORKSPACE_REQUIRED";

function authorizationError(code, message) {
  return Object.assign(new Error(message), { code });
}

function normalizedModel(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function assertExactRoute(claim, actualRoute) {
  if (
    !claim ||
    claim.provider !== actualRoute.provider ||
    normalizedModel(claim.model) !== normalizedModel(actualRoute.model)
  ) {
    throw authorizationError(
      AUTHORIZATION_BOUNDARY_CHANGED,
      "Inference authorization changed. Retry the request."
    );
  }
}

function allowedRoute(actualRoute, managed) {
  return {
    managed,
    provider: actualRoute.provider,
    model: normalizedModel(actualRoute.model),
  };
}

function isAuthenticated(authState) {
  return authState?.authenticated ?? Boolean(authState?.token);
}

function assertCurrentIdentity(claim, authState, identity) {
  if (
    !claim ||
    typeof claim.accountId !== "string" ||
    typeof claim.workspaceId !== "string" ||
    !Number.isSafeInteger(claim.authGeneration) ||
    claim.authGeneration !== authState.generation ||
    !identity ||
    identity.accountId !== claim.accountId ||
    identity.workspaceId !== claim.workspaceId ||
    identity.authGeneration !== claim.authGeneration
  ) {
    throw authorizationError(
      AUTHORIZATION_BOUNDARY_CHANGED,
      "Inference authorization changed. Retry the request."
    );
  }
}

function assertConfigIdentity(identity, result) {
  if (
    result.accountId !== identity.accountId ||
    result.workspaceId !== identity.workspaceId ||
    result.authGeneration !== identity.authGeneration
  ) {
    throw authorizationError(
      AUTHORIZATION_BOUNDARY_CHANGED,
      "Inference authorization changed. Retry the request."
    );
  }
}

function localCategory(domain, selection) {
  const isTranscription = selection.provider === "whisper" || selection.provider === "nvidia";
  return domain === "transcription" ? isTranscription : !isTranscription;
}

function authorizeLocalConfig(claim, actualRoute, selections) {
  const approved = selections.filter((selection) => localCategory(actualRoute.domain, selection));
  if (approved.length === 0) {
    if (claim.managed) {
      throw authorizationError(
        AUTHORIZATION_BOUNDARY_CHANGED,
        "Inference authorization changed. Retry the request."
      );
    }
    return allowedRoute(actualRoute, false);
  }
  const exact = approved.some(
    (selection) =>
      selection.provider === actualRoute.provider &&
      selection.model === normalizedModel(actualRoute.model)
  );
  if (!claim.managed || !exact) {
    throw authorizationError(
      AUTHORIZATION_BOUNDARY_CHANGED,
      "Inference authorization changed. Retry the request."
    );
  }
  return allowedRoute(actualRoute, true);
}

function authorizeCloudConfig(claim, actualRoute, config) {
  if (actualRoute.domain !== "reasoning") {
    if (claim.managed) {
      throw authorizationError(
        AUTHORIZATION_BOUNDARY_CHANGED,
        "Inference authorization changed. Retry the request."
      );
    }
    return allowedRoute(actualRoute, false);
  }
  const resolution = resolveManagedEnterpriseScope(
    config,
    actualRoute.inferenceScope,
    actualRoute.setupMode
  );
  if (resolution.kind === "error") {
    throw authorizationError(MANAGED_CONFIG_UNAVAILABLE, "Managed configuration is unavailable.");
  }
  if (resolution.kind === "manual") {
    if (claim.managed) {
      throw authorizationError(
        AUTHORIZATION_BOUNDARY_CHANGED,
        "Inference authorization changed. Retry the request."
      );
    }
    return allowedRoute(actualRoute, false);
  }
  if (
    !claim.managed ||
    resolution.provider !== actualRoute.provider ||
    resolution.model !== normalizedModel(actualRoute.model)
  ) {
    throw authorizationError(
      AUTHORIZATION_BOUNDARY_CHANGED,
      "Inference authorization changed. Retry the request."
    );
  }
  return allowedRoute(actualRoute, true);
}

async function authorizeManagedInferenceStart({
  claim,
  actualRoute,
  authState,
  activeIdentity,
  getConfig,
}) {
  assertExactRoute(claim, actualRoute);
  if (!isAuthenticated(authState)) {
    if (
      claim.accountId !== null ||
      claim.workspaceId !== null ||
      claim.authGeneration !== null ||
      claim.configGeneration !== null ||
      claim.managed !== false
    ) {
      throw authorizationError(
        AUTHORIZATION_BOUNDARY_CHANGED,
        "Inference authorization changed. Retry the request."
      );
    }
    return allowedRoute(actualRoute, false);
  }

  if (claim?.accountId && !claim.workspaceId) {
    throw authorizationError(
      MANAGED_WORKSPACE_REQUIRED,
      "An active workspace is required for managed inference."
    );
  }

  const identity = activeIdentity();
  assertCurrentIdentity(claim, authState, identity);

  let result;
  try {
    result = await getConfig(identity);
  } catch {
    throw authorizationError(MANAGED_CONFIG_UNAVAILABLE, "Managed configuration is unavailable.");
  }
  if (activeIdentity() !== identity) {
    throw authorizationError(
      AUTHORIZATION_BOUNDARY_CHANGED,
      "Inference authorization changed. Retry the request."
    );
  }
  if (!result || typeof result !== "object") {
    throw authorizationError(MANAGED_CONFIG_UNAVAILABLE, "Managed configuration is unavailable.");
  }
  assertConfigIdentity(identity, result);

  if (!result.success || !result.config) {
    if (
      result.enforcementRequired === false &&
      claim.configGeneration === null &&
      claim.managed === false
    ) {
      return allowedRoute(actualRoute, false);
    }
    throw authorizationError(MANAGED_CONFIG_UNAVAILABLE, "Managed configuration is unavailable.");
  }
  if (
    result.config.workspaceId !== identity.workspaceId ||
    result.config.generation !== claim.configGeneration
  ) {
    throw authorizationError(
      AUTHORIZATION_BOUNDARY_CHANGED,
      "Inference authorization changed. Retry the request."
    );
  }

  const selections = result.config.localModels?.selections;
  return Array.isArray(selections)
    ? authorizeLocalConfig(claim, actualRoute, selections)
    : authorizeCloudConfig(claim, actualRoute, result.config);
}

module.exports = {
  AUTHORIZATION_BOUNDARY_CHANGED,
  MANAGED_CONFIG_UNAVAILABLE,
  MANAGED_WORKSPACE_REQUIRED,
  authorizeManagedInferenceStart,
};
