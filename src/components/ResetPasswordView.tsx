import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { resetPassword, NEON_AUTH_URL, authClient } from "../lib/neonAuth";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { AlertCircle, ArrowLeft, Check, Loader2 } from "lucide-react";

interface ResetPasswordViewProps {
  token: string;
  onSuccess: () => void;
  onBack: () => void;
}

export default function ResetPasswordView({ token, onSuccess, onBack }: ResetPasswordViewProps) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      if (!password || !confirmPassword) return;

      if (password !== confirmPassword) {
        setError(t("resetPassword.errors.passwordsDoNotMatch"));
        return;
      }

      if (password.length < 8) {
        setError(t("resetPassword.errors.passwordMinLength"));
        return;
      }

      setIsSubmitting(true);
      setError(null);

      const result = await resetPassword(password, token);

      if (result.error) {
        setError(result.error.message);
        setIsSubmitting(false);
      } else {
        setIsSuccess(true);
        setIsSubmitting(false);
      }
    },
    [password, confirmPassword, token, t]
  );

  if (!NEON_AUTH_URL || !authClient) {
    return (
      <div className="space-y-3">
        <div className="bg-warning/5 p-2.5 rounded border border-warning/20">
          <p className="text-xs text-warning text-center leading-snug">
            {t("resetPassword.notConfigured")}
          </p>
        </div>
        <Button onClick={onBack} variant="outline" className="w-full h-9">
          <ArrowLeft className="w-3.5 h-3.5" />
          <span className="text-sm font-medium">{t("resetPassword.goBack")}</span>
        </Button>
      </div>
    );
  }

  if (isSuccess) {
    return (
      <div className="space-y-3">
        <div className="text-center mb-4">
          <div className="w-10 h-10 mx-auto bg-success/10 rounded-full flex items-center justify-center mb-3">
            <Check className="w-5 h-5 text-success" />
          </div>
          <p className="text-lg font-semibold text-foreground tracking-tight leading-tight">
            {t("resetPassword.success.title")}
          </p>
          <p className="text-muted-foreground text-sm mt-1.5 leading-snug">
            {t("resetPassword.success.description")}
          </p>
        </div>

        <Button onClick={onSuccess} className="w-full h-9">
          <span className="text-sm font-medium">{t("resetPassword.continue")}</span>
        </Button>
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
        {t("resetPassword.backToSignIn")}
      </button>

      <div className="text-center mb-4">
        <p className="text-lg font-semibold text-foreground tracking-tight leading-tight">
          {t("resetPassword.title")}
        </p>
        <p className="text-muted-foreground text-sm mt-1 leading-tight">
          {t("resetPassword.subtitle")}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-2">
        <Input
          type="password"
          placeholder={t("resetPassword.newPasswordPlaceholder")}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="h-9 text-sm"
          required
          minLength={8}
          disabled={isSubmitting}
          autoFocus
        />
        <Input
          type="password"
          placeholder={t("resetPassword.confirmPasswordPlaceholder")}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className="h-9 text-sm"
          required
          minLength={8}
          disabled={isSubmitting}
        />

        <p className="text-xs text-muted-foreground/70 leading-tight">
          {t("resetPassword.passwordMinLength")}
        </p>

        {error && (
          <div className="px-2.5 py-1.5 rounded bg-destructive/5 border border-destructive/20 flex items-center gap-1.5">
            <AlertCircle className="w-3 h-3 text-destructive shrink-0" />
            <p className="text-xs text-destructive leading-snug">{error}</p>
          </div>
        )}

        <Button
          type="submit"
          disabled={isSubmitting || !password || !confirmPassword}
          className="w-full h-9"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span className="text-sm font-medium">{t("resetPassword.resetting")}</span>
            </>
          ) : (
            <span className="text-sm font-medium">{t("resetPassword.resetButton")}</span>
          )}
        </Button>
      </form>
    </div>
  );
}
