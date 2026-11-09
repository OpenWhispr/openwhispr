const hasRouteFlag = (name: string): boolean =>
  typeof window !== "undefined" && new URLSearchParams(window.location.search).get(name) === "true";

// Window creation tags the control panel with ?panel=true and the agent window
// with ?agent=true, in development and packaged builds alike; the dictation
// panel is the plain URL.
export const isControlPanelWindow = (): boolean => hasRouteFlag("panel");

export const isAgentWindow = (): boolean => hasRouteFlag("agent");

export const isDictationPanelWindow = (): boolean =>
  typeof window !== "undefined" && !isControlPanelWindow() && !isAgentWindow();
