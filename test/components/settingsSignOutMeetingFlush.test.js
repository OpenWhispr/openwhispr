const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

// Signing out clears main's account scope the moment the token is cleared, so
// by the reload's beforeunload a signed-in account's note is out of reach and
// that flush writes nothing. Sign-out saves the live meeting transcript first.
// Exercise the actual Settings callback without loading unrelated settings panels.
const filename = path.join(__dirname, "../../src/components/SettingsPage.tsx");
const source = ts.createSourceFile(
  filename,
  fs.readFileSync(filename, "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);
let signOutCallback;
function visit(node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(source) === "handleSignOut" &&
    node.initializer &&
    ts.isCallExpression(node.initializer) &&
    node.initializer.expression.getText(source) === "useCallback"
  ) {
    signOutCallback = node.initializer.arguments[0].getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(signOutCallback, "Settings must expose its sign-out callback");

test("sign-out saves a live meeting transcript before the account scope is cleared", async () => {
  const calls = [];
  const context = {
    // Resolves on a later tick, so the order below also proves it is awaited.
    persistLiveTranscript: () =>
      new Promise((resolve) => {
        setTimeout(() => {
          calls.push("meeting transcript saved");
          resolve();
        }, 0);
      }),
    syncService: {
      purgeTeamSpacesForSignOut: async () => {
        calls.push("team spaces purged");
      },
    },
    signOut: async () => {
      calls.push("signed out");
    },
    window: { location: { reload: () => calls.push("reloaded") } },
    setIsSigningOut: () => {},
    logger: { error: (message) => calls.push(`error: ${message}`) },
    showAlertDialog: () => calls.push("alert"),
    t: (key) => key,
  };
  const { outputText } = ts.transpileModule(`const handleSignOut = ${signOutCallback};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  const handleSignOut = vm.runInNewContext(`${outputText}\nhandleSignOut;`, context);

  await handleSignOut();

  assert.deepEqual(calls, [
    "meeting transcript saved",
    "team spaces purged",
    "signed out",
    "reloaded",
  ]);
});
