/**
 * Chinese script preference helpers for Whisper-family STT.
 *
 * Whisper accepts "zh" for both explicit Chinese languages. Only those languages
 * bias the STT prompt, since a script hint would skew automatic language detection.
 * Cleanup chooses the script in context, and OpenCC corrects its reply only when
 * characters of the other script remain. Raw dictation and other outputs without
 * script-aware cleanup use OpenCC at delivery.
 *
 * Scope: dictation (audioManager) and history retry (ControlPanel). Meeting
 * transcription and uploaded audio strip zh-CN / zh-TW to "zh" and store the
 * response unconverted; the setting's copy is worded to match. Widening it means
 * converting at those sinks too, before the transcript is persisted.
 *
 * See #975.
 */

const HAN_RE = /\p{Script=Han}/u;
// Kana and Hangul never appear in Chinese, so either one rules the text out.
const KANA_RE = /[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f]/;
const HANGUL_RE = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;

// Auto mode must be conservative: Han is shared by Chinese and Japanese. These
// signals use forms that differ from modern Japanese. Shared forms and phrases
// such as 開, 電, 設定 and 資料 are deliberately absent: without a distinct
// character there is no reliable way to distinguish kanji-only Japanese.
const SIMPLIFIED_CHINESE_VARIANT_RE =
  /[这们吗简软网语汉习说发东车门问间书见长爱据实认让给还过边达选进运远违连迟适应际标亲亿优仅从众气请谢听读卖产业电备复历压类总处线证验权转导报记试计机传云丰动务场图库录页价关规办觉坏变删乐广设]/;
const TRADITIONAL_CHINESE_VARIANT_RE =
  /[這們嗎體說發據實讓邊遲應氣條聽讀寫賣兒經廣樂觀號國學會產歷壓總處證驗權轉傳豐圖錄價關辦覺壞變刪]/;

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
      // Character tables only. Unlike twp, they leave text already in the target
      // script unchanged (twp → cn turns 么 into 幺), so a difference means some
      // character is still in the other script.
      toSimplifiedCharacters: OpenCC.Converter({ from: "t", to: "cn" }),
      toTraditionalCharacters: OpenCC.Converter({ from: "cn", to: "t" }),
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
 * Whether text has positive evidence of being Chinese rather than merely
 * containing Han. Kana/Hangul rule it out, while short or mixed-script text with
 * no Chinese-specific variants/phrases stays ambiguous and is left untouched.
 *
 * @param {string | null | undefined} text
 * @returns {boolean}
 */
export function isChineseText(text) {
  if (!text) return false;
  if (KANA_RE.test(text) || HANGUL_RE.test(text)) return false;
  return SIMPLIFIED_CHINESE_VARIANT_RE.test(text) || TRADITIONAL_CHINESE_VARIANT_RE.test(text);
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
 * Language code passed to cleanup/reasoning prompts. Auto stays auto: specifying
 * zh-CN / zh-TW tells cleanup to write its entire response in Chinese, which is
 * unsafe before the transcription language is known.
 *
 * @param {string | null | undefined} preferredLanguage
 * @returns {string}
 */
export function resolveCleanupLanguage(preferredLanguage) {
  if (preferredLanguage && preferredLanguage !== "auto") return preferredLanguage;
  return "auto";
}

/**
 * Cleanup can distinguish Chinese passages in context even when the raw-text
 * detector cannot. Explicit Chinese languages already carry a script instruction.
 * A returned `cleanupScript` means an accepted reply is finalized with
 * applyChineseScriptAfterCleanup instead of a full conversion.
 * @param {string | null | undefined} preferredLanguage
 * @param {string | null | undefined} preference
 * @returns {{language: string, cleanupScript?: ChineseScriptTarget}}
 */
export function getCleanupLanguageContext(preferredLanguage, preference) {
  const language = resolveCleanupLanguage(preferredLanguage);
  const target =
    language === "auto"
      ? normalizeChineseScriptPreference(preference)
      : resolveChineseScriptTarget(language, preference);
  return target === "simplified" || target === "traditional"
    ? { language, cleanupScript: target }
    : { language };
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

  const { toSimplified, toTraditional } = await getConverters();
  return target === "simplified" ? toSimplified(text) : toTraditional(text);
}

/**
 * Script-instructed cleanup chooses characters and regional wording in context, so
 * its reply keeps them. A reply that still has characters of the other script (a
 * verbatim echo of the transcript, a model that ignored the instruction) is
 * converted like a raw transcript.
 *
 * @param {string | null | undefined} text
 * @param {ChineseScriptTarget | null} target
 * @returns {Promise<string>}
 */
export async function applyChineseScriptAfterCleanup(text, target) {
  if (!text || !target) return text || "";
  if (!HAN_RE.test(text)) return text;

  const { toSimplifiedCharacters, toTraditionalCharacters } = await getConverters();
  const inTarget =
    target === "simplified" ? toSimplifiedCharacters(text) : toTraditionalCharacters(text);
  return inTarget === text ? text : applyChineseScript(text, target);
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
