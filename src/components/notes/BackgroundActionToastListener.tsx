import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "../ui/useToast";
import { useActionProcessingStore, consumeErrorEvents } from "../../stores/actionProcessingStore";

/**
 * Headless. Mount once inside ToastProvider so background-action errors
 * surface even after the user navigates away from the notes view.
 */
export default function BackgroundActionToastListener() {
  const { t } = useTranslation();
  const { toast } = useToast();

  const errorCount = useActionProcessingStore((s) => s.errorEvents.length);

  useEffect(() => {
    if (errorCount === 0) return;
    for (const event of consumeErrorEvents()) {
      toast({
        title: t("notes.enhance.title"),
        description: event.message,
        variant: "destructive",
      });
    }
  }, [errorCount, toast, t]);

  return null;
}
