const crypto = require("crypto");
const fs = require("fs");

// In userData; Reset app data deletes it.
const PAID_KEY_CHECKS_FILE = "paid-key-checks.json";

// A key is a secret, so it is stored through a password hash; a long random key needs only a
// light one.
const digestOf = (key) =>
  crypto.scryptSync(key, "openwhispr-paid-key-check", 32, { N: 1024 }).toString("hex");

// A key check that spends the user's credits runs once per key. A key that passed is
// remembered by its digest, never the key itself, so showing a panel again or restarting the
// app costs nothing. Checks for the same key share one request while it runs, and a key that
// did not pass is asked about again next time. `filePath` returns where the digests live.
function createPaidKeyCheck(filePath) {
  const inFlight = new Map();
  let passed = null;
  const passedDigests = () => {
    if (!passed) {
      try {
        const stored = JSON.parse(fs.readFileSync(filePath(), "utf8")).passed;
        passed = new Set(Array.isArray(stored) ? stored : []);
      } catch {
        passed = new Set();
      }
    }
    return passed;
  };

  return function runPaidCheck(key, check) {
    const digest = digestOf(key);
    if (passedDigests().has(digest)) return Promise.resolve({ success: true });
    let running = inFlight.get(digest);
    if (!running) {
      running = Promise.resolve()
        .then(check)
        .then((result) => {
          if (result?.success) {
            passedDigests().add(digest);
            try {
              fs.writeFileSync(filePath(), JSON.stringify({ passed: [...passedDigests()] }));
            } catch {
              // Best effort: the key stays remembered until the app quits.
            }
          }
          return result;
        })
        .finally(() => inFlight.delete(digest));
      inFlight.set(digest, running);
    }
    return running;
  };
}

module.exports = { PAID_KEY_CHECKS_FILE, createPaidKeyCheck };
