// The Slack conversation the agent hotkey was pressed over, from the window's
// title. The title stays in main: it never reaches a renderer, the model or the
// logs. Slack's title formats aren't documented and vary by version, platform
// and language, so nothing here assumes one: the connector takes a title part
// only when it is exactly the name of one conversation (slackConnector.js).

// The Slack app by its name, bundle id (com.tinyspeck.slackmacgap), executable
// or window class.
const SLACK_APP = /(?:^|[^a-z0-9])(?:slack|tinyspeck)(?:$|[^a-z0-9])/i;
const SLACK_HOST = /(?:^|\.)slack\.com$/i;
// Title parts are separated by a spaced dash, bar or dot.
const SEPARATOR = /\s[-–—|·•]\s/;
const ZERO_WIDTH = /[\u200b-\u200d\ufeff]/g;
// What Slack and browsers put before a title for unread messages: "* ", "! ", "(3) ".
const UNREAD = /^(?:[*!•]|\(\d+\+?\)|\[\d+\+?\])\s*/;
// A kind Slack may add after a name, in the user's language: "(Channel)", "(DM)".
const KIND_TAG = /\s*\([^()]*\)$/;

/**
 * The window title, when the press-time app (`selectionManager.getTargetAppContext()`)
 * is Slack: the desktop app, a slack.com page (its host is read on macOS only), or
 * a window whose title has a part that is Slack's own name. Otherwise null.
 */
function slackWindowTitle(context) {
  const title = typeof context?.windowTitle === "string" ? context.windowTitle.trim() : "";
  if (!title) return null;
  const isSlack =
    SLACK_APP.test(context.appSignature ?? "") ||
    SLACK_HOST.test(context.urlHost ?? "") ||
    title.split(SEPARATOR).some((part) => part.trim().toLowerCase() === "slack");
  return isSlack ? title : null;
}

/**
 * The names a Slack window title may give its conversation: the one part before
 * the workspace's name besides Slack's own, with and without a kind tag after it,
 * without an unread mark or a leading "#". Slack puts the conversation before the
 * workspace, whichever end its own name is on
 * ("eng (Channel) - Acme - 3 new items - Slack", "Slack | #eng | Acme"), and a
 * browser adds its own name and the profile's after ("… - Google Chrome – Sam (acme.com)"),
 * so nothing after the workspace's name counts. None when the title doesn't name it,
 * or when more parts come before it: a name with a dash in it ("Ana - Design") splits
 * into parts that could each be someone else.
 */
function slackTitleNames(title, workspaceName) {
  const workspace = String(workspaceName ?? "").toLowerCase();
  const parts = title.replace(ZERO_WIDTH, "").split(SEPARATOR);
  const workspaceAt = parts.findIndex(
    (part) => workspace && part.trim().toLowerCase() === workspace
  );
  const before = parts.slice(0, Math.max(workspaceAt, 0));
  const notSlack = (part) => part.trim().replace(UNREAD, "").toLowerCase() !== "slack";
  if (before.filter(notSlack).length !== 1) return [];
  const names = new Set();
  for (const segment of before) {
    const part = segment.trim().replace(UNREAD, "");
    for (const name of [part, part.replace(KIND_TAG, "")]) {
      const bare = name.replace(/^#/, "").trim();
      if (bare && bare.toLowerCase() !== "slack") names.add(bare);
    }
  }
  return [...names];
}

module.exports = { slackWindowTitle, slackTitleNames };
