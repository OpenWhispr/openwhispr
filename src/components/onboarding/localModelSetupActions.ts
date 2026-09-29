export interface LocalModelSetupActionState {
  assistant: boolean;
  selectedReady: boolean;
  anyDownloadActive: boolean;
  canProceed: boolean;
}

export function resolveLocalModelSetupActions({
  assistant,
  selectedReady,
  anyDownloadActive,
  canProceed,
}: LocalModelSetupActionState) {
  return {
    showSkip: anyDownloadActive || (assistant && !selectedReady),
    skipDisabled: anyDownloadActive && !canProceed && !assistant,
    preservePending: anyDownloadActive && canProceed,
  };
}
