import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/EmptyState";

interface EmptyConversationListProps {
  onNewChat: () => void;
}

export default function EmptyConversationList({ onNewChat }: EmptyConversationListProps) {
  const { t } = useTranslation();

  return (
    <EmptyState
      compact
      description={t("chat.noConversations")}
      actions={
        <Button
          variant="ghost"
          size="sm"
          onClick={onNewChat}
          className="h-7 px-2.5 text-xs text-primary hover:bg-primary/8 dark:hover:bg-primary/10"
        >
          <Plus size={12} />
          {t("chat.newChat")}
        </Button>
      }
      className="h-full select-none"
    />
  );
}
