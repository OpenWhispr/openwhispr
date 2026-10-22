// Lets the app's main-process helpers load under plain Node, as the chain tests
// do (test/helpers/localReasoningBridgeChain.test.js): `require("electron")`
// returns a stub whose paths point at a throwaway userData folder, so the exam
// never writes into the real app's profile. Install before requiring helpers.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// The part of Electron's net.request the app's downloadUtils.js uses
// (setHeader, end, abort, "response" and "error"), on Node's http client.
// Electron follows redirects by itself, so this does too.
function netRequest({ url, method = "GET" }) {
  const request = new EventEmitter();
  const headers = {};
  let current = null;
  const send = (target, redirects) => {
    const client = target.startsWith("https:") ? https : http;
    current = client.request(target, { method, headers }, (response) => {
      const { location } = response.headers;
      if (location && response.statusCode >= 300 && response.statusCode < 400 && redirects < 10) {
        response.resume();
        send(new URL(location, target).href, redirects + 1);
        return;
      }
      request.emit("response", response);
    });
    current.on("error", (error) => request.emit("error", error));
    current.end();
  };
  request.setHeader = (name, value) => {
    headers[name] = value;
  };
  request.end = () => send(url, 0);
  request.abort = () => current?.destroy();
  return request;
}

let installedBase = null;

export function installElectronStub({ baseDir } = {}) {
  if (installedBase) return installedBase;
  const base = baseDir || fs.mkdtempSync(path.join(os.tmpdir(), "ow-local-exam-"));
  fs.mkdirSync(path.join(base, "userData"), { recursive: true });
  const originalLoad = Module._load;
  Module._load = function loadWithElectronStub(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: {
          isReady: () => true,
          isPackaged: false,
          getAppPath: () => REPO_ROOT,
          getVersion: () => "0.0.0-local-exam",
          getPath: (name) => (name === "home" ? os.homedir() : path.join(base, name)),
          on() {},
          once() {},
        },
        net: { request: netRequest, fetch },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  installedBase = base;
  return base;
}
