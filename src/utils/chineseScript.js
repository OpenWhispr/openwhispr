/**
 * Chinese script preference helpers for Whisper-family STT.
 *
 * Whisper language codes only expose "zh", so zh-CN / zh-TW / auto all share the
 * same STT language hint. Script choice is applied after transcription so
 * Simplified vs Traditional is deterministic. An explicit zh-CN / zh-TW also
 * biases the Whisper prompt; auto never does, because the bias would skew the
 * language detection it depends on.
 *
 * Scope: dictation only (audioManager). Meeting transcription, uploaded audio and
 * history retry strip zh-CN / zh-TW to "zh" and store the response unconverted;
 * the setting's copy is worded to match. Widening it means converting at those
 * sinks too — for retry, before updateTranscriptionText persists the row.
 *
 * See #975.
 */

const HAN_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
// Kana and Hangul never appear in Chinese, so either one rules the text out.
const KANA_RE = /[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f]/;
const HANGUL_RE = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;

/** @typedef {"simplified" | "traditional" | "as-transcribed"} ChineseScriptPreference */
/** @typedef {"simplified" | "traditional"} ChineseScriptTarget */

const VALID_PREFERENCES = new Set(["simplified", "traditional", "as-transcribed"]);

let convertersPromise = null;

// opencc-js ships ~1.2 MB of dictionaries. Import it on first conversion rather
// than at module load, so the renderer bundle stays lean for everyone who never
// dictates Chinese.
function getConverters() {
  if (!convertersPromise) {
    convertersPromise = import("opencc-js").then((OpenCC) => ({
      // twp includes Taiwan phrase variants (軟體) that plain tw misses.
      toSimplified: OpenCC.Converter({ from: "twp", to: "cn" }),
      toTraditional: OpenCC.Converter({ from: "cn", to: "twp" }),
    }));
  }
  return convertersPromise;
}

/**
 * @param {string | null | undefined} value
 * @returns {ChineseScriptPreference}
 */
export function normalizeChineseScriptPreference(value) {
  if (VALID_PREFERENCES.has(value)) return value;
  return "as-transcribed";
}

/**
 * Whether text is Han script that is plausibly Chinese rather than Japanese or
 * Korean. Kana/Hangul are decisive; kanji-only Japanese (e.g. 東京駅) is
 * indistinguishable from Chinese by script alone and reads as Chinese here.
 *
 * @param {string | null | undefined} text
 * @returns {boolean}
 */
export function isChineseText(text) {
  if (!text) return false;
  return HAN_RE.test(text) && !KANA_RE.test(text) && !HANGUL_RE.test(text);
}

/**
 * Resolve the script target from preferred language + auto-detect preference.
 *
 * zh-CN / zh-TW are an explicit user assertion and always win. On auto the
 * preference applies only to text that actually looks Chinese — otherwise
 * Japanese and Korean dictation gets rewritten (会議の資料 → 会议の数据).
 *
 * Omit `text` when no transcript exists yet (Whisper prompt building): without
 * it only an explicit language can be trusted, since biasing the prompt toward
 * Chinese would corrupt the very auto-detection it is scoped to.
 *
 * @param {string | null | undefined} preferredLanguage
 * @param {string | null | undefined} chineseScriptPreference
 * @param {string | null | undefined} [text]
 * @returns {ChineseScriptTarget | null}
 */
export function resolveChineseScriptTarget(preferredLanguage, chineseScriptPreference, text) {
  if (preferredLanguage === "zh-CN") return "simplified";
  if (preferredLanguage === "zh-TW") return "traditional";

  if ((!preferredLanguage || preferredLanguage === "auto") && isChineseText(text)) {
    const preference = normalizeChineseScriptPreference(chineseScriptPreference);
    if (preference === "simplified") return "simplified";
    if (preference === "traditional") return "traditional";
  }

  return null;
}

/**
 * Language code passed to cleanup/reasoning prompts so AI instructions match
 * the chosen Chinese script (including when STT language is auto).
 *
 * @param {string | null | undefined} preferredLanguage
 * @param {string | null | undefined} chineseScriptPreference
 * @param {string | null | undefined} [text] transcript being cleaned up
 * @returns {string}
 */
export function resolveCleanupLanguage(preferredLanguage, chineseScriptPreference, text) {
  if (preferredLanguage && preferredLanguage !== "auto") return preferredLanguage;
  const target = resolveChineseScriptTarget(preferredLanguage, chineseScriptPreference, text);
  if (target === "simplified") return "zh-CN";
  if (target === "traditional") return "zh-TW";
  return preferredLanguage || "auto";
}

/**
 * Short Whisper prompt bias so the model prefers the target character set.
 *
 * @param {ChineseScriptTarget | null} target
 * @returns {string | null}
 */
export function getChineseScriptPromptBias(target) {
  if (target === "simplified") {
    return "以下是简体中文。语言、学习、软件、网络。";
  }
  if (target === "traditional") {
    return "以下是繁體中文。語言、學習、軟體、網路。";
  }
  return null;
}

/**
 * @param {string | null | undefined} text
 * @param {ChineseScriptTarget | null} target
 * @returns {Promise<string>}
 */
export async function applyChineseScript(text, target) {
  if (!text || !target) return text || "";
  if (!HAN_RE.test(text)) return text;

  const { toSimplified: t2s, toTraditional: s2t } = await getConverters();
  return target === "simplified" ? t2s(text) : s2t(text);
}

/**
 * Merge dictionary words with an optional Chinese script bias for Whisper prompts.
 *
 * @param {string | null | undefined} dictionaryPrompt
 * @param {ChineseScriptTarget | null} target
 * @returns {string | null}
 */
export function mergeWhisperPrompt(dictionaryPrompt, target) {
  const bias = getChineseScriptPromptBias(target);
  const dict = typeof dictionaryPrompt === "string" ? dictionaryPrompt.trim() : "";
  if (bias && dict) return `${bias} ${dict}`;
  if (bias) return bias;
  return dict || null;
}
