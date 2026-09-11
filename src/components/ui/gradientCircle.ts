// Brand gradient from the Figma mic/send assets (#5B81E4 → #154BD4 → #163992, top-right to
// bottom-left), under a top-lit white sheen and an inner rim so it reads as glass like the
// app icon; the sheen is also what lifts the blue.
// transform-gpu keeps each circle on its own compositing layer from first paint —
// without it, Chromium can flash a black first frame when one mounts over backdrop-blur.
export const GRADIENT_CIRCLE =
  "bg-[linear-gradient(180deg,rgba(255,255,255,0.28),rgba(255,255,255,0.06)_55%,rgba(255,255,255,0)),linear-gradient(221deg,#5B81E4_0%,#154BD4_55%,#163992_100%)] shadow-(--shadow-brand-glass) text-white transform-gpu";
