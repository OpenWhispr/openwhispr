# Plan — Stop npm 11.8.0 silently stripping `libc` from package-lock.json

Date: 2026-08-05
Base: `main` @ `741f8b16` (version 1.13.1)
Branch to cut: `chore/npm-lockfile-drift-guard`
Status: **revised after adversarial review** (see "Review outcomes" at the end)

---

## Symptom

`docs/plans/2026-08-04-HANDOFF.md:119-121` carries two standing prohibitions:

> - `node-abi` stays undeclared — declaring it forces a lockfile regeneration that
>   strips `libc` fields on a mismatched Node major (observed).
> - Do not regenerate `package-lock.json` on anything but Node 24.

Both describe a real observed failure, but the stated cause is wrong, and the
documented remediation cannot be executed on this machine. The result is a
prohibition nobody can satisfy and a trap that is still armed: any `npm install`
run here silently deletes 19 `libc` fields from the lockfile.

---

## Verified root cause

### It is the npm version, not the Node major

Reproduced by copying `package.json` + `package-lock.json` into a scratch dir and
running `npm install --package-lock-only --ignore-scripts` under each npm:

| npm | ships with | `libc` entries after regen | vs committed lockfile |
|---|---|---|---|
| 11.8.0 | Node 25.6.0 (local) | **0** | differs |
| 11.9.0 | — | **0** | differs |
| 11.10.0 | — | **0** | differs |
| 11.10.1 | — | **0** | differs |
| **11.11.0** | — | **19** | **byte-identical** ← boundary |
| 11.12.1 | Node 25.9.0 | 19 | byte-identical |
| **11.17.0** | Node 24.19.0 (CI) | 19 | byte-identical |
| 12.0.2 | — (npm latest) | 19 | byte-identical |

Package count is **913 in every case**. No package is added or removed. The
entire diff is the `libc` field:

```
19 <       ],
19 <       "libc": [
11 <         "glibc"
 8 <         "musl"
```

(57 lines: 12939 committed → 12882 regenerated.)

**The boundary is exactly 11.11.0**: 11.10.1 strips, 11.11.0 preserves. So the
constraint is a **lower bound on npm**, not an exact Node major.

The "newer Node means newer npm" intuition is backwards here and is likely what
produced the wrong diagnosis:

- Node **24.19.0** ships npm **11.17.0**
- Node **25.6.0** ships npm **11.8.0**

CI's npm is *newer* than local.

The affected entries are the Linux gnu/musl variants of `@napi-rs/keyring`,
`@rolldown/binding`, `@tailwindcss/oxide`, and `lightningcss`. `libc` is what
lets npm discriminate musl from glibc when resolving `optionalDependencies` on
Linux; without it that filter is gone.

**Current state: the committed lockfile is clean.** All 19 entries are intact at
`741f8b16`. No drift has landed. This is prevention, not repair.

### Nothing in the repo catches it

- `package.json` `engines` is `{"node": ">=24"}` and `.npmrc` is
  `engine-strict=true` — but **25.6.0 satisfies `>=24`**, so the guard that
  exists is inert against exactly this failure. There is no `npm` key in
  `engines`.
- No `packageManager` field.
- `.github/workflows/lockfile-lint.yml:12` validates only
  `--validate-https --allowed-hosts npm --validate-integrity`. Not `libc`, not
  drift.
- No CI job regenerates the lockfile and compares it to the committed one.
  (Careful wording: CI is not purely `npm ci` — `build-and-notarize.yml:34,123`
  and `release.yml:33,115` run `npm install <pkgs> --no-save`. But nothing in CI
  commits a lockfile, so drift still can only *land* via a committed local
  install or a Dependabot PR.)

### The `node@24` trap

```
/opt/homebrew/opt/node@24 -> ../Cellar/node/25.6.0
$ /opt/homebrew/opt/node@24/bin/node -v
v25.6.0
```

A dangling Homebrew alias left from when `node@24` was the main formula.
`/opt/homebrew/Cellar/node@24/` does not exist; `brew list --versions` reports
only `node 25.6.0`. Anything reaching for that path silently gets Node 25.

`nvm`, `fnm`, `volta`, `asdf`, `n`, and `nodenv` are **all absent**. So
`CLAUDE.md`'s remediation — `nvm exec 24 npm install` — cannot run here at all.

### `packageManager` would be inert — rejected

`corepack` is **absent** (`command -v corepack` → exit 1; Homebrew's node formula
no longer ships it). Verified empirically: in a scratch package pinned to
`"packageManager": "npm@11.17.0"`, npm 11.8.0 ran to completion, **exit 0, no
warning**. The field is enforced by corepack, not by npm.

---

## Proposed fix

### Change 1 — enforce a minimum npm via `engines.npm`

`package.json`:

```diff
   "engines": {
-    "node": ">=24"
+    "node": ">=24",
+    "npm": ">=11.11.0"
   },
```

This reuses the `engine-strict=true` already in `.npmrc`. Verified: with both
keys set, npm 11.8.0 aborts before touching the lockfile:

```
npm error code EBADENGINE
npm error notsup Required: {"node":">=24","npm":">=11.11.0"}
npm error notsup Actual:   {"node":"v25.6.0","npm":"11.8.0"}
```

**Why `>=11.11.0`:** it is the proven boundary — 11.10.1 strips `libc`, 11.11.0
does not. A higher floor would reject npm versions that demonstrably produce a
correct lockfile. Both realistic upgrade paths clear it: Node 24.19.0 → npm
11.17.0 (CI), Node 25.9.0 → npm 11.12.1 (a plain `brew upgrade node`).

**Blast radius on CI — all 13 workflows checked, not just the 4 that set a Node
version:**

| workflow | node-version | npm commands |
|---|---|---|
| `build-and-notarize.yml` | `"24"` → npm 11.17.0 | 14 |
| `release.yml` | `"24"` → npm 11.17.0 | 13 |
| `tests.yml` | `.nvmrc` (24) → npm 11.17.0 | 3 |
| `build-meeting-aec-helper.yml` | `"22"` | **0** |
| `lockfile-lint.yml` | none (runner default) | 0 (`npx` only) |
| `build-linux-text-monitor.yml` | none | 0 |
| `build-windows-{fast-paste,key-listener,mic-listener,system-audio-helper,text-monitor}.yml` | none | 0 |
| `codeql.yml` | none | 0 |
| `update-nix.yml` | none | 0 |

Every workflow that runs npm is on Node 24 → npm 11.17.0, which clears the
floor. The workflows on older/default Node run **zero** npm commands. Notably
`lockfile-lint.yml` runs `npx` on the runner-default npm with no `setup-node` —
it survives because **`npx` does not perform the root engine check** (verified:
exit 0 under a failing root `engines` + `engine-strict`).

**Local blast radius — measured, both halves:**

| command (local npm 11.8.0, failing floor) | result |
|---|---|
| `npm install`, `npm install --package-lock-only` | **EBADENGINE, exit 1**, lockfile untouched |
| `npm ci` | **EBADENGINE, exit 1** |
| `npm rebuild`, `npm rebuild better-sqlite3` | exit 0 |
| `npx …` (incl. `electron-builder install-app-deps`) | exit 0 |
| `npm run <script>` | runs normally |

So the `prebuild`/`predev`/`postinstall` chain (pure `npm run` nesting — the
scripts block contains no `npm install`) and the better-sqlite3 ABI toggle both
keep working. But **`npm ci` fails too, not just `npm install`** — the handoff
must say so, because `npm ci` is the recovery command people reach for.

Intended behaviour: a loud stop instead of silent corruption. Remedy is one
line, **`npm i -g npm@11`** (→ 11.19.0, verified to regenerate byte-identically).

**Not `npm@latest`.** Attempting it on this machine fails:

```
npm error notsup Required: {"node":"^22.22.2 || ^24.15.0 || >=26.0.0"}
npm error notsup Actual:   {"node":"v25.6.0","npm":"11.8.0"}
```

npm 12 dropped the Node 25.x line (odd-numbered, non-LTS); npm 11.x is
`^20.17.0 || >=22.9.0` and covers it. The repo's `engine-strict=true` is what
makes this a hard error rather than a warning — it prevented installing an npm
this Node does not support. Alternative: `brew install node@24` (24.19.0,
keg-only, available but not installed) to match `.nvmrc` and CI exactly.

### Change 2 — CI guard against lockfile drift

`.github/workflows/lockfile-lint.yml` — add a job that regenerates the lockfile
with a **pinned** npm and fails on any difference:

```yaml
  lockfile-drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
      # Pinned deliberately: setup-node resolves the LATEST 24.x, whose bundled
      # npm has moved 11.12.1 -> 11.13.0 -> 11.16.0 -> 11.17.0 across 24.15-24.19.
      # A floating npm here would make the guard itself a source of drift.
      # Bumping this pin requires regenerating package-lock.json with it.
      - name: Regenerate the lockfile with the pinned npm
        run: npx --yes npm@11.17.0 install --package-lock-only
      - name: Fail if it drifted from the committed lockfile
        run: git diff --exit-code -- package-lock.json
```

The existing `lockfile-lint` job has no `setup-node` step, so the new job adds
its own.

**`--ignore-scripts` is required, not cosmetic.** The review called it redundant
(MINOR #9) on the premise that `--package-lock-only` never runs lifecycle
scripts. That premise is false, and I only caught it because the drift test ran
in a directory without `node_modules`:

```
$ npm install --package-lock-only        # no node_modules present
> open-whispr@1.13.1 postinstall
> electron-builder install-app-deps
sh: electron-builder: command not found
npm error code 127
```

The CI job checks out and immediately regenerates — it never populates
`node_modules` — so without the flag the guard would fail with exit 127 on every
single run. With it, the exact CI condition is clean: `regen exit=0`, `libc: 19`,
`git diff --exit-code` → 0.

This catches the `libc` stripping and every future lockfile drift, not just this
one bug.

**Why regenerate-and-diff over a narrow "assert libc is present" script:** the
narrow check only ever catches this one regression. Regenerate-and-diff catches
any lockfile not produced by a conforming npm. Evidence it is stable rather than
flaky: five npm versions (11.11.0, 11.12.1, 11.17.0, 12.0.2) all regenerated
**byte-identical** output against the live registry today, and `npm install` does
not upgrade entries that already satisfy their range.

### Change 3 — Dependabot interaction

`.github/dependabot.yml` runs **weekly npm updates** on this repo, and
`origin/dependabot/npm_and_yarn/{electron-43.1.0,typescript-7.0.2}` are live.
Dependabot is the **only other writer** of this lockfile, and both changes above
gate it:

- The drift guard will run on every Dependabot PR. If Dependabot's npm ever
  serializes differently from the pinned 11.17.0, dependency updates go red.
- If Dependabot honours `engine-strict` with an npm below the floor, its
  resolution fails with EBADENGINE.

**Evidence it conforms today** — every recent Dependabot-written lockfile
preserves all 19 entries:

```
8aef6448  libc=19  chore(deps-dev): bump vite from 8.1.3 to 8.1.4
b1581ae7  libc=19  chore(deps): bump tinfoil from 1.1.7 to 1.1.8
c1259bce  libc=19  chore(deps): bump i18next from 26.3.4 to 26.3.6
```

Also, `engine-strict=true` has been in `.npmrc` since `a528ed16` (2026-03-11)
and Dependabot has been landing updates throughout, so it already tolerates
engine-strict.

**Action:** no config change. Explicitly watch the **first Dependabot PR after
this lands** and record the outcome in the handoff. If it goes red, the fallback
is to relax the guard to the narrow `libc` assertion rather than to drop the
`engines.npm` floor (the floor is the part that prevents corruption; the guard
only detects it).

### Change 4 — correct the wrong documents

Three places repeat the wrong Node-major diagnosis:

1. `docs/plans/2026-08-04-HANDOFF.md:119-121` — replace the Node-major claim with
   the npm floor; drop the "only Node 24" prohibition (superseded).
2. `CLAUDE.md:19` — "**Node.js**: 24 (pinned in `.nvmrc` — CI uses Node 24, do
   NOT regenerate `package-lock.json` with a different major version)". Same
   wrong cause, missed by the first draft of this plan.
3. `CLAUDE.md` "Build Issues" → item 4 "Lockfile":
   > Always use Node 24 when running `npm install` (matches CI). If your local
   > Node version differs, use `nvm exec 24 npm install`. Running `npm install`
   > with a different major version will produce an incompatible
   > `package-lock.json` that breaks `npm ci` in CI.

   Wrong on three counts: the variable is npm not Node; `nvm` is not installed;
   and the failure mode is silently-stripped `libc`, **not** a broken `npm ci`
   (verified: `npm ci --dry-run` succeeds on the stripped lockfile, exit 0).

Replace all three with: the npm floor, the `npm i -g npm@11` remedy, the
note that `/opt/homebrew/opt/node@24` is a dangling alias to 25.6.0, and the
fact that `npm ci` also fails until npm is upgraded.

Also update `README.md:37` and `README.md:67`, which tell contributors to run
`npm install` with no mention of the floor — on the current local toolchain
that is a bare EBADENGINE with no explanation.

Leave the `node-abi` decision itself alone — it stays undeclared. Only its
stated *justification* was wrong.

---

## Test plan

1. **`engines.npm` blocks the broken npm.** With the change applied, run
   `npm install --package-lock-only` under local npm 11.8.0 → expect
   `EBADENGINE`, non-zero exit, `package-lock.json` unchanged
   (`git diff --exit-code`).
2. **`npm ci` also blocks** under local npm 11.8.0 → expect EBADENGINE, exit 1.
3. **`engines.npm` permits a conforming npm.** `npx npm@11.17.0 install
   --package-lock-only` → success, byte-identical lockfile.
4. **The floor is exactly right at the boundary.** `npx npm@11.11.0` → success;
   `npx npm@11.10.1` → would strip (already proven), and is now rejected by the
   floor.
5. **The escape hatches still work** under local npm 11.8.0 with the floor in
   place: `npm rebuild better-sqlite3` → exit 0; `npx electron-builder
   install-app-deps` → exit 0; `npm run typecheck` → runs.
6. **The CI guard fails on drift.** In a scratch copy, strip the `libc` fields,
   run the two guard commands, confirm `git diff --exit-code` exits non-zero.
7. **The CI guard passes on `main` as-is.** Same commands against the untouched
   lockfile under pinned npm 11.17.0 → exit 0.
8. **Full gate unchanged:** `npm run typecheck`, `npm run lint`, `npm test`
   (`npm rebuild better-sqlite3` first — see the ABI toggle). Baseline to match:
   570 tests / 565 pass / 0 fail / 5 skipped.

No unit tests are added: the change is a manifest field, a workflow, and prose.
Tests 6 and 2 are the ones that prove the guard actually guards and that the
blast radius is documented honestly.

---

## Open questions for the user

1. **Version bump.** `CLAUDE.md` → "Versioning — REQUIRED" says every change that
   produces a build gets a bump, classing an internal/build change as **patch**
   (1.13.1 → 1.13.2). But `1.13.1` is not yet tagged and is pending your
   real-call verification. Bumping now means the artifact you verify is not the
   one you were about to verify. **Recommend: hold at 1.13.1** — this alters no
   runtime code, only `engines`, a workflow, and docs. Your call.
2. **Upgrade local npm — resolved during implementation.** `npm i -g npm@11`
   (→ 11.19.0). The first attempt used `npm@latest` and failed: npm 12 excludes
   the Node 25.x line. Verified 11.19.0 regenerates the lockfile byte-identically.
3. **`.nvmrc` says `24` while the machine runs 25.6.0** and nothing enforces it
   (no version manager installed). Out of scope here — nothing reads `.nvmrc`
   locally. Leave it, or file a follow-up to install a real Node 24?

---

## Unverified claims to flag

- I have **not** observed a build failure caused by the stripped `libc` fields.
  The impact argument is mechanical (npm loses its musl/glibc filter for Linux
  optional deps), not empirical. `release.yml:33` and `build-and-notarize.yml:34`
  already hand-install `@rollup/rollup-linux-x64-gnu lightningcss-linux-x64-gnu
  @tailwindcss/oxide-linux-x64-gnu --no-save`, the same optional-native-binary
  resolution class — suggestive, but I have not proven the two are connected.
- The currently failing `Build and Notarize` runs are **unrelated**: they abort
  on `llama-server-linux-x64` / `llama-server-win32-x64.exe` missing, caught by
  `scripts/verify-bundled-binaries.js`. Not addressed by this plan.

---

## Review outcomes (adversarial review, 2026-08-05)

Verdict was "safe to implement with specific changes first — no re-plan needed".
No CRITICAL findings. All five IMPORTANT and four MINOR findings are addressed
above; each was independently re-verified before being accepted:

| # | Finding | Resolution |
|---|---|---|
| 1 | Dependabot never considered — the only other lockfile writer, gated by both changes | New **Change 3**; verified its recent writes preserve `libc` |
| 2 | Floor rationale superseded — true boundary is 11.11.0, not 11.12.1 | Bisect confirmed (11.10.1 strips / 11.11.0 clean); floor lowered to `>=11.11.0` |
| 3 | Guard's npm floats with `setup-node`, itself a drift source | Guard npm **pinned** to 11.17.0 with a comment explaining the pin |
| 4 | "Checked every workflow" listed 4 of 13 | Table now covers all 13; conclusion survives |
| 5 | `npm ci` also hard-fails; `rebuild`/`npx`/`run` survive | Full measured matrix added |
| 6 | `CLAUDE.md:19` repeats the wrong diagnosis, untouched | Added to Change 4 |
| 7 | `README.md:37,67` say `npm install` with no floor note | Added to Change 4 |
| 8 | "Every workflow uses `npm ci`" is false | Sentence corrected |
| 9 | `--ignore-scripts` redundant; no `cache: npm` | **Finding rejected — it was wrong.** `--package-lock-only` *does* run lifecycle scripts; dropping the flag would have failed the guard job with exit 127 on every run (proven, see Change 2). Flag kept. Cache left off (perf-only) |

**Implementation-time findings not in the review:**

| # | Finding | Resolution |
|---|---|---|
| 10 | The lockfile embeds the root `engines` block at `packages[""].engines`, so changing `package.json` makes the lockfile stale and the new guard immediately red | `package-lock.json` regenerated with the pinned npm 11.17.0 in the same commit; diff is exactly the 2-line `engines` change, libc still 19, 913 packages, and re-running the guard is idempotent |
| 11 | The documented remedy `npm i -g npm@latest` is **wrong on Node 25** — npm 12's `engines.node` is `^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0`, excluding the 25.x line, so it aborts with EBADENGINE | Remedy changed to `npm i -g npm@11` (→ 11.19.0, verified byte-identical) in CLAUDE.md, README, and this plan; `brew install node@24` noted as the alternative |

Review claims I re-verified myself rather than accepting: the Dependabot config
and its live branches, the 11.11.0 boundary, `npm ci` failing under
engine-strict, `npx`/`npm rebuild` surviving, `CLAUDE.md:19`, and `README.md:37,67`.
