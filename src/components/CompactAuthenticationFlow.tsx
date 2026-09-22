import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { signOut } from "../lib/auth";
import AuthenticationStep from "./AuthenticationStep";
import EmailVerificationStep from "./EmailVerificationStep";
import type { OnboardingAuthDraft } from "./onboarding/flow";

interface VerificationBackRequest {
  email: string;
  result: Promise<boolean>;
}

// Account policy can replace the flow while sign-out is still running. Retain
// its result until a flow for this address consumes it, including a later reopen.
let verificationBackRequest: VerificationBackRequest | null = null;

interface CompactAuthenticationFlowProps {
  onContinueWithoutAccount?: () => void;
  onAuthComplete: () => void;
  autoContinue?: boolean;
  embedded?: boolean;
  onSignOut?: () => void;
  resumeState?: OnboardingAuthDraft;
  onResumeStateChange?: (state: Partial<OnboardingAuthDraft>) => void;
}

export function CompactAuthenticationFlow({
  onContinueWithoutAccount,
  onAuthComplete,
  autoContinue,
  embedded,
  onSignOut,
  resumeState,
  onResumeStateChange,
}: CompactAuthenticationFlowProps): JSX.Element {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState<string | null>(
    resumeState?.pendingVerificationEmail ?? null
  );
  // A restored address was never mailed from this session, so the verification
  // screen must not open on a cooldown for a message nobody just sent.
  const [resumedVerification, setResumedVerification] = useState(
    Boolean(resumeState?.pendingVerificationEmail)
  );
  const [backRequest, setBackRequest] = useState(() =>
    verificationBackRequest?.email === resumeState?.pendingVerificationEmail
      ? verificationBackRequest
      : null
  );

  const updatePendingVerificationEmail = useCallback(
    (email: string | null, patch?: Partial<OnboardingAuthDraft>) => {
      // A signup response from before policy replaced this flow must not restore
      // a verification draft that the current flow has already completed.
      if (!mountedRef.current) return;
      if (email && verificationBackRequest?.email === email) verificationBackRequest = null;
      setPendingVerificationEmail(email);
      setResumedVerification(false);
      onResumeStateChange?.({ pendingVerificationEmail: email, ...patch });
    },
    [onResumeStateChange]
  );

  useEffect(() => {
    if (!backRequest) return;
    let cancelled = false;
    void backRequest.result.then((signedOut) => {
      if (cancelled || verificationBackRequest !== backRequest) return;
      verificationBackRequest = null;
      setBackRequest(null);
      if (signedOut) updatePendingVerificationEmail(null, { authMode: "sign-in" });
      else setResumedVerification(true);
    });
    return () => {
      cancelled = true;
    };
  }, [backRequest, updatePendingVerificationEmail]);

  if (pendingVerificationEmail) {
    return (
      <EmailVerificationStep
        // Failed Back starts a fresh polling/notice cycle with recovery visible.
        key={backRequest ? "signing-out" : "verification"}
        email={pendingVerificationEmail}
        resumed={resumedVerification || Boolean(backRequest)}
        embedded={embedded}
        onVerified={() => {
          if (backRequest) return;
          if (verificationBackRequest?.email === pendingVerificationEmail) {
            verificationBackRequest = null;
          }
          updatePendingVerificationEmail(null);
          onAuthComplete();
        }}
        onBack={() => {
          // Abandoning verification leaves a live session for the wrong email;
          // end it first or the remounted auth step auto-completes that account.
          // The draft still says "sign-up", which is what opened this screen — send
          // the user back to sign-in as the button promises, rather than to the
          // create-account form for an address that now exists.
          if (verificationBackRequest?.email !== pendingVerificationEmail) {
            verificationBackRequest = {
              email: pendingVerificationEmail,
              result: signOut().then(
                () => true,
                () => false
              ),
            };
          }
          setBackRequest(verificationBackRequest);
        }}
      />
    );
  }

  return (
    <AuthenticationStep
      onContinueWithoutAccount={onContinueWithoutAccount}
      onAuthComplete={onAuthComplete}
      autoContinue={autoContinue}
      embedded={embedded}
      onSignOut={onSignOut}
      onNeedsVerification={updatePendingVerificationEmail}
      resumeState={resumeState}
      onResumeStateChange={onResumeStateChange}
    />
  );
}
