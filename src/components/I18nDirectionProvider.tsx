import React, { type PropsWithChildren } from "react";
import { DirectionProvider } from "@radix-ui/react-direction";
import { useTranslation } from "react-i18next";
import { useUiLocale } from "../hooks/useUiLocale";

export function I18nDirectionProvider({ children }: PropsWithChildren) {
  const { i18n } = useTranslation();
  const locale = useUiLocale();

  return <DirectionProvider dir={i18n.dir(locale)}>{children}</DirectionProvider>;
}
