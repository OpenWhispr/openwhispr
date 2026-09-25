const { execFile } = require("child_process");
const { buildComposeRequest, isValidEmailAddress, COMPOSE_TARGETS } = require("./emailCompose");

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

// Electron hands a Linux mailto link to xdg-email without waiting for it, so
// a missing mail app would still look like an opened draft. Only a clear "no
// default" answer refuses; if xdg-mime itself fails, the open reports it.
// Inside Flatpak the sandbox's MIME database is empty and the portal picks
// the handler, so there is nothing to ask.
function hasLinuxMailtoHandler() {
  if (process.env.FLATPAK_ID) return Promise.resolve(true);
  return new Promise((resolve) => {
    execFile(
      "xdg-mime",
      ["query", "default", "x-scheme-handler/mailto"],
      { timeout: 2000 },
      (error, stdout) => resolve(Boolean(error) || stdout.trim() !== "")
    );
  });
}

// A compose window is the user's review step: they press Send in their own
// mail client, so drafting needs no approval card.
function createEmailConnector({
  openExternal,
  writeClipboard,
  platform = process.platform,
  hasMailtoHandler = hasLinuxMailtoHandler,
}) {
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
      const failed = (errorCode, message) => ({
        state: "failed",
        errorCode,
        message,
        destinationLabel,
      });
      if (to.length === 0 || [...to, ...cc].some((address) => !isValidEmailAddress(address))) {
        return failed("invalid_address", "Every recipient must be a full email address.");
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
        return failed(
          "draft_too_long",
          "There are too many recipients for a draft link. Ask the user to add some of them in their email app."
        );
      }
      // The renderer reserves the turn's one clipboard use before calling, so
      // a draft it expected to fit its link can't replace another draft's text.
      if (request.clipboardText !== null && args.clipboardReserved !== true) {
        return failed("clipboard_unreserved", "This draft is too long for a link.");
      }
      if (target === "mailto" && platform === "linux" && !(await hasMailtoHandler())) {
        return failed(
          "open_failed",
          "No email app is set up to open drafts. Ask the user to set a default email app, or to pick Gmail or Outlook for 'Draft emails in' under Integrations."
        );
      }

      // A cancel (Esc) that landed during the checks above still stops it.
      if (runtime.signal?.aborted) return { state: "not_sent", reason: "cancelled" };
      try {
        await openExternal(request.url);
      } catch {
        return failed("open_failed", "Couldn't open your email app.");
      }
      // Only after the OS took the link, so a failed open leaves the user's
      // clipboard as it was.
      let copied = false;
      if (request.clipboardText !== null) {
        try {
          await writeClipboard(request.clipboardText, runtime.webContents ?? null);
          copied = true;
        } catch {
          // The draft is open without its text; the result says so.
        }
      }
      // The compose URL carries the body, so it is never returned or logged.
      return {
        state: "sent",
        destinationLabel,
        bodyCopied: copied && request.bodyCopied,
        subjectCopied: copied && request.subjectCopied,
        copyFailed: request.clipboardText !== null && !copied,
      };
    },
  };
}

module.exports = { createEmailConnector };
