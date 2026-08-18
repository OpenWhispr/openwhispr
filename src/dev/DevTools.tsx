import { useEffect, useState } from "react";

import { SUPPORTED_UI_LANGUAGES, type UiLanguage } from "../i18n";
import { useSettingsStore } from "../stores/settingsStore";
import {
  DEV_STEP_OPTIONS,
  currentStepId,
  exitOnboarding,
  jumpToStep,
  restartOnboarding,
} from "./onboardingSteps";

/**
 * Development-only onboarding tooling: jump to any step, restart, skip to the
 * app, flip the theme, switch UI language, and unlock the window chrome to check
 * steps at other sizes.
 *
 * Deliberately dependency-free. This used to host a DialKit panel for live design
 * dials and the Agentation annotation toolbar; both are gone, along with the
 * design-override stylesheet they drove — every value they tuned is now written
 * into index.css from the Figma specs, so keeping a second source of truth for the
 * same numbers was a liability (a stale dial default silently reverted the real
 * design more than once).
 *
 * The theme and language controls write through the real store setters rather than
 * poking `document.documentElement.classList` or `i18n.changeLanguage` directly, so
 * what you see here is exactly what a user gets from Settings — including the
 * persistence. That does mean they outlive the session: the panel labels the
 * non-default values so a forgotten override doesn't get mistaken for a bug.
 *
 * Only ever mounted behind `import.meta.env.DEV`, so none of this reaches a
 * production build. Strings are intentionally not run through i18n: this UI is
 * never shown to a user, and a translated dev panel would hide the very thing the
 * language switcher exists to check.
 */

const THEMES = ["light", "dark", "auto"] as const;

// Endonyms, matching UI_LANGUAGE_OPTIONS in SettingsPage.tsx. Written out rather
// than derived from Intl.DisplayNames so the panel reads the same on every
// machine regardless of the OS locale data.
const LANGUAGE_LABELS: Record<UiLanguage, string> = {
  en: "English",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  pt: "Português",
  it: "Italiano",
  ru: "Русский",
  ja: "日本語",
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
};

const SELECT_CLASS = "w-full rounded-md bg-neutral-800 px-2 py-1.5 text-xs";

export default function DevTools() {
  const [open, setOpen] = useState(false);
  const [nativeChrome, setNativeChrome] = useState(false);

  const theme = useSettingsStore((state) => state.theme);
  const setTheme = useSettingsStore((state) => state.setTheme);
  const uiLanguage = useSettingsStore((state) => state.uiLanguage);
  const setUiLanguage = useSettingsStore((state) => state.setUiLanguage);

  // Sent on mount too, so a reload (which resets the toggle to false) also
  // re-locks the real window instead of leaving it unlocked from last session.
  useEffect(() => {
    void window.electronAPI?.setOnboardingWindowUnlocked?.(nativeChrome);
  }, [nativeChrome]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-[9999] flex size-11 items-center justify-center rounded-full bg-neutral-900 text-xs font-medium text-white shadow-lg"
        title="Onboarding dev tools"
      >
        dev
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-[9999] w-64 rounded-xl bg-neutral-900 p-3 text-xs text-neutral-100 shadow-2xl">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium">Onboarding</span>
        <button type="button" onClick={() => setOpen(false)} className="text-neutral-400">
          close
        </button>
      </div>

      <select
        value={currentStepId()}
        onChange={(event) => jumpToStep(event.target.value)}
        className={`mb-2 ${SELECT_CLASS}`}
      >
        {DEV_STEP_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      <div className="mb-2 flex gap-2">
        <button
          type="button"
          onClick={restartOnboarding}
          className="flex-1 rounded-md bg-neutral-800 px-2 py-1.5"
        >
          Restart
        </button>
        <button
          type="button"
          onClick={exitOnboarding}
          className="flex-1 rounded-md bg-neutral-800 px-2 py-1.5"
        >
          Skip to app
        </button>
      </div>

      {/* Theme. Segmented rather than a select because flipping light/dark back and
          forth is the whole point — a two-click dropdown makes A/B comparison
          useless. "auto" is the shipped default, so it is marked. */}
      <div className="mb-1 flex items-center justify-between text-neutral-400">
        <span>Theme</span>
        {theme !== "auto" && <span className="text-amber-400">overridden</span>}
      </div>
      <div className="mb-2 flex gap-1 rounded-md bg-neutral-800 p-0.5">
        {THEMES.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setTheme(option)}
            className={`flex-1 rounded px-2 py-1 capitalize ${
              theme === option ? "bg-neutral-100 text-neutral-900" : "text-neutral-300"
            }`}
          >
            {option}
          </button>
        ))}
      </div>

      {/* Language. Every string in onboarding should survive all ten; the long ones
          (de, ru) are where a fixed-width pill or a two-line title breaks first. */}
      <div className="mb-1 flex items-center justify-between text-neutral-400">
        <span>Language</span>
        {uiLanguage !== "en" && <span className="text-amber-400">overridden</span>}
      </div>
      <select
        value={uiLanguage}
        onChange={(event) => setUiLanguage(event.target.value)}
        className={`mb-2 ${SELECT_CLASS}`}
      >
        {SUPPORTED_UI_LANGUAGES.map((language) => (
          <option key={language} value={language}>
            {language} — {LANGUAGE_LABELS[language]}
          </option>
        ))}
      </select>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={nativeChrome}
          onChange={(event) => setNativeChrome(event.target.checked)}
        />
        {/* Onboarding pins the window to 546x654 / 1200x910 with the traffic
            lights hidden; unlocking lets you drag-resize to check other sizes. */}
        Unlock window chrome
      </label>
    </div>
  );
}
