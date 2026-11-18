# Android EAS builds

Run Android EAS commands from `openwhispr-mobile` with Node 24:

```sh
node scripts/eas-android.mjs build --profile android-play-test --non-interactive
```

The command uses EAS CLI 25.1.1 and selects Android. Use `android-billing-test` when that separate billing environment is intended. The existing EAS profiles, signing credentials and update channels still control the build. Building does not submit a release unless an explicit EAS submission option is supplied.

To inspect the archive without starting a remote build:

```sh
node scripts/eas-android.mjs build:inspect --profile android-play-test --stage archive --output /absolute/path/android-archive
```

EAS archive inspection still uses the CLI's normal authentication/configuration flow. Output paths are resolved from the directory where the command is invoked. Local builds keep their default artifacts in that invoking directory; explicit local artifact and working-directory environment paths are resolved there too. Other EAS options pass through; omit `--platform`/`-p`, and keep short options separate from their values.

The Android archive rules live in `config/easignore.android`. The command copies the current working tree, including local dependencies and configuration inputs, into a temporary Git clone outside the checkout. It uses copy-on-write where the filesystem supports it, preserves the source commit/index and adds `.easignore` only inside that clone. EAS then applies the same mobile-only archive rules, including the five licensed fonts. Fetch those fonts through the existing `npm run download:brand-fonts` step before a build that requires them.

The command removes its temporary clone after success, failure or a handled interruption. On macOS/Linux it stops the CLI's process group, escalating after five seconds if needed. An uncatchable termination such as `SIGKILL` or a machine crash may leave an `android-eas-stage-*` directory in the operating system's temporary directory. Check that its build process has stopped before removing such a directory. CLI changes made inside the clone, such as local version-file edits, remain inside that temporary snapshot; remote version increments still use the existing EAS configuration.

Use the ordinary EAS command for iOS. There is no repository-root `.easignore`, so iOS uses the upstream `.gitignore` archive rules. Calling EAS directly for Android also uses those default rules; use this Android command to retain the smaller Android archive and font inclusion.

Run the command's local tests without contacting EAS:

```sh
node --test scripts/__tests__/eas-android.test.mjs
```

The tests use synthetic project/configuration files and a fake CLI. Actual EAS archive-copy equivalence is verified separately; these tests do not establish cloud signing, native-build or physical-device acceptance. The Windows launch/termination branches require Windows-host verification.
