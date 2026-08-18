import { useState, type ReactNode } from "react";
import { Check, CircleCheck, Search, Undo2, X } from "lucide-react";
import { Button } from "../components/ui/button";
import { OnboardingProgress } from "../components/onboarding/OnboardingShell";
import OnboardingList from "../components/onboarding/OnboardingList";
import { HotkeyChord } from "../components/onboarding/ShortcutSetupStep";
import { ConfettiLayer } from "../components/onboarding/DemoStep";

/**
 * Dev-only component gallery for the onboarding buttons and list rows.
 *
 * Served at http://localhost:5183/kitchen.html — see src/kitchen.html.
 *
 * Everything renders inside `.onboarding-canvas` because that element is where
 * the onboarding design tokens (--onboarding-accent, --onboarding-text-*, …) and
 * the Inter font stack are declared. Outside it, colours silently fall back.
 *
 * The shared primitives (.onboarding-list, .onboarding-list-row, and the hover
 * slab) come straight from index.css, so tuning them here tunes the real UI.
 * The button class strings mirror OnboardingShell.tsx and
 * CompactPermissionsStep.tsx — if you change them there, change them here.
 */

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-medium text-[var(--onboarding-text-primary)]">{title}</h2>
        {note && <p className="text-sm text-[var(--onboarding-text-secondary)]">{note}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-white/60 p-4 ring-1 ring-[var(--onboarding-control-border)]">
        {children}
      </div>
    </section>
  );
}

function Label({ children }: { children: ReactNode }) {
  return (
    <span className="w-full text-xs uppercase tracking-wide text-[var(--onboarding-text-tertiary)]">
      {children}
    </span>
  );
}

// Mirrors the row button in CompactPermissionsStep.tsx.
const PERMISSION_BUTTON_BASE =
  "inline-flex h-9 min-w-24 shrink-0 items-center justify-center gap-1.5 rounded-full px-3 text-sm font-normal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 disabled:cursor-default";
const PERMISSION_NEUTRAL =
  "bg-neutral-200 text-neutral-500 hover:bg-neutral-300 disabled:bg-neutral-200 disabled:text-neutral-500";
const PERMISSION_GRANTED =
  "bg-[color-mix(in_srgb,var(--onboarding-accent)_12%,transparent)] text-[var(--onboarding-accent)] disabled:bg-[color-mix(in_srgb,var(--onboarding-accent)_12%,transparent)] disabled:text-[var(--onboarding-accent)]";
const PERMISSION_PRIMARY = "bg-blue-500 text-white hover:bg-blue-600";

// Mirrors the continue button in OnboardingShell.tsx (Figma "Frame 31 → Frame 25").
const CONTINUE_BUTTON =
  "h-10 gap-4 rounded-[38px] border-0 bg-[var(--onboarding-accent)] px-6 py-2.5 text-sm font-medium leading-[1.4] tracking-normal text-white shadow-none! hover:bg-[color-mix(in_srgb,var(--onboarding-accent)_88%,black)] hover:shadow-none! disabled:bg-neutral-200 disabled:text-neutral-500 disabled:opacity-100!";

const LANGUAGES = [
  { name: "English", native: "English", checked: true },
  { name: "Chinese - Simplified", native: "简体中文", checked: false },
  { name: "Spanish", native: "Español", checked: true },
  { name: "Arabic", native: "العربية", checked: false },
];

export default function Kitchen() {
  // Remounting on a new key re-runs the effect, which is what fires the cannons.
  const [burst, setBurst] = useState(0);
  const [scalar, setScalar] = useState(1.3);

  return (
    <main className="onboarding-canvas min-h-screen px-10 py-12">
      <header className="mb-10">
        <h1 className="onboarding-display-title">Onboarding kitchen</h1>
        <p className="mt-2 text-sm text-[var(--onboarding-text-secondary)]">
          Real components, real tokens. Open the dial panel (bottom right) to tune them live.
        </p>
      </header>

      <div className="mx-auto grid max-w-5xl gap-10">
        <Section
          title="Shell footer"
          note="OnboardingShell.tsx — back, skip and continue, plus continue's disabled and loading states."
        >
          <Button
            type="button"
            variant="outline-flat"
            size="icon"
            className="h-10 w-10 rounded-full! border! border-neutral-200! bg-white! p-0 text-neutral-950 hover:bg-neutral-50!"
            aria-label="Back"
          >
            <Undo2 className="size-4" />
          </Button>
          <Button
            type="button"
            variant="outline-flat"
            size="default"
            className="h-10 min-w-[5.5rem] rounded-full! border! border-neutral-200! bg-white! px-4 text-neutral-950 hover:bg-neutral-50!"
          >
            <Undo2 className="size-4" />
            Back
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="h-10 min-w-[5.5rem] rounded-full px-4 text-sm"
          >
            Skip
          </Button>
          <Button type="button" className={CONTINUE_BUTTON}>
            Continue
          </Button>
          <Button type="button" disabled className={CONTINUE_BUTTON}>
            Continue
          </Button>
          <Button type="button" disabled className={CONTINUE_BUTTON}>
            Loading…
          </Button>
          <Label>Progress</Label>
          {[0, 1, 2, 3].map((index) => (
            <OnboardingProgress key={index} index={index} />
          ))}
        </Section>

        <Section
          title="Permission row buttons"
          note="CompactPermissionsStep.tsx — the granted pill is disabled on purpose, so its disabled: variants must restate the tint."
        >
          <button type="button" className={`${PERMISSION_BUTTON_BASE} ${PERMISSION_NEUTRAL}`}>
            Enable
          </button>
          <button
            type="button"
            disabled
            className={`${PERMISSION_BUTTON_BASE} ${PERMISSION_GRANTED}`}
          >
            <CircleCheck className="size-4 shrink-0" aria-hidden="true" />
            Enabled
          </button>
          <button type="button" className={`${PERMISSION_BUTTON_BASE} ${PERMISSION_PRIMARY}`}>
            Continue
          </button>
          <button
            type="button"
            disabled
            className={`${PERMISSION_BUTTON_BASE} ${PERMISSION_NEUTRAL}`}
          >
            Enable
          </button>
        </Section>

        <Section
          title="Compact skip"
          note="Sits on the indigo hero, so it is white-on-translucent."
        >
          <div className="flex w-full justify-end rounded-2xl bg-gradient-to-b from-indigo-400 via-indigo-300 to-white p-5">
            <button
              type="button"
              className="h-8 rounded-full bg-white/20 px-3 text-sm font-medium text-white transition-colors hover:bg-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              Skip
            </button>
          </div>
        </Section>

        <Section
          title="Selected language pill"
          note="Figma Frame 38 — gap 7, pad 10 20, 20px close glyph."
        >
          {["English", "Spanish", "Chinese - Simplified"].map((name) => (
            <button
              key={name}
              type="button"
              className="inline-flex items-center gap-[7px] rounded-full border border-[var(--onboarding-control-border)] bg-white px-5 py-2.5 text-sm font-medium leading-[1.4] text-[var(--onboarding-text-primary)] hover:bg-neutral-50"
            >
              {name}
              <X className="size-5 shrink-0" strokeWidth={1.667} />
            </button>
          ))}
        </Section>

        <Section
          title="Search field"
          note="Figma Frame 25 — pad 12 16, 24px icon, 18/140% placeholder in text-tertiary."
        >
          <label className="relative block w-full max-w-[33.75rem]">
            <Search
              className="pointer-events-none absolute left-4 top-1/2 size-6 -translate-y-1/2 text-[var(--onboarding-text-tertiary)]"
              strokeWidth={2}
            />
            <input
              type="search"
              placeholder="Search languages"
              className="onboarding-light-input onboarding-light-input-bordered w-full rounded-full! border border-[var(--onboarding-control-border)] bg-white py-3 pl-[3.125rem] pr-4 text-[1.125rem] leading-[1.4] text-[var(--onboarding-text-primary)] shadow-none! outline-none placeholder:text-[var(--onboarding-text-tertiary)]"
            />
          </label>
        </Section>

        <Section
          title="Dictation success confetti"
          note="DemoStep.tsx — fires only on the dictation demo reaching status success. Two corner cannons plus a delayed puff; opts out under prefers-reduced-motion."
        >
          {[1, 1.3, 1.8, 2.4].map((size) => (
            <button
              key={size}
              type="button"
              onClick={() => {
                setScalar(size);
                setBurst((n) => n + 1);
              }}
              className={`rounded-full px-5 py-2 text-sm font-medium transition-colors ${
                scalar === size
                  ? "bg-[var(--onboarding-accent)] text-white"
                  : "border border-[var(--onboarding-control-border)] text-[var(--onboarding-text-primary)] hover:bg-neutral-50"
              }`}
            >
              scalar {size}
            </button>
          ))}
          <span className="text-sm text-[var(--onboarding-text-secondary)]">
            {burst > 0 ? `last: scalar ${scalar}` : "1.3 is the shipped value"}
          </span>
          {burst > 0 && <ConfettiLayer key={burst} scalar={scalar} />}
        </Section>

        <Section
          title="Keycaps"
          note="ShortcutSetupStep.tsx. <kbd> defaults to monospace in the UA stylesheet, so .onboarding-canvas kbd opts back in to Inter."
        >
          <HotkeyChord value="CommandOrControl+Shift+Space" />
        </Section>

        <Section
          title="List rows"
          note="Hover any row: the slab bleeds past the dividers and removes the two it touches. Dial radius, bleed and tint in the panel."
        >
          <OnboardingList className="w-full max-w-[33.75rem]" maxHeightClassName="max-h-[20.5rem]">
            {LANGUAGES.map((language) => (
              <button
                key={language.name}
                type="button"
                role="checkbox"
                aria-checked={language.checked}
                className="onboarding-list-row w-full text-left"
              >
                <span
                  className={`flex size-6 shrink-0 items-center justify-center rounded-[5.5px] border border-[var(--onboarding-control-border)] ${
                    language.checked ? "bg-[var(--onboarding-accent)] text-white" : "bg-white"
                  }`}
                  aria-hidden="true"
                >
                  {language.checked && <Check className="size-4" strokeWidth={1.17} />}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate text-base font-medium leading-[1.4] text-[var(--onboarding-text-primary)]">
                    {language.name}
                  </span>
                  <span
                    className="truncate text-sm font-normal leading-[1.4] text-[var(--onboarding-text-secondary)]"
                    dir="auto"
                  >
                    {language.native}
                  </span>
                </span>
              </button>
            ))}
          </OnboardingList>
        </Section>
      </div>
    </main>
  );
}
