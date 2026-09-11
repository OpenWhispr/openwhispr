const HotkeyManager = require("./hotkeyManager");

// Preserve the upstream slot API and on-disk hotkey names. The public trigger
// contract adds a device-neutral description without duplicating registration,
// rollback, platform hooks or the existing push/toggle state machines.
class TriggerManager extends HotkeyManager {
  registerTrigger(slot, trigger, callback, options = {}) {
    if (!trigger || !["keyboard", "mouse"].includes(trigger.kind)) {
      return Promise.resolve({ success: false, error: "Unsupported trigger kind" });
    }
    const key = trigger.kind === "mouse" ? "MouseButton" + trigger.button : trigger.accelerator;
    if (trigger.kind === "mouse" && ![3, 4, 5].includes(trigger.button)) {
      return Promise.resolve({ success: false, error: "Supported mouse buttons are 3, 4 and 5" });
    }
    return this.registerSlot(slot, key, callback, options);
  }

  getTriggers(slot) {
    return this.getSlotHotkeys(slot).map((key) =>
      HotkeyManager.isMouseButtonHotkey(key)
        ? { kind: "mouse", button: Number(key.slice(-1)) }
        : { kind: "keyboard", accelerator: key }
    );
  }
}
module.exports = TriggerManager;
