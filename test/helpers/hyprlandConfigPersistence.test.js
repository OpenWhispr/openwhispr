const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const load = Module._load;
let Manager;
Module._load = function (request, parent, isMain) {
  if (request === "child_process") {
    return {
      execFileSync() {
        throw new Error("Unexpected compositor command");
      },
    };
  }
  if (request === "./debugLogger") return { log() {} };
  return load.call(this, request, parent, isMain);
};
try {
  Manager = require("../../src/helpers/hyprlandShortcut");
} finally {
  Module._load = load;
}

function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hyprland-config-test-"));
  const config = {
    path: path.join(dir, "hyprland.lua"),
    bindsPath: path.join(dir, "openwhispr-binds.lua"),
    format: "lua",
  };
  try {
    return fn(new Manager(), config, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const [name, loader] of [
  ["pcall whitespace", (p) => `  pcall ( require , ${JSON.stringify(p)} ) -- managed load`],
  ["pcall without space", (p) => `pcall(require,${JSON.stringify(p)})`],
  ["require", (p) => `require ( '${p}' )`],
  ["dofile", (p) => `dofile ( ${JSON.stringify(p)} );`],
  ["pcall dofile", (p) => `pcall ( dofile, '${p}' )`],
  ["require without parentheses", (p) => `require '${p}'`],
  ["multiline pcall", (p) => `pcall(\n  require, -- loader\n  ${JSON.stringify(p)}\n)`],
  ["multiline dofile", (p) => `dofile(\n  '${p}'\n)`],
]) {
  test(`keeps an existing ${name} loader byte- and inode-identical`, () =>
    fixture((manager, config) => {
      const content = `-- user config\n${loader(config.bindsPath)}\nreturn {}\n`;
      fs.writeFileSync(config.path, content);
      const before = fs.statSync(config.path);
      assert.equal(manager._ensureSourceInMainConfig(config), true);
      assert.equal(fs.readFileSync(config.path, "utf8"), content);
      assert.equal(fs.statSync(config.path).ino, before.ino);
      assert.equal(fs.statSync(config.path).mtimeMs, before.mtimeMs);
    }));
}

test("replaces the main config atomically through a symlink, preserving its target mode", () =>
  fixture((manager, config, dir) => {
    const target = path.join(dir, "chezmoi-source.lua");
    const original = "-- keep user settings\nreturn {}\n";
    fs.writeFileSync(target, original, { mode: 0o640 });
    const realTarget = fs.realpathSync(target);
    fs.symlinkSync(target, config.path);
    let replacements = 0;
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to === realTarget) {
        replacements++;
        assert.equal(fs.readFileSync(target, "utf8"), original);
        assert.match(fs.readFileSync(from, "utf8"), /pcall\(require,/);
      }
      return rename(from, to);
    };
    try {
      assert.equal(manager._ensureSourceInMainConfig(config), true);
    } finally {
      fs.renameSync = rename;
    }
    assert.equal(replacements, 1);
    assert.equal(fs.lstatSync(config.path).isSymbolicLink(), true);
    assert.equal(fs.statSync(target).mode & 0o777, 0o640);
    assert.equal(fs.readFileSync(target, "utf8").includes(original.split("\n")[0]), true);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["chezmoi-source.lua", "hyprland.lua"]);
  }));

for (const [name, content] of [
  ["line comment", (p) => `-- require("${p}")\n`],
  ["long comment", (p) => `--[=[\nrequire("${p}")\n]=]\n`],
  ["long string", (p) => `local example = [[\nrequire("${p}")\n]]\n`],
  ["conditional", (p) => `if false then\nrequire("${p}")\nend\n`],
  ["function body", (p) => `local function unused()\nrequire("${p}")\nend\n`],
]) {
  test(`does not treat a ${name} as an active top-level loader`, () =>
    fixture((manager, config) => {
      fs.writeFileSync(config.path, content(config.bindsPath));
      assert.equal(manager._ensureSourceInMainConfig(config), true);
      assert.match(fs.readFileSync(config.path, "utf8"), /pcall\(require,/);
    }));
}

for (const [name, expression] of [
  ["table", (loader) => `false and {\n  ${loader}\n}`],
  ["parenthesized expression", (loader) => `false and (\n  ${loader}\n)`],
  ["call argument", (loader) => `false and tostring(\n  ${loader}\n)`],
]) {
  test(`adds an unconditional loader without damaging a skipped ${name}`, () =>
    fixture((manager, config) => {
      const loader = `pcall(require, ${JSON.stringify(config.bindsPath)})`;
      const prefix = `local optional = ${expression(loader)}\n`;
      fs.writeFileSync(config.path, `${prefix}return {}\n`);

      assert.equal(manager._ensureSourceInMainConfig(config), true);
      assert.equal(fs.readFileSync(config.path, "utf8"), `${prefix}${loader}\nreturn {}\n`);
      const before = fs.statSync(config.path);
      assert.equal(manager._ensureSourceInMainConfig(config), true);
      assert.equal(fs.statSync(config.path).ino, before.ino);
    }));
}

test("failed atomic replacement leaves the original target and symlink intact", () =>
  fixture((manager, config, dir) => {
    const target = path.join(dir, "source.lua");
    fs.writeFileSync(target, "-- unchanged\n", { mode: 0o600 });
    fs.symlinkSync(target, config.path);
    const rename = fs.renameSync;
    fs.renameSync = () => {
      throw new Error("synthetic rename failure");
    };
    try {
      assert.throws(() => manager._ensureSourceInMainConfig(config), /synthetic rename failure/);
    } finally {
      fs.renameSync = rename;
    }
    assert.equal(fs.readFileSync(target, "utf8"), "-- unchanged\n");
    assert.equal(fs.lstatSync(config.path).isSymbolicLink(), true);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["hyprland.lua", "source.lua"]);
  }));

test("does not replace a dangling config symlink", () =>
  fixture((manager, config, dir) => {
    fs.symlinkSync(path.join(dir, "missing.lua"), config.path);
    assert.equal(manager._ensureSourceInMainConfig(config), false);
    assert.equal(fs.lstatSync(config.path).isSymbolicLink(), true);
  }));

test("does not break a hard-linked config when a load directive is missing", () =>
  fixture((manager, config, dir) => {
    fs.writeFileSync(config.path, "-- shared inode\n");
    const alias = path.join(dir, "hardlink.lua");
    fs.linkSync(config.path, alias);
    assert.throws(() => manager._ensureSourceInMainConfig(config), /hard-linked/);
    assert.equal(fs.statSync(config.path).ino, fs.statSync(alias).ino);
    assert.equal(fs.readFileSync(config.path, "utf8"), "-- shared inode\n");
  }));

test("repeating persistence leaves both an existing loader and unchanged managed binds untouched", () =>
  fixture((manager, config, dir) => {
    fs.writeFileSync(config.path, `pcall(require,${JSON.stringify(config.bindsPath)})\n`);
    const target = path.join(dir, "managed.lua");
    fs.writeFileSync(target, "-- user bind comment\n", { mode: 0o640 });
    fs.symlinkSync(target, config.bindsPath);
    manager._persistBinds(config, {});
    const main = fs.statSync(config.path);
    const binds = fs.statSync(target);
    manager._persistBinds(config, {});
    assert.equal(fs.statSync(config.path).ino, main.ino);
    assert.equal(fs.statSync(config.path).mtimeMs, main.mtimeMs);
    assert.equal(fs.statSync(target).ino, binds.ino);
    assert.equal(fs.statSync(target).mtimeMs, binds.mtimeMs);
    assert.equal(fs.statSync(target).mode & 0o777, 0o640);
    assert.equal(fs.lstatSync(config.bindsPath).isSymbolicLink(), true);
  }));
