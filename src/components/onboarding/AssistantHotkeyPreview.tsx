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
 * This stays above the shortcut controls and outside the shrinking flex pool.
 * The frame is a fixed band rather than the export's 16:9 — at full height the
 * step needed a scroll to reach the recommendations — and it crops a lightly
 * enlarged image, biased toward the top, so the spoken request and the mail
 * window stay in view while no export edge or component border shows.
 */
export default function AssistantHotkeyPreview() {
  return (
    <div className="mx-auto mt-3 h-44 w-full max-w-[30rem] shrink-0 overflow-hidden rounded-2xl">
      <img
        src={assistantPreview}
        alt=""
        aria-hidden="true"
        width={561}
        height={318}
        decoding="async"
        draggable={false}
        className="h-full w-full scale-105 select-none object-cover object-[50%_38%]"
      />
    </div>
  );
}
