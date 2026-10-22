// Downloads and caches the test material without running any engine.
//   node --import tsx scripts/local-model-exam/prefetch.mjs [--clips 12]
import { DICTATION_SENTENCES, FLEURS_LANGUAGES, loadFleurs, loadSynthetic } from "./lib/sets.mjs";
const i = process.argv.indexOf("--clips");
const clips = Number(i > 0 ? process.argv[i + 1] : 12);
for (const language of FLEURS_LANGUAGES) {
  const got = await loadFleurs(language, language === "en" ? Math.max(40, clips) : clips);
  console.log(new Date().toISOString().slice(11, 19), language, got.length);
}
for (const language of Object.keys(DICTATION_SENTENCES)) await loadSynthetic(language);
console.log("material ready");
