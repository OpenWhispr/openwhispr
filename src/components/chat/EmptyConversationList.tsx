import { useTranslation } from "react-i18next";
import ThemedEmptyIllustration from "../ui/ThemedEmptyIllustration";
import chatEmptyLight from "../../assets/empty-states/chat-empty-light.svg";
import chatEmptyDark from "../../assets/empty-states/chat-empty-dark.svg";

interface EmptyConversationListProps {
  state: "active" | "archived" | "error";
  onRetry: () => void;
}

export default function EmptyConversationList({ state, onRetry }: EmptyConversationListProps) {
  const { t } = useTranslation();

  return (
    <div className="flex h-full flex-col items-center justify-center px-4 pb-10 text-center">
      {state !== "error" && (
        <ThemedEmptyIllustration
          light={chatEmptyLight}
          dark={chatEmptyDark}
          width={150}
          height={150}
        />
      )}
      <p className="mt-3 text-sm font-semibold text-foreground">
        {t(
          state === "error"
            ? "chat.loadFailed"
            : state === "archived"
              ? "chat.noArchived"
              : "chat.noConversations"
        )}
      </p>
      {state === "active" && (
        <p className="mt-2 text-xs text-muted-foreground">{t("chat.noConversationsDescription")}</p>
      )}
      {state === "error" && (
        <button
          onClick={onRetry}
          className="mt-3 text-xs text-primary hover:underline focus-visible:underline"
        >
          {t("common.retry")}
        </button>
      )}
    </div>
  );
}
