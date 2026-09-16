import React from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { CompactAuthenticationFlow } from "./CompactAuthenticationFlow";
import type { OnboardingAuthDraft } from "./onboarding/flow";

interface SignInDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAuthComplete?: () => void;
  resumeState?: OnboardingAuthDraft;
  onResumeStateChange?: (state: Partial<OnboardingAuthDraft>) => void;
}

export default function SignInDialog({
  open,
  onOpenChange,
  onAuthComplete,
  resumeState,
  onResumeStateChange,
}: SignInDialogProps) {
  const { t } = useTranslation();

  const complete = () => {
    onOpenChange(false);
    onAuthComplete?.();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogTitle className="sr-only">{t("auth.welcomeTitle")}</DialogTitle>
        <DialogDescription className="sr-only">{t("auth.welcomeSubtitle")}</DialogDescription>
        {open && (
          <CompactAuthenticationFlow
            onAuthComplete={complete}
            resumeState={resumeState}
            onResumeStateChange={onResumeStateChange}
            embedded
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
