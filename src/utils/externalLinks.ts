export async function openExternalUrl(url: string, failureMessage: string): Promise<void> {
  if (window.electronAPI?.openExternal) {
    const result = await window.electronAPI.openExternal(url);
    if (result?.success === false) throw new Error(result.error || failureMessage);
    return;
  }
  const opened = window.open(url, "_blank");
  if (!opened) throw new Error(failureMessage);
  opened.opener = null;
}

export function openExternalLink(url: string): void {
  if (window.electronAPI?.openExternal) {
    window.electronAPI.openExternal(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

export function createExternalLinkHandler(url: string) {
  return (e: React.MouseEvent) => {
    e.preventDefault();
    openExternalLink(url);
  };
}

// Tags an outbound link with OpenWhispr UTM attribution. Non-http(s) and
// already-attributed URLs pass through unchanged so existing links can't break.
export function withUtm(url: string, campaign = "app"): string {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return url;
    if (u.searchParams.has("utm_source")) return url; // respect existing attribution
    u.searchParams.set("utm_source", "openwhispr");
    u.searchParams.set("utm_medium", "app");
    u.searchParams.set("utm_campaign", campaign);
    return u.toString();
  } catch {
    return url;
  }
}
