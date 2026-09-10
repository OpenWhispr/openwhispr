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
  // A restored address was never mailed from this session, so the verification
  // screen must not open on a cooldown for a message nobody just sent.
  const [resumedVerification, setResumedVerification] = useState(
    Boolean(resumeState?.pendingVerificationEmail)
  );

  const updatePendingVerificationEmail = (
    email: string | null,
    patch?: Partial<OnboardingAuthDraft>
  ) => {
    setPendingVerificationEmail(email);
    setResumedVerification(false);
    onResumeStateChange?.({ pendingVerificationEmail: email, ...patch });
  };

  if (pendingVerificationEmail) {
    return (
      <EmailVerificationStep
        email={pendingVerificationEmail}
        resumed={resumedVerification}
        onVerified={() => {
          updatePendingVerificationEmail(null);
          onAuthComplete();
        }}
        onBack={() => {
          // Abandoning verification leaves a live session for the wrong email;
          // end it first or the remounted auth step auto-completes that account.
          // The draft still says "sign-up", which is what opened this screen — send
          // the user back to sign-in as the button promises, rather than to the
          // create-account form for an address that now exists.
          void signOut().then(() => updatePendingVerificationEmail(null, { authMode: "sign-in" }));
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
