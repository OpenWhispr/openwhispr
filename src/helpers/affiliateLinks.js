const fs = require("fs");
const path = require("path");
const { app, net } = require("electron");
const tokenStore = require("./tokenStore");
const accountScopeBinding = require("./accountScopeBinding");

const CLICK_ID = /^[A-Za-z0-9_-]{1,128}$/;
function configuration() {
  const domain = process.env.OPENWHISPR_AFFILIATE_DOMAIN;
  return process.env.OPENWHISPR_AFFILIATE_ENABLED === "true" &&
    ["try.openwhispr.com", "open-whispr-affiliate-sandbox.dub.link"].includes(domain)
    ? { domain }
    : null;
}
function parseLink(value, domain) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.hostname !== domain ||
      url.port ||
      url.username ||
      url.password ||
      !/^\/[A-Za-z0-9_-]+$/.test(url.pathname)
    )
      return null;
    return url.toString();
  } catch {
    return null;
  }
}
function parseArrival(value, protocol, domain) {
  try {
    const url = new URL(value);
    if (
      value.length > 4096 ||
      url.protocol !== `${protocol}:` ||
      url.hostname !== "affiliate" ||
      url.username ||
      url.password ||
      url.port ||
      !["", "/"].includes(url.pathname)
    )
      return null;
    const link = parseLink(url.searchParams.get("link"), domain);
    const clickId = url.searchParams.get("dub_id");
    if (!link && !CLICK_ID.test(clickId ?? "")) return null;
    return { link: link ?? "", clickId: CLICK_ID.test(clickId ?? "") ? clickId : null };
  } catch {
    return null;
  }
}
const file = () => path.join(app.getPath("userData"), "affiliate-candidate.json");
function context() {
  const state = tokenStore.getState();
  const scope = accountScopeBinding.resolveActiveAccountScope({
    ...state,
    binding: accountScopeBinding.read(),
  });
  return { ...state, accountId: scope?.accountId ?? null };
}
function read() {
  try {
    const data = JSON.parse(fs.readFileSync(file(), "utf8"));
    const config = configuration();
    if (
      !config ||
      !data ||
      (data.ownerId !== null && typeof data.ownerId !== "string") ||
      (data.tokenHash !== null && !/^[a-f0-9]{64}$/.test(data.tokenHash)) ||
      typeof data.saved !== "boolean" ||
      typeof data.link !== "string" ||
      data.link.length > 2048 ||
      (data.clickId && !CLICK_ID.test(data.clickId))
    )
      return null;
    return data;
  } catch {
    return null;
  }
}
function write(candidate) {
  const destination = file();
  fs.writeFileSync(`${destination}.tmp`, JSON.stringify(candidate), { mode: 0o600 });
  fs.renameSync(`${destination}.tmp`, destination);
}
function clear() {
  fs.rmSync(file(), { force: true });
}
function capture(value, protocol) {
  const config = configuration();
  const parsed = config && parseArrival(value, protocol, config.domain);
  if (!parsed) return false;
  const current = context();
  const previous = read();
  if (previous?.saved && previous.ownerId === current.accountId) return true;
  write({
    ...parsed,
    saved: false,
    ownerId: current.accountId,
    tokenHash: current.token ? accountScopeBinding.hashToken(current.token) : null,
  });
  return true;
}
function candidateForCurrentAccount() {
  const candidate = read();
  if (!candidate) return null;
  const current = context();
  if (candidate.ownerId && candidate.ownerId !== current.accountId) {
    if (current.accountId || !current.token) clear();
    return null;
  }
  if (
    !candidate.ownerId &&
    candidate.tokenHash &&
    candidate.tokenHash !== (current.token ? accountScopeBinding.hashToken(current.token) : null)
  ) {
    clear();
    return null;
  }
  if (!candidate.ownerId && current.accountId) {
    candidate.ownerId = current.accountId;
    write(candidate);
  }
  return { link: candidate.link, clickId: candidate.clickId, saved: candidate.saved };
}
function saveCandidate(input) {
  const config = configuration();
  const current = context();
  if (!config || input?.generation !== current.generation) throw new Error("AUTH_CONTEXT_CHANGED");
  if (
    typeof input.link !== "string" ||
    input.link.length > 2048 ||
    (input.clickId && !CLICK_ID.test(input.clickId))
  )
    throw new Error("INVALID_REFERRAL");
  const previous = candidateForCurrentAccount();
  if (previous?.saved) return;
  // Partial text is allowed while editing; only a resolved link is used for requests.
  write({
    link: input.link,
    clickId: input.clickId ?? null,
    saved: input.saved === true,
    ownerId: current.accountId,
    tokenHash: current.token ? accountScopeBinding.hashToken(current.token) : null,
  });
}
async function resolveLink(value, expectedGeneration, fetcher = (...args) => net.fetch(...args)) {
  const config = configuration();
  const link = config && parseLink(value, config.domain);
  if (!link || tokenStore.getState().generation !== expectedGeneration)
    throw new Error("INVALID_REFERRAL");
  // Follow only the creator-link request. Never fetch its arbitrary destination.
  const response = await fetcher(link, { redirect: "manual", signal: AbortSignal.timeout(8000) });
  const destination = response.headers.get("location");
  if (
    tokenStore.getState().generation !== expectedGeneration ||
    ![301, 302, 303, 307, 308].includes(response.status) ||
    !destination
  )
    throw new Error("REFERRAL_UNAVAILABLE");
  const url = new URL(destination);
  const clickId = url.searchParams.get("dub_id");
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    !["openwhispr.com", "www.openwhispr.com"].includes(url.hostname) ||
    !CLICK_ID.test(clickId ?? "")
  )
    throw new Error("REFERRAL_UNAVAILABLE");
  return { link, clickId };
}
module.exports = {
  configuration,
  parseLink,
  parseArrival,
  capture,
  candidateForCurrentAccount,
  saveCandidate,
  resolveLink,
};
