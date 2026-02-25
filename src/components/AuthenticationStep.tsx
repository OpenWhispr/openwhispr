import React, { useCallback, useEffect, useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../hooks/useAuth";
import {
  authClient,
  NEON_AUTH_URL,
  signInWithSocial,
  updateLastSignInTime,
  type SocialProvider,
} from "../lib/neonAuth";
import { OPENWHISPR_API_URL } from "../config/constants";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { AlertCircle, ArrowRight, Check, Loader2, ChevronLeft } from "lucide-react";
import logoIcon from "../assets/icon.png";
import logger from "../utils/logger";
import ForgotPasswordView from "./ForgotPasswordView";
import ResetPasswordView from "./ResetPasswordView";

interface AuthenticationStepProps {
  onContinueWithoutAccount: () => void;
  onAuthComplete: () => void;
  onNeedsVerification: (email: string) => void;
}

type AuthMode = "sign-in" | "sign-up" | null;
type PasswordResetView = "forgot" | "reset" | null;

const GoogleIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      fill="#4285F4"
    />
    <path
      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      fill="#34A853"
    />
    <path
      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      fill="#FBBC05"
    />
    <path
      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      fill="#EA4335"
    />
  </svg>
);

export default function AuthenticationStep({
  onContinueWithoutAccount,
  onAuthComplete,
  onNeedsVerification,
}: AuthenticationStepProps) {
  const { t } = useTranslation();
  const { isSignedIn, isLoaded, user } = useAuth();
  const [authMode, setAuthMode] = useState<AuthMode>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCheckingEmail, setIsCheckingEmail] = useState(false);
  const [isSocialLoading, setIsSocialLoading] = useState<SocialProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [passwordResetView, setPasswordResetView] = useState<PasswordResetView>(null);
  const [resetToken, setResetToken] = useState<string | null>(null);

  const oauthProcessedRef = useRef(false);
  const resetProcessedRef = useRef(false);
  const needsVerificationRef = useRef(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const hasVerifier = params.has("neon_auth_session_verifier");
    const token = params.get("token");
    const isResetPassword = params.has("reset_password");

    if (token && isResetPassword && !resetProcessedRef.current) {
      resetProcessedRef.current = true;
      setResetToken(token);
      setPasswordResetView("reset");
      logger.debug("Password reset token detected, showing reset form", undefined, "auth");
      return;
    }

    if (hasVerifier && !oauthProcessedRef.current) {
      oauthProcessedRef.current = true;
      setIsSocialLoading("google");

      // Grace period: session cookies take ~10-15s to establish after OAuth
      updateLastSignInTime();
      logger.debug("OAuth callback detected, grace period active", undefined, "auth");
    }
  }, []);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || needsVerificationRef.current || !user?.id || !user?.email)
      return;

    const initAndComplete = async () => {
      if (OPENWHISPR_API_URL) {
        try {
          const res = await fetch(`${OPENWHISPR_API_URL}/api/auth/init-user`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userId: user.id,
              email: user.email,
              name: user.name || null,
            }),
          });
          if (!res.ok) {
            logger.error("init-user returned non-OK", { status: res.status }, "auth");
          }
        } catch (err) {
          logger.error("Failed to init user", err, "auth");
        }
      }
      onAuthComplete();
    };
    initAndComplete();
  }, [isLoaded, isSignedIn, user, onAuthComplete]);

  useEffect(() => {
    if (isSocialLoading === null) return;

    let timeout: ReturnType<typeof setTimeout>;

    const handleFocus = () => {
      timeout = setTimeout(() => {
        setIsSocialLoading(null);
      }, 1000);
    };

    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
      clearTimeout(timeout);
    };
  }, [isSocialLoading]);

  const handleSocialSignIn = useCallback(
    async (provider: SocialProvider) => {
      setIsSocialLoading(provider);
      setError(null);

      const result = await signInWithSocial(provider);

      if (result.error) {
        setError(
          result.error.message ||
            t("auth.errors.failedProviderSignIn", {
              provider: provider.charAt(0).toUpperCase() + provider.slice(1),
            })
        );
        setIsSocialLoading(null);
      }
    },
    [t]
  );

  const handleEmailContinue = useCallback(async () => {
    if (!email.trim() || !authClient) return;

    const localPart = email.trim().split("@")[0];
    if (localPart?.includes("+")) {
      setError(t("auth.errors.plusAliasUnsupported"));
      return;
    }

    setIsCheckingEmail(true);
    setError(null);

    try {
      if (!OPENWHISPR_API_URL) {
        setAuthMode("sign-up");
        return;
      }

      const response = await fetch(`${OPENWHISPR_API_URL}/api/check-user`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });

      if (!response.ok) {
        throw new Error(t("auth.errors.failedUserCheck"));
      }

      const data = await response.json().catch(() => ({}));
      setAuthMode(data.exists ? "sign-in" : "sign-up");
    } catch (err) {
      logger.error("Error checking user existence", err, "auth");
      setAuthMode("sign-up");
    } finally {
      setIsCheckingEmail(false);
    }
  }, [email, t]);

  const errorMessageIncludes = (message: string | undefined, keywords: string[]): boolean => {
    if (!message) return false;
    const lowerMessage = message.toLowerCase();
    return keywords.some((keyword) => lowerMessage.includes(keyword));
  };

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      if (!authClient) {
        setError(t("auth.errors.authNotConfigured"));
        return;
      }

      setIsSubmitting(true);
      setError(null);

      try {
        if (authMode === "sign-up") {
          // Set before signup — SDK may trigger isSignedIn before returning
          needsVerificationRef.current = true;

          const result = await authClient.signUp.email({
            email: email.trim(),
            password,
            name: fullName.trim() || email.trim().split("@")[0],
          });

          if (result.error) {
            needsVerificationRef.current = false;
            if (
              errorMessageIncludes(result.error.message, ["already exists", "already registered"])
            ) {
              setAuthMode("sign-in");
              setError(t("auth.errors.accountExistsSignIn"));
              setPassword("");
            } else {
              setError(result.error.message || t("auth.errors.createAccountFailed"));
            }
          } else {
            updateLastSignInTime();

            if (OPENWHISPR_API_URL) {
              try {
                await fetch(`${OPENWHISPR_API_URL}/api/auth/init-user`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    userId: result.data?.user?.id,
                    email: email.trim(),
                    name: fullName.trim() || email.trim().split("@")[0],
                  }),
                });
              } catch (initErr) {
                logger.error("Failed to init user", initErr, "auth");
              }
            }

            onNeedsVerification(email.trim());
          }
        } else {
          const result = await authClient.signIn.email({
            email: email.trim(),
            password,
          });

          if (result.error) {
            if (errorMessageIncludes(result.error.message, ["not found", "no user"])) {
              setAuthMode("sign-up");
              setError(t("auth.errors.accountNotFoundCreate"));
              setPassword("");
            } else {
              setError(result.error.message || t("auth.errors.invalidCredentials"));
            }
          } else {
            updateLastSignInTime();
            onAuthComplete();
          }
        }
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : t("auth.errors.generic");
        setError(errorMessage);
      } finally {
        setIsSubmitting(false);
      }
    },
    [authMode, email, password, onAuthComplete, onNeedsVerification, t]
  );

  const handleBack = useCallback(() => {
    setAuthMode(null);
    setPassword("");
    setFullName("");
    setError(null);
  }, []);

  const handleForgotPassword = useCallback(() => {
    setPasswordResetView("forgot");
    setError(null);
  }, []);

  const handleBackFromPasswordReset = useCallback(() => {
    setPasswordResetView(null);
    setResetToken(null);
    setError(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("token");
    url.searchParams.delete("reset_password");
    window.history.replaceState({}, "", url.toString());
  }, []);

  const toggleAuthMode = useCallback(() => {
    setAuthMode((mode) => (mode === "sign-in" ? "sign-up" : "sign-in"));
    setError(null);
    setPassword("");
    setFullName("");
  }, []);

  // Auth not configured state
  if (!NEON_AUTH_URL || !authClient) {
    return (
      <div className="space-y-3">
        <div className="text-center mb-4">
          <img
            src={logoIcon}
            alt="OpenWhispr"
            className="w-12 h-12 mx-auto mb-2.5 rounded-lg shadow-sm"
          />
          <p className="text-lg font-semibold text-foreground tracking-tight leading-tight">
            {t("auth.welcomeTitle")}
          </p>
          <p className="text-muted-foreground text-sm mt-1 leading-tight">
            {t("auth.welcomeSubtitle")}
          </p>
        </div>

        <div className="bg-warning/5 p-2.5 rounded border border-warning/20">
          <p className="text-xs text-warning text-center leading-snug">
            {t("auth.cloudNotConfigured")}
          </p>
        </div>

        <Button onClick={onContinueWithoutAccount} className="w-full h-9">
          <span className="text-sm font-medium">{t("auth.getStarted")}</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </Button>
      </div>
    );
  }

  // Already signed in state
  if (isLoaded && isSignedIn) {
    return (
      <div className="space-y-3">
        <div className="text-center mb-4">
          <img
            src={logoIcon}
            alt="OpenWhispr"
            className="w-12 h-12 mx-auto mb-2.5 rounded-lg shadow-sm"
          />
          <div className="w-5 h-5 mx-auto bg-success/10 rounded-full flex items-center justify-center mb-2">
            <Check className="w-3 h-3 text-success" />
          </div>
          <p className="text-lg font-semibold text-foreground tracking-tight leading-tight">
            {user?.name
              ? t("auth.signedIn.welcomeBackName", { name: user.name })
              : t("auth.signedIn.welcomeBack")}
          </p>
          <p className="text-muted-foreground text-sm mt-1 leading-tight">
            {t("auth.signedIn.ready")}
          </p>
        </div>
        <Button onClick={onAuthComplete} className="w-full h-9">
          <span className="text-sm font-medium">{t("auth.common.continue")}</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </Button>
      </div>
    );
  }

  // Password reset flow - show reset form if we have a token
  if (passwordResetView === "reset" && resetToken) {
    return (
      <ResetPasswordView
        token={resetToken}
        onSuccess={onAuthComplete}
        onBack={handleBackFromPasswordReset}
      />
    );
  }

  // Password reset flow - show forgot password form
  if (passwordResetView === "forgot") {
    return <ForgotPasswordView email={email} onBack={handleBackFromPasswordReset} />;
  }

  // Password form (after email is entered)
  if (authMode !== null) {
    return (
      <div className="space-y-3">
        <button
          type="button"
          onClick={handleBack}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-0.5"
        >
          <ChevronLeft className="w-3 h-3" />
          {t("auth.common.back")}
        </button>

        <div className="text-center mb-4">
          <p className="text-sm text-muted-foreground/70 mb-2 leading-tight">{email}</p>
          <p className="text-lg font-semibold text-foreground tracking-tight leading-tight">
            {authMode === "sign-in"
              ? t("auth.passwordForm.welcomeBack")
              : t("auth.passwordForm.createAccount")}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-2">
          {authMode === "sign-up" && (
            <Input
              type="text"
              placeholder={t("auth.passwordForm.fullNamePlaceholder")}
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="h-9 text-xs"
              disabled={isSubmitting}
              autoFocus
            />
          )}
          <Input
            type="password"
            placeholder={
              authMode === "sign-up"
                ? t("auth.passwordForm.createPasswordPlaceholder")
                : t("auth.passwordForm.enterPasswordPlaceholder")
            }
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-9 text-xs"
            required
            minLength={authMode === "sign-up" ? 8 : undefined}
            disabled={isSubmitting}
            autoFocus={authMode === "sign-in"}
          />

          {authMode === "sign-up" && (
            <p className="text-xs text-muted-foreground/70 leading-tight">
              {t("auth.passwordForm.passwordMinLength")}
            </p>
          )}

          {authMode === "sign-in" && (
            <button
              type="button"
              onClick={handleForgotPassword}
              className="text-xs text-primary hover:text-primary/80 transition-colors text-left"
              disabled={isSubmitting}
            >
              {t("auth.passwordForm.forgotPassword")}
            </button>
          )}

          {error && (
            <div className="px-2.5 py-1.5 rounded bg-destructive/5 border border-destructive/20 flex items-center gap-1.5">
              <AlertCircle className="w-3 h-3 text-destructive shrink-0" />
              <p className="text-xs text-destructive leading-snug">{error}</p>
            </div>
          )}

          <Button type="submit" disabled={isSubmitting || !password} className="w-full h-9">
            {isSubmitting ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span className="text-sm font-medium">
                  {authMode === "sign-in"
                    ? t("auth.passwordForm.signingIn")
                    : t("auth.passwordForm.creatingAccount")}
                </span>
              </>
            ) : (
              <span className="text-sm font-medium">
                {authMode === "sign-in"
                  ? t("auth.passwordForm.signIn")
                  : t("auth.passwordForm.createAccountButton")}
              </span>
            )}
          </Button>
        </form>

        <div className="text-center">
          <button
            type="button"
            onClick={toggleAuthMode}
            className="text-xs text-muted-foreground/70 hover:text-foreground transition-colors"
            disabled={isSubmitting}
          >
            {authMode === "sign-in" ? (
              <>
                {t("auth.passwordForm.newHere")}{" "}
                <span className="font-medium text-primary">
                  {t("auth.passwordForm.createAccountLink")}
                </span>
              </>
            ) : (
              <>
                {t("auth.passwordForm.haveAccount")}{" "}
                <span className="font-medium text-primary">
                  {t("auth.passwordForm.signInLink")}
                </span>
              </>
            )}
          </button>
        </div>
      </div>
    );
  }

  // Main welcome view
  return (
    <div className="space-y-3">
      <div className="text-center mb-4">
        <img
          src={logoIcon}
          alt="OpenWhispr"
          className="w-12 h-12 mx-auto mb-2.5 rounded-lg shadow-sm"
        />
        <p className="text-lg font-semibold text-foreground tracking-tight leading-tight">
          {t("auth.welcomeTitle")}
        </p>
        <p className="text-muted-foreground text-sm mt-1 leading-tight">
          {t("auth.welcomeSubtitle")}
        </p>
      </div>

      <Button
        type="button"
        variant="social"
        onClick={() => handleSocialSignIn("google")}
        disabled={isSocialLoading !== null || isCheckingEmail}
        className="w-full h-9"
      >
        {isSocialLoading === "google" ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            <span className="text-sm font-medium text-muted-foreground">
              {t("auth.social.completeInBrowser")}
            </span>
          </>
        ) : (
          <>
            <GoogleIcon className="w-4 h-4" />
            <span className="text-sm font-medium">{t("auth.social.continueWithGoogle")}</span>
          </>
        )}
      </Button>

      <div className="flex items-center gap-2">
        <div className="flex-1 h-px bg-border/50" />
        <span className="text-xs font-medium text-muted-foreground/40 uppercase tracking-widest px-1">
          {t("auth.common.or")}
        </span>
        <div className="flex-1 h-px bg-border/50" />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleEmailContinue();
        }}
        className="space-y-2"
      >
        <Input
          type="email"
          placeholder={t("auth.emailStep.emailPlaceholder")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="h-9 text-sm"
          required
          disabled={isSocialLoading !== null || isCheckingEmail}
        />
        <Button
          type="submit"
          variant="outline"
          disabled={!email.trim() || isSocialLoading !== null || isCheckingEmail}
          className="w-full h-9"
        >
          {isCheckingEmail ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <>
              <span className="text-sm font-medium">{t("auth.emailStep.continueWithEmail")}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </>
          )}
        </Button>
      </form>

      {error && (
        <div className="px-3 py-2 rounded-md bg-destructive/5 border border-destructive/20 flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5 text-destructive shrink-0" />
          <p className="text-xs text-destructive">{error}</p>
        </div>
      )}

      <div className="pt-1">
        <button
          type="button"
          onClick={onContinueWithoutAccount}
          className="w-full text-center text-xs text-muted-foreground/85 hover:text-foreground transition-colors py-1.5 rounded hover:bg-muted/30"
          disabled={isSocialLoading !== null || isCheckingEmail}
        >
          {t("auth.emailStep.continueWithoutAccount")}
        </button>
      </div>

      <p className="text-xs text-muted-foreground/80 leading-tight text-center">
        {t("auth.legal.prefix")}{" "}
        <a
          href="https://openwhispr.com/terms"
          target="_blank"
          rel="noopener noreferrer"
          className="text-link underline decoration-link/30 hover:decoration-link/60 transition-colors"
        >
          {t("auth.legal.terms")}
        </a>{" "}
        {t("auth.legal.and")}{" "}
        <a
          href="https://openwhispr.com/privacy"
          target="_blank"
          rel="noopener noreferrer"
          className="text-link underline decoration-link/30 hover:decoration-link/60 transition-colors"
        >
          {t("auth.legal.privacy")}
        </a>
        {t("auth.legal.suffix")}
      </p>
    </div>
  );
}
