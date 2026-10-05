import type { ActiveAccountScope } from "../types/electron";

type ReadinessOptions = {
  normalAppVisible: boolean;
  isControlPanel: boolean;
  isSignedIn: boolean;
  authSkipped: boolean;
  readActiveAccountScope?: () => Promise<ActiveAccountScope | null>;
};

type MacAccessibilityReadiness = {
  expectedAccountScope?: ActiveAccountScope;
};

export async function resolveMacAccessibilityReadiness({
  normalAppVisible,
  isControlPanel,
  isSignedIn,
  authSkipped,
  readActiveAccountScope,
}: ReadinessOptions): Promise<MacAccessibilityReadiness | null> {
  if (!normalAppVisible) return null;
  if (isSignedIn || authSkipped) return {};
  if (isControlPanel || !readActiveAccountScope) return null;

  try {
    const expectedAccountScope = await readActiveAccountScope();
    return expectedAccountScope ? { expectedAccountScope } : null;
  } catch {
    return null;
  }
}
