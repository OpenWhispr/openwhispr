export type ControlPanelWindowMode = "compact" | "restore";

export interface SettledControlPanelWindowState {
  isControlPanel: boolean;
  isLoading: boolean;
  isWaitingForPolicyStart: boolean;
  showOnboarding: boolean;
  needsReauth: boolean;
}

export function resolveSettledControlPanelWindowMode(
  state: SettledControlPanelWindowState
): ControlPanelWindowMode | null {
  if (
    !state.isControlPanel ||
    state.isLoading ||
    state.isWaitingForPolicyStart ||
    state.showOnboarding
  ) {
    return null;
  }

  return state.needsReauth ? "compact" : "restore";
}
