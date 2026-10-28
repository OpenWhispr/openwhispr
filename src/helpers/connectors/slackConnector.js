const { resolveTarget } = require("./targetResolution");
const { isValidEmailAddress } = require("./emailCompose");
const { createSlackApi } = require("./slackApi");
const { createSlackAuth } = require("./slackAuth");
const { createSlackDirectory } = require("./slackDirectory");
const { connectorResultPage } = require("./oauthResultPage");

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
// A channel (C…, or G… for an older private one), a DM (D…) or a person (U…,
// or W… on Enterprise Grid): nine or more characters with a digit. Shorter
// names typed in capitals ("GABE", "D2C") never match; a longer one such as
// "DESIGN2025" can, so findTarget tries a bare one as a name as well.
const SLACK_ID = /^[CDGUW](?=[A-Z0-9]*\d)[A-Z0-9]{8,}$/;
// A message in a link: p, then its ts without the dot.
const LINK_MESSAGE = /^p(\d{10})(\d{6})$/;
const MESSAGE_TS = /^\d{10}\.\d{6}$/;

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

function messageParams(channel, text, threadTs) {
  return {
    channel,
    markdown_text: formatMessage(text),
    ...(threadTs ? { thread_ts: threadTs } : {}),
  };
}

// chat.postMessage returns no permalink; this is Slack's permalink format. A
// reply's link names its thread, as Slack's own do, so replying to it again
// stays in that thread.
function messageUrl(teamUrl, channel, ts, threadTs) {
  if (typeof teamUrl !== "string" || typeof ts !== "string") return undefined;
  const url = `${teamUrl.replace(/\/?$/, "/")}archives/${channel}/p${ts.replace(".", "")}`;
  return threadTs ? `${url}?thread_ts=${threadTs}&cid=${channel}` : url;
}

// A link to a conversation, or to a message in it:
// https://<…>.slack.com/archives/<C…|G…|D…>[/p<ts>]. Any Slack host:
// Enterprise Grid and Slack Connect links aren't on the workspace's own
// domain, and the conversation is pinned by its id (among the user's
// channels, or against the destination) either way. A reply can't start a
// thread, and its link names the one it is in (?thread_ts=), so threadTs is
// that thread. Null for anything else, a cid naming another conversation
// included.
function parseSlackLink(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".slack.com")) return null;
  const [archives, channelId, message, ...rest] = url.pathname.split("/").filter(Boolean);
  if (archives !== "archives" || rest.length > 0) return null;
  if (!/^[CDG]/.test(channelId ?? "") || !SLACK_ID.test(channelId)) return null;
  const cid = url.searchParams.get("cid");
  if (cid !== null && cid !== channelId) return null;
  const ts = message === undefined ? null : LINK_MESSAGE.exec(message);
  if (message !== undefined && !ts) return null;
  const threadTs = url.searchParams.get("thread_ts");
  if (threadTs !== null && !MESSAGE_TS.test(threadTs)) return null;
  return { channelId, threadTs: threadTs ?? (ts ? `${ts[1]}.${ts[2]}` : null) };
}

// The card says which thread by when it started; the copy formats the time
// (ms) in the UI's language and the user's time zone.
function replyInThreadNote(threadTs) {
  return {
    key: "connectors.approval.slack.notes.replyInThread",
    values: { started: String(Math.round(Number(threadTs) * 1000)) },
  };
}

// A person's DM is known only once Send opens it, which checks the thread
// again; until then, a thread outside any DM can't be with them.
function threadFits(target, thread) {
  return target.kind === "user" ? thread.channelId.startsWith("D") : target.id === thread.channelId;
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
    case "thread_mismatch":
      return `That thread is in a different conversation from ${label}, so nothing was sent. To reply there, pass the thread's link as the destination too.`;
    case "invalid_thread":
      return "The thread must be a link to a Slack message, like https://<workspace>.slack.com/archives/C0123ABCD/p1712345678901234. Nothing was sent.";
    case "cannot_reply_to_message":
    case "restricted_action_thread_locked":
    case "restricted_action_non_threadable_channel":
      return "Slack doesn't allow replies in that thread.";
    case "restricted_action_thread_only_channel":
      return `Only replies in threads can be posted in ${label}.`;
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
  const link = parseSlackLink(value);
  if (link) return { kind: "link", query: link.channelId };
  if (SLACK_ID.test(value)) return { kind: "id", query: value };
  return { kind: "any", query: value };
}

function clarify(message, candidates = []) {
  const labels = candidates.map((candidate) => candidate.hint ?? candidate.label);
  return {
    status: "needs_clarification",
    message,
    candidates: labels,
    // What the user can pick from: each destination finds exactly that
    // channel (#name) or person (@username) when prepared again.
    ...(candidates.length > 0
      ? {
          choices: candidates.map((candidate, index) => ({
            label: labels[index],
            destination: candidate.kind === "channel" ? candidate.label : `@${candidate.handle}`,
          })),
        }
      : {}),
  };
}

function prepareFailed(errorCode, message) {
  return { status: "failed", errorCode, message };
}

// Which Slack login a lookup or an opened DM belongs to.
function loginCacheKey(binding, credential) {
  return `${binding.ownerAccountId}:${credential.teamId}:${credential.userId}:${binding.generation}`;
}

function createSlackConnector({ api, auth, directory, credentials }) {
  // Whose DM an id is takes im:read, which the app doesn't ask for, and the
  // card must name who gets the message. So a DM id is known by the person a
  // Send opened it with, per login, for as long as the app runs.
  const openedDms = new Map();

  // An id names exactly one channel, person or DM. A person's is looked up
  // directly; a channel's must be among the user's channels, which a list
  // cut off at the page cap may not show.
  async function findById(id, token, cacheKey) {
    if (id.startsWith("D")) {
      const person = openedDms.get(`${cacheKey}:${id}`);
      if (person) return { candidate: { id, kind: "dm", label: person.label } };
      return {
        clarify: clarify(
          `Slack doesn't say whose direct message ${id} is. Ask the user who to send it to, by name or email.`
        ),
      };
    }
    if (id.startsWith("U") || id.startsWith("W")) {
      const found = await directory.personById(token, id);
      if (!found.ok) return { error: found.errorCode };
      if (found.candidate) return { candidate: found.candidate };
      return {
        clarify: clarify(
          `No one in this Slack workspace has the id ${id}. Ask the user who they meant.`
        ),
      };
    }
    const channels = await directory.channels(token, cacheKey);
    if (!channels.ok) return { error: channels.errorCode };
    const channel = channels.items.find((candidate) => candidate.id === id);
    if (channel) return { candidate: channel };
    return {
      clarify: clarify(
        channels.truncated
          ? `The user is in more Slack channels than can be listed, and none of those read has the id ${id}. Ask the user where to send it.`
          : `Couldn't find a channel with the id ${id} that the user is in. Ask the user where to send it.`
      ),
    };
  }

  // unmatched: no name was found, or could be in a list cut off at the page cap.
  async function findByName(parsed, token, cacheKey) {
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

    // A username is unique in a workspace, so "@handle" (what the picker
    // sends) finds exactly that person, even when it is also someone else's
    // display name.
    if (parsed.kind === "person") {
      const handle = parsed.query.toLowerCase();
      const exact = candidates.find((candidate) => candidate.handle?.toLowerCase() === handle);
      if (exact) return { candidate: exact };
    }

    // A name is only unique if every candidate was seen. When a list stopped
    // at the page cap, only what is unique in a workspace still identifies
    // something: an exact @username (above), an exact channel name, or an
    // email address.
    if (lists.some((list) => list.truncated)) {
      if (parsed.kind !== "channel") {
        return { clarify: clarify(TOO_LARGE_FOR_NAMES), unmatched: true };
      }
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
    return {
      clarify: clarify(`Couldn't find ${where} in Slack. Ask the user where to send it.`),
      unmatched: true,
    };
  }

  // A link names its conversation by id. A bare id-shaped value can also be a
  // name ("DESIGN2025" is a channel): a DM id has no lookup of its own, so it
  // is a DM only when no name matches; any other is looked up as an id first,
  // and tried as a name when nothing has that id.
  async function findTarget(parsed, token, cacheKey) {
    if (parsed.kind === "link") return findById(parsed.query, token, cacheKey);
    if (parsed.kind !== "id") return findByName(parsed, token, cacheKey);
    const asName = { kind: "any", query: parsed.query };
    if (parsed.query.startsWith("D")) {
      const named = await findByName(asName, token, cacheKey);
      return named.unmatched ? findById(parsed.query, token, cacheKey) : named;
    }
    const byId = await findById(parsed.query, token, cacheKey);
    if (!byId.clarify) return byId;
    // A name that matches nothing either: the id's own question says more
    // (a cut-off list of channels, not "too large to look people up by name").
    const named = await findByName(asName, token, cacheKey);
    return named.unmatched ? byId : named;
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
    // The card edits only the message text; the destination stays as prepared.
    actions: { send_message: { kind: "approval", editable: { body: "text" } } },

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
      const threadLink = typeof args.thread === "string" ? args.thread.trim() : "";
      const thread = threadLink ? parseSlackLink(threadLink) : null;
      if (threadLink && !thread?.threadTs) {
        return prepareFailed("invalid_thread", failureMessage("invalid_thread"));
      }

      const access = await auth.getAccessToken(binding);
      if (!access.ok) {
        return prepareFailed(
          access.errorCode,
          failureMessage(access.errorCode, "", "Couldn't reach Slack. Try again.")
        );
      }
      const { credential } = access;
      const parsed = parseDestination(destination);
      const cacheKey = loginCacheKey(binding, credential);
      const found = await findTargetWithRefresh(parsed, binding, access, cacheKey);
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
      // A person's DM is known only once Send opens it, unless an earlier Send
      // here opened the thread's DM with someone else: then nothing is opened.
      const threadDm = thread && openedDms.get(`${cacheKey}:${thread.channelId}`);
      const otherPersonsDm = target.kind === "user" && threadDm && threadDm.userId !== target.id;
      if (thread && (!threadFits(target, thread) || otherPersonsDm)) {
        return prepareFailed("thread_mismatch", failureMessage("thread_mismatch", target.label));
      }
      return {
        status: "ready",
        payload: {
          target,
          text,
          ...(thread ? { thread: { channelId: thread.channelId, ts: thread.threadTs } } : {}),
        },
        preview: {
          verbKey: "slackPost",
          destinationLabel: target.label,
          accountLabel: credential.userName,
          workspaceLabel: credential.teamName,
          body: text,
          ...(thread ? { notes: [replyInThreadNote(thread.threadTs)] } : {}),
        },
      };
    },

    async commit(action, payload, edits, { binding } = {}) {
      if (action !== "send_message") {
        return { state: "failed", errorCode: "unknown_action", message: "Unknown Slack action." };
      }
      const { target, thread } = payload;
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
        openedDms.set(`${loginCacheKey(binding, access.credential)}:${channelId}`, {
          userId: target.id,
          label: target.label,
        });
      }
      if (thread && channel !== thread.channelId) {
        return {
          state: "failed",
          errorCode: "thread_mismatch",
          message: failureMessage("thread_mismatch", target.label),
        };
      }

      const posted = await writeWithRefresh(
        "chat.postMessage",
        messageParams(channel, text, thread?.ts),
        binding,
        current
      );
      const { result } = posted;
      if (result.ok) {
        // The thread Slack says the message went into, if any: one it didn't
        // thread is linked as the new message it is, and the card says so,
        // since it promised a reply in the thread.
        const threadTs = thread ? result.data.message?.thread_ts : undefined;
        const threaded = MESSAGE_TS.test(threadTs ?? "");
        return {
          state: "sent",
          url: messageUrl(
            posted.access.credential.teamUrl,
            channel,
            result.data.ts,
            threaded ? threadTs : undefined
          ),
          ...(thread && !threaded ? { outsideThread: true } : {}),
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
    // Which Slack user, in which workspace, a login belongs to.
    loginKey: (credential) => `${credential?.teamId}:${credential?.userId}`,
  };
}

// Built by createConnectors.js. One auth instance for every consumer: its
// single-flight refresh map is per instance, so a second one could spend the
// same single-use refresh token.
function buildSlackConnector(deps) {
  const api = createSlackApi({ fetchImpl: deps.fetch });
  const auth = createSlackAuth({
    api,
    credentials: deps.credentials,
    getClientId: () => deps.env.SLACK_CLIENT_ID,
    runOAuthLoopbackFlow: deps.runOAuthLoopbackFlow,
    OAuthFlowError: deps.OAuthFlowError,
    renderResultPage: connectorResultPage(deps, "slack"),
    logger: deps.logger,
  });
  return createSlackConnector({
    api,
    auth,
    directory: createSlackDirectory({ api }),
    credentials: deps.credentials,
  });
}

module.exports = {
  createSlackConnector,
  buildSlackConnector,
  escapeSpecials,
  formatMessage,
  SLACK_MESSAGE_LIMIT,
  SLACK_ESCAPE_SPECIALS,
};
