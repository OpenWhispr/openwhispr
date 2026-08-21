import React, { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { OPENWHISPR_API_URL } from "../config/constants";
import { authClient } from "../lib/auth";
import { Button } from "./ui/button";
import { CircleCheck, Loader, Loader2, MailCheck, RefreshCw } from "lucide-react";
import { CompactOnboardingFrame } from "./onboarding/OnboardingShell";

interface EmailVerificationStepProps {
  email: string;
  onVerified: () => void;
  onBack: () => void;
  /** Rendering inside SignInDialog rather than the onboarding window. */
  embedded?: boolean;
}

export default function EmailVerificationStep({
  email,
  onVerified,
  onBack,
  embedded = false,
}: EmailVerificationStepProps) {
  const { t } = useTranslation();
  const [resendCooldown, setResendCooldown] = useState(60);
  const [isResending, setIsResending] = useState(false);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onVerifiedRef = useRef(onVerified);

  useEffect(() => {
    onVerifiedRef.current = onVerified;
  }, [onVerified]);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setTimeout(() => setResendCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCooldown]);

  useEffect(() => {
    if (!OPENWHISPR_API_URL) return;

    const url = `${OPENWHISPR_API_URL}/api/auth/verification-status?email=${encodeURIComponent(email)}`;
    let stopped = false;

    const checkVerificationStatus = async () => {
      try {
        const res = await fetch(url, { credentials: "include" });
        if (stopped) return;

        if (res.ok) {
          const data = await res.json();
          if (data.verified) {
            setVerified(true);
            if (pollRef.current) clearInterval(pollRef.current);
          }
        } else if (res.status === 401 || res.status === 400) {
          if (pollRef.current) clearInterval(pollRef.current);
          setError(t("auth.sessionExpired"));
        }
      } catch {
        // Network error — silently retry on next poll
      }
    };

    // Check immediately so returning from the verification link never leaves the
    // user staring at a stale waiting state for a full polling interval.
    void checkVerificationStatus();
    pollRef.current = setInterval(checkVerificationStatus, 5000);

    return () => {
      stopped = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [email, t]);

  useEffect(() => {
    if (!verified) return;
    const timer = setTimeout(() => onVerifiedRef.current(), 1200);
    return () => clearTimeout(timer);
  }, [verified]);

  const handleResend = useCallback(async () => {
    if (resendCooldown > 0 || isResending) return;
    setIsResending(true);
    setError(null);
    try {
      const result = await authClient.sendVerificationEmail({ email });
      if (result.error) {
        setError(result.error.message || t("emailVerification.errors.resendFailed"));
      } else {
        setResendCooldown(60);
      }
    } catch {
      setError(t("emailVerification.errors.serverUnreachable"));
    } finally {
      setIsResending(false);
    }
  }, [resendCooldown, isResending, email, t]);

  return (
    <CompactOnboardingFrame showBrandMark={false} embedded={embedded}>
      <div className={`${embedded ? "pt-1" : "px-5 pt-42"} text-center`}>
        <div className="mx-auto flex size-16 items-center justify-center rounded-full border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] text-[var(--onboarding-text-primary)] shadow-sm">
          <MailCheck className="size-7" strokeWidth={1.8} />
        </div>
        <h1
          className={
            embedded
              ? "mt-6 text-2xl font-semibold tracking-tight"
              : "onboarding-display-title mt-9"
          }
        >
          {t("emailVerification.checkEmailTitle")}
        </h1>
        <p className="mx-auto mt-2 max-w-xs text-sm leading-5 text-[var(--onboarding-text-secondary)]">
          {t("emailVerification.checkEmailDescription")}{" "}
          <span className="font-medium text-[var(--onboarding-text-primary)]">{email}</span>
        </p>

        <div
          className={`mx-auto mt-5 inline-flex h-10 items-center justify-center gap-3 rounded-full px-6 text-sm font-medium ${
            verified
              ? "bg-[var(--onboarding-accent)] text-[var(--onboarding-accent-foreground)]"
              : "bg-[var(--onboarding-inverse-surface)] text-[var(--onboarding-inverse-text)]"
          }`}
          role="status"
          aria-live="polite"
        >
          {verified ? (
            <CircleCheck className="size-4" />
          ) : (
            <Loader className="size-4 animate-spin" />
          )}
          {verified ? t("emailVerification.verifiedTitle") : t("emailVerification.waiting")}
        </div>

        {error && (
          <div className="mt-5 rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2">
            <p className="text-xs leading-snug text-destructive">{error}</p>
          </div>
        )}

        {/* Keep the reference state uncluttered during the initial delivery
            window, then expose recovery actions once resending is possible or
            immediately when polling reports a terminal session error. */}
        {!verified && (error || resendCooldown <= 0) && (
          <div className="mt-5 flex justify-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleResend}
              disabled={resendCooldown > 0 || isResending}
              className="rounded-full text-muted-foreground"
            >
              {isResending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : resendCooldown > 0 ? (
                t("emailVerification.resendIn", { seconds: resendCooldown })
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {!isResending && resendCooldown <= 0 && t("emailVerification.resendButton")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onBack}
              className="rounded-full text-muted-foreground"
            >
              {t("emailVerification.backToSignIn")}
            </Button>
          </div>
        )}
      </div>
    </CompactOnboardingFrame>
  );
}
