/**
 * Translates an editor-blocks string (`notes.editor.blocks.*` in the locale
 * files). Used by code outside React components (slash items, node views,
 * prompts); components call useTranslation() as well, so they re-render when
 * the UI language changes.
 */
import i18n from "i18next";

export const tb = (key: string, options?: Record<string, unknown>): string => {
  const fullKey = `notes.editor.blocks.${key}`;
  // Before i18next is initialized (unit tests), fall back to the key, as react-i18next does.
  const value = i18n.isInitialized ? i18n.t(fullKey, options) : undefined;
  return typeof value === "string" ? value : fullKey;
};
