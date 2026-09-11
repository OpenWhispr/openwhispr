// Brand blue as glass, matched to the app icon: a light-to-mid sky gradient (a touch darker
// than the icon so white content stays crisp) under the rim stack in --shadow-brand-glass
// (bright top edge, hairline, darker bottom edge). Every primary action wears this: the
// Button default variant, the mic/send circles, the upcoming-events today header.
export const BRAND_GLASS_SURFACE =
  "bg-[linear-gradient(180deg,#5588F0_0%,#3466E2_100%)] shadow-(--shadow-brand-glass) text-white";

// transform-gpu keeps each circle on its own compositing layer from first paint — without it,
// Chromium can flash a black first frame when one mounts over backdrop-blur.
export const GRADIENT_CIRCLE = `${BRAND_GLASS_SURFACE} transform-gpu`;
