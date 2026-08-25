const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/toastPresentation.js");

test("destructive notifications stay standard toasts unless they opt into the error surface", async () => {
  const { resolveToastPresentation } = await load();
  assert.equal(
    resolveToastPresentation({ presentation: undefined, variant: "destructive", isDictationPanel: true }),
    "standard"
  );
  assert.equal(
    resolveToastPresentation({ presentation: "dictation-error", variant: "destructive", isDictationPanel: true }),
    "dictation-error"
  );
});

test("non-error and control-panel notifications retain the standard toast", async () => {
  const { resolveToastPresentation } = await load();
  assert.equal(resolveToastPresentation({ variant: "default", isDictationPanel: true }), "standard");
  assert.equal(resolveToastPresentation({ variant: "destructive", isDictationPanel: false }), "standard");
});

test("an explicit presentation remains authoritative", async () => {
  const { resolveToastPresentation } = await load();
  assert.equal(
    resolveToastPresentation({
      presentation: "standard",
      variant: "destructive",
      isDictationPanel: true,
    }),
    "standard"
  );
});

test("actionless shared errors still request the error-window footprint", async () => {
  const { getDictationErrorActionCount } = await load();
  assert.equal(getDictationErrorActionCount([]), 0);
  assert.equal(getDictationErrorActionCount([{ presentation: "dictation-error" }]), 1);
  assert.equal(
    getDictationErrorActionCount([
      { presentation: "dictation-error", actions: [{}, {}] },
      { presentation: "standard", actions: [] },
    ]),
    2
  );
});

test("short dictation errors dismiss after three seconds", async () => {
  const { getDictationErrorDuration } = await load();
  assert.equal(getDictationErrorDuration("Paste Error", "Please try again."), 3000);
});

test("medium dictation errors dismiss after four seconds", async () => {
  const { getDictationErrorDuration } = await load();
  assert.equal(getDictationErrorDuration("Error", "a".repeat(100)), 4000);
});

test("long dictation errors dismiss after five seconds", async () => {
  const { getDictationErrorDuration } = await load();
  assert.equal(getDictationErrorDuration("Error", "a".repeat(200)), 5000);
});
