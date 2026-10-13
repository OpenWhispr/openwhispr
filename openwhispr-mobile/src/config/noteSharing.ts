const HOSTED_API_URL = 'https://api.openwhispr.com';
const HOSTED_VIEWER_URL = 'https://notes.openwhispr.com';

export function getNoteShareViewerBaseUrl(): string {
  const configured = process.env.EXPO_PUBLIC_NOTES_URL;
  const apiUrl = process.env.EXPO_PUBLIC_API_URL || HOSTED_API_URL;
  if (!configured && apiUrl.replace(/\/$/, '') === HOSTED_API_URL) return HOSTED_VIEWER_URL;
  if (!configured) throw new Error('Configure EXPO_PUBLIC_NOTES_URL for this API');

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error('Invalid EXPO_PUBLIC_NOTES_URL');
  }
  const loopback =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]';
  if (
    (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== '/'
  ) {
    throw new Error('Invalid EXPO_PUBLIC_NOTES_URL');
  }
  return parsed.origin;
}
