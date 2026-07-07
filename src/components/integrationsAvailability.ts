export interface IntegrationsAvailabilityInput {
  isSignedIn: boolean;
  isPaid: boolean;
  isDesktopAppRunning: boolean;
}

export interface IntegrationAvailabilityState {
  usable: boolean;
  route: "local-cli" | "loopback" | "hosted" | "hosted-unavailable";
  requiresHostedSubscription: boolean;
  reason: "local_available" | "desktop_required" | "hosted_available" | "hosted_only";
}

export function resolveIntegrationsAvailability(input: IntegrationsAvailabilityInput): {
  localCli: IntegrationAvailabilityState;
  localMcp: IntegrationAvailabilityState;
  hostedMcp: IntegrationAvailabilityState;
  workspaceApiKeys: IntegrationAvailabilityState;
} {
  return {
    localCli: {
      usable: true,
      route: "local-cli",
      requiresHostedSubscription: false,
      reason: "local_available",
    },
    localMcp: {
      usable: input.isDesktopAppRunning,
      route: "loopback",
      requiresHostedSubscription: false,
      reason: input.isDesktopAppRunning ? "local_available" : "desktop_required",
    },
    hostedMcp: hostedAvailability(input),
    workspaceApiKeys: hostedAvailability(input),
  };
}

function hostedAvailability(input: IntegrationsAvailabilityInput): IntegrationAvailabilityState {
  const usable = input.isSignedIn && input.isPaid;
  return {
    usable,
    route: usable ? "hosted" : "hosted-unavailable",
    requiresHostedSubscription: true,
    reason: usable ? "hosted_available" : "hosted_only",
  };
}
