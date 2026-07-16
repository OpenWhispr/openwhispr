import { useEffect } from "react";
import { useSettingsStore } from "../stores/settingsStore";

export function useTheme() {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);

  useEffect(() => {
    const htmlElement = document.documentElement;

    // Determine effective theme
    const effectiveTheme: "light" | "dark" =
      theme === "auto"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : theme;

    // Apply dark class
    if (effectiveTheme === "dark") {
      htmlElement.classList.add("dark");
      document.body.classList.add("dark");
    } else {
      htmlElement.classList.remove("dark");
      document.body.classList.remove("dark");
    }

    // Listen for system preference changes (only when auto)
    if (theme === "auto") {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = (e: MediaQueryListEvent) => {
        if (e.matches) {
          htmlElement.classList.add("dark");
          document.body.classList.add("dark");
        } else {
          htmlElement.classList.remove("dark");
          document.body.classList.remove("dark");
        }
      };

      mediaQuery.addEventListener("change", handler);
      return () => mediaQuery.removeEventListener("change", handler);
    }
  }, [theme]);

  return { theme, setTheme };
}
