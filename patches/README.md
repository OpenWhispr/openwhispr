# EHBP cancellation

EHBP 0.2.5 rebuilds requests during encryption without preserving their abort
signal. The patch carries the signal through both request copies and checks it
before encryption and upload, so policy revocation cancels the actual network
request. Both CommonJS and ESM consumers are covered.

Tinfoil's attestation and encryption remain unchanged. Shared attestation can
finish for other callers; a cancelled caller cannot upload when it completes.
Remove this patch and the EHBP override when an upstream release preserves
cancellation, keeping `test/helpers/tinfoilCancellation.test.js` as verification.

Normal installs apply the patch in `postinstall`. Installs using
`--ignore-scripts` must run `npm run apply:patches` before testing or packaging.
