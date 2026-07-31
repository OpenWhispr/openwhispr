import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, KeyRound, Loader2 } from "lucide-react";
import {
  changePassword,
  hasCredentialAccount,
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
const MAX_NAME_LENGTH = 80;

const AUTH_ERROR_KEYS: Record<string, string> = {
  INVALID_PASSWORD: "settingsPage.account.profile.errors.invalidPassword",
  PASSWORD_TOO_SHORT: "settingsPage.account.profile.errors.passwordTooShort",
  PASSWORD_TOO_LONG: "settingsPage.account.profile.errors.passwordTooLong",
  CREDENTIAL_ACCOUNT_NOT_FOUND: "settingsPage.account.profile.errors.noPassword",
};

interface ProfileSectionProps {
  name: string;
  onSessionRefresh: () => void;
}

export default function ProfileSection({ name, onSessionRefresh }: ProfileSectionProps) {
  const { t } = useTranslation();
  const { toast } = useToast();

  const [displayName, setDisplayName] = useState(name);
  // Baseline for the dirty check. Advanced on a successful save so the button
  // can't re-enable during the window before the refetched name prop lands.
  const [savedName, setSavedName] = useState(name);
  const [savingName, setSavingName] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);

  useEffect(() => {
    setDisplayName(name);
    setSavedName(name);
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
  const nameDirty = trimmedName.length > 0 && trimmedName !== savedName.trim();

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
    setSavedName(trimmedName);
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
                maxLength={MAX_NAME_LENGTH}
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

      <ChangePasswordDialog
        open={passwordOpen}
        onOpenChange={setPasswordOpen}
        describeError={describeError}
      />
    </>
  );
}

interface ChangePasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  describeError: (error: AuthActionError) => string;
}

function ChangePasswordDialog({ open, onOpenChange, describeError }: ChangePasswordDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [revokeOtherSessions, setRevokeOtherSessions] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setRevokeOtherSessions(true);
    setError(null);
    setSubmitting(false);
  }, []);

  // Bumped on every open/close so a response that resolves after the dialog
  // closed (or reopened) can't paint stale state into the new session.
  const sessionRef = useRef(0);

  useEffect(() => {
    sessionRef.current += 1;
    if (open) reset();
  }, [open, reset]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) reset();
      onOpenChange(next);
    },
    [reset, onOpenChange]
  );

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
    const token = sessionRef.current;
    setSubmitting(true);
    setError(null);
    const { error: actionError } = await changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions,
    });
    if (sessionRef.current !== token) return;
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
            <div className="px-2.5 py-1.5 rounded bg-destructive/5 border border-destructive/20 flex items-center gap-1.5">
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
