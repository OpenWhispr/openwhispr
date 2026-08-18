import { useEffect, useState } from "react";

import {
  DEV_STEP_OPTIONS,
  currentStepId,
  exitOnboarding,
  jumpToStep,
  restartOnboarding,
} from "./onboardingSteps";

/**
 * Development-only onboarding tooling: jump to any step, restart, skip to the
 * app, and unlock the window chrome to check steps at other sizes.
 *
 * Deliberately dependency-free. This used to host a DialKit panel for live design
 * dials and the Agentation annotation toolbar; both are gone, along with the
 * design-override stylesheet they drove — every value they tuned is now written
 * into index.css from the Figma specs, so keeping a second source of truth for the
 * same numbers was a liability (a stale dial default silently reverted the real
 * design more than once).
 *
 * Only ever mounted behind `import.meta.env.DEV`, so none of this reaches a
 * production build. Strings are intentionally not run through i18n: this UI is
 * never shown to a user.
 */
export default function DevTools() {
  const [open, setOpen] = useState(false);
  const [nativeChrome, setNativeChrome] = useState(false);

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
        className="mb-2 w-full rounded-md bg-neutral-800 px-2 py-1.5 text-xs"
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
