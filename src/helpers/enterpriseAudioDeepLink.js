function parseEnterpriseAudioDeepLink(value, protocol = "openwhispr") {
  try {
    const url = new URL(value);
    if (
      url.protocol !== `${protocol}:` ||
      url.hostname !== "enterprise-audio-test" ||
      !["", "/"].includes(url.pathname) ||
      url.username ||
      url.password ||
      url.hash ||
      [...url.searchParams.keys()].some((key) => !["workspaceId", "provider"].includes(key))
    )
      return null;
    const workspaceId = url.searchParams.get("workspaceId");
    const provider = url.searchParams.get("provider");
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(workspaceId ?? "") ||
      !["azure", "openai-compatible"].includes(provider) ||
      url.searchParams.getAll("workspaceId").length !== 1 ||
      url.searchParams.getAll("provider").length !== 1
    )
      return null;
    return { workspaceId, provider };
  } catch {
    return null;
  }
}

module.exports = { parseEnterpriseAudioDeepLink };
