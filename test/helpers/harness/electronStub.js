const Module = require("node:module");

// DatabaseManager requires electron at load time, which is unloadable under plain
// node, so the module loader hands it a stub whose userData path tests repoint.
let userDataDir = process.cwd();
let patched = false;

function installElectronStub() {
  if (patched) return;
  patched = true;
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: {
          getPath: () => userDataDir,
          getAppPath: () => process.cwd(),
          isReady: () => false,
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
}

// Must be set before DatabaseManager loads: it picks the dev database filename
// from NODE_ENV.
process.env.NODE_ENV = "test";

function setUserDataDir(dir) {
  if (typeof dir !== "string" || dir.length === 0) {
    throw new TypeError("setUserDataDir requires a non-empty path");
  }
  userDataDir = dir;
}

function getUserDataDir() {
  return userDataDir;
}

module.exports = { installElectronStub, setUserDataDir, getUserDataDir };
