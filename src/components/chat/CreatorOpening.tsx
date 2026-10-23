import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { PAGE_CONTENT_WIDTH_CLASS } from "../ui/pageWidth";
import { ChatMessage } from "./ChatMessage";

/** The skill creator's first question, shown in its empty chat. It is never saved. */
export function CreatorOpening(): ReactElement {
  const { t } = useTranslation();
  return (
    <div className={PAGE_CONTENT_WIDTH_CLASS}>
      <ChatMessage
        messageId="skill-creator-opening"
        role="assistant"
        content={t("skills.chat.creatorOpening")}
        isStreaming={false}
      />
    </div>
  );
}
