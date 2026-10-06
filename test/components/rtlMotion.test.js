const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.join(__dirname, "../..");
const source = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

test("standard toasts enter from the outer edge in both document directions", () => {
  const toast = source("src/components/ui/Toast.tsx");
  const css = source("src/index.css");

  assert.match(toast, /toast-enter opacity-100 translate-x-0 scale-100/);
  assert.doesNotMatch(toast, /animate-in|slide-in-from-/);
  assert.match(css, /\.toast-enter\s*\{[\s\S]*?--toast-enter-x: 1rem;/);
  assert.match(css, /\[dir="rtl"\] \.toast-enter\s*\{[\s\S]*?--toast-enter-x: -1rem;/);
  assert.match(css, /@keyframes toast-enter[\s\S]*?translateX\(var\(--toast-enter-x\)\)/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*?\.toast-enter[\s\S]*?animation: none/);
});
