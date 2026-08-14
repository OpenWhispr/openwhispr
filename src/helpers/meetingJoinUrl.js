const MEETING_URL_PATTERN =
  /https?:\/\/[^\s<>"']*(?:zoom\.us\/j\/|meet\.google\.com\/|teams\.microsoft\.com\/l\/meetup-join|teams\.live\.com\/meet\/|\.webex\.com\/|chime\.aws\/)[^\s<>"']*/i;

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
    const match = candidate?.match?.(MEETING_URL_PATTERN);
    if (match) return match[0].replace(/[),.;:!?]+$/, "");
  }
  return null;
}
