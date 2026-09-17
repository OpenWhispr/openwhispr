import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "../components/ui/useToast";
import { useSettingsStore } from "../stores/settingsStore";
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
  const transcriptionMode = useSettingsStore((state) => state.transcriptionMode);

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
        <button
          onClick={() => {
            dismiss(toastId);
            onOpenTranscriptionSettings();
          }}
          className="rounded-sm border border-white/20 bg-white/10 px-2.5 py-1 text-[10px] font-medium whitespace-nowrap text-white/90 transition-colors hover:border-white/35 hover:bg-white/20 hover:text-white"
        >
          {t("controlPanel.cloudNudge.action")}
        </button>
      ),
    });
  }, [dismiss, isSignedIn, onOpenTranscriptionSettings, policy, t, toast, transcriptionMode]);
}
