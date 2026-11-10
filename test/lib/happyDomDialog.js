// Shared setup for tests that mount a dialog with the real Radix primitives in happy-dom, so
// closing, Escape and stacked dialogs behave as they do on screen. The services and stores are
// fakes the test steers; strings come from the English file, so a missing key shows up as a
// missing label.
const assert = require("node:assert/strict");
const React = require("react");

const DOM_GLOBALS = [
  "document",
  "navigator",
  "Node",
  "NodeFilter",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "MutationObserver",
  "getComputedStyle",
  "KeyboardEvent",
  "MouseEvent",
  "PointerEvent",
  "FocusEvent",
  "Event",
  "CustomEvent",
  "ResizeObserver",
  "DOMRect",
];

// A react-i18next stand-in over the real English file, with plural forms and interpolation.
const ENGLISH_I18N_MOCK = `
  import en from "/locales/en/translation.json";
  const lookup = (key) => key.split(".").reduce((value, part) => value?.[part], en);
  const t = (key, values = {}) => {
    let text = lookup(key);
    if (text === undefined && typeof values.count === "number") {
      text = lookup(key + "_" + new Intl.PluralRules("en").select(values.count));
    }
    if (typeof text !== "string") return key;
    return text.replace(/{{\\s*(\\w+)\\s*}}/g, (_, name) => String(values[name] ?? ""));
  };
  export const useTranslation = () => ({ t, i18n: { language: "en" } });
`;

/** Installs a happy-dom window as the globals React DOM and Radix read. */
async function installHappyDom() {
  const { Window } = await import("happy-dom");
  const happyWindow = new Window();
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  define("window", happyWindow);
  for (const name of DOM_GLOBALS) define(name, happyWindow[name]);
  for (const name of ["requestAnimationFrame", "cancelAnimationFrame"]) {
    define(name, happyWindow[name].bind(happyWindow));
  }
  define("IS_REACT_ACT_ENVIRONMENT", true);
  // React DOM decides at load time whether the DOM supports input events.
  const { createRoot } = require("react-dom/client");
  return { happyWindow, createRoot };
}

// The text a person reads: aria-hidden decoration is left out, neighbouring elements are one
// space apart, and the bidi isolates that wrap names inside sentences are dropped.
const readable = (value) => value.replace(/[⁨⁩]/g, "").replace(/\s+/g, " ").trim();

function text(node) {
  const parts = [];
  const walk = (current) => {
    if (current.nodeType === 3) parts.push(current.nodeValue);
    else if (current.getAttribute?.("aria-hidden") !== "true")
      [...current.childNodes].forEach(walk);
  };
  walk(node);
  return readable(parts.join(" "));
}

/** The interaction helpers for one happy-dom window. */
function interactions(happyWindow) {
  const act = (fn) => React.act(async () => fn());
  const click = (element) => {
    assert.ok(element, "the control exists");
    return act(() =>
      element.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true, detail: 1 }))
    );
  };
  // Radix tabs activate on mousedown, not click.
  const pressTab = (element) => {
    assert.ok(element, "the tab exists");
    return act(() =>
      element.dispatchEvent(
        new happyWindow.MouseEvent("mousedown", { bubbles: true, button: 0, ctrlKey: false })
      )
    );
  };
  const setValue = (element, value, prototype) =>
    act(() => {
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
      element.dispatchEvent(new happyWindow.Event("input", { bubbles: true }));
    });
  const type = (element, value) => setValue(element, value, happyWindow.HTMLInputElement.prototype);
  const typeText = (element, value) =>
    setValue(element, value, happyWindow.HTMLTextAreaElement.prototype);
  const press = (element, key) =>
    act(() =>
      element.dispatchEvent(
        new happyWindow.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
      )
    );
  const focus = (element) => act(() => element.focus());
  const blur = (element) =>
    act(() => {
      element.dispatchEvent(
        new happyWindow.FocusEvent("focusout", { bubbles: true, relatedTarget: null })
      );
    });
  // Lets the promises a click starts (the service calls and what follows them) run to the end.
  const settle = () =>
    React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  return { act, click, pressTab, type, typeText, press, focus, blur, settle };
}

module.exports = { ENGLISH_I18N_MOCK, installHappyDom, interactions, readable, text };
