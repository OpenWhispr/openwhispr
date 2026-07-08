import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
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
      <DialogContent className="max-w-md">
        <DialogTitle className="sr-only">{t("auth.welcomeTitle")}</DialogTitle>
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
