import assistantPreview from "../../assets/onboarding-assistant-preview.webp";

/**
 * The OpenWhispr Assistant illustration on the assistant-hotkey step.
 *
 * A single exported image rather than a DOM composition: the artwork (grass
 * backdrop, prompt bubble, mail window, dictation pill) ships as one 2x export,
 * so it matches Figma exactly and cannot drift.
 *
 * Tradeoff, deliberately accepted: the copy inside the mock-up is pixels now, so
 * it stays English in every locale. It is illustrative chrome, not UI the user
 * reads for meaning.
 *
 * `shrink` + `min-h-0` matter — this is decoration, so on a short window it gives
 * way and crops rather than pushing the hotkey capture box out of the shell.
 */
export default function AssistantHotkeyPreview() {
  return (
    <img
      src={assistantPreview}
      alt=""
      aria-hidden="true"
      width={561}
      height={318}
      decoding="async"
      draggable={false}
      className="mx-auto mt-6 h-auto min-h-0 w-full max-w-[26rem] shrink select-none rounded-2xl border border-[var(--onboarding-control-border)] object-cover"
    />
  );
}
