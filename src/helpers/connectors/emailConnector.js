const { buildComposeRequest, isValidEmailAddress, COMPOSE_TARGETS } = require("./emailCompose");

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

// A compose window is the user's review step: they press Send in their own
// mail client, so drafting needs no approval card.
function createEmailConnector({ openExternal, writeClipboard, platform = process.platform }) {
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
      // Failures carry it too, so the receipt says whose draft didn't open.
      const destinationLabel = to.join(", ");
      if (to.length === 0 || [...to, ...cc].some((address) => !isValidEmailAddress(address))) {
        return {
          state: "failed",
          errorCode: "invalid_address",
          message: "Every recipient must be a full email address.",
          destinationLabel,
        };
      }
      const target = COMPOSE_TARGETS.includes(args.target) ? args.target : "mailto";
      const request = buildComposeRequest({
        target,
        to,
        cc,
        subject: typeof args.subject === "string" ? args.subject : "",
        body: typeof args.body === "string" ? args.body : "",
        platform,
      });
      if (!request.ok) {
        return {
          state: "failed",
          errorCode: "draft_too_long",
          message:
            "There are too many recipients for a draft link. Ask the user to add some of them in their email app.",
          destinationLabel,
        };
      }

      try {
        await openExternal(request.url);
      } catch {
        return {
          state: "failed",
          errorCode: "open_failed",
          message: "Couldn't open your email app.",
          destinationLabel,
        };
      }
      // Only once the window opened, so a failed open leaves the user's
      // clipboard as it was.
      if (request.clipboardText !== null) {
        await writeClipboard(request.clipboardText, runtime.webContents ?? null);
      }
      // The compose URL carries the body, so it is never returned or logged.
      return {
        state: "sent",
        destinationLabel,
        bodyCopied: request.clipboardText !== null,
        subjectCopied: request.subjectCopied,
      };
    },
  };
}

module.exports = { createEmailConnector };
