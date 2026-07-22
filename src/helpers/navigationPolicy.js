export function isInternalNavigation(url, appUrl) {
  return Boolean(
    (appUrl && url.startsWith(appUrl)) ||
      url.startsWith("file://") ||
      url.startsWith("devtools://")
  );
}
