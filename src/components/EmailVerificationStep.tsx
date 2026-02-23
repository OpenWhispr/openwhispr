import React, { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { OPENWHISPR_API_URL } from "../config/constants";
import { Button } from "./ui/button";
import { Mail, Loader2, Check, RefreshCw } from "lucide-react";
import logoIcon from "../assets/icon.png";

interface EmailVerificationStepProps {
  email: string;
  onVerified: () => void;
}

export default function EmailVerificationStep({ email, onVerified }: EmailVerificationStepProps) {
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
  }, [email, verified, onVerified]);

  const handleResend = useCallback(async () => {
    if (resendCooldown > 0 || isResending || !OPENWHISPR_API_URL) return;
    setIsResending(true);
    setError(null);
    try {
      const res = await fetch(`${OPENWHISPR_API_URL}/api/auth/send-verification-email`, {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        setResendCooldown(60);
      } else {
        const data = await res.json();
        setError(data.error || t("emailVerification.errors.resendFailed"));
      }
    } catch {
      setError(t("emailVerification.errors.serverUnreachable"));
    } finally {
      setIsResending(false);
    }
  }, [resendCooldown, isResending, t]);

  if (verified) {
    return (
      <div className="space-y-3">
        <div className="text-center mb-4">
          <img
            src={logoIcon}
            alt="OpenWhispr"
            className="w-12 h-12 mx-auto mb-2.5 rounded-lg shadow-sm"
          />
          <div className="w-8 h-8 mx-auto bg-success/10 rounded-full flex items-center justify-center mb-2">
            <Check className="w-4 h-4 text-success" />
          </div>
          <p className="text-lg font-semibold text-foreground tracking-tight leading-tight">
            {t("emailVerification.verifiedTitle")}
          </p>
          <p className="text-muted-foreground text-sm mt-1 leading-tight">
            {t("emailVerification.verifiedDescription")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="text-center mb-4">
        <img
          src={logoIcon}
          alt="OpenWhispr"
          className="w-12 h-12 mx-auto mb-2.5 rounded-lg shadow-sm"
        />
        <div className="w-8 h-8 mx-auto bg-primary/10 rounded-full flex items-center justify-center mb-3">
          <Mail className="w-4 h-4 text-primary" />
        </div>
        <p className="text-lg font-semibold text-foreground tracking-tight leading-tight">
          {t("emailVerification.checkEmailTitle")}
        </p>
        <p className="text-muted-foreground text-sm mt-1 leading-tight">
          {t("emailVerification.checkEmailDescription")}
        </p>
        <p className="text-sm font-medium text-foreground mt-0.5">{email}</p>
      </div>

      <div className="flex items-center justify-center gap-1.5 py-1">
        <Loader2 className="w-3 h-3 animate-spin text-muted-foreground/50" />
        <p className="text-xs text-muted-foreground/50">{t("emailVerification.waiting")}</p>
      </div>

      {error && (
        <div className="px-2.5 py-1.5 rounded bg-destructive/5 border border-destructive/20 flex items-center gap-1.5">
          <p className="text-xs text-destructive leading-snug">{error}</p>
        </div>
      )}

      <Button
        type="button"
        variant="outline"
        onClick={handleResend}
        disabled={resendCooldown > 0 || isResending}
        className="w-full h-9"
      >
        {isResending ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : resendCooldown > 0 ? (
          <span className="text-sm font-medium">
            {t("emailVerification.resendIn", { seconds: resendCooldown })}
          </span>
        ) : (
          <>
            <RefreshCw className="w-3.5 h-3.5" />
            <span className="text-sm font-medium">{t("emailVerification.resendButton")}</span>
          </>
        )}
      </Button>
    </div>
  );
}
