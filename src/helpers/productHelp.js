const { compareVersions } = require("./parakeetCapability");
const topics = require("../config/productHelpTopics.json");
const AgentStreamRequestRegistry = require("./agentStreamRequestRegistry");

const ENDPOINT = "https://docs.openwhispr.com/mcp";
const ORIGIN = "https://docs.openwhispr.com";
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_TEXT = 64000;

function validPage(value) {
  return (
    typeof value === "string" &&
    value.length <= 160 &&
    /^\/(?:help|guides|platform|integrations)\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(value)
  );
}

function bundled(topic, reason) {
  const article = topics[topic];
  return {
    source: "bundled",
    reason,
    retrievedAt: null,
    articles: [
      {
        title: topic,
        url: ORIGIN + article.path,
        path: article.path,
        text: article.text,
      },
    ],
  };
}

async function readBounded(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("Help response too large");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function parseRpc(text, id) {
  const messages = text.trim().startsWith("{")
    ? [text]
    : text
        .split(/\r?\n\r?\n/)
        .map((block) =>
          block
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n")
        )
        .filter(Boolean);
  for (const message of messages) {
    const parsed = JSON.parse(message);
    if (parsed.id !== id) continue;
    if (parsed.error || parsed.result?.isError || !parsed.result)
      throw new Error("Help unavailable");
    return parsed.result;
  }
  throw new Error("Missing help response");
}

function createProductHelp({ fetch, now = Date.now }) {
  // Public, fixed-topic queries only: no account credentials, settings or user text.
  let windowStart = now();
  let requests = 0;
  async function lookup({ topic, page }, { signal, allowed }) {
    if (
      !Object.hasOwn(topics, topic) ||
      (page !== undefined && (!validPage(page) || !topics[topic].paths.includes(page)))
    )
      throw new Error(
        "Invalid help request: use an exact path returned for this topic, including its leading slash and without .mdx. Stop retrying the path; request the topic essentials instead."
      );
    if (signal.aborted) throw new Error("Cancelled");
    if (!allowed) return bundled(topic, "policy");
    if (now() - windowStart >= 60000) {
      windowStart = now();
      requests = 0;
    }
    if (++requests > 12) return bundled(topic, "rateLimit");
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(12000)]);
    try {
      let sessionId;
      async function rpc(id, method, params) {
        const response = await fetch(ENDPOINT, {
          method: "POST",
          redirect: "error",
          credentials: "omit",
          signal: boundedSignal,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2024-11-05",
            ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
          },
          body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }),
        });
        if (!response.ok) throw new Error("Help unavailable");
        sessionId = response.headers.get("mcp-session-id") || sessionId;
        if (id === null) {
          await response.body?.cancel();
          return;
        }
        return parseRpc(await readBounded(response), id);
      }
      await rpc(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "openwhispr-help", version: "1" },
      });
      await rpc(null, "notifications/initialized", {});
      // Read complete curated pages, not broad search snippets that can rank another
      // platform first or truncate the instructions that answer the question.
      const paths = page ? [page] : topics[topic].paths;
      const articles = [];
      for (const [index, path] of paths.entries()) {
        const result = await rpc(2 + index, "tools/call", {
          name: "query_docs_filesystem_open_whispr",
          arguments: { command: `cat ${path}.mdx` },
        });
        const rawText = (result.content || [])
          .filter((c) => c.type === "text" && typeof c.text === "string")
          .map((c) => c.text)
          .join("\n");
        const exit = rawText.match(/^exit:\s*(\d+)/);
        if (exit && exit[1] !== "0") return bundled(topic, "unavailable");
        const text = rawText.replace(/^exit: 0\r?\n--- stdout ---\r?\n/, "");
        // A partial, empty or failed page is not complete evidence. Fall back
        // explicitly rather than silently clipping content and calling it live.
        if (
          !text.trim() ||
          text.length > MAX_TEXT ||
          /^(?:error:|file not found|no such file)/im.test(text) ||
          /\[(?:output |content )?truncated\]/i.test(text)
        ) {
          return bundled(topic, "unavailable");
        }
        articles.push({
          title:
            text.match(/^# (.+)$/m)?.[1] ||
            text.match(/^title:\s*["']?([^"'\n]+)/m)?.[1] ||
            path.split("/").pop(),
          path,
          url: ORIGIN + path,
          text,
        });
      }
      return { source: "live", reason: null, retrievedAt: new Date(now()).toISOString(), articles };
    } catch {
      if (signal.aborted) throw new Error("Cancelled");
      return bundled(topic, "unavailable");
    }
  }
  return { lookup };
}

function remoteHelpAllowed(snapshot, appVersion) {
  if (snapshot?.success !== true) return false;
  if (snapshot.managed === false) return true;
  return (
    snapshot.managed === true &&
    (!snapshot.policy?.minAppVersion ||
      (typeof appVersion === "string" &&
        /^\d+\.\d+\.\d+$/.test(appVersion) &&
        compareVersions(appVersion, snapshot.policy.minAppVersion) >= 0)) &&
    snapshot.policy?.features?.webSearchEnabled === true &&
    snapshot.policy?.llm?.allowedModes?.some(
      (mode) => mode === "openwhispr" || mode === "providers"
    )
  );
}

function registerProductHelpIpc({ ipcMain, fetch, canLookup, getBasics }) {
  const help = createProductHelp({ fetch });
  const requests = new AgentStreamRequestRegistry();
  const active = new Map();
  ipcMain.handle("product-help-basics", () => getBasics());
  ipcMain.handle("product-help", async (event, id, input) => {
    if (typeof id !== "string" || id.length > 100 || !id || (active.get(event.sender.id) || 0) >= 4)
      throw new Error("Help request unavailable");
    const sender = event.sender;
    const controller = requests.begin(sender.id, id);
    active.set(sender.id, (active.get(sender.id) || 0) + 1);
    const destroyed = () => requests.cancelSender(sender.id);
    sender.once("destroyed", destroyed);
    try {
      const policySignal = AbortSignal.any([controller.signal, AbortSignal.timeout(1500)]);
      const allowed = await new Promise((resolve) => {
        const stop = () => resolve(false);
        policySignal.addEventListener("abort", stop, { once: true });
        Promise.resolve()
          .then(() => canLookup(event, policySignal))
          .then(resolve, () => resolve(false))
          .finally(() => policySignal.removeEventListener("abort", stop));
      });
      return await help.lookup(input || {}, { signal: controller.signal, allowed });
    } finally {
      const remaining = (active.get(sender.id) || 1) - 1;
      if (remaining) active.set(sender.id, remaining);
      else active.delete(sender.id);
      sender.removeListener("destroyed", destroyed);
      requests.complete(sender.id, id, controller);
    }
  });
  ipcMain.on("product-help-cancel", (event, id) => requests.cancel(event.sender.id, id));
}

module.exports = {
  createProductHelp,
  registerProductHelpIpc,
  remoteHelpAllowed,
  validPage,
  parseRpc,
};
