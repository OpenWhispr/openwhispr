export function getMeetingJoinUrl(event) {
  if (!event) return null;
  if (event.hangout_link) return event.hangout_link;
  if (!event.conference_data) return null;
  try {
    const data = JSON.parse(event.conference_data);
    return data?.entryPoints?.find((ep) => ep.entryPointType === "video")?.uri ?? null;
  } catch {
    return null;
  }
}
