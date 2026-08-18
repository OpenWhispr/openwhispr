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
      // mt-10 is Frame 50's 40 gap below the header.
      className="mx-auto mt-10 h-[318px] min-h-0 w-[561px] max-w-full shrink select-none rounded-[20px] border border-[var(--onboarding-control-border)] object-cover"
    />
  );
}
