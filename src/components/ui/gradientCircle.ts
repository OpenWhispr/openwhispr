// Brand gradient from the Figma mic/send assets (#5B81E4 → #154BD4 → #163992, top-right to
// bottom-left), read as glass like the app icon: a specular dome in the top-left corner over
// the gradient, plus the rim/inner-glow stack in --shadow-brand-glass (bright top edge, hairline,
// darker bottom edge). transform-gpu keeps each circle on its own compositing layer from first
// paint — without it, Chromium can flash a black first frame when one mounts over backdrop-blur.
export const GRADIENT_CIRCLE =
  "bg-[radial-gradient(120%_90%_at_30%_0%,rgba(255,255,255,0.32),rgba(255,255,255,0)_55%),linear-gradient(221deg,#5B81E4_0%,#154BD4_55%,#163992_100%)] shadow-(--shadow-brand-glass) text-white transform-gpu";
