import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { requestPasswordReset, AUTH_URL, authClient } from "../lib/auth";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { AlertCircle, ArrowLeft, Loader2, MailCheck } from "lucide-react";

interface ForgotPasswordViewProps {
  email?: string;
  onBack: () => void;
}

export default function ForgotPasswordView({
  email: initialEmail = "",
  onBack,
}: ForgotPasswordViewProps) {
  const { t } = useTranslation();
  const [email, setEmail] = useState(initialEmail);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      if (!email.trim()) return;

      setIsSubmitting(true);
      setError(null);

      const result = await requestPasswordReset(email.trim());

      if (result.error) {
        setError(result.error.message);
        setIsSubmitting(false);
      } else {
        setIsSuccess(true);
        setIsSubmitting(false);
      }
    },
    [email]
  );

  if (!AUTH_URL || !authClient) {
    return (
      <div className="text-center">
        <h1 className="onboarding-display-title">{t("forgotPassword.title")}</h1>
        <div className="mt-4 rounded-lg border border-warning/20 bg-warning/5 p-3">
          <p className="text-center text-xs leading-snug text-warning">
            {t("forgotPassword.notConfigured")}
          </p>
        </div>
        <Button
          onClick={onBack}
          variant="outline"
          className="mt-3 h-10 w-full rounded-full border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] text-[var(--onboarding-text-primary)]"
        >
          <ArrowLeft className="size-3.5" />
          <span className="text-sm font-medium">{t("forgotPassword.goBack")}</span>
        </Button>
      </div>
    );
  }

  if (isSuccess) {
    return (
      <div className="text-center">
        <div className="mx-auto flex size-16 items-center justify-center rounded-full border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] text-[var(--onboarding-text-primary)] shadow-sm">
          <MailCheck className="size-7" strokeWidth={1.8} />
        </div>
        <h1 className="onboarding-display-title mt-7">{t("forgotPassword.success.title")}</h1>
        <p className="mx-auto mt-2 max-w-xs text-sm leading-5 text-[var(--onboarding-text-secondary)]">
          {t("forgotPassword.success.description")}{" "}
          <span className="font-medium text-[var(--onboarding-text-primary)]">{email}</span>
        </p>

        <p className="mx-auto mt-3 max-w-xs text-xs leading-4 text-[var(--onboarding-text-secondary)]">
          {t("forgotPassword.success.help")}
        </p>

        <div className="mt-5 space-y-2">
          <Button
            onClick={() => {
              setIsSuccess(false);
              setEmail("");
            }}
            className="h-10 w-full rounded-full border-transparent bg-[var(--onboarding-inverse-surface)] text-[var(--onboarding-inverse-text)] shadow-none hover:opacity-90"
          >
            <span className="text-sm font-medium">{t("forgotPassword.success.tryAnother")}</span>
          </Button>
          <button
            type="button"
            onClick={onBack}
            className="inline-flex h-8 items-center justify-center gap-1.5 text-xs text-[var(--onboarding-text-secondary)] transition-colors hover:text-[var(--onboarding-text-primary)]"
          >
            <ArrowLeft className="size-3.5" />
            {t("forgotPassword.backToSignIn")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="text-center">
      <h1 className="onboarding-display-title">{t("forgotPassword.title")}</h1>
      <p className="mt-3 text-base text-[var(--onboarding-text-secondary)]">
        {t("forgotPassword.subtitle")}
      </p>

      <form onSubmit={handleSubmit} className="mt-4 space-y-3 text-left">
        <label className="block space-y-2">
          <span className="text-xs text-[var(--onboarding-text-secondary)]">
            {t("auth.emailStep.emailLabel")}
          </span>
          <Input
            type="email"
            placeholder={t("forgotPassword.emailPlaceholder")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="onboarding-light-input onboarding-auth-input h-10 rounded-xl px-3 text-sm"
            required
            disabled={isSubmitting}
            autoFocus
          />
        </label>

        {error && (
          <div className="flex items-center gap-1.5 rounded border border-destructive/20 bg-destructive/5 px-2.5 py-1.5">
            <AlertCircle className="size-3 shrink-0 text-destructive" />
            <p className="text-xs leading-snug text-destructive">{error}</p>
          </div>
        )}

        <Button
          type="submit"
          disabled={isSubmitting || !email.trim()}
          className="h-10 w-full rounded-full border-transparent bg-[var(--onboarding-inverse-surface)] text-[var(--onboarding-inverse-text)] shadow-none hover:opacity-90 disabled:border-transparent disabled:bg-[var(--onboarding-surface-tertiary)] disabled:text-[var(--onboarding-text-tertiary)] disabled:opacity-100"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              <span className="text-sm font-medium">{t("forgotPassword.sending")}</span>
            </>
          ) : (
            <span className="text-sm font-medium">{t("forgotPassword.sendResetLink")}</span>
          )}
        </Button>
      </form>

      <button
        type="button"
        onClick={onBack}
        className="mt-3 inline-flex h-8 items-center justify-center gap-1.5 text-xs text-[var(--onboarding-text-secondary)] transition-colors hover:text-[var(--onboarding-text-primary)]"
      >
        <ArrowLeft className="size-3.5" />
        {t("forgotPassword.backToSignIn")}
      </button>
    </div>
  );
}
