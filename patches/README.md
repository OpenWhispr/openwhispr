# Dependency cancellation fixes

The pinned Tinfoil 1.1.8 and EHBP 0.2.5 patches preserve cancellation during attestation, initialization retries, realtime setup and encrypted HTTP requests. They retain all verification, encryption and origin checks.

`npm install` applies them before native dependency setup. CI jobs using `--ignore-scripts` explicitly run `npm run apply:patches`. Patch failures stop installation/CI. Keep both package versions pinned until an upstream release passes the cancellation regressions in `test/helpers/tinfoilCancellation.test.js` and the IPC/renderer policy tests.

The patches change the published JavaScript and corresponding public declarations. Both EHBP module formats are covered. No generated bundle or alternate transport is used.
