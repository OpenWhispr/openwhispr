/**
 * Chinese script preference helpers for Whisper-family STT.
 *
 * Whisper language codes only expose "zh", so zh-CN / zh-TW / auto all share the
 * same STT language hint. Script choice is applied after transcription (and as a
 * Whisper prompt bias) so Simplified vs Traditional is deterministic.
 *
 * See #975.
 */

import * as OpenCC from "opencc-js";

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

/** @typedef {"simplified" | "traditional" | "as-transcribed"} ChineseScriptPreference */
/** @typedef {"simplified" | "traditional"} ChineseScriptTarget */

const VALID_PREFERENCES = new Set(["simplified", "traditional", "as-transcribed"]);

let toSimplified = null;
let toTraditional = null;

function getConverters() {
  if (!toSimplified) {
    // twp includes Taiwan phrase variants (軟體) that plain tw misses.
    toSimplified = OpenCC.Converter({ from: "twp", to: "cn" });
    toTraditional = OpenCC.Converter({ from: "cn", to: "twp" });
  }
  return { toSimplified, toTraditional };
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
 * Resolve the script target from preferred language + auto-detect preference.
 * zh-CN / zh-TW always win; the preference only applies when language is auto.
 *
 * @param {string | null | undefined} preferredLanguage
 * @param {string | null | undefined} chineseScriptPreference
 * @returns {ChineseScriptTarget | null}
 */
export function resolveChineseScriptTarget(preferredLanguage, chineseScriptPreference) {
  if (preferredLanguage === "zh-CN") return "simplified";
  if (preferredLanguage === "zh-TW") return "traditional";

  if (!preferredLanguage || preferredLanguage === "auto") {
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
 * @returns {string}
 */
export function resolveCleanupLanguage(preferredLanguage, chineseScriptPreference) {
  if (preferredLanguage && preferredLanguage !== "auto") return preferredLanguage;
  const target = resolveChineseScriptTarget(preferredLanguage, chineseScriptPreference);
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
 * @returns {string}
 */
export function applyChineseScript(text, target) {
  if (!text || !target) return text || "";
  if (!CJK_RE.test(text)) return text;

  const { toSimplified: t2s, toTraditional: s2t } = getConverters();
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
