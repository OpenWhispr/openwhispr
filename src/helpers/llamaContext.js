/**
 * Decides how much context llama-server may allocate.
 *
 * llama-server's default is `-c 0`, "use the context the model was trained for".
 * For a 131072-token model that is ~14 GB of KV cache next to 5 GB of weights —
 * enough to drive a 24 GB machine into swap and make the whole desktop
 * unresponsive. Nothing in the app bounded it, and the two callers that pass a
 * context disagree by 64x (4096 from the inference path, 262144 from the
 * registry), so this module ignores both and decides from the model's own
 * geometry and the machine's memory.
 */
const { kvBytesPerToken } = require("./ggufMetadata");

const MIN_CONTEXT = 2048;
const FALLBACK_CONTEXT = 8192;
const FALLBACK_MAX = 32768;
// Share of RAM the KV cache may occupy once the weights are accounted for. The
// rest belongs to the OS, the browser the user has open, and this app.
const MEMORY_SHARE = 0.35;
const MIN_KV_BUDGET = 256 * 1024 * 1024;
const MAX_KV_BUDGET = 8 * 1024 ** 3;

const roundDownToPowerOfTwo = (value) => 2 ** Math.floor(Math.log2(value));

/**
 * @returns {{contextSize:number, trainedContext:number|null, kvBytesPerToken:number|null,
 *   estimatedKvBytes:number|null, kvBudgetBytes:number, source:string}}
 */
function resolveContextSize({ gguf, totalMemBytes, modelFileBytes = 0, requested } = {}) {
  const kvBudgetBytes = Math.min(
    Math.max(Math.floor((totalMemBytes || 0) * MEMORY_SHARE) - modelFileBytes, MIN_KV_BUDGET),
    MAX_KV_BUDGET
  );

  if (!gguf) {
    // No readable header: pick something small enough to be safe anywhere. The
    // caller's `requested` is deliberately not trusted here either.
    return {
      contextSize: Math.min(FALLBACK_CONTEXT, FALLBACK_MAX),
      trainedContext: null,
      kvBytesPerToken: null,
      estimatedKvBytes: null,
      kvBudgetBytes,
      source: "fallback",
    };
  }

  const perToken = kvBytesPerToken(gguf);
  const affordable = Math.floor(kvBudgetBytes / perToken);
  const bounded = Math.min(affordable, gguf.contextLength);

  // Below the floor the model is useless anyway; accept the overshoot and let
  // the caller's budget check reject oversized prompts.
  const contextSize =
    bounded < MIN_CONTEXT ? MIN_CONTEXT : Math.max(roundDownToPowerOfTwo(bounded), MIN_CONTEXT);

  return {
    contextSize,
    trainedContext: gguf.contextLength,
    kvBytesPerToken: perToken,
    estimatedKvBytes: contextSize * perToken,
    kvBudgetBytes,
    source: contextSize >= gguf.contextLength ? "trained-context" : "memory-bound",
    // Recorded only so the log can show what the caller wanted and did not get.
    requested: requested ?? null,
  };
}

// Deliberately pessimistic: 3.6 chars per token undercounts nothing in English
// and errs toward rejecting a prompt we could just barely have run, which is far
// cheaper than the alternative.
const CHARS_PER_TOKEN = 3.6;
// Leave room for the system prompt and the reply.
const PROMPT_SHARE = 0.6;

const estimatePromptTokens = (text) => Math.ceil((text?.length || 0) / CHARS_PER_TOKEN);

/**
 * @returns {{fits:boolean, estimatedTokens:number, budgetTokens:number, code?:string}}
 */
function checkPromptFitsContext({ text, contextSize }) {
  const estimatedTokens = estimatePromptTokens(text);
  const budgetTokens = Math.floor(contextSize * PROMPT_SHARE);

  if (estimatedTokens <= budgetTokens) {
    return { fits: true, estimatedTokens, budgetTokens };
  }
  return { fits: false, estimatedTokens, budgetTokens, code: "LOCAL_CONTEXT_EXCEEDED" };
}

module.exports = {
  resolveContextSize,
  estimatePromptTokens,
  checkPromptFitsContext,
  MIN_CONTEXT,
  PROMPT_SHARE,
};
