const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
const TRAILING_PUNCTUATION_PATTERN = /[),.;:!?]+$/;
const MEETING_URL_RULES = [
  {
    hostname: "zoom.us",
    allowSubdomains: true,
    pathnamePattern: /^\/(?:j|w|my)\/[^/]+/i,
  },
  { hostname: "meet.google.com", pathnamePattern: /^\/[^/]+/ },
  {
    hostname: "teams.microsoft.com",
    pathnamePattern: /^\/(?:l\/meetup-join|meet)\/[^/]+/i,
  },
  { hostname: "teams.live.com", pathnamePattern: /^\/meet\/[^/]+/i },
  { hostname: "webex.com", allowSubdomains: true, pathnamePattern: /^\/[^/]+/ },
  { hostname: "chime.aws", pathnamePattern: /^\/[^/]+/ },
];

function isAllowedHostname(candidateHostname, allowedHostname, allowSubdomains) {
  return (
    candidateHostname === allowedHostname ||
    (allowSubdomains && candidateHostname.endsWith(`.${allowedHostname}`))
  );
}

function isMeetingUrl(value) {
  try {
    const url = new URL(value);
    return MEETING_URL_RULES.some(
      ({ hostname, allowSubdomains, pathnamePattern }) =>
        isAllowedHostname(url.hostname, hostname, allowSubdomains) &&
        pathnamePattern.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function getMeetingJoinUrl(event) {
  if (!event) return null;
  const hangoutLink = event.hangout_link?.trim();
  if (hangoutLink) return hangoutLink;
  if (!event.conference_data) return null;
  try {
    const data = JSON.parse(event.conference_data);
    const uri = data?.entryPoints
      ?.find((ep) => ep.entryPointType === "video" && ep.uri?.trim())
      ?.uri?.trim();
    return uri || null;
  } catch {
    return null;
  }
}

// Finds a meeting link in loose text (EventKit has no structured conference
// data — Zoom/Meet/Teams/Webex links live in url, location, or notes).
export function extractMeetingUrl(candidates) {
  if (!Array.isArray(candidates)) return null;
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    for (const match of candidate.matchAll(URL_PATTERN)) {
      const value = match[0].replace(TRAILING_PUNCTUATION_PATTERN, "");
      if (isMeetingUrl(value)) return value;
    }
  }
  return null;
}
