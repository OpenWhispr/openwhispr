// Window creation tags the control panel with ?panel=true in both development
// and packaged builds; the dictation panel is the plain URL.
export const isControlPanelWindow = (): boolean => {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("panel") === "true";
};

export const isDictationPanelWindow = (): boolean =>
  typeof window !== "undefined" && !isControlPanelWindow();
