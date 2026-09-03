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
const { kvBytesPerToken, kvCacheBytes } = require("./ggufMetadata");

const MIN_CONTEXT = 2048;
const FALLBACK_CONTEXT = 8192;
const FALLBACK_MAX = 32768;
// Share of RAM the KV cache may occupy once the weights are accounted for. The
// rest belongs to the OS, the browser the user has open, and this app.
const MEMORY_SHARE = 0.35;
// Share of what is *actually* free. The total-RAM share above is a ceiling for
// polite behaviour on a big machine; this is a floor of reality. Budgeting 35%
// of 24 GB on a machine with 17 GB already committed is what put the desktop
// into swap on 2026-08-12 — the resolver was right, its input was not.
const AVAILABLE_SHARE = 0.8;
const MIN_KV_BUDGET = 256 * 1024 * 1024;
const MAX_KV_BUDGET = 8 * 1024 ** 3;
// A flat minimum is incoherent next to the weights: the app commits gigabytes to
// those without hesitation, then refuses the cache a few hundred megabytes and
// hands back a context too small to hold a prompt. Whenever the model is larger
// than the available-memory share, that flat floor is the only thing left
// deciding the context — so it scales with the commitment already made. Bounded
// above by the polite total-RAM allowance, so a model too large for the machine
// cannot use its own size to claim more.
const WEIGHTS_KV_FLOOR_SHARE = 0.15;

const roundDownToPowerOfTwo = (value) => 2 ** Math.floor(Math.log2(value));

/**
 * @returns {{contextSize:number, trainedContext:number|null, kvBytesPerToken:number|null,
 *   estimatedKvBytes:number|null, kvBudgetBytes:number, source:string}}
 */
function resolveContextSize({
  gguf,
  totalMemBytes,
  modelFileBytes = 0,
  requested,
  availableMemBytes,
  modelAlreadyResident = false,
} = {}) {
  const shareOfTotal = Math.floor((totalMemBytes || 0) * MEMORY_SHARE);
  // A resident model's weights are already excluded from the available figure,
  // so subtracting the file size again would double-count them and collapse the
  // context to the floor on the second run.
  const weights = modelAlreadyResident ? 0 : modelFileBytes;

  const bounds = [shareOfTotal - modelFileBytes];
  let availableBound = false;
  if (Number.isFinite(availableMemBytes)) {
    const shareOfAvailable = Math.floor(availableMemBytes * AVAILABLE_SHARE) - weights;
    availableBound = shareOfAvailable < bounds[0];
    bounds.push(shareOfAvailable);
  }

  const politeCeiling = Math.max(MIN_KV_BUDGET, shareOfTotal - modelFileBytes);
  const kvFloor = Math.min(
    Math.max(Math.floor(modelFileBytes * WEIGHTS_KV_FLOOR_SHARE), MIN_KV_BUDGET),
    politeCeiling
  );

  const kvBudgetBytes = Math.min(Math.max(Math.min(...bounds), kvFloor), MAX_KV_BUDGET);

  // `contextLength` drives the search's termination, so it is checked here and
  // not only in the reader: an infinite one halves forever, and a fractional one
  // never lands on the floor.
  const priceable =
    gguf &&
    Number.isInteger(gguf.contextLength) &&
    gguf.contextLength > 0 &&
    kvCacheBytes(gguf, MIN_CONTEXT) > 0;

  // Three different situations, deliberately answered differently. No header at
  // all is the long-standing case and keeps its established default. A header we
  // cannot price is not the same thing — it is positive evidence of corruption,
  // so it gets the floor rather than the larger default a corrupt file could
  // otherwise have aimed at. A header trained below the floor is priceable and
  // keeps its own geometry; routing it here would hand it eight times the context
  // it was trained for, with nothing costing it.
  if (gguf && !priceable) {
    return {
      contextSize: MIN_CONTEXT,
      trainedContext: null,
      kvBytesPerToken: null,
      estimatedKvBytes: null,
      kvBudgetBytes,
      source: "unpriceable-geometry",
      requested: requested ?? null,
    };
  }

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

  // A search rather than a division: on a sliding-window model the cache is not
  // linear in the context, so `budget / bytesPerToken` would be meaningless.
  let affordableContext = roundDownToPowerOfTwo(gguf.contextLength);
  while (affordableContext > MIN_CONTEXT && kvCacheBytes(gguf, affordableContext) > kvBudgetBytes) {
    affordableContext /= 2;
  }

  // Below the floor the model is useless anyway; accept the overshoot and let
  // the caller's budget check reject oversized prompts. `source` says so, since
  // "we chose 2048" and "2048 is more than this machine can hold" need different
  // answers from whoever reads the log.
  const belowFloor = kvCacheBytes(gguf, MIN_CONTEXT) > kvBudgetBytes;
  const contextSize = Math.max(affordableContext, MIN_CONTEXT);

  return {
    contextSize,
    trainedContext: gguf.contextLength,
    kvBytesPerToken: kvBytesPerToken(gguf),
    estimatedKvBytes: kvCacheBytes(gguf, contextSize),
    kvBudgetBytes,
    source: belowFloor
      ? "below-floor"
      : contextSize >= gguf.contextLength
        ? "trained-context"
        : availableBound
          ? "available-bound"
          : "memory-bound",
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
