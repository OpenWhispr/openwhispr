// Linear connector (Linear spec §5): search issues (a query), create an
// issue and comment on one (approval actions). The model only prepares a
// write; the card's Send commits exactly what the card shows, rebuilt and
// re-checked here.
const crypto = require("crypto");
const { isTransportErrorCode } = require("./deliveryClassifier");
const { connectorResultPage } = require("./oauthResultPage");
const { createLinearApi } = require("./linearApi");
const { createLinearAuth, linearRedirectUri } = require("./linearAuth");
const { createLinearTeams } = require("./linearTeams");

const MAX_TITLE_LENGTH = 256;
// Checked live: Linear accepted a 70,000-character description, higher
// than the card's own 65,536-character limit, so the card's limit governs.
const MAX_DESCRIPTION_LENGTH = 65536;
const MAX_QUERY_LENGTH = 200;
const MAX_RESULTS = 10;
const SNIPPET_LENGTH = 300;

// Linear's own priority numbers; the card words each
// name from connectors.linear.notes.priority.<name>.
const PRIORITIES = { urgent: 1, high: 2, medium: 3, low: 4, none: 0 };

const LINE_BREAK = /[\r\n]/;
// What linearApi reports when Linear refused the token (401 or
// AUTHENTICATION_ERROR): nothing happened, so the call may be repeated once
// after refreshing the bound login.
const TOKEN_REFUSED = "unauthorized";
// Codes a failed call keeps as they are (linearApi's, linearAuth's and
// linearTeams'); anything else from Linear is "refused" and anything from
// the network is "network".
const OWN_CODES = new Set([
  "reconnect_needed",
  "connection_changed",
  "credential_save_failed",
  "linear_unavailable",
  "network",
  "rate_limited",
  "not_found",
  "forbidden",
  "invalid_input",
]);
// Every errorCode this connector's query, prepare and commit can return.
// Each has its own card and tool-step copy under
// connectors.{approval,toolStatus}.errors.linear (linearErrorCopy.test.js pins it).
const LINEAR_ERROR_CODES = Object.freeze([
  ...OWN_CODES,
  "too_long",
  "missing_title",
  "missing_body",
  "not_created",
  "wrong_workspace",
  "invalid_reference",
  "refused",
  "unknown_action",
]);

const SEARCH_QUERY = `query LinearSearchIssues($term: String!, $filter: IssueFilter, $first: Int!) {
  searchIssues(term: $term, filter: $filter, first: $first) {
    nodes {
      identifier
      title
      url
      updatedAt
      description
      state { name }
      assignee { name }
      team { key }
      labels { nodes { name } }
    }
    pageInfo { hasNextPage }
  }
}`;
// Both an issue key ("ENG-123") and the client id a create sent.
const ISSUE_QUERY = `query LinearIssue($id: String!) {
  issue(id: $id) { id identifier title url }
}`;
const CREATE_MUTATION = `mutation LinearIssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id identifier url } }
}`;
const COMMENT_MUTATION = `mutation LinearCommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id url } }
}`;
// The client id a comment was sent with.
const COMMENT_QUERY = `query LinearComment($id: String!) {
  comment(id: $id) { id url }
}`;

const IDENTIFIER = /^([A-Za-z][A-Za-z0-9]{0,9})-([1-9]\d{0,8})$/;

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

// "ENG-123", "eng-123", or a link to it in this workspace:
// https://linear.app/<urlKey>/issue/ENG-123/<slug>?query#fragment.
function parseIssueReference(input, organizationUrlKey) {
  const raw = typeof input === "string" ? input.trim() : "";
  const key = IDENTIFIER.exec(raw);
  if (key) return { ok: true, identifier: `${key[1].toUpperCase()}-${key[2]}` };
  let url;
  try {
    url = new URL(raw.startsWith("linear.app/") ? `https://${raw}` : raw);
  } catch {
    return { ok: false, errorCode: "invalid_reference" };
  }
  if (url.protocol !== "https:" || url.hostname !== "linear.app" || url.port) {
    return { ok: false, errorCode: "invalid_reference" };
  }
  const [workspace, kind, identifier] = url.pathname.split("/").filter(Boolean);
  const inPath = kind === "issue" ? IDENTIFIER.exec(identifier ?? "") : null;
  if (!workspace || !inPath) return { ok: false, errorCode: "invalid_reference" };
  if (
    !nonEmptyString(organizationUrlKey) ||
    workspace.toLowerCase() !== organizationUrlKey.toLowerCase()
  ) {
    return { ok: false, errorCode: "wrong_workspace" };
  }
  return { ok: true, identifier: `${inPath[1].toUpperCase()}-${inPath[2]}` };
}

// Whitespace runs become one space, and a cut never splits a character:
// at most `max` characters, the last an ellipsis when something was cut.
function clip(text, max) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const characters = [...flat];
  if (characters.length <= max) return flat;
  return `${characters
    .slice(0, max - 1)
    .join("")
    .trimEnd()}…`;
}

// Characters (code points), as the card counts them (issueApprovalFields.ts),
// so a card the user could send is never refused here for its length.
function characterCount(text) {
  return [...text].length;
}

function titleProblem(title) {
  if (typeof title !== "string" || !title.trim()) return "missing_title";
  if (LINE_BREAK.test(title)) return "invalid_input";
  if (characterCount(title) > MAX_TITLE_LENGTH) return "too_long";
  return null;
}

function bodyProblem(body, { required }) {
  if (typeof body !== "string") return required ? "missing_body" : null;
  if (required && !body.trim()) return "missing_body";
  if (characterCount(body) > MAX_DESCRIPTION_LENGTH) return "too_long";
  return null;
}

// A Linear issue link without its title slug, which receipts must not keep:
// https://linear.app/<urlKey>/issue/ENG-123[#comment-…]. Null for anything
// that isn't a Linear issue link.
function issueLink(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "linear.app" || url.port) return null;
  const [workspace, kind, identifier] = url.pathname.split("/").filter(Boolean);
  if (!workspace || kind !== "issue" || !IDENTIFIER.test(identifier ?? "")) return null;
  return `https://linear.app/${workspace}/issue/${identifier}${url.hash}`;
}

// The network or an outage, rather than an answer from Linear.
function isNetworkCode(errorCode) {
  return isTransportErrorCode(errorCode) || /^http_5\d\d$/.test(errorCode ?? "");
}

// The connector's own code for a failed call: Linear's refusals and the
// network's, so the card and the tool step can word them.
function failureCode(errorCode) {
  if (OWN_CODES.has(errorCode)) return errorCode;
  return isNetworkCode(errorCode) ? "network" : "refused";
}

// English for the model; the card and the tool step show translated copy by
// errorCode.
function failureMessage(errorCode) {
  switch (errorCode) {
    case "reconnect_needed":
      return "Linear needs to be reconnected under Settings → Integrations → Connectors.";
    case "connection_changed":
      return "The Linear connection changed before sending, so nothing was sent.";
    case "credential_save_failed":
      return "Couldn't save the refreshed Linear login. Nothing was sent.";
    case "linear_unavailable":
      return "Linear isn't available in this build of OpenWhispr right now.";
    case "network":
      return "Couldn't reach Linear. Nothing was sent.";
    case "rate_limited":
      return "Linear is busy. Try again shortly.";
    case "not_found":
      return "Linear couldn't find the team, project or issue anymore. Nothing was sent.";
    case "forbidden":
      return "The user's Linear account isn't allowed to do that. Nothing was sent.";
    case "invalid_input":
      return "Linear couldn't accept this as written. Nothing was sent.";
    case "too_long":
      return `Too long for Linear: a title can have ${MAX_TITLE_LENGTH} characters and a description or comment ${MAX_DESCRIPTION_LENGTH}.`;
    case "missing_title":
      return "The issue needs a title.";
    case "missing_body":
      return "The comment is empty.";
    case "not_created":
      return "Linear didn't create the issue.";
    case "wrong_workspace":
      return "That issue is in another Linear workspace than the one connected.";
    case "invalid_reference":
      return "That isn't a Linear issue key (like ENG-123) or a Linear issue link.";
    default:
      return "Linear refused the request. Nothing was sent.";
  }
}

function clarify(message, candidates = []) {
  return { status: "needs_clarification", message, candidates };
}

function prepareFailed(errorCode, message = failureMessage(errorCode)) {
  return { status: "failed", errorCode, message };
}

function commitFailed(errorCode, message = failureMessage(errorCode)) {
  return { state: "failed", errorCode, message };
}

// Own keys only: PRIORITIES is a plain object, so "toString", "constructor"
// or "__proto__" would otherwise resolve to an inherited function or the
// prototype itself instead of failing as an unknown priority.
function priorityFor(value) {
  return typeof value === "string" && Object.hasOwn(PRIORITIES, value)
    ? { name: value, value: PRIORITIES[value] }
    : undefined;
}

// Models often send null for an optional argument they leave out.
function isAbsent(value) {
  return value === undefined || value === null;
}

function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}

function searchItem(node) {
  return {
    reference: node.identifier,
    title: clip(node.title, MAX_TITLE_LENGTH),
    state: stringOrNull(node.state?.name),
    url: node.url,
    updatedAt: stringOrNull(node.updatedAt),
    assignee: stringOrNull(node.assignee?.name),
    team: stringOrNull(node.team?.key),
    labels: (Array.isArray(node.labels?.nodes) ? node.labels.nodes : [])
      .map((label) => label?.name)
      .filter(nonEmptyString),
    snippet: clip(node.description, SNIPPET_LENGTH),
  };
}

function newestFirst(a, b) {
  return (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0);
}

// The team's issue list: where the user checks for a create that may or may
// not have happened.
function teamIssuesUrl(urlKey, teamKey) {
  return `https://linear.app/${encodeURIComponent(urlKey)}/team/${encodeURIComponent(teamKey)}/all`;
}

function createLinearConnector({
  api,
  auth,
  teams,
  credentials,
  randomId = () => crypto.randomUUID(),
}) {
  // Linear refusing a token it just issued means the login itself is gone.
  function refusedAgain(binding) {
    return { ok: false, outcome: "failed", errorCode: auth.markReconnect(binding).errorCode };
  }

  // A call Linear refused for its token did nothing, so it is the one call
  // that may be repeated: once, after refreshing the login the action is
  // bound to. Never whichever login is current.
  async function withRefresh(binding, access, run) {
    const first = await run(access.token);
    if (first.ok || first.errorCode !== TOKEN_REFUSED) return { result: first, access };
    const refreshed = await auth.getAccessToken(binding, { forceRefresh: true });
    if (!refreshed.ok) {
      return { result: { ok: false, outcome: "failed", errorCode: refreshed.errorCode }, access };
    }
    const second = await run(refreshed.token);
    if (!second.ok && second.errorCode === TOKEN_REFUSED) {
      return { result: refusedAgain(binding), access: refreshed };
    }
    return { result: second, access: refreshed };
  }

  // A read that failed or can't be trusted: prepare and query only ever read,
  // so there is nothing to settle, only a reason to give.
  function readFailed(result) {
    return prepareFailed(failureCode(result.errorCode));
  }

  async function searchIssues(args, binding) {
    const term = typeof args?.query === "string" ? args.query.trim() : "";
    if (!term) return clarify("Ask the user what to search Linear for.");
    if (characterCount(term) > MAX_QUERY_LENGTH) {
      return prepareFailed("too_long", `Search with ${MAX_QUERY_LENGTH} characters or fewer.`);
    }
    const state = args?.state ?? "open";
    if (state !== "open" && state !== "all") {
      return prepareFailed("invalid_input", 'state is "open" or "all".');
    }
    if (!isAbsent(args?.assignedToMe) && typeof args.assignedToMe !== "boolean") {
      return prepareFailed("invalid_input", "assignedToMe is true or false.");
    }

    let access = await auth.getAccessToken(binding);
    if (!access.ok) return prepareFailed(failureCode(access.errorCode));

    const filter = {};
    const teamInput = typeof args?.team === "string" ? args.team.trim() : "";
    if (teamInput) {
      const resolved = await withRefresh(binding, access, (token) =>
        teams.resolveTeam(binding, token, teamInput)
      );
      access = resolved.access;
      if (resolved.result.clarification) {
        const { message, candidates } = resolved.result.clarification;
        return clarify(message, candidates);
      }
      if (!resolved.result.ok) return readFailed(resolved.result);
      filter.team = { id: { eq: resolved.result.team.id } };
    }
    if (args?.assignedToMe === true) filter.assignee = { isMe: { eq: true } };
    // Open means not done and not cancelled, whatever the team calls them.
    if (state === "open") filter.state = { type: { nin: ["completed", "canceled"] } };

    const variables = {
      term,
      first: MAX_RESULTS + 1,
      ...(Object.keys(filter).length > 0 ? { filter } : {}),
    };
    const { result } = await withRefresh(binding, access, (token) =>
      api.graphql(SEARCH_QUERY, variables, { token })
    );
    if (!result.ok) return readFailed(result);
    const found = result.data?.searchIssues;
    const nodes = (Array.isArray(found?.nodes) ? found.nodes : []).filter(
      (node) => nonEmptyString(node?.identifier) && nonEmptyString(node?.url)
    );
    // Linear ranks by relevance, so the extra match cut is its least relevant
    // one; the ten kept are then shown newest first.
    return {
      status: "ok",
      items: nodes.slice(0, MAX_RESULTS).map(searchItem).sort(newestFirst),
      truncated: nodes.length > MAX_RESULTS || found?.pageInfo?.hasNextPage === true,
    };
  }

  async function prepareCreate(args, binding) {
    // A title is one line: line breaks become spaces, as the card's field
    // can't hold them.
    const title = typeof args?.title === "string" ? args.title.replace(/[\r\n]+/g, " ").trim() : "";
    const description = typeof args?.description === "string" ? args.description : "";
    const problem = titleProblem(title) ?? bodyProblem(description, { required: false });
    if (problem) return prepareFailed(problem);
    const priority = isAbsent(args?.priority) ? null : priorityFor(args.priority);
    if (priority === undefined) {
      return prepareFailed("invalid_input", "priority is urgent, high, medium, low or none.");
    }

    let access = await auth.getAccessToken(binding);
    if (!access.ok) return prepareFailed(failureCode(access.errorCode));

    const teamInput = typeof args?.team === "string" ? args.team.trim() : "";
    const resolved = await withRefresh(binding, access, (token) =>
      teams.resolveTeam(binding, token, teamInput || undefined)
    );
    access = resolved.access;
    if (resolved.result.clarification) {
      const { message, candidates } = resolved.result.clarification;
      return clarify(message, candidates);
    }
    if (!resolved.result.ok) return readFailed(resolved.result);
    const { team } = resolved.result;

    const notes = [];
    if (priority) notes.push({ key: `connectors.linear.notes.priority.${priority.name}` });
    const { credential } = access;
    // The card is the truth: an assigneeId is never sent without a note
    // saying so, even when Linear never told us the viewer's name.
    if (args?.assignToMe === true) {
      notes.push(
        nonEmptyString(credential.userName)
          ? {
              key: "connectors.approval.issue.notes.assignee",
              values: { assignee: credential.userName },
            }
          : { key: "connectors.linear.notes.assignedToYou" }
      );
    }

    let projectId = null;
    const projectInput = typeof args?.project === "string" ? args.project.trim() : "";
    if (projectInput) {
      const found = await withRefresh(binding, access, (token) =>
        teams.resolveProject(binding, token, team.id, projectInput)
      );
      access = found.access;
      if (found.result.clarification) {
        const { message, candidates } = found.result.clarification;
        return clarify(message, candidates);
      }
      if (!found.result.ok) return readFailed(found.result);
      projectId = found.result.project.id;
      notes.push({
        key: "connectors.approval.issue.notes.project",
        values: { project: found.result.project.name },
      });
    }

    return {
      status: "ready",
      payload: {
        id: randomId(),
        teamId: team.id,
        teamKey: team.key,
        title,
        description,
        ...(priority ? { priority: priority.value } : {}),
        ...(args?.assignToMe === true ? { assigneeId: credential.userId } : {}),
        ...(projectId ? { projectId } : {}),
      },
      preview: {
        verbKey: "issue",
        destinationLabel: team.key,
        accountLabel: credential.userName ?? "",
        workspaceLabel: credential.organizationName ?? "",
        body: description,
        fields: { title, body: description },
        notes,
      },
    };
  }

  async function prepareComment(args, binding) {
    const body = typeof args?.body === "string" ? args.body : "";
    const problem = bodyProblem(body, { required: true });
    if (problem) return prepareFailed(problem);
    // Checked on the stored login before any network call.
    const bound = auth.boundCredential(binding);
    if (!bound) return prepareFailed("connection_changed");
    const reference = parseIssueReference(args?.issue, bound.organizationUrlKey);
    if (!reference.ok) return prepareFailed(reference.errorCode);

    const access = await auth.getAccessToken(binding);
    if (!access.ok) return prepareFailed(failureCode(access.errorCode));
    const { result, access: current } = await withRefresh(binding, access, (token) =>
      api.graphql(ISSUE_QUERY, { id: reference.identifier }, { token })
    );
    const issue = result.ok ? result.data?.issue : null;
    if ((result.ok && !issue) || (!result.ok && result.errorCode === "not_found")) {
      return clarify(
        `Couldn't find ${reference.identifier} in Linear. Ask the user which issue they meant.`
      );
    }
    if (!result.ok) return readFailed(result);
    const issueUrl = issueLink(issue.url);
    if (!nonEmptyString(issue.id) || !issueUrl) return prepareFailed("refused");
    const identifier = nonEmptyString(issue.identifier) ? issue.identifier : reference.identifier;
    return {
      status: "ready",
      payload: { id: randomId(), issueId: issue.id, identifier, issueUrl, body },
      preview: {
        verbKey: "comment",
        destinationLabel: identifier,
        accountLabel: current.credential.userName ?? "",
        workspaceLabel: current.credential.organizationName ?? "",
        body,
        fields: { body },
        notes: [
          {
            key: "connectors.approval.comment.notes.targetTitle",
            values: { title: clip(issue.title, MAX_TITLE_LENGTH) },
          },
        ],
      },
    };
  }

  // Checked live: Linear keeps the client id a create was sent with and
  // refuses a second create with the same one, so a single lookup settles
  // it. A miss proves nothing unless the create's own uncertain answer was a
  // completed HTTP 200 (an unlisted GraphQL error, or a 200 whose issueCreate
  // didn't carry a usable issue). After a timeout, a connection reset or a
  // 5xx, Linear may still commit the insert later, so a miss stays unknown.
  async function settleUncertainCreate(binding, access, payload, uncertain) {
    const checkUrl = teamIssuesUrl(access.credential.organizationUrlKey, payload.teamKey);
    const stillUnknown = { state: "unknown", errorCode: uncertain.errorCode, checkUrl };
    const { result } = await withRefresh(binding, access, (token) =>
      api.graphql(ISSUE_QUERY, { id: payload.id }, { token })
    );
    const issue = result.ok ? result.data?.issue : null;
    const url = issueLink(issue?.url);
    if (url && nonEmptyString(issue.identifier)) {
      return { state: "sent", url, resultLabel: issue.identifier };
    }
    const missing = (result.ok && result.data?.issue === null) || result.errorCode === "not_found";
    if (missing && !isNetworkCode(uncertain.errorCode)) {
      return commitFailed("not_created");
    }
    return stillUnknown;
  }

  // An uncertain comment is never repeated. Found by its client id it was
  // sent; a miss stays unknown, since Linear's handling of a comment's id was
  // never checked against a live workspace the way an issue's was, and the
  // user checks the issue.
  async function settleUncertainComment(binding, access, payload, uncertain) {
    const stillUnknown = {
      state: "unknown",
      errorCode: uncertain.errorCode,
      checkUrl: payload.issueUrl,
    };
    if (!nonEmptyString(payload.id)) return stillUnknown;
    const { result } = await withRefresh(binding, access, (token) =>
      api.graphql(COMMENT_QUERY, { id: payload.id }, { token })
    );
    const url = result.ok ? issueLink(result.data?.comment?.url) : null;
    return url ? { state: "sent", url } : stillUnknown;
  }

  async function commitCreate(payload, edits, binding) {
    // The card's title and description over what prepare stored. Nothing
    // else from the model or the edits reaches Linear.
    const title = typeof edits?.title === "string" ? edits.title : payload.title;
    const description = typeof edits?.body === "string" ? edits.body : payload.description;
    const problem = titleProblem(title) ?? bodyProblem(description, { required: false });
    if (problem) return commitFailed(problem);

    const access = await auth.getAccessToken(binding);
    if (!access.ok) return commitFailed(failureCode(access.errorCode));
    const input = {
      id: payload.id,
      teamId: payload.teamId,
      title: title.trim(),
      ...(description ? { description } : {}),
      ...(Number.isInteger(payload.priority) ? { priority: payload.priority } : {}),
      ...(nonEmptyString(payload.assigneeId) ? { assigneeId: payload.assigneeId } : {}),
      ...(nonEmptyString(payload.projectId) ? { projectId: payload.projectId } : {}),
    };
    const sent = await withRefresh(binding, access, (token) =>
      api.graphql(CREATE_MUTATION, { input }, { token })
    );
    const { result } = sent;
    if (!result.ok && result.outcome === "failed") {
      return commitFailed(failureCode(result.errorCode));
    }
    const issue = result.ok ? result.data?.issueCreate?.issue : null;
    const url = issueLink(issue?.url);
    if (
      result.ok &&
      result.data?.issueCreate?.success === true &&
      url &&
      nonEmptyString(issue.identifier)
    ) {
      return { state: "sent", url, resultLabel: issue.identifier };
    }
    return settleUncertainCreate(
      binding,
      sent.access,
      payload,
      result.ok ? { errorCode: "bad_response" } : result
    );
  }

  async function commitComment(payload, edits, binding) {
    const body = typeof edits?.body === "string" ? edits.body : payload.body;
    const problem = bodyProblem(body, { required: true });
    if (problem) return commitFailed(problem);
    // No re-parse of Linear's own issue.url against the bound login's
    // organizationUrlKey here: the payload was built in main from Linear's
    // answer under this same token, which only ever reaches one workspace,
    // so a workspace rename between prepare and Send must not refuse a
    // comment that was always going to the right place. The user's typed
    // reference is still checked for that in prepareComment.
    if (!nonEmptyString(payload?.issueId) || !nonEmptyString(payload?.identifier)) {
      return commitFailed("refused");
    }

    const access = await auth.getAccessToken(binding);
    if (!access.ok) return commitFailed(failureCode(access.errorCode));
    const input = {
      ...(nonEmptyString(payload.id) ? { id: payload.id } : {}),
      issueId: payload.issueId,
      body,
    };
    const sent = await withRefresh(binding, access, (token) =>
      api.graphql(COMMENT_MUTATION, { input }, { token })
    );
    const { result } = sent;
    if (!result.ok && result.outcome === "failed") {
      return commitFailed(failureCode(result.errorCode));
    }
    const url = result.ok ? issueLink(result.data?.commentCreate?.comment?.url) : null;
    if (result.ok && result.data?.commentCreate?.success === true && url) {
      return { state: "sent", url };
    }
    return settleUncertainComment(
      binding,
      sent.access,
      payload,
      result.ok ? { errorCode: "bad_response" } : result
    );
  }

  return {
    id: "linear",
    actions: {
      search_issues: { kind: "query" },
      create_issue: { kind: "approval", editable: { title: "line", body: "text" } },
      comment: { kind: "approval", editable: { body: "text" } },
    },

    async getStatus() {
      const entry = credentials.read(credentials.activeAccountId(), "linear");
      // A login left by a build that had a client id still shows, so
      // Disconnect stays available.
      if (entry) return { ...auth.statusOf(entry.credential), configured: true };
      return {
        connected: false,
        configured: auth.isConfigured(),
        accountLabel: null,
        workspaceLabel: null,
        needsReconnect: false,
      };
    },

    async getBinding() {
      const ownerAccountId = credentials.activeAccountId();
      const entry = credentials.read(ownerAccountId, "linear");
      if (!entry) return null;
      return {
        ownerAccountId,
        accountId: entry.credential.userId,
        workspaceId: entry.credential.organizationId,
        generation: entry.generation,
      };
    },

    async query(action, args, { binding } = {}) {
      if (action !== "search_issues") {
        return prepareFailed("unknown_action", "Unknown Linear action.");
      }
      return searchIssues(args, binding);
    },

    async prepare(action, args, { binding } = {}) {
      if (action === "create_issue") return prepareCreate(args, binding);
      if (action === "comment") return prepareComment(args, binding);
      return prepareFailed("unknown_action", "Unknown Linear action.");
    },

    async commit(action, payload, edits, { binding } = {}) {
      if (action === "create_issue") return commitCreate(payload, edits, binding);
      if (action === "comment") return commitComment(payload, edits, binding);
      return commitFailed("unknown_action", "Unknown Linear action.");
    },

    authorize: (options) => auth.authorize(options),

    // One Linear user in one workspace: connecting another one over it
    // revokes the replaced login.
    loginKey: (credential) => `${credential?.organizationId}:${credential?.userId}`,

    // Disconnect, account deletion and Reset app data. The manager passes
    // only the credential, before it deletes the login, so every cached team
    // and project list goes: a new login lists its own.
    async revoke(credential, options) {
      try {
        await auth.revoke(credential, options);
      } finally {
        teams.clear();
      }
    },
  };
}

// One shared api, auth and teams instance for every consumer (foundation
// §9.3): concurrent actions share the auth's single-flight refresh.
function buildLinearConnector(deps) {
  const api = createLinearApi({ fetchImpl: deps.fetch });
  const auth = createLinearAuth({
    api,
    credentials: deps.credentials,
    // Read at each use, so a build's client id is never cached or logged.
    getClientId: () => deps.env?.LINEAR_CLIENT_ID,
    runOAuthLoopbackFlow: deps.runOAuthLoopbackFlow,
    OAuthFlowError: deps.OAuthFlowError,
    // Linear matches a registered redirect URI exactly, port included, so
    // the loopback server's random port can't be registered: sign-in goes
    // through the openwhispr.com relay instead.
    redirectUri: linearRedirectUri(deps.env),
    renderResultPage: connectorResultPage(deps, "linear"),
    logger: deps.logger,
  });
  const teams = createLinearTeams({ api });
  return createLinearConnector({ api, auth, teams, credentials: deps.credentials });
}

module.exports = {
  createLinearConnector,
  buildLinearConnector,
  parseIssueReference,
  LINEAR_ERROR_CODES,
  MAX_TITLE_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_RESULTS,
  SNIPPET_LENGTH,
};
