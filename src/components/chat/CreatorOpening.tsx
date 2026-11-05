import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ChatMessage } from "./ChatMessage";

/**
 * The skill creator's first question, at the top of its chat for as long as the creator is
 * attached, so the user's answer never reads as the start. It is never saved; the model hears
 * it was asked through the creator's context.
 */
export function CreatorOpening(): ReactElement {
  const { t } = useTranslation();
  return (
    <ChatMessage
      messageId="skill-creator-opening"
      role="assistant"
      content={t("skills.chat.creatorOpening")}
      isStreaming={false}
    />
  );
}
