const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/toastPresentation.js");

test("destructive dictation notifications use the shared error surface", async () => {
  const { resolveToastPresentation } = await load();
  assert.equal(
    resolveToastPresentation({ variant: "destructive", isDictationPanel: true }),
    "dictation-error"
  );
});

test("non-error and control-panel notifications retain the standard toast", async () => {
  const { resolveToastPresentation } = await load();
  assert.equal(
    resolveToastPresentation({ variant: "default", isDictationPanel: true }),
    "standard"
  );
  assert.equal(
    resolveToastPresentation({ variant: "destructive", isDictationPanel: false }),
    "standard"
  );
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
