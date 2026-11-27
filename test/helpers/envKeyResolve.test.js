const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isEnvRef,
  envRefName,
  resolveEnvRef,
  parseShellEnvDump,
  buildShellImportScript,
  isTrustedLoginShell,
  resolveLoginShell,
  coalesceResolvedSecret,
  usableSecret,
  classifySecretInput,
  ENV_EXPORT_SENTINEL,
  importMissingSecretsFromLoginShell,
} = require("../../src/helpers/envKeyResolve");

// What the import script prints: rc noise, the sentinel, then NAME=value\0 records.
function envDump(values, { noise = "", tail = "" } = {}) {
  const records = Object.entries(values)
    .map(([name, value]) => `${name}=${value}\0`)
    .join("");
  return `${noise}${ENV_EXPORT_SENTINEL}\n${records}${tail}`;
}

test("detects $VAR and ${VAR} references", () => {
  assert.equal(isEnvRef("$OPENAI_API_KEY"), true);
  assert.equal(isEnvRef(" ${OPENAI_API_KEY} "), true);
  assert.equal(isEnvRef("sk-abc"), false);
  assert.equal(isEnvRef("$1INVALID"), false);
  assert.equal(isEnvRef(""), false);
  assert.equal(envRefName("$OPENAI_API_KEY"), "OPENAI_API_KEY");
  assert.equal(envRefName("${CUSTOM_TRANSCRIPTION_API_KEY}"), "CUSTOM_TRANSCRIPTION_API_KEY");
});

test("resolves a single env-ref hop and leaves literals alone", () => {
  const env = { OPENAI_API_KEY: "sk-from-shell", EMPTY: "" };
  assert.equal(resolveEnvRef("$OPENAI_API_KEY", env), "sk-from-shell");
  assert.equal(resolveEnvRef("${OPENAI_API_KEY}", env), "sk-from-shell");
  assert.equal(resolveEnvRef("sk-hardcoded", env), "sk-hardcoded");
  assert.equal(resolveEnvRef("$MISSING", env), "");
  assert.equal(resolveEnvRef("$EMPTY", env), "");
});

test("does not recursively expand a resolved value", () => {
  const env = { OUTER: "$INNER", INNER: "secret" };
  assert.equal(resolveEnvRef("$OUTER", env), "$INNER");
});

test("reads NAME=value records exactly, whatever the value holds", () => {
  const parsed = parseShellEnvDump(
    envDump(
      {
        OPENAI_API_KEY: "sk-openai",
        GROQ_API_KEY: "it's a 'quoted' \"key\" # not a comment",
        CUSTOM_TRANSCRIPTION_API_KEY: "a=b=c",
        MULTI: "line1\nline2",
        EMPTY: "",
      },
      { noise: "Powerlevel10k FOO=bar\n", tail: "logout noise BAR=baz" }
    )
  );
  assert.equal(parsed.OPENAI_API_KEY, "sk-openai");
  assert.equal(parsed.GROQ_API_KEY, "it's a 'quoted' \"key\" # not a comment");
  assert.equal(parsed.CUSTOM_TRANSCRIPTION_API_KEY, "a=b=c");
  assert.equal(parsed.MULTI, "line1\nline2");
  assert.equal(parsed.EMPTY, "");
  assert.equal(parsed.FOO, undefined);
  assert.equal(parsed.BAR, undefined);
});

test("the import script asks only for allowlisted names and reads ~/.bashrc for bash", () => {
  const bash = buildShellImportScript("/bin/bash", ["OPENAI_API_KEY", "x; rm -rf ~", "GROQ_API_KEY"]);
  assert.match(bash, /\.bashrc/);
  assert.match(bash, /for __ow_n in OPENAI_API_KEY GROQ_API_KEY;/);
  assert.equal(bash.includes("rm -rf"), false);
  assert.equal(buildShellImportScript("/usr/bin/zsh", ["OPENAI_API_KEY"]).includes(".bashrc"), false);
});

test("trusted shells are exact system paths, not basenames", () => {
  assert.equal(isTrustedLoginShell("/bin/zsh"), true);
  assert.equal(isTrustedLoginShell("/usr/bin/bash"), true);
  assert.equal(isTrustedLoginShell("/tmp/zsh"), false);
  assert.equal(isTrustedLoginShell("/tmp/evil"), false);
});

test("login-shell import fills only missing secret names", async () => {
  const env = {
    SHELL: "/bin/zsh",
    OPENAI_API_KEY: "already-set",
  };
  const execFileSync = (file, args) => {
    assert.equal(args[0], "-ilc");
    return envDump({
      OPENAI_API_KEY: "from-zsh-should-lose",
      GROQ_API_KEY: "from-zsh",
      UNRELATED: "nope",
    });
  };

  const { imported, reason } = await importMissingSecretsFromLoginShell({
    secretNames: ["OPENAI_API_KEY", "GROQ_API_KEY", "CUSTOM_TRANSCRIPTION_API_KEY"],
    env,
    platform: "linux",
    execFileSync,
    existsSync: (p) => p === "/bin/zsh",
  });

  assert.equal(reason, "ok");
  assert.deepEqual(imported, ["GROQ_API_KEY"]);
  assert.equal(env.OPENAI_API_KEY, "already-set");
  assert.equal(env.GROQ_API_KEY, "from-zsh");
  assert.equal(env.CUSTOM_TRANSCRIPTION_API_KEY, undefined);
  assert.equal(env.UNRELATED, undefined);
});

test("login-shell import does not execute /tmp/zsh", async () => {
  const called = [];
  const env = { SHELL: "/tmp/zsh" };
  const { imported, reason } = await importMissingSecretsFromLoginShell({
    secretNames: ["OPENAI_API_KEY"],
    env,
    platform: "linux",
    existsSync: (p) => p === "/tmp/zsh" || p === "/bin/bash",
    execFileSync: (file) => {
      called.push(file);
      return "export OPENAI_API_KEY='from-bash'\n";
    },
  });
  assert.deepEqual(called, []);
  assert.equal(reason, "no-trusted-shell");
  assert.deepEqual(imported, []);
  assert.equal(env.OPENAI_API_KEY, undefined);
});

test("login-shell child env does not receive app secrets", async () => {
  let childEnv;
  const env = {
    SHELL: "/bin/zsh",
    HOME: "/home/u",
    PATH: "/bin",
    USER: "u",
    OPENAI_API_KEY: "sk-should-not-leak",
    ANTHROPIC_API_KEY: "sk-nope",
  };
  await importMissingSecretsFromLoginShell({
    secretNames: ["GROQ_API_KEY"],
    env,
    platform: "linux",
    existsSync: (p) => p === "/bin/zsh",
    execFileSync: (_file, _args, opts) => {
      childEnv = opts.env;
      return envDump({ GROQ_API_KEY: "gsk" });
    },
  });
  assert.equal(childEnv.OPENAI_API_KEY, undefined);
  assert.equal(childEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(childEnv.HOME, "/home/u");
  assert.equal(childEnv.SHELL, "/bin/zsh");
  assert.equal(childEnv.TERM, "dumb");
});

test("coalesceResolvedSecret never emits an unexpanded ref", () => {
  assert.equal(coalesceResolvedSecret("$OPENAI_API_KEY", ""), "");
  assert.equal(coalesceResolvedSecret("$OPENAI_API_KEY", "sk-live"), "sk-live");
  assert.equal(coalesceResolvedSecret("$OPENAI_API_KEY", "$OPENAI_API_KEY"), "");
  assert.equal(coalesceResolvedSecret("$OPENAI_API_KEY", undefined), "");
  assert.equal(coalesceResolvedSecret("sk-hardcoded", undefined), "sk-hardcoded");
});

test("login-shell import skips when no trusted shell exists", async () => {
  const { imported, reason } = await importMissingSecretsFromLoginShell({
    secretNames: ["OPENAI_API_KEY"],
    env: { SHELL: "/tmp/zsh" },
    platform: "linux",
    existsSync: () => false,
    execFileSync: () => {
      throw new Error("should not run");
    },
  });
  assert.equal(reason, "no-trusted-shell");
  assert.deepEqual(imported, []);
});

test("resolveLoginShell uses SHELL when trusted, else passwd, and does not probe zsh", () => {
  assert.equal(
    resolveLoginShell({ SHELL: "/usr/bin/bash" }, (p) => p === "/usr/bin/bash", ""),
    "/usr/bin/bash"
  );
  assert.equal(resolveLoginShell({ SHELL: "/tmp/zsh" }, (p) => p === "/bin/bash", "/bin/bash"), null);
  assert.equal(resolveLoginShell({}, (p) => p === "/bin/bash", "/bin/bash"), "/bin/bash");
  assert.equal(resolveLoginShell({}, (p) => p === "/bin/zsh", ""), null);
  assert.equal(resolveLoginShell({}, () => false, ""), null);
});

test("login-shell import records names before mutating env", async () => {
  const env = { SHELL: "/bin/zsh" };
  const importedSet = new Set();
  await importMissingSecretsFromLoginShell({
    secretNames: ["GROQ_API_KEY"],
    env,
    platform: "linux",
    importedSet,
    existsSync: (p) => p === "/bin/zsh",
    execFileSync: () => envDump({ GROQ_API_KEY: "gsk" }),
  });
  assert.equal(importedSet.has("GROQ_API_KEY"), true);
  assert.equal(env.GROQ_API_KEY, "gsk");
});

test("login-shell import async execFile path parses sentinel output", async () => {
  const env = { SHELL: "/bin/zsh" };
  const { imported, reason } = await importMissingSecretsFromLoginShell({
    secretNames: ["GROQ_API_KEY"],
    env,
    platform: "linux",
    existsSync: (p) => p === "/bin/zsh",
    execFile: async () => ({ stdout: envDump({ GROQ_API_KEY: "gsk" }) }),
  });
  assert.equal(reason, "ok");
  assert.deepEqual(imported, ["GROQ_API_KEY"]);
  assert.equal(env.GROQ_API_KEY, "gsk");
});

test("login-shell import is a no-op on Windows and on exec failure", async () => {
  const env = {};
  assert.deepEqual(
    await importMissingSecretsFromLoginShell({
      secretNames: ["OPENAI_API_KEY"],
      env,
      platform: "win32",
      execFileSync: () => {
        throw new Error("should not run");
      },
    }),
    { imported: [], reason: "win32" }
  );
  assert.deepEqual(
    await importMissingSecretsFromLoginShell({
      secretNames: ["OPENAI_API_KEY"],
      env: { SHELL: "/bin/zsh" },
      platform: "linux",
      existsSync: (p) => p === "/bin/zsh",
      execFileSync: () => {
        throw new Error("zsh hung");
      },
    }),
    { imported: [], reason: "exec-failed" }
  );
});

test("usableSecret never returns a leftover $VAR", () => {
  assert.equal(usableSecret("$OPENAI_API_KEY"), "");
  assert.equal(usableSecret("${GROQ_API_KEY}"), "");
  assert.equal(usableSecret("sk-live"), "sk-live");
  assert.equal(usableSecret(""), "");
});

test("classifySecretInput rejects self-refs and unknown names", () => {
  const allowed = new Set(["OPENAI_API_KEY", "GROQ_API_KEY"]);
  assert.equal(classifySecretInput("$OPENAI_API_KEY", "OPENAI_API_KEY", allowed), "self-reference");
  assert.equal(classifySecretInput("$PATH", "OPENAI_API_KEY", allowed), "unknown-ref");
  assert.equal(classifySecretInput("$GROQ_API_KEY", "OPENAI_API_KEY", allowed), null);
  assert.equal(classifySecretInput("sk-live", "OPENAI_API_KEY", allowed), null);
});

test("chat-agent and scope custom refs are not usable as Authorization secrets", () => {
  assert.equal(usableSecret("$CHAT_AGENT_CUSTOM_API_KEY"), "");
  assert.equal(usableSecret("$NOTE_FORMATTING_CUSTOM_API_KEY"), "");
  assert.equal(usableSecret("$TRANSLATION_CUSTOM_API_KEY"), "");
  assert.equal(usableSecret("$DICTATION_AGENT_CUSTOM_API_KEY"), "");
  assert.equal(usableSecret("sk-chat"), "sk-chat");
});

test("resolved env ref is a usable Authorization secret, leftover $VAR is not", () => {
  const resolved = resolveEnvRef("$OPENAI_API_KEY", { OPENAI_API_KEY: "sk-live" });
  assert.equal(usableSecret(resolved), "sk-live");
  assert.equal(usableSecret("$OPENAI_API_KEY"), "");
});

test("envRef.ts and envRef.cjs share the same ENV_REF_RE", () => {
  const fs = require("fs");
  const path = require("path");
  const ts = fs.readFileSync(path.join(__dirname, "../../src/helpers/envRef.ts"), "utf8");
  const cjs = fs.readFileSync(path.join(__dirname, "../../src/helpers/envRef.cjs"), "utf8");
  const re = /ENV_REF_RE = (\/.+\/);/;
  assert.equal(ts.match(re)[1], cjs.match(re)[1]);
});

test("a key saved while the shell runs is never overwritten by the import", async () => {
  const env = { SHELL: "/bin/zsh" };
  const importedSet = new Set();
  let release;
  const shellDone = new Promise((resolve) => (release = resolve));
  const pending = importMissingSecretsFromLoginShell({
    secretNames: ["GROQ_API_KEY", "OPENAI_API_KEY"],
    env,
    platform: "linux",
    importedSet,
    existsSync: (p) => p === "/bin/zsh",
    execFile: async () => {
      await shellDone;
      return { stdout: envDump({ GROQ_API_KEY: "from-shell", OPENAI_API_KEY: "from-shell" }) };
    },
  });
  env.GROQ_API_KEY = "saved-in-settings"; // a Settings save while the shell runs
  release();
  const { imported } = await pending;
  assert.deepEqual(imported, ["OPENAI_API_KEY"]);
  assert.equal(env.GROQ_API_KEY, "saved-in-settings");
  assert.equal(importedSet.has("GROQ_API_KEY"), false);
});

test("canImport decides each name after the shell answers", async () => {
  const env = { SHELL: "/bin/zsh" };
  const { imported } = await importMissingSecretsFromLoginShell({
    secretNames: ["GROQ_API_KEY", "OPENAI_API_KEY"],
    env,
    platform: "linux",
    existsSync: (p) => p === "/bin/zsh",
    canImport: (name) => name !== "GROQ_API_KEY",
    execFileSync: () => envDump({ GROQ_API_KEY: "a", OPENAI_API_KEY: "b" }),
  });
  assert.deepEqual(imported, ["OPENAI_API_KEY"]);
  assert.equal(env.GROQ_API_KEY, undefined);
});

// Real shells against a throwaway HOME holding fake exports, so nothing from the
// developer's own rc files or environment is read.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function importFromRealShell(shell, files, names, { environment, checkHome } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ow-shell-import-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(home, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    const env = {
      SHELL: shell,
      HOME: home,
      PATH: "/usr/bin:/bin",
      USER: "ow-test",
      ...environment?.(home),
    };
    const result = await importMissingSecretsFromLoginShell({
      secretNames: names,
      env,
      platform: "linux",
    });
    checkHome?.(home);
    return { ...result, env };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test(
  "real login bash imports an export that only ~/.bashrc makes",
  { skip: !fs.existsSync("/bin/bash") && "bash not installed" },
  async () => {
    const { imported, env } = await importFromRealShell(
      "/bin/bash",
      {
        // Ubuntu's stock guard; no ~/.bash_profile or ~/.profile sources this file.
        ".bashrc": 'case $- in *i*) ;; *) return;; esac\nexport OPENAI_API_KEY="fake-bashrc-only"\n',
      },
      ["OPENAI_API_KEY", "GROQ_API_KEY"]
    );
    assert.deepEqual(imported, ["OPENAI_API_KEY"]);
    assert.equal(env.OPENAI_API_KEY, "fake-bashrc-only");
    assert.equal(env.GROQ_API_KEY, undefined);
  }
);

test(
  "login bash keeps profile overrides while filling other keys from ~/.bashrc",
  { skip: !fs.existsSync("/bin/bash") && "bash not installed" },
  async () => {
    const { env } = await importFromRealShell(
      "/bin/bash",
      {
        ".bashrc":
          '[[ ! -f "$HOME/ran" ]] || exit 10\n: > "$HOME/ran"\nexport OPENAI_API_KEY=default-account\nexport GROQ_API_KEY=rc-only\n',
        ".bash_profile": 'set -eu\n. "$HOME/include"\nexport OPENAI_API_KEY=profile-account\n',
        include: '. "$HOME/.bashrc"\n',
        ".bash_login": "exit 11\n",
      },
      ["OPENAI_API_KEY", "GROQ_API_KEY", "CUSTOM_TRANSCRIPTION_API_KEY"]
    );
    assert.equal(env.OPENAI_API_KEY, "profile-account");
    assert.equal(env.GROQ_API_KEY, "rc-only");
  }
);

test(
  "Bash consults an independent bashrc once without overriding login exports",
  {
    skip: !fs.existsSync("/bin/bash"),
  },
  async () => {
    const { env } = await importFromRealShell(
      "/bin/bash",
      {
        ".bash_login": "set -eu\nexport OPENAI_API_KEY=login\n",
        ".profile": "exit 11\n",
        ".bashrc": "export OPENAI_API_KEY=rc\nexport GROQ_API_KEY=rc\n",
      },
      ["OPENAI_API_KEY", "GROQ_API_KEY"]
    );
    assert.equal(env.OPENAI_API_KEY, "login");
    assert.equal(env.GROQ_API_KEY, "rc");
  }
);

for (const trap of ["trap", "builtin trap", "command trap", "command builtin trap", "command -p -- builtin -- trap"]) {
  test(
    `Bash preserves a profile's ${trap} DEBUG hook and runs its .bashrc once`,
    { skip: !fs.existsSync("/bin/bash") },
    async () => {
      const { env } = await importFromRealShell(
        "/bin/bash",
        {
          ".profile": [
            "set -eu",
            `${trap} 'export OPENAI_API_KEY=hook' DEBUG`,
            '. "$HOME/.bashrc"',
            '[[ $(type -t builtin) == builtin && $(type -t trap) == builtin && $(type -t command) == builtin ]] || exit 11',
          ].join("\n"),
          ".bashrc":
            '[[ ! -f "$HOME/ran" ]] || exit 10\n: > "$HOME/ran"\nexport GROQ_API_KEY=rc\n',
        },
        ["OPENAI_API_KEY", "GROQ_API_KEY", "CUSTOM_TRANSCRIPTION_API_KEY"]
      );
      assert.equal(env.OPENAI_API_KEY, "hook");
      assert.equal(env.GROQ_API_KEY, "rc");
    }
  );

  test(
    `a profile's guarded ${trap} DEBUG hook still allows independent .bashrc exports`,
    { skip: !fs.existsSync("/bin/bash") },
    async () => {
      const { env } = await importFromRealShell(
        "/bin/bash",
        {
          ".bash_profile": [
            `[[ -z $(${trap} -p DEBUG) ]] || exit 12`,
            `${trap} -- 'export OPENAI_API_KEY=hook' DEBUG`,
            `[[ $(${trap} -p DEBUG) == *OPENAI_API_KEY* ]] || exit 13`,
          ].join("\n"),
          ".bashrc": "export GROQ_API_KEY=rc-only\n",
        },
        ["OPENAI_API_KEY", "GROQ_API_KEY"]
      );
      assert.equal(env.OPENAI_API_KEY, "hook");
      assert.equal(env.GROQ_API_KEY, "rc-only");
    }
  );
}

test(
  "real login zsh keeps apostrophes, quotes and # in a value",
  { skip: !fs.existsSync("/bin/zsh") && "zsh not installed" },
  async () => {
    const value = `it's a "fake" #key with 'quotes'`;
    const { imported, env } = await importFromRealShell(
      "/bin/zsh",
      { ".zshrc": `export GROQ_API_KEY=${"'" + value.replace(/'/g, "'\\''") + "'"}\n` },
      ["GROQ_API_KEY"]
    );
    assert.deepEqual(imported, ["GROQ_API_KEY"]);
    assert.equal(env.GROQ_API_KEY, value);
  }
);

for (const restoresTracing of [false, true]) {
  test(
    `Bash does not repeat an rc sourced with tracing off (restored: ${restoresTracing})`,
    {
      skip: !fs.existsSync("/bin/bash"),
    },
    async () => {
      const { env } = await importFromRealShell(
        "/bin/bash",
        {
          ".bash_profile": ["set +T", '. "$HOME/includes"', restoresTracing ? "set -T" : ":"].join(
            "\n"
          ),
          includes: '. "$HOME/.bashrc"\n',
          ".bashrc": 'echo rc >> "$HOME/count"\nexport OPENAI_API_KEY=once\n',
        },
        ["OPENAI_API_KEY", "GROQ_API_KEY"],
        {
          checkHome: (home) =>
            assert.equal(fs.readFileSync(path.join(home, "count"), "utf8"), "rc\n"),
        }
      );
      assert.equal(env.OPENAI_API_KEY, "once");
    }
  );
}

test(
  "an independent Bash rc is read when the profile disables tracing",
  {
    skip: !fs.existsSync("/bin/bash"),
  },
  async () => {
    const { env } = await importFromRealShell(
      "/bin/bash",
      {
        ".bash_profile":
          "set +T\ncommand printf ''\ncommand -v true >/dev/null\nbuiltin export GROQ_API_KEY=profile\n",
        ".bashrc": "export OPENAI_API_KEY=independent-rc\n",
      },
      ["OPENAI_API_KEY", "GROQ_API_KEY"]
    );
    assert.equal(env.OPENAI_API_KEY, "independent-rc");
    assert.equal(env.GROQ_API_KEY, "profile");
  }
);

for (const includeRc of [false, true]) {
  test(
    `Bash follows the files loaded by a prompt helper with tracing disabled (includes rc: ${includeRc})`,
    { skip: !fs.existsSync("/bin/bash") },
    async () => {
      const { env } = await importFromRealShell(
        "/bin/bash",
        {
          ".bash_profile": [
            "set -eu",
            "trap 'case $BASH_COMMAND in \": nested\") exit 13;; \": after_prompt\") export ANTHROPIC_API_KEY=hook;; esac' DEBUG",
            "set +T",
            ". \"$HOME/aliases\"",
            'setup_prompt() { [[ $- != *T* ]] || exit 11; . "$HOME/prompt"; }',
            "setup_prompt",
            ": after_prompt",
          ].join("\n"),
          aliases: ': nested\n[[ $- != *T* ]] || exit 12\nexport GROQ_API_KEY=alias-file\n',
          prompt: includeRc ? '. "$HOME/.bashrc"\n' : "PROMPT_COMMAND=:\n",
          ".bashrc": 'echo rc >> "$HOME/count"\nexport OPENAI_API_KEY=rc-only\n',
        },
        ["OPENAI_API_KEY", "GROQ_API_KEY", "ANTHROPIC_API_KEY", "CUSTOM_TRANSCRIPTION_API_KEY"],
        {
          checkHome: (home) =>
            assert.equal(fs.readFileSync(path.join(home, "count"), "utf8"), "rc\n"),
        }
      );
      assert.equal(env.OPENAI_API_KEY, "rc-only");
      assert.equal(env.GROQ_API_KEY, "alias-file");
      assert.equal(env.ANTHROPIC_API_KEY, "hook");
    }
  );
}

for (const invocation of ["setup-prompt", '"$prompt_helper"', '"${prompt_helper}"']) {
  test(
    `Bash observes a prompt helper invoked as ${invocation} without repeating its rc`,
    { skip: !fs.existsSync("/bin/bash") },
    async () => {
      const { env } = await importFromRealShell(
        "/bin/bash",
        {
          ".bash_profile": [
            "set +T",
            'setup-prompt() { [[ $- != *T* ]] || exit 11; . "$HOME/.bashrc"; }',
            "prompt_helper=setup-prompt",
            invocation,
          ].join("\n"),
          ".bashrc": 'echo rc >> "$HOME/count"\nexport OPENAI_API_KEY=rc-only\n',
        },
        ["OPENAI_API_KEY", "GROQ_API_KEY"],
        {
          checkHome: (home) =>
            assert.equal(fs.readFileSync(path.join(home, "count"), "utf8"), "rc\n"),
        }
      );
      assert.equal(env.OPENAI_API_KEY, "rc-only");
    }
  );
}

test(
  "Zsh uses the desktop's ZDOTDIR and XDG configuration paths",
  {
    skip: !fs.existsSync("/bin/zsh"),
  },
  async () => {
    const { env } = await importFromRealShell(
      "/bin/zsh",
      {
        ".zshrc": "export OPENAI_API_KEY=old-account\n",
        "zsh/.zshrc": '. "$XDG_CONFIG_HOME/credentials"\n',
        "xdg/credentials": "export OPENAI_API_KEY=selected-account\n",
      },
      ["OPENAI_API_KEY"],
      {
        environment: (home) => ({
          ZDOTDIR: path.join(home, "zsh"),
          XDG_CONFIG_HOME: path.join(home, "xdg"),
        }),
      }
    );
    assert.equal(env.OPENAI_API_KEY, "selected-account");
  }
);

test(
  "reading Zsh credentials does not run login-session cleanup",
  {
    skip: !fs.existsSync("/bin/zsh"),
  },
  async () => {
    const { env } = await importFromRealShell(
      "/bin/zsh",
      {
        ".zshrc": "export OPENAI_API_KEY=zsh-account\n",
        ".zlogout": ': > "$HOME/logged-out"\n',
      },
      ["OPENAI_API_KEY"],
      {
        checkHome: (home) => assert.equal(fs.existsSync(path.join(home, "logged-out")), false),
      }
    );
    assert.equal(env.OPENAI_API_KEY, "zsh-account");
  }
);

test(
  "a credential probe gives a shell prompt EOF",
  {
    skip: !fs.existsSync("/bin/bash"),
  },
  async () => {
    const { env } = await importFromRealShell(
      "/bin/bash",
      {
        ".bash_profile": "read -t 3 answer || :\nexport OPENAI_API_KEY=after-prompt\n",
      },
      ["OPENAI_API_KEY"]
    );
    assert.equal(env.OPENAI_API_KEY, "after-prompt");
  }
);

for (const background of [false, true]) {
  test(
    `a startup command holding output pipes cannot stall the probe (background: ${background})`,
    {
      skip: !fs.existsSync("/bin/bash"),
    },
    async () => {
      const started = Date.now();
      const { reason, env } = await importFromRealShell(
        "/bin/bash",
        {
          ".bash_profile": [
            'trap "" TERM',
            background ? "sleep 6 &" : "sleep 6",
            "export OPENAI_API_KEY=after-command",
          ].join("\n"),
        },
        ["OPENAI_API_KEY"]
      );
      assert.ok(
        Date.now() - started < 4500,
        "the public import promise waited for the six-second command"
      );
      assert.equal(reason, background ? "ok" : "exec-failed");
      assert.equal(env.OPENAI_API_KEY, background ? "after-command" : undefined);
    }
  );
}
