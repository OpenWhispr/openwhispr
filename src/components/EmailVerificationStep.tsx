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
}

export default function EmailVerificationStep({
  email,
  onVerified,
  onBack,
}: EmailVerificationStepProps) {
  const { t } = useTranslation();
  const [resendCooldown, setResendCooldown] = useState(60);
  const [isResending, setIsResending] = useState(false);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setTimeout(() => setResendCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCooldown]);

  useEffect(() => {
    if (!OPENWHISPR_API_URL || verified) return;

    const url = `${OPENWHISPR_API_URL}/api/auth/verification-status?email=${encodeURIComponent(email)}`;

    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(url, { credentials: "include" });
        if (res.ok) {
          const data = await res.json();
          if (data.verified) {
            setVerified(true);
            if (pollRef.current) clearInterval(pollRef.current);
            setTimeout(() => onVerified(), 1200);
          }
        } else if (res.status === 401 || res.status === 400) {
          if (pollRef.current) clearInterval(pollRef.current);
          setError(t("auth.sessionExpired"));
        }
      } catch {
        // Network error — silently retry on next poll
      }
    }, 5000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [email, verified, onVerified, t]);

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
    <CompactOnboardingFrame showBrandMark={false}>
      <div className="px-5 pt-[11.9rem] text-center">
        <div className="mx-auto flex size-[4.25rem] items-center justify-center rounded-full border border-neutral-200 bg-white text-neutral-950 shadow-sm">
          <MailCheck className="size-8" strokeWidth={1.8} />
        </div>
        <h1 className="onboarding-display-title mt-9">{t("emailVerification.checkEmailTitle")}</h1>
        <p className="mx-auto mt-3.5 max-w-xs text-base leading-6 text-neutral-500 dark:text-neutral-500">
          {t("emailVerification.checkEmailDescription")}{" "}
          <span className="font-medium text-neutral-950 dark:text-neutral-950">{email}</span>
        </p>

        <div
          className={`mx-auto mt-7 inline-flex h-[2.875rem] items-center justify-center gap-3 rounded-full px-6 text-base font-medium ${
            verified ? "bg-blue-500 text-white" : "bg-neutral-950 text-white"
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

        {!verified && error && (
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
