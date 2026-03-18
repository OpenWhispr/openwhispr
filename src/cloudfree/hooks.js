/**
 * CloudFree Hooks
 *
 * Pluggable hook system for the CloudFree fork. Defines all integration
 * points into main.js and preload.js so that upstream can adopt this
 * pattern and forks can cleanly extend the app without merge conflicts.
 *
 * Usage in main.js:
 *   const cloudfree = require("./src/cloudfree/hooks");
 *   cloudfree.onBeforeReady({ session, debugLogger });
 *
 * Usage in preload.js:
 *   const cloudfree = require("./src/cloudfree/hooks");
 *   const api = cloudfree.preload(ipcRenderer);
 *   // Spread into contextBridge: ...api
 */

const { installNetworkGuard } = require("./networkGuard");

module.exports = {
  /**
   * Called at the very start of startApp(), before any windows are created.
   * Installs the network guard on the default session.
   */
  onBeforeReady({ session, debugLogger }) {
    installNetworkGuard(session, debugLogger || console);
  },

  /**
   * Returns CloudFree preload API bindings to spread into contextBridge.
   * @param {Electron.IpcRenderer} ipcRenderer
   * @returns {Record<string, Function>}
   */
  preload(ipcRenderer) {
    return {
      cloudfreeGetNetworkLog: () => ipcRenderer.invoke("cloudfree:get-network-log"),
      cloudfreeGetAllowlist: () => ipcRenderer.invoke("cloudfree:get-allowlist"),
      cloudfreeResetStats: () => ipcRenderer.invoke("cloudfree:reset-stats"),
      cloudfreeAddUserRule: (rule) => ipcRenderer.invoke("cloudfree:add-user-rule", rule),
      cloudfreeRemoveUserRule: (rule) => ipcRenderer.invoke("cloudfree:remove-user-rule", rule),
      cloudfreeToggleGroup: (opts) => ipcRenderer.invoke("cloudfree:toggle-group", opts),
      cloudfreeGetUserConfig: () => ipcRenderer.invoke("cloudfree:get-user-config"),
    };
  },
};
