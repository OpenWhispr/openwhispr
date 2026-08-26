import type { JSX } from "react";
import { CompactAuthenticationFlow } from "./CompactAuthenticationFlow";
import OnboardingShell from "./onboarding/OnboardingShell";

interface ReauthenticationScreenProps {
  onContinueWithoutAccount: () => void;
  onAuthComplete: () => void;
}

export default function ReauthenticationScreen({
  onContinueWithoutAccount,
  onAuthComplete,
}: ReauthenticationScreenProps): JSX.Element {
  return (
    <OnboardingShell compact stepKey="reauthentication">
      <div className="min-h-full w-full">
        <CompactAuthenticationFlow
          onContinueWithoutAccount={onContinueWithoutAccount}
          onAuthComplete={onAuthComplete}
        />
      </div>
    </OnboardingShell>
  );
}
