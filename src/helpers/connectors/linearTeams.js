// A Linear workspace's teams and, on demand, a team's projects, cached for
// 10 minutes per login, and resolved from what the user said with the shared
// targetResolution rule: exact, then case-insensitive, then prefix. Two
// matches at one stage are always a question, never a guess.
const { resolveTarget } = require("./targetResolution");

const CACHE_TTL_MS = 10 * 60 * 1000;
// A name that matches nothing in a list older than this is looked up once
// more: the team or project may have been created since the list was read.
const REFETCH_AFTER_MS = 30 * 1000;
// Linear's largest page. A workspace with more teams (or a team with more
// projects) is resolved by exact name only, since a looser match could be on
// the page that wasn't read.
const PAGE_SIZE = 250;
// What a question lists: the foundation keeps at most 20 candidates.
const MAX_CANDIDATES = 20;
// A name the user said, as quoted back to the model.
const MAX_QUOTED_LENGTH = 100;

const TEAMS_QUERY = `query LinearTeams { teams(first: ${PAGE_SIZE}) { nodes { id key name } pageInfo { hasNextPage } } }`;
const PROJECTS_QUERY = `query LinearTeamProjects($teamId: String!) { team(id: $teamId) { projects(first: ${PAGE_SIZE}) { nodes { id name } pageInfo { hasNextPage } } } }`;

const nonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;
const teamLabel = (team) => `${team.key} · ${team.name}`;
const quoted = (input) => input.trim().slice(0, MAX_QUOTED_LENGTH);

// The login a cache entry belongs to. A reconnect is a new generation, so
// nothing cached for the old login is ever read for the new one.
const loginKey = (binding) => `${binding?.ownerAccountId ?? ""}:${binding?.generation ?? ""}`;

function failure(result) {
  return { ok: false, outcome: result.outcome ?? "unknown", errorCode: result.errorCode };
}

function clarification(message, candidates) {
  return { ok: false, clarification: { message, candidates: candidates.slice(0, MAX_CANDIDATES) } };
}

function createLinearTeams({ api, now = Date.now, ttlMs = CACHE_TTL_MS }) {
  const cache = new Map();

  async function cached(key, load, maxAgeMs = ttlMs) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < Math.min(maxAgeMs, ttlMs)) return hit.value;
    const value = await load();
    // Only answers are kept: a failure is asked again next time.
    if (value.ok) cache.set(key, { at: now(), value });
    return value;
  }

  function list(binding, token, maxAgeMs) {
    return cached(
      `${loginKey(binding)}|teams`,
      async () => {
        const result = await api.graphql(TEAMS_QUERY, {}, { token });
        if (!result.ok) return failure(result);
        const nodes = result.data?.teams?.nodes;
        if (!Array.isArray(nodes))
          return { ok: false, outcome: "unknown", errorCode: "bad_response" };
        const teams = nodes
          .filter(
            (team) =>
              nonEmptyString(team?.id) && nonEmptyString(team.key) && nonEmptyString(team.name)
          )
          .map((team) => ({ id: team.id, key: team.key, name: team.name }));
        return { ok: true, teams, truncated: result.data.teams.pageInfo?.hasNextPage === true };
      },
      maxAgeMs
    );
  }

  function projects(binding, token, teamId, maxAgeMs) {
    return cached(
      `${loginKey(binding)}|projects|${teamId}`,
      async () => {
        const result = await api.graphql(PROJECTS_QUERY, { teamId }, { token });
        if (!result.ok) return failure(result);
        // A team Linear doesn't return has no projects this login can use.
        if (result.data?.team === null) return { ok: true, projects: [], truncated: false };
        const connection = result.data?.team?.projects;
        if (!Array.isArray(connection?.nodes)) {
          return { ok: false, outcome: "unknown", errorCode: "bad_response" };
        }
        return {
          ok: true,
          projects: connection.nodes
            .filter((project) => nonEmptyString(project?.id) && nonEmptyString(project.name))
            .map((project) => ({ id: project.id, name: project.name })),
          truncated: connection.pageInfo?.hasNextPage === true,
        };
      },
      maxAgeMs
    );
  }

  // Resolves `input` against a list, reading the list once more when nothing
  // matched and what was read is older than REFETCH_AFTER_MS.
  async function resolveInList(read, input, toCandidates) {
    let listed = await read();
    if (!listed.ok) return { listed };
    const match = (answer) =>
      resolveTarget(input, toCandidates(answer), { exactOnly: answer.truncated });
    let resolved = match(listed);
    if (resolved.status === "none") {
      const fresher = await read(REFETCH_AFTER_MS);
      if (!fresher.ok) return { listed: fresher };
      if (fresher !== listed) {
        listed = fresher;
        resolved = match(fresher);
      }
    }
    return { listed, resolved };
  }

  async function resolveTeam(binding, token, input) {
    if (!nonEmptyString(input)) {
      const listed = await list(binding, token);
      if (!listed.ok) return listed;
      const { teams, truncated } = listed;
      // A single team is used without asking; with several, the user picks.
      if (teams.length === 1 && !truncated) return { ok: true, team: teams[0] };
      if (teams.length === 0) {
        return clarification("This Linear login can't see any team to create an issue in.", []);
      }
      return clarification(
        "Which Linear team should this go to? Ask the user.",
        teams.map(teamLabel)
      );
    }
    const { listed, resolved } = await resolveInList(
      (maxAgeMs) => list(binding, token, maxAgeMs),
      input,
      (answer) => answer.teams.map((team) => ({ id: team.id, names: [team.key, team.name], team }))
    );
    if (!listed.ok) return listed;
    if (resolved.status === "match") return { ok: true, team: resolved.candidate.team };
    if (resolved.status === "ambiguous") {
      return clarification(
        `More than one Linear team matches "${quoted(input)}". Ask the user which one.`,
        resolved.candidates.map((candidate) => teamLabel(candidate.team))
      );
    }
    return clarification(
      `No Linear team matches "${quoted(input)}". Ask the user which team to use.`,
      listed.teams.map(teamLabel)
    );
  }

  // A project the team doesn't have, like an ambiguous one, is a question:
  // the user either names another or files the issue without one.
  async function resolveProject(binding, token, teamId, input) {
    if (!nonEmptyString(input)) return { ok: true, project: null };
    const { listed, resolved } = await resolveInList(
      (maxAgeMs) => projects(binding, token, teamId, maxAgeMs),
      input,
      (answer) =>
        answer.projects.map((project) => ({ id: project.id, names: [project.name], project }))
    );
    if (!listed.ok) return listed;
    if (resolved.status === "match") return { ok: true, project: resolved.candidate.project };
    if (resolved.status === "ambiguous") {
      return clarification(
        `More than one Linear project matches "${quoted(input)}". Ask the user which one.`,
        resolved.candidates.map((candidate) => candidate.project.name)
      );
    }
    return clarification(
      `No Linear project in this team matches "${quoted(input)}". Ask the user which project to use, or whether to create the issue without one.`,
      listed.projects.map((project) => project.name)
    );
  }

  // Forgets one login's teams and projects, or everything with no binding.
  function clear(binding) {
    if (!binding) {
      cache.clear();
      return;
    }
    const prefix = `${loginKey(binding)}|`;
    for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key);
  }

  return { list, resolveTeam, resolveProject, clear };
}

module.exports = { createLinearTeams, CACHE_TTL_MS, REFETCH_AFTER_MS };
