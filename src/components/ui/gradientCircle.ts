// Brand gradient from the Figma mic/send assets (#5B81E4 → #154BD4 → #163992, top-right to bottom-left).
// transform-gpu keeps each circle on its own compositing layer from first paint —
// without it, Chromium can flash a black first frame when one mounts over backdrop-blur.
export const GRADIENT_CIRCLE =
  "bg-[linear-gradient(221deg,#5B81E4_0%,#154BD4_55%,#163992_100%)] text-white transform-gpu";
