const { Menu } = require("electron");
const { i18nMain } = require("./i18nMain");

class MenuManager {
  static setupMainMenu(onOpenSettings) {
    if (process.platform === "darwin") {
      const template = [
        {
          label: i18nMain.t("menu.appLabel"),
          submenu: [
            { role: "about" },
            { type: "separator" },
            {
              label: i18nMain.t("menu.settings"),
              accelerator: "Command+,",
              click: () => onOpenSettings?.(),
            },
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit", label: i18nMain.t("menu.quit") },
          ],
        },
      ];
      const menu = Menu.buildFromTemplate(template);
      Menu.setApplicationMenu(menu);
    }
  }

  static setupControlPanelMenu(controlPanelWindow, onOpenSettings) {
    if (process.platform === "darwin") {
      // On macOS, create a proper application menu
      const template = [
        {
          label: i18nMain.t("menu.appLabel"),
          submenu: [
            { role: "about" },
            { type: "separator" },
            {
              label: i18nMain.t("menu.settings"),
              accelerator: "Command+,",
              click: () => onOpenSettings?.(),
            },
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit", label: i18nMain.t("menu.quit") },
          ],
        },
        {
          label: "Edit",
          submenu: [
            { role: "undo" },
            { role: "redo" },
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
            { role: "pasteAndMatchStyle" },
            { role: "delete" },
            { role: "selectAll" },
            { type: "separator" },
            {
              label: i18nMain.t("menu.speech"),
              submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }],
            },
          ],
        },
        {
          label: "View",
          submenu: [
            { role: "reload" },
            { role: "forceReload" },
            { role: "toggleDevTools" },
            { type: "separator" },
            { role: "resetZoom" },
            { role: "zoomIn" },
            { role: "zoomOut" },
            { type: "separator" },
            { role: "togglefullscreen" },
          ],
        },
        {
          label: "Window",
          submenu: [
            { role: "minimize" },
            { role: "close" },
            { type: "separator" },
            { role: "front" },
            { type: "separator" },
            { role: "window" },
          ],
        },
        {
          label: i18nMain.t("menu.help"),
          submenu: [
            {
              label: i18nMain.t("menu.learnMore"),
              click: async () => {
                const { shell } = require("electron");
                await shell.openExternal("https://github.com/OpenWhispr/openwhispr");
              },
            },
          ],
        },
      ];

      const menu = Menu.buildFromTemplate(template);
      Menu.setApplicationMenu(menu);
    } else {
      // For Windows/Linux, keep the window-specific menu
      const template = [
        {
          label: i18nMain.t("menu.file"),
          submenu: [
            {
              label: i18nMain.t("menu.settings"),
              accelerator: "Ctrl+,",
              click: () => onOpenSettings?.(),
            },
            { type: "separator" },
            { role: "close", label: i18nMain.t("menu.closeWindow") },
          ],
        },
        {
          label: "Edit",
          submenu: [
            { role: "undo" },
            { role: "redo" },
            { type: "separator" },
            { role: "cut" },
            { role: "copy" },
            { role: "paste" },
            { type: "separator" },
            { role: "selectAll" },
          ],
        },
        {
          label: "View",
          submenu: [
            { role: "reload" },
            { role: "forceReload" },
            { role: "toggleDevTools" },
            { type: "separator" },
            { role: "resetZoom" },
            { role: "zoomIn" },
            { role: "zoomOut" },
            { type: "separator" },
            { role: "togglefullscreen" },
          ],
        },
      ];

      const menu = Menu.buildFromTemplate(template);
      controlPanelWindow.setMenu(menu);
    }
  }
}

module.exports = MenuManager;
