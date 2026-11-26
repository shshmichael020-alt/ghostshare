"use client";

import { useCallback, useSyncExternalStore } from "react";
import { THEME_STORAGE_KEY, type Theme } from "./themeConstants";

export { THEME_STORAGE_KEY, type Theme } from "./themeConstants";

const THEME_CHANGE_EVENT = "ghostshare-theme-change";

export function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light") return "light";
  } catch {
    // Ignore storage access errors (e.g., restricted environments)
  }
  return "dark";
}

export function getDomTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("light") ? "light" : "dark";
}

export function applyTheme(theme: Theme): void {
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    if (theme === "light") {
      root.classList.remove("dark");
      root.classList.add("light");
      root.style.colorScheme = "light";
    } else {
      root.classList.remove("light");
      root.classList.add("dark");
      root.style.colorScheme = "dark";
    }
  }

  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Ignore storage quota/privacy mode errors
    }
    window.dispatchEvent(new CustomEvent<Theme>(THEME_CHANGE_EVENT, { detail: theme }));
  }
}

function subscribeTheme(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};

  const onCustomChange = () => callback();
  const onStorageChange = (e: StorageEvent) => {
    if (e.key === THEME_STORAGE_KEY) {
      const next: Theme = e.newValue === "light" ? "light" : "dark";
      if (typeof document !== "undefined") {
        const root = document.documentElement;
        root.classList.remove("dark", "light");
        root.classList.add(next);
        root.style.colorScheme = next;
      }
      callback();
    }
  };

  window.addEventListener(THEME_CHANGE_EVENT, onCustomChange);
  window.addEventListener("storage", onStorageChange);
  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, onCustomChange);
    window.removeEventListener("storage", onStorageChange);
  };
}

function getServerSnapshot(): Theme {
  return "dark";
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribeTheme, getDomTheme, getServerSnapshot);

  const setTheme = useCallback((next: Theme) => {
    applyTheme(next);
  }, []);

  const toggleTheme = useCallback(() => {
    const current = getDomTheme();
    applyTheme(current === "dark" ? "light" : "dark");
  }, []);

  return {
    theme,
    isDark: theme === "dark",
    isLight: theme === "light",
    setTheme,
    toggleTheme,
  };
}
