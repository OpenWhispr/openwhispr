/**
 * browserMeetingUrlChecker
 *
 * Uses AppleScript (via osascript) to inspect open browser tab URLs and decide
 * whether one is an ACTIVE meeting-code URL (a real call), as opposed to a bare
 * landing page like meet.google.com that a user may leave open all day.
 *
 * Only queries browsers that are already running (the `is running` guard avoids
 * launching them). If macOS Automation permission is denied, it caches the
 * denial and degrades gracefully (callers should fall back to device-in-use +
 * native meeting-process signals).
 */
const { execFile } = require("child_process");
const debugLogger = require("./debugLogger");

// Active-meeting URL patterns (a meeting *code*, not a landing page).
const MEETING_URL_PATTERNS = [
  // meet.google.com/abc-defg-hij
  /^https:\/\/meet\.google\.com\/[a-z]{3,4}-[a-z]{4}-[a-z]{3,4}(?:[/?#]|$)/i,
  // zoom web client: *.zoom.us/wc/<id>/... or /wc/join/<id> or /j/<id>
  /^https:\/\/[\w.-]*zoom\.us\/(?:wc\/(?:join\/)?|j\/)\d{3,}/i,
  // teams web meeting join
  /^https:\/\/teams\.(?:microsoft|live)\.com\/.*(?:meetup-join|\/meet\/|meetingjoin)/i,
];

const BROWSERS = ["Google Chrome", "Brave Browser", "Microsoft Edge", "Arc", "Safari"];

let automationDenied = false;

function tabsScript(appName) {
  // The `is running` guard prevents osascript from launching a closed browser.
  return `if application "${appName}" is running then\n  tell application "${appName}" to get URL of tabs of windows\nend if`;
}

function runOsascript(script) {
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], { timeout: 4000 }, (err, stdout, stderr) => {
      if (err) {
        // -1743 = "not authorized to send Apple events" (Automation denied).
        const denied = /-1743|not authoriz/i.test(`${stderr || ""}${err.message || ""}`);
        resolve({ ok: false, denied, output: "" });
        return;
      }
      resolve({ ok: true, denied: false, output: String(stdout || "") });
    });
  });
}

/**
 * @returns {Promise<{matched:boolean, url?:string, browser?:string, denied?:boolean}>}
 */
async function checkForActiveMeetingUrl() {
  if (process.platform !== "darwin") return { matched: false };
  if (automationDenied) return { matched: false, denied: true };

  let anyBrowserResponded = false;
  for (const app of BROWSERS) {
    const res = await runOsascript(tabsScript(app));
    if (res.denied) {
      automationDenied = true;
      debugLogger.warn(
        "Browser tab check blocked (Automation permission denied); using device-in-use only",
        {},
        "meeting"
      );
      return { matched: false, denied: true };
    }
    if (!res.ok || !res.output.trim()) continue;
    anyBrowserResponded = true;
    // osascript renders a list of URLs comma-separated (may include nested windows).
    const urls = res.output
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const url of urls) {
      if (MEETING_URL_PATTERNS.some((re) => re.test(url))) {
        return { matched: true, url, browser: app };
      }
    }
  }
  // No match — but was it a confident "no meeting" or an inconclusive failure?
  return anyBrowserResponded
    ? { matched: false }
    : { matched: false, unavailable: true };
}

module.exports = { checkForActiveMeetingUrl, MEETING_URL_PATTERNS };
