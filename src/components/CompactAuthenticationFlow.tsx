import { useState, type JSX } from "react";
import { signOut } from "../lib/auth";
import AuthenticationStep from "./AuthenticationStep";
import EmailVerificationStep from "./EmailVerificationStep";

interface CompactAuthenticationFlowProps {
  onContinueWithoutAccount?: () => void;
  onAuthComplete: () => void;
}

export function CompactAuthenticationFlow({
  onContinueWithoutAccount,
  onAuthComplete,
}: CompactAuthenticationFlowProps): JSX.Element {
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState<string | null>(null);

  if (pendingVerificationEmail) {
    return (
      <EmailVerificationStep
        email={pendingVerificationEmail}
        onVerified={() => {
          setPendingVerificationEmail(null);
          onAuthComplete();
        }}
        onBack={() => {
          // Abandoning verification leaves a live session for the wrong email;
          // end it first or the remounted auth step auto-completes that account.
          void signOut().then(() => setPendingVerificationEmail(null));
        }}
      />
    );
  }

  return (
    <AuthenticationStep
      onContinueWithoutAccount={onContinueWithoutAccount}
      onAuthComplete={onAuthComplete}
      onNeedsVerification={setPendingVerificationEmail}
    />
  );
}
