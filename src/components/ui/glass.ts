// Liquid-glass capsule surface (pairs with the --shadow-glass token in index.css).
// transform-gpu keeps the surface on its own compositing layer from first paint —
// without it, Chromium can flash a black first frame when backdrop-blur mounts.
export const GLASS_SURFACE =
  "bg-white/55 dark:bg-white/6 backdrop-blur-xl backdrop-saturate-150 shadow-(--shadow-glass) transform-gpu";
