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
    hint: `${label} (@${displayName || user.name})`,
    names: [...new Set([displayName, realName, user.name].filter(Boolean))],
  };
}

function createSlackDirectory({ api, now = Date.now }) {
  const cache = new Map();

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

  async function cached(kind, cacheKey, load) {
    const key = `${kind}:${cacheKey}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_TTL_MS) return hit.value;
    const value = await load();
    if (value.ok) cache.set(key, { at: now(), value });
    return value;
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

  function people(token, cacheKey) {
    return cached("people", cacheKey, () =>
      listAll("users.list", {}, token, (data) =>
        (data.members ?? []).filter(isPerson).map(personCandidate)
      )
    );
  }

  async function personByEmail(token, email) {
    const result = await api.call("users.lookupByEmail", { email }, { token });
    if (result.ok) {
      return {
        ok: true,
        candidate: isPerson(result.data.user) ? personCandidate(result.data.user) : null,
      };
    }
    if (result.errorCode === "users_not_found") return { ok: true, candidate: null };
    return { ok: false, errorCode: result.errorCode };
  }

  return { channels, people, personByEmail };
}

module.exports = { createSlackDirectory };
