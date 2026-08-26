import React, { useCallback, useEffect, useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../hooks/useAuth";
import {
  authClient,
  AUTH_URL,
  signInWithSocial,
  signInWithSSO,
  updateLastSignInTime,
  type SocialProvider,
} from "../lib/auth";
import { discoverEmailAuth } from "../lib/emailAuthDiscovery";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { AlertCircle, ArrowRight, Building2, Check, Loader2, ChevronLeft } from "lucide-react";
import logger from "../utils/logger";
import { getCachedPlatform } from "../utils/platform";
import ForgotPasswordView from "./ForgotPasswordView";
import { CompactOnboardingFrame } from "./onboarding/OnboardingShell";

interface AuthenticationStepProps {
  onContinueWithoutAccount?: () => void;
  onAuthComplete: () => void;
  onNeedsVerification: (email: string) => void;
  /** Rendering inside SignInDialog rather than the onboarding window. */
  embedded?: boolean;
}

type AuthMode = "sign-in" | "sign-up" | null;
type SsoDiscovery = {
  required: boolean;
  domain: string;
  exists: boolean;
};

const EXISTING_ACCOUNT_ERROR_CODES = new Set([
  "USER_ALREADY_EXISTS",
  "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
]);

function ProviderTile({
  label,
  icon: Icon,
  loading,
  disabled,
  title,
  onClick,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  loading: boolean;
  disabled: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={label}
      className="flex h-13 min-w-0 flex-1 flex-col items-center justify-center gap-1.5 rounded-xl bg-[var(--onboarding-surface-secondary)] px-2 text-[var(--onboarding-text-primary)] transition-colors hover:bg-[var(--onboarding-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--onboarding-accent)_40%,transparent)] disabled:pointer-events-none disabled:opacity-100"
    >
      {loading ? (
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      ) : (
        <Icon className="size-4" />
      )}
      <span className="truncate text-sm font-normal">{label}</span>
    </button>
  );
}

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

const MicrosoftIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M11.4 11.4H2V2h9.4v9.4z" fill="#F25022" />
    <path d="M22 11.4h-9.4V2H22v9.4z" fill="#7FBA00" />
    <path d="M11.4 22H2v-9.4h9.4V22z" fill="#00A4EF" />
    <path d="M22 22h-9.4v-9.4H22V22z" fill="#FFB900" />
  </svg>
);

const AppleIcon = ({ className }: { className?: string }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="currentColor"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
  </svg>
);

export default function AuthenticationStep({
  onContinueWithoutAccount,
  onAuthComplete,
  onNeedsVerification,
  embedded = false,
}: AuthenticationStepProps) {
  const { t } = useTranslation();
  // The fixed top offsets centre content in the compact setup window;
  // inside the SignInDialog the dialog supplies its own padding.
  const frameInset = (topClass: string) => (embedded ? "pt-1" : `px-5 ${topClass}`);
  const titleClass = embedded
    ? "text-2xl font-semibold tracking-tight"
    : "onboarding-display-title";
  const { isSignedIn, isLoaded, user } = useAuth();
  const [authMode, setAuthMode] = useState<AuthMode>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCheckingEmail, setIsCheckingEmail] = useState(false);
  const [isSocialLoading, setIsSocialLoading] = useState<SocialProvider | null>(null);
  const [isSSOLoading, setIsSSOLoading] = useState(false);
  const [ssoDiscovery, setSsoDiscovery] = useState<SsoDiscovery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forgotPasswordOpen, setForgotPasswordOpen] = useState(false);
  const [oauthProtocolRegistered, setOauthProtocolRegistered] = useState(true);
  const isMacOS = getCachedPlatform() === "darwin";

  const needsVerificationRef = useRef(false);

  useEffect(() => {
    window.electronAPI
      ?.getOAuthProtocolRegistered?.()
      .then(setOauthProtocolRegistered)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || needsVerificationRef.current || !user?.id || !user?.email)
      return;
    // The ref only latches within one mount. Remounting over a session that is
    // still unverified (Back from the verification step) must not complete —
    // that would advance with an email the user came back to correct.
    if (user.emailVerified === false) return;
    onAuthComplete();
  }, [isLoaded, isSignedIn, user, onAuthComplete]);

  useEffect(() => {
    if (isSocialLoading === null && !isSSOLoading) return;

    let timeout: ReturnType<typeof setTimeout>;

    const handleFocus = () => {
      timeout = setTimeout(() => {
        setIsSocialLoading(null);
        setIsSSOLoading(false);
      }, 1000);
    };

    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
      clearTimeout(timeout);
    };
  }, [isSocialLoading, isSSOLoading]);

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

  const startSSOSignIn = useCallback(
    async (value: string) => {
      if (!value.trim()) {
        setError(t("auth.sso.emailRequired"));
        return;
      }
      setIsSSOLoading(true);
      setError(null);

      const result = await signInWithSSO(value.trim());

      if (result.error) {
        setError(result.error.message || t("auth.sso.failed"));
        setIsSSOLoading(false);
      }
    },
    [t]
  );

  const handleSSOSignIn = useCallback(() => startSSOSignIn(email), [email, startSSOSignIn]);

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
      const data = await discoverEmailAuth(email, AUTH_URL);
      if (!data) {
        // No discovery endpoint on this auth server — default to sign-up; an
        // existing email is still caught by the duplicate check at sign-up.
        setAuthMode("sign-up");
        return;
      }
      if (data.sso?.available) {
        const discovery = {
          required: data.sso.required,
          domain: data.sso.domain || email.trim().split("@")[1] || "your organization",
          exists: data.exists,
        };
        setSsoDiscovery(discovery);
        if (discovery.required) await startSSOSignIn(email);
        return;
      }
      setAuthMode(data.exists ? "sign-in" : "sign-up");
    } catch (err) {
      logger.error("Error checking user existence", err, "auth");
      setError(t("auth.errors.failedUserCheck"));
    } finally {
      setIsCheckingEmail(false);
    }
  }, [email, startSSOSignIn, t]);

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
              EXISTING_ACCOUNT_ERROR_CODES.has(result.error.code || "") ||
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
    [authMode, email, fullName, password, onAuthComplete, onNeedsVerification, t]
  );

  const handleBack = useCallback(() => {
    setAuthMode(null);
    setSsoDiscovery(null);
    setPassword("");
    setFullName("");
    setError(null);
  }, []);

  const handleForgotPassword = useCallback(() => {
    setForgotPasswordOpen(true);
    setError(null);
  }, []);

  const handleBackFromForgotPassword = useCallback(() => {
    setForgotPasswordOpen(false);
    setError(null);
  }, []);

  const toggleAuthMode = useCallback(() => {
    setAuthMode((mode) => (mode === "sign-in" ? "sign-up" : "sign-in"));
    setError(null);
    setPassword("");
    setFullName("");
  }, []);

  // Auth not configured state
  if (!AUTH_URL || !authClient) {
    return (
      <CompactOnboardingFrame embedded={embedded}>
        <div className={`${frameInset("pt-44")} text-center`}>
          <h1 className={titleClass}>{t("auth.welcomeTitle")}</h1>
          <p className="mt-3 text-base text-muted-foreground">{t("auth.welcomeSubtitle")}</p>
          <div className="mt-8 rounded-xl border border-warning/20 bg-warning/5 p-3 text-sm text-warning">
            {t("auth.cloudNotConfigured")}
          </div>
          {onContinueWithoutAccount && (
            <Button onClick={onContinueWithoutAccount} className="mt-3 h-12 w-full rounded-full">
              {t("auth.getStarted")}
              <ArrowRight className="size-4" />
            </Button>
          )}
        </div>
      </CompactOnboardingFrame>
    );
  }

  // Already signed in state
  if (isLoaded && isSignedIn) {
    return (
      <CompactOnboardingFrame embedded={embedded}>
        <div className={`${frameInset("pt-48")} text-center`}>
          <div className="mx-auto flex size-12 items-center justify-center rounded-full border border-border bg-card shadow-sm">
            <Check className="size-5 text-success" />
          </div>
          <p className="mt-6 text-2xl font-medium leading-tight tracking-tight">
            {user?.name
              ? t("auth.signedIn.welcomeBackName", { name: user.name })
              : t("auth.signedIn.welcomeBack")}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">{t("auth.signedIn.ready")}</p>
          <Button onClick={onAuthComplete} className="mt-7 h-12 w-full rounded-full">
            {t("auth.common.continue")}
            <ArrowRight className="size-4" />
          </Button>
        </div>
      </CompactOnboardingFrame>
    );
  }

  if (forgotPasswordOpen) {
    return (
      <CompactOnboardingFrame embedded={embedded}>
        <div className={frameInset("pt-42")}>
          <ForgotPasswordView email={email} onBack={handleBackFromForgotPassword} />
        </div>
      </CompactOnboardingFrame>
    );
  }

  if (ssoDiscovery && authMode === null) {
    return (
      <CompactOnboardingFrame embedded={embedded}>
        <div className={`space-y-3 ${frameInset("pt-72")}`}>
          <button
            type="button"
            onClick={handleBack}
            className="flex items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronLeft className="h-3 w-3" />
            {t("auth.common.back")}
          </button>

          <div className="pb-1 text-center">
            <p className="mb-2 text-sm leading-tight text-muted-foreground/70">{email}</p>
            <p className="text-lg font-semibold leading-tight tracking-tight text-foreground">
              {t("auth.sso.companySignInTitle")}
            </p>
            <p className="mt-1 text-xs leading-snug text-muted-foreground">
              {ssoDiscovery.required
                ? t("auth.sso.requiredDescription", { domain: ssoDiscovery.domain })
                : t("auth.sso.availableDescription", { domain: ssoDiscovery.domain })}
            </p>
          </div>

          <Button
            type="button"
            onClick={handleSSOSignIn}
            disabled={isSSOLoading || !oauthProtocolRegistered}
            className="h-12 w-full rounded-full"
          >
            {isSSOLoading ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span className="text-sm font-medium">{t("auth.social.completeInBrowser")}</span>
              </>
            ) : (
              <span className="text-sm font-medium">{t("auth.sso.continueWithSSO")}</span>
            )}
          </Button>

          {!ssoDiscovery.required && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full font-normal text-muted-foreground"
              disabled={isSSOLoading}
              onClick={() => {
                setSsoDiscovery(null);
                setAuthMode(ssoDiscovery.exists ? "sign-in" : "sign-up");
              }}
            >
              {t("auth.sso.useEmailInstead")}
            </Button>
          )}

          {error && (
            <div className="flex items-center gap-1.5 rounded border border-destructive/20 bg-destructive/5 px-2.5 py-1.5">
              <AlertCircle className="h-3 w-3 shrink-0 text-destructive" />
              <p className="text-xs leading-snug text-destructive">{error}</p>
            </div>
          )}
        </div>
      </CompactOnboardingFrame>
    );
  }

  // Password form (after email is entered)
  if (authMode !== null) {
    return (
      <CompactOnboardingFrame embedded={embedded}>
        <div className={`${frameInset("pt-38")} text-center`}>
          <h1 className={titleClass}>{t("auth.welcomeTitle")}</h1>
          <p className="mt-2 text-base text-[var(--onboarding-text-secondary)]">
            {t("auth.welcomeSubtitle")}
          </p>

          <button
            type="button"
            onClick={handleBack}
            className={
              embedded
                ? "mb-3 inline-flex h-8 items-center gap-1 text-xs text-[var(--onboarding-text-secondary)] transition-colors hover:text-[var(--onboarding-text-primary)]"
                : "absolute left-5 top-13 inline-flex h-8 items-center gap-1 text-xs font-medium text-white/80 transition-colors hover:text-white"
            }
            style={embedded ? undefined : ({ WebkitAppRegion: "no-drag" } as React.CSSProperties)}
            disabled={isSubmitting}
          >
            <ChevronLeft className="size-3.5" />
            {t("auth.common.back")}
          </button>

          <form onSubmit={handleSubmit} className="mt-4 space-y-3 text-left">
            <label className="block space-y-2">
              <span className="text-xs text-[var(--onboarding-text-secondary)]">
                {authMode === "sign-up"
                  ? t("auth.passwordForm.nameLabel")
                  : t("auth.emailStep.emailLabel")}
              </span>
              {authMode === "sign-up" ? (
                <Input
                  type="text"
                  placeholder={t("auth.passwordForm.fullNamePlaceholder")}
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="onboarding-light-input onboarding-auth-input h-10 rounded-xl px-3 text-sm"
                  disabled={isSubmitting}
                  autoFocus
                />
              ) : (
                <Input
                  type="email"
                  value={email}
                  className="onboarding-light-input onboarding-auth-input h-10 rounded-xl px-3 text-sm"
                  readOnly
                  disabled={isSubmitting}
                />
              )}
            </label>
            <label className="block space-y-2">
              <span className="text-xs text-[var(--onboarding-text-secondary)]">
                {t("auth.passwordForm.passwordLabel")}
              </span>
              <Input
                type="password"
                placeholder={t("auth.passwordForm.passwordLabel")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="onboarding-light-input onboarding-auth-input h-10 rounded-xl px-3 text-sm"
                required
                minLength={authMode === "sign-up" ? 8 : undefined}
                disabled={isSubmitting}
                autoFocus={authMode === "sign-in"}
              />
            </label>

            {error && (
              <div className="px-2.5 py-1.5 rounded bg-destructive/5 border border-destructive/20 flex items-center gap-1.5">
                <AlertCircle className="w-3 h-3 text-destructive shrink-0" />
                <p className="text-xs text-destructive leading-snug">{error}</p>
              </div>
            )}

            <Button
              type="submit"
              disabled={isSubmitting || !password}
              className="h-10 w-full rounded-full border-transparent bg-[var(--onboarding-inverse-surface)] text-base font-normal text-[var(--onboarding-inverse-text)] shadow-none hover:opacity-90 disabled:border-transparent disabled:bg-[var(--onboarding-surface-tertiary)] disabled:text-[var(--onboarding-text-tertiary)] disabled:opacity-100"
            >
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

          {authMode === "sign-in" && (
            <div className="mt-3 text-xs text-[var(--onboarding-text-secondary)]">
              <button
                type="button"
                onClick={handleForgotPassword}
                className="transition-colors hover:text-[var(--onboarding-text-primary)]"
                disabled={isSubmitting}
              >
                {t("auth.passwordForm.forgotPassword")}
              </button>
            </div>
          )}
          <button type="button" onClick={toggleAuthMode} className="sr-only">
            {authMode === "sign-in"
              ? t("auth.passwordForm.createAccountLink")
              : t("auth.passwordForm.signInLink")}
          </button>
        </div>
      </CompactOnboardingFrame>
    );
  }

  // Main welcome view
  const busy = isSocialLoading !== null || isCheckingEmail || isSSOLoading;
  const providers = [
    {
      id: "google",
      label: "Google",
      icon: GoogleIcon,
      onClick: () => handleSocialSignIn("google"),
      loading: isSocialLoading === "google",
    },
    ...(isMacOS
      ? [
          {
            id: "apple",
            label: "Apple",
            icon: AppleIcon,
            onClick: () => handleSocialSignIn("apple"),
            loading: isSocialLoading === "apple",
          },
        ]
      : []),
    {
      id: "microsoft",
      label: "Microsoft",
      icon: MicrosoftIcon,
      onClick: () => handleSocialSignIn("microsoft"),
      loading: isSocialLoading === "microsoft",
    },
    { id: "sso", label: "SSO", icon: Building2, onClick: handleSSOSignIn, loading: isSSOLoading },
  ];

  return (
    <CompactOnboardingFrame embedded={embedded}>
      <div className={`${frameInset("pt-38")} text-center`}>
        <h1 className={titleClass}>{t("auth.welcomeTitle")}</h1>
        <p className="mt-2 text-base text-[var(--onboarding-text-secondary)]">
          {t("auth.welcomeSubtitle")}
        </p>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            handleEmailContinue();
          }}
          className="mt-3 space-y-3"
        >
          <Input
            type="email"
            placeholder={t("auth.emailStep.emailPlaceholder")}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="onboarding-light-input h-10 rounded-xl px-3 text-sm disabled:opacity-100"
            required
            disabled={busy}
          />
          <Button
            type="submit"
            disabled={!email.trim() || busy}
            className={`h-10 w-full rounded-full border-transparent bg-[var(--onboarding-inverse-surface)] text-base font-normal text-[var(--onboarding-inverse-text)] shadow-none hover:opacity-90 disabled:border-transparent disabled:opacity-100 ${
              email.trim()
                ? ""
                : "disabled:bg-[var(--onboarding-surface-tertiary)] disabled:text-[var(--onboarding-text-tertiary)]"
            }`}
          >
            {isCheckingEmail ? <Loader2 className="size-4 animate-spin" /> : null}
            {isCheckingEmail
              ? t("auth.emailStep.checkingEmail")
              : t("auth.emailStep.continueWithEmail")}
          </Button>
        </form>

        <p className="pb-3 pt-4 text-sm font-normal uppercase text-[var(--onboarding-text-secondary)]">
          {t("auth.common.or")}
        </p>

        <div className="flex gap-3">
          {providers.map((provider) => (
            <ProviderTile
              key={provider.id}
              label={provider.label}
              icon={provider.icon}
              loading={provider.loading}
              disabled={busy || !oauthProtocolRegistered}
              title={!oauthProtocolRegistered ? t("auth.social.protocolUnavailable") : undefined}
              onClick={provider.onClick}
            />
          ))}
        </div>

        {!oauthProtocolRegistered && (
          <p className="mt-2 text-center text-xs leading-tight text-muted-foreground/80">
            {t("auth.social.protocolUnavailable")}
          </p>
        )}

        {error && (
          <div className="mt-2 flex items-center gap-2 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-left">
            <AlertCircle className="size-3.5 shrink-0 text-destructive" />
            <p className="text-xs text-destructive">{error}</p>
          </div>
        )}

        {onContinueWithoutAccount && (
          <div className="pt-5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onContinueWithoutAccount}
              className="w-full rounded-full text-base font-normal text-[var(--onboarding-text-secondary)] hover:bg-[var(--onboarding-surface-hover)] hover:text-[var(--onboarding-text-primary)]"
              disabled={isSocialLoading !== null || isCheckingEmail || isSSOLoading}
            >
              {t("auth.emailStep.continueWithoutAccount")}
            </Button>
          </div>
        )}
      </div>
    </CompactOnboardingFrame>
  );
}
