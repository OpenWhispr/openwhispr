import { useTranslation } from "react-i18next";
import ThemedEmptyIllustration from "../ui/ThemedEmptyIllustration";
import chatEmptyLight from "../../assets/empty-states/chat-empty-light.svg";
import chatEmptyDark from "../../assets/empty-states/chat-empty-dark.svg";

const TITLE_KEYS = {
  active: "chat.noConversations",
  // There are chats, but every one of them is archived.
  archived: "chat.allArchived",
  error: "chat.loadFailed",
} as const;

interface EmptyConversationListProps {
  state: keyof typeof TITLE_KEYS;
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
      <p className="mt-3 text-sm font-semibold text-foreground">{t(TITLE_KEYS[state])}</p>
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
