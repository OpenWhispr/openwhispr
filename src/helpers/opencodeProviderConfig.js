// OpenCode's two products share a host and a wire shape but not a
// subscription. Go is a flat-rate plan served under /zen/go/v1 and requires a
// per-conversation `x-opencode-session` header; Zen is pay-as-you-go under
// /zen/v1 and ignores that header. Each model is served over its native
// protocol (Chat Completions, Responses, Messages, Generate Content) at its
// own inference base URL from the live list, so only the /models base URL
// and the key differ here.
//
// This module is CommonJS because the main process owns every request:
// opencode.ai answers no CORS preflight, so the renderer can't call it.

const OPENCODE_PROVIDERS = Object.freeze({
  "opencode-go": Object.freeze({
    id: "opencode-go",
    label: "OpenCode Go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    keyGetter: "getOpencodeGoKey",
    requiresSession: true,
  }),
  "opencode-zen": Object.freeze({
    id: "opencode-zen",
    label: "OpenCode Zen",
    baseUrl: "https://opencode.ai/zen/v1",
    keyGetter: "getOpencodeZenKey",
    requiresSession: false,
  }),
});

const SESSION_HEADER = "x-opencode-session";

function isOpencodeProvider(id) {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(OPENCODE_PROVIDERS, id);
}

function getOpencodeProvider(id) {
  if (!isOpencodeProvider(id)) {
    throw new Error(`Unsupported OpenCode provider: ${id}`);
  }
  return OPENCODE_PROVIDERS[id];
}

// One id per unit of work, so a request and its retries read as one
// conversation to Go's router. A chat turn passes the id it minted when its
// model was built, so every tool step in that turn is the same conversation;
// a one-shot call mints its own. Zen never sees a header it acts on.
function opencodeHeaders(
  id,
  { sessionId, randomUUID = () => require("crypto").randomUUID() } = {}
) {
  const provider = getOpencodeProvider(id);
  if (!provider.requiresSession) return {};
  return { [SESSION_HEADER]: sessionId || randomUUID() };
}

module.exports = {
  OPENCODE_PROVIDERS,
  SESSION_HEADER,
  isOpencodeProvider,
  getOpencodeProvider,
  opencodeHeaders,
};
