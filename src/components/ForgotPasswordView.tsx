import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { requestPasswordReset, NEON_AUTH_URL, authClient } from "../lib/neonAuth";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { AlertCircle, ArrowLeft, Check, Loader2, Mail } from "lucide-react";

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

  if (!NEON_AUTH_URL || !authClient) {
    return (
      <div className="space-y-3">
        <div className="bg-warning/5 p-2.5 rounded border border-warning/20">
          <p className="text-xs text-warning text-center leading-snug">
            {t("forgotPassword.notConfigured")}
          </p>
        </div>
        <Button onClick={onBack} variant="outline" className="w-full h-9">
          <ArrowLeft className="w-3.5 h-3.5" />
          <span className="text-sm font-medium">{t("forgotPassword.goBack")}</span>
        </Button>
      </div>
    );
  }

  if (isSuccess) {
    return (
      <div className="space-y-3">
        <div className="text-center mb-4">
          <div className="w-10 h-10 mx-auto bg-success/10 rounded-full flex items-center justify-center mb-3">
            <Mail className="w-5 h-5 text-success" />
          </div>
          <p className="text-lg font-semibold text-foreground tracking-tight leading-tight">
            {t("forgotPassword.success.title")}
          </p>
          <p className="text-muted-foreground text-sm mt-1.5 leading-snug">
            {t("forgotPassword.success.description")}
          </p>
          <p className="text-foreground text-sm font-medium mt-0.5">{email}</p>
        </div>

        <div className="bg-muted/50 p-2.5 rounded border border-border/50">
          <p className="text-xs text-muted-foreground text-center leading-snug">
            {t("forgotPassword.success.help")}
          </p>
        </div>

        <div className="space-y-2">
          <Button
            onClick={() => {
              setIsSuccess(false);
              setEmail("");
            }}
            variant="outline"
            className="w-full h-9"
          >
            <span className="text-sm font-medium">{t("forgotPassword.success.tryAnother")}</span>
          </Button>
          <Button onClick={onBack} variant="ghost" className="w-full h-9">
            <ArrowLeft className="w-3.5 h-3.5" />
            <span className="text-sm font-medium">{t("forgotPassword.backToSignIn")}</span>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={onBack}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-0.5"
      >
        <ArrowLeft className="w-3 h-3" />
        {t("forgotPassword.back")}
      </button>

      <div className="text-center mb-4">
        <p className="text-lg font-semibold text-foreground tracking-tight leading-tight">
          {t("forgotPassword.title")}
        </p>
        <p className="text-muted-foreground text-sm mt-1 leading-tight">
          {t("forgotPassword.subtitle")}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-2">
        <Input
          type="email"
          placeholder={t("forgotPassword.emailPlaceholder")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="h-9 text-sm"
          required
          disabled={isSubmitting}
          autoFocus
        />

        {error && (
          <div className="px-2.5 py-1.5 rounded bg-destructive/5 border border-destructive/20 flex items-center gap-1.5">
            <AlertCircle className="w-3 h-3 text-destructive shrink-0" />
            <p className="text-xs text-destructive leading-snug">{error}</p>
          </div>
        )}

        <Button type="submit" disabled={isSubmitting || !email.trim()} className="w-full h-9">
          {isSubmitting ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span className="text-sm font-medium">{t("forgotPassword.sending")}</span>
            </>
          ) : (
            <span className="text-sm font-medium">{t("forgotPassword.sendResetLink")}</span>
          )}
        </Button>
      </form>
    </div>
  );
}
