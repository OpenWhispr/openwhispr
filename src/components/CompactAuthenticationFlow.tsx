import { useState, type JSX } from "react";
import { signOut } from "../lib/auth";
import AuthenticationStep from "./AuthenticationStep";
import EmailVerificationStep from "./EmailVerificationStep";
import type { OnboardingAuthDraft } from "./onboarding/flow";

interface CompactAuthenticationFlowProps {
  onContinueWithoutAccount?: () => void;
  onAuthComplete: () => void;
  resumeState?: OnboardingAuthDraft;
  onResumeStateChange?: (state: Partial<OnboardingAuthDraft>) => void;
}

export function CompactAuthenticationFlow({
  onContinueWithoutAccount,
  onAuthComplete,
  resumeState,
  onResumeStateChange,
}: CompactAuthenticationFlowProps): JSX.Element {
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState<string | null>(
    resumeState?.pendingVerificationEmail ?? null
  );

  const updatePendingVerificationEmail = (email: string | null) => {
    setPendingVerificationEmail(email);
    onResumeStateChange?.({ pendingVerificationEmail: email });
  };

  if (pendingVerificationEmail) {
    return (
      <EmailVerificationStep
        email={pendingVerificationEmail}
        onVerified={() => {
          updatePendingVerificationEmail(null);
          onAuthComplete();
        }}
        onBack={() => {
          // Abandoning verification leaves a live session for the wrong email;
          // end it first or the remounted auth step auto-completes that account.
          void signOut().then(() => updatePendingVerificationEmail(null));
        }}
      />
    );
  }

  return (
    <AuthenticationStep
      onContinueWithoutAccount={onContinueWithoutAccount}
      onAuthComplete={onAuthComplete}
      onNeedsVerification={updatePendingVerificationEmail}
      resumeState={resumeState}
      onResumeStateChange={onResumeStateChange}
    />
  );
}
