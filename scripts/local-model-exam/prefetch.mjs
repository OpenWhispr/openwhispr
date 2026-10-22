// Downloads and caches the test material without running any engine.
//   node --import tsx scripts/local-model-exam/prefetch.mjs [--clips 12]
import { log, parseArgs } from "./lib/cli.mjs";
import { DICTATION_SENTENCES, FLEURS_LANGUAGES, loadFleurs, loadSynthetic } from "./lib/sets.mjs";

const clips = Number(parseArgs().clips || 12);
for (const language of FLEURS_LANGUAGES) {
  const got = await loadFleurs(language, language === "en" ? Math.max(40, clips) : clips);
  log(language, got.length);
}
for (const language of Object.keys(DICTATION_SENTENCES)) await loadSynthetic(language);
log("material ready");
