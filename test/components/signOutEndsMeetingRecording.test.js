const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

// Signing out clears main's account scope the moment the token is cleared, so
// a live meeting's note is out of reach from then on: neither its later saves
// nor the reload's beforeunload flush can write it. Settings' Sign out and the
// invitation's account switch end the meeting first, and the stop writes the
// final transcript. (Account deletion deletes the note, so it has nothing to save.)
// Exercise the actual callbacks without loading their components.
function extractFunction(relativePath, name) {
  const filename = path.join(__dirname, relativePath);
  const source = ts.createSourceFile(
    filename,
    fs.readFileSync(filename, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  let code;
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === name &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.expression.getText(source) === "useCallback"
    ) {
      code = `const ${name} = ${node.initializer.arguments[0].getText(source)};`;
    } else if (ts.isFunctionDeclaration(node) && node.name?.getText(source) === name) {
      code = node.getText(source);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(code, `${relativePath} must define ${name}`);
  return ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
    .outputText;
}

function createContext(calls) {
  return {
    // Resolves on a later tick, so the order below also proves it is awaited.
    stopRecording: () =>
      new Promise((resolve) => {
        setTimeout(() => {
          calls.push("meeting stopped");
          resolve({ diarizationSessionId: null, stopped: true });
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
    token: "invite-token",
    storePendingInvitationToken: () => calls.push("invitation kept"),
  };
}

test("Settings sign-out ends a live meeting before the account scope is cleared", async () => {
  const calls = [];
  const handleSignOut = vm.runInNewContext(
    `${extractFunction("../../src/components/SettingsPage.tsx", "handleSignOut")}\nhandleSignOut;`,
    createContext(calls)
  );

  await handleSignOut();

  assert.deepEqual(calls, ["meeting stopped", "team spaces purged", "signed out", "reloaded"]);
});

test("switching account from an invitation ends a live meeting before signing out", async () => {
  const calls = [];
  const handleSwitchAccount = vm.runInNewContext(
    `${extractFunction(
      "../../src/components/AcceptInvitationModal.tsx",
      "handleSwitchAccount"
    )}\nhandleSwitchAccount;`,
    createContext(calls)
  );

  await handleSwitchAccount();

  assert.deepEqual(calls, [
    "invitation kept",
    "meeting stopped",
    "team spaces purged",
    "signed out",
  ]);
});
