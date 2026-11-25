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
const ZERO_WIDTH = /[​-‍﻿]/g;
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
 * The names a Slack window title may give its conversation: each part, with
 * and without a kind tag after it, without an unread mark or a leading "#",
 * leaving out Slack's own name and the workspace's. Slack's title ends with
 * its name ("eng (Channel) - Acme - 3 new items - Slack"), and a browser adds
 * its own and the profile's after it ("… - Slack - Google Chrome – Sam (acme.com)"),
 * so the parts after Slack's name never count.
 */
function slackTitleNames(title, workspaceName) {
  const skip = new Set(["slack", String(workspaceName ?? "").toLowerCase()]);
  const names = new Set();
  const parts = title.replace(ZERO_WIDTH, "").split(SEPARATOR);
  const slackAt = parts.findLastIndex((part) => part.trim().toLowerCase() === "slack");
  for (const segment of slackAt > 0 ? parts.slice(0, slackAt) : parts) {
    const part = segment.trim().replace(UNREAD, "");
    for (const name of [part, part.replace(KIND_TAG, "")]) {
      const bare = name.replace(/^#/, "").trim();
      if (bare && !skip.has(bare.toLowerCase())) names.add(bare);
    }
  }
  return [...names];
}

module.exports = { slackWindowTitle, slackTitleNames };
