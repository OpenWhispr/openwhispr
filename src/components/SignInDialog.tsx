import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import AuthenticationStep from "./AuthenticationStep";
import EmailVerificationStep from "./EmailVerificationStep";
import { signOut } from "../lib/auth";

interface SignInDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function SignInDialog({ open, onOpenChange }: SignInDialogProps) {
  const { t } = useTranslation();
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState<string | null>(null);

  const handleOpenChange = (next: boolean) => {
    if (!next) setPendingVerificationEmail(null);
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogTitle className="sr-only">{t("auth.welcomeTitle")}</DialogTitle>
        <DialogDescription className="sr-only">{t("auth.welcomeSubtitle")}</DialogDescription>
        {pendingVerificationEmail ? (
          <EmailVerificationStep
            email={pendingVerificationEmail}
            onVerified={() => handleOpenChange(false)}
            onBack={() => {
              // Abandoning verification leaves a live session for the wrong
              // email; end it first or the remounted auth step auto-completes
              // with that account (signOut never rejects).
              void signOut().then(() => setPendingVerificationEmail(null));
            }}
            embedded
          />
        ) : (
          <AuthenticationStep
            onAuthComplete={() => handleOpenChange(false)}
            onNeedsVerification={setPendingVerificationEmail}
            embedded
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
