const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

const loadedImagePaths = [];

const originalLoad = Module._load;
Module._load = function loadTrayWithStubs(request, parent, isMain) {
  if (request === "electron") {
    return {
      Tray: class {},
      Menu: {},
      nativeImage: {
        createFromPath: (iconPath) => {
          loadedImagePaths.push(iconPath);
          return { isEmpty: () => false, setTemplateImage: () => undefined };
        },
      },
      app: {},
    };
  }
  if (request === "./debugLogger") return { info: () => undefined, debug: () => undefined };
  if (request === "./dockManager") return {};
  if (request === "./i18nMain") return { i18nMain: { t: (key) => key } };
  return originalLoad.call(this, request, parent, isMain);
};
const TrayManager = require("../../src/helpers/tray");
Module._load = originalLoad;

function createTrayManager(calls, { dictating = false } = {}) {
  const trayManager = new TrayManager();
  trayManager.windowManager = {
    isDictationPanelVisible: () => false,
    isDictating: () => dictating,
    sendStartDictation: () => calls.push("start-dictation"),
    sendStopDictation: () => calls.push("stop-dictation"),
    sendOpenAssistantPanel: () => calls.push("assistant"),
    startManualMeeting: () => calls.push("meeting"),
  };
  return trayManager;
}

test("the tray menu leads with the dictation pill's quick actions", () => {
  const calls = [];
  const [listen, assistant, meeting, separator] =
    createTrayManager(calls).buildContextMenuTemplate();

  assert.deepEqual(
    [listen.label, assistant.label, meeting.label, separator.type],
    [
      "app.commandMenu.startListening",
      "app.commandMenu.askAssistant",
      "app.commandMenu.startMeetingRecording",
      "separator",
    ]
  );

  listen.click();
  assistant.click();
  meeting.click();
  // Listening and a meeting start in the main process; only the assistant needs
  // the renderer, which is the one that can open its panel.
  assert.deepEqual(calls, ["start-dictation", "assistant", "meeting"]);
});

test("the tray's listen item stops the recording it reflects", () => {
  const calls = [];
  const [listen] = createTrayManager(calls, { dictating: true }).buildContextMenuTemplate();

  assert.equal(listen.label, "app.commandMenu.stopListening");
  listen.click();
  assert.deepEqual(calls, ["stop-dictation"]);
});

test(
  "the monochrome tray style loads the one-color icon on Linux and Windows",
  { skip: process.platform === "darwin" },
  async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    loadedImagePaths.length = 0;

    try {
      await new TrayManager("monochrome").loadTrayIcon();
      assert.equal(path.basename(loadedImagePaths.at(-1)), "iconTemplate@3x.png");

      await new TrayManager("default").loadTrayIcon();
      assert.equal(
        path.basename(loadedImagePaths.at(-1)),
        process.platform === "win32" ? "icon.ico" : "icon.png"
      );
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  }
);

test("changing tray style replaces the live icon", async () => {
  const trayManager = new TrayManager();
  const monochromeIcon = { isEmpty: () => false };
  const applied = [];
  trayManager.tray = { setImage: (icon) => applied.push(icon) };
  trayManager.loadTrayIcon = async () => monochromeIcon;

  await trayManager.setIconStyle("monochrome");

  assert.equal(trayManager.iconStyle, "monochrome");
  assert.deepEqual(applied, [monochromeIcon]);
});
