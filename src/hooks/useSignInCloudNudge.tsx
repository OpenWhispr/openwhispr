import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ToastActionButton } from "../components/ui/Toast";
import { useToast } from "../components/ui/useToast";
import { selectPolicyEffectiveSettings, useSettingsStore } from "../stores/settingsStore";
import { SIGN_IN_PROMPTED_AT_KEY } from "../utils/requestSignIn";
import { decideSignInCloudNudge } from "../utils/signInCloudNudge";
import { usePolicySnapshot } from "./usePolicy";

/**
 * Tells a user who just signed in that OpenWhispr Cloud is available, once, without
 * switching anything: a post-sign-in cloud switch is what overrode Local for #2086.
 * The marker requestSignIn left behind survives the reload that sign-in goes through.
 */
export function useSignInCloudNudge(
  isSignedIn: boolean,
  onOpenTranscriptionSettings: () => void
): void {
  const { t } = useTranslation();
  const { toast, dismiss } = useToast();
  const policy = usePolicySnapshot();
  // Policy-effective, because a managed user the policy already clamps onto Cloud is
  // there whatever their own preference still says.
  const transcriptionMode = useSettingsStore(
    (settings) => selectPolicyEffectiveSettings(settings, policy).transcriptionMode
  );

  useEffect(() => {
    const promptedAt = localStorage.getItem(SIGN_IN_PROMPTED_AT_KEY);
    if (promptedAt === null) return;
    const decision = decideSignInCloudNudge({
      promptedAt: Number(promptedAt),
      now: Date.now(),
      isSignedIn,
      policy,
      transcriptionMode,
    });
    if (decision === "wait") return;
    localStorage.removeItem(SIGN_IN_PROMPTED_AT_KEY);
    if (decision === "skip") return;

    const toastId = toast({
      title: t("controlPanel.cloudNudge.title"),
      description: t("controlPanel.cloudNudge.description"),
      duration: 10000,
      action: (
        <ToastActionButton
          onClick={() => {
            dismiss(toastId);
            onOpenTranscriptionSettings();
          }}
        >
          {t("controlPanel.cloudNudge.action")}
        </ToastActionButton>
      ),
    });
  }, [dismiss, isSignedIn, onOpenTranscriptionSettings, policy, t, toast, transcriptionMode]);
}
