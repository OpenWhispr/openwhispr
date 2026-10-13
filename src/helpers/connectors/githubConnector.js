// GitHub connector (spec §5): search issues and pull requests (a query),
// create an issue and comment (approval cards), only in the repositories the
// OpenWhispr GitHub App is installed on. The model only prepares; the card's
// Send commits exactly what the card shows, re-checked here first.
const { createGithubApi } = require("./githubApi");
const { createGithubAuth } = require("./githubAuth");
const { createGithubInstallations, REFETCH_AFTER_MS } = require("./githubInstallations");
const { isTransportErrorCode } = require("./deliveryClassifier");
const { formBody } = require("./providerHttp");
const {
  MAX_TITLE_LENGTH,
  MAX_BODY_LENGTH,
  MAX_QUERY_LENGTH,
  MAX_RESULTS,
  SNIPPET_LENGTH,
  LINE_BREAK,
  nonEmptyString,
  characterCount,
  clarify,
} = require("./connectorText");

const MAX_LABELS = 10;
// GitHub's 256-character search limit counts only the words, never the
// qualifiers, and MAX_QUERY_LENGTH already keeps the words under it. What
// bounds the `repo:` list is the request URL: GitHub answered 250 qualifiers
// (a 5 KB URL) and failed with a 5xx near 8 KB. The budget is `q` as the
// request's query string encodes it (formBody, as githubApi's rest builds
// it), so with the rest of the URL it stays under the 5 KB that worked.
const MAX_SEARCH_QUERY_LENGTH = 4900;
// A read of the installed repository count for the status gives up after
// this long, so a hung read never blocks the next one.
const STATUS_REPOSITORIES_TIMEOUT_MS = 5000;

const STATES = new Set(["open", "all"]);
const TYPES = new Set(["issue", "pr", "any"]);
// A GitHub App user token can't search issues and pull requests together:
// GitHub refuses a `q` without one of these with a 422, so `any` is two
// searches.
const TYPE_QUALIFIERS = { issue: "is:issue", pr: "is:pull-request" };
// The scope is always the installed repos and the type is always the tool's
// own (the user's is:pr beside an added is:issue would match nothing), so
// the user's own scope and type qualifiers (negated, quoted, after NOT or
// opening a group too) are removed; every other qualifier (label:, author:,
// is:closed, …) passes through. A quoted phrase is words to GitHub, so
// nothing in one is removed.
const OWN_QUALIFIER =
  /(^|[\s(])(?:NOT\s+)*-?(?:(?:repo|org|user):(?:"[^"]*"?|[^\s)]*)|(?:is|type):(?:issue|pr|pull-request)(?=$|[\s)]))|"[^"]*"/gi;
// What a removed qualifier can leave behind, each removed until none is
// left: an empty group (with a NOT or - in front of it), AND or OR opening
// the query or a group, an operator closing one, and an operator before AND
// or OR. GitHub would refuse the query, and a NOT would negate whatever came
// next. GitHub's operators are upper case; "or" is a word.
const LEFTOVERS = [
  /(\s?)(?:\bNOT\s*|-)?\(\s*\)/g,
  /(^|\()\s*(?:AND|OR)(?=\s|\)|$)/g,
  /(^|[\s(])(?:AND|OR|NOT)(?=\s*(?:\)|$))/g,
  /(^|[\s(])(?:AND|OR|NOT)\s+(?=(?:AND|OR)(?:\s|\)|$))/g,
];
// A state the query names itself: state:open beside is:closed would match
// nothing.
const STATE_QUALIFIER =
  /(^|[\s(])-?(?:is:(?:open|closed|merged|unmerged)|state:(?:open|closed))(?=$|[\s)])/i;
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const NUMBER_PATTERN = /^[1-9]\d{0,9}$/;
const SHORT_REFERENCE = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/;
// `repo#12` or `#12`: a comment target whose repo is found among the
// installed ones.
const INSTALLED_REFERENCE = /^([^/\s#]*)#(\d+)$/;
const SEARCH_REPO_URL = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/i;
// spec §6.1: no email address reaches the model, internationalized ones
// (josé@example.com, bob@exämple.com, a full-width ＠) included. A GitHub
// mention ("@alice", no local part before the @) is left alone.
const EMAIL_PATTERN = /[\p{L}\p{N}._%+-]+[@＠][\p{L}\p{N}.-]+\.\p{L}{2,}/gu;

const INVALID_REFERENCE = { ok: false, errorCode: "invalid_reference" };

function collapseWhitespace(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function redactEmails(text) {
  return String(text ?? "").replace(EMAIL_PATTERN, "[email]");
}

// A search result's title or body as at most `max` characters, emails
// redacted. EMAIL_PATTERN takes quadratic time on a long run of word
// characters, and anyone can open an issue with a 65,536-character body, so
// only a window a few times `max` is redacted. The window ends at a space
// when it can, so no address is cut in two where the excerpt might show it.
function excerpt(text, max) {
  const collapsed = collapseWhitespace(text);
  // UTF-16 units: at least twice `max` characters, however many are emoji.
  const windowLength = max * 4;
  if (collapsed.length <= windowLength) return clip(redactEmails(collapsed), max);
  const space = collapsed.lastIndexOf(" ", windowLength);
  let end = space > max ? space : windowLength;
  // Never keep half a surrogate pair.
  if (/[\uD800-\uDBFF]/.test(collapsed[end - 1])) end -= 1;
  return clip(`${redactEmails(collapsed.slice(0, end))}…`, max);
}

// At most `max` characters (code points, so never half a surrogate pair),
// ending in "…" when anything was cut.
function clip(text, max) {
  if (text.length <= max) return text;
  const characters = [...text];
  return characters.length <= max ? text : `${characters.slice(0, max - 1).join("")}…`;
}

function validRepoName(name) {
  return REPO_PATTERN.test(name) && name !== "." && name !== "..";
}

function reference(owner, repo, number) {
  if (!OWNER_PATTERN.test(owner) || !validRepoName(repo)) return INVALID_REFERENCE;
  if (!NUMBER_PATTERN.test(number)) return INVALID_REFERENCE;
  return { ok: true, owner, repo, number: Number(number) };
}

// `repo#12` (`name` is "repo") or `#12` (`name` is "").
function parseInstalledReference(input) {
  const match = INSTALLED_REFERENCE.exec(typeof input === "string" ? input.trim() : "");
  if (!match || (match[1] && !validRepoName(match[1])) || !NUMBER_PATTERN.test(match[2])) {
    return INVALID_REFERENCE;
  }
  return { ok: true, name: match[1], number: Number(match[2]) };
}

/**
 * An issue or pull request the user named: `owner/repo#12`, or its
 * github.com link (`/issues/12` or `/pull/12`, with anything after it).
 */
function parseGithubTarget(input) {
  const raw = typeof input === "string" ? input.trim() : "";
  const short = SHORT_REFERENCE.exec(raw);
  if (short) return reference(short[1], short[2], short[3]);
  let url;
  try {
    url = new URL(raw);
  } catch {
    return INVALID_REFERENCE;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port ||
    url.username ||
    url.password
  ) {
    return INVALID_REFERENCE;
  }
  const [, owner, repo, kind, number] = url.pathname.split("/");
  if (kind !== "issues" && kind !== "pull") return INVALID_REFERENCE;
  return reference(owner ?? "", repo ?? "", number ?? "");
}

// A quote left open would make the rest of the query, the qualifiers added
// after the words included, one phrase; the last quote is dropped.
function withoutOpenQuote(text) {
  if ((text.match(/"/g) ?? []).length % 2 === 0) return text;
  const last = text.lastIndexOf('"');
  return text.slice(0, last) + text.slice(last + 1);
}

// A parenthesis without its pair (the user's own, or the ")" a removed
// qualifier's value stopped at) is dropped: an open group would take in the
// qualifiers added after the words. Parentheses in a quoted phrase are words.
function balancedParentheses(text) {
  const characters = [...text];
  const unpaired = [];
  const open = [];
  let quoted = false;
  characters.forEach((character, index) => {
    if (character === '"') quoted = !quoted;
    else if (quoted) return;
    else if (character === "(") open.push(index);
    else if (character === ")") {
      if (open.length > 0) open.pop();
      else unpaired.push(index);
    }
  });
  const dropped = new Set([...unpaired, ...open]);
  return characters.filter((_, index) => !dropped.has(index)).join("");
}

function withoutLeftovers(text) {
  let previous;
  let current = text;
  do {
    previous = current;
    for (const pattern of LEFTOVERS) current = current.replace(pattern, "$1 ");
  } while (current !== previous);
  return collapseWhitespace(current);
}

/**
 * The `q` for GET /search/issues: the user's words without their own scope
 * qualifiers, the type (`issue` or `pr`) and state (unless the words name
 * one), then one `repo:` per installed repo in the order given (most
 * recently updated first) while `q`, encoded as the request sends it, stays
 * within MAX_SEARCH_QUERY_LENGTH. `truncated` says some repos were left out.
 */
function buildSearchQuery({ query, type, state = "open", repos = [] }) {
  const unscoped = withoutOpenQuote(String(query ?? "")).replace(OWN_QUALIFIER, (match, lead) =>
    // A quoted phrase stays as it is.
    lead === undefined ? match : `${lead} `
  );
  const words = withoutLeftovers(balancedParentheses(unscoped));
  const stateQualifier = state === "all" || STATE_QUALIFIER.test(words) ? "" : "state:open";
  let q = [words, TYPE_QUALIFIERS[type], stateQualifier].filter(Boolean).join(" ");
  const searched = [];
  for (const fullName of repos) {
    const next = `${q}${q ? " " : ""}repo:${fullName}`;
    if (formBody({ q: next }).length > MAX_SEARCH_QUERY_LENGTH) break;
    q = next;
    searched.push(fullName);
  }
  // Without a single repo: qualifier the search would cover every repo the
  // user can see, not only the installed ones.
  if (searched.length === 0) return { ok: false, errorCode: "too_long" };
  return { ok: true, q, repos: searched, truncated: searched.length < repos.length };
}

// English for the model; the card and the tool step show translated copy by
// errorCode.
function failureMessage(errorCode) {
  switch (errorCode) {
    case "reconnect_needed":
      return "GitHub needs to be reconnected under Settings → Integrations → Connectors.";
    case "connection_changed":
      return "The GitHub connection changed, so nothing was done.";
    case "rate_limited":
      return "GitHub is limiting requests right now. Try again later.";
    case "no_repositories":
      return "The OpenWhispr GitHub App isn't installed on any repository yet. Tell the user to choose repositories for it in Settings → Integrations → Connectors.";
    case "forbidden":
      return "GitHub refused: the user may not have permission for that in this repository.";
    case "not_found":
      return "GitHub couldn't find that issue or pull request.";
    case "issues_disabled":
      return "Issues are turned off in that repository.";
    case "archived":
      return "That repository is archived, so it can't take new issues or comments.";
    case "invalid":
      return "GitHub couldn't accept this as written.";
    case "too_long":
      return `Keep the title to ${MAX_TITLE_LENGTH} characters and the text to ${MAX_BODY_LENGTH} characters or fewer.`;
    case "invalid_reference":
      return "Give the issue or pull request as owner/repo#123, repo#123, #123 or its github.com link.";
    case "credential_save_failed":
      return "Couldn't save the refreshed GitHub login.";
    case "not_configured":
      return "GitHub isn't available in this build of OpenWhispr.";
    case "network":
      return "Couldn't reach GitHub.";
    default:
      if (isTransportErrorCode(errorCode)) return "Couldn't reach GitHub.";
      return /^http_5\d\d$/.test(errorCode)
        ? "GitHub had a problem answering. Try again later."
        : "GitHub refused the request.";
  }
}

function failed(errorCode, message = failureMessage(errorCode)) {
  return { status: "failed", errorCode, message };
}

function commitFailed(errorCode, message = failureMessage(errorCode)) {
  return { state: "failed", errorCode, message };
}

// A lookup's failure, with its own message when it has one.
function failedWith(failure) {
  return failed(failure.errorCode, failure.message);
}

function commitFailedWith(failure) {
  return commitFailed(failure.errorCode, failure.message);
}

// The distinct names, in the order given.
function labelList(value) {
  const seen = new Set();
  const labels = [];
  for (const raw of Array.isArray(value) ? value : []) {
    if (typeof raw !== "string") continue;
    const label = raw.trim();
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }
  return labels;
}

function repoPath(repo) {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}

function findInstalled(repos, owner, name) {
  const wanted = `${owner}/${name}`.toLowerCase();
  return repos.find((repo) => repo.fullName.toLowerCase() === wanted) ?? null;
}

function searchItem(raw, fullName) {
  if (!Number.isInteger(raw?.number) || !nonEmptyString(raw?.html_url)) return null;
  const pullRequest = raw.pull_request && typeof raw.pull_request === "object";
  const state = pullRequest && raw.pull_request.merged_at ? "merged" : raw.state;
  return {
    reference: `${fullName}#${raw.number}`,
    isPullRequest: Boolean(pullRequest),
    title: excerpt(raw.title, MAX_TITLE_LENGTH),
    state: state === "closed" || state === "merged" ? state : "open",
    url: raw.html_url,
    updatedAt: nonEmptyString(raw.updated_at) ? raw.updated_at : null,
    assignee: nonEmptyString(raw.assignee?.login) ? raw.assignee.login : null,
    author: nonEmptyString(raw.user?.login) ? raw.user.login : null,
    labels: (Array.isArray(raw.labels) ? raw.labels : [])
      .map((label) => (typeof label === "string" ? label : label?.name))
      .filter(nonEmptyString)
      // GitHub caps a label name at 50 characters, so the quadratic pattern
      // has nothing long to run on.
      .map(redactEmails),
    snippet: excerpt(raw.body, SNIPPET_LENGTH),
  };
}

function createGithubConnector({
  api,
  auth,
  installations,
  credentials,
  getSlug = () => null,
  notifyStatusChanged = () => {},
  statusTimeoutMs = STATUS_REPOSITORIES_TIMEOUT_MS,
}) {
  // The installed repository count per OpenWhispr account, for its current
  // login ({ generation, count }), and the reads in flight. The manager asks
  // every connector for its status together, so the status answers with the
  // last count read and never waits on GitHub: Slack's Connect or the first
  // chat turn would wait with it.
  const repoCounts = new Map();
  const countReads = new Set();
  const countKey = (binding) => `${binding.ownerAccountId}:${binding.generation}`;

  function manageUrl() {
    const slug = getSlug();
    return typeof slug === "string" && SLUG_PATTERN.test(slug)
      ? `https://github.com/apps/${slug}/installations/new`
      : null;
  }

  // `truncated`: the installations listed more repositories than OpenWhispr
  // reads, so the repo may be installed after all.
  function notInstalled(fullName, truncated = false) {
    if (truncated) {
      return {
        errorCode: "repo_unlisted",
        message: `The OpenWhispr GitHub App isn't installed on ${fullName}, as far as OpenWhispr can tell: it reads the first 1,000 repositories of each installation. Ask the user to check the name.`,
      };
    }
    const installUrl = manageUrl();
    const message = `The OpenWhispr GitHub App isn't installed on ${fullName}.`;
    return {
      errorCode: "not_installed",
      message: installUrl
        ? `${message} Tell the user to install it on that repository: ${installUrl}`
        : `${message} Tell the user to install it on that repository from Settings → Integrations → Connectors.`,
    };
  }

  // One action's requests share this: the bound login and its current token.
  // A 401 means GitHub refused and did nothing, so it is refreshed once under
  // the same login and asked again; a second 401 means the login is gone.
  async function call(session, send) {
    const first = await send(session.token);
    if (first.ok || first.errorCode !== "unauthorized") return first;
    const refreshed = await auth.refreshRejected(session.binding, session.token);
    if (!refreshed.ok) return { ok: false, outcome: "failed", errorCode: refreshed.errorCode };
    session.token = refreshed.token;
    const second = await send(session.token);
    if (!second.ok && second.errorCode === "unauthorized") {
      return {
        ok: false,
        outcome: "failed",
        errorCode: auth.markReconnect(session.binding).errorCode,
      };
    }
    return second;
  }

  async function openSession(binding) {
    const access = await auth.getAccessToken(binding);
    if (!access.ok) return { failure: { errorCode: access.errorCode } };
    return { session: { binding, token: access.token, login: access.credential.login } };
  }

  // With `wanted` ({ owner, repo }), a list without that repo is read once
  // more, like one with no repo at all: the App may have just been installed.
  async function installedRepos(session, wanted) {
    const found = wanted
      ? (repos) => findInstalled(repos, wanted.owner, wanted.repo) !== null
      : (repos) => repos.length > 0;
    const listed = await call(session, (token) =>
      installations.listFinding(session.binding, token, found)
    );
    if (!listed.ok) return { failure: { errorCode: listed.errorCode } };
    if (listed.repos.length === 0) return { failure: { errorCode: "no_repositories" } };
    return { repos: listed.repos, truncated: listed.truncated === true };
  }

  // An installed repo that can take new issues and comments, or why not.
  function writableRepo(repo, fullName, truncated) {
    if (!repo) return { failure: notInstalled(fullName, truncated) };
    if (repo.archived) {
      return {
        failure: {
          errorCode: "archived",
          message: `${repo.fullName} is archived, so it can't take new issues or comments.`,
        },
      };
    }
    return { repo };
  }

  // writableRepo, with issues turned on. A repo with issues off still takes
  // comments on its pull requests, so only a new issue checks it.
  function issueRepo(repo, fullName, truncated) {
    const writable = writableRepo(repo, fullName, truncated);
    if (writable.failure || repo.hasIssues) return writable;
    return {
      failure: {
        errorCode: "issues_disabled",
        message: `Issues are turned off in ${repo.fullName}, so it can't take a new issue.`,
      },
    };
  }

  async function resolveRepo(session, input, options) {
    const resolved = await call(session, (token) =>
      installations.resolveRepo(session.binding, token, input, options)
    );
    if (resolved.ok) return { repo: resolved.repo };
    if (resolved.clarification) return { clarification: resolved.clarification };
    if (resolved.errorCode === "not_installed" || resolved.errorCode === "repo_unlisted") {
      return { failure: notInstalled(input.trim(), resolved.errorCode === "repo_unlisted") };
    }
    return { failure: { errorCode: resolved.errorCode, message: resolved.message } };
  }

  // GitHub answers 410 both when a repo's issues are off and when the issue
  // was deleted; the installed repo says which. Null for any other answer.
  function deletedIssue(result, repo, number) {
    if (result.errorCode !== "issues_disabled" || !repo.hasIssues) return null;
    return { errorCode: "not_found", message: `${repo.fullName}#${number} was deleted.` };
  }

  // GitHub answers 403 or 404 for a repo the App isn't installed on (any
  // more), and 403 for one archived since the list was read: the
  // installations are read again to tell those apart.
  async function refusal(session, result, repo) {
    if (result.errorCode === "forbidden" || result.errorCode === "not_found") {
      installations.clear(session.binding);
      const listed = await call(session, (token) => installations.list(session.binding, token));
      if (listed.ok) {
        const fresh = findInstalled(listed.repos, repo.owner, repo.name);
        const writable = writableRepo(fresh, repo.fullName, listed.truncated === true);
        if (writable.failure) return writable.failure;
      }
    }
    return { errorCode: result.errorCode };
  }

  // The issue or PR a comment goes on, in an installed repo, still open to
  // comments. Read at prepare and again at Send.
  async function readTarget(session, target) {
    const installed = await installedRepos(session, target);
    if (installed.failure) return installed;
    const writable = writableRepo(
      findInstalled(installed.repos, target.owner, target.repo),
      `${target.owner}/${target.repo}`,
      installed.truncated
    );
    if (writable.failure) return writable;
    const { repo } = writable;
    const read = await call(session, (token) =>
      api.rest("GET", `${repoPath(repo)}/issues/${target.number}`, { token })
    );
    if (!read.ok) {
      return {
        failure: deletedIssue(read, repo, target.number) ?? (await refusal(session, read, repo)),
      };
    }
    const issue = read.data;
    if (!Number.isInteger(issue?.number) || !nonEmptyString(issue?.html_url)) {
      return {
        failure: { errorCode: "bad_response", message: "GitHub's answer couldn't be read." },
      };
    }
    // fetch follows redirects, and GitHub 301s a transferred issue: the
    // reply can be a different issue than the one asked for (another
    // number, another repo, another title). Never trust it for the
    // destination or the payload without checking it answered the number
    // asked for, in this repo.
    const expectedIssueUrl =
      `https://github.com/${repo.fullName}/issues/${target.number}`.toLowerCase();
    const expectedPullUrl =
      `https://github.com/${repo.fullName}/pull/${target.number}`.toLowerCase();
    const actualUrl = issue.html_url.toLowerCase();
    if (
      issue.number !== target.number ||
      (actualUrl !== expectedIssueUrl && actualUrl !== expectedPullUrl)
    ) {
      return {
        failure: {
          errorCode: "not_found",
          message: `GitHub couldn't find that issue or pull request in ${repo.fullName}; it may have moved.`,
        },
      };
    }
    const destination = `${repo.fullName}#${target.number}`;
    // GitHub still takes comments on a locked conversation from people who
    // can push to the repo.
    if (issue.locked === true && !repo.canPush) {
      return {
        failure: {
          errorCode: "locked",
          message: `The conversation on ${destination} is locked, so it can't take new comments.`,
        },
      };
    }
    return {
      repo,
      destination,
      issue: {
        number: target.number,
        title: typeof issue.title === "string" ? issue.title : "",
        isPullRequest: Boolean(issue.pull_request),
        url: issue.html_url,
      },
    };
  }

  // One search per type (`any` is both), each limited to `repos`.
  async function runSearches(session, { query, type, state }, repos) {
    const searches = (type === "any" ? ["issue", "pr"] : [type]).map((kind) =>
      buildSearchQuery({ query, type: kind, state, repos: repos.map((repo) => repo.fullName) })
    );
    if (searches.some((built) => !built.ok)) {
      return {
        failure: {
          errorCode: "too_long",
          message:
            "The search is too long to limit to the user's repositories. Ask for a shorter search.",
        },
      };
    }
    const pages = await Promise.all(
      searches.map((built) =>
        call(session, (token) =>
          api.rest("GET", "/search/issues", {
            token,
            query: { q: built.q, sort: "updated", order: "desc", per_page: MAX_RESULTS },
          })
        )
      )
    );
    const failure = pages.find((found) => !found.ok);
    // A transport failure (offline, DNS, reset, timeout) would otherwise
    // reach normalizeQueryResult as an unrecognized code and get rewritten to
    // generic "query_failed" copy; "network" is a code it accepts as is.
    if (failure) {
      return {
        failure: {
          errorCode: isTransportErrorCode(failure.errorCode) ? "network" : failure.errorCode,
        },
      };
    }
    return { searches, pages };
  }

  // The search over the repo named, or every installed one. `truncated`:
  // the installations listed more repos than OpenWhispr reads, so some went
  // unsearched.
  async function scopedSearch(session, repo, params) {
    let scope;
    if (repo) {
      const resolved = await resolveRepo(session, repo);
      if (!resolved.repo) return resolved;
      scope = { repos: [resolved.repo], truncated: false };
    } else {
      scope = await installedRepos(session);
      if (scope.failure) return scope;
    }
    const run = await runSearches(session, params, scope.repos);
    return run.failure ? run : { ...run, truncated: scope.truncated };
  }

  async function searchIssues(args, binding) {
    const query = typeof args?.query === "string" ? args.query.trim() : "";
    if (!query) return clarify("Ask the user what to search GitHub for.");
    if (characterCount(query) > MAX_QUERY_LENGTH) {
      return failed("too_long", `Keep the search to ${MAX_QUERY_LENGTH} characters or fewer.`);
    }
    const state = args?.state ?? "open";
    const type = args?.type ?? "any";
    // Refused before GitHub is asked: the model's own input, not GitHub's
    // verdict.
    if (!STATES.has(state) || !TYPES.has(type)) {
      return failed("invalid_input", "state is open or all, and type is issue, pr or any.");
    }
    const opened = await openSession(binding);
    if (opened.failure) return failedWith(opened.failure);
    const { session } = opened;
    const repo = typeof args?.repo === "string" ? args.repo.trim() : "";
    const params = { query, type, state };

    let run = await scopedSearch(session, repo, params);
    // GitHub answers 422 when q names a repo the user can no longer search
    // (unticked on the install page, deleted, access lost), which the 60 s
    // cache can still list: the repos are read fresh and searched once more.
    if (run.failure?.errorCode === "invalid") {
      installations.clear(session.binding);
      run = await scopedSearch(session, repo, params);
    }
    if (run.clarification) return clarify(run.clarification.message, run.clarification.candidates);
    if (run.failure) return failedWith(run.failure);
    const { searches, pages } = run;
    const items = [];
    let truncated = run.truncated;
    searches.forEach((built, index) => {
      const found = pages[index];
      const searched = new Map(built.repos.map((fullName) => [fullName.toLowerCase(), fullName]));
      const raws = Array.isArray(found.data?.items) ? found.data.items : [];
      for (const raw of raws) {
        const match = SEARCH_REPO_URL.exec(raw?.repository_url ?? "");
        // GitHub may answer with repos the user can see but didn't install
        // the App on; those never reach the model.
        const fullName = match ? searched.get(`${match[1]}/${match[2]}`.toLowerCase()) : null;
        const item = fullName ? searchItem(raw, fullName) : null;
        if (item) items.push(item);
      }
      const total = found.data?.total_count;
      truncated ||=
        built.truncated ||
        found.data?.incomplete_results === true ||
        (Number.isInteger(total) && total > raws.length);
    });
    // Most recently updated first across both searches, as each one is.
    items.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return {
      status: "ok",
      items: items.slice(0, MAX_RESULTS),
      truncated: truncated || items.length > MAX_RESULTS,
    };
  }

  async function prepareIssue(args, binding) {
    // A title is one line: line breaks become spaces.
    const title = typeof args?.title === "string" ? args.title.replace(/[\r\n]+/g, " ").trim() : "";
    if (!title) return clarify("Ask the user what the issue's title should be.");
    if (characterCount(title) > MAX_TITLE_LENGTH) {
      return failed("too_long", `Keep the title to ${MAX_TITLE_LENGTH} characters or fewer.`);
    }
    const body = typeof args?.body === "string" ? args.body : "";
    if (characterCount(body) > MAX_BODY_LENGTH) {
      return failed("too_long", `Keep the description to ${MAX_BODY_LENGTH} characters or fewer.`);
    }
    const requested = labelList(args?.labels);
    // Never trimmed to fit: the card would show fewer labels than asked for
    // without saying so.
    if (requested.length > MAX_LABELS) {
      return failed("too_many_labels", `Pick at most ${MAX_LABELS} labels for one issue.`);
    }

    const opened = await openSession(binding);
    if (opened.failure) return failedWith(opened.failure);
    const { session } = opened;
    const resolved = await resolveRepo(session, typeof args?.repo === "string" ? args.repo : "", {
      forNewIssue: true,
    });
    if (resolved.clarification) {
      return clarify(
        `${resolved.clarification.message} The issue can go in any of these.`,
        resolved.clarification.candidates
      );
    }
    if (resolved.failure) return failedWith(resolved.failure);
    const writable = issueRepo(resolved.repo);
    if (writable.failure) return failedWith(writable.failure);
    const { repo } = writable;

    const labels = [];
    const dropped = [];
    if (requested.length > 0) {
      const listed = await call(session, (token) =>
        api.restAll(`${repoPath(repo)}/labels`, { token, query: { per_page: 100 } })
      );
      if (!listed.ok) {
        const refused = await refusal(session, listed, repo);
        // A 404 here is about the repo, never an issue or pull request.
        return failedWith(
          refused.errorCode === "not_found"
            ? {
                errorCode: "labels_unavailable",
                message: `Couldn't read the labels in ${repo.fullName}. Try again, or create the issue without labels.`,
              }
            : refused
        );
      }
      const existing = new Map(
        listed.items
          .filter((label) => nonEmptyString(label?.name))
          .map((label) => [label.name.toLowerCase(), label.name])
      );
      for (const label of requested) {
        const match = existing.get(label.toLowerCase());
        if (match) labels.push(match);
        // Only the first 1,000 labels were read, so this one may exist all
        // the same: it goes as asked, and the card lists it with the others
        // rather than saying the repo doesn't have it.
        else if (listed.truncated) labels.push(label);
        else dropped.push(label);
      }
    }

    const notes = [];
    if (labels.length > 0) {
      notes.push({
        key: "connectors.approval.issue.notes.labels",
        values: { labels: labels.join(", ") },
      });
    }
    if (dropped.length > 0) {
      notes.push({
        key: "connectors.approval.issue.notes.droppedLabels",
        values: { destination: repo.fullName, labels: dropped.join(", ") },
      });
    }
    // GitHub silently drops labels when the user can't push to the repo.
    if (labels.length > 0 && !repo.canPush) {
      notes.push({ key: "connectors.approval.github.notes.labelsMayNotApply" });
    }

    return {
      status: "ready",
      payload: { owner: repo.owner, repo: repo.name, title, body, labels },
      preview: {
        verbKey: "issue",
        destinationLabel: repo.fullName,
        accountLabel: `@${session.login}`,
        body,
        fields: { title, body },
        notes,
      },
    };
  }

  // The { owner, repo, number } a parsed target names, finding the repo of
  // `repo#12` or `#12` among the installed ones.
  async function commentTarget(session, parsed) {
    if (parsed.owner) return { target: parsed };
    const resolved = await resolveRepo(session, parsed.name);
    if (resolved.clarification) {
      return {
        clarification: clarify(
          `${resolved.clarification.message} The comment goes on #${parsed.number} there.`,
          resolved.clarification.candidates
        ),
      };
    }
    if (resolved.failure) return resolved;
    const { repo } = resolved;
    return { target: { owner: repo.owner, repo: repo.name, number: parsed.number } };
  }

  async function prepareComment(args, binding) {
    const full = parseGithubTarget(args?.target);
    const parsed = full.ok ? full : parseInstalledReference(args?.target);
    if (!parsed.ok) return failed("invalid_reference");
    const body = typeof args?.body === "string" ? args.body : "";
    if (!body.trim()) return clarify("Ask the user what the comment should say.");
    if (characterCount(body) > MAX_BODY_LENGTH) {
      return failed("too_long", `Keep the comment to ${MAX_BODY_LENGTH} characters or fewer.`);
    }
    const opened = await openSession(binding);
    if (opened.failure) return failedWith(opened.failure);
    const { session } = opened;
    const found = await commentTarget(session, parsed);
    if (found.clarification) return found.clarification;
    if (found.failure) return failedWith(found.failure);
    const read = await readTarget(session, found.target);
    if (read.failure) return failedWith(read.failure);

    const notes = [
      {
        key: "connectors.approval.comment.notes.targetTitle",
        values: { title: clip(collapseWhitespace(read.issue.title), MAX_TITLE_LENGTH) },
      },
    ];
    if (read.issue.isPullRequest)
      notes.push({ key: "connectors.approval.github.notes.pullRequest" });
    return {
      status: "ready",
      payload: { owner: read.repo.owner, repo: read.repo.name, number: read.issue.number, body },
      preview: {
        verbKey: "comment",
        destinationLabel: read.destination,
        accountLabel: `@${session.login}`,
        body,
        fields: { body },
        notes,
      },
    };
  }

  // The card's title and description, over what prepare stored.
  function issueEdits(payload, edits) {
    const changes = edits ?? {};
    const rawTitle = typeof changes.title === "string" ? changes.title : payload.title;
    const body = typeof changes.body === "string" ? changes.body : payload.body;
    // Every check from prepare again, before anything reaches GitHub.
    if (LINE_BREAK.test(rawTitle)) {
      return commitFailed("invalid", "The title must be a single line, so nothing was created.");
    }
    const title = rawTitle.trim();
    if (!title) return commitFailed("invalid", "The issue has no title, so nothing was created.");
    if (characterCount(title) > MAX_TITLE_LENGTH || characterCount(body) > MAX_BODY_LENGTH) {
      return commitFailed("too_long");
    }
    return { title, body };
  }

  async function createIssue(payload, edits, binding) {
    const checked = issueEdits(payload, edits);
    if (checked.state === "failed") return checked;
    const opened = await openSession(binding);
    if (opened.failure) return commitFailedWith(opened.failure);
    const { session } = opened;
    const installed = await installedRepos(session, payload);
    if (installed.failure) return commitFailedWith(installed.failure);
    const writable = issueRepo(
      findInstalled(installed.repos, payload.owner, payload.repo),
      `${payload.owner}/${payload.repo}`,
      installed.truncated
    );
    if (writable.failure) return commitFailedWith(writable.failure);
    const { repo } = writable;
    const created = await call(session, (token) =>
      api.rest("POST", `${repoPath(repo)}/issues`, {
        token,
        body: {
          title: checked.title,
          body: checked.body,
          ...(payload.labels.length > 0 ? { labels: payload.labels } : {}),
        },
      })
    );
    const checkUrl = `https://github.com/${repo.fullName}/issues`;
    if (created.ok) {
      const { number, html_url: url } = created.data ?? {};
      if (Number.isInteger(number) && nonEmptyString(url)) {
        return { state: "sent", url, resultLabel: `${repo.fullName}#${number}` };
      }
      return { state: "unknown", errorCode: "bad_response", checkUrl };
    }
    if (created.outcome === "failed") {
      const refused = await refusal(session, created, repo);
      // GitHub answers 404 to a write the user may not make there, and the
      // repo is still installed: no issue is missing.
      if (refused.errorCode === "not_found") {
        return commitFailed(
          "forbidden",
          `GitHub refused: the user may not be able to create issues in ${repo.fullName}.`
        );
      }
      return commitFailedWith(refused);
    }
    // GitHub has no idempotency key, so an uncertain create is never repeated.
    return { state: "unknown", errorCode: created.errorCode, checkUrl };
  }

  async function postComment(payload, edits, binding) {
    const body = typeof edits?.body === "string" ? edits.body : payload.body;
    if (!body.trim())
      return commitFailed("invalid", "The comment is empty, so nothing was posted.");
    if (characterCount(body) > MAX_BODY_LENGTH) return commitFailed("too_long");
    const opened = await openSession(binding);
    if (opened.failure) return commitFailedWith(opened.failure);
    const { session } = opened;
    const read = await readTarget(session, {
      owner: payload.owner,
      repo: payload.repo,
      number: payload.number,
    });
    if (read.failure) return commitFailedWith(read.failure);
    const posted = await call(session, (token) =>
      api.rest("POST", `${repoPath(read.repo)}/issues/${read.issue.number}/comments`, {
        token,
        body: { body },
      })
    );
    if (posted.ok) {
      return nonEmptyString(posted.data?.html_url)
        ? { state: "sent", url: posted.data.html_url }
        : { state: "unknown", errorCode: "bad_response", checkUrl: read.issue.url };
    }
    if (posted.outcome === "failed") {
      return commitFailedWith(
        deletedIssue(posted, read.repo, read.issue.number) ??
          (await refusal(session, posted, read.repo))
      );
    }
    return { state: "unknown", errorCode: posted.errorCode, checkUrl: read.issue.url };
  }

  function bindingFor(ownerAccountId, entry) {
    return {
      ownerAccountId,
      accountId: String(entry.credential.userId),
      generation: entry.generation,
    };
  }

  // A list younger than REFETCH_AFTER_MS is reused, so the status
  // broadcasts that follow each other don't each read every repository, and
  // an install picked on GitHub's own page moments ago still shows.
  async function countRepos(binding, signal) {
    const opened = await openSession(binding);
    let failure = opened.failure;
    if (!failure) {
      if (signal.aborted) return null;
      const listed = await call(opened.session, (token) =>
        installations.list(binding, token, { signal, maxAgeMs: REFETCH_AFTER_MS })
      );
      // More repositories are installed than OpenWhispr reads (1,000 each).
      if (listed.ok) return `${listed.repos.length}${listed.truncated ? "+" : ""}`;
      failure = listed;
    }
    // The refresh this read needed was refused and the login is saved as
    // needing a reconnect, but Settings and the offered tools only see that
    // in a status read. Announced even after the read was given up on.
    if (failure.errorCode === "reconnect_needed") notifyStatusChanged();
    return null;
  }

  // The installed repo count, within statusTimeoutMs. Best effort: a
  // failure or a timeout is null, never "0".
  async function repoCount(binding) {
    const signal = AbortSignal.timeout(statusTimeoutMs);
    const gaveUp = new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(null), { once: true });
    });
    return Promise.race([countRepos(binding, signal).catch(() => null), gaveUp]);
  }

  // The last read for this login ({ count }, a null count when it failed),
  // or null before one has finished.
  function lastRead(binding) {
    const last = repoCounts.get(binding.ownerAccountId);
    return last?.generation === binding.generation ? last : null;
  }

  // Reads the count again in the background and announces a changed one,
  // and the first read for a login even when it failed, so the row stops
  // waiting on it. A later count that couldn't be read keeps the last one.
  function refreshRepoCount(binding) {
    const key = countKey(binding);
    if (countReads.has(key)) return;
    countReads.add(key);
    void repoCount(binding).then((count) => {
      countReads.delete(key);
      const last = lastRead(binding);
      if (last && (count === null || count === last.count)) return;
      repoCounts.set(binding.ownerAccountId, { generation: binding.generation, count });
      notifyStatusChanged();
    });
  }

  return {
    id: "github",
    actions: {
      search_issues: { kind: "query" },
      create_issue: { kind: "approval", editable: { title: "line", body: "text" } },
      comment: { kind: "approval", editable: { body: "text" } },
    },

    async getStatus() {
      const url = manageUrl();
      const withManage = (status) => (url ? { ...status, manageUrl: url } : status);
      const ownerAccountId = credentials.activeAccountId();
      const entry = credentials.read(ownerAccountId, "github");
      if (!entry) {
        return withManage({
          connected: false,
          // Without the App's slug there's no way to choose repositories, and
          // every action would end in no_repositories.
          configured: auth.isConfigured() && url !== null,
          accountLabel: null,
          workspaceLabel: null,
          needsReconnect: false,
        });
      }
      // A login always reports configured, so Disconnect stays reachable.
      const status = { ...auth.statusOf(entry.credential), configured: true };
      if (status.needsReconnect) return withManage(status);
      const binding = bindingFor(ownerAccountId, entry);
      refreshRepoCount(binding);
      const last = lastRead(binding);
      // Pending until the first read for this login (after a connect, or
      // at launch) finishes, so the row doesn't offer to choose repositories
      // that may be installed already.
      return withManage({
        ...status,
        workspaceLabel: last?.count ?? null,
        ...(last ? {} : { workspaceLabelPending: true }),
      });
    },

    async getBinding() {
      const ownerAccountId = credentials.activeAccountId();
      const entry = credentials.read(ownerAccountId, "github");
      return entry ? bindingFor(ownerAccountId, entry) : null;
    },

    async query(action, args, { binding } = {}) {
      if (action !== "search_issues") return failed("unknown_action", "Unknown GitHub action.");
      return searchIssues(args, binding);
    },

    async prepare(action, args, { binding } = {}) {
      if (action === "create_issue") return prepareIssue(args, binding);
      if (action === "comment") return prepareComment(args, binding);
      return failed("unknown_action", "Unknown GitHub action.");
    },

    async commit(action, payload, edits, { binding } = {}) {
      if (action === "create_issue") return createIssue(payload, edits, binding);
      if (action === "comment") return postComment(payload, edits, binding);
      return commitFailed("unknown_action", "Unknown GitHub action.");
    },

    authorize: (options) => auth.authorize(options),
    // Only when every login is going (account deletion, Reset app data).
    // GitHub's secret-free revoke is its endpoint for exposed credentials and
    // emails the user, which reads as a leak after an ordinary Disconnect or
    // reconnect; those only delete the login here, and the App's
    // authorization stays on github.com either way.
    revoke: async (credential, { removingAll = false } = {}) => {
      if (removingAll) await auth.revoke(credential);
    },
  };
}

// Foundation §9.3: one api, auth and installations instance for every
// consumer, so concurrent actions share one single-flight refresh (GitHub's
// refresh tokens are single-use).
function buildGithubConnector(deps) {
  const api = createGithubApi({ fetchImpl: deps.fetch });
  const auth = createGithubAuth({
    api,
    credentials: deps.credentials,
    getClientId: () => deps.env?.GITHUB_APP_CLIENT_ID,
    broadcast: deps.broadcast,
    logger: deps.logger,
  });
  return createGithubConnector({
    api,
    auth,
    installations: createGithubInstallations({ api }),
    credentials: deps.credentials,
    getSlug: () => deps.env?.GITHUB_APP_SLUG,
    notifyStatusChanged: deps.notifyStatusChanged,
  });
}

module.exports = {
  createGithubConnector,
  buildGithubConnector,
  parseGithubTarget,
  buildSearchQuery,
  STATUS_REPOSITORIES_TIMEOUT_MS,
  MAX_TITLE_LENGTH,
  MAX_BODY_LENGTH,
  MAX_LABELS,
  MAX_RESULTS,
  SNIPPET_LENGTH,
};
