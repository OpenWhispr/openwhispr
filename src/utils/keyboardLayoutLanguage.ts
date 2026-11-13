// Stored value of the "By keyboard layout" Transcription Language option. It only
// has meaning while dictating, where it is replaced by the language of the
// foreground window's layout (resolveLayoutLanguage in languageSupport.ts);
// everywhere else it is treated as "auto". It must never reach an STT request,
// prompt, wake-word check or env var as a language code.
//
// No imports on purpose: the main process loads this file natively, so it must not
// pull in languageSupport.ts (JSON import). CommonJS main-process code that cannot
// import it (ipcHandlers.js) repeats the literal.
export const KEYBOARD_LAYOUT_LANGUAGE = "keyboard";

export function isKeyboardLayoutLanguage(code: string | null | undefined): boolean {
  return code === KEYBOARD_LAYOUT_LANGUAGE;
}
