const CACHE_TTL_MS = 10 * 60 * 1000;
const PAGE_LIMIT = 200;
const MAX_PAGES = 10;

function channelCandidate(channel) {
  return { id: channel.id, kind: "channel", label: `#${channel.name}`, names: [channel.name] };
}

function isPerson(user) {
  return (
    Boolean(user) && !user.deleted && !user.is_bot && !user.is_app_user && user.id !== "USLACKBOT"
  );
}

function personCandidate(user) {
  const profile = user.profile ?? {};
  const realName = profile.real_name || user.real_name || "";
  const displayName = profile.display_name || "";
  const label = realName || displayName || user.name;
  return {
    id: user.id,
    kind: "user",
    label,
    // The username: display names needn't be unique.
    hint: `${label} (@${user.name})`,
    // The username, unique in a workspace: "@handle" finds exactly this person.
    handle: user.name,
    names: [...new Set([displayName, realName, user.name].filter(Boolean))],
  };
}

function createSlackDirectory({ api, now = Date.now }) {
  const cache = new Map();
  const loading = new Map();

  // Stops at MAX_PAGES and says so: callers must not treat a cut-off list
  // as every channel or person there is.
  async function listAll(method, params, token, itemsOf) {
    const items = [];
    let cursor = "";
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await api.call(
        method,
        { ...params, limit: String(PAGE_LIMIT), ...(cursor ? { cursor } : {}) },
        { token }
      );
      if (!result.ok) return { ok: false, errorCode: result.errorCode };
      items.push(...itemsOf(result.data));
      cursor = result.data.response_metadata?.next_cursor || "";
      if (!cursor) return { ok: true, items, truncated: false };
    }
    return { ok: true, items, truncated: true };
  }

  // Callers asking at once share one load (people and notPeople read the same list).
  function cached(kind, cacheKey, load) {
    const key = `${kind}:${cacheKey}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.value);
    let pending = loading.get(key);
    if (!pending) {
      pending = load()
        .then((value) => {
          if (value.ok) cache.set(key, { at: now(), value });
          return value;
        })
        .finally(() => loading.delete(key));
      loading.set(key, pending);
    }
    return pending;
  }

  // Only channels the user is in: a user token can't post anywhere else.
  function channels(token, cacheKey) {
    return cached("channels", cacheKey, () =>
      listAll(
        "users.conversations",
        { types: "public_channel,private_channel", exclude_archived: "true" },
        token,
        (data) =>
          (data.channels ?? []).filter((channel) => !channel.is_archived).map(channelCandidate)
      )
    );
  }

  // Everyone in the workspace, read once for both lists below.
  function members(token, cacheKey) {
    return cached("members", cacheKey, () =>
      listAll("users.list", {}, token, (data) => data.members ?? [])
    );
  }

  async function membersWhere(token, cacheKey, keep, toCandidate) {
    const list = await members(token, cacheKey);
    return list.ok ? { ...list, items: list.items.filter(keep).map(toCandidate) } : list;
  }

  function people(token, cacheKey) {
    return membersWhere(token, cacheKey, isPerson, personCandidate);
  }

  // Bots, apps and deactivated accounts: no one to post to, but a DM with one
  // is titled with its name, so a person who shares it isn't the one it's with.
  function notPeople(token, cacheKey) {
    return membersWhere(
      token,
      cacheKey,
      (user) => Boolean(user) && !isPerson(user),
      (user) => ({ ...personCandidate(user), kind: "not_person" })
    );
  }

  // One person, looked up exactly; Slack not knowing them is no match.
  async function lookUpPerson(method, params, notFound, token) {
    const result = await api.call(method, params, { token });
    if (result.ok) {
      return {
        ok: true,
        candidate: isPerson(result.data.user) ? personCandidate(result.data.user) : null,
      };
    }
    if (result.errorCode === notFound) return { ok: true, candidate: null };
    return { ok: false, errorCode: result.errorCode };
  }

  const personByEmail = (token, email) =>
    lookUpPerson("users.lookupByEmail", { email }, "users_not_found", token);
  const personById = (token, id) =>
    lookUpPerson("users.info", { user: id }, "user_not_found", token);

  return { channels, people, notPeople, personByEmail, personById };
}

module.exports = { createSlackDirectory };
