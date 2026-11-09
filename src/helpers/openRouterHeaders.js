// OpenRouter uses these headers to identify the app in activity logs and analytics.
export function openRouterHeaders(endpoint) {
  try {
    if (new URL(endpoint).origin !== "https://openrouter.ai") return {};
  } catch {
    return {};
  }

  return {
    "HTTP-Referer": "https://openwhispr.com",
    "X-OpenRouter-Title": "OpenWhispr",
  };
}
