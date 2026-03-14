import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "module";

// createRequire bypasses vitest's ESM transform, avoiding the JSDoc
// parsing issue in networkGuard.js where /*/resolve/main/* is misinterpreted.
const require = createRequire(import.meta.url);
const hooks = require("./hooks.js");

describe("hooks", () => {
  describe("onBeforeReady", () => {
    it("is a function", () => {
      expect(typeof hooks.onBeforeReady).toBe("function");
    });
  });

  describe("preload", () => {
    it("returns an object with three IPC wrapper functions", () => {
      const mockInvoke = vi.fn();
      const api = hooks.preload({ invoke: mockInvoke });

      expect(typeof api.cloudfreeGetNetworkLog).toBe("function");
      expect(typeof api.cloudfreeGetAllowlist).toBe("function");
      expect(typeof api.cloudfreeResetStats).toBe("function");
    });

    it("cloudfreeGetNetworkLog invokes correct IPC channel", () => {
      const mockInvoke = vi.fn().mockResolvedValue({ log: [] });
      const api = hooks.preload({ invoke: mockInvoke });

      api.cloudfreeGetNetworkLog();
      expect(mockInvoke).toHaveBeenCalledWith("cloudfree:get-network-log");
    });

    it("cloudfreeGetAllowlist invokes correct IPC channel", () => {
      const mockInvoke = vi.fn().mockResolvedValue({ rules: {} });
      const api = hooks.preload({ invoke: mockInvoke });

      api.cloudfreeGetAllowlist();
      expect(mockInvoke).toHaveBeenCalledWith("cloudfree:get-allowlist");
    });

    it("cloudfreeResetStats invokes correct IPC channel", () => {
      const mockInvoke = vi.fn().mockResolvedValue({ ok: true });
      const api = hooks.preload({ invoke: mockInvoke });

      api.cloudfreeResetStats();
      expect(mockInvoke).toHaveBeenCalledWith("cloudfree:reset-stats");
    });
  });
});
