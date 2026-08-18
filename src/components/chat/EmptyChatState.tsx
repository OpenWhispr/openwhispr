import { MessagesSquare } from "lucide-react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "../ui/EmptyState";

export default function EmptyChatState() {
  const { t } = useTranslation();

  return (
    <EmptyState
      icon={MessagesSquare}
      description={t("chat.selectChat")}
      className="h-full -mt-6 select-none"
    />
  );
}
