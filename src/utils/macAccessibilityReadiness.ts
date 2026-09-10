import type { ActiveAccountScope } from "../types/electron";

type ReadinessOptions = {
  normalAppVisible: boolean;
  isControlPanel: boolean;
  isSignedIn: boolean;
  authSkipped: boolean;
  readActiveAccountScope?: () => Promise<ActiveAccountScope | null>;
};

export async function resolveMacAccessibilityReadiness({
  normalAppVisible,
  isControlPanel,
  isSignedIn,
  authSkipped,
  readActiveAccountScope,
}: ReadinessOptions): Promise<boolean> {
  if (!normalAppVisible) return false;
  if (isSignedIn || authSkipped) return true;
  if (isControlPanel || !readActiveAccountScope) return false;

  try {
    return Boolean(await readActiveAccountScope());
  } catch {
    return false;
  }
}
