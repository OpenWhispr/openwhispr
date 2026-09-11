import React, { type PropsWithChildren } from "react";
import { DirectionProvider } from "@radix-ui/react-direction";
import { useTranslation } from "react-i18next";

export function I18nDirectionProvider({ children }: PropsWithChildren) {
  const { i18n } = useTranslation();
  const language = i18n.resolvedLanguage || i18n.language;

  return <DirectionProvider dir={i18n.dir(language)}>{children}</DirectionProvider>;
}
