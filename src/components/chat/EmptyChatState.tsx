import { useTranslation } from "react-i18next";
import { ChatEmptyIllustration } from "./ChatEmptyIllustration";

export default function EmptyChatState() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center justify-center h-full -mt-6 select-none">
      <ChatEmptyIllustration />
      <p className="text-xs text-muted-foreground/40 mt-4">{t("chat.selectChat")}</p>
    </div>
  );
}
