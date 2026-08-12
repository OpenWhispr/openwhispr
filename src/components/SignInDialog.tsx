import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import AuthenticationStep from "./AuthenticationStep";
import EmailVerificationStep from "./EmailVerificationStep";

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
      {/* The auth view opens with a full-bleed brand hero: clip it to the dialog
          corners, and lift the close glyph so it stays legible on the blue. */}
      <DialogContent
        className={
          pendingVerificationEmail
            ? "max-w-md"
            : "max-w-md overflow-hidden [&>button>svg]:text-white"
        }
      >
        <DialogTitle className="sr-only">{t("auth.welcomeTitle")}</DialogTitle>
        <DialogDescription className="sr-only">{t("auth.welcomeSubtitle")}</DialogDescription>
        {pendingVerificationEmail ? (
          <EmailVerificationStep
            email={pendingVerificationEmail}
            onVerified={() => handleOpenChange(false)}
            onBack={() => setPendingVerificationEmail(null)}
          />
        ) : (
          <AuthenticationStep
            onAuthComplete={() => handleOpenChange(false)}
            onNeedsVerification={setPendingVerificationEmail}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
