const { screen } = require("electron");
const { WindowPositionUtil } = require("./windowConfig");
const debugLogger = require("./debugLogger");

class DragManager {
  constructor() {
    this.isDragging = false;
    this.dragOffset = { x: 0, y: 0 };
    this.mouseTrackingInterval = null;
    this.targetWindow = null;
  }

  setTargetWindow(window) {
    this.targetWindow = window;
  }

  async startWindowDrag() {
    if (!this.targetWindow || this.targetWindow.isDestroyed()) {
      return { success: false, message: "Window not available" };
    }

    try {
      this.isDragging = true;

      // Get current cursor position
      const cursorPos = screen.getCursorScreenPoint();
      const windowPos = this.targetWindow.getPosition();

      // Calculate offset from cursor to window position
      this.dragOffset = {
        x: cursorPos.x - windowPos[0],
        y: cursorPos.y - windowPos[1],
      };

      // Start tracking mouse movements
      this.setupMouseTracking();

      debugLogger.info("Window drag started", undefined, "window-drag");
      return { success: true };
    } catch (error) {
      console.error("Failed to start window drag:", error);
      this.isDragging = false;
      return { success: false, message: error.message };
    }
  }

  async stopWindowDrag() {
    try {
      this.isDragging = false;
      this.stopMouseTracking();
      debugLogger.info("Window drag stopped", undefined, "window-drag");
      return { success: true };
    } catch (error) {
      console.error("Failed to stop window drag:", error);
      return { success: false, message: error.message };
    }
  }

  setupMouseTracking() {
    if (this.mouseTrackingInterval) {
      clearInterval(this.mouseTrackingInterval);
    }

    this.mouseTrackingInterval = setInterval(() => {
      if (this.isDragging && this.targetWindow && !this.targetWindow.isDestroyed()) {
        this.updateWindowPosition();
      }
    }, 16); // ~60fps
  }

  updateWindowPosition() {
    try {
      const cursorPos = screen.getCursorScreenPoint();
      const { width, height } = this.targetWindow.getBounds();
      const x = cursorPos.x - this.dragOffset.x;
      const y = cursorPos.y - this.dragOffset.y;

      // Constrain against the display the window lands on, not the one under the
      // cursor: near a boundary between differently sized displays, the cursor's
      // work area permits positions that leave the window in dead space.
      const display = screen.getDisplayNearestPoint({
        x: x + width / 2,
        y: y + height / 2,
      });
      const clamped = WindowPositionUtil.clampToWorkArea({ x, y, width, height }, display);

      this.targetWindow.setPosition(clamped.x, clamped.y);
    } catch (error) {
      console.error("Error updating window position:", error);
      this.stopWindowDrag();
    }
  }

  stopMouseTracking() {
    if (this.mouseTrackingInterval) {
      clearInterval(this.mouseTrackingInterval);
      this.mouseTrackingInterval = null;
    }
  }

  isDragActive() {
    return this.isDragging;
  }

  getDragOffset() {
    return { ...this.dragOffset };
  }

  cleanup() {
    this.stopWindowDrag();
    this.targetWindow = null;
  }
}

module.exports = DragManager;
