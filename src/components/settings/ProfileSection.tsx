import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, KeyRound, Loader2, Mail } from "lucide-react";
import {
  changePassword,
  hasCredentialAccount,
  requestEmailChange,
  updateDisplayName,
  type AuthActionError,
} from "../../lib/auth";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import { useToast } from "../ui/useToast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";

const MIN_PASSWORD_LENGTH = 8;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const AUTH_ERROR_KEYS: Record<string, string> = {
  INVALID_PASSWORD: "settingsPage.account.profile.errors.invalidPassword",
  PASSWORD_TOO_SHORT: "settingsPage.account.profile.errors.passwordTooShort",
  PASSWORD_TOO_LONG: "settingsPage.account.profile.errors.passwordTooLong",
  CREDENTIAL_ACCOUNT_NOT_FOUND: "settingsPage.account.profile.errors.noPassword",
};

const INLINE_ERROR_CLASS =
  "px-2.5 py-1.5 rounded bg-destructive/5 border border-destructive/20 flex items-center gap-1.5";

interface ProfileSectionProps {
  name: string;
  email: string;
  onSessionRefresh: () => void;
}

interface DialogBaseProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  describeError: (error: AuthActionError) => string;
}

export default function ProfileSection({ name, email, onSessionRefresh }: ProfileSectionProps) {
  const { t } = useTranslation();
  const { toast } = useToast();

  const [displayName, setDisplayName] = useState(name);
  const [savingName, setSavingName] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [hasPassword, setHasPassword] = useState(true);

  useEffect(() => {
    setDisplayName(name);
  }, [name]);

  useEffect(() => {
    let active = true;
    void hasCredentialAccount().then((result) => {
      if (active) setHasPassword(result);
    });
    return () => {
      active = false;
    };
  }, []);

  const describeError = useCallback(
    (error: AuthActionError) => {
      const key = error.code ? AUTH_ERROR_KEYS[error.code] : undefined;
      return key ? t(key) : t("settingsPage.account.profile.errors.generic");
    },
    [t]
  );

  const trimmedName = displayName.trim();
  const nameDirty = trimmedName.length > 0 && trimmedName !== name.trim();

  const handleSaveName = useCallback(async () => {
    if (!nameDirty || savingName) return;
    setSavingName(true);
    const { error } = await updateDisplayName(trimmedName);
    setSavingName(false);
    if (error) {
      toast({
        title: t("settingsPage.account.profile.name.error"),
        description: describeError(error),
        variant: "destructive",
      });
      return;
    }
    onSessionRefresh();
    toast({ title: t("settingsPage.account.profile.name.saved") });
  }, [nameDirty, savingName, trimmedName, toast, t, describeError, onSessionRefresh]);

  return (
    <>
      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow label={t("settingsPage.account.profile.name.label")}>
            <div className="flex gap-2">
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={t("settingsPage.account.profile.name.placeholder")}
                aria-label={t("settingsPage.account.profile.name.label")}
                maxLength={80}
                disabled={savingName}
                className="h-8 w-56 text-xs"
              />
              <Button size="sm" onClick={handleSaveName} disabled={!nameDirty || savingName}>
                {savingName
                  ? t("settingsPage.account.profile.name.saving")
                  : t("settingsPage.account.profile.name.save")}
              </Button>
            </div>
          </SettingsRow>
        </SettingsPanelRow>

        <SettingsPanelRow>
          <SettingsRow label={t("settingsPage.account.profile.email.label")} description={email}>
            <Button variant="outline" size="sm" onClick={() => setEmailOpen(true)}>
              <Mail className="mr-1.5 h-3.5 w-3.5" />
              {t("settingsPage.account.profile.email.change")}
            </Button>
          </SettingsRow>
        </SettingsPanelRow>

        {hasPassword && (
          <SettingsPanelRow>
            <SettingsRow
              label={t("settingsPage.account.profile.password.label")}
              description={t("settingsPage.account.profile.password.description")}
            >
              <Button variant="outline" size="sm" onClick={() => setPasswordOpen(true)}>
                <KeyRound className="mr-1.5 h-3.5 w-3.5" />
                {t("settingsPage.account.profile.password.change")}
              </Button>
            </SettingsRow>
          </SettingsPanelRow>
        )}
      </SettingsPanel>

      <ChangeEmailDialog
        open={emailOpen}
        onOpenChange={setEmailOpen}
        currentEmail={email}
        onSessionRefresh={onSessionRefresh}
        describeError={describeError}
      />
      <ChangePasswordDialog
        open={passwordOpen}
        onOpenChange={setPasswordOpen}
        describeError={describeError}
      />
    </>
  );
}

function ChangeEmailDialog({
  open,
  onOpenChange,
  currentEmail,
  onSessionRefresh,
  describeError,
}: DialogBaseProps & { currentEmail: string; onSessionRefresh: () => void }) {
  const { t } = useTranslation();
  const [newEmail, setNewEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const openRef = useRef(open);

  // Reset on open + track openness so a late response can't restore stale state after close.
  useEffect(() => {
    openRef.current = open;
    if (open) {
      setNewEmail("");
      setError(null);
      setSent(false);
      setSubmitting(false);
    }
  }, [open]);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      onSessionRefresh();
      setNewEmail("");
      setError(null);
      setSent(false);
      setSubmitting(false);
    }
    onOpenChange(next);
  };

  const trimmed = newEmail.trim();
  const valid =
    EMAIL_REGEX.test(trimmed) && trimmed.toLowerCase() !== currentEmail.trim().toLowerCase();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(null);
    const { error: actionError } = await requestEmailChange(trimmed);
    if (!openRef.current) return;
    setSubmitting(false);
    if (actionError) {
      setError(describeError(actionError));
      return;
    }
    setSent(true);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        {sent ? (
          <>
            <DialogHeader>
              <div className="w-10 h-10 rounded-full bg-success/10 flex items-center justify-center mb-1">
                <Mail className="w-5 h-5 text-success" />
              </div>
              <DialogTitle>{t("settingsPage.account.profile.email.sentTitle")}</DialogTitle>
              <DialogDescription>
                {t("settingsPage.account.profile.email.sentDescription")}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={() => handleOpenChange(false)}>
                {t("settingsPage.account.profile.email.close")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>{t("settingsPage.account.profile.email.dialogTitle")}</DialogTitle>
              <DialogDescription>
                {t("settingsPage.account.profile.email.dialogDescription")}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="profile-new-email" className="text-xs font-medium">
                {t("settingsPage.account.profile.email.newLabel")}
              </Label>
              <Input
                id="profile-new-email"
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder={t("settingsPage.account.profile.email.newPlaceholder")}
                disabled={submitting}
                autoFocus
              />
            </div>
            {error && (
              <div className={INLINE_ERROR_CLASS}>
                <AlertCircle className="w-3 h-3 text-destructive shrink-0" />
                <p className="text-xs text-destructive leading-snug">{error}</p>
              </div>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => handleOpenChange(false)}
                disabled={submitting}
              >
                {t("settingsPage.account.profile.email.cancel")}
              </Button>
              <Button type="submit" disabled={!valid || submitting}>
                {submitting ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    {t("settingsPage.account.profile.email.sending")}
                  </>
                ) : (
                  t("settingsPage.account.profile.email.submit")
                )}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ChangePasswordDialog({ open, onOpenChange, describeError }: DialogBaseProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [revokeOtherSessions, setRevokeOtherSessions] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openRef = useRef(open);

  // Reset on open + track openness so a late response can't restore stale state after close.
  useEffect(() => {
    openRef.current = open;
    if (open) {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setRevokeOtherSessions(true);
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setRevokeOtherSessions(true);
      setError(null);
      setSubmitting(false);
    }
    onOpenChange(next);
  };

  const tooShort = newPassword.length > 0 && newPassword.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirmPassword.length > 0 && confirmPassword !== newPassword;
  const canSubmit =
    currentPassword.length > 0 &&
    newPassword.length >= MIN_PASSWORD_LENGTH &&
    newPassword === confirmPassword &&
    !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const { error: actionError } = await changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions,
    });
    if (!openRef.current) return;
    setSubmitting(false);
    if (actionError) {
      setError(describeError(actionError));
      return;
    }
    toast({ title: t("settingsPage.account.profile.password.saved") });
    handleOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={handleSubmit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{t("settingsPage.account.profile.password.dialogTitle")}</DialogTitle>
            <DialogDescription>
              {t("settingsPage.account.profile.password.dialogDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="profile-current-password" className="text-xs font-medium">
                {t("settingsPage.account.profile.password.currentLabel")}
              </Label>
              <Input
                id="profile-current-password"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                disabled={submitting}
                autoComplete="current-password"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="profile-new-password" className="text-xs font-medium">
                {t("settingsPage.account.profile.password.newLabel")}
              </Label>
              <Input
                id="profile-new-password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                minLength={MIN_PASSWORD_LENGTH}
                disabled={submitting}
                autoComplete="new-password"
              />
              {tooShort && (
                <p className="text-xs text-destructive leading-snug">
                  {t("settingsPage.account.profile.password.minLength")}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="profile-confirm-password" className="text-xs font-medium">
                {t("settingsPage.account.profile.password.confirmLabel")}
              </Label>
              <Input
                id="profile-confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={submitting}
                autoComplete="new-password"
              />
              {mismatch && (
                <p className="text-xs text-destructive leading-snug">
                  {t("settingsPage.account.profile.password.mismatch")}
                </p>
              )}
            </div>
            <label className="flex items-center gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={revokeOtherSessions}
                onChange={(e) => setRevokeOtherSessions(e.target.checked)}
                disabled={submitting}
                className="h-3.5 w-3.5 rounded border-border accent-primary cursor-pointer"
              />
              <span className="text-xs text-foreground">
                {t("settingsPage.account.profile.password.revokeOthers")}
              </span>
            </label>
          </div>
          {error && (
            <div className={INLINE_ERROR_CLASS}>
              <AlertCircle className="w-3 h-3 text-destructive shrink-0" />
              <p className="text-xs text-destructive leading-snug">{error}</p>
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => handleOpenChange(false)}
              disabled={submitting}
            >
              {t("settingsPage.account.profile.password.cancel")}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  {t("settingsPage.account.profile.password.saving")}
                </>
              ) : (
                t("settingsPage.account.profile.password.submit")
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
