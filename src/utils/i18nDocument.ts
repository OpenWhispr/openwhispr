interface DocumentLanguageSource {
  language: string;
  resolvedLanguage?: string;
  dir(language?: string): "ltr" | "rtl";
  on(event: "languageChanged", listener: (language: string) => void): unknown;
  off(event: "languageChanged", listener: (language: string) => void): unknown;
}

interface DocumentLanguageRoot {
  lang: string;
  dir: string;
}

interface HotModule {
  dispose(callback: () => void): void;
}

export function bindDocumentLanguage(
  i18n: DocumentLanguageSource,
  root: DocumentLanguageRoot,
  hot?: HotModule
): () => void {
  const sync = (language: string) => {
    root.lang = language;
    root.dir = i18n.dir(language);
  };
  const handleLanguageChanged = (language: string) => sync(language);

  sync(i18n.resolvedLanguage || i18n.language || "en");
  i18n.on("languageChanged", handleLanguageChanged);

  let active = true;
  const dispose = () => {
    if (!active) return;
    active = false;
    i18n.off("languageChanged", handleLanguageChanged);
  };
  hot?.dispose(dispose);
  return dispose;
}
