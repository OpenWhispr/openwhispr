import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import SignInDialog from "./SignInDialog";
import { useToast } from "./ui/useToast";
import { usePolicySnapshot } from "../hooks/usePolicy";
import { useSettingsStore } from "../stores/settingsStore";
import {
  SIGN_IN_PROMPTED_AT_KEY,
  setSignInPromptOpen,
  useSignInPromptStore,
} from "../stores/signInPromptStore";
import { decideSignInCloudNudge } from "../utils/signInCloudNudge";

interface SignInPromptProps {
  isSignedIn: boolean;
  onOpenTranscriptionSettings: () => void;
}

export default function SignInPrompt({
  isSignedIn,
  onOpenTranscriptionSettings,
}: SignInPromptProps) {
  const { t } = useTranslation();
  const { toast, dismiss } = useToast();
  const open = useSignInPromptStore((state) => state.open);
  const policy = usePolicySnapshot();
  const transcriptionMode = useSettingsStore((state) => state.transcriptionMode);

  useEffect(() => {
    if (open) return;
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
  }, [dismiss, isSignedIn, onOpenTranscriptionSettings, open, policy, t, toast, transcriptionMode]);

  return <SignInDialog open={open} onOpenChange={setSignInPromptOpen} />;
}
