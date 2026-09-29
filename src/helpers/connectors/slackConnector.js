const { resolveTarget } = require("./targetResolution");
const { isValidEmailAddress } = require("./emailCompose");

// markdown_text's documented limit, applied to what Slack receives.
const SLACK_MESSAGE_LIMIT = 12000;
// Slack refused the token, so it did nothing: refresh and repeat once. A
// revoked login fails that refresh, which flags it for a reconnect.
const RETRY_AFTER_REFRESH = new Set([
  "token_expired",
  "invalid_auth",
  "http_401",
  "token_revoked",
  "account_inactive",
  "not_authed",
]);
// Plan Task 3: whether markdown_text turns <!here>, <@U…> and <url> into
// mentions and links.
const SLACK_ESCAPE_SPECIALS = true;
const TOO_LARGE_FOR_NAMES =
  "This Slack workspace is too large to look people up by name. Ask the user for the person's email address, or the exact #channel name.";

// Escaping &, < and > makes a message post exactly as the card showed it:
// no channel-wide mention or link the user didn't see.
function escapeSpecials(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// What Slack receives in the message field. Escaping lengthens the text, so
// the limit is checked on this, not on what the user typed.
function formatMessage(text) {
  return SLACK_ESCAPE_SPECIALS ? escapeSpecials(text) : text;
}

function messageParams(channel, text) {
  return { channel, markdown_text: formatMessage(text) };
}

// chat.postMessage returns no permalink; this is Slack's permalink format.
function messageUrl(teamUrl, channel, ts) {
  if (typeof teamUrl !== "string" || typeof ts !== "string") return undefined;
  return `${teamUrl.replace(/\/?$/, "/")}archives/${channel}/p${ts.replace(".", "")}`;
}

function failureMessage(errorCode, label = "", fallback = "Slack didn't accept the message.") {
  switch (errorCode) {
    case "not_in_channel":
      return `You're not a member of ${label}.`;
    case "channel_not_found":
      return `${label} couldn't be found in Slack anymore.`;
    case "is_archived":
      return `${label} is archived.`;
    case "reconnect_needed":
    case "token_revoked":
    case "invalid_auth":
    case "account_inactive":
    case "not_authed":
      return "Slack needs to be reconnected in Settings.";
    case "connection_changed":
      return "The Slack connection changed before sending, so nothing was sent.";
    case "rate_limited":
    case "ratelimited":
      return "Slack is busy. Try again shortly.";
    case "missing_scope":
      return "OpenWhispr doesn't have permission to post there. Reconnect Slack in Settings.";
    case "msg_too_long":
      return "The message is too long for Slack (12,000 characters at most, once formatted).";
    case "no_text":
      return "The message is empty.";
    default:
      return fallback;
  }
}

function textProblem(text) {
  if (typeof text !== "string" || !text.trim()) return "no_text";
  if (formatMessage(text).length > SLACK_MESSAGE_LIMIT) return "msg_too_long";
  return null;
}

function parseDestination(raw) {
  const value = raw.trim();
  if (value.startsWith("#")) return { kind: "channel", query: value.slice(1) };
  if (isValidEmailAddress(value)) return { kind: "email", query: value };
  if (value.startsWith("@")) return { kind: "person", query: value.slice(1) };
  return { kind: "any", query: value };
}

function clarify(message, candidates = []) {
  return {
    status: "needs_clarification",
    message,
    candidates: candidates.map((candidate) => candidate.hint ?? candidate.label),
  };
}

function prepareFailed(errorCode, message) {
  return { status: "failed", errorCode, message };
}

function createSlackConnector({ api, auth, directory, credentials }) {
  async function findTarget(parsed, token, cacheKey) {
    if (parsed.kind === "email") {
      const found = await directory.personByEmail(token, parsed.query);
      if (!found.ok) return { error: found.errorCode };
      if (found.candidate) return { candidate: found.candidate };
      return {
        clarify: clarify(
          `No one in this Slack workspace uses ${parsed.query}. Ask the user who they meant.`
        ),
      };
    }
    const lists = (
      await Promise.all([
        parsed.kind === "person" ? null : directory.channels(token, cacheKey),
        parsed.kind === "channel" ? null : directory.people(token, cacheKey),
      ])
    ).filter(Boolean);
    const failure = lists.find((list) => !list.ok);
    if (failure) return { error: failure.errorCode };
    const candidates = lists.flatMap((list) => list.items);

    // A name is only unique if every candidate was seen. When a list stopped
    // at the page cap, only an exact channel name (unique in a workspace)
    // still identifies something; a person needs an email address.
    if (lists.some((list) => list.truncated)) {
      if (parsed.kind !== "channel") return { clarify: clarify(TOO_LARGE_FOR_NAMES) };
      const exact = resolveTarget(parsed.query, candidates, { exactOnly: true });
      if (exact.status === "match") return { candidate: exact.candidate };
      return {
        clarify: clarify(
          `Couldn't find a channel named exactly #${parsed.query} that the user is in. Ask for the exact #channel name.`
        ),
      };
    }

    const resolved = resolveTarget(parsed.query, candidates);
    if (resolved.status === "match") return { candidate: resolved.candidate };
    if (resolved.status === "ambiguous") {
      return {
        clarify: clarify(
          `More than one match for "${parsed.query}". Ask the user which one they meant.`,
          resolved.candidates
        ),
      };
    }
    const where =
      parsed.kind === "channel"
        ? `a channel called #${parsed.query} that the user is in`
        : `"${parsed.query}"`;
    return { clarify: clarify(`Couldn't find ${where} in Slack. Ask the user where to send it.`) };
  }

  // Slack refusing a token it just issued means the login itself is gone.
  function refusedAgain(binding) {
    return { ok: false, outcome: "failed", errorCode: auth.markReconnect(binding).errorCode };
  }

  // A write Slack refused for its token did nothing, so it is the one write
  // that may be repeated: once, after refreshing the login the action is
  // bound to. Never whichever login is current.
  async function writeWithRefresh(method, params, binding, access) {
    const first = await api.call(method, params, { token: access.token });
    if (first.ok || !RETRY_AFTER_REFRESH.has(first.errorCode)) return { result: first, access };
    const refreshed = await auth.getAccessToken(binding, { forceRefresh: true });
    if (!refreshed.ok) {
      return { result: { ok: false, outcome: "failed", errorCode: refreshed.errorCode }, access };
    }
    const second = await api.call(method, params, { token: refreshed.token });
    if (!second.ok && RETRY_AFTER_REFRESH.has(second.errorCode)) {
      return { result: refusedAgain(binding), access: refreshed };
    }
    return { result: second, access: refreshed };
  }

  // Lookups only read, but a refused token gets the same treatment: one
  // more try after refreshing the bound login, then a reconnect.
  async function findTargetWithRefresh(parsed, binding, access, cacheKey) {
    const first = await findTarget(parsed, access.token, cacheKey);
    if (!RETRY_AFTER_REFRESH.has(first.error)) return first;
    const refreshed = await auth.getAccessToken(binding, { forceRefresh: true });
    if (!refreshed.ok) return { error: refreshed.errorCode };
    const second = await findTarget(parsed, refreshed.token, cacheKey);
    if (!RETRY_AFTER_REFRESH.has(second.error)) return second;
    return { error: refusedAgain(binding).errorCode };
  }

  return {
    id: "slack",
    actions: { send_message: { kind: "approval" } },

    async getStatus() {
      const entry = credentials.read(credentials.activeAccountId(), "slack");
      return entry
        ? auth.statusOf(entry.credential)
        : { connected: false, accountLabel: null, workspaceLabel: null, needsReconnect: false };
    },

    async getBinding() {
      const ownerAccountId = credentials.activeAccountId();
      const entry = credentials.read(ownerAccountId, "slack");
      if (!entry) return null;
      return {
        ownerAccountId,
        accountId: entry.credential.userId,
        workspaceId: entry.credential.teamId,
        generation: entry.generation,
      };
    },

    async prepare(action, args, { binding } = {}) {
      if (action !== "send_message")
        return prepareFailed("unknown_action", "Unknown Slack action.");
      const text = typeof args.text === "string" ? args.text : "";
      const problem = textProblem(text);
      if (problem) return prepareFailed(problem, failureMessage(problem));
      const destination = typeof args.destination === "string" ? args.destination.trim() : "";
      if (!destination)
        return clarify("Ask the user which Slack channel or person to send this to.");

      const access = await auth.getAccessToken(binding);
      if (!access.ok) {
        return prepareFailed(
          access.errorCode,
          failureMessage(access.errorCode, "", "Couldn't reach Slack. Try again.")
        );
      }
      const { credential } = access;
      const cacheKey = `${binding.ownerAccountId}:${credential.teamId}:${credential.userId}:${binding.generation}`;
      const found = await findTargetWithRefresh(
        parseDestination(destination),
        binding,
        access,
        cacheKey
      );
      if (found.clarify) return found.clarify;
      if (found.error) {
        return prepareFailed(
          found.error,
          failureMessage(found.error, "", "Couldn't reach Slack to look that up. Try again.")
        );
      }

      const target = {
        kind: found.candidate.kind,
        id: found.candidate.id,
        label: found.candidate.label,
      };
      return {
        status: "ready",
        payload: { target, text },
        preview: {
          verbKey: "slackPost",
          destinationLabel: target.label,
          accountLabel: credential.userName,
          workspaceLabel: credential.teamName,
          body: text,
        },
      };
    },

    async commit(action, payload, edits, { binding } = {}) {
      if (action !== "send_message") {
        return { state: "failed", errorCode: "unknown_action", message: "Unknown Slack action." };
      }
      const { target } = payload;
      const text = typeof edits.body === "string" ? edits.body : payload.text;
      // Checked before anything reaches Slack, a DM open included.
      const problem = textProblem(text);
      if (problem) return { state: "failed", errorCode: problem, message: failureMessage(problem) };

      const access = await auth.getAccessToken(binding);
      if (!access.ok) {
        return {
          state: "failed",
          errorCode: access.errorCode,
          message: failureMessage(
            access.errorCode,
            target.label,
            "Couldn't reach Slack. Nothing was sent."
          ),
        };
      }

      let channel = target.id;
      let current = access;
      if (target.kind === "user") {
        // Opening a DM creates it in Slack, so it happens only after the user
        // pressed Send (spec §5 invariant 2).
        const opened = await writeWithRefresh(
          "conversations.open",
          { users: target.id },
          binding,
          current
        );
        current = opened.access;
        const channelId = opened.result.ok ? opened.result.data?.channel?.id : null;
        // Whatever happened to the DM, the message itself was never posted.
        if (!channelId) {
          const errorCode = opened.result.ok ? "bad_response" : opened.result.errorCode;
          return {
            state: "failed",
            errorCode,
            message: failureMessage(
              errorCode,
              target.label,
              `Couldn't open a conversation with ${target.label}. Nothing was sent.`
            ),
          };
        }
        channel = channelId;
      }

      const posted = await writeWithRefresh(
        "chat.postMessage",
        messageParams(channel, text),
        binding,
        current
      );
      const { result } = posted;
      if (result.ok) {
        return {
          state: "sent",
          url: messageUrl(posted.access.credential.teamUrl, channel, result.data.ts),
        };
      }
      if (result.outcome === "failed") {
        return {
          state: "failed",
          errorCode: result.errorCode,
          message: failureMessage(result.errorCode, target.label),
        };
      }
      return {
        state: "unknown",
        errorCode: result.errorCode,
        checkUrl: `https://app.slack.com/client/${posted.access.credential.teamId}/${channel}`,
      };
    },

    authorize: (options) => auth.authorize(options),
    revoke: (credential) => auth.revoke(credential),
  };
}

module.exports = {
  createSlackConnector,
  escapeSpecials,
  formatMessage,
  SLACK_MESSAGE_LIMIT,
  SLACK_ESCAPE_SPECIALS,
};
