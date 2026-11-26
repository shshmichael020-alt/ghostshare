import test from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import vm from "node:vm";
import { THEME_INIT_SCRIPT, THEME_STORAGE_KEY } from "../lib/themeConstants";
import { applyTheme, readStoredTheme } from "../lib/theme";

function createMockDom(initialStored?: string) {
  const classes = new Set<string>(["dark"]);
  const style: Record<string, string> = {};
  const storageMap = new Map<string, string>();
  if (initialStored !== undefined) {
    storageMap.set(THEME_STORAGE_KEY, initialStored);
  }
  const listeners = new Map<string, Set<(ev: Event) => void>>();

  const mockDocument = {
    documentElement: {
      classList: {
        add: (...items: string[]) => items.forEach((i) => classes.add(i)),
        remove: (...items: string[]) => items.forEach((i) => classes.delete(i)),
        contains: (item: string) => classes.has(item),
      },
      style,
    },
  };

  const mockStorage = {
    getItem: (key: string) => storageMap.get(key) ?? null,
    setItem: (key: string, val: string) => {
      storageMap.set(key, val);
    },
  };

  const mockWindow = {
    localStorage: mockStorage,
    addEventListener: (type: string, fn: (ev: Event) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: (ev: Event) => void) => {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent: (ev: Event) => {
      listeners.get(ev.type)?.forEach((fn) => fn(ev));
      return true;
    },
  };

  return { classes, style, storageMap, mockDocument, mockStorage, mockWindow };
}

test("Theme Init Script: defaults to dark for first-time visitors without flash", () => {
  const { classes, style, mockDocument, mockStorage } = createMockDom(undefined);
  vm.runInNewContext(THEME_INIT_SCRIPT, {
    document: mockDocument,
    localStorage: mockStorage,
  });

  assert.strictEqual(classes.has("dark"), true);
  assert.strictEqual(classes.has("light"), false);
  assert.strictEqual(style.colorScheme, "dark");
});

test("Theme Init Script: restores light theme immediately when stored in localStorage", () => {
  const { classes, style, mockDocument, mockStorage } = createMockDom("light");
  vm.runInNewContext(THEME_INIT_SCRIPT, {
    document: mockDocument,
    localStorage: mockStorage,
  });

  assert.strictEqual(classes.has("light"), true);
  assert.strictEqual(classes.has("dark"), false);
  assert.strictEqual(style.colorScheme, "light");
});

test("Theme Init Script: degrades gracefully when localStorage throws", () => {
  const { classes, mockDocument } = createMockDom(undefined);
  const throwingStorage = {
    getItem: () => {
      throw new Error("SecurityError");
    },
  };

  assert.doesNotThrow(() => {
    vm.runInNewContext(THEME_INIT_SCRIPT, {
      document: mockDocument,
      localStorage: throwingStorage,
    });
  });
  assert.strictEqual(classes.has("dark"), true);
});

test("Theme Toggle & Persistence: switches between dark and light and persists in localStorage", () => {
  const origWindow = (globalThis as unknown as Record<string, unknown>).window;
  const origDocument = (globalThis as unknown as Record<string, unknown>).document;

  const { classes, style, storageMap, mockDocument, mockWindow } = createMockDom(undefined);
  (globalThis as unknown as Record<string, unknown>).window = mockWindow;
  (globalThis as unknown as Record<string, unknown>).document = mockDocument;

  try {
    assert.strictEqual(readStoredTheme(), "dark");

    applyTheme("light");
    assert.strictEqual(storageMap.get(THEME_STORAGE_KEY), "light");
    assert.strictEqual(classes.has("light"), true);
    assert.strictEqual(classes.has("dark"), false);
    assert.strictEqual(style.colorScheme, "light");
    assert.strictEqual(readStoredTheme(), "light");

    applyTheme("dark");
    assert.strictEqual(storageMap.get(THEME_STORAGE_KEY), "dark");
    assert.strictEqual(classes.has("dark"), true);
    assert.strictEqual(classes.has("light"), false);
    assert.strictEqual(style.colorScheme, "dark");
    assert.strictEqual(readStoredTheme(), "dark");
  } finally {
    (globalThis as unknown as Record<string, unknown>).window = origWindow;
    (globalThis as unknown as Record<string, unknown>).document = origDocument;
  }
});

test("CSS Theme Tokens: globals.css defines complete dark and light CSS variables", () => {
  const cssPath = path.join(process.cwd(), "app", "globals.css");
  const css = fs.readFileSync(cssPath, "utf8");

  assert.ok(css.includes("html.dark"), "globals.css must define html.dark");
  assert.ok(css.includes("html.light"), "globals.css must define html.light");

  const requiredTokens = [
    "--color-canvas-default",
    "--color-surface",
    "--color-surface-container-lowest",
    "--color-surface-container-low",
    "--color-surface-container",
    "--color-surface-container-high",
    "--color-surface-container-highest",
    "--color-on-surface",
    "--color-on-surface-variant",
    "--color-primary",
    "--color-secondary",
    "--color-tertiary",
    "--color-error",
    "--color-border-subtle",
    "--color-border-default",
    "--color-border-strong",
    "--color-surface-hover",
    "--color-warning",
    "--color-success",
    "--color-backdrop",
  ];

  const lightSection = css.slice(css.indexOf("html.light"));
  for (const token of requiredTokens) {
    assert.ok(css.includes(token), `Missing @theme token: ${token}`);
    assert.ok(lightSection.includes(token), `Missing light mode override for token: ${token}`);
  }
});
