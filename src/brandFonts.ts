// Registers the Yowza brand faces when their files are present in the build.
//
// Yowza is a licensed typeface (Blaze Type), so the .otf files are not in git:
// scripts/download-brand-fonts.js fetches them at build time and vite bundles
// them into app.asar as hashed assets. In a build without them the glob below is
// empty, nothing is registered, and every `--font-family-*` token falls through
// to Noto Sans. Nothing is ever fetched at runtime.
const FACES: Record<string, { family: string; weight: string }> = {
  "yowza-std-regular": { family: "Yowza", weight: "400" },
  // Medium covers 500–600: the family has no Semibold, and letting
  // `font-semibold` fall to Bold made labels and card titles read heavy.
  "yowza-std-medium": { family: "Yowza", weight: "500 600" },
  "yowza-std-bold": { family: "Yowza", weight: "700" },
  "yowza-soft-std-regular": { family: "Yowza Soft", weight: "400" },
  "yowza-soft-std-medium": { family: "Yowza Soft", weight: "500" },
};

const fontUrls = import.meta.glob("./assets/fonts/yowza/*.otf", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const rules = Object.entries(fontUrls).flatMap(([file, url]) => {
  const face = FACES[file.slice(file.lastIndexOf("/") + 1, -".otf".length)];
  return face
    ? [
        `@font-face{font-family:"${face.family}";font-style:normal;font-weight:${face.weight};font-display:swap;src:url("${url}") format("opentype")}`,
      ]
    : [];
});

if (rules.length) {
  const style = document.createElement("style");
  style.textContent = rules.join("\n");
  document.head.append(style);
}
