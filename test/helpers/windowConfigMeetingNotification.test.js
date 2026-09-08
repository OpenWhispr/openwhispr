const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AUTO_END_NOTIFICATION_WINDOW_SIZE,
  NOTIFICATION_WINDOW_CONFIG,
  WindowPositionUtil,
  getMeetingNotificationWindowSize,
} = require("../../src/helpers/windowConfig");

test("meeting notifications accept the first macOS click with Electron's documented option", () => {
  assert.equal(NOTIFICATION_WINDOW_CONFIG.acceptFirstMouse, true);
  assert.equal(Object.hasOwn(NOTIFICATION_WINDOW_CONFIG, "acceptsFirstMouse"), false);
});

test("auto-end uses a larger positioned window while detection keeps its existing size", () => {
  const detectionSize = getMeetingNotificationWindowSize({ kind: "detection" });
  const autoEndSize = getMeetingNotificationWindowSize({ kind: "auto-end" });
  const display = { workArea: { x: 100, y: 50, width: 1400, height: 900 } };

  assert.deepEqual(detectionSize, { width: 392, height: 92 });
  assert.deepEqual(autoEndSize, AUTO_END_NOTIFICATION_WINDOW_SIZE);
  // Wider than a detection prompt because of the countdown copy and the Restart
  // action, but not so wide that a single line runs the width of the screen.
  assert.ok(autoEndSize.width > detectionSize.width);
  assert.ok(autoEndSize.width <= 480);
  assert.deepEqual(WindowPositionUtil.getNotificationPosition(display, autoEndSize), {
    x: 1004,
    y: 66,
    width: autoEndSize.width,
    height: autoEndSize.height,
  });
});

test("auto-end dimensions fit every supported localized title, body, and action", () => {
  const locales = ["en", "es", "fr", "de", "pt", "it", "ru", "ja", "zh-CN", "zh-TW"];
  const translations = locales.map(
    (locale) => require(`../../src/locales/${locale}/translation.json`).meetingNotification.autoEnd
  );
  const displayColumns = (value) =>
    [...value].reduce(
      (columns, character) =>
        columns +
        (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(character) ? 2 : 1),
      0
    );
  const longestActionColumns = Math.max(
    ...translations.map(({ restart }) => displayColumns(restart))
  );

  // Reserve the card's outer padding, icon/gaps, and the full non-wrapping action.
  const actionWidth = longestActionColumns * 6 + 20;
  const textWidth = AUTO_END_NOTIFICATION_WINDOW_SIZE.width - 24 - 20 - 26 - 20 - actionWidth;
  const columnsPerLine = Math.floor(textWidth / 6);
  // Every reason-specific body must fit, not just the longest per locale.
  const worstCase = translations.flatMap(({ title, body }, index) =>
    Object.entries(body).map(([reason, text]) => ({
      locale: locales[index],
      reason,
      lines:
        Math.ceil(displayColumns(title) / columnsPerLine) +
        Math.ceil(displayColumns(text) / columnsPerLine),
    }))
  );
  const maximumTextLines = Math.max(...worstCase.map(({ lines }) => lines));
  const requiredHeight = 24 + 20 + maximumTextLines * 14;

  assert.ok(columnsPerLine > 0);
  assert.ok(
    requiredHeight <= AUTO_END_NOTIFICATION_WINDOW_SIZE.height,
    `overflow: ${JSON.stringify(worstCase.filter(({ lines }) => lines === maximumTextLines))}`
  );
});
