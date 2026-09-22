// Brand blue as glass, matched to the app icon: the --gradient-brand-glass ramp under the
// rim stack in --shadow-brand-glass (bright top edge, hairline, darker bottom edge). Every
// primary action wears this: the Button default variant, the mic/send circles, the upcoming
// events today header, the onboarding brand tile.
export const BRAND_GLASS_SURFACE =
  "bg-[image:var(--gradient-brand-glass)] shadow-(--shadow-brand-glass) text-white";

// transform-gpu keeps each circle on its own compositing layer from first paint — without it,
// Chromium can flash a black first frame when one mounts over backdrop-blur.
export const GRADIENT_CIRCLE = `${BRAND_GLASS_SURFACE} transform-gpu`;
