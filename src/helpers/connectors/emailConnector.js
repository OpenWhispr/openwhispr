const { buildComposeRequest, isValidEmailAddress, COMPOSE_TARGETS } = require("./emailCompose");

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

// A compose window is the user's review step: they press Send in their own
// mail client, so drafting needs no approval card.
function createEmailConnector({ openExternal, writeClipboard }) {
  return {
    id: "email",
    actions: { draft: { kind: "direct" } },

    async getStatus() {
      return { connected: true, accountLabel: null };
    },

    async getBinding() {
      return null;
    },

    async runDirect(action, args, runtime) {
      if (action !== "draft") {
        return { state: "failed", errorCode: "unknown_action", message: "Unknown email action." };
      }
      const to = stringList(args.to);
      const cc = stringList(args.cc);
      if (to.length === 0 || [...to, ...cc].some((address) => !isValidEmailAddress(address))) {
        return {
          state: "failed",
          errorCode: "invalid_address",
          message: "Every recipient must be a full email address.",
        };
      }
      const target = COMPOSE_TARGETS.includes(args.target) ? args.target : "mailto";
      const request = buildComposeRequest({
        target,
        to,
        cc,
        subject: typeof args.subject === "string" ? args.subject : "",
        body: typeof args.body === "string" ? args.body : "",
      });
      if (!request.ok) {
        return {
          state: "failed",
          errorCode: "draft_too_long",
          message: "There are too many recipients for a draft link. Ask the user to add some of them in their email app.",
        };
      }

      try {
        if (request.clipboardText !== null) {
          await writeClipboard(request.clipboardText, runtime.webContents ?? null);
        }
        await openExternal(request.url);
      } catch {
        return {
          state: "failed",
          errorCode: "open_failed",
          message: "Couldn't open your email app.",
        };
      }
      // The compose URL carries the body, so it is never returned or logged.
      return {
        state: "sent",
        destinationLabel: to.join(", "),
        bodyCopied: request.clipboardText !== null,
        subjectCopied: request.subjectCopied,
      };
    },
  };
}

module.exports = { createEmailConnector };
