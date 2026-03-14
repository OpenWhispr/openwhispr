import { describe, it, expect } from "vitest";
import { settingsMap, defaultSettingsSection } from "./ui-hooks";

describe("defaultSettingsSection", () => {
  it("is 'general'", () => {
    expect(defaultSettingsSection).toBe("general");
  });
});

describe("settingsMap", () => {
  const items = [
    { id: "general", label: "General" },
    { id: "audio", label: "Audio" },
    { id: "advanced", label: "Advanced" },
  ];

  it("preserves non-hidden items", () => {
    const result = items.flatMap(settingsMap);
    expect(result.find((i) => i.id === "general")).toBeTruthy();
    expect(result.find((i) => i.id === "audio")).toBeTruthy();
    expect(result.find((i) => i.id === "advanced")).toBeTruthy();
  });

  it("appends CloudFree item after the last item", () => {
    const result = items.flatMap(settingsMap);
    const last = result[result.length - 1];
    expect(last.id).toBe("cloudfree");
    expect(last.label).toBe("CloudFree");
    expect(last.group).toBe("CloudFree");
  });

  it("filters out 'account' section", () => {
    const withAccount = [
      { id: "general", label: "General" },
      { id: "account", label: "Account" },
      { id: "advanced", label: "Advanced" },
    ];
    const result = withAccount.flatMap(settingsMap);
    expect(result.find((i) => i.id === "account")).toBeUndefined();
  });

  it("filters out 'plansBilling' section", () => {
    const withBilling = [
      { id: "general", label: "General" },
      { id: "plansBilling", label: "Plans" },
      { id: "advanced", label: "Advanced" },
    ];
    const result = withBilling.flatMap(settingsMap);
    expect(result.find((i) => i.id === "plansBilling")).toBeUndefined();
  });

  it("filters multiple hidden sections at once", () => {
    const all = [
      { id: "general", label: "General" },
      { id: "account", label: "Account" },
      { id: "plansBilling", label: "Plans" },
      { id: "advanced", label: "Advanced" },
    ];
    const result = all.flatMap(settingsMap);
    const ids = result.map((i) => i.id);
    expect(ids).toEqual(["general", "advanced", "cloudfree"]);
  });

  it("handles single-item array", () => {
    const single = [{ id: "general", label: "General" }];
    const result = single.flatMap(settingsMap);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("general");
    expect(result[1].id).toBe("cloudfree");
  });

  it("handles array where last item is hidden", () => {
    const items = [
      { id: "general", label: "General" },
      { id: "account", label: "Account" },
    ];
    const result = items.flatMap(settingsMap);
    // "account" is hidden (returns []), so no CloudFree appended to it
    // "general" is not last (account is), so it's just [general]
    expect(result.map((i) => i.id)).toEqual(["general"]);
  });
});
